package quota

import (
	"encoding/json"
	"fmt"
	"math"
	"strconv"
	"strings"
	"time"
)

const (
	FiveHourSeconds = 18000
	WeeklySeconds   = 604800
	MonthlySeconds  = 2592000
)

// RawCodexWindow handles both snake_case and camelCase serialization.
type RawCodexWindow struct {
	UsedPercent        any `json:"used_percent"`
	UsedPercentAlt     any `json:"usedPercent"`
	LimitWindowSeconds any `json:"limit_window_seconds"`
	LimitWindowSecAlt  any `json:"limitWindowSeconds"`
	ResetAfterSeconds  any `json:"reset_after_seconds"`
	ResetAfterSecAlt   any `json:"resetAfterSeconds"`
	ResetAt            any `json:"reset_at"`
	ResetAtAlt         any `json:"resetAt"`
}

type RawCodexRateLimit struct {
	Allowed         *bool           `json:"allowed"`
	LimitReached    *bool           `json:"limit_reached"`
	LimitReachedAlt *bool           `json:"limitReached"`
	PrimaryWindow   *RawCodexWindow `json:"primary_window"`
	PrimaryWinAlt   *RawCodexWindow `json:"primaryWindow"`
	SecondaryWindow *RawCodexWindow `json:"secondary_window"`
	SecondaryWinAlt *RawCodexWindow `json:"secondaryWindow"`
}

type RawCodexAdditionalRateLimit struct {
	LimitName      string             `json:"limit_name"`
	LimitNameAlt   string             `json:"limitName"`
	MeteredFeature string             `json:"metered_feature"`
	RateLimit      *RawCodexRateLimit `json:"rate_limit"`
	RateLimitAlt   *RawCodexRateLimit `json:"rateLimit"`
}

type RawCodexResetCredit struct {
	ID           string `json:"id"`
	Status       string `json:"status"`
	ResetType    string `json:"reset_type"`
	ResetTypeAlt string `json:"resetType"`
	GrantedAt    string `json:"grantedAt"`
	GrantedAtAlt string `json:"granted_at"`
	ExpiresAt    string `json:"expiresAt"`
	ExpiresAtAlt string `json:"expires_at"`
}

type RawCodexResetCreditsSummary struct {
	AvailableCount           any                   `json:"available_count"`
	AvailableCountAlt        any                   `json:"availableCount"`
	ApplicableAvailableCount any                   `json:"applicable_available_count"`
	ApplicableCountAlt       any                   `json:"applicableAvailableCount"`
	Credits                  []RawCodexResetCredit `json:"credits,omitempty"`
}

type RawCodexUsagePayload struct {
	PlanType                string                        `json:"plan_type"`
	PlanTypeAlt             string                        `json:"planType"`
	SubscriptionActiveUntil any                           `json:"subscription_active_until"`
	SubscriptionActiveAlt   any                           `json:"subscriptionActiveUntil"`
	RateLimit               *RawCodexRateLimit            `json:"rate_limit"`
	RateLimitAlt            *RawCodexRateLimit            `json:"rateLimit"`
	CodeReviewRateLimit     *RawCodexRateLimit            `json:"code_review_rate_limit"`
	CodeReviewRateLimitAlt  *RawCodexRateLimit            `json:"codeReviewRateLimit"`
	AdditionalRateLimits    []RawCodexAdditionalRateLimit `json:"additional_rate_limits"`
	AdditionalRateLimitsAlt []RawCodexAdditionalRateLimit `json:"additionalRateLimits"`
	RateLimitResetCredits   *RawCodexResetCreditsSummary  `json:"rate_limit_reset_credits"`
	RateLimitResetCredsAlt  *RawCodexResetCreditsSummary  `json:"rateLimitResetCredits"`
}

func toFloat(val any) (float64, bool) {
	if val == nil {
		return 0, false
	}
	switch v := val.(type) {
	case float64:
		return v, true
	case float32:
		return float64(v), true
	case int:
		return float64(v), true
	case int64:
		return float64(v), true
	case json.Number:
		if f, err := v.Float64(); err == nil {
			return f, true
		}
	case string:
		v = strings.TrimSpace(v)
		if f, err := strconv.ParseFloat(v, 64); err == nil {
			return f, true
		}
	}
	return 0, false
}

func toInt64(val any) (int64, bool) {
	if val == nil {
		return 0, false
	}
	switch v := val.(type) {
	case int64:
		return v, true
	case int:
		return int64(v), true
	case float64:
		return int64(v), true
	case json.Number:
		if i, err := v.Int64(); err == nil {
			return i, true
		}
	case string:
		v = strings.TrimSpace(v)
		if i, err := strconv.ParseInt(v, 10, 64); err == nil {
			return i, true
		}
		// Could be an ISO timestamp
		if t, err := time.Parse(time.RFC3339, v); err == nil {
			return t.UnixMilli(), true
		}
		if t, err := time.Parse(time.RFC3339Nano, v); err == nil {
			return t.UnixMilli(), true
		}
	}
	return 0, false
}

