package quota

import (
	"reflect"
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

func modelPoint(hour, used float64, models ...ModelCalibrationUsage) CalibrationPoint {
	return CalibrationPoint{ObservedAtMS: int64(hour * float64(hourMS)), UsedPercent: used, IntervalModels: models}
}

func modelSample(model string, requests, tokens int64) ModelCalibrationUsage {
	return ModelCalibrationUsage{Model: model, Requests: requests, Tokens: tokens, PromptTokens: tokens}
}

func TestModelQuotaForecastUsesEachModelsOwnObservedConsumption(t *testing.T) {
	stored := cycle(
		modelPoint(6, 10),
		modelPoint(7, 20, modelSample("gemini-4-hydrogen", 10, 1000)),
		modelPoint(8, 40, modelSample("gemini-4-carbon", 10, 1000)),
	)
	forecasts, reason := BuildModelForecasts(capacityWindow(40), nil, 9*hourMS, []CycleCalibration{stored})
	if reason != "" || len(forecasts) != 2 {
		t.Fatalf("forecasts = %+v, reason = %q", forecasts, reason)
	}
	if forecasts[0].Model != "gemini-4-carbon" || forecasts[0].RemainingRequests != 30 || forecasts[0].RemainingTokens != 3000 || forecasts[0].SampleUsedPercent != 20 {
		t.Fatalf("carbon = %+v", forecasts[0])
	}
	if forecasts[1].Model != "gemini-4-hydrogen" || forecasts[1].RemainingRequests != 60 || forecasts[1].RemainingTokens != 6000 || forecasts[1].SampleRequests != 10 {
		t.Fatalf("hydrogen = %+v", forecasts[1])
	}
	// Recorded API-equivalent amounts are usage facts, not forecast inputs.
	stored.Points[1].CostNanos = 100_000_000_000
	repeated, _ := BuildModelForecasts(capacityWindow(40), nil, 9*hourMS, []CycleCalibration{stored})
	if !reflect.DeepEqual(repeated, forecasts) {
		t.Fatalf("a price edit changed a quota forecast: %+v", repeated)
	}
}

func TestModelQuotaForecastRequiresAttributableIntervals(t *testing.T) {
	hydrogen := modelSample("gemini-4-hydrogen", 10, 1000)
	carbon := modelSample("gemini-4-carbon", 10, 1000)
	mixedTier := hydrogen
	mixedTier.HasMixedServiceTiers = true
	cases := []struct {
		name   string
		stored CycleCalibration
	}{
		{"one reading is not a zero baseline", cycle(modelPoint(8, 50, hydrogen))},
		{"legacy aggregate", cycle(point(6, 10, 1, 100), point(8, 50, 10, 1000))},
		{"mixed models", cycle(modelPoint(6, 10), modelPoint(8, 50, hydrogen, carbon))},
		{"unclassified traffic", cycle(modelPoint(6, 10), modelPoint(8, 50, hydrogen, modelSample("private-alias", 1, 100)))},
		{"mixed service tiers", cycle(modelPoint(6, 10), modelPoint(8, 50, mixedTier))},
		{"too few requests", cycle(modelPoint(6, 10), modelPoint(8, 50, modelSample("gemini-4-hydrogen", 4, 400)))},
		{"too little quota", cycle(modelPoint(6, 10), modelPoint(8, 11, hydrogen))},
		{"external-only use", cycle(modelPoint(6, 10), modelPoint(8, 50))},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			forecasts, reason := BuildModelForecasts(capacityWindow(tc.stored.Points[len(tc.stored.Points)-1].UsedPercent), nil, 9*hourMS, []CycleCalibration{tc.stored})
			if len(forecasts) != 0 || reason == "" {
				t.Fatalf("forecasts = %+v, reason = %q", forecasts, reason)
			}
		})
	}
	// New pure intervals can establish evidence after an unattributable climb.
	stored := cycle(modelPoint(6, 10), modelPoint(7, 30, hydrogen, carbon), modelPoint(8, 40, hydrogen))
	forecasts, reason := BuildModelForecasts(capacityWindow(40), nil, 9*hourMS, []CycleCalibration{stored})
	if reason != "" || len(forecasts) != 1 || forecasts[0].FromMS != 7*hourMS {
		t.Fatalf("forecasts = %+v, reason = %q", forecasts, reason)
	}
}

