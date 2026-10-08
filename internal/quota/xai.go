package quota

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

type RawXaiCent struct {
	Val any `json:"val"`
}

type RawXaiPeriod struct {
	Type  string `json:"type"`
	Start string `json:"start"`
	End   string `json:"end"`
}

type RawXaiProductUsage struct {
	Product      string `json:"product"`
	UsagePercent any    `json:"usage_percent"`
	UsagePctAlt  any    `json:"usagePercent"`
}

type RawXaiBillingConfig struct {
	CurrentPeriod      *RawXaiPeriod        `json:"current_period"`
	CurrentPeriodAlt   *RawXaiPeriod        `json:"currentPeriod"`
	CreditUsagePercent any                  `json:"credit_usage_percent"`
	CreditUsagePctAlt  any                  `json:"creditUsagePercent"`
	ProductUsage       []RawXaiProductUsage `json:"product_usage"`
	ProductUsageAlt    []RawXaiProductUsage `json:"productUsage"`
	MonthlyLimit       any                  `json:"monthly_limit"`
	MonthlyLimitAlt    any                  `json:"monthlyLimit"`
	Used               any                  `json:"used"`
	BillingPeriodStart string               `json:"billing_period_start"`
	BillingPeriodEnd   string               `json:"billing_period_end"`
}

type RawXaiBillingPayload struct {
	Config *RawXaiBillingConfig `json:"config"`
}

// parseXaiInstant reads an upstream billing timestamp.
//
// The CLI writes fractional seconds with an explicit offset, which the strict layout rejects.
// Both layouts are tried here because a rejected instant silently costs the window its reset —
// the reading stays, but it can no longer say when the limit lifts.
func parseXaiInstant(value string) (time.Time, bool) {
	for _, layout := range []string{time.RFC3339, time.RFC3339Nano} {
		if instant, err := time.Parse(layout, value); err == nil {
			return instant, true
		}
	}
	return time.Time{}, false
}

// ParseXaiBillingDocuments combines the two billing documents the Grok CLI reads.
//
// The credits document (`?format=credits`) publishes the subscription's own window — the
// percentage together with the period it belongs to — while the plain billing document
// publishes the metered ledger (monthly limit, spend, on-demand). The two describe different
// clocks, so the period stays atomic: a window and its reset always come from one document, and
// the ledger is carried beside it as extra usage rather than merged into that window. Reading
// only the plain document is what reported a SuperGrok subscription as having no usage at all,
// because a subscription account's metered ledger is empty.
//
// Either document may be absent: a document that is missing or unreadable contributes nothing,
// which is how a provider mid-rollout still yields the reading the other one carries. Only when
// neither yields a plan is this a failure the caller can act on.
func ParseXaiBillingDocuments(creditsRaw, monthlyRaw []byte, nowMS int64) (*QuotaPlan, []QuotaWindow, error) {
	creditsPlan, creditsWindows := parseXaiBillingDocument(creditsRaw, nowMS)
	monthlyPlan, monthlyWindows := parseXaiBillingDocument(monthlyRaw, nowMS)

	plan := creditsPlan
	if plan == nil {
		plan = monthlyPlan
	}
	if plan == nil {
		return nil, nil, fmt.Errorf("xai billing config missing")
	}

	windows := creditsWindows
	if len(windows) == 0 {
		windows = monthlyWindows
	}
	// The ledger belongs to whichever document stated it, but it describes the account rather
	// than the window, so it is collected across both without moving either one's period.
	if monthlyPlan != nil && monthlyPlan.ExtraUsage != nil {
		plan.ExtraUsage = monthlyPlan.ExtraUsage
	}

	return plan, windows, nil
}

// parseXaiBillingDocument reads one document, and treats an absent or unusable one as
// contributing nothing: a provider mid-rollout must not cost the read the document that did
// answer, and only a pair with no plan at all is the caller's failure.
func parseXaiBillingDocument(raw []byte, nowMS int64) (*QuotaPlan, []QuotaWindow) {
	if len(bytes.TrimSpace(raw)) == 0 {
		return nil, nil
	}
	plan, windows, err := ParseXaiBilling(raw, nowMS)
	if err != nil {
		return nil, nil
	}
	return plan, windows
}

func parseCentVal(value any) int64 {
	if value == nil {
		return 0
	}
	if m, ok := value.(map[string]any); ok {
		if v, ok := toInt64(m["val"]); ok {
			return v
		}
	}
	if v, ok := toInt64(value); ok {
		return v
	}
	return 0
}

