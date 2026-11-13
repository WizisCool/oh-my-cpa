package quota

import (
	"slices"
	"strings"
)

// Readings belong to one cycle when their reset instants agree within these
// tolerances. A derived instant carries the latency between upstream's clock and
// the parse; an approximate one is a recovery estimate the provider revises. A
// new cycle moves the boundary by far more, and an early reset that keeps the
// boundary shows as a drop in the used share instead.
const (
	cycleBoundaryToleranceMS            = 60_000
	approximateCycleBoundaryToleranceMS = 3_600_000
)

// capacityMaxPoints bounds one cycle's evidence. A point is kept only for a rise
// of a whole point or a reset, so a cycle reaches the bound only after more than
// two full climbs; its later readings are ignored.
const capacityMaxPoints = 256

// CalibrationPoint is an explicit baseline or changed quota reading. Cumulative
// usage preserves consumption history; interval models freeze the attribution
// needed for forecasts, independently of request-record retention.
type CalibrationPoint struct {
	ObservedAtMS      int64                   `json:"at"`
	UsedPercent       float64                 `json:"used"`
	Requests          int64                   `json:"requests"`
	PricedRequests    int64                   `json:"priced"`
	Tokens            int64                   `json:"tokens"`
	PricedTokens      int64                   `json:"priced_tokens,omitempty"`
	PromptTokens      int64                   `json:"prompt_tokens,omitempty"`
	CachedTokens      int64                   `json:"cached_tokens,omitempty"`
	CostNanos         int64                   `json:"cost_nanos"`
	UnmatchedRequests int64                   `json:"unmatched,omitempty"`
	IntervalModels    []ModelCalibrationUsage `json:"interval_models,omitempty"`
	HasUsageGap       bool                    `json:"has_usage_gap,omitempty"`
}

// CycleCalibration is the evidence one cycle of a window has gathered.
type CycleCalibration struct {
	WindowKey      string
	CycleResetAtMS int64
	PeriodHours    float64
	PlanType       string
	PlanTier       string
	Points         []CalibrationPoint
}

// CycleStartMS is where the cycle's recorded usage starts.
func (cycle CycleCalibration) CycleStartMS() int64 {
	return cycle.CycleResetAtMS - int64(cycle.PeriodHours*3600*1000)
}

// CapacityWindowKey identifies the metered limit a calibration belongs to: two
// readings calibrate the same limit only when id, scope and metered models agree.
func CapacityWindowKey(provider string, window QuotaWindow) string {
	models := strings.Join(windowModelFamilies(window), ",")
	if models == "" {
		models = window.Model
	}
	return provider + "|" + window.ID + "|" + window.Scope + "|" + models
}

func cycleBoundaryTolerance(window QuotaWindow) int64 {
	if window.ResetAccuracy == "approximate" {
		return approximateCycleBoundaryToleranceMS
	}
	return cycleBoundaryToleranceMS
}

// isSameCycle compares a reading's boundary with a stored cycle's.
func isSameCycle(cycle CycleCalibration, window QuotaWindow) bool {
	if window.ResetAtMS == nil || window.PeriodHours == nil || *window.PeriodHours != cycle.PeriodHours {
		return false
	}
	tolerance := cycleBoundaryTolerance(window)
	difference := *window.ResetAtMS - cycle.CycleResetAtMS
	return -tolerance <= difference && difference <= tolerance
}

func sameCalibrationPlan(cycle CycleCalibration, plan *QuotaPlan) bool {
	return plan == nil || cycle.PlanType == plan.PlanType && cycle.PlanTier == plan.Tier
}

