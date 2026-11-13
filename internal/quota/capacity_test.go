package quota

import (
	"math"
	"testing"
)

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

func point(hour, used float64, requests, tokens, costNanos int64) CalibrationPoint {
	return CalibrationPoint{
		ObservedAtMS:   int64(hour * float64(hourMS)),
		UsedPercent:    used,
		Requests:       requests,
		PricedRequests: requests,
		Tokens:         tokens,
		PromptTokens:   tokens,
		CostNanos:      costNanos,
	}
}

func cycle(points ...CalibrationPoint) CycleCalibration {
	return CycleCalibration{
		WindowKey:      "codex|five_hour|standard|",
		CycleResetAtMS: 10 * hourMS,
		PeriodHours:    5,
		Points:         points,
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
		{"claude model window", "claude", QuotaWindow{ID: "seven_day_sonnet", Scope: "model", Model: "claude-3-5-sonnet"}, true},
		{"codex code review", "codex", QuotaWindow{ID: "code_review_5h", Kind: "custom", Scope: "code_review"}, false},
		{"codex unrecognised period", "codex", QuotaWindow{ID: "primary", Kind: "custom", Scope: "standard"}, false},
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
	if _, _, reason = WindowCycleRange(window, 4*hourMS, 8*hourMS); reason != CapacityReasonBoundaryUnknown {
		t.Fatalf("observation before cycle: reason = %q, want boundary_unknown", reason)
	}
}

func TestEstimateWindowCapacityDirectScalingAndPricingModes(t *testing.T) {
	// Immediate prediction on the very first reading at 1% with 2 requests (no multi-snapshot or 5% gate).
	usage := WindowUsage{
		Requests:       2,
		PricedRequests: 2,
		Tokens:         6_400,
		PromptTokens:   5_000,
		CachedTokens:   4_000,
		CostNanos:      20_000_000,
	}
	got, reason := EstimateWindowCapacity(capacityWindow(1), nil, 7*hourMS, 7*hourMS, &usage, nil)
	if reason != "" || got == nil {
		t.Fatalf("1%% single-reading capacity = %+v, reason = %q", got, reason)
	}
	if got.Basis != CapacityBasisCurrentWindow || got.Requests != 200 || got.Tokens != 640_000 || got.CostNanos == nil || *got.CostNanos != 2_000_000_000 || got.CacheRate == nil || *got.CacheRate != 80 {
		t.Fatalf("unexpected 1%% scaled capacity = %+v", got)
	}

	// Partially priced window still estimates dollar cost while preserving sample_priced_requests < sample_requests.
	partial := WindowUsage{Requests: 10, PricedRequests: 8, Tokens: 100_000, CostNanos: 4_000_000_000}
	gotPartial, reason := EstimateWindowCapacity(capacityWindow(25), nil, 7*hourMS, 7*hourMS, &partial, nil)
	if reason != "" || gotPartial == nil || gotPartial.CostNanos == nil || *gotPartial.CostNanos != 16_000_000_000 || gotPartial.SampleRequests != 10 || gotPartial.SamplePricedRequests != 8 {
		t.Fatalf("partial priced capacity = %+v, reason = %q", gotPartial, reason)
	}

	// Completely unpriced window still predicts tokens and requests without fabricating a dollar cost.
	unpriced := WindowUsage{Requests: 3, PricedRequests: 0, Tokens: 150_000, CostNanos: 0}
	gotUnpriced, reason := EstimateWindowCapacity(capacityWindow(10), nil, 7*hourMS, 7*hourMS, &unpriced, nil)
	if reason != "" || gotUnpriced == nil || gotUnpriced.CostNanos != nil || gotUnpriced.Tokens != 1_500_000 || gotUnpriced.Requests != 30 {
		t.Fatalf("unpriced capacity = %+v, reason = %q", gotUnpriced, reason)
	}

	// Pathological sub-epsilon float noise falls back safely instead of overflowing int64.
	if bad := ScaleWindowCapacity(CapacityBasisCurrentWindow, math.SmallestNonzeroFloat64, usage); bad != nil {
		t.Fatalf("expected nil for sub-epsilon usedPercent, got %+v", bad)
	}
}

func TestEstimateWindowCapacityPreviousWindowFallbackAndPlanGuard(t *testing.T) {
	prior := CycleCalibration{
		WindowKey:      "codex|five_hour|standard|",
		CycleResetAtMS: 5 * hourMS,
		PeriodHours:    5,
		PlanType:       "pro",
		PlanTier:       "elite",
		Points:         []CalibrationPoint{point(4, 50, 40, 2_000_000, 15_000_000_000)},
	}
	plan := &QuotaPlan{PlanType: "pro", Tier: "elite"}

	// Fresh 0% window with zero current traffic carries forward the scaled 100% capacity from the prior cycle.
	got, reason := EstimateWindowCapacity(capacityWindow(0), plan, 6*hourMS, 6*hourMS, &WindowUsage{}, []CycleCalibration{prior})
	if reason != "" || got == nil || got.Basis != CapacityBasisPreviousWindow || got.Requests != 80 || got.Tokens != 4_000_000 || got.CostNanos == nil || *got.CostNanos != 30_000_000_000 {
		t.Fatalf("previous-window fallback = %+v, reason = %q", got, reason)
	}

	// Different plan rejects the prior cycle's capacity.
	if got, reason := EstimateWindowCapacity(capacityWindow(0), &QuotaPlan{PlanType: "plus", Tier: "standard"}, 6*hourMS, 6*hourMS, &WindowUsage{}, []CycleCalibration{prior}); got != nil || reason != CapacityReasonLowUsage {
		t.Fatalf("cross-plan fallback = %+v, reason = %q", got, reason)
	}
}

func TestEstimateWindowCapacityMidCycleResetAndExhaustionOverflow(t *testing.T) {
	// Mid-cycle reset at 7h (80% -> 0%): at 0% falls back to pre-reset $20 capacity; at 10% uses post-reset delta.
	withReset := cycle(
		point(6, 80, 80, 800_000, 16_000_000_000),
		point(7, 0, 80, 800_000, 16_000_000_000),
	)
	atReset, reason := EstimateWindowCapacity(capacityWindow(0), nil, 7*hourMS, 7*hourMS, nil, []CycleCalibration{withReset})
	if reason != "" || atReset == nil || atReset.Basis != CapacityBasisPreviousWindow || atReset.CostNanos == nil || *atReset.CostNanos != 20_000_000_000 {
		t.Fatalf("immediately after mid-cycle reset = %+v, reason = %q", atReset, reason)
	}

	postReset := cycle(
		point(6, 80, 80, 800_000, 16_000_000_000),
		point(7, 0, 80, 800_000, 16_000_000_000),
		point(8, 10, 90, 900_000, 18_000_000_000),
	)
	afterClimb, reason := EstimateWindowCapacity(capacityWindow(10), nil, 8*hourMS, 8*hourMS, nil, []CycleCalibration{postReset})
	if reason != "" || afterClimb == nil || afterClimb.Basis != CapacityBasisCurrentWindow || afterClimb.Requests != 100 || afterClimb.CostNanos == nil || *afterClimb.CostNanos != 20_000_000_000 {
		t.Fatalf("post-reset climb = %+v, reason = %q", afterClimb, reason)
	}

	// Once a window reaches 100%, subsequent extra-usage overflow does not inflate window capacity—even across a sub-tolerance 99.5% rounding wobble.
	withOverflow := cycle(point(7, 100, 50, 1_000_000, 10_000_000_000))
	overflowLive := WindowUsage{Requests: 150, PricedRequests: 150, Tokens: 3_000_000, CostNanos: 30_000_000_000}
	for _, readingPercent := range []float64{100, 99.5} {
		capped, reason := EstimateWindowCapacity(capacityWindow(readingPercent), nil, 8*hourMS, 8*hourMS, &overflowLive, []CycleCalibration{withOverflow})
		if reason != "" || capped == nil || capped.Tokens != 1_000_000 || capped.CostNanos == nil || *capped.CostNanos != 10_000_000_000 {
			t.Fatalf("%.1f%% exhaustion overflow leaked into capacity = %+v, reason = %q", readingPercent, capped, reason)
		}
		if cutoff, _, ok := ExhaustionCutoffPoint(capacityWindow(readingPercent), nil, 8*hourMS, []CycleCalibration{withOverflow}); !ok || cutoff.ObservedAtMS != 7*hourMS {
			t.Fatalf("%.1f%% cutoff dropped = (%+v, %v)", readingPercent, cutoff, ok)
		}
	}

	// Completed cycle with a post-100% sub-tolerance dip (99.5%) still carries pre-exhaustion capacity into the next cycle.
	priorWithDip := CycleCalibration{
		WindowKey: "codex|five_hour|standard|", CycleResetAtMS: 5 * hourMS, PeriodHours: 5,
		Points: []CalibrationPoint{point(3, 100, 50, 1_000_000, 10_000_000_000), point(4, 99.5, 150, 3_000_000, 30_000_000_000)},
	}
	nextCycleCap, reason := EstimateWindowCapacity(capacityWindow(0), nil, 6*hourMS, 6*hourMS, nil, []CycleCalibration{priorWithDip})
	if reason != "" || nextCycleCap == nil || nextCycleCap.Requests != 50 || nextCycleCap.Tokens != 1_000_000 {
		t.Fatalf("completed cycle with 99.5%% dip leaked overflow = %+v, reason = %q", nextCycleCap, reason)
	}
}

func TestNextCalibrationCycleKeepsBaselineAndRejectsOlderPlan(t *testing.T) {
	stored, ok := NextCalibrationCycle(nil, "codex", capacityWindow(0), nil, 6*hourMS)
	if !ok || stored.CycleResetAtMS != 10*hourMS {
		t.Fatalf("zero baseline = %+v, %v", stored, ok)
	}
	stored.Points = []CalibrationPoint{point(6, 20, 10, 1000, 1000)}
	if _, ok := NextCalibrationCycle([]CycleCalibration{stored}, "codex", capacityWindow(20), nil, 7*hourMS); ok {
		t.Fatal("idle reading added a duplicate point")
	}
	if _, ok := NextCalibrationCycle([]CycleCalibration{stored}, "codex", capacityWindow(20.4), nil, 7*hourMS); !ok {
		t.Fatal("fractional rise was ignored")
	}
	reset, ok := NextCalibrationCycle([]CycleCalibration{stored}, "codex", capacityWindow(0), nil, 8*hourMS)
	if !ok || len(reset.Points) != 1 {
		t.Fatalf("reset = %+v, %v", reset, ok)
	}
	stored.PlanType, stored.PlanTier = "pro", "elite"
	stored.Points = []CalibrationPoint{point(8, 20, 10, 1000, 1000)}
	if _, ok := NextCalibrationCycle([]CycleCalibration{stored}, "codex", capacityWindow(10), &QuotaPlan{PlanType: "free", Tier: "basic"}, 7*hourMS); ok {
		t.Fatal("an older plan reading replaced the newer plan's cycle")
	}

	// Fractional rises coalesce without evicting baseline, mid-cycle reset, or 100% exhaustion points.
	var pts []CalibrationPoint
	for step := range 500 {
		used := float64(step) * 0.1 // 0.0% .. 49.9%
		pts = AppendCalibrationPoint(pts, CalibrationPoint{
			ObservedAtMS: 5*hourMS + int64(step)*1000, UsedPercent: used,
			Requests: int64(step + 1), PricedRequests: int64(step + 1), Tokens: int64(step+1) * 1000, CostNanos: int64(step+1) * 100_000_000,
		})
	}
	pts = AppendCalibrationPoint(pts, point(6, 0, 500, 500_000, 50_000_000_000))   // mid-cycle reset
	pts = AppendCalibrationPoint(pts, point(7, 100, 600, 600_000, 60_000_000_000)) // post-reset 100% exhaustion
	if len(pts) > capacityMaxPoints {
		t.Fatalf("points exceeded cap: %d > %d", len(pts), capacityMaxPoints)
	}
	c := cycle(pts...)
	if cutoff, _, ok := ExhaustionCutoffPoint(capacityWindow(100), nil, 8*hourMS, []CycleCalibration{c}); !ok || cutoff.ObservedAtMS != 7*hourMS {
		t.Fatalf("exhaustion cutoff after fractional climb + reset = (%+v, %v), want 7h", cutoff, ok)
	}
	overflowLive := WindowUsage{FromMS: 5 * hourMS, ToMS: 8 * hourMS, Requests: 900, PricedRequests: 900, Tokens: 900_000, CostNanos: 90_000_000_000}
	got, reason := EstimateWindowCapacity(capacityWindow(100), nil, 8*hourMS, 8*hourMS, &overflowLive, []CycleCalibration{c})
	if reason != "" || got == nil || got.Requests != 100 || got.CostNanos == nil || *got.CostNanos != 10_000_000_000 {
		t.Fatalf("post-reset 100%% capacity after 500 fractional steps = %+v, reason = %q", got, reason)
	}
}
