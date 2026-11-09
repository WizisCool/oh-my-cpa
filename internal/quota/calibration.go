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
	CostNanos         int64   `json:"cost_nanos"`
	UnmatchedRequests int64   `json:"unmatched,omitempty"`
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

// isSameCycle compares a reading's boundary with a stored cycle's.
func isSameCycle(cycle CycleCalibration, window QuotaWindow) bool {
	if window.ResetAtMS == nil || window.PeriodHours == nil || *window.PeriodHours != cycle.PeriodHours {
		return false
	}
	tolerance := int64(cycleBoundaryToleranceMS)
	if window.ResetAccuracy == "approximate" {
		tolerance = approximateCycleBoundaryToleranceMS
	}
	difference := *window.ResetAtMS - cycle.CycleResetAtMS
	return -tolerance <= difference && difference <= tolerance
}

// NextCalibrationCycle decides whether a reading adds evidence. cycles are the
// stored ones, newest first: a reading saved after a later one, across a reset,
// still extends its own cycle rather than replacing it with a fresh one. It
// returns the cycle the reading extends, or a new empty cycle when the boundary
// moved; the
// caller appends the point with the usage recorded up to the reading. A reading
// adds nothing when the share did not rise by a whole point or drop at a reset:
// idle refreshes therefore leave the evidence, and every estimate, untouched.
// An unused window starts no cycle, since an idle window's boundary can roll
// forward with every refresh.
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

// capacitySegment is one uninterrupted climb: a cycle's points up to a reset, or
// from a reset to the next. Only a climb that starts with the cycle is measured
// from the cycle start, whose share is exactly zero.
type capacitySegment struct {
	cycle          *CycleCalibration
	points         []CalibrationPoint
	fromCycleStart bool
}

func cycleSegments(cycle *CycleCalibration, observedAtMS int64) []capacitySegment {
	points := cycle.Points
	// A stale reading is measured with the evidence it had, never with later points.
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
// rounding, and the cycle start carries none: the error shrinks as the climb
// grows instead of waiting for exhaustion.
//
// A rise during which this gateway recorded nothing was spent elsewhere, and is
// left out with its share. A rise that mixes outside use with recorded requests
// cannot be told apart in upstream's single counter and makes the figure low.
func estimateSegment(segment capacitySegment) (*WindowCapacity, string) {
	points := segment.points
	previous := CalibrationPoint{ObservedAtMS: segment.cycle.CycleStartMS()}
	if !segment.fromCycleStart {
		previous, points = points[0], points[1:]
	}
	var share float64
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
			// Each run of measured changes adds its rounded end, and its start
			// unless that is the exact cycle start.
			roundedEnds++
			if !segment.fromCycleStart || index > 0 {
				roundedEnds++
			}
			isFirstMeasured = isFirstMeasured || segment.fromCycleStart && index == 0
		}
		isMeasuring = true
		share += rise
		usage.Requests += point.Requests - previous.Requests
		usage.PricedRequests += point.PricedRequests - previous.PricedRequests
		usage.Tokens += tokens
		usage.CostNanos += cost
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
	if float64(usage.PricedRequests) >= float64(usage.Requests)*capacityMinPricedShare {
		cost := int64(math.Round(float64(usage.CostNanos) * 100 / share))
		capacity.CostNanos = &cost
	}
	return capacity, ""
}

// EstimateWindowCapacity sizes a window from the stored evidence alone, so the
// figure changes only when a reading moves the share. The live cycle's latest
// climb is the current sample; the climb before it - an earlier part of this
// cycle or an earlier cycle on the same plan - is the reference that carries the
// estimate while the current sample is small, weighted by relative precision.
// cycles are newest first.
func EstimateWindowCapacity(window QuotaWindow, plan *QuotaPlan, observedAtMS int64, cycles []CycleCalibration) (*WindowCapacity, string) {
	_, _, boundaryReason := WindowCycleRange(window, observedAtMS, observedAtMS)
	live := liveCycleIndex(window, observedAtMS, cycles)
	var references []capacitySegment
	for index := len(cycles) - 1; index >= 0; index-- {
		cycle := &cycles[index]
		if index == live || plan == nil || cycle.PlanType == plan.PlanType && cycle.PlanTier == plan.Tier {
			references = append(references, cycleSegments(cycle, observedAtMS)...)
		}
		if index == live {
			break
		}
	}

	var current *WindowCapacity
	reason := CapacityReasonLowUsage
	switch {
	case live >= 0 && len(references) > 0 && references[len(references)-1].cycle == &cycles[live]:
		current, reason = estimateSegment(references[len(references)-1])
		references = references[:len(references)-1]
	case live < 0 && boundaryReason != "":
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

// liveCycleIndex finds the stored cycle a reading belongs to, or -1 when the
// reading's cycle has gathered no evidence yet.
func liveCycleIndex(window QuotaWindow, observedAtMS int64, cycles []CycleCalibration) int {
	_, _, boundaryReason := WindowCycleRange(window, observedAtMS, observedAtMS)
	for index := range cycles {
		if boundaryReason == "" && isSameCycle(cycles[index], window) || window.ResetAtMS == nil && index == 0 && cycles[index].CycleResetAtMS > observedAtMS {
			return index
		}
	}
	return -1
}

// PreviousCapacityCycle returns the stored cycle before the one a reading
// belongs to, or nil. cycles are newest first.
func PreviousCapacityCycle(window QuotaWindow, observedAtMS int64, cycles []CycleCalibration) *CycleCalibration {
	for next := liveCycleIndex(window, observedAtMS, cycles) + 1; next < len(cycles); next++ {
		if cycles[next].CycleStartMS() < observedAtMS {
			return &cycles[next]
		}
	}
	return nil
}

// blendWindowCapacity weights the current sample and the reference by inverse
// error variance, so a fresh cycle leans on the last calibrated size until its
// own climb is comparably precise, and never hands over in a jump.
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
	result.CostNanos = nil
	if current.CostNanos != nil && reference.CostNanos != nil {
		cost := blend(*current.CostNanos, *reference.CostNanos)
		result.CostNanos = &cost
	}
	result.ErrorPercent = math.Round(currentError*referenceError/math.Hypot(currentError, referenceError)*10) / 10
	return &result
}
