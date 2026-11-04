package quota

import (
	"math"
	"slices"
)

// HasIncompleteWindowHistory preserves a failed evidence read for this cycle,
// without describing it as an upstream reset that was never actually observed.
func HasIncompleteWindowHistory(window QuotaWindow, history []ObservedWindows, fromMS, toMS int64) bool {
	if window.HasIncompleteHistory {
		return true
	}
	for _, observation := range history {
		if observation.ObservedAtMS < fromMS || observation.ObservedAtMS > toMS {
			continue
		}
		for _, earlier := range observation.Windows {
			if earlier.ID == window.ID && earlier.HasIncompleteHistory {
				return true
			}
		}
	}
	return false
}

// HasWindowCycleReset checks the whole retained sequence, not just the peak
// against today's value: a reset remains a reset after consumption catches up.
func HasWindowCycleReset(window QuotaWindow, history []ObservedWindows, fromMS, toMS int64) bool {
	observations := sortedCapacityHistory(history)
	var previous *QuotaWindow
	for _, observation := range observations {
		if observation.ObservedAtMS > toMS {
			continue
		}
		if observation.ObservedAtMS < fromMS {
			// A moved boundary can move the derived start past the last reading.
			// Keep the preceding observation only while its advertised cycle is
			// still active; an ordinary completed cycle must not taint its successor.
			for _, earlier := range observation.Windows {
				if earlier.ID == window.ID && earlier.ResetAtMS != nil && *earlier.ResetAtMS > toMS {
					previous = &earlier
				}
			}
			continue
		}
		for _, earlier := range observation.Windows {
			if earlier.ID != window.ID {
				continue
			}
			if earlier.HasMidCycleReset {
				return true
			}
			if previous != nil {
				priorUsed, hasPrior := WindowUsedPercent(*previous)
				earlierUsed, hasEarlier := WindowUsedPercent(earlier)
				if hasPrior && hasEarlier && priorUsed > earlierUsed+capacityResetTolerancePercent {
					return true
				}
			}
			// An early reset may also replace the advertised boundary without a
			// percentage decrease (for example when the next reading is already high).
			if previous != nil && hasChangedCapacityBoundary(*previous, earlier) && *previous.ResetAtMS > observation.ObservedAtMS {
				return true
			}
			previous = &earlier
		}
	}
	if window.HasMidCycleReset {
		return true
	}
	if previous == nil {
		return false
	}
	if hasChangedCapacityBoundary(*previous, window) && *previous.ResetAtMS > toMS {
		return true
	}
	priorUsed, hasPrior := WindowUsedPercent(*previous)
	used, hasReading := WindowUsedPercent(window)
	return hasPrior && hasReading && priorUsed > used+capacityResetTolerancePercent
}

func hasChangedCapacityBoundary(first, second QuotaWindow) bool {
	return first.ResetAtMS != nil && second.ResetAtMS != nil && first.ResetAccuracy != "approximate" && second.ResetAccuracy != "approximate" && math.Abs(float64(*first.ResetAtMS-*second.ResetAtMS)) > 1000
}

func hasSameCapacityScope(first, second QuotaWindow) bool {
	if first.ID != second.ID || first.Scope != second.Scope || !slices.Equal(windowModelFamilies(first), windowModelFamilies(second)) {
		return false
	}
	return len(windowModelFamilies(first)) > 0 || first.Model == second.Model
}

// CapacityPoint keeps a percentage paired with the instant it was observed.
type CapacityPoint struct {
	Window       QuotaWindow
	ObservedAtMS int64
}

func hasCompatibleCapacityPeriod(first, second QuotaWindow) bool {
	return first.PeriodHours == nil || second.PeriodHours == nil || *first.PeriodHours == *second.PeriodHours
}

func sortedCapacityHistory(history []ObservedWindows) []ObservedWindows {
	ordered := slices.Clone(history)
	slices.SortStableFunc(ordered, func(first, second ObservedWindows) int {
		if first.ObservedAtMS < second.ObservedAtMS {
			return -1
		}
		if first.ObservedAtMS > second.ObservedAtMS {
			return 1
		}
		return 0
	})
	return ordered
}

