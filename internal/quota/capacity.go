package quota

import (
	"math"
	"strings"

	"github.com/oh-my-cpa/oh-my-cpa/internal/pricing"
)

// capacityCleanPricedShare is the share of requests in an interval that counts
// as cleanly priced without scaling.
const capacityCleanPricedShare = 0.95

// capacityMinImputedShare is the lowest share of priced tokens from which a
// mixed priced/unpriced climb scales a dollar estimate.
const capacityMinImputedShare = 0.50

// capacityResetTolerancePercent absorbs upstream rounding when two readings of
// the same cycle are compared: only a larger drop is a reset.
const capacityResetTolerancePercent = 1.0

// usedPercentHalfStep is half of the one-point granularity upstream reports, the
// most a rounded reading can differ from the share it stands for.
const usedPercentHalfStep = 0.5

// maxDisplayedCacheRate matches the console and dashboard presentation ceiling:
// any nonzero uncached prompt keeps a rounded reading below 100%.
const maxDisplayedCacheRate = 99.9

// Reasons a window carries no capacity estimate yet. They are wire values the
// console maps to its own copy, each naming what starts an estimate.
const (
	// CapacityReasonScopeUnknown: a scoped window's requests all used models
	// with no known family, so none of them can be counted against it.
	CapacityReasonScopeUnknown       = "scope_unknown"
	CapacityReasonHistoryUnavailable = "history_unavailable"
	CapacityReasonUsageUnavailable   = "usage_unavailable"
	// CapacityReasonBoundaryUnknown: the reading names no reset instant or
	// period, so it cannot be placed in a cycle.
	CapacityReasonBoundaryUnknown = "boundary_unknown"
	// CapacityReasonExpired: the cycle the reading describes has already ended.
	CapacityReasonExpired = "expired"
	// CapacityReasonNoReading: upstream published no used share for the window.
	CapacityReasonNoReading = "no_reading"
	// CapacityReasonLowUsage: too little of the window has been used for its
	// rounded share to support a figure.
	CapacityReasonLowUsage = "low_usage"
	// CapacityReasonNoTraffic: quota was used but this gateway recorded no
	// request while it moved, so it was spent elsewhere.
	CapacityReasonNoTraffic = "no_traffic"
	// CapacityReasonResetMidCycle: the counter was reset part-way through the
	// cycle and no reading since the reset gives a change to measure.
	CapacityReasonResetMidCycle = "reset_mid_cycle"
)

// WindowUsage is what this deployment recorded for a credential in [FromMS, ToMS).
type WindowUsage struct {
	FromMS               int64    `json:"from_ms"`
	ToMS                 int64    `json:"to_ms"`
	Requests             int64    `json:"requests"`
	PricedRequests       int64    `json:"priced_requests"`
	Tokens               int64    `json:"tokens"`
	PromptTokens         int64    `json:"prompt_tokens,omitempty"`
	CachedTokens         int64    `json:"cached_tokens,omitempty"`
	CacheRate            *float64 `json:"cache_rate,omitempty"`
	CostNanos            int64    `json:"cost_nanos"`
	PricedTokens         int64    `json:"-"`
	BreakdownRequests    int64    `json:"-"`
	CacheWriteTokens     int64    `json:"-"`
	OutputTokens         int64    `json:"-"`
	MinInputTokens       int64    `json:"-"`
	MaxInputTokens       int64    `json:"-"`
	HasInputBounds       bool     `json:"-"`
	ServiceTier          string   `json:"-"`
	HasMixedServiceTiers bool     `json:"-"`
	UnmatchedRequests    int64    `json:"-"`
}

func (usage WindowUsage) hasTokenBreakdown() bool {
	if usage.BreakdownRequests > 0 {
		return usage.BreakdownRequests == usage.Requests && (usage.PromptTokens > 0 || usage.OutputTokens > 0)
	}
	return usage.Requests > 0 && (usage.PromptTokens > 0 || usage.OutputTokens > 0)
}

func (usage WindowUsage) inputBounds() (minInput, maxInput int64, ok bool) {
	if !usage.hasTokenBreakdown() {
		return 0, 0, false
	}
	if usage.HasInputBounds || usage.MinInputTokens > 0 || usage.MaxInputTokens > 0 {
		return max(usage.MinInputTokens, 0), max(usage.MaxInputTokens, 0), true
	}
	if usage.Requests == 1 {
		single := max(usage.PromptTokens, usage.CachedTokens+usage.CacheWriteTokens)
		return single, single, true
	}
	return 0, 0, false
}

// ModelQuoteRate holds the active ModelPrice, channel multiplier and quote
// timestamp so projections honour tiers (long-context, service-tier, time
// windows) via pricing.Quote.
type ModelQuoteRate struct {
	Price             pricing.ModelPrice
	ChannelMultiplier float64
	QuoteAtMS         int64
}

