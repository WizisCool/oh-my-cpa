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
	observations := slices.Clone(history)
	slices.SortStableFunc(observations, func(first, second ObservedWindows) int {
		if first.ObservedAtMS < second.ObservedAtMS {
			return -1
		}
		if first.ObservedAtMS > second.ObservedAtMS {
			return 1
		}
		return 0
	})
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
			if previous != nil && previous.UsedPercent != nil && earlier.UsedPercent != nil && *previous.UsedPercent > *earlier.UsedPercent+capacityResetTolerancePercent {
				return true
			}
			// An early reset may also replace the advertised boundary without a
			// percentage decrease (for example when the next reading is already high).
			if previous != nil && previous.ResetAtMS != nil && earlier.ResetAtMS != nil && *previous.ResetAtMS > observation.ObservedAtMS && math.Abs(float64(*previous.ResetAtMS-*earlier.ResetAtMS)) > 1000 {
				return true
			}
			previous = &earlier
		}
	}
	if window.HasMidCycleReset {
		return true
	}
	if previous != nil && previous.ResetAtMS != nil && window.ResetAtMS != nil && *previous.ResetAtMS > toMS && math.Abs(float64(*previous.ResetAtMS-*window.ResetAtMS)) > 1000 {
		return true
	}
	return previous != nil && previous.UsedPercent != nil && window.UsedPercent != nil && *previous.UsedPercent > *window.UsedPercent+capacityResetTolerancePercent
}

func hasSameCapacityScope(first, second QuotaWindow) bool {
	if first.ID != second.ID || first.Scope != second.Scope || !slices.Equal(windowModelFamilies(first), windowModelFamilies(second)) {
		return false
	}
	return len(windowModelFamilies(first)) > 0 || first.Model == second.Model
}

// PreviousWindowObservation chooses the last reading of the immediately
// preceding scheduled cycle. It never searches farther back to find a nicer
// number, nor crosses a changed scope or a reset boundary that moved early.
func PreviousWindowObservation(window QuotaWindow, history []ObservedWindows, observedAtMS, nowMS int64) (QuotaWindow, int64, bool) {
	currentStart, _, reason := WindowCycleRange(window, observedAtMS, nowMS)
	if reason != "" {
		return QuotaWindow{}, 0, false
	}
	previousStart := currentStart - int64(*window.PeriodHours*3600*1000)
	var selected QuotaWindow
	var selectedAtMS int64
	hasSelected := false
	for _, observation := range history {
		if observation.ObservedAtMS < previousStart || observation.ObservedAtMS >= currentStart {
			continue
		}
		for _, candidate := range observation.Windows {
			if candidate.ID != window.ID {
				continue
			}
			// A changed or invalid final reading must not resurrect an older,
			// more convenient observation from this same scheduled cycle.
			if candidate.HasIncompleteHistory || !hasSameCapacityScope(window, candidate) || candidate.ResetAtMS == nil || candidate.PeriodHours == nil || *candidate.PeriodHours != *window.PeriodHours || math.Abs(float64(*candidate.ResetAtMS-currentStart)) > 1000 {
				return QuotaWindow{}, 0, false
			}
			if _, _, candidateReason := WindowCycleRange(candidate, observation.ObservedAtMS, observation.ObservedAtMS); candidateReason != "" {
				return QuotaWindow{}, 0, false
			}
			if !hasSelected || observation.ObservedAtMS >= selectedAtMS {
				selected, selectedAtMS, hasSelected = candidate, observation.ObservedAtMS, true
			}
		}
	}
	if !hasSelected {
		return QuotaWindow{}, 0, false
	}
	fromMS, _, _ := WindowCycleRange(selected, selectedAtMS, selectedAtMS)
	if HasWindowCycleReset(selected, history, fromMS, currentStart-1) {
		return QuotaWindow{}, 0, false
	}
	return selected, selectedAtMS, true
}
