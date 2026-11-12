package quota

import (
	"testing"

	"github.com/oh-my-cpa/oh-my-cpa/internal/pricing"
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

	// Majority-priced mixed intervals with explicit priced-token evidence scale
	// the unpriced remainder; legacy mixed points without PricedTokens or
	// minority-priced climbs withhold a dollar figure rather than guessing from
	// request counts.
	majorityPriced := point(8, 20, 4, 2_000_000)
	majorityPriced.PricedRequests = 3
	majorityPriced.PricedTokens = 1_500_000
	majorityPriced.CostNanos = 1_500_000
	if capacity, _ := estimate(20, cycle(majorityPriced)); capacity == nil || capacity.CostNanos == nil || *capacity.CostNanos != 10_000_000 || capacity.Tokens != 10_000_000 {
		t.Fatalf("majority-priced climb = %+v, want scaled $0.01 cost and 10M tokens", capacity)
	}
	legacyMixed := point(8, 20, 4, 2_000_000)
	legacyMixed.PricedRequests = 3
	legacyMixed.CostNanos = 1_500_000
	if capacity, _ := estimate(20, cycle(legacyMixed)); capacity == nil || capacity.CostNanos != nil {
		t.Fatalf("legacy mixed point without PricedTokens = %+v, want nil cost rather than request-ratio inference", capacity)
	}
	minorityPriced := point(8, 20, 4, 2_000_000)
	minorityPriced.PricedRequests = 1
	minorityPriced.PricedTokens = 500_000
	if capacity, _ := estimate(20, cycle(minorityPriced)); capacity == nil || capacity.CostNanos != nil || capacity.Tokens != 10_000_000 {
		t.Fatalf("minority-priced climb = %+v, want tokens without a cost", capacity)
	}

	// A cleanly priced interval anchors dollar capacity directly even when a
	// later interval in the same cycle ran only unpriced models.
	mixedIntervals := cycle(
		CalibrationPoint{ObservedAtMS: 6 * hourMS, UsedPercent: 10, Requests: 5, PricedRequests: 5, Tokens: 1_000_000, PricedTokens: 1_000_000, CostNanos: 5_000_000_000},
		CalibrationPoint{ObservedAtMS: 8 * hourMS, UsedPercent: 40, Requests: 20, PricedRequests: 5, Tokens: 4_000_000, PricedTokens: 1_000_000, CostNanos: 5_000_000_000},
	)
	if capacity, _ := estimate(40, mixedIntervals); capacity == nil || capacity.CostNanos == nil || *capacity.CostNanos != 50_000_000_000 || capacity.Tokens != 10_000_000 {
		t.Fatalf("clean + unpriced intervals = %+v, want $50 from the clean 10%% climb and 10M tokens over 40%%", capacity)
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
	if prev := PreviousCapacityCycle(capacityWindow(0), plus, 9*hourMS, []CycleCalibration{previous}); prev == nil || prev.CycleResetAtMS != 5*hourMS {
		t.Fatalf("same-plan previous cycle = %+v, want 5h reset", prev)
	}
	if prev := PreviousCapacityCycle(capacityWindow(0), &QuotaPlan{PlanType: "pro"}, 9*hourMS, []CycleCalibration{previous}); prev != nil {
		t.Fatalf("different-plan previous cycle = %+v, want nil", prev)
	}

	// Subscribing or re-anchoring mid-week replaces an overlapping earlier cycle
	// (e.g. 11/07..11/14 superseded on 11/12 by 11/12..11/19): neither the
	// overlapping cycle nor anything before that schedule break counts as a
	// previous cycle or calibration reference.
	const dayMS = 24 * hourMS
	ancient := CycleCalibration{
		WindowKey:      "antigravity|ag_gemini_weekly|group|gemini",
		CycleResetAtMS: 7 * dayMS,
		PeriodHours:    168,
		Points:         []CalibrationPoint{{ObservedAtMS: 6 * dayMS, UsedPercent: 50, Requests: 100, PricedRequests: 100, Tokens: 10_000_000, CostNanos: 5_000_000_000}},
	}
	superseded := CycleCalibration{
		WindowKey:      "antigravity|ag_gemini_weekly|group|gemini",
		CycleResetAtMS: 14 * dayMS,
		PeriodHours:    168,
		Points:         []CalibrationPoint{{ObservedAtMS: 11 * dayMS, UsedPercent: 7, Requests: 353, PricedRequests: 353, Tokens: 61_400_000, CostNanos: 10_650_000_000}},
	}
	active := CycleCalibration{
		WindowKey:      "antigravity|ag_gemini_weekly|group|gemini",
		CycleResetAtMS: 19 * dayMS,
		PeriodHours:    168,
		Points:         []CalibrationPoint{{ObservedAtMS: 13 * dayMS, UsedPercent: 53, Requests: 1_740, PricedRequests: 1_740, Tokens: 455_000_000, CostNanos: 103_720_000_000}},
	}
	activeWindow := QuotaWindow{
		ID:            "ag_gemini_weekly",
		Scope:         "group",
		ModelFamilies: []string{"gemini"},
		UsedPercent:   floatPtr(53),
		ResetAtMS:     int64Ptr(19 * dayMS),
		PeriodHours:   floatPtr(168),
		ResetAccuracy: "exact",
	}
	if prev := PreviousCapacityCycle(activeWindow, nil, 13*dayMS, []CycleCalibration{active, superseded, ancient}); prev != nil {
		t.Fatalf("overlapping superseded cycle returned as previous = %+v, want nil", prev)
	}
	reanchoredCap, reason := EstimateWindowCapacity(activeWindow, nil, 13*dayMS, []CycleCalibration{active, superseded, ancient})
	if reanchoredCap == nil || reason != "" || reanchoredCap.Basis != "current_cycle" {
		t.Fatalf("reanchored capacity = %+v %q, want current_cycle without blending superseded history", reanchoredCap, reason)
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

func TestCacheWeightedCapacityAndDominantModelProjection(t *testing.T) {
	if got := ComputeCacheRate(0, 0); got != nil {
		t.Fatalf("empty prompt cache rate = %v, want nil", got)
	}
	if got := ComputeCacheRate(9_999, 10_000); got == nil || *got != 99.9 {
		t.Fatalf("near-100%% cache rate = %v, want 99.9 ceiling", got)
	}

	// Previous cycle ran at high cache rate ($50 = 100M tokens); current cycle
	// runs uncached ($1 over 2% = $50 = 20M tokens). Dollar capacity blends at
	// $50 and raw tokens follow the current cycle's uncached rate (~20M).
	previous := CycleCalibration{
		WindowKey:      "codex|five_hour|standard|",
		CycleResetAtMS: 5 * hourMS,
		PeriodHours:    5,
		Points: []CalibrationPoint{{
			ObservedAtMS: 4 * hourMS, UsedPercent: 50, Requests: 500, PricedRequests: 500,
			Tokens: 50_000_000, PricedTokens: 50_000_000, PromptTokens: 50_000_000, CachedTokens: 45_000_000, CostNanos: 25_000_000_000,
		}},
	}
	current := cycle(CalibrationPoint{
		ObservedAtMS: 6 * hourMS, UsedPercent: 2, Requests: 10, PricedRequests: 10,
		Tokens: 400_000, PricedTokens: 400_000, PromptTokens: 400_000, CachedTokens: 0, CostNanos: 1_000_000_000,
	})
	capacity, reason := EstimateWindowCapacity(capacityWindow(2), nil, 9*hourMS, []CycleCalibration{current, previous})
	if capacity == nil || reason != "" || capacity.CostNanos == nil || *capacity.CostNanos != 50_000_000_000 || capacity.Tokens != 20_000_000 {
		t.Fatalf("cache-shifted blend = %+v %q, want $50 and 20M uncached tokens", capacity, reason)
	}

	// Multi-model workload: $50 window at 20% used ($10 spent = 90 reqs, 1.75M tokens).
	// Dominant model is claude-sonnet-4-6 (80 reqs, $4 = $0.05/req, 20k tok/req, 80% cache rate),
	// alongside 10 reqs of claude-opus-4-6 ($6 = $0.60/req, 15k tok/req).
	window := capacityWindow(20)
	costCap := int64(50_000_000_000)
	sized := &WindowCapacity{Requests: 450, Tokens: 8_750_000, CostNanos: &costCap, ErrorPercent: 2.6}
	groups := []ModelWindowUsage{
		{
			Model: "claude-opus-4-6",
			Usage: WindowUsage{Requests: 10, PricedRequests: 10, Tokens: 150_000, PricedTokens: 150_000, PromptTokens: 120_000, CachedTokens: 60_000, OutputTokens: 30_000, MinInputTokens: 12_000, MaxInputTokens: 12_000, HasInputBounds: true, CostNanos: 6_000_000_000},
		},
		{
			Model: "claude-sonnet-4-6",
			Usage: WindowUsage{Requests: 80, PricedRequests: 80, Tokens: 1_600_000, PricedTokens: 1_600_000, PromptTokens: 1_500_000, CachedTokens: 1_200_000, OutputTokens: 100_000, MinInputTokens: 15_000, MaxInputTokens: 20_000, HasInputBounds: true, CostNanos: 4_000_000_000},
		},
	}
	AttachModelProjection(sized, window, groups)
	// $50 window converted onto Sonnet ($0.05/req, 20k tok/req): 1,000 requests, 20M tokens.
	if sized.Projection == nil || sized.Projection.Model != "claude-sonnet-4-6" || sized.Projection.Requests != 1_000 || sized.Projection.Tokens != 20_000_000 {
		t.Fatalf("projection = %+v, want claude-sonnet-4-6 with 1,000 requests and 20M tokens", sized.Projection)
	}
	if sized.Projection.CacheRate == nil || *sized.Projection.CacheRate != 80 {
		t.Fatalf("projection cache rate = %+v, want 80%%", sized.Projection)
	}

	longContextRate := 20.0
	projections := BuildModelProjections(
		sized,
		window,
		groups,
		[]string{"claude-haiku-4-5", "claude-sonnet-long", "claude-priority-only"},
		map[string]ModelQuoteRate{
			// Updated current rate for Sonnet ($0.10/req instead of historical $0.05/req) takes precedence.
			"claude-sonnet-4-6": {
				Price: pricing.ModelPrice{Model: "claude-sonnet-4-6", PromptPricePer1M: 10.0, CompletionPer1M: 38.0, CacheReadPer1M: 1.0, PriceMultiplier: 1},
			},
			"claude-haiku-4-5": {
				Price: pricing.ModelPrice{Model: "claude-haiku-4-5", PromptPricePer1M: 1.0, CompletionPer1M: 5.0, CacheReadPer1M: 0.1, PriceMultiplier: 1},
			},
			// Long-context tier (>10k input tokens, which avgPrompt ~18k exceeds) overrides the $1 base rate with $20.
			"claude-sonnet-long": {
				Price: pricing.ModelPrice{
					Model: "claude-sonnet-long", PromptPricePer1M: 1.0, CompletionPer1M: 5.0, CacheReadPer1M: 0.1, PriceMultiplier: 1,
					Tiers: []pricing.PriceTier{{MinPromptTokens: 10_000, PromptPricePer1M: &longContextRate}},
				},
			},
			"claude-priority-only": {
				Price: pricing.ModelPrice{
					Model: "claude-priority-only", PromptPricePer1M: 2.0, CompletionPer1M: 10.0, CacheReadPer1M: 0.2, PriceMultiplier: 1,
					Tiers: []pricing.PriceTier{{ServiceTiers: []string{"priority"}, PromptPricePer1M: &longContextRate}},
				},
			},
		},
	)
	if len(projections) != 5 || projections[0].Model != "claude-sonnet-4-6" || projections[1].Model != "claude-opus-4-6" || projections[2].Model != "claude-haiku-4-5" {
		t.Fatalf("projections = %+v, want sonnet, opus, haiku, priority-only, sonnet-long", projections)
	}
	// Sonnet updated rate ($0.10/req -> 500 requests instead of historical 1,000); Opus historical fallback ($0.60/req -> 83 requests).
	if projections[0].Requests != 500 || projections[1].Requests != 83 || projections[2].Requests <= projections[0].Requests {
		t.Fatalf("model switch projections = %+v, want 500 Sonnet (current rate), 83 Opus, and >500 Haiku", projections)
	}
	// Long-context tier applied to claude-sonnet-long makes it hold far fewer requests than claude-haiku-4-5 despite identical base rates.
	if projections[4].Model != "claude-sonnet-long" || projections[4].Requests >= projections[2].Requests {
		t.Fatalf("tiered candidate = %+v vs base %+v, want long-context tier applied", projections[4], projections[2])
	}

	// Reference groups without a prompt/output breakdown omit candidate projections rather than treating all tokens as completion,
	// and mixed service tiers withhold candidates with service-tier rules.
	noBreakdown := BuildModelProjections(
		sized,
		window,
		[]ModelWindowUsage{{Model: "claude-sonnet-4-6", Usage: WindowUsage{Requests: 10, PricedRequests: 10, Tokens: 200_000, CostNanos: 1_000_000_000}}},
		[]string{"claude-haiku-4-5"},
		map[string]ModelQuoteRate{"claude-haiku-4-5": {Price: pricing.ModelPrice{Model: "claude-haiku-4-5", PromptPricePer1M: 1.0, CompletionPer1M: 5.0, PriceMultiplier: 1}}},
	)
	if len(noBreakdown) != 1 || noBreakdown[0].Model != "claude-sonnet-4-6" {
		t.Fatalf("total-only reference = %+v, want observed model only and candidate omitted", noBreakdown)
	}
	mixedTierGroups := []ModelWindowUsage{{
		Model: "claude-sonnet-4-6",
		Usage: WindowUsage{Requests: 10, PricedRequests: 10, Tokens: 200_000, PromptTokens: 180_000, OutputTokens: 20_000, HasMixedServiceTiers: true, CostNanos: 1_000_000_000},
	}}
	withheld := BuildModelProjections(
		sized,
		window,
		mixedTierGroups,
		[]string{"claude-priority-only"},
		map[string]ModelQuoteRate{
			"claude-priority-only": {
				Price: pricing.ModelPrice{
					Model: "claude-priority-only", PromptPricePer1M: 2.0, CompletionPer1M: 10.0, PriceMultiplier: 1,
					Tiers: []pricing.PriceTier{{ServiceTiers: []string{"priority"}, PromptPricePer1M: &longContextRate}},
				},
			},
		},
	)
	if len(withheld) != 1 || withheld[0].Model != "claude-sonnet-4-6" {
		t.Fatalf("ambiguous service-tier candidate = %+v, want service-tier candidate withheld", withheld)
	}

	// Minority-priced or legacy mixed model usage without PricedTokens falls back
	// to token-based projection rather than extrapolating noisy partial cost.
	minorityModelProj := BuildModelProjections(
		&WindowCapacity{Requests: 100, Tokens: 2_000_000, CostNanos: &costCap, ErrorPercent: 2},
		window,
		[]ModelWindowUsage{{
			Model: "claude-sonnet-4-6",
			Usage: WindowUsage{Requests: 10, PricedRequests: 1, Tokens: 200_000, CostNanos: 10_000_000},
		}},
		nil,
		nil,
	)
	if len(minorityModelProj) != 1 || minorityModelProj[0].Requests != 100 {
		t.Fatalf("minority-priced model projection = %+v, want token-based 100 requests", minorityModelProj)
	}

	// Straddled long-context threshold (50k @ $1/M = $0.05 + 250k @ $10/M = $2.50 ->
	// mean input 150k < 200k, empirical mean cost $1.275/req): observed projection
	// must use empirical $1.275/req (39 requests on $50, matching AttachModelProjection)
	// rather than quoting mean(150k) at $0.15/req (333 requests), and candidate models
	// whose threshold is straddled are withheld.
	tierTen := 10.0
	straddledCap := &WindowCapacity{Requests: 39, Tokens: 5_882_353, CostNanos: &costCap, ErrorPercent: 2}
	straddledGroups := []ModelWindowUsage{{
		Model: "claude-sonnet-4-6",
		Usage: WindowUsage{
			Requests: 2, PricedRequests: 2, Tokens: 300_000, PricedTokens: 300_000,
			PromptTokens: 300_000, MinInputTokens: 50_000, MaxInputTokens: 250_000, HasInputBounds: true,
			CostNanos: 2_550_000_000,
		},
	}}
	AttachModelProjection(straddledCap, window, straddledGroups)
	straddledProjs := BuildModelProjections(
		straddledCap,
		window,
		straddledGroups,
		[]string{"claude-opus-tiered"},
		map[string]ModelQuoteRate{
			"claude-sonnet-4-6": {
				Price: pricing.ModelPrice{
					Model: "claude-sonnet-4-6", PromptPricePer1M: 1.0, CompletionPer1M: 5.0, PriceMultiplier: 1,
					Tiers: []pricing.PriceTier{{MinPromptTokens: 200_000, PromptPricePer1M: &tierTen}},
				},
			},
			"claude-opus-tiered": {
				Price: pricing.ModelPrice{
					Model: "claude-opus-tiered", PromptPricePer1M: 2.0, CompletionPer1M: 10.0, PriceMultiplier: 1,
					Tiers: []pricing.PriceTier{{MinPromptTokens: 200_000, PromptPricePer1M: &longContextRate}},
				},
			},
		},
	)
	if straddledCap.Projection == nil || straddledCap.Projection.Requests != 39 {
		t.Fatalf("AttachModelProjection straddled = %+v, want 39 empirical requests", straddledCap.Projection)
	}
	if len(straddledProjs) != 1 || straddledProjs[0].Requests != straddledCap.Projection.Requests {
		t.Fatalf("BuildModelProjections straddled = %+v, want empirical 39 requests matching AttachModelProjection and straddled candidate withheld", straddledProjs)
	}
}