func clamp(val, min, max float64) float64 {
	if val < min {
		return min
	}
	if val > max {
		return max
	}
	return val
}

func parseWindowDurationHours(seconds float64) float64 {
	if seconds <= 0 {
		return 0
	}
	return math.Round((seconds/3600.0)*10) / 10
}

func formatDurationShort(duration time.Duration) string {
	if duration <= 0 {
		return "刚刚"
	}
	totalMinutes := int(math.Ceil(duration.Minutes()))
	if totalMinutes < 60 {
		return fmt.Sprintf("%d分钟", totalMinutes)
	}
	hours := totalMinutes / 60
	mins := totalMinutes % 60
	if hours < 24 {
		if mins > 0 {
			return fmt.Sprintf("%d小时%d分", hours, mins)
		}
		return fmt.Sprintf("%d小时", hours)
	}
	days := hours / 24
	remHours := hours % 24
	if remHours > 0 {
		return fmt.Sprintf("%d天%d小时", days, remHours)
	}
	return fmt.Sprintf("%d天", days)
}

func formatResetInstant(resetAtMS int64, nowMS int64) string {
	if resetAtMS <= 0 {
		return ""
	}
	resetTime := time.UnixMilli(resetAtMS)
	diff := time.Duration(resetAtMS-nowMS) * time.Millisecond
	if diff <= 0 {
		return "已恢复"
	}
	rel := formatDurationShort(diff)
	// Local clock time format: HH:mm or MM-DD HH:mm
	if diff < 24*time.Hour {
		return fmt.Sprintf("%s (%s后恢复)", resetTime.Format("15:04"), rel)
	}
	return fmt.Sprintf("%s (%s后恢复)", resetTime.Format("01-02 15:04"), rel)
}

func resolveCodexPlanTier(planType string) (tier string, label string) {
	norm := strings.ToLower(strings.TrimSpace(planType))
	switch norm {
	case "pro":
		return "elite", "Pro 20x"
	case "prolite", "pro_lite", "premium":
		return "premium", "Pro Lite"
	case "plus":
		return "standard", "Plus"
	case "team":
		return "standard", "Team"
	case "free":
		return "free", "Free"
	default:
		if norm != "" {
			return "standard", strings.ToUpper(norm[:1]) + norm[1:]
		}
		return "unknown", "未知套餐"
	}
}