// CapacityBaseline uses the widest observed change in the latest uninterrupted
// segment. It works after a mid-cycle reset and without a published cycle start.
// Rounded plateaus are kept in the segment, so more evidence improves the slope
// instead of producing one noisy estimate per polling interval.
func CapacityBaseline(window QuotaWindow, history []ObservedWindows, observedAtMS int64) (CapacityPoint, bool) {
	used, hasReading := WindowUsedPercent(window)
	if !hasReading {
		return CapacityPoint{}, false
	}
	ordered := sortedCapacityHistory(history)
	next := window
	nextUsed := used
	var baseline CapacityPoint
	hasBaseline := false
	for i := len(ordered) - 1; i >= 0; i-- {
		observation := ordered[i]
		if observation.ObservedAtMS >= observedAtMS {
			continue
		}
		for _, candidate := range observation.Windows {
			if candidate.ID != window.ID {
				continue
			}
			if !hasSameCapacityScope(window, candidate) || !hasCompatibleCapacityPeriod(window, candidate) || next.HasMidCycleReset && !candidate.HasMidCycleReset {
				return baseline, hasBaseline
			}
			periodHours := window.PeriodHours
			if periodHours == nil {
				periodHours = candidate.PeriodHours
			}
			if periodHours != nil && float64(observedAtMS-observation.ObservedAtMS) >= *periodHours*3600000 {
				return baseline, hasBaseline
			}
			// Approximate reset instants can move as a provider updates its
			// recovery estimate; percentage changes remain useful in that case.
			if hasChangedCapacityBoundary(candidate, next) {
				return baseline, hasBaseline
			}
			candidateUsed, hasCandidateReading := WindowUsedPercent(candidate)
			if !hasCandidateReading {
				continue
			}
			if candidateUsed > nextUsed+capacityResetTolerancePercent {
				return baseline, hasBaseline
			}
			if candidateUsed < used {
				baseline, hasBaseline = CapacityPoint{Window: candidate, ObservedAtMS: observation.ObservedAtMS}, true
			}
			next, nextUsed = candidate, candidateUsed
		}
	}
	return baseline, hasBaseline
}

// CapacityReferencePoints selects recent same-scope cycles, allowing gaps when
// an account was idle. One point per cycle segment and three candidates bound
// accounting joins. A reset starts a new segment, keeping the preceding estimate
// available until fresh traffic can calibrate the new one. Observation times stay
// with each reference so idle accounts keep a dated result instead of losing it.
func CapacityReferencePoints(window QuotaWindow, history []ObservedWindows, observedAtMS int64) []CapacityPoint {
	ordered := sortedCapacityHistory(history)
	points := make([]CapacityPoint, 0, 3)
	// A segment is a reset boundary and whether a mid-cycle reset split it. A
	// derived boundary drifts between refreshes, so boundaries within a second
	// are one, as in hasChangedCapacityBoundary.
	type segment struct {
		resetAtMS int64
		hasReset  bool
	}
	seenSegments := make([]segment, 0, 3)
	isSeen := func(candidate segment) bool {
		for _, seen := range seenSegments {
			if seen.hasReset == candidate.hasReset && math.Abs(float64(seen.resetAtMS-candidate.resetAtMS)) <= 1000 {
				return true
			}
		}
		return false
	}
	for i := len(ordered) - 1; i >= 0 && len(points) < 3; i-- {
		observation := ordered[i]
		if observation.ObservedAtMS >= observedAtMS {
			continue
		}
		for _, candidate := range observation.Windows {
			if candidate.ID != window.ID {
				continue
			}
			if !hasSameCapacityScope(window, candidate) || !hasCompatibleCapacityPeriod(window, candidate) {
				return points
			}
			used, hasReading := WindowUsedPercent(candidate)
			if !hasReading || used <= 0 {
				continue
			}
			cycle := int64(0)
			if candidate.ResetAtMS != nil {
				cycle = *candidate.ResetAtMS
			}
			key := segment{resetAtMS: cycle, hasReset: candidate.HasMidCycleReset}
			if isSeen(key) {
				continue
			}
			seenSegments = append(seenSegments, key)
			points = append(points, CapacityPoint{Window: candidate, ObservedAtMS: observation.ObservedAtMS})
		}
	}
	return points
}