func (rate ModelQuoteRate) quoteNanos(
	prompt, cached, cacheWrite, output float64,
	hasInputBounds bool,
	minInput, maxInput int64,
	allowPointInTimeWindow bool,
	isTierKnown bool,
	serviceTier string,
) (float64, bool) {
	for _, tier := range rate.Price.Tiers {
		if tier.HasServiceTiers() && !isTierKnown {
			return 0, false
		}
		if tier.HasWindow() && (!allowPointInTimeWindow || rate.QuoteAtMS <= 0) {
			return 0, false
		}
		if tier.MinPromptTokens > 0 {
			if !hasInputBounds || minInput < tier.MinPromptTokens && maxInput >= tier.MinPromptTokens {
				return 0, false
			}
		}
	}
	price := rate.Price
	if price.PriceMultiplier == 0 {
		price.PriceMultiplier = 1
	}
	channelMult := rate.ChannelMultiplier
	if channelMult <= 0 || math.IsNaN(channelMult) || math.IsInf(channelMult, 0) {
		channelMult = 1
	}
	c := int64(math.Round(max(cached, 0)))
	w := int64(math.Round(max(cacheWrite, 0)))
	p := max(int64(math.Round(max(prompt, 0))), c+w)
	o := int64(math.Round(max(output, 0)))
	if p == 0 && o == 0 {
		return 0, false
	}
	breakdown, err := pricing.Quote(price, channelMult, pricing.Tokens{
		Input:      p,
		Output:     o,
		CacheRead:  c,
		CacheWrite: w,
	}, rate.QuoteAtMS, serviceTier)
	if err != nil || breakdown.TotalNanos <= 0 {
		return 0, false
	}
	return float64(breakdown.TotalNanos), true
}

// ModelCapacityProjection expresses the whole window's request and token
// capacity if the remaining allowance from now is spent on a single model.
type ModelCapacityProjection struct {
	Model          string   `json:"model"`
	SampleRequests int64    `json:"sample_requests"`
	CacheRate      *float64 `json:"cache_rate,omitempty"`
	Requests       int64    `json:"requests"`
	Tokens         int64    `json:"tokens"`
}

// WindowCapacity is the size of a whole quota window in the recorded workload's
// tokens and API-equivalent cost, with what is left of it at the reading.
type WindowCapacity struct {
	// Requests is how many requests of the recorded workload the window holds.
	Requests     int64  `json:"requests"`
	Tokens       int64  `json:"tokens"`
	Basis        string `json:"basis"`
	ObservedAtMS int64  `json:"observed_at_ms"`
	FromMS       int64  `json:"from_ms"`
	ResetAtMS    int64  `json:"reset_at_ms"`
	// CostNanos is nil when too much of the sample is unpriced to state a cost.
	CostNanos *int64 `json:"cost_nanos,omitempty"`
	// Remaining amounts are given only with a live reading of the used share.
	RemainingTokens    *int64 `json:"remaining_tokens,omitempty"`
	RemainingCostNanos *int64 `json:"remaining_cost_nanos,omitempty"`
	// Projection sizes the window using the credential's dominant recent model.
	Projection *ModelCapacityProjection `json:"projection,omitempty"`
	// ErrorPercent is the relative effect of upstream's whole-point rounding on
	// the estimate; the console rounds the figure to the digits it supports.
	ErrorPercent float64 `json:"error_percent"`
}

// ComputeCacheRate returns prompt cache reads as a percentage of prompt tokens,
// rounded to one decimal and bounded by maxDisplayedCacheRate, or nil when no
// prompt tokens were recorded.
func ComputeCacheRate(cachedTokens, promptTokens int64) *float64 {
	if promptTokens <= 0 {
		return nil
	}
	cached := min(max(cachedTokens, 0), promptTokens)
	rate := math.Round(float64(cached)/float64(promptTokens)*1000) / 10
	if rate > maxDisplayedCacheRate {
		rate = maxDisplayedCacheRate
	}
	return &rate
}

// SupportsWindowCapacity identifies supported global or model-metered windows.
// Scoped windows count only the models their families meter; a feature allowance
// has no model-only numerator and stays unsupported.
func SupportsWindowCapacity(provider string, window QuotaWindow) bool {
	if provider != "codex" && provider != "claude" && provider != "antigravity" {
		return false
	}
	if window.Scope == "model" || provider == "antigravity" && window.Scope == "group" {
		return true
	}
	if provider == "antigravity" || window.Scope != "standard" || window.Model != "" {
		return false
	}
	switch window.Kind {
	case "five_hour", "daily", "weekly", "monthly":
		return true
	}
	return window.ID == "five_hour" || window.ID == "seven_day"
}

