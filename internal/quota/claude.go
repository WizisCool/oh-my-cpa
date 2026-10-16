package quota

import (
	"encoding/json"
	"fmt"
	"math"
	"regexp"
	"sort"
	"strings"
	"time"
)

type RawClaudeWindow struct {
	Utilization      any    `json:"utilization"`
	ResetsAt         string `json:"resets_at"`
	LimitDollars     any    `json:"limit_dollars"`
	UsedDollars      any    `json:"used_dollars"`
	RemainingDollars any    `json:"remaining_dollars"`
}

// isDollarDenominated reports a window that meters a dollar allowance rather
// than a share of the plan. Claude reuses the iguana_necktie key for its cloud
// session credits, which would otherwise read as the legacy Fable window.
func (w *RawClaudeWindow) isDollarDenominated() bool {
	for _, value := range []any{w.LimitDollars, w.UsedDollars, w.RemainingDollars} {
		if _, ok := toFloat(value); ok {
			return true
		}
	}
	return false
}

type RawClaudeModelScope struct {
	ID          string `json:"id"`
	DisplayName string `json:"display_name"`
}

type RawClaudeScope struct {
	Model *RawClaudeModelScope `json:"model"`
}

type RawClaudeUsageLimit struct {
	Kind     string          `json:"kind"`
	Group    string          `json:"group"`
	Percent  any             `json:"percent"`
	ResetsAt string          `json:"resets_at"`
	IsActive *bool           `json:"is_active"`
	Scope    *RawClaudeScope `json:"scope"`
}

type RawClaudeExtraUsage struct {
	IsEnabled         *bool  `json:"is_enabled"`
	MonthlyLimit      any    `json:"monthly_limit"`
	UsedCredits       any    `json:"used_credits"`
	Utilization       any    `json:"utilization"`
	Currency          string `json:"currency"`
	DisabledReason    string `json:"disabled_reason"`
	UserDisabled      *bool  `json:"user_disabled"`
	SpendLimitReached *bool  `json:"spend_limit_reached"`
}

type RawClaudeUsagePayload struct {
	FiveHour          *RawClaudeWindow      `json:"five_hour"`
	SevenDay          *RawClaudeWindow      `json:"seven_day"`
	SevenDayOAuthApps *RawClaudeWindow      `json:"seven_day_oauth_apps"`
	SevenDayOpus      *RawClaudeWindow      `json:"seven_day_opus"`
	SevenDaySonnet    *RawClaudeWindow      `json:"seven_day_sonnet"`
	SevenDayCowork    *RawClaudeWindow      `json:"seven_day_cowork"`
	IguanaNecktie     *RawClaudeWindow      `json:"iguana_necktie"`
	Limits            []RawClaudeUsageLimit `json:"limits"`
	ExtraUsage        *RawClaudeExtraUsage  `json:"extra_usage"`
}

type RawClaudeProfileAccount struct {
	HasClaudeMax bool `json:"has_claude_max"`
	HasClaudePro bool `json:"has_claude_pro"`
}

type RawClaudeProfileOrg struct {
	RateLimitTier        string `json:"rate_limit_tier"`
	HasExtraUsageEnabled bool   `json:"has_extra_usage_enabled"`
	SubscriptionStatus   string `json:"subscription_status"`
}

type RawClaudeProfileResponse struct {
	Account      *RawClaudeProfileAccount `json:"account"`
	Organization *RawClaudeProfileOrg     `json:"organization"`
}

// ClaudeResetGrant is one Anthropic rate-limit reset grant, display-only. OMC
// lists grants beside the Claude quota; claiming one spends an entitlement
// and is deliberately not implemented.
type ClaudeResetGrant struct {
	ID          string   `json:"id"`
	Label       string   `json:"label,omitempty"`
	ResetsTotal int      `json:"resets_total"`
	ResetsLeft  int      `json:"resets_left"`
	EndsAtMS    *int64   `json:"ends_at_ms,omitempty"`
	Clears      []string `json:"clears,omitempty"`
}

// claudeResetGrantWindows are the usage windows a grant can clear. Windows the
// provider adds later are dropped, never guessed.
var claudeResetGrantWindows = map[string]bool{
	"five_hour": true, "seven_day": true, "seven_day_overage_included": true,
}

var claudeResetGrantIDPattern = regexp.MustCompile(`^[a-z0-9_-]{1,40}$`)