// ParseCodexUsage parses the raw JSON from https://chatgpt.com/backend-api/wham/usage.
func ParseCodexUsage(raw []byte, nowMS int64) (*QuotaPlan, []QuotaWindow, *CodexResetCreditsInfo, error) {
	var payload RawCodexUsagePayload
	if err := json.Unmarshal(raw, &payload); err != nil {
		return nil, nil, nil, fmt.Errorf("invalid codex payload: %w", err)
	}

	planType := payload.PlanType
	if planType == "" {
		planType = payload.PlanTypeAlt
	}

	tier, planLabel := resolveCodexPlanTier(planType)
	var expiresAtMS *int64
	var expiresLabel string

	rawExpiry := payload.SubscriptionActiveUntil
	if rawExpiry == nil {
		rawExpiry = payload.SubscriptionActiveAlt
	}
	if exp, ok := toInt64(rawExpiry); ok {
		// If it's in seconds instead of ms (< 10^11)
		if exp < 100000000000 {
			exp = exp * 1000
		}
		expiresAtMS = &exp
		diff := time.Duration(exp-nowMS) * time.Millisecond
		if diff > 0 {
			expiresLabel = formatDurationShort(diff) + "后到期"
		} else {
			expiresLabel = "已到期"
		}
	}

	plan := &QuotaPlan{
		PlanType:     planType,
		PlanLabel:    planLabel,
		Tier:         tier,
		ExpiresAtMS:  expiresAtMS,
		ExpiresLabel: expiresLabel,
	}

	// Parse Rate Limits
	rateLimit := payload.RateLimit
	if rateLimit == nil {
		rateLimit = payload.RateLimitAlt
	}

	windows := make([]QuotaWindow, 0)

	addWindow := func(w *RawCodexWindow, id, defaultLabel, scope, model string) {
		if w == nil {
			return
		}
		rawUsed := w.UsedPercent
		if rawUsed == nil {
			rawUsed = w.UsedPercentAlt
		}
		usedVal, hasUsed := toFloat(rawUsed)

		rawWinSec := w.LimitWindowSeconds
		if rawWinSec == nil {
			rawWinSec = w.LimitWindowSecAlt
		}
		winSec, _ := toFloat(rawWinSec)

		rawResetAfter := w.ResetAfterSeconds
		if rawResetAfter == nil {
			rawResetAfter = w.ResetAfterSecAlt
		}
		resetAfterSec, hasResetAfter := toFloat(rawResetAfter)

		rawResetAt := w.ResetAt
		if rawResetAt == nil {
			rawResetAt = w.ResetAtAlt
		}
		resetAtVal, hasResetAt := toInt64(rawResetAt)

		var resetAtMS *int64
		accuracy := "approximate"
		if hasResetAt && resetAtVal > 0 {
			if resetAtVal < 100000000000 {
				resetAtVal = resetAtVal * 1000
			}
			resetAtMS = &resetAtVal
			accuracy = "exact"
		} else if hasResetAfter && resetAfterSec > 0 {
			calculated := nowMS + int64(resetAfterSec*1000)
			resetAtMS = &calculated
			accuracy = "derived"
		}

		var periodHours *float64
		if winSec > 0 {
			hours := parseWindowDurationHours(winSec)
			periodHours = &hours
		}

		// Determine label based on window seconds
		label := defaultLabel
		kind := "custom"
		if scope == "standard" && model == "" {
			if winSec >= WeeklySeconds-3600 && winSec <= WeeklySeconds+3600 {
				label = "每周用量上限 (Weekly)"
				id = "weekly"
				kind = "weekly"
			} else if winSec >= FiveHourSeconds-600 && winSec <= FiveHourSeconds+600 {
				label = "5小时用量上限 (5-Hour)"
				id = "five_hour"
				kind = "five_hour"
			}
		} else if scope == "model" {
			kind = "model_scoped"
		}

		var usedPercent *float64
		var remainingPercent *float64
		if hasUsed {
			clampedUsed := clamp(usedVal, 0, 100)
			usedPercent = &clampedUsed
			clampedRem := clamp(100-clampedUsed, 0, 100)
			remainingPercent = &clampedRem
		}

		var resetLabel string
		if resetAtMS != nil {
			resetLabel = formatResetInstant(*resetAtMS, nowMS)
		}

		windows = append(windows, QuotaWindow{
			ID:               id,
			Label:            label,
			Kind:             kind,
			Scope:            scope,
			Model:            model,
			UsedPercent:      usedPercent,
			RemainingPercent: remainingPercent,
			ResetAtMS:        resetAtMS,
			ResetLabel:       resetLabel,
			PeriodHours:      periodHours,
			ResetAccuracy:    accuracy,
		})
	}

	if rateLimit != nil {
		primary := rateLimit.PrimaryWindow
		if primary == nil {
			primary = rateLimit.PrimaryWinAlt
		}
		secondary := rateLimit.SecondaryWindow
		if secondary == nil {
			secondary = rateLimit.SecondaryWinAlt
		}

		addWindow(primary, "five_hour", "5小时用量上限 (5-Hour)", "standard", "")
		addWindow(secondary, "weekly", "每周用量上限 (Weekly)", "standard", "")
	}

	// Code review rate limit
	codeReview := payload.CodeReviewRateLimit
	if codeReview == nil {
		codeReview = payload.CodeReviewRateLimitAlt
	}
	if codeReview != nil {
		crPrimary := codeReview.PrimaryWindow
		if crPrimary == nil {
			crPrimary = codeReview.PrimaryWinAlt
		}
		crSecondary := codeReview.SecondaryWindow
		if crSecondary == nil {
			crSecondary = codeReview.SecondaryWinAlt
		}
		addWindow(crPrimary, "code_review_5h", "代码审查 5小时配额", "standard", "")
		addWindow(crSecondary, "code_review_weekly", "代码审查 每周配额", "standard", "")
	}

	// Additional rate limits (e.g. GPT-5.3-Codex-Spark, o1, etc.)
	addlLimits := payload.AdditionalRateLimits
	if len(addlLimits) == 0 {
		addlLimits = payload.AdditionalRateLimitsAlt
	}
	for i, addl := range addlLimits {
		name := addl.LimitName
		if name == "" {
			name = addl.LimitNameAlt
		}
		if name == "" {
			name = addl.MeteredFeature
		}
		if name == "" {
			name = fmt.Sprintf("Limit-%d", i+1)
		}

		lim := addl.RateLimit
		if lim == nil {
			lim = addl.RateLimitAlt
		}
		if lim != nil {
			p := lim.PrimaryWindow
			if p == nil {
				p = lim.PrimaryWinAlt
			}
			s := lim.SecondaryWindow
			if s == nil {
				s = lim.SecondaryWinAlt
			}
			addWindow(p, fmt.Sprintf("addl_%d_p", i), fmt.Sprintf("%s 5小时配额", name), "model", name)
			addWindow(s, fmt.Sprintf("addl_%d_s", i), fmt.Sprintf("%s 每周配额", name), "model", name)
		}
	}

	// Parse Rate Limit Reset Credits
	resetCreditsRaw := payload.RateLimitResetCredits
	if resetCreditsRaw == nil {
		resetCreditsRaw = payload.RateLimitResetCredsAlt
	}

	var resetCreditsInfo *CodexResetCreditsInfo
	if resetCreditsRaw != nil {
		resetCreditsInfo = parseCodexResetCreditsSummary(resetCreditsRaw)
	}

	return plan, windows, resetCreditsInfo, nil
}