// WindowCycleRange returns the half-open range of recorded usage that the
// window's used share accounts for. It ends at the observation rather than at
// "now": requests made after the reading are not part of the share it reports.
func WindowCycleRange(window QuotaWindow, observedAtMS, nowMS int64) (fromMS, toMS int64, reason string) {
	if window.ResetAtMS == nil || window.PeriodHours == nil || *window.PeriodHours <= 0 || math.IsNaN(*window.PeriodHours) || math.IsInf(*window.PeriodHours, 0) {
		return 0, 0, CapacityReasonBoundaryUnknown
	}
	if window.ResetAccuracy != "exact" && window.ResetAccuracy != "derived" && window.ResetAccuracy != "approximate" {
		return 0, 0, CapacityReasonBoundaryUnknown
	}
	resetAtMS := *window.ResetAtMS
	if resetAtMS <= nowMS {
		return 0, 0, CapacityReasonExpired
	}
	fromMS = resetAtMS - int64(*window.PeriodHours*3600*1000)
	toMS = min(observedAtMS, resetAtMS)
	if toMS <= fromMS {
		return 0, 0, CapacityReasonBoundaryUnknown
	}
	return fromMS, toMS, ""
}

// WindowUsedPercent also accepts providers that publish only the remaining share.
func WindowUsedPercent(window QuotaWindow) (float64, bool) {
	used := window.UsedPercent
	if used == nil && window.RemainingPercent != nil {
		value := 100 - *window.RemainingPercent
		used = &value
	}
	if used == nil || math.IsNaN(*used) || math.IsInf(*used, 0) || *used < 0 || *used > 100 {
		return 0, false
	}
	return *used, true
}

// AttachRemainingCapacity sizes what is left of the window from a live reading.
func AttachRemainingCapacity(capacity *WindowCapacity, window QuotaWindow, isLive bool) {
	if capacity == nil {
		return
	}
	capacity.RemainingTokens, capacity.RemainingCostNanos = nil, nil
	used, hasReading := WindowUsedPercent(window)
	if !isLive || !hasReading {
		return
	}
	remaining := (100 - used) / 100
	tokens := int64(math.Round(float64(capacity.Tokens) * remaining))
	capacity.RemainingTokens = &tokens
	if capacity.CostNanos != nil {
		cost := int64(math.Round(float64(*capacity.CostNanos) * remaining))
		capacity.RemainingCostNanos = &cost
	}
}

// AttachModelProjection attaches the dominant recent model's whole-window
// projection onto capacity.
func AttachModelProjection(capacity *WindowCapacity, window QuotaWindow, groups []ModelWindowUsage) {
	if capacity == nil {
		return
	}
	capacity.Projection = nil
	projections := BuildModelProjections(capacity, window, groups, nil, nil)
	if len(projections) > 0 {
		first := projections[0]
		capacity.Projection = &first
	}
}