// ParseXaiBilling parses xAI billing payload into windows and plan details.
func ParseXaiBilling(raw []byte, nowMS int64) (*QuotaPlan, []QuotaWindow, error) {
	var payload RawXaiBillingPayload
	if err := json.Unmarshal(raw, &payload); err != nil {
		return nil, nil, fmt.Errorf("invalid xai payload: %w", err)
	}

	cfg := payload.Config
	if cfg == nil {
		return nil, nil, fmt.Errorf("xai config missing")
	}

	windows := make([]QuotaWindow, 0)

	rawCreditPct := cfg.CreditUsagePercent
	if rawCreditPct == nil {
		rawCreditPct = cfg.CreditUsagePctAlt
	}

	periodEnd := cfg.BillingPeriodEnd
	currPeriod := cfg.CurrentPeriod
	if currPeriod == nil {
		currPeriod = cfg.CurrentPeriodAlt
	}
	if currPeriod != nil && currPeriod.End != "" {
		periodEnd = currPeriod.End
	}

	var resetAtMS *int64
	var resetLabel string
	if periodEnd != "" {
		if instant, ok := parseXaiInstant(periodEnd); ok {
			ms := instant.UnixMilli()
			resetAtMS = &ms
			resetLabel = formatResetInstant(ms, nowMS)
		}
	}

	if creditPct, ok := toFloat(rawCreditPct); ok {
		clampedUsed := clamp(creditPct, 0, 100)
		clampedRem := clamp(100-clampedUsed, 0, 100)
		// A credits document states the period its percentage belongs to, and that span is the
		// window's real length. The metered ledger states no period, and the CLI's own reading of
		// it assumes a weekly window, so that assumption stays the fallback.
		periodHours := 168.0
		if currPeriod != nil {
			if start, startOK := parseXaiInstant(currPeriod.Start); startOK {
				if end, endOK := parseXaiInstant(currPeriod.End); endOK && end.After(start) {
					periodHours = end.Sub(start).Hours()
				}
			}
		}
		windows = append(windows, QuotaWindow{
			ID:               "xai_credit_usage",
			Label:            "额度总使用率 (Credit Usage)",
			Scope:            "standard",
			UsedPercent:      &clampedUsed,
			RemainingPercent: &clampedRem,
			ResetAtMS:        resetAtMS,
			ResetLabel:       resetLabel,
			PeriodHours:      &periodHours,
			ResetAccuracy:    "exact",
		})
	}

	products := cfg.ProductUsage
	if len(products) == 0 {
		products = cfg.ProductUsageAlt
	}
	for i, prod := range products {
		name := prod.Product
		if name == "" {
			name = fmt.Sprintf("模型 %d", i+1)
		}
		rawPct := prod.UsagePercent
		if rawPct == nil {
			rawPct = prod.UsagePctAlt
		}
		if pct, ok := toFloat(rawPct); ok {
			clampedUsed := clamp(pct, 0, 100)
			clampedRem := clamp(100-clampedUsed, 0, 100)
			windows = append(windows, QuotaWindow{
				ID:               fmt.Sprintf("xai_prod_%d", i),
				Label:            fmt.Sprintf("%s 使用率", strings.ToUpper(name)),
				Scope:            "model",
				Model:            name,
				UsedPercent:      &clampedUsed,
				RemainingPercent: &clampedRem,
				ResetAtMS:        resetAtMS,
				ResetLabel:       resetLabel,
				ResetAccuracy:    "exact",
			})
		}
	}

	monthlyLim := cfg.MonthlyLimit
	if monthlyLim == nil {
		monthlyLim = cfg.MonthlyLimitAlt
	}
	limitCents := parseCentVal(monthlyLim)
	usedCents := parseCentVal(cfg.Used)

	var extraUsage *QuotaExtraUsage
	if limitCents > 0 {
		pct := clamp(float64(usedCents)/float64(limitCents)*100, 0, 100)
		extraUsage = &QuotaExtraUsage{
			IsEnabled:          true,
			MonthlyLimitCents:  limitCents,
			UsedCreditsCents:   usedCents,
			UtilizationPercent: &pct,
		}
	}

	plan := &QuotaPlan{
		PlanType:   "paid",
		PlanLabel:  "xAI Paid / API",
		Tier:       "standard",
		ExtraUsage: extraUsage,
	}

	return plan, windows, nil
}