// ParseClaudeResetGrants parses the `cedar_ember` block of the Claude usage
// response. It returns nil for a missing or malformed block: one malformed
// grant, a duplicate id or a bad timestamp rejects the whole block, because a
// half-parsed entitlement display is worse than none.
func ParseClaudeResetGrants(raw []byte) []ClaudeResetGrant {
	var body struct {
		CedarEmber *struct {
			Eligible *bool             `json:"eligible"`
			Grants   []json.RawMessage `json:"grants"`
		} `json:"cedar_ember"`
	}
	if json.Unmarshal(raw, &body) != nil || body.CedarEmber == nil || body.CedarEmber.Eligible == nil {
		return nil
	}
	grants := make([]ClaudeResetGrant, 0, len(body.CedarEmber.Grants))
	seen := make(map[string]bool, len(body.CedarEmber.Grants))
	for _, rawGrantJSON := range body.CedarEmber.Grants {
		var rawGrant struct {
			ID          string          `json:"id"`
			Label       string          `json:"label"`
			ResetsTotal json.RawMessage `json:"resets_total"`
			ResetsLeft  json.RawMessage `json:"resets_left"`
			EndsAt      *string         `json:"ends_at"`
			Clears      []string        `json:"clears"`
		}
		var flagMaps map[string]json.RawMessage
		if json.Unmarshal(rawGrantJSON, &rawGrant) != nil || json.Unmarshal(rawGrantJSON, &flagMaps) != nil {
			return nil
		}
		if !claudeResetGrantIDPattern.MatchString(rawGrant.ID) || seen[rawGrant.ID] {
			return nil
		}
		seen[rawGrant.ID] = true
		total, okTotal := grantCount(rawGrant.ResetsTotal)
		left, okLeft := grantCount(rawGrant.ResetsLeft)
		if !okTotal || !okLeft || left > total {
			return nil
		}
		// Usability flags default to the refusing side and must be booleans
		// when present; the display never offers a grant for spending.
		for _, key := range []string{"paused", "usable_now", "use_requires_limit"} {
			if rawFlag, present := flagMaps[key]; present {
				var flag bool
				if json.Unmarshal(rawFlag, &flag) != nil {
					return nil
				}
			}
		}
		var endsAtMS *int64
		if rawGrant.EndsAt != nil {
			parsed, ok := parseGrantInstant(*rawGrant.EndsAt)
			if !ok {
				return nil
			}
			endsAtMS = &parsed
		}
		clears := make([]string, 0)
		for _, window := range rawGrant.Clears {
			if claudeResetGrantWindows[window] {
				clears = append(clears, window)
			}
		}
		grants = append(grants, ClaudeResetGrant{
			ID:          rawGrant.ID,
			Label:       grantLabel(rawGrant.Label),
			ResetsTotal: total,
			ResetsLeft:  left,
			EndsAtMS:    endsAtMS,
			Clears:      clears,
		})
	}
	return grants
}

// grantCount accepts an integer count of zero or more; floats, strings and
// negatives are a malformed grant, not a zero. The upper bound keeps an
// out-of-range float from reaching the float-to-int conversion, whose result
// Go leaves implementation-defined.
func grantCount(raw json.RawMessage) (int, bool) {
	var value float64
	if json.Unmarshal(raw, &value) != nil || value < 0 || value > 1e6 || value != math.Trunc(value) {
		return 0, false
	}
	return int(value), true
}

// parseGrantInstant reads an upstream ISO timestamp as epoch milliseconds.
func parseGrantInstant(value string) (int64, bool) {
	for _, layout := range []string{time.RFC3339, time.RFC3339Nano} {
		if instant, err := time.Parse(layout, value); err == nil {
			return instant.UnixMilli(), true
		}
	}
	return 0, false
}

// grantLabel keeps upstream display text free of control characters and bounded.
func grantLabel(value string) string {
	cleaned := strings.Map(func(runeValue rune) rune {
		if runeValue < 0x20 || (runeValue >= 0x7f && runeValue <= 0x9f) {
			return ' '
		}
		return runeValue
	}, value)
	cleaned = strings.Join(strings.Fields(cleaned), " ")
	if len([]rune(cleaned)) > 120 {
		cleaned = string([]rune(cleaned)[:120])
	}
	return cleaned
}

