package quota

import "math"

// capacityResetTolerancePercent absorbs upstream rounding when two readings of
// the same cycle are compared: only a larger drop is a mid-cycle reset.
const capacityResetTolerancePercent = 1.0

// minEstimableUsedPercent rejects float noise (e.g. 1e-300) while allowing any
// real provider reading (0.1%, 1%, ...) to scale immediately without a 5% gate.
const minEstimableUsedPercent = 0.01

// maxDisplayedCacheRate matches the console and dashboard presentation ceiling:
// any nonzero uncached prompt keeps a rounded reading below 100%.
const maxDisplayedCacheRate = 99.9

// Basis values describing which cycle's consumption supplied a capacity estimate.
const (
	CapacityBasisCurrentWindow  = "current_window"
	CapacityBasisPreviousWindow = "previous_window"
)

// Reasons a window carries no capacity estimate yet. They are wire values the
// console maps to its own copy.
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
	// CapacityReasonLowUsage: the window reports zero used share so far.
	CapacityReasonLowUsage = "low_usage"
	// CapacityReasonNoTraffic: quota was used but this gateway recorded no
	// request in the window, so consumption happened elsewhere.
	CapacityReasonNoTraffic = "no_traffic"
	// CapacityReasonResetMidCycle: the counter was reset part-way through the
	// cycle and no earlier or post-reset consumption can size it yet.
	CapacityReasonResetMidCycle = "reset_mid_cycle"
)

// WindowUsage is what this deployment recorded for a credential in [FromMS, ToMS).
type WindowUsage struct {
	FromMS            int64    `json:"from_ms"`
	ToMS              int64    `json:"to_ms"`
	Requests          int64    `json:"requests"`
	PricedRequests    int64    `json:"priced_requests"`
	Tokens            int64    `json:"tokens"`
	PromptTokens      int64    `json:"prompt_tokens,omitempty"`
	CachedTokens      int64    `json:"cached_tokens,omitempty"`
	CacheRate         *float64 `json:"cache_rate,omitempty"`
	CostNanos         int64    `json:"cost_nanos"`
	UnmatchedRequests int64    `json:"-"`
}

// WindowCapacity is the estimated 100% full-window allowance, scaled linearly
// from recorded window consumption and upstream used percentage.
type WindowCapacity struct {
	Basis                string   `json:"basis"`
	SampleRequests       int64    `json:"sample_requests"`
	SamplePricedRequests int64    `json:"sample_priced_requests,omitempty"`
	Requests             int64    `json:"requests"`
	Tokens               int64    `json:"tokens"`
	CostNanos            *int64   `json:"cost_nanos,omitempty"`
	CacheRate            *float64 `json:"cache_rate,omitempty"`
}

func scaleMetricToFullWindow(actual int64, usedPercent float64) (int64, bool) {
	if actual < 0 {
		return 0, false
	}
	raw := math.Round(float64(actual) * 100 / usedPercent)
	if math.IsNaN(raw) || math.IsInf(raw, 0) || raw < 0 || raw >= maxInt64Exclusive {
		return 0, false
	}
	return max(actual, int64(raw)), true
}

// ScaleWindowCapacity extrapolates 100% window capacity from a recorded usage
// sample and its consumed percentage share, clamping to at least recorded
// actuals and guarding against float/int64 overflow.
func ScaleWindowCapacity(basis string, usedPercent float64, usage WindowUsage) *WindowCapacity {
	if math.IsNaN(usedPercent) || math.IsInf(usedPercent, 0) || usedPercent < minEstimableUsedPercent || usedPercent > 100 || usage.Requests <= 0 || usage.Tokens <= 0 {
		return nil
	}
	requests, okReq := scaleMetricToFullWindow(usage.Requests, usedPercent)
	tokens, okTok := scaleMetricToFullWindow(usage.Tokens, usedPercent)
	if !okReq || !okTok || requests <= 0 || tokens <= 0 {
		return nil
	}
	var costNanos *int64
	if usage.PricedRequests == usage.Requests || (usage.PricedRequests > 0 && usage.CostNanos > 0) {
		if cost, okCost := scaleMetricToFullWindow(usage.CostNanos, usedPercent); okCost {
			costNanos = &cost
		}
	}
	return &WindowCapacity{
		Basis:                basis,
		SampleRequests:       usage.Requests,
		SamplePricedRequests: usage.PricedRequests,
		Requests:             requests,
		Tokens:               tokens,
		CostNanos:            costNanos,
		CacheRate:            ComputeCacheRate(usage.CachedTokens, usage.PromptTokens),
	}
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
