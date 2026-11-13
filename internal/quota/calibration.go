package quota

import (
	"slices"
	"strings"
)

// Readings belong to one cycle when their reset instants agree within these
// tolerances. A derived instant carries the latency between upstream's clock and
// the parse; an approximate one is a recovery estimate the provider revises.
const (
	cycleBoundaryToleranceMS            = 60_000
	approximateCycleBoundaryToleranceMS = 3_600_000
	capacityMaxPoints                   = 256
)

// CalibrationPoint records cumulative window consumption at a quota reading so
// completed cycles and retained history remain usable after usage_events pruning.
type CalibrationPoint struct {
	ObservedAtMS      int64   `json:"at"`
	UsedPercent       float64 `json:"used"`
	Requests          int64   `json:"requests"`
	PricedRequests    int64   `json:"priced"`
	Tokens            int64   `json:"tokens"`
	PromptTokens      int64   `json:"prompt_tokens,omitempty"`
	CachedTokens      int64   `json:"cached_tokens,omitempty"`
	CostNanos         int64   `json:"cost_nanos"`
	UnmatchedRequests int64   `json:"unmatched,omitempty"`
	UsageWatermarkID  int64   `json:"usage_watermark_id,omitempty"`
	HasUsageGap       bool    `json:"has_usage_gap,omitempty"`
}

func (point CalibrationPoint) windowUsage(fromMS, toMS int64) WindowUsage {
	return WindowUsage{
		FromMS:            fromMS,
		ToMS:              toMS,
		Requests:          point.Requests,
		PricedRequests:    point.PricedRequests,
		Tokens:            point.Tokens,
		PromptTokens:      point.PromptTokens,
		CachedTokens:      point.CachedTokens,
		CacheRate:         ComputeCacheRate(point.CachedTokens, point.PromptTokens),
		CostNanos:         point.CostNanos,
		UnmatchedRequests: point.UnmatchedRequests,
	}
}

// CycleCalibration is the recorded consumption evidence of one window cycle.
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