// BuildModelProjections expresses the whole window's request and token capacity
// in terms of each in-scope model on the credential, using that model's
// observed per-request cost and token mix (or pricing rates for unused models).
func BuildModelProjections(
	capacity *WindowCapacity,
	window QuotaWindow,
	groups []ModelWindowUsage,
	candidateModels []string,
	prices map[string]ModelQuoteRate,
) []ModelCapacityProjection {
	if capacity == nil {
		return nil
	}

	scoped := FilterScopedModels(window, groups)
	var refReqs, refToks, refPrompt, refCached, refWrite, refOut float64
	var refMinInput, refMaxInput int64
	hasRefInputBounds := true
	hasFirstBounds := false
	refTier := ""
	isRefTierKnown := false
	hasFirstTier := false
	for _, g := range scoped {
		if !g.Usage.hasTokenBreakdown() {
			continue
		}
		refReqs += float64(g.Usage.Requests)
		refToks += float64(g.Usage.Tokens)
		refPrompt += float64(g.Usage.PromptTokens)
		refCached += float64(g.Usage.CachedTokens)
		refWrite += float64(g.Usage.CacheWriteTokens)
		refOut += float64(g.Usage.OutputTokens)
		if gMin, gMax, ok := g.Usage.inputBounds(); !ok {
			hasRefInputBounds = false
		} else if !hasFirstBounds {
			refMinInput, refMaxInput = gMin, gMax
			hasFirstBounds = true
		} else {
			refMinInput = min(refMinInput, gMin)
			refMaxInput = max(refMaxInput, gMax)
		}
		if g.Usage.HasMixedServiceTiers {
			isRefTierKnown = false
			hasFirstTier = true
		} else if !hasFirstTier {
			refTier = g.Usage.ServiceTier
			isRefTierKnown = true
			hasFirstTier = true
		} else if refTier != g.Usage.ServiceTier {
			isRefTierKnown = false
		}
	}
	if !hasFirstBounds {
		hasRefInputBounds = false
	}

	seen := make(map[string]bool, len(scoped)+len(candidateModels))
	out := make([]ModelCapacityProjection, 0, len(scoped)+len(candidateModels))

	add := func(model string, sampleReqs int64, cacheRate *float64, fullModelReqs, tokPerReq float64) {
		if fullModelReqs <= 0 || tokPerReq <= 0 || math.IsNaN(fullModelReqs) || math.IsInf(fullModelReqs, 0) {
			return
		}
		out = append(out, ModelCapacityProjection{
			Model:          model,
			SampleRequests: sampleReqs,
			CacheRate:      cacheRate,
			Requests:       int64(math.Round(fullModelReqs)),
			Tokens:         int64(math.Round(fullModelReqs * tokPerReq)),
		})
	}

	for _, g := range scoped {
		seen[strings.ToLower(g.Model)] = true
		reqs := float64(g.Usage.Requests)
		tokPerReq := float64(g.Usage.Tokens) / reqs
		fullReqs := 0.0
		if capacity.CostNanos != nil && *capacity.CostNanos > 0 {
			if rate, ok := lookupModelRate(prices, g.Model); ok && g.Usage.hasTokenBreakdown() {
				p := float64(g.Usage.PromptTokens) / reqs
				c := float64(g.Usage.CachedTokens) / reqs
				w := float64(g.Usage.CacheWriteTokens) / reqs
				o := float64(g.Usage.OutputTokens) / reqs
				gMin, gMax, hasBounds := g.Usage.inputBounds()
				if costPerReq, quoted := rate.quoteNanos(p, c, w, o, hasBounds, gMin, gMax, false, !g.Usage.HasMixedServiceTiers, g.Usage.ServiceTier); quoted {
					fullReqs = float64(*capacity.CostNanos) / costPerReq
				}
			}
			if fullReqs <= 0 && g.Usage.PricedRequests > 0 && g.Usage.CostNanos > 0 {
				switch {
				case float64(g.Usage.PricedRequests) >= reqs*capacityCleanPricedShare:
					fullReqs = float64(*capacity.CostNanos) / (float64(g.Usage.CostNanos) / reqs)
				case g.Usage.Tokens > 0 && g.Usage.PricedTokens > 0 && float64(g.Usage.PricedTokens) >= float64(g.Usage.Tokens)*capacityMinImputedShare:
					costSum := float64(g.Usage.CostNanos) * float64(g.Usage.Tokens) / float64(g.Usage.PricedTokens)
					fullReqs = float64(*capacity.CostNanos) / (costSum / reqs)
				}
			}
		}
		if fullReqs <= 0 && tokPerReq > 0 {
			fullReqs = float64(capacity.Tokens) / tokPerReq
		}
		add(g.Model, g.Usage.Requests, ComputeCacheRate(g.Usage.CachedTokens, g.Usage.PromptTokens), fullReqs, tokPerReq)
	}

	if capacity.CostNanos != nil && *capacity.CostNanos > 0 && len(prices) > 0 && refReqs > 0 {
		avgTok := refToks / refReqs
		avgPrompt := refPrompt / refReqs
		avgCached := refCached / refReqs
		avgWrite := refWrite / refReqs
		avgOut := refOut / refReqs
		refCacheRate := ComputeCacheRate(int64(math.Round(avgCached)), int64(math.Round(avgPrompt)))

		candidates := make([]string, 0, len(candidateModels))
		for _, raw := range candidateModels {
			name := strings.TrimSpace(raw)
			key := strings.ToLower(name)
			if name == "" || key == "unknown" || seen[key] || !IsModelInWindowScope(window, name) {
				continue
			}
			if _, ok := lookupModelRate(prices, name); ok {
				seen[key] = true
				candidates = append(candidates, name)
			}
		}
		for i := 1; i < len(candidates); i++ {
			for j := i; j > 0 && candidates[j] < candidates[j-1]; j-- {
				candidates[j], candidates[j-1] = candidates[j-1], candidates[j]
			}
		}
		for _, name := range candidates {
			rate, _ := lookupModelRate(prices, name)
			if costPerReq, quoted := rate.quoteNanos(avgPrompt, avgCached, avgWrite, avgOut, hasRefInputBounds, refMinInput, refMaxInput, true, isRefTierKnown, refTier); quoted {
				add(name, 0, refCacheRate, float64(*capacity.CostNanos)/costPerReq, avgTok)
			}
		}
	}
	return out
}

func lookupModelRate(prices map[string]ModelQuoteRate, model string) (ModelQuoteRate, bool) {
	if len(prices) == 0 {
		return ModelQuoteRate{}, false
	}
	if rate, ok := prices[model]; ok {
		return rate, true
	}
	if norm := normalizeCapacityModel(model); norm != "" {
		if rate, ok := prices[norm]; ok {
			return rate, true
		}
	}
	return ModelQuoteRate{}, false
}