// NextCalibrationCycle decides whether a reading adds evidence. cycles are the
// stored ones, newest first: a reading saved after a later one, across a reset,
// still extends its own cycle rather than replacing it with a fresh one.
func NextCalibrationCycle(cycles []CycleCalibration, provider string, window QuotaWindow, plan *QuotaPlan, observedAtMS int64) (CycleCalibration, bool) {
	if !SupportsWindowCapacity(provider, window) {
		return CycleCalibration{}, false
	}
	used, hasReading := WindowUsedPercent(window)
	if !hasReading {
		return CycleCalibration{}, false
	}
	_, _, boundaryReason := WindowCycleRange(window, observedAtMS, observedAtMS)
	hasBoundary := boundaryReason == ""
	if index := liveCycleIndex(window, observedAtMS, cycles); index >= 0 && sameCalibrationPlan(cycles[index], plan) && len(cycles[index].Points) > 0 {
		latest := &cycles[index]
		last := latest.Points[len(latest.Points)-1]
		isRise := used >= last.UsedPercent+1-1e-9
		isReset := used < last.UsedPercent-capacityResetTolerancePercent
		if observedAtMS <= last.ObservedAtMS || len(latest.Points) >= capacityMaxPoints || !isRise && !isReset {
			return CycleCalibration{}, false
		}
		cycle := *latest
		cycle.Points = slices.Clone(latest.Points)
		return cycle, true
	}
	if !hasBoundary {
		return CycleCalibration{}, false
	}
	cycle := CycleCalibration{
		WindowKey:      CapacityWindowKey(provider, window),
		CycleResetAtMS: *window.ResetAtMS,
		PeriodHours:    *window.PeriodHours,
	}
	if plan != nil {
		cycle.PlanType, cycle.PlanTier = plan.PlanType, plan.Tier
	}
	return cycle, true
}

func liveCycleIndex(window QuotaWindow, observedAtMS int64, cycles []CycleCalibration) int {
	_, _, boundaryReason := WindowCycleRange(window, observedAtMS, observedAtMS)
	for index := range cycles {
		if boundaryReason == "" && isSameCycle(cycles[index], window) || window.ResetAtMS == nil && index == 0 && cycles[index].CycleResetAtMS > observedAtMS {
			return index
		}
	}
	return -1
}

// priorCompletedCycles walks stored cycles older than the live one, newest
// first, and stops as soon as a plan change or overlapping boundary shows the
// upstream cycle schedule was replaced mid-way (for instance when activating a
// new subscription).
func priorCompletedCycles(window QuotaWindow, plan *QuotaPlan, observedAtMS int64, cycles []CycleCalibration) []*CycleCalibration {
	fromMS, _, boundaryReason := WindowCycleRange(window, observedAtMS, observedAtMS)
	live := liveCycleIndex(window, observedAtMS, cycles)
	tolerance := cycleBoundaryTolerance(window)

	cursorStartMS := observedAtMS
	switch {
	case boundaryReason == "" && live >= 0:
		cursorStartMS = min(fromMS, cycles[live].CycleStartMS())
	case boundaryReason == "":
		cursorStartMS = fromMS
	case live >= 0:
		cursorStartMS = cycles[live].CycleStartMS()
	}

	var out []*CycleCalibration
	for index := max(live+1, 0); index < len(cycles); index++ {
		cycle := &cycles[index]
		if live < 0 && cycle.CycleStartMS() >= observedAtMS {
			continue
		}
		if cycle.CycleResetAtMS > cursorStartMS+tolerance || !sameCalibrationPlan(*cycle, plan) {
			break
		}
		out = append(out, cycle)
		cursorStartMS = cycle.CycleStartMS()
	}
	return out
}

// PreviousCapacityCycle returns the completed same-plan cycle immediately
// before the one a reading belongs to, or nil when none exists or the cycle
// schedule was re-anchored mid-period. cycles are newest first.
func PreviousCapacityCycle(window QuotaWindow, plan *QuotaPlan, observedAtMS int64, cycles []CycleCalibration) *CycleCalibration {
	if prior := priorCompletedCycles(window, plan, observedAtMS, cycles); len(prior) > 0 {
		return prior[0]
	}
	return nil
}
