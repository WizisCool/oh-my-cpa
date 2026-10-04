package quota

import "testing"

func TestPreviousWindowObservationUsesFinalAdjacentReading(t *testing.T) {
	current := capacityWindow(2)
	previous := capacityWindow(70)
	previous.ResetAtMS = int64Ptr(5 * hourMS)
	older := previous
	older.ResetAtMS = int64Ptr(0)
	history := []ObservedWindows{
		{ObservedAtMS: 4 * hourMS, Windows: []QuotaWindow{previous}},
		{ObservedAtMS: 2 * hourMS, Windows: []QuotaWindow{capacityHistoryWindow(previous, 20)}},
		{ObservedAtMS: -hourMS, Windows: []QuotaWindow{older}},
	}
	actual, atMS, ok := PreviousWindowObservation(current, history, 7*hourMS, 8*hourMS)
	if !ok || atMS != 4*hourMS || actual.UsedPercent == nil || *actual.UsedPercent != 70 {
		t.Fatalf("previous=%+v at=%d ok=%v", actual, atMS, ok)
	}
	history = append(history, ObservedWindows{ObservedAtMS: 3 * hourMS, Windows: []QuotaWindow{capacityHistoryWindow(previous, 5)}})
	if _, _, ok = PreviousWindowObservation(current, history, 7*hourMS, 8*hourMS); ok {
		t.Fatal("previous cycle reset was accepted after recovery")
	}
}

func capacityHistoryWindow(window QuotaWindow, percent float64) QuotaWindow {
	window.UsedPercent = floatPtr(percent)
	return window
}

func TestPreviousWindowObservationRejectsMissingChangedOrEarlyCycles(t *testing.T) {
	current := capacityWindow(2)
	previous := capacityWindow(50)
	previous.ResetAtMS = int64Ptr(5 * hourMS)
	cases := []struct {
		name   string
		window QuotaWindow
	}{
		{"retained reset evidence", func() QuotaWindow { window := previous; window.HasMidCycleReset = true; return window }()},
		{"different scope", func() QuotaWindow { window := previous; window.Scope = "model"; window.Model = "gpt-5"; return window }()},
		{"cycle gap", func() QuotaWindow { window := previous; window.ResetAtMS = int64Ptr(4 * hourMS); return window }()},
		{"approximate boundary", func() QuotaWindow { window := previous; window.ResetAccuracy = "approximate"; return window }()},
		{"different period", func() QuotaWindow { window := previous; window.PeriodHours = floatPtr(4); return window }()},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			if _, _, ok := PreviousWindowObservation(current, []ObservedWindows{{ObservedAtMS: 3 * hourMS, Windows: []QuotaWindow{testCase.window}}}, 7*hourMS, 8*hourMS); ok {
				t.Fatal("unsafe previous cycle selected")
			}
		})
	}
	moved := previous
	moved.ResetAtMS = int64Ptr(6 * hourMS)
	history := []ObservedWindows{{ObservedAtMS: 2 * hourMS, Windows: []QuotaWindow{previous}}, {ObservedAtMS: 3 * hourMS, Windows: []QuotaWindow{moved}}}
	if _, _, ok := PreviousWindowObservation(current, history, 7*hourMS, 8*hourMS); ok {
		t.Fatal("early boundary replacement accepted")
	}
}

func TestPreviousWindowObservationDoesNotResurrectSupersededScope(t *testing.T) {
	current := capacityWindow(2)
	previous := capacityWindow(50)
	previous.ResetAtMS = int64Ptr(5 * hourMS)
	for _, change := range []string{"scope", "boundary", "accuracy"} {
		t.Run(change, func(t *testing.T) {
			final := previous
			switch change {
			case "scope":
				final.Scope, final.Model = "model", "gpt-5"
			case "boundary":
				final.ResetAtMS = int64Ptr(6 * hourMS)
			case "accuracy":
				final.ResetAccuracy = "approximate"
			}
			history := []ObservedWindows{{ObservedAtMS: 2 * hourMS, Windows: []QuotaWindow{previous}}, {ObservedAtMS: 4 * hourMS, Windows: []QuotaWindow{final}}}
			if _, _, ok := PreviousWindowObservation(current, history, 7*hourMS, 8*hourMS); ok {
				t.Fatal("older estimate resurrected after incompatible observation")
			}
		})
	}
}

func TestEstimateWindowCapacityResetEvidencePrecedesMissingReading(t *testing.T) {
	window := capacityWindow(0)
	window.HasMidCycleReset, window.UsedPercent = true, nil
	if _, reason := EstimateWindowCapacity(window, WindowUsage{}, nil); reason != CapacityReasonResetMidCycle {
		t.Fatalf("unsafe fallback reason=%q", reason)
	}
}

func TestWindowCycleResetDetectsBoundaryMovedPastPriorReading(t *testing.T) {
	current := capacityWindow(60)
	current.ResetAtMS = int64Ptr(15 * hourMS)
	prior := capacityWindow(50)
	prior.ResetAtMS = int64Ptr(14 * hourMS)
	history := []ObservedWindows{{ObservedAtMS: 9 * hourMS, Windows: []QuotaWindow{prior}}}
	if !HasWindowCycleReset(current, history, 10*hourMS, 11*hourMS) {
		t.Fatal("derived start hid an active prior cycle's boundary change")
	}
	prior.ResetAtMS = int64Ptr(10 * hourMS)
	history[0].Windows = []QuotaWindow{prior}
	if HasWindowCycleReset(current, history, 10*hourMS, 11*hourMS) {
		t.Fatal("completed scheduled cycle tainted its successor")
	}
}
