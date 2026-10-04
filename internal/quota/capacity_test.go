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
		{"claude model window", "claude", QuotaWindow{ID: "seven_day_sonnet", Scope: "model", Model: "claude-3-5-sonnet"}, false},
		{"codex code review", "codex", QuotaWindow{ID: "code_review_5h", Kind: "custom", Scope: "code_review"}, false},
		{"codex unrecognised period", "codex", QuotaWindow{ID: "primary", Kind: "custom", Scope: "standard"}, false},
		{"other provider", "antigravity", QuotaWindow{ID: "five_hour", Kind: "five_hour", Scope: "standard"}, false},
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
	if _, _, reason = WindowCycleRange(approximate, 7*hourMS, 8*hourMS); reason != CapacityReasonBoundaryUnknown {
		t.Fatalf("approximate reset: reason = %q, want boundary_unknown", reason)
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
	usage := WindowUsage{Requests: 40, PricedRequests: 40, Tokens: 2_000_000, CostNanos: 3_000_000_000}

	capacity, reason := EstimateWindowCapacity(capacityWindow(25), usage, nil)
	if reason != "" || capacity == nil {
		t.Fatalf("estimate = %v reason %q, want an estimate", capacity, reason)
	}
	if capacity.Tokens != 8_000_000 {
		t.Errorf("tokens = %d, want 8000000", capacity.Tokens)
	}
	if capacity.CostNanos == nil || *capacity.CostNanos != 12_000_000_000 {
		t.Errorf("cost = %v, want 12000000000", capacity.CostNanos)
	}
	if capacity.ErrorPercent != 2 {
		t.Errorf("error = %v, want 2 (half a point of 25)", capacity.ErrorPercent)
	}
}

func TestEstimateWindowCapacityWithholds(t *testing.T) {
	usage := WindowUsage{Requests: 10, PricedRequests: 10, Tokens: 1000, CostNanos: 1000}

	noReading := capacityWindow(0)
	noReading.UsedPercent = nil

	cases := []struct {
		name        string
		window      QuotaWindow
		usage       WindowUsage
		earlierPeak *float64
		want        string
	}{
		{"no used share", noReading, usage, nil, CapacityReasonNoReading},
		{"below the threshold", capacityWindow(4.9), usage, nil, CapacityReasonLowUsage},
		{"nothing recorded", capacityWindow(30), WindowUsage{}, nil, CapacityReasonNoTraffic},
		{"earlier reading was higher", capacityWindow(30), usage, floatPtr(60), CapacityReasonResetMidCycle},
		// A reset outranks missing traffic: after a reset the gateway may well
		// have recorded nothing yet, and "spent elsewhere" would be the wrong story.
		{"reset with nothing recorded since", capacityWindow(30), WindowUsage{}, floatPtr(60), CapacityReasonResetMidCycle},
	}
	for _, tc := range cases {
		capacity, reason := EstimateWindowCapacity(tc.window, tc.usage, tc.earlierPeak)
		if capacity != nil || reason != tc.want {
			t.Errorf("%s: estimate = %v reason %q, want none with %q", tc.name, capacity, reason, tc.want)
		}
	}

	if capacity, reason := EstimateWindowCapacity(capacityWindow(5), usage, nil); capacity == nil || reason != "" {
		t.Errorf("at the threshold: estimate = %v reason %q, want an estimate", capacity, reason)
	}
	// Upstream rounding can move a reading down by a point without any reset.
	if capacity, reason := EstimateWindowCapacity(capacityWindow(30), usage, floatPtr(31)); capacity == nil || reason != "" {
		t.Errorf("one point lower: estimate = %v reason %q, want an estimate", capacity, reason)
	}
}

func TestEstimateWindowCapacityDropsCostWhenUnpriced(t *testing.T) {
	usage := WindowUsage{Requests: 100, PricedRequests: 94, Tokens: 1000, CostNanos: 5000}
	capacity, reason := EstimateWindowCapacity(capacityWindow(50), usage, nil)
	if reason != "" || capacity == nil {
		t.Fatalf("estimate = %v reason %q, want a token estimate", capacity, reason)
	}
	if capacity.CostNanos != nil {
		t.Errorf("cost = %d, want none with 6%% of requests unpriced", *capacity.CostNanos)
	}
	if capacity.Tokens != 2000 {
		t.Errorf("tokens = %d, want 2000", capacity.Tokens)
	}

	usage.PricedRequests = 95
	if capacity, _ = EstimateWindowCapacity(capacityWindow(50), usage, nil); capacity == nil || capacity.CostNanos == nil {
		t.Errorf("95%% priced: want a cost estimate, got %v", capacity)
	}
}

func TestPeakUsedPercent(t *testing.T) {
	history := []ObservedWindows{
		{ObservedAtMS: 4 * hourMS, Windows: []QuotaWindow{{ID: "five_hour", UsedPercent: floatPtr(95)}}},
		{ObservedAtMS: 5 * hourMS, Windows: []QuotaWindow{{ID: "five_hour", UsedPercent: floatPtr(20)}}},
		{ObservedAtMS: 6 * hourMS, Windows: []QuotaWindow{
			{ID: "five_hour", UsedPercent: floatPtr(45)},
			{ID: "weekly", UsedPercent: floatPtr(80)},
		}},
		{ObservedAtMS: 7 * hourMS, Windows: []QuotaWindow{{ID: "five_hour", UsedPercent: floatPtr(99)}}},
	}

	// The reading before the cycle, the one at its end and another window's
	// are all outside what the current cycle's peak may consider.
	peak := PeakUsedPercent(history, "five_hour", 5*hourMS, 7*hourMS)
	if peak == nil || *peak != 45 {
		t.Fatalf("peak = %v, want 45", peak)
	}
	if peak = PeakUsedPercent(history, "five_hour", 8*hourMS, 9*hourMS); peak != nil {
		t.Fatalf("peak with no observation in range = %v, want none", *peak)
	}
}
