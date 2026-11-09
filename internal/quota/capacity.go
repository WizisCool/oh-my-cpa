package quota

import "math"

// capacityMinPricedShare is the share of measured requests that must carry a cost
// before a dollar figure is given. Unpriced requests add nothing to the cost sum,
// so a lower share would understate it; the token figure does not depend on prices.
const capacityMinPricedShare = 0.95

// capacityResetTolerancePercent absorbs upstream rounding when two readings of
// the same cycle are compared: only a larger drop is a reset.
const capacityResetTolerancePercent = 1.0

// usedPercentHalfStep is half of the one-point granularity upstream reports, the
// most a rounded reading can differ from the share it stands for.
const usedPercentHalfStep = 0.5

// Reasons a window carries no capacity estimate yet. They are wire values the
// console maps to its own copy, each naming what starts an estimate.
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
	CapacityReasonLowUsage = "low_usage"
	// CapacityReasonNoTraffic: quota was used but this gateway recorded no
	// request while it moved, so it was spent elsewhere.
	CapacityReasonNoTraffic = "no_traffic"
	// CapacityReasonResetMidCycle: the counter was reset part-way through the
	// cycle and no reading since the reset gives a change to measure.
	CapacityReasonResetMidCycle = "reset_mid_cycle"
)

// WindowUsage is what this deployment recorded for a credential in [FromMS, ToMS).
type WindowUsage struct {
	FromMS         int64 `json:"from_ms"`
	ToMS           int64 `json:"to_ms"`
	Requests       int64 `json:"requests"`
	PricedRequests int64 `json:"priced_requests"`
	Tokens         int64 `json:"tokens"`
	CostNanos      int64 `json:"cost_nanos"`
	// UnmatchedRequests are scoped-window requests whose model has no known
	// family. They are left out of the numerator and only explain an empty one.
	UnmatchedRequests int64 `json:"-"`
}

// WindowCapacity is the size of a whole quota window in the recorded workload's
// tokens and API-equivalent cost, with what is left of it at the reading.
type WindowCapacity struct {
	// Requests is how many requests of the recorded workload the window holds.
	Requests     int64  `json:"requests"`
	Tokens       int64  `json:"tokens"`
	Basis        string `json:"basis"`
	ObservedAtMS int64  `json:"observed_at_ms"`
	FromMS       int64  `json:"from_ms"`
	ResetAtMS    int64  `json:"reset_at_ms"`
	// CostNanos is nil when too much of the sample is unpriced to state a cost.
	CostNanos *int64 `json:"cost_nanos,omitempty"`
	// Remaining amounts are given only with a live reading of the used share.
	RemainingTokens    *int64 `json:"remaining_tokens,omitempty"`
	RemainingCostNanos *int64 `json:"remaining_cost_nanos,omitempty"`
	// ErrorPercent is the relative effect of upstream's whole-point rounding on
	// the estimate; the console rounds the figure to the digits it supports.
	ErrorPercent float64 `json:"error_percent"`
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

// AttachRemainingCapacity sizes what is left of the window from a live reading.
func AttachRemainingCapacity(capacity *WindowCapacity, window QuotaWindow, isLive bool) {
	if capacity == nil {
		return
	}
	capacity.RemainingTokens, capacity.RemainingCostNanos = nil, nil
	used, hasReading := WindowUsedPercent(window)
	if !isLive || !hasReading {
		return
	}
	remaining := (100 - used) / 100
	tokens := int64(math.Round(float64(capacity.Tokens) * remaining))
	capacity.RemainingTokens = &tokens
	if capacity.CostNanos != nil {
		cost := int64(math.Round(float64(*capacity.CostNanos) * remaining))
		capacity.RemainingCostNanos = &cost
	}
}
