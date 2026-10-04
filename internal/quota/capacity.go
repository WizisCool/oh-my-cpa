package quota

import "math"

// CapacityMinUsedPercent is the lowest used share an estimate is derived from.
// Upstream reports whole percentage points, so the reading is only known to
// within half a point: at 5% the estimate is already uncertain by a tenth, and
// below it the division amplifies rounding into a figure that reads as precise
// while being off by a multiple.
const CapacityMinUsedPercent = 5.0

// capacityMinPricedShare is the share of a cycle's requests that must carry a
// cost snapshot before a dollar estimate is given. Unpriced requests add
// nothing to the cost sum, so a lower share would understate the capacity
// without saying so; the token estimate does not depend on prices and stays.
const capacityMinPricedShare = 0.95

// capacityResetTolerancePercent absorbs upstream rounding when an earlier
// reading of the same cycle is compared with the current one.
const capacityResetTolerancePercent = 1.0

// usedPercentHalfStep is half of the one-point granularity upstream reports.
const usedPercentHalfStep = 0.5

// Reasons a window carries no capacity estimate. They are wire values the
// console maps to its own copy.
const (
	// CapacityReasonBoundaryUnknown: the cycle start cannot be derived, because
	// the reset instant or the period is missing or only approximate.
	CapacityReasonBoundaryUnknown = "boundary_unknown"
	// CapacityReasonExpired: the cycle the reading describes has already ended.
	CapacityReasonExpired = "expired"
	// CapacityReasonStale: the windows were kept from an earlier observation
	// because the credential is disabled or its refresh failed.
	CapacityReasonStale = "stale"
	// CapacityReasonNoReading: upstream published no used share for the window.
	CapacityReasonNoReading = "no_reading"
	// CapacityReasonLowUsage: the used share is below CapacityMinUsedPercent.
	CapacityReasonLowUsage = "low_usage"
	// CapacityReasonNoTraffic: quota was consumed but no request of this
	// credential was recorded in the cycle, so it was spent outside the gateway.
	CapacityReasonNoTraffic = "no_traffic"
	// CapacityReasonResetMidCycle: an earlier reading inside the same cycle was
	// higher, so the counter was reset part-way and the recorded usage no
	// longer corresponds to the used share.
	CapacityReasonResetMidCycle = "reset_mid_cycle"
)

// WindowUsage is what this deployment recorded for a credential inside a
// window's current cycle, up to the moment the used share was observed.
type WindowUsage struct {
	FromMS         int64 `json:"from_ms"`
	ToMS           int64 `json:"to_ms"`
	Requests       int64 `json:"requests"`
	PricedRequests int64 `json:"priced_requests"`
	Tokens         int64 `json:"tokens"`
	CostNanos      int64 `json:"cost_nanos"`
}

// WindowCapacity is the estimated size of a whole window: the recorded usage
// scaled to 100% of the quota. It is not a projection of what will have been
// used when the window ends.
type WindowCapacity struct {
	Tokens int64 `json:"tokens"`
	// CostNanos is nil when too much of the cycle's usage is unpriced.
	CostNanos *int64 `json:"cost_nanos,omitempty"`
	// ErrorPercent is the relative uncertainty, in percent, that upstream's
	// whole-point rounding of the used share puts on the estimate.
	ErrorPercent float64 `json:"error_percent"`
}

// ObservedWindows is one earlier quota observation of a credential.
type ObservedWindows struct {
	ObservedAtMS int64
	Windows      []QuotaWindow
}

// SupportsWindowCapacity reports whether a window is one whose quota every
// request of the credential draws on. A model- or feature-scoped window meters
// only part of the traffic, so dividing the credential's whole usage by its
// used share would overstate it.
func SupportsWindowCapacity(provider string, window QuotaWindow) bool {
	if provider != "codex" && provider != "claude" {
		return false
	}
	if window.Scope != "standard" || window.Model != "" {
		return false
	}
	switch window.Kind {
	case "five_hour", "weekly":
		return true
	}
	return window.ID == "five_hour" || window.ID == "seven_day"
}

// WindowCycleRange returns the half-open range of recorded usage that the
// window's used share accounts for. It ends at the observation rather than at
// "now": requests made after the reading are not part of the share it reports,
// and counting them would inflate the estimate until the next refresh.
func WindowCycleRange(window QuotaWindow, observedAtMS, nowMS int64) (fromMS, toMS int64, reason string) {
	if window.ResetAtMS == nil || window.PeriodHours == nil || *window.PeriodHours <= 0 {
		return 0, 0, CapacityReasonBoundaryUnknown
	}
	if window.ResetAccuracy != "exact" && window.ResetAccuracy != "derived" {
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

// PeakUsedPercent returns the highest used share earlier observations reported
// for the window while inside [fromMS, toMS).
func PeakUsedPercent(history []ObservedWindows, windowID string, fromMS, toMS int64) *float64 {
	var peak *float64
	for _, observation := range history {
		if observation.ObservedAtMS < fromMS || observation.ObservedAtMS >= toMS {
			continue
		}
		for _, window := range observation.Windows {
			if window.ID != windowID || window.UsedPercent == nil {
				continue
			}
			if peak == nil || *window.UsedPercent > *peak {
				used := *window.UsedPercent
				peak = &used
			}
		}
	}
	return peak
}

// EstimateWindowCapacity scales a cycle's recorded usage to the whole window.
// earlierPeak is the highest used share seen earlier in the same cycle, or nil.
func EstimateWindowCapacity(window QuotaWindow, usage WindowUsage, earlierPeak *float64) (*WindowCapacity, string) {
	if window.UsedPercent == nil {
		return nil, CapacityReasonNoReading
	}
	usedPercent := *window.UsedPercent
	if usedPercent < CapacityMinUsedPercent {
		return nil, CapacityReasonLowUsage
	}
	if earlierPeak != nil && *earlierPeak > usedPercent+capacityResetTolerancePercent {
		return nil, CapacityReasonResetMidCycle
	}
	if usage.Requests <= 0 {
		return nil, CapacityReasonNoTraffic
	}

	scale := 100 / usedPercent
	capacity := &WindowCapacity{
		Tokens:       int64(math.Round(float64(usage.Tokens) * scale)),
		ErrorPercent: math.Round(usedPercentHalfStep/usedPercent*1000) / 10,
	}
	if float64(usage.PricedRequests) >= float64(usage.Requests)*capacityMinPricedShare {
		costNanos := int64(math.Round(float64(usage.CostNanos) * scale))
		capacity.CostNanos = &costNanos
	}
	return capacity, ""
}
