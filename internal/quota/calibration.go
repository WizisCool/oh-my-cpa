package quota

import (
	"math"
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

// capacityMaxErrorPercent is the most rounding error a figure may carry on its
// own. A smaller sample still refines a reference, weighted by its precision.
const capacityMaxErrorPercent = 25.0

// capacityReferenceErrorPercent is the least error an earlier climb carries when
// it stands in for the current one: both meter the same plan, but not the same
// mix of models, cache hits and prompt lengths.
const capacityReferenceErrorPercent = 5.0

// CalibrationPoint is a reading that moved the used share, with the usage this
// gateway recorded from the cycle start until the reading. The usage is frozen
// when the point is written, so neither idle refreshes nor request-record
// retention can move an estimate afterwards.
type CalibrationPoint struct {
	ObservedAtMS      int64   `json:"at"`
	UsedPercent       float64 `json:"used"`
	Requests          int64   `json:"requests"`
	PricedRequests    int64   `json:"priced"`
	Tokens            int64   `json:"tokens"`
	PricedTokens      int64   `json:"priced_tokens,omitempty"`
	PromptTokens      int64   `json:"prompt_tokens,omitempty"`
	CachedTokens      int64   `json:"cached_tokens,omitempty"`
	CostNanos         int64   `json:"cost_nanos"`
	UnmatchedRequests int64   `json:"unmatched,omitempty"`
}

func (point CalibrationPoint) pricedTokens() int64 {
	if point.PricedTokens > 0 {
		return min(point.PricedTokens, max(point.Tokens, 0))
	}
	if point.Requests > 0 && point.PricedRequests >= point.Requests {
		return max(point.Tokens, 0)
	}
	return 0
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
	if index := liveCycleIndex(window, observedAtMS, cycles); index >= 0 && len(cycles[index].Points) > 0 {
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
	if !hasBoundary || used <= 0 {
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

type capacitySegment struct {
	cycle          *CycleCalibration
	points         []CalibrationPoint
	fromCycleStart bool
}

func cycleSegments(cycle *CycleCalibration, observedAtMS int64) []capacitySegment {
	points := cycle.Points
	for len(points) > 0 && points[len(points)-1].ObservedAtMS > observedAtMS {
		points = points[:len(points)-1]
	}
	var segments []capacitySegment
	start := 0
	for i := 1; i <= len(points); i++ {
		if i == len(points) || points[i].UsedPercent < points[i-1].UsedPercent-capacityResetTolerancePercent {
			segments = append(segments, capacitySegment{cycle: cycle, points: points[start:i], fromCycleStart: start == 0})
			start = i
		}
	}
	return segments
}

// estimateSegment divides the usage recorded while the share rose by the rise.
// Summing consecutive changes telescopes, so only the ends of the climb carry
// rounding, and the cycle start carries none.
//
// A rise during which this gateway recorded nothing was spent elsewhere, and is
// left out with its share. Cleanly priced intervals anchor the dollar estimate
// directly; partially priced climbs scale by priced token share when at least
// half of recorded tokens carry a price.
func estimateSegment(segment capacitySegment) (*WindowCapacity, string) {
	points := segment.points
	previous := CalibrationPoint{ObservedAtMS: segment.cycle.CycleStartMS()}
	if !segment.fromCycleStart {
		previous, points = points[0], points[1:]
	}
	var share, cleanShare, cleanCost float64
	var usage WindowUsage
	roundedEnds := 0
	isMeasuring, hasRise, hasUnmatched := false, false, false
	isFirstMeasured := false
	for index, point := range points {
		rise := point.UsedPercent - previous.UsedPercent
		tokens := point.Tokens - previous.Tokens
		cost := point.CostNanos - previous.CostNanos
		hasRise = hasRise || rise > 0
		if rise <= 0 || tokens <= 0 && cost <= 0 {
			hasUnmatched = hasUnmatched || point.UnmatchedRequests > previous.UnmatchedRequests
			isMeasuring = false
			previous = point
			continue
		}
		if !isMeasuring {
			roundedEnds++
			if !segment.fromCycleStart || index > 0 {
				roundedEnds++
			}
			isFirstMeasured = isFirstMeasured || segment.fromCycleStart && index == 0
		}
		isMeasuring = true
		dReqs := max(point.Requests-previous.Requests, 0)
		dPriced := max(point.PricedRequests-previous.PricedRequests, 0)
		dToks := max(tokens, 0)
		dPricedToks := min(max(point.pricedTokens()-previous.pricedTokens(), 0), dToks)
		dCost := max(cost, 0)

		share += rise
		usage.Requests += dReqs
		usage.PricedRequests += dPriced
		usage.Tokens += dToks
		usage.PricedTokens += dPricedToks
		usage.CostNanos += dCost
		if dReqs > 0 && float64(dPriced) >= float64(dReqs)*capacityCleanPricedShare {
			cleanShare += rise
			cleanCost += float64(dCost)
		}
		previous = point
	}
	if share <= 0 {
		switch {
		case !segment.fromCycleStart && len(points) == 0:
			return nil, CapacityReasonResetMidCycle
		case hasUnmatched:
			return nil, CapacityReasonScopeUnknown
		case hasRise:
			return nil, CapacityReasonNoTraffic
		}
		return nil, CapacityReasonLowUsage
	}
	rounding := usedPercentHalfStep * float64(roundedEnds)
	capacity := &WindowCapacity{
		Requests:     int64(math.Round(float64(usage.Requests) * 100 / share)),
		Tokens:       int64(math.Round(float64(usage.Tokens) * 100 / share)),
		Basis:        "observed_delta",
		ObservedAtMS: segment.points[len(segment.points)-1].ObservedAtMS,
		FromMS:       segment.points[0].ObservedAtMS,
		ResetAtMS:    segment.cycle.CycleResetAtMS,
		ErrorPercent: math.Round(rounding/math.Max(share-rounding, rounding)*1000) / 10,
	}
	if isFirstMeasured {
		capacity.Basis, capacity.FromMS = "current_cycle", segment.cycle.CycleStartMS()
	}
	switch {
	case cleanShare >= 5.0 || cleanShare > 0 && cleanShare >= share*0.5:
		cost := int64(math.Round(cleanCost * 100 / cleanShare))
		capacity.CostNanos = &cost
	case usage.Tokens > 0 && usage.PricedTokens > 0 && float64(usage.PricedTokens) >= float64(usage.Tokens)*capacityMinImputedShare:
		scaled := float64(usage.CostNanos) * float64(usage.Tokens) / float64(usage.PricedTokens)
		cost := int64(math.Round(scaled * 100 / share))
		capacity.CostNanos = &cost
	}
	return capacity, ""
}

// EstimateWindowCapacity sizes a window from the stored evidence alone, so the
// figure changes only when a reading moves the share. cycles are newest first.
func EstimateWindowCapacity(window QuotaWindow, plan *QuotaPlan, observedAtMS int64, cycles []CycleCalibration) (*WindowCapacity, string) {
	_, _, boundaryReason := WindowCycleRange(window, observedAtMS, observedAtMS)
	live := liveCycleIndex(window, observedAtMS, cycles)
	prior := priorCompletedCycles(window, plan, observedAtMS, cycles)

	var references []capacitySegment
	for index := len(prior) - 1; index >= 0; index-- {
		references = append(references, cycleSegments(prior[index], observedAtMS)...)
	}

	var current *WindowCapacity
	reason := CapacityReasonLowUsage
	switch {
	case live >= 0:
		liveSegments := cycleSegments(&cycles[live], observedAtMS)
		if len(liveSegments) > 0 {
			current, reason = estimateSegment(liveSegments[len(liveSegments)-1])
			references = append(references, liveSegments[:len(liveSegments)-1]...)
		}
	case boundaryReason != "":
		reason = boundaryReason
	}
	if _, hasReading := WindowUsedPercent(window); !hasReading {
		reason = CapacityReasonNoReading
	}

	var reference *WindowCapacity
	for index := len(references) - 1; index >= 0; index-- {
		candidate, _ := estimateSegment(references[index])
		if candidate != nil && candidate.ErrorPercent <= capacityMaxErrorPercent {
			candidate.Basis = "previous_cycle"
			candidate.ErrorPercent = max(candidate.ErrorPercent, capacityReferenceErrorPercent)
			reference = candidate
			break
		}
	}
	if reference == nil && current != nil && current.ErrorPercent > capacityMaxErrorPercent {
		return nil, CapacityReasonLowUsage
	}
	capacity := blendWindowCapacity(current, reference)
	if capacity == nil {
		return nil, reason
	}
	return capacity, ""
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

// blendWindowCapacity weights the current sample and the reference by inverse
// error variance. When both carry dollar capacity, tokens and requests scale by
// the current climb's rate so model or cache-rate changes between cycles do not
// average incompatible token counts.
func blendWindowCapacity(current, reference *WindowCapacity) *WindowCapacity {
	if current == nil {
		return reference
	}
	if reference == nil {
		return current
	}
	currentError := max(current.ErrorPercent, 0.1)
	referenceError := max(reference.ErrorPercent, 0.1)
	weight := referenceError * referenceError / (currentError*currentError + referenceError*referenceError)
	if weight >= 0.99 {
		return current
	}
	blend := func(value, prior int64) int64 {
		return int64(math.Round(float64(value)*weight + float64(prior)*(1-weight)))
	}
	result := *current
	result.Basis = "blended"
	result.Requests = blend(current.Requests, reference.Requests)
	result.Tokens = blend(current.Tokens, reference.Tokens)
	switch {
	case current.CostNanos != nil && reference.CostNanos != nil:
		cost := blend(*current.CostNanos, *reference.CostNanos)
		result.CostNanos = &cost
		if *current.CostNanos > 0 {
			scale := float64(cost) / float64(*current.CostNanos)
			result.Tokens = int64(math.Round(float64(current.Tokens) * scale))
			result.Requests = int64(math.Round(float64(current.Requests) * scale))
		}
	case current.CostNanos != nil:
		cost := *current.CostNanos
		result.CostNanos = &cost
	case reference.CostNanos != nil:
		cost := *reference.CostNanos
		result.CostNanos = &cost
	default:
		result.CostNanos = nil
	}
	result.ErrorPercent = math.Round(currentError*referenceError/math.Hypot(currentError, referenceError)*10) / 10
	return &result
}