// ParseClaudeUsage parses the Claude usage JSON and builds windows and extra usage.
func ParseClaudeUsage(raw []byte, nowMS int64) ([]QuotaWindow, *QuotaExtraUsage, error) {
	var payload RawClaudeUsagePayload
	if err := json.Unmarshal(raw, &payload); err != nil {
		return nil, nil, fmt.Errorf("invalid claude payload: %w", err)
	}

	windows := make([]QuotaWindow, 0)

	addWindow := func(w *RawClaudeWindow, id, label, scope, model string, periodHours float64) {
		if w == nil {
			return
		}
		utilVal, hasUtil := toFloat(w.Utilization)

		var resetAtMS *int64
		var resetLabel string
		accuracy := "approximate"
		if w.ResetsAt != "" {
			if t, err := time.Parse(time.RFC3339, w.ResetsAt); err == nil {
				ms := t.UnixMilli()
				resetAtMS = &ms
				resetLabel = formatResetInstant(ms, nowMS)
				accuracy = "exact"
			} else if t, err := time.Parse(time.RFC3339Nano, w.ResetsAt); err == nil {
				ms := t.UnixMilli()
				resetAtMS = &ms
				resetLabel = formatResetInstant(ms, nowMS)
				accuracy = "exact"
			}
		}

		var usedPercent *float64
		var remainingPercent *float64
		if hasUtil {
			clampedUsed := clamp(utilVal, 0, 100)
			usedPercent = &clampedUsed
			clampedRem := clamp(100-clampedUsed, 0, 100)
			remainingPercent = &clampedRem
		}

		windows = append(windows, QuotaWindow{
			ID:               id,
			Label:            label,
			Scope:            scope,
			ModelFamilies:    windowModelFamilies(QuotaWindow{ID: id}),
			Model:            model,
			UsedPercent:      usedPercent,
			RemainingPercent: remainingPercent,
			ResetAtMS:        resetAtMS,
			ResetLabel:       resetLabel,
			PeriodHours:      &periodHours,
			ResetAccuracy:    accuracy,
		})
	}

	addWindow(payload.FiveHour, "five_hour", "5小时滚动用量 (5-Hour)", "standard", "", 5)
	addWindow(payload.SevenDay, "seven_day", "每周总用量上限 (Weekly)", "standard", "", 168)
	addWindow(payload.SevenDaySonnet, "seven_day_sonnet", "Sonnet 每周用量", "model", "claude-3-5-sonnet", 168)
	addWindow(payload.SevenDayOpus, "seven_day_opus", "Opus 每周用量", "model", "claude-3-opus", 168)
	addWindow(payload.SevenDayOAuthApps, "seven_day_oauth_apps", "第三方应用 每周用量", "standard", "", 168)
	addWindow(payload.SevenDayCowork, "seven_day_cowork", "Cowork 协作每周用量", "standard", "", 168)

	// Fable arrives either as a modern model-scoped limit or under the legacy
	// iguana_necktie window, so both spellings are probed.
	var foundFable bool
	for _, lim := range payload.Limits {
		modelName := ""
		if lim.Scope != nil && lim.Scope.Model != nil {
			modelName = lim.Scope.Model.DisplayName
		}
		if strings.EqualFold(modelName, "fable") || strings.EqualFold(modelName, "fable 5") {
			pct, hasPct := toFloat(lim.Percent)
			if hasPct {
				foundFable = true
				var resetAtMS *int64
				var resetLabel string
				if t, err := time.Parse(time.RFC3339, lim.ResetsAt); err == nil {
					ms := t.UnixMilli()
					resetAtMS = &ms
					resetLabel = formatResetInstant(ms, nowMS)
				}
				clampedUsed := clamp(pct, 0, 100)
				clampedRem := clamp(100-clampedUsed, 0, 100)
				periodHours := 168.0
				windows = append(windows, QuotaWindow{
					ID:               "seven_day_fable",
					Label:            "Fable 每周用量",
					Scope:            "model",
					Model:            "fable",
					UsedPercent:      &clampedUsed,
					RemainingPercent: &clampedRem,
					ResetAtMS:        resetAtMS,
					ResetLabel:       resetLabel,
					PeriodHours:      &periodHours,
					ResetAccuracy:    "exact",
				})
				break
			}
		}
	}
	if !foundFable && payload.IguanaNecktie != nil && !payload.IguanaNecktie.isDollarDenominated() {
		addWindow(payload.IguanaNecktie, "seven_day_fable", "Fable 每周用量", "model", "fable", 168)
	}

	// A disabled block is still reported: it says the credential cannot overflow
	// into paid usage. Only a block whose state is unreadable is dropped.
	var extraUsage *QuotaExtraUsage
	if eu := payload.ExtraUsage; eu != nil && eu.IsEnabled != nil {
		monLim, _ := toInt64(eu.MonthlyLimit)
		usedCreds, _ := toInt64(eu.UsedCredits)
		var utilPct *float64
		if u, ok := toFloat(eu.Utilization); ok {
			clamped := clamp(u, 0, 100)
			utilPct = &clamped
		} else if monLim > 0 {
			calc := clamp(float64(usedCreds)/float64(monLim)*100, 0, 100)
			utilPct = &calc
		}
		extraUsage = &QuotaExtraUsage{
			IsEnabled:           *eu.IsEnabled,
			MonthlyLimitCents:   monLim,
			UsedCreditsCents:    usedCreds,
			UtilizationPercent:  utilPct,
			Currency:            claudeCurrency(eu.Currency),
			DisabledReason:      grantLabel(eu.DisabledReason),
			IsUserDisabled:      eu.UserDisabled != nil && *eu.UserDisabled,
			IsSpendLimitReached: eu.SpendLimitReached != nil && *eu.SpendLimitReached,
		}
	}

	return windows, extraUsage, nil
}