func TestModelQuotaForecastResetsWorkloadAndCycleEvidence(t *testing.T) {
	sample := modelSample("gpt-6.1-sol", 5, 1000)
	cached := sample
	cached.CachedTokens = 800
	stored := cycle(modelPoint(6, 0), modelPoint(7, 10, sample), modelPoint(8, 11, cached))
	if forecasts, _ := BuildModelForecasts(capacityWindow(12), nil, 9*hourMS, []CycleCalibration{stored}); len(forecasts) != 0 {
		t.Fatalf("changed cache mix reused old sample: %+v", forecasts)
	}
	larger := sample
	larger.Tokens, larger.PromptTokens = 10000, 10000
	stored.Points[2] = modelPoint(8, 11, larger)
	if forecasts, _ := BuildModelForecasts(capacityWindow(12), nil, 9*hourMS, []CycleCalibration{stored}); len(forecasts) != 0 {
		t.Fatalf("changed request size reused old sample: %+v", forecasts)
	}
	stored.Points = append(stored.Points, modelPoint(8.5, 0), modelPoint(9, 5, sample))
	forecasts, reason := BuildModelForecasts(capacityWindow(5), nil, 9*hourMS, []CycleCalibration{stored})
	if reason != "" || len(forecasts) != 1 || forecasts[0].SampleRequests != 5 || forecasts[0].FromMS != int64(8.5*float64(hourMS)) {
		t.Fatalf("reset retained old evidence: %+v, %q", forecasts, reason)
	}
	if forecasts, _ := BuildModelForecasts(capacityWindow(5), &QuotaPlan{PlanType: "new-plan"}, 9*hourMS, []CycleCalibration{stored}); len(forecasts) != 0 {
		t.Fatalf("plan changed: %+v", forecasts)
	}
	prior := stored
	prior.CycleResetAtMS -= 5 * hourMS
	if forecasts, _ := BuildModelForecasts(capacityWindow(5), nil, 9*hourMS, []CycleCalibration{prior}); len(forecasts) != 0 {
		t.Fatalf("previous cycle supplied a forecast: %+v", forecasts)
	}
}

func TestModelQuotaForecastAccumulatesOnlyContinuousCompatibleIntervals(t *testing.T) {
	sample := modelSample("gpt-6.1-sol", 3, 300)
	stored := cycle(modelPoint(6, 20), modelPoint(7, 23, sample), modelPoint(8, 26, sample))
	forecasts, reason := BuildModelForecasts(capacityWindow(26), nil, 9*hourMS, []CycleCalibration{stored})
	if reason != "" || len(forecasts) != 1 || forecasts[0].SampleRequests != 6 || forecasts[0].RemainingRequests != 74 || forecasts[0].RoundingErrorPercent != 20.9 {
		t.Fatalf("continuous sample = %+v, %q", forecasts, reason)
	}
	stored.Points[1].IntervalModels = nil
	if forecasts, _ := BuildModelForecasts(capacityWindow(26), nil, 9*hourMS, []CycleCalibration{stored}); len(forecasts) != 0 {
		t.Fatalf("missing interval attributed to the next model: %+v", forecasts)
	}
	// Models outside this window's metered scope do not contaminate its sample.
	scoped := capacityWindow(10)
	scoped.Scope, scoped.ModelFamilies = "model", []string{"claude-sonnet"}
	stored = cycle(modelPoint(6, 0), modelPoint(8, 10, modelSample("claude-sonnet-4-6", 10, 1000), modelSample("gemini-4-carbon", 10, 1000)))
	forecasts, reason = BuildModelForecasts(scoped, nil, 9*hourMS, []CycleCalibration{stored})
	if reason != "" || len(forecasts) != 1 || forecasts[0].Model != "claude-sonnet-4-6" {
		t.Fatalf("scoped sample = %+v, %q", forecasts, reason)
	}
}

func TestNextCalibrationCycleKeepsAnExplicitBaseline(t *testing.T) {
	stored, ok := NextCalibrationCycle(nil, "codex", capacityWindow(0), nil, 6*hourMS)
	if !ok || stored.CycleResetAtMS != 10*hourMS {
		t.Fatalf("zero baseline = %+v, %v", stored, ok)
	}
	stored.Points = []CalibrationPoint{modelPoint(6, 20)}
	if _, ok := NextCalibrationCycle([]CycleCalibration{stored}, "codex", capacityWindow(20), nil, 7*hourMS); ok {
		t.Fatal("idle reading added evidence")
	}
	reset, ok := NextCalibrationCycle([]CycleCalibration{stored}, "codex", capacityWindow(0), nil, 8*hourMS)
	if !ok || len(reset.Points) != 1 {
		t.Fatalf("reset = %+v, %v", reset, ok)
	}
}

