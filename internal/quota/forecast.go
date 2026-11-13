package quota

import (
	"math"
	"sort"
	"strings"
)

const (
	forecastMinRequests         = 5
	forecastMinUsedPercent      = 2.0
	forecastMaxCacheShift       = 25.0
	forecastMaxRequestSizeRatio = 3.0
)

// ModelCalibrationUsage freezes one model's completed traffic between two quota
// readings. Aggregate-only historical points cannot establish this attribution.
type ModelCalibrationUsage struct {
	Model                string `json:"model"`
	Requests             int64  `json:"requests"`
	PricedRequests       int64  `json:"priced_requests,omitempty"`
	Tokens               int64  `json:"tokens"`
	PromptTokens         int64  `json:"prompt_tokens,omitempty"`
	CachedTokens         int64  `json:"cached_tokens,omitempty"`
	OutputTokens         int64  `json:"output_tokens,omitempty"`
	CostNanos            int64  `json:"cost_nanos,omitempty"`
	ServiceTier          string `json:"service_tier,omitempty"`
	HasMixedServiceTiers bool   `json:"has_mixed_service_tiers,omitempty"`
}

// ModelQuotaForecast is conditional on the sampled model, lane and workload.
// It describes remaining work, not the provider's allowance or a monetary balance.
type ModelQuotaForecast struct {
	Model                string   `json:"model"`
	ServiceTier          string   `json:"service_tier,omitempty"`
	SampleRequests       int64    `json:"sample_requests"`
	SamplePricedRequests int64    `json:"sample_priced_requests,omitempty"`
	SampleTokens         int64    `json:"sample_tokens"`
	SampleUsedPercent    float64  `json:"sample_used_percent"`
	CacheRate            *float64 `json:"cache_rate,omitempty"`
	FromMS               int64    `json:"from_ms"`
	ObservedAtMS         int64    `json:"observed_at_ms"`
	RemainingRequests    int64    `json:"remaining_requests"`
	RemainingTokens      int64    `json:"remaining_tokens"`
	RemainingCostNanos   *int64   `json:"remaining_cost_nanos,omitempty"`
	// This bound covers meter rounding only, not future workload variability.
	RoundingErrorPercent float64 `json:"rounding_error_percent"`
}

type modelForecastSample struct {
	ModelCalibrationUsage
	usedPercent  float64
	fromMS       int64
	observedAtMS int64
}

// BuildModelForecasts uses only continuous, single-model intervals in the live
// cycle. Prices, older cycles and another model's consumption are not evidence
// of how much quota the selected model consumes.
func BuildModelForecasts(window QuotaWindow, plan *QuotaPlan, observedAtMS int64, cycles []CycleCalibration) ([]ModelQuotaForecast, string) {
	if _, _, reason := WindowCycleRange(window, observedAtMS, observedAtMS); reason != "" {
		return nil, reason
	}
	used, hasReading := WindowUsedPercent(window)
	if !hasReading {
		return nil, CapacityReasonNoReading
	}
	live := liveCycleIndex(window, observedAtMS, cycles)
	if live < 0 || !sameCalibrationPlan(cycles[live], plan) {
		return nil, CapacityReasonLowUsage
	}
	samples := make(map[string]*modelForecastSample)
	var active *modelForecastSample
	reason := CapacityReasonLowUsage
	points := cycles[live].Points
	for index := 1; index < len(points); index++ {
		previous, point := points[index-1], points[index]
		if point.ObservedAtMS > observedAtMS {
			break
		}
		rise := point.UsedPercent - previous.UsedPercent
		if rise < -capacityResetTolerancePercent {
			clear(samples)
			active = nil
			reason = CapacityReasonResetMidCycle
			continue
		}
		if point.HasUsageGap {
			// Earlier rates used incomplete attribution; only fresh intervals can rebuild them.
			clear(samples)
			active = nil
			reason = CapacityReasonLowUsage
			continue
		}
		if rise <= 0 || point.ObservedAtMS <= previous.ObservedAtMS {
			active = nil
			continue
		}
		for key, sample := range samples {
			for _, model := range point.IntervalModels {
				if model.Requests <= 0 || !strings.EqualFold(sample.Model, model.Model) {
					continue
				}
				if model.HasMixedServiceTiers || sample.ServiceTier == model.ServiceTier && !hasSimilarWorkload(sample.ModelCalibrationUsage, model) {
					delete(samples, key)
				}
			}
		}
		model, ok := singleIntervalModel(window, point.IntervalModels)
		if !ok {
			active = nil
			if len(point.IntervalModels) > 1 {
				reason = CapacityReasonMixedModels
			}
			continue
		}
		key := strings.ToLower(model.Model) + "\x00" + model.ServiceTier
		if active == nil || !strings.EqualFold(active.Model, model.Model) || active.ServiceTier != model.ServiceTier || !hasSimilarWorkload(active.ModelCalibrationUsage, model) {
			active = &modelForecastSample{ModelCalibrationUsage: model, usedPercent: rise, fromMS: previous.ObservedAtMS, observedAtMS: point.ObservedAtMS}
		} else {
			active.Requests += model.Requests
			active.PricedRequests += model.PricedRequests
			active.Tokens += model.Tokens
			active.PromptTokens += model.PromptTokens
			active.CachedTokens += model.CachedTokens
			active.OutputTokens += model.OutputTokens
			active.CostNanos += model.CostNanos
			active.usedPercent += rise
			active.observedAtMS = point.ObservedAtMS
		}
		// The latest workload replaces an earlier run of this model, even when
		// its new sample is too small. This prevents a changed cache mix from
		// continuing to display the earlier run's prediction.
		samples[key] = active
	}
	forecasts := make([]ModelQuotaForecast, 0, len(samples))
	remaining := 100 - used
	for _, sample := range samples {
		if sample.Requests < forecastMinRequests || sample.usedPercent < forecastMinUsedPercent {
			continue
		}
		var remainingCostNanos *int64
		if sample.PricedRequests == sample.Requests && sample.Requests > 0 || sample.PricedRequests > 0 && sample.CostNanos > 0 {
			cost := int64(math.Floor(float64(sample.CostNanos) * remaining / sample.usedPercent))
			remainingCostNanos = &cost
		}
		forecasts = append(forecasts, ModelQuotaForecast{
			Model: sample.Model, ServiceTier: sample.ServiceTier,
			SampleRequests: sample.Requests, SamplePricedRequests: sample.PricedRequests,
			SampleTokens: sample.Tokens, SampleUsedPercent: sample.usedPercent,
			CacheRate: ComputeCacheRate(sample.CachedTokens, sample.PromptTokens),
			FromMS:    sample.fromMS, ObservedAtMS: sample.observedAtMS,
			RemainingRequests:    int64(math.Floor(float64(sample.Requests) * remaining / sample.usedPercent)),
			RemainingTokens:      int64(math.Floor(float64(sample.Tokens) * remaining / sample.usedPercent)),
			RemainingCostNanos:   remainingCostNanos,
			RoundingErrorPercent: forecastRoundingError(sample.usedPercent, remaining),
		})
	}
	sort.Slice(forecasts, func(i, j int) bool {
		if forecasts[i].ObservedAtMS != forecasts[j].ObservedAtMS {
			return forecasts[i].ObservedAtMS > forecasts[j].ObservedAtMS
		}
		if forecasts[i].Model != forecasts[j].Model {
			return forecasts[i].Model < forecasts[j].Model
		}
		return forecasts[i].ServiceTier < forecasts[j].ServiceTier
	})
	if len(forecasts) == 0 {
		return nil, reason
	}
	return forecasts, ""
}

