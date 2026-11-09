package quota

import "testing"

func floatPtr(value float64) *float64 { return &value }
func int64Ptr(value int64) *int64     { return &value }

const hourMS = int64(3600 * 1000)

func capacityWindow(usedPercent float64) QuotaWindow {
	return QuotaWindow{
		ID:            "five_hour",
		Kind:          "five_hour",
		Scope:         "standard",
		UsedPercent:   floatPtr(usedPercent),
		ResetAtMS:     int64Ptr(10 * hourMS),
		PeriodHours:   floatPtr(5),
		ResetAccuracy: "exact",
	}
}

// point is a reading at the given hour with the tokens recorded since the cycle
// start; every request is priced at one nano per token.
func point(hour, used float64, requests, tokens int64) CalibrationPoint {
	return CalibrationPoint{ObservedAtMS: int64(hour * float64(hourMS)), UsedPercent: used, Requests: requests, PricedRequests: requests, Tokens: tokens, CostNanos: tokens}
}

// cycle is the five-hour cycle that capacityWindow reads, from 5h to 10h.
func cycle(points ...CalibrationPoint) CycleCalibration {
	return CycleCalibration{WindowKey: "codex|five_hour|standard|", CycleResetAtMS: 10 * hourMS, PeriodHours: 5, Points: points}
}

func TestSupportsWindowCapacity(t *testing.T) {
	cases := []struct {
		name     string
		provider string
		window   QuotaWindow
		want     bool
	}{
		{"codex five-hour", "codex", QuotaWindow{ID: "five_hour", Kind: "five_hour", Scope: "standard"}, true},
		{"codex weekly", "codex", QuotaWindow{ID: "weekly", Kind: "weekly", Scope: "standard"}, true},
		{"claude weekly by id", "claude", QuotaWindow{ID: "seven_day", Scope: "standard"}, true},
		{"claude model window", "claude", QuotaWindow{ID: "seven_day_sonnet", Scope: "model", Model: "claude-3-5-sonnet"}, true},
		{"codex code review", "codex", QuotaWindow{ID: "code_review_5h", Kind: "custom", Scope: "code_review"}, false},
		{"codex unrecognised period", "codex", QuotaWindow{ID: "primary", Kind: "custom", Scope: "standard"}, false},
		// A free plan's own window is monthly, and it is estimated on the same terms as the
		// five-hour and weekly windows beside it.
		{"codex monthly window", "codex", QuotaWindow{ID: "monthly", Kind: "monthly", Scope: "standard"}, true},
		{"antigravity standard window", "antigravity", QuotaWindow{ID: "five_hour", Kind: "five_hour", Scope: "standard"}, false},
		{"antigravity group window", "antigravity", QuotaWindow{ID: "ag_g_b", Scope: "group"}, true},
		{"other provider", "other", QuotaWindow{ID: "five_hour", Kind: "five_hour", Scope: "standard"}, false},
	}
	for _, tc := range cases {
		if got := SupportsWindowCapacity(tc.provider, tc.window); got != tc.want {
			t.Errorf("%s: SupportsWindowCapacity = %v, want %v", tc.name, got, tc.want)
		}
	}
}

func TestWindowCycleRange(t *testing.T) {
	window := capacityWindow(40)

	fromMS, toMS, reason := WindowCycleRange(window, 7*hourMS, 8*hourMS)
	if reason != "" || fromMS != 5*hourMS || toMS != 7*hourMS {
		t.Fatalf("range = [%d, %d) reason %q, want [5h, 7h) with no reason", fromMS, toMS, reason)
	}

	// The range ends at the observation even when the clock has moved on:
	// later requests are not part of the share the observation reported.
	if _, toMS, _ = WindowCycleRange(window, 6*hourMS, 9*hourMS); toMS != 6*hourMS {
		t.Fatalf("range end = %d, want the observation at 6h", toMS)
	}

	if _, _, reason = WindowCycleRange(window, 7*hourMS, 10*hourMS); reason != CapacityReasonExpired {
		t.Fatalf("reset at now: reason = %q, want expired", reason)
	}

	approximate := window
	approximate.ResetAccuracy = "approximate"
	if _, _, reason = WindowCycleRange(approximate, 7*hourMS, 8*hourMS); reason != "" {
		t.Fatalf("approximate reset: reason = %q, want an initial estimate", reason)
	}

	noPeriod := window
	noPeriod.PeriodHours = nil
	if _, _, reason = WindowCycleRange(noPeriod, 7*hourMS, 8*hourMS); reason != CapacityReasonBoundaryUnknown {
		t.Fatalf("missing period: reason = %q, want boundary_unknown", reason)
	}

	noReset := window
	noReset.ResetAtMS = nil
	if _, _, reason = WindowCycleRange(noReset, 7*hourMS, 8*hourMS); reason != CapacityReasonBoundaryUnknown {
		t.Fatalf("missing reset: reason = %q, want boundary_unknown", reason)
	}

	// An observation older than the cycle it would be measured against leaves
	// an empty range rather than a negative one.
	if _, _, reason = WindowCycleRange(window, 4*hourMS, 8*hourMS); reason != CapacityReasonBoundaryUnknown {
		t.Fatalf("observation before cycle: reason = %q, want boundary_unknown", reason)
	}
}