func TestModelQuotaForecastSeparatesServiceTiers(t *testing.T) {
	standard := modelSample("gpt-6.1-sol", 10, 1000)
	standard.ServiceTier = "default"
	fast := standard
	fast.ServiceTier = "priority"
	stored := cycle(modelPoint(6, 0), modelPoint(7, 10, standard), modelPoint(8, 30, fast))
	forecasts, reason := BuildModelForecasts(capacityWindow(30), nil, 9*hourMS, []CycleCalibration{stored})
	if reason != "" || len(forecasts) != 2 || forecasts[0].ServiceTier != "priority" || forecasts[0].RemainingRequests != 35 || forecasts[1].ServiceTier != "default" || forecasts[1].RemainingRequests != 70 {
		t.Fatalf("tier forecasts = %+v, %q", forecasts, reason)
	}
}

func TestModelQuotaForecastInvalidatesMixedIntervalWorkload(t *testing.T) {
	initial := modelSample("gpt-6.1-sol", 10, 1000)
	larger := modelSample(initial.Model, 5, 5000)
	cached := modelSample(initial.Model, 5, 500)
	cached.CachedTokens = 400
	mixedTier := modelSample(initial.Model, 5, 500)
	mixedTier.HasMixedServiceTiers = true
	for _, changed := range []ModelCalibrationUsage{larger, cached, mixedTier} {
		stored := cycle(modelPoint(6, 0), modelPoint(7, 10, initial), modelPoint(8, 20, changed, modelSample("gpt-6.1-terra", 5, 500)))
		if got, _ := BuildModelForecasts(capacityWindow(20), nil, 9*hourMS, []CycleCalibration{stored}); len(got) != 0 {
			t.Fatalf("mixed interval retained a changed workload: %+v", got)
		}
	}
	stored := cycle(modelPoint(6, 0), modelPoint(7, 10, initial), modelPoint(8, 20, modelSample(initial.Model, 5, 500), modelSample("gpt-6.1-terra", 5, 500)))
	if got, _ := BuildModelForecasts(capacityWindow(20), nil, 9*hourMS, []CycleCalibration{stored}); len(got) != 1 || got[0].SampleRequests != 10 {
		t.Fatalf("unchanged model lost its earlier direct sample: %+v", got)
	}
}

func TestNextCalibrationCycleRejectsOlderPlanReading(t *testing.T) {
	stored := cycle(modelPoint(8, 20))
	stored.PlanType, stored.PlanTier = "pro", "elite"
	if _, ok := NextCalibrationCycle([]CycleCalibration{stored}, "codex", capacityWindow(10), &QuotaPlan{PlanType: "free", Tier: "basic"}, 7*hourMS); ok {
		t.Fatal("an older plan reading replaced the newer plan's cycle")
	}
	reset := modelPoint(8, 0)
	reset.HasUsageGap = true
	withReset := cycle(modelPoint(6, 0), modelPoint(7, 20, modelSample("gpt-6.1-sol", 10, 1000)), reset)
	if got, reason := BuildModelForecasts(capacityWindow(0), nil, 9*hourMS, []CycleCalibration{withReset}); len(got) != 0 || reason != CapacityReasonResetMidCycle {
		t.Fatalf("mid-cycle reset with usage gap = %+v, %q", got, reason)
	}
}

func TestModelQuotaForecastMinQuotaAndWorkloadTolerance(t *testing.T) {
	p := modelSample("gpt-6.1-sol", 5, 5000)
	p.PricedRequests = 5
	p.CostNanos = 1_000_000_000
	shortCycle := cycle(modelPoint(6, 0), modelPoint(8, 2, p))
	forecasts, reason := BuildModelForecasts(capacityWindow(2), nil, 9*hourMS, []CycleCalibration{shortCycle})
	if reason != "" || len(forecasts) != 1 || forecasts[0].RemainingRequests != 245 || forecasts[0].RemainingCostNanos == nil || *forecasts[0].RemainingCostNanos != 49_000_000_000 {
		t.Fatalf("5h 2%% forecast = %+v, %q", forecasts, reason)
	}

	first := ModelCalibrationUsage{Model: "gpt-6.1-sol", Requests: 3, Tokens: 10300, PromptTokens: 10000, CachedTokens: 6000, OutputTokens: 300}
	second := ModelCalibrationUsage{Model: "gpt-6.1-sol", Requests: 3, Tokens: 20500, PromptTokens: 20000, CachedTokens: 16000, OutputTokens: 1200}
	stored := cycle(modelPoint(6, 0), modelPoint(7, 3, first), modelPoint(8, 6, second))
	forecasts, reason = BuildModelForecasts(capacityWindow(6), nil, 9*hourMS, []CycleCalibration{stored})
	if reason != "" || len(forecasts) != 1 || forecasts[0].SampleRequests != 6 || forecasts[0].SampleUsedPercent != 6 {
		t.Fatalf("moderate workload shift dropped sample = %+v, %q", forecasts, reason)
	}
}