// parseCodexResetCreditsSummary normalizes a raw Codex rate-limit reset credits
// summary. Only usable credits survive: CPAMC-parity filtering keeps credits
// whose reset_type (when projected) targets codex_rate_limits and whose status
// is "available", so consumed/expired credits never inflate the reset count.
func parseCodexResetCreditsSummary(resetCreditsRaw *RawCodexResetCreditsSummary) *CodexResetCreditsInfo {
	availVal, _ := toFloat(resetCreditsRaw.AvailableCount)
	if availVal == 0 {
		availVal, _ = toFloat(resetCreditsRaw.AvailableCountAlt)
	}

	appVal, _ := toFloat(resetCreditsRaw.ApplicableAvailableCount)
	if appVal == 0 {
		appVal, _ = toFloat(resetCreditsRaw.ApplicableCountAlt)
	}

	credits := make([]CodexResetCredit, 0)
	for _, rc := range resetCreditsRaw.Credits {
		if !isRedeemableCodexCredit(rc) {
			continue
		}
		var grantedMS *int64
		if g, ok := parseCreditInstantToMS(creditInstant(rc.GrantedAt, rc.GrantedAtAlt)); ok {
			grantedMS = &g
		}
		var expMS *int64
		if e, ok := parseCreditInstantToMS(creditInstant(rc.ExpiresAt, rc.ExpiresAtAlt)); ok {
			expMS = &e
		}
		credits = append(credits, CodexResetCredit{
			ID:          rc.ID,
			Status:      rc.Status,
			GrantedAtMS: grantedMS,
			ExpiresAtMS: expMS,
		})
	}

	return &CodexResetCreditsInfo{
		AvailableCount:           int(availVal),
		ApplicableAvailableCount: int(appVal),
		Credits:                  credits,
	}
}

// isRedeemableCodexCredit mirrors CPAMC's credit filter: the upstream payload
// mixes consumed and expired credits into the same list.
func isRedeemableCodexCredit(rc RawCodexResetCredit) bool {
	if strings.TrimSpace(rc.Status) != "available" {
		return false
	}
	resetType := strings.TrimSpace(rc.ResetType)
	if resetType == "" {
		resetType = strings.TrimSpace(rc.ResetTypeAlt)
	}
	return resetType == "" || resetType == "codex_rate_limits"
}

// creditInstant prefers snake_case (current upstream) and falls back to the
// legacy camelCase spelling; values are epoch seconds or milliseconds.
func creditInstant(primary, alt string) string {
	if strings.TrimSpace(primary) != "" {
		return primary
	}
	return alt
}

// parseCreditInstantToMS parses a credit timestamp the way CPAMC does: the
// upstream field may be ISO-8601 or a Unix epoch in seconds or milliseconds,
// disambiguated by magnitude.
func parseCreditInstantToMS(value string) (int64, bool) {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return 0, false
	}
	if t, err := time.Parse(time.RFC3339, trimmed); err == nil {
		return t.UnixMilli(), true
	}
	if ms, ok := toInt64(trimmed); ok && ms > 0 {
		if ms < 100000000000 {
			ms *= 1000
		}
		return ms, true
	}
	return 0, false
}

// ParseCodexResetCreditsPayload parses the dedicated rate-limit reset credits
// endpoint (GET https://chatgpt.com/backend-api/wham/rate-limit-reset-credits),
// which returns the same summary shape as the usage payload's credits block.
func ParseCodexResetCreditsPayload(raw []byte) (*CodexResetCreditsInfo, error) {
	var summary RawCodexResetCreditsSummary
	if err := json.Unmarshal(raw, &summary); err != nil {
		return nil, fmt.Errorf("invalid codex reset credits payload: %w", err)
	}
	return parseCodexResetCreditsSummary(&summary), nil
}