func TestEstimateWindowCapacity(t *testing.T) {
	estimate := func(used float64, cycles ...CycleCalibration) (*WindowCapacity, string) {
		return EstimateWindowCapacity(capacityWindow(used), nil, 9*hourMS, cycles)
	}

	// Two points of rounding on a 2% reading is too coarse to state on its own.
	if capacity, reason := estimate(2, cycle(point(6, 2, 1, 200_000))); capacity != nil || reason != CapacityReasonLowUsage {
		t.Fatalf("2%% climb = %+v %q, want low_usage", capacity, reason)
	}
	// Only the ends of a climb carry rounding, and the cycle start none.
	capacity, reason := estimate(20, cycle(point(6, 3, 1, 300_000), point(7, 10, 2, 900_000), point(8, 20, 4, 2_000_000)))
	if capacity == nil || reason != "" || capacity.Basis != "current_cycle" || capacity.Tokens != 10_000_000 || capacity.Requests != 20 || capacity.ErrorPercent != 2.6 {
		t.Fatalf("climb = %+v %q, want 2M over 20 points from the cycle start", capacity, reason)
	}
	if capacity.CostNanos == nil || *capacity.CostNanos != 10_000_000 || capacity.FromMS != 5*hourMS || capacity.ObservedAtMS != 8*hourMS || capacity.ResetAtMS != 10*hourMS {
		t.Fatalf("climb = %+v, want its cost and the cycle's dates", capacity)
	}
	// A stale reading is measured with the evidence it had.
	stale, _ := EstimateWindowCapacity(capacityWindow(10), nil, 7*hourMS, []CycleCalibration{cycle(point(6, 3, 1, 300_000), point(7, 10, 2, 900_000), point(8, 20, 4, 2_000_000))})
	if stale == nil || stale.Tokens != 9_000_000 {
		t.Fatalf("stale reading = %+v, want the climb up to its own instant", stale)
	}

	// Rises the gateway recorded nothing for were spent elsewhere and are left
	// out with their share.
	capacity, _ = estimate(50, cycle(point(6, 30, 0, 0), point(7, 40, 1, 1_000_000), point(8, 50, 1, 1_000_000), point(8.5, 60, 2, 2_000_000)))
	if capacity == nil || capacity.Basis != "observed_delta" || capacity.Tokens != 10_000_000 || capacity.ErrorPercent != 11.1 {
		t.Fatalf("partly external climb = %+v, want 2M over the 20 recorded points", capacity)
	}
	if capacity, reason := estimate(40, cycle(point(6, 40, 0, 0))); capacity != nil || reason != CapacityReasonNoTraffic {
		t.Fatalf("external climb = %+v %q, want no_traffic", capacity, reason)
	}

	// A dollar figure needs nearly every request priced.
	unpriced := point(8, 20, 4, 2_000_000)
	unpriced.PricedRequests = 3
	if capacity, _ := estimate(20, cycle(unpriced)); capacity == nil || capacity.CostNanos != nil || capacity.Tokens != 10_000_000 {
		t.Fatalf("unpriced climb = %+v, want tokens without a cost", capacity)
	}

	if capacity, reason := EstimateWindowCapacity(QuotaWindow{ID: "five_hour", Scope: "standard"}, nil, 9*hourMS, nil); capacity != nil || reason != CapacityReasonNoReading {
		t.Fatalf("no reading = %+v %q", capacity, reason)
	}
}