func singleIntervalModel(window QuotaWindow, models []ModelCalibrationUsage) (ModelCalibrationUsage, bool) {
	var selected ModelCalibrationUsage
	for _, model := range models {
		if model.Requests <= 0 {
			continue
		}
		name := normalizeCapacityModel(model.Model)
		if capacityModelFamily(name) == "" {
			return ModelCalibrationUsage{}, false
		}
		if !IsModelInWindowScope(window, model.Model) {
			continue
		}
		if selected.Requests > 0 || model.Tokens <= 0 || model.HasMixedServiceTiers {
			return ModelCalibrationUsage{}, false
		}
		selected = model
	}
	return selected, selected.Requests > 0
}

func hasSimilarWorkload(previous, current ModelCalibrationUsage) bool {
	checks := [][2]int64{{previous.Tokens, current.Tokens}, {previous.PromptTokens, current.PromptTokens}}
	// Ignore output-token swings when output is under 10% of total tokens so tool-call length jitter does not reset large-context samples.
	if previous.OutputTokens*10 >= previous.Tokens || current.OutputTokens*10 >= current.Tokens {
		checks = append(checks, [2]int64{previous.OutputTokens, current.OutputTokens})
	}
	for _, counts := range checks {
		if counts[0] == 0 || counts[1] == 0 {
			if counts[0] != counts[1] {
				return false
			}
			continue
		}
		ratio := (float64(counts[1]) / float64(current.Requests)) / (float64(counts[0]) / float64(previous.Requests))
		if ratio < 1/forecastMaxRequestSizeRatio || ratio > forecastMaxRequestSizeRatio {
			return false
		}
	}
	previousCache := ComputeCacheRate(previous.CachedTokens, previous.PromptTokens)
	currentCache := ComputeCacheRate(current.CachedTokens, current.PromptTokens)
	if previousCache == nil || currentCache == nil {
		return previousCache == nil && currentCache == nil
	}
	return math.Abs(*previousCache-*currentCache) <= forecastMaxCacheShift
}

// Both ends of the sampled delta are rounded; the live remaining share has
// its own half-step. This bound intentionally says nothing about future tasks.
func forecastRoundingError(sampleUsed, remaining float64) float64 {
	if remaining <= 0 {
		return 0
	}
	ratio := remaining / sampleUsed
	upper := min(100, remaining+usedPercentHalfStep) / (sampleUsed - 2*usedPercentHalfStep)
	lower := max(0, remaining-usedPercentHalfStep) / (sampleUsed + 2*usedPercentHalfStep)
	return math.Ceil(max(upper/ratio-1, 1-lower/ratio)*1000) / 10
}
