package quota

import (
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
		if t, err := time.Parse(time.RFC3339, periodEnd); err == nil {
			ms := t.UnixMilli()
			resetAtMS = &ms
			resetLabel = formatResetInstant(ms, nowMS)
		}
	}

	if creditPct, ok := toFloat(rawCreditPct); ok {
		clampedUsed := clamp(creditPct, 0, 100)
		clampedRem := clamp(100-clampedUsed, 0, 100)
		// The billing payload carries no period, so a weekly window is assumed.
		periodHours := 168.0
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