var claudeCurrencyPattern = regexp.MustCompile(`^[A-Z]{3}$`)

// claudeCurrency keeps only an ISO 4217 code, which the console hands to the
// number formatter; anything else is left to the USD default.
func claudeCurrency(value string) string {
	value = strings.ToUpper(strings.TrimSpace(value))
	if claudeCurrencyPattern.MatchString(value) {
		return value
	}
	return ""
}

// claudeBalanceFields are what make an arbitrary usage key a dollar balance.
// Requiring all of them keeps a new percentage window, or any other object
// upstream adds, from being read as money.
var claudeBalanceFields = []string{"limit_dollars", "used_dollars", "remaining_dollars", "utilization", "resets_at"}

// ParseClaudeBalances reads the dollar allowances in the Claude usage response.
// iguana_necktie counts as soon as it carries a dollar amount, since that is
// what separates the cloud session credit pool from the legacy Fable window.
// Balances are ordered by key so a refresh does not reshuffle them.
func ParseClaudeBalances(raw []byte) []QuotaBalance {
	var fields map[string]json.RawMessage
	if json.Unmarshal(raw, &fields) != nil {
		return nil
	}
	keys := make([]string, 0, len(fields))
	for key := range fields {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	var balances []QuotaBalance
	for _, key := range keys {
		if key == "five_hour" || key == "seven_day" || key == "extra_usage" {
			continue
		}
		var members map[string]json.RawMessage
		var window RawClaudeWindow
		if json.Unmarshal(fields[key], &members) != nil || members == nil || json.Unmarshal(fields[key], &window) != nil {
			continue
		}
		isBalance := key == "iguana_necktie" && window.isDollarDenominated()
		if !isBalance {
			isBalance = true
			for _, field := range claudeBalanceFields {
				if _, ok := members[field]; !ok {
					isBalance = false
					break
				}
			}
		}
		if !isBalance || len(balances) >= 16 {
			continue
		}
		balance := QuotaBalance{ID: key}
		for _, amount := range []struct {
			value  any
			target **float64
		}{{window.LimitDollars, &balance.LimitUSD}, {window.UsedDollars, &balance.UsedUSD}, {window.RemainingDollars, &balance.RemainingUSD}} {
			if value, ok := toFloat(amount.value); ok && !math.IsNaN(value) && !math.IsInf(value, 0) {
				*amount.target = &value
			}
		}
		if utilization, ok := toFloat(window.Utilization); ok && !math.IsNaN(utilization) && !math.IsInf(utilization, 0) {
			clamped := clamp(utilization, 0, 100)
			balance.UtilizationPercent = &clamped
		}
		if instant, err := time.Parse(time.RFC3339Nano, window.ResetsAt); err == nil {
			resetAtMS := instant.UnixMilli()
			balance.ResetAtMS = &resetAtMS
		}
		balances = append(balances, balance)
	}
	return balances
}

// ParseClaudeProfile derives the subscription plan from the /api/oauth/profile
// response (ClaudeProfileURL), not from a billing endpoint.
func ParseClaudeProfile(raw []byte) *QuotaPlan {
	var profile RawClaudeProfileResponse
	if err := json.Unmarshal(raw, &profile); err != nil {
		return &QuotaPlan{
			PlanType:  "free",
			PlanLabel: "Free",
			Tier:      "free",
		}
	}

	planType := "free"
	planLabel := "Free"
	tier := "free"

	if profile.Account != nil {
		if profile.Account.HasClaudeMax {
			planType = "max"
			planLabel = "Claude Max"
			tier = "elite"
		} else if profile.Account.HasClaudePro {
			planType = "pro"
			planLabel = "Claude Pro"
			tier = "premium"
		}
	}

	if profile.Organization != nil && profile.Organization.RateLimitTier != "" {
		if planType == "free" {
			planType = strings.ToLower(profile.Organization.RateLimitTier)
			planLabel = profile.Organization.RateLimitTier
			tier = "standard"
		}
	}

	return &QuotaPlan{
		PlanType:  planType,
		PlanLabel: planLabel,
		Tier:      tier,
	}
}
