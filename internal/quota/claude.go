package quota

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

type RawClaudeWindow struct {
	Utilization any    `json:"utilization"`
	ResetsAt    string `json:"resets_at"`
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
	IsEnabled    bool `json:"is_enabled"`
	MonthlyLimit any  `json:"monthly_limit"`
	UsedCredits  any  `json:"used_credits"`
	Utilization  any  `json:"utilization"`
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
			Model:            model,
			UsedPercent:      usedPercent,
			RemainingPercent: remainingPercent,
			ResetAtMS:        resetAtMS,
			ResetLabel:       resetLabel,
			PeriodHours:      &periodHours,
			ResetAccuracy:    accuracy,
		})
	}

	// 1. Standard rolling windows
	addWindow(payload.FiveHour, "five_hour", "5小时滚动用量 (5-Hour)", "standard", "", 5)
	addWindow(payload.SevenDay, "seven_day", "每周总用量上限 (Weekly)", "standard", "", 168)
	addWindow(payload.SevenDaySonnet, "seven_day_sonnet", "Sonnet 每周用量", "model", "claude-3-5-sonnet", 168)
	addWindow(payload.SevenDayOpus, "seven_day_opus", "Opus 每周用量", "model", "claude-3-opus", 168)
	addWindow(payload.SevenDayOAuthApps, "seven_day_oauth_apps", "第三方应用 每周用量", "standard", "", 168)
	addWindow(payload.SevenDayCowork, "seven_day_cowork", "Cowork 协作每周用量", "standard", "", 168)

	// 2. Fable limit (modern scoped or legacy iguana_necktie)
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
	if !foundFable && payload.IguanaNecktie != nil {
		addWindow(payload.IguanaNecktie, "seven_day_fable", "Fable 每周用量", "model", "fable", 168)
	}

	// 3. Extra usage
	var extraUsage *QuotaExtraUsage
	if eu := payload.ExtraUsage; eu != nil && eu.IsEnabled {
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
			IsEnabled:          eu.IsEnabled,
			MonthlyLimitCents:  monLim,
			UsedCreditsCents:   usedCreds,
			UtilizationPercent: utilPct,
		}
	}

	return windows, extraUsage, nil
}

// ParseClaudeProfile derives subscription plan from /api/account profile response.
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
