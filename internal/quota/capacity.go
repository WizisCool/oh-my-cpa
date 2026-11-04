package quota

import "math"

// CapacityCalibrationPercent is the used share at which a window's own sample
// replaces a reference estimate. A smaller sample still gives an estimate, blended
// with the reference in proportion to its size.
const CapacityCalibrationPercent = 5.0

// capacityMinPricedShare is the share of sampled requests that must carry a cost
// before a dollar figure is given. Unpriced requests add nothing to the cost sum,
// so a lower share would understate it; the token figure does not depend on prices.
const capacityMinPricedShare = 0.95

// capacityResetTolerancePercent absorbs upstream rounding when two readings of
// the same cycle are compared.
const capacityResetTolerancePercent = 1.0

// usedPercentHalfStep is half of the one-point granularity upstream reports.
const usedPercentHalfStep = 0.5

// Reasons a window carries no capacity estimate yet. They are wire values the
// console maps to its own copy, each naming what starts an estimate.
const (
	// CapacityReasonScopeUnknown: a scoped window's requests all used models
	// with no known family, so none of them can be counted against it.
	CapacityReasonScopeUnknown       = "scope_unknown"
	CapacityReasonHistoryUnavailable = "history_unavailable"
	CapacityReasonUsageUnavailable   = "usage_unavailable"
	// CapacityReasonBoundaryUnknown: there is no earlier reading to measure a
	// change from, and the cycle start cannot be derived from the reset instant.
	CapacityReasonBoundaryUnknown = "boundary_unknown"
	// CapacityReasonExpired: the cycle the reading describes has already ended.
	CapacityReasonExpired = "expired"
	// CapacityReasonNoReading: upstream published no used share for the window.
	CapacityReasonNoReading = "no_reading"
	// CapacityReasonLowUsage: no quota has been used yet in the sample.
	CapacityReasonLowUsage = "low_usage"
	// CapacityReasonNoTraffic: quota was used but no request of this credential
	// was recorded in the sample, so it was spent outside the gateway.
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
	// SamplePercent is the used share the estimate was divided by.
	SamplePercent float64 `json:"-"`
}

// ObservedWindows is one earlier quota observation of a credential.
type ObservedWindows struct {
	ObservedAtMS int64
	PlanType     string
	PlanTier     string
	Windows      []QuotaWindow
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
// Only a whole-cycle estimate needs it; a change between two readings does not.
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

// EstimateWindowCapacity divides a whole cycle's usage by its used share, for a
// window with no earlier reading to measure a change from. A cycle that was reset
// part-way is refused: its pre-reset traffic is not in the current share.
func EstimateWindowCapacity(window QuotaWindow, usage WindowUsage, earlierPeak *float64) (*WindowCapacity, string) {
	if window.HasMidCycleReset {
		return nil, CapacityReasonResetMidCycle
	}
	used, hasReading := WindowUsedPercent(window)
	if !hasReading {
		return nil, CapacityReasonNoReading
	}
	if earlierPeak != nil && *earlierPeak > used+capacityResetTolerancePercent {
		return nil, CapacityReasonResetMidCycle
	}
	if used == 0 {
		return nil, CapacityReasonLowUsage
	}
	capacity, reason := estimateUsageCapacity(usage, used, usedPercentHalfStep, "current_cycle")
	if capacity != nil && window.ResetAtMS != nil {
		capacity.ResetAtMS = *window.ResetAtMS
	}
	return capacity, reason
}

// EstimateDeltaCapacity excludes the consumption that predates the baseline.
// Both endpoints are rounded readings, so the sensitivity is one point rather
// than the half-point sensitivity of a whole-cycle ratio.
func EstimateDeltaCapacity(window QuotaWindow, usage WindowUsage, usedChange float64) (*WindowCapacity, string) {
	capacity, reason := estimateUsageCapacity(usage, usedChange, 2*usedPercentHalfStep, "observed_delta")
	if capacity != nil && window.ResetAtMS != nil {
		capacity.ResetAtMS = *window.ResetAtMS
	}
	return capacity, reason
}

func estimateUsageCapacity(usage WindowUsage, percent, roundingStep float64, basis string) (*WindowCapacity, string) {
	if math.IsNaN(percent) || math.IsInf(percent, 0) || percent <= 0 || percent > 100 {
		return nil, CapacityReasonLowUsage
	}
	if usage.Requests <= 0 && usage.UnmatchedRequests > 0 {
		return nil, CapacityReasonScopeUnknown
	}
	if usage.Requests <= 0 || usage.Tokens <= 0 && usage.CostNanos <= 0 {
		return nil, CapacityReasonNoTraffic
	}
	scale := 100 / percent
	capacity := &WindowCapacity{
		Tokens: int64(math.Round(float64(usage.Tokens) * scale)), Basis: basis,
		ObservedAtMS: usage.ToMS, FromMS: usage.FromMS, SamplePercent: percent,
		ErrorPercent: math.Round(roundingStep/math.Max(percent-roundingStep, roundingStep)*1000) / 10,
	}
	if float64(usage.PricedRequests) >= float64(usage.Requests)*capacityMinPricedShare {
		cost := int64(math.Round(float64(usage.CostNanos) * scale))
		capacity.CostNanos = &cost
	}
	return capacity, ""
}

// BlendWindowCapacity lets a small new sample move a reference estimate in
// proportion to its size; CapacityCalibrationPercent points replace it.
func BlendWindowCapacity(current, reference *WindowCapacity) *WindowCapacity {
	if current == nil {
		return reference
	}
	if reference == nil || current.SamplePercent >= CapacityCalibrationPercent {
		return current
	}
	weight := current.SamplePercent / CapacityCalibrationPercent
	blend := func(value, prior int64) int64 {
		return int64(math.Round(float64(value)*weight + float64(prior)*(1-weight)))
	}
	result := *current
	result.Basis = "blended"
	result.Tokens = blend(current.Tokens, reference.Tokens)
	if current.CostNanos != nil && reference.CostNanos != nil {
		cost := blend(*current.CostNanos, *reference.CostNanos)
		result.CostNanos = &cost
	}
	result.ErrorPercent = max(current.ErrorPercent, reference.ErrorPercent)
	return &result
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
