package quota

import "testing"

func capacityHistoryWindow(window QuotaWindow, percent float64) QuotaWindow {
	window.UsedPercent = floatPtr(percent)
	return window
}

func TestCapacityBaselineUsesWidestPostResetChange(t *testing.T) {
	current := capacityWindow(25)
	current.HasMidCycleReset = true
	history := []ObservedWindows{
		{ObservedAtMS: 8 * hourMS, Windows: []QuotaWindow{capacityHistoryWindow(current, 15)}},
		{ObservedAtMS: 6 * hourMS, Windows: []QuotaWindow{capacityHistoryWindow(current, 60)}},
		{ObservedAtMS: 7 * hourMS, Windows: []QuotaWindow{capacityHistoryWindow(current, 5)}},
	}
	baseline, ok := CapacityBaseline(current, history, 9*hourMS)
	if !ok || baseline.ObservedAtMS != 7*hourMS || *baseline.Window.UsedPercent != 5 {
		t.Fatalf("baseline=%+v ok=%v, want the reading after 60%% -> 5%%", baseline, ok)
	}
	// A missing reset instant does not remove a measured percentage change.
	current.ResetAtMS, current.PeriodHours = nil, nil
	for i := range history {
		history[i].Windows[0].ResetAtMS, history[i].Windows[0].PeriodHours = nil, nil
	}
	if baseline, ok = CapacityBaseline(current, history, 9*hourMS); !ok || baseline.ObservedAtMS != 7*hourMS {
		t.Fatalf("unknown boundaries lost observed change: %+v %v", baseline, ok)
	}
}

func TestCapacityBaselineDoesNotCrossChangedScopeOrCycle(t *testing.T) {
	current := capacityWindow(50)
	approximate := capacityHistoryWindow(current, 10)
	approximate.ResetAtMS = int64Ptr(10*hourMS + 60000)
	approximate.ResetAccuracy = "approximate"
	history := []ObservedWindows{{ObservedAtMS: 6 * hourMS, Windows: []QuotaWindow{approximate}}}
	if _, ok := CapacityBaseline(current, history, 8*hourMS); !ok || HasWindowCycleReset(current, history, 5*hourMS, 8*hourMS) {
		t.Fatal("a moving approximate reset erased observed percentage evidence")
	}
	for _, change := range []string{"scope", "cycle", "period"} {
		t.Run(change, func(t *testing.T) {
			previous := capacityHistoryWindow(current, 10)
			switch change {
			case "scope":
				previous.Scope, previous.Model = "model", "gpt-5"
			case "cycle":
				previous.ResetAtMS = int64Ptr(5 * hourMS)
			case "period":
				previous.PeriodHours = floatPtr(168)
			}
			if _, ok := CapacityBaseline(current, []ObservedWindows{{ObservedAtMS: 6 * hourMS, Windows: []QuotaWindow{previous}}}, 8*hourMS); ok {
				t.Fatal("incompatible percentage used as baseline")
			}
		})
	}
}

func TestCapacityReferenceAllowsIdleCyclesButKeepsScope(t *testing.T) {
	current := capacityWindow(0)
	previous := capacityWindow(50)
	previous.ResetAtMS = int64Ptr(0)
	points := CapacityReferencePoints(current, []ObservedWindows{{ObservedAtMS: -hourMS, Windows: []QuotaWindow{previous}}}, 7*hourMS)
	if len(points) != 1 || points[0].ObservedAtMS != -hourMS {
		t.Fatalf("idle cycle lost reference: %+v", points)
	}
	if points = CapacityReferencePoints(current, []ObservedWindows{{ObservedAtMS: -31 * 24 * hourMS, Windows: []QuotaWindow{previous}}}, 7*hourMS); len(points) != 1 {
		t.Fatalf("an idle month erased the dated reference: %+v", points)
	}
	changed := previous
	changed.Scope, changed.Model = "model", "gpt-5"
	history := []ObservedWindows{{ObservedAtMS: -2 * hourMS, Windows: []QuotaWindow{previous}}, {ObservedAtMS: -hourMS, Windows: []QuotaWindow{changed}}}
	if points = CapacityReferencePoints(current, history, 7*hourMS); len(points) != 0 {
		t.Fatalf("superseded scope resurrected: %+v", points)
	}
}

func TestEstimateWindowCapacityResetEvidencePrecedesMissingReading(t *testing.T) {
	window := capacityWindow(0)
	window.HasMidCycleReset, window.UsedPercent = true, nil
	if _, reason := EstimateWindowCapacity(window, WindowUsage{}, nil); reason != CapacityReasonResetMidCycle {
		t.Fatalf("pre-reset usage accepted: reason=%q", reason)
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