// NextCalibrationCycle decides whether a reading adds a changed point to a cycle.
// cycles are newest first.
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
	if index := liveCycleIndex(window, observedAtMS, cycles); index >= 0 && len(cycles[index].Points) > 0 {
		latest := &cycles[index]
		last := latest.Points[len(latest.Points)-1]
		if observedAtMS <= last.ObservedAtMS {
			return CycleCalibration{}, false
		}
		if sameCalibrationPlan(*latest, plan) {
			cycle := *latest
			cycle.Points = slices.Clone(latest.Points)
			isRise := used > last.UsedPercent+1e-9
			isReset := used < last.UsedPercent-capacityResetTolerancePercent
			if !isRise && !isReset {
				return cycle, used >= 100
			}
			return cycle, true
		}
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

func isOrdinaryClimbBetween(prev, curr, next CalibrationPoint) bool {
	return curr.UsedPercent > prev.UsedPercent+1e-9 &&
		curr.UsedPercent < 100 &&
		next.UsedPercent > curr.UsedPercent+1e-9
}

func isPostExhaustionTail(prev, curr, next CalibrationPoint) bool {
	return prev.UsedPercent >= 100 && curr.UsedPercent >= 100-capacityResetTolerancePercent && next.UsedPercent >= 100-capacityResetTolerancePercent
}

// AppendCalibrationPoint appends point while coalescing sub-1% intermediate
// rises and post-100% overflow checkpoints, bounding the slice to
// capacityMaxPoints without dropping baseline, mid-cycle reset, pre-reset peak,
// or initial 100% exhaustion boundaries.
func AppendCalibrationPoint(points []CalibrationPoint, point CalibrationPoint) []CalibrationPoint {
	n := len(points)
	if n == 0 {
		return []CalibrationPoint{point}
	}
	if n >= 2 && isPostExhaustionTail(points[n-2], points[n-1], point) {
		points[n-1] = point
		return points
	}
	if n >= 2 && isOrdinaryClimbBetween(points[n-2], points[n-1], point) {
		if (point.UsedPercent < points[n-2].UsedPercent+1-1e-9 && point.UsedPercent < 100) || n >= capacityMaxPoints {
			points[n-1] = point
			return points
		}
	}
	if n >= capacityMaxPoints {
		evicted := false
		for i := n - 2; i >= 1; i-- {
			if isOrdinaryClimbBetween(points[i-1], points[i], points[i+1]) || isPostExhaustionTail(points[i-1], points[i], points[i+1]) {
				points = slices.Delete(points, i, i+1)
				evicted = true
				break
			}
		}
		if !evicted && n >= 2 {
			points = slices.Delete(points, 0, 1)
		}
	}
	return append(points, point)
}

// LiveCycleIndex returns the index of the live cycle matching window at observedAtMS, or -1.
func LiveCycleIndex(window QuotaWindow, observedAtMS int64, cycles []CycleCalibration) int {
	return liveCycleIndex(window, observedAtMS, cycles)
}

// SameCalibrationPlan reports whether cycle belongs to plan.
func SameCalibrationPlan(cycle CycleCalibration, plan *QuotaPlan) bool {
	return sameCalibrationPlan(cycle, plan)
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
// upstream cycle schedule was replaced mid-way.
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

// EffectiveWindowUsage preserves cumulative usage frozen in the live cycle when
// request-record retention has pruned older usage_events rows.
func EffectiveWindowUsage(window QuotaWindow, plan *QuotaPlan, observedAtMS int64, liveUsage WindowUsage, cycles []CycleCalibration) WindowUsage {
	live := liveCycleIndex(window, observedAtMS, cycles)
	if live < 0 || !sameCalibrationPlan(cycles[live], plan) {
		return liveUsage
	}
	var latest *CalibrationPoint
	for index := range cycles[live].Points {
		point := &cycles[live].Points[index]
		if point.ObservedAtMS > observedAtMS {
			break
		}
		latest = point
	}
	if latest != nil && latest.Requests > liveUsage.Requests {
		return latest.windowUsage(liveUsage.FromMS, liveUsage.ToMS)
	}
	return liveUsage
}

// AddWindowUsage combines two WindowUsage values while keeping current's bounds
// and recomputing CacheRate.
func AddWindowUsage(current, delta WindowUsage) WindowUsage {
	out := WindowUsage{
		FromMS:            current.FromMS,
		ToMS:              current.ToMS,
		Requests:          current.Requests + delta.Requests,
		PricedRequests:    current.PricedRequests + delta.PricedRequests,
		Tokens:            current.Tokens + delta.Tokens,
		PromptTokens:      current.PromptTokens + delta.PromptTokens,
		CachedTokens:      current.CachedTokens + delta.CachedTokens,
		CostNanos:         current.CostNanos + delta.CostNanos,
		UnmatchedRequests: current.UnmatchedRequests + delta.UnmatchedRequests,
	}
	out.CacheRate = ComputeCacheRate(out.CachedTokens, out.PromptTokens)
	return out
}

// LatestLiveCalibrationPoint returns the latest stored point at or before
// observedAtMS in the live same-plan cycle, if any.
func LatestLiveCalibrationPoint(window QuotaWindow, plan *QuotaPlan, observedAtMS int64, cycles []CycleCalibration) (CalibrationPoint, bool) {
	live := liveCycleIndex(window, observedAtMS, cycles)
	if live < 0 || !sameCalibrationPlan(cycles[live], plan) {
		return CalibrationPoint{}, false
	}
	var latest *CalibrationPoint
	for index := range cycles[live].Points {
		point := &cycles[live].Points[index]
		if point.ObservedAtMS > observedAtMS {
			break
		}
		latest = point
	}
	if latest == nil {
		return CalibrationPoint{}, false
	}
	return *latest, true
}

// ExhaustionCutoffPoint returns the first 100%-used calibration point in the
// active segment of the live cycle and the cycle's watermark ID, keeping the
// cutoff active across sub-tolerance fluctuations until a qualifying reset.
func ExhaustionCutoffPoint(window QuotaWindow, plan *QuotaPlan, observedAtMS int64, cycles []CycleCalibration) (CalibrationPoint, int64, bool) {
	used, ok := WindowUsedPercent(window)
	if !ok {
		return CalibrationPoint{}, 0, false
	}
	live := liveCycleIndex(window, observedAtMS, cycles)
	if live < 0 || !sameCalibrationPlan(cycles[live], plan) {
		return CalibrationPoint{}, 0, false
	}
	var firstFull *CalibrationPoint
	var lastPoint *CalibrationPoint
	var watermarkID int64
	points := cycles[live].Points
	for index := range points {
		point := &points[index]
		watermarkID = max(watermarkID, point.UsageWatermarkID)
		if point.ObservedAtMS > observedAtMS {
			break
		}
		if index > 0 && point.UsedPercent < points[index-1].UsedPercent-capacityResetTolerancePercent {
			firstFull = nil
			lastPoint = point
			continue
		}
		if point.UsedPercent >= 100 && firstFull == nil {
			firstFull = point
		}
		lastPoint = point
	}
	if firstFull == nil || (lastPoint != nil && used < lastPoint.UsedPercent-capacityResetTolerancePercent) {
		return CalibrationPoint{}, 0, false
	}
	return *firstFull, watermarkID, true
}

func subtractWindowUsage(current, base WindowUsage) WindowUsage {
	delta := WindowUsage{
		FromMS:            current.FromMS,
		ToMS:              current.ToMS,
		Requests:          max(current.Requests-base.Requests, 0),
		PricedRequests:    max(current.PricedRequests-base.PricedRequests, 0),
		Tokens:            max(current.Tokens-base.Tokens, 0),
		PromptTokens:      max(current.PromptTokens-base.PromptTokens, 0),
		CachedTokens:      max(current.CachedTokens-base.CachedTokens, 0),
		CostNanos:         max(current.CostNanos-base.CostNanos, 0),
		UnmatchedRequests: max(current.UnmatchedRequests-base.UnmatchedRequests, 0),
	}
	delta.CacheRate = ComputeCacheRate(delta.CachedTokens, delta.PromptTokens)
	return delta
}

func estimateCyclePoints(basis string, points []CalibrationPoint) *WindowCapacity {
	var segBase CalibrationPoint
	var firstFull *CalibrationPoint
	var best *WindowCapacity
	for index := range points {
		point := &points[index]
		if index > 0 && point.UsedPercent < points[index-1].UsedPercent-capacityResetTolerancePercent {
			segBase = *point
			firstFull = nil
			continue
		}
		if firstFull != nil {
			continue
		}
		if point.UsedPercent >= 100 {
			firstFull = point
		}
		dUsed := point.UsedPercent - segBase.UsedPercent
		dUsage := subtractWindowUsage(point.windowUsage(0, 0), segBase.windowUsage(0, 0))
		if cap := ScaleWindowCapacity(basis, dUsed, dUsage); cap != nil {
			best = cap
		}
	}
	return best
}

// EstimateWindowCapacity sizes a window's 100% capacity from its recorded
// consumption and used percentage, keeping exhaustion readings immune to paid
// overflow traffic, handling mid-cycle resets, and falling back to the last
// completed same-plan window when the current window has not accumulated usage.
func EstimateWindowCapacity(
	window QuotaWindow,
	plan *QuotaPlan,
	observedAtMS, nowMS int64,
	liveUsage *WindowUsage,
	cycles []CycleCalibration,
) (*WindowCapacity, string) {
	if _, _, reason := WindowCycleRange(window, observedAtMS, nowMS); reason != "" {
		return nil, reason
	}
	used, hasReading := WindowUsedPercent(window)
	if !hasReading {
		return nil, CapacityReasonNoReading
	}

	var usage WindowUsage
	if liveUsage != nil {
		usage = *liveUsage
	}

	hasReset := false
	var segBase CalibrationPoint
	var firstFull *CalibrationPoint
	var lastPoint *CalibrationPoint
	var preResetFallback *WindowCapacity
	if live := liveCycleIndex(window, observedAtMS, cycles); live >= 0 && sameCalibrationPlan(cycles[live], plan) {
		points := cycles[live].Points
		for index := range points {
			point := &points[index]
			if point.ObservedAtMS > observedAtMS {
				break
			}
			if index > 0 && point.UsedPercent < points[index-1].UsedPercent-capacityResetTolerancePercent {
				prev := points[index-1]
				if firstFull != nil {
					prev = *firstFull
				}
				dUsed := prev.UsedPercent - segBase.UsedPercent
				dUsage := subtractWindowUsage(prev.windowUsage(0, 0), segBase.windowUsage(0, 0))
				if cap := ScaleWindowCapacity(CapacityBasisPreviousWindow, dUsed, dUsage); cap != nil {
					preResetFallback = cap
				}
				hasReset = true
				segBase = *point
				firstFull = nil
				lastPoint = point
				continue
			}
			if point.UsedPercent >= 100 && firstFull == nil {
				firstFull = point
			}
			lastPoint = point
		}
	}
	if lastPoint != nil && used < lastPoint.UsedPercent-capacityResetTolerancePercent {
		prev := *lastPoint
		if firstFull != nil {
			prev = *firstFull
		}
		dUsed := prev.UsedPercent - segBase.UsedPercent
		dUsage := subtractWindowUsage(prev.windowUsage(0, 0), segBase.windowUsage(0, 0))
		if cap := ScaleWindowCapacity(CapacityBasisPreviousWindow, dUsed, dUsage); cap != nil {
			preResetFallback = cap
		}
		hasReset = true
		segBase = CalibrationPoint{
			ObservedAtMS:      observedAtMS,
			UsedPercent:       used,
			Requests:          lastPoint.Requests,
			PricedRequests:    lastPoint.PricedRequests,
			Tokens:            lastPoint.Tokens,
			PromptTokens:      lastPoint.PromptTokens,
			CachedTokens:      lastPoint.CachedTokens,
			CostNanos:         lastPoint.CostNanos,
			UnmatchedRequests: lastPoint.UnmatchedRequests,
		}
		firstFull = nil
	}

	// Once a window reached 100%, later traffic answered via prepaid credits or
	// extra usage does not expand the subscription window's own capacity, even
	// across sub-tolerance rounding fluctuations before a qualifying reset.
	capacityUsage := EffectiveWindowUsage(window, plan, observedAtMS, usage, cycles)
	effectiveUsed := used
	if firstFull != nil && firstFull.ObservedAtMS < observedAtMS {
		effectiveUsed = firstFull.UsedPercent
		frozen := firstFull.windowUsage(usage.FromMS, firstFull.ObservedAtMS)
		if liveUsage != nil && liveUsage.ToMS > 0 && liveUsage.ToMS <= firstFull.ObservedAtMS && liveUsage.Requests > frozen.Requests {
			capacityUsage = *liveUsage
		} else {
			capacityUsage = frozen
		}
	}

	if !hasReset {
		if cap := ScaleWindowCapacity(CapacityBasisCurrentWindow, effectiveUsed, capacityUsage); cap != nil {
			return cap, ""
		}
	} else {
		dUsed := effectiveUsed - segBase.UsedPercent
		dUsage := subtractWindowUsage(capacityUsage, segBase.windowUsage(0, 0))
		if cap := ScaleWindowCapacity(CapacityBasisCurrentWindow, dUsed, dUsage); cap != nil {
			return cap, ""
		}
		if preResetFallback != nil {
			return preResetFallback, ""
		}
	}

	for _, prior := range priorCompletedCycles(window, plan, observedAtMS, cycles) {
		if cap := estimateCyclePoints(CapacityBasisPreviousWindow, prior.Points); cap != nil {
			return cap, ""
		}
	}

	if hasReset && used <= segBase.UsedPercent {
		return nil, CapacityReasonResetMidCycle
	}
	if used < minEstimableUsedPercent {
		return nil, CapacityReasonLowUsage
	}
	if capacityUsage.Requests == 0 && capacityUsage.UnmatchedRequests > 0 {
		return nil, CapacityReasonScopeUnknown
	}
	return nil, CapacityReasonNoTraffic
}