func TestEstimateWindowCapacityAfterReset(t *testing.T) {
	climb := []CalibrationPoint{point(6, 10, 1, 1_000_000), point(7, 50, 5, 5_000_000)}

	// Right after a mid-cycle reset the new climb has nothing to measure; the
	// climb before it still sizes the plan.
	reset := cycle(append(climb, point(8, 0, 5, 5_000_000))...)
	capacity, _ := EstimateWindowCapacity(capacityWindow(0), nil, 9*hourMS, []CycleCalibration{reset})
	if capacity == nil || capacity.Basis != "previous_cycle" || capacity.Tokens != 10_000_000 || capacity.ErrorPercent != 5 {
		t.Fatalf("after the reset = %+v, want the earlier climb as the reference", capacity)
	}
	// A small new climb is weighted by its precision, not handed over to.
	resumed := cycle(append(climb, point(8, 0, 5, 5_000_000), point(8.5, 2, 6, 5_300_000))...)
	capacity, _ = EstimateWindowCapacity(capacityWindow(2), nil, 9*hourMS, []CycleCalibration{resumed})
	if capacity == nil || capacity.Basis != "blended" || capacity.Tokens <= 10_000_000 || capacity.Tokens > 10_020_000 {
		t.Fatalf("resumed climb = %+v, want 10M nudged toward the 15M sample", capacity)
	}
	if capacity, reason := EstimateWindowCapacity(capacityWindow(0), nil, 9*hourMS, []CycleCalibration{cycle(point(6, 30, 0, 0), point(7, 0, 0, 0))}); capacity != nil || reason != CapacityReasonResetMidCycle {
		t.Fatalf("reset without a reference = %+v %q", capacity, reason)
	}

	// A new cycle that has not been used leans on the previous one, on the same
	// plan only.
	previous := cycle(climb...)
	previous.CycleResetAtMS, previous.PlanType = 5*hourMS, "plus"
	plus := &QuotaPlan{PlanType: "plus"}
	if capacity, _ := EstimateWindowCapacity(capacityWindow(0), plus, 9*hourMS, []CycleCalibration{previous}); capacity == nil || capacity.Basis != "previous_cycle" || capacity.Tokens != 10_000_000 {
		t.Fatalf("unused cycle = %+v, want the previous cycle's size", capacity)
	}
	if capacity, reason := EstimateWindowCapacity(capacityWindow(0), &QuotaPlan{PlanType: "pro"}, 9*hourMS, []CycleCalibration{previous}); capacity != nil || reason != CapacityReasonLowUsage {
		t.Fatalf("another plan = %+v %q, want no reference", capacity, reason)
	}
}

func TestNextCalibrationCycle(t *testing.T) {
	stored := cycle(point(6, 10, 1, 100))
	advance := func(latest *CycleCalibration, window QuotaWindow, observedAtMS int64) (CycleCalibration, bool) {
		return NextCalibrationCycle([]CycleCalibration{*latest}, "codex", window, nil, observedAtMS)
	}
	for _, tc := range []struct {
		name   string
		window QuotaWindow
		atMS   int64
		want   bool
	}{
		{"idle refresh", capacityWindow(10), 7 * hourMS, false},
		{"rise below a whole point", capacityWindow(10.5), 7 * hourMS, false},
		{"rise of a point", capacityWindow(11), 7 * hourMS, true},
		{"reset", capacityWindow(2), 7 * hourMS, true},
		{"out of order", capacityWindow(20), 6 * hourMS, false},
	} {
		if _, got := advance(&stored, tc.window, tc.atMS); got != tc.want {
			t.Errorf("%s: adds evidence = %v, want %v", tc.name, got, tc.want)
		}
	}

	// A derived boundary drifts between refreshes within one cycle.
	drifted := capacityWindow(20)
	drifted.ResetAtMS, drifted.ResetAccuracy = int64Ptr(10*hourMS+30_000), "derived"
	if next, ok := advance(&stored, drifted, 7*hourMS); !ok || len(next.Points) != 1 || next.CycleResetAtMS != 10*hourMS {
		t.Fatalf("drifted boundary = %+v %v, want the stored cycle extended", next, ok)
	}
	// A reading without a boundary still extends the live cycle it belongs to.
	unbounded := capacityWindow(20)
	unbounded.ResetAtMS = nil
	if next, ok := advance(&stored, unbounded, 7*hourMS); !ok || next.CycleResetAtMS != 10*hourMS {
		t.Fatalf("unbounded reading = %+v %v, want the stored cycle extended", next, ok)
	}

	// An unused window opens no cycle: its boundary can roll with every refresh.
	nextCycle := capacityWindow(0)
	nextCycle.ResetAtMS = int64Ptr(15 * hourMS)
	if _, ok := advance(&stored, nextCycle, 11*hourMS); ok {
		t.Fatal("an unused window opened a cycle")
	}
	nextCycle.UsedPercent = floatPtr(3)
	if next, ok := advance(&stored, nextCycle, 11*hourMS); !ok || len(next.Points) != 0 || next.CycleResetAtMS != 15*hourMS {
		t.Fatalf("used new cycle = %+v %v, want a new empty cycle", next, ok)
	}
	// A reading saved after the next cycle's first one still extends its own cycle.
	newer := cycle(point(11, 3, 1, 100))
	newer.CycleResetAtMS = 15 * hourMS
	if next, ok := NextCalibrationCycle([]CycleCalibration{newer, stored}, "codex", capacityWindow(20), nil, 7*hourMS); !ok || next.CycleResetAtMS != 10*hourMS || len(next.Points) != 1 {
		t.Fatalf("late reading = %+v %v, want its own stored cycle extended", next, ok)
	}
	if _, ok := NextCalibrationCycle(nil, "codex", QuotaWindow{ID: "code_review", Scope: "code_review", UsedPercent: floatPtr(5)}, nil, 7*hourMS); ok {
		t.Fatal("an unsupported window gathered evidence")
	}
}
