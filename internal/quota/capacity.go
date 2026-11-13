package quota

import "math"

// capacityResetTolerancePercent absorbs upstream rounding when two readings of
// the same cycle are compared: only a larger drop is a reset.
const capacityResetTolerancePercent = 1.0

// usedPercentHalfStep is half of the one-point granularity upstream reports, the
// most a rounded reading can differ from the share it stands for.
const usedPercentHalfStep = 0.5

// maxDisplayedCacheRate matches the console and dashboard presentation ceiling:
// any nonzero uncached prompt keeps a rounded reading below 100%.
const maxDisplayedCacheRate = 99.9

// Reasons a window carries no model forecast yet. They are wire values the
// console maps to its own copy, each naming the missing evidence.
const (
	// CapacityReasonScopeUnknown: a scoped window's requests all used models
	// with no known family, so none of them can be counted against it.
	CapacityReasonScopeUnknown       = "scope_unknown"
	CapacityReasonHistoryUnavailable = "history_unavailable"
	CapacityReasonUsageUnavailable   = "usage_unavailable"
	// CapacityReasonBoundaryUnknown: the reading names no reset instant or
	// period, so it cannot be placed in a cycle.
	CapacityReasonBoundaryUnknown = "boundary_unknown"
	// CapacityReasonExpired: the cycle the reading describes has already ended.
	CapacityReasonExpired = "expired"
	// CapacityReasonNoReading: upstream published no used share for the window.
	CapacityReasonNoReading = "no_reading"
	// CapacityReasonLowUsage: too little of the window has been used for its
	// rounded share to support a figure.
	CapacityReasonLowUsage    = "low_usage"
	CapacityReasonMixedModels = "mixed_models"
	// CapacityReasonNoTraffic: quota was used but this gateway recorded no
	// request while it moved, so it was spent elsewhere.
	CapacityReasonNoTraffic = "no_traffic"
	// CapacityReasonResetMidCycle: the counter was reset part-way through the
	// cycle and no reading since the reset gives a change to measure.
	CapacityReasonResetMidCycle = "reset_mid_cycle"
)

// WindowUsage is what this deployment recorded for a credential in [FromMS, ToMS).
type WindowUsage struct {
	FromMS               int64    `json:"from_ms"`
	ToMS                 int64    `json:"to_ms"`
	Requests             int64    `json:"requests"`
	PricedRequests       int64    `json:"priced_requests"`
	Tokens               int64    `json:"tokens"`
	PromptTokens         int64    `json:"prompt_tokens,omitempty"`
	CachedTokens         int64    `json:"cached_tokens,omitempty"`
	CacheRate            *float64 `json:"cache_rate,omitempty"`
	CostNanos            int64    `json:"cost_nanos"`
	PricedTokens         int64    `json:"-"`
	BreakdownRequests    int64    `json:"-"`
	CacheWriteTokens     int64    `json:"-"`
	OutputTokens         int64    `json:"-"`
	MinInputTokens       int64    `json:"-"`
	MaxInputTokens       int64    `json:"-"`
	HasInputBounds       bool     `json:"-"`
	ServiceTier          string   `json:"-"`
	HasMixedServiceTiers bool     `json:"-"`
	UnmatchedRequests    int64    `json:"-"`
}

func (usage WindowUsage) hasTokenBreakdown() bool {
	if usage.BreakdownRequests > 0 {
		return usage.BreakdownRequests == usage.Requests && (usage.PromptTokens > 0 || usage.OutputTokens > 0)
	}
	return usage.Requests > 0 && (usage.PromptTokens > 0 || usage.OutputTokens > 0)
}

func (usage WindowUsage) inputBounds() (minInput, maxInput int64, ok bool) {
	if !usage.hasTokenBreakdown() {
		return 0, 0, false
	}
	if usage.HasInputBounds || usage.MinInputTokens > 0 || usage.MaxInputTokens > 0 {
		return max(usage.MinInputTokens, 0), max(usage.MaxInputTokens, 0), true
	}
	if usage.Requests == 1 {
		single := max(usage.PromptTokens, usage.CachedTokens+usage.CacheWriteTokens)
		return single, single, true
	}
	return 0, 0, false
}

// ComputeCacheRate returns prompt cache reads as a percentage of prompt tokens,
// rounded to one decimal and bounded by maxDisplayedCacheRate, or nil when no
// prompt tokens were recorded.
func ComputeCacheRate(cachedTokens, promptTokens int64) *float64 {
	if promptTokens <= 0 {
		return nil
	}
	cached := min(max(cachedTokens, 0), promptTokens)
	rate := math.Round(float64(cached)/float64(promptTokens)*1000) / 10
	if rate > maxDisplayedCacheRate {
		rate = maxDisplayedCacheRate
	}
	return &rate
}

// SupportsWindowCapacity identifies supported global or model-metered windows.
// Scoped windows count only the models their families meter; a feature allowance
// has no model-only numerator and stays unsupported.
func SupportsWindowCapacity(provider string, window QuotaWindow) bool {
	if provider != "codex" && provider != "claude" && provider != "antigravity" {
		return false
	}
	if window.Scope == "model" || provider == "antigravity" && window.Scope == "group" {
		return true
	}
	if provider == "antigravity" || window.Scope != "standard" || window.Model != "" {
		return false
	}
	switch window.Kind {
	case "five_hour", "daily", "weekly", "monthly":
		return true
	}
	return window.ID == "five_hour" || window.ID == "seven_day"
}

// WindowCycleRange returns the half-open range of recorded usage that the
// window's used share accounts for. It ends at the observation rather than at
// "now": requests made after the reading are not part of the share it reports.
func WindowCycleRange(window QuotaWindow, observedAtMS, nowMS int64) (fromMS, toMS int64, reason string) {
	if window.ResetAtMS == nil || window.PeriodHours == nil || *window.PeriodHours <= 0 || math.IsNaN(*window.PeriodHours) || math.IsInf(*window.PeriodHours, 0) {
		return 0, 0, CapacityReasonBoundaryUnknown
	}
	if window.ResetAccuracy != "exact" && window.ResetAccuracy != "derived" && window.ResetAccuracy != "approximate" {
		return 0, 0, CapacityReasonBoundaryUnknown
	}
	resetAtMS := *window.ResetAtMS
	if resetAtMS <= nowMS {
		return 0, 0, CapacityReasonExpired
	}
	fromMS = resetAtMS - int64(*window.PeriodHours*3600*1000)
	toMS = min(observedAtMS, resetAtMS)
	if toMS <= fromMS {
		return 0, 0, CapacityReasonBoundaryUnknown
	}
	return fromMS, toMS, ""
}

// WindowUsedPercent also accepts providers that publish only the remaining share.
func WindowUsedPercent(window QuotaWindow) (float64, bool) {
	used := window.UsedPercent
	if used == nil && window.RemainingPercent != nil {
		value := 100 - *window.RemainingPercent
		used = &value
	}
	if used == nil || math.IsNaN(*used) || math.IsInf(*used, 0) || *used < 0 || *used > 100 {
		return 0, false
	}
	return *used, true
}
