package api

import (
	"context"
	"encoding/json"
	"net/http"
	"slices"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/oh-my-cpa/oh-my-cpa/internal/pricing"
	"github.com/oh-my-cpa/oh-my-cpa/internal/quota"
)

// Estimates are read-time joins over the stored cycle evidence, which only a
// saved reading that moves the used share changes. A failed refresh can share
// the prior windows, so replace the slice rather than writing estimates into the
// stored reading.
func (h *Handler) attachWindowCapacity(ctx context.Context, observation *quota.NormalizedQuota, nowMS int64) {
	if h.repo == nil || observation == nil || len(observation.Windows) == 0 {
		return
	}
	windows := slices.Clone(observation.Windows)
	observation.Windows = windows
	var cycles map[string][]quota.CycleCalibration
	var cyclesErr error
	hasLoadedCycles := false
	var lookbackCache map[int64][]quota.ModelWindowUsage
	for i := range windows {
		window := &windows[i]
		window.Usage, window.Capacity, window.CapacityUnavailable = nil, nil, ""
		if !quota.SupportsWindowCapacity(observation.Provider, *window) {
			continue
		}
		if !hasLoadedCycles {
			cycles, cyclesErr = h.repo.LoadCapacityCycles(ctx, observation.AuthIndex)
			hasLoadedCycles = true
		}
		usageReason := ""
		var cycleGroups []quota.ModelWindowUsage
		if fromMS, toMS, reason := quota.WindowCycleRange(*window, observation.ObservedAtMS, observation.ObservedAtMS); reason == "" {
			usage, groups, scopeReason, err := h.repo.QueryCapacityUsageWithModels(ctx, observation.AuthIndex, *window, fromMS, toMS)
			switch {
			case err != nil:
				usageReason = quota.CapacityReasonUsageUnavailable
			case scopeReason != "":
				usageReason = scopeReason
			default:
				window.Usage = &usage
				cycleGroups = groups
			}
		}
		if cyclesErr != nil {
			window.CapacityUnavailable = quota.CapacityReasonHistoryUnavailable
			continue
		}
		capacity, reason := quota.EstimateWindowCapacity(*window, observation.Plan, observation.ObservedAtMS, cycles[quota.CapacityWindowKey(observation.Provider, *window)])
		if capacity == nil {
			if usageReason != "" {
				reason = usageReason
			}
			window.CapacityUnavailable = reason
			continue
		}
		isLive := observation.Status != "stale" && observation.Status != "error" && observation.Error == "" && !observation.Disabled && (window.ResetAtMS == nil || *window.ResetAtMS > nowMS)
		quota.AttachRemainingCapacity(capacity, *window, isLive)
		projectionGroups := cycleGroups
		if dominant, ok := quota.SelectDominantModelUsage(*window, projectionGroups); !ok || dominant.Usage.Requests < 5 {
			horizonMS := recentProjectionHorizonMS(*window)
			recentGroups, cached := lookbackCache[horizonMS]
			if !cached {
				if lookbackCache == nil {
					lookbackCache = make(map[int64][]quota.ModelWindowUsage, 2)
				}
				_, loaded, _, err := h.repo.QueryCapacityUsageWithModels(
					ctx,
					observation.AuthIndex,
					quota.QuotaWindow{ID: "lookback", Scope: "standard"},
					observation.ObservedAtMS-horizonMS,
					observation.ObservedAtMS,
				)
				if err == nil {
					recentGroups = loaded
				}
				lookbackCache[horizonMS] = recentGroups
			}
			if _, hasScoped := quota.SelectDominantModelUsage(*window, recentGroups); hasScoped {
				projectionGroups = recentGroups
			}
		}
		quota.AttachModelProjection(capacity, *window, projectionGroups)
		window.Capacity = capacity
	}
}

func recentProjectionHorizonMS(window quota.QuotaWindow) int64 {
	const (
		hourMS = int64(3600 * 1000)
		minMS  = 24 * hourMS
		maxMS  = 7 * 24 * hourMS
	)
	if window.PeriodHours == nil || *window.PeriodHours <= 0 {
		return minMS
	}
	span := int64(*window.PeriodHours * 2 * float64(hourMS))
	return min(max(span, minMS), maxMS)
}

type capacityCycleDTO struct {
	FromMS      int64              `json:"from_ms"`
	ResetAtMS   int64              `json:"reset_at_ms"`
	UsedPercent *float64           `json:"used_percent,omitempty"`
	Usage       *quota.WindowUsage `json:"usage,omitempty"`
}

// getQuotaCapacityHistory answers the capacity details of one window from local
// evidence alone: the cycle the latest reading belongs to, the one before it,
// and per-model whole-window projections if the remaining allowance is spent on
// a chosen model.
func (h *Handler) getQuotaCapacityHistory(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	authIndex := strings.TrimSpace(chi.URLParam(request, "authIndex"))
	windowID := strings.TrimSpace(request.URL.Query().Get("window"))
	if authIndex == "" || windowID == "" {
		writeError(writer, http.StatusBadRequest, "auth_index and window are required")
		return
	}
	if h.repo == nil {
		writeError(writer, http.StatusServiceUnavailable, "repository is not initialized")
		return
	}
	ctx := request.Context()
	snapshots, err := h.repo.GetLatestQuotaSnapshots(ctx, []string{authIndex})
	if err != nil {
		writeError(writer, http.StatusInternalServerError, "quota reading could not be read")
		return
	}
	snapshot, ok := snapshots[authIndex]
	var windows []quota.QuotaWindow
	if ok {
		_ = json.Unmarshal([]byte(snapshot.WindowsJSON), &windows)
	}
	index := slices.IndexFunc(windows, func(window quota.QuotaWindow) bool { return window.ID == windowID })
	if index < 0 || !quota.SupportsWindowCapacity(snapshot.Provider, windows[index]) {
		writeError(writer, http.StatusNotFound, "the credential has no estimated window "+strconv.Quote(windowID))
		return
	}
	window := windows[index]
	cycles, err := h.repo.LoadCapacityCycles(ctx, authIndex)
	if err != nil {
		writeError(writer, http.StatusInternalServerError, "capacity evidence could not be read")
		return
	}
	var plan *quota.QuotaPlan
	if snapshot.PlanJSON != "" {
		var parsed quota.QuotaPlan
		if json.Unmarshal([]byte(snapshot.PlanJSON), &parsed) == nil {
			plan = &parsed
		}
	}
	if plan == nil && (snapshot.PlanType != "" || snapshot.PlanTier != "") {
		plan = &quota.QuotaPlan{PlanType: snapshot.PlanType, Tier: snapshot.PlanTier}
	}

	windowKey := quota.CapacityWindowKey(snapshot.Provider, window)
	previous := quota.PreviousCapacityCycle(window, plan, snapshot.ObservedAtMS, cycles[windowKey])

	response := map[string]any{"window_id": window.ID, "current": nil, "previous": nil}
	var currentGroups []quota.ModelWindowUsage
	var currentFromMS *int64
	if fromMS, toMS, reason := quota.WindowCycleRange(window, snapshot.ObservedAtMS, snapshot.ObservedAtMS); reason == "" {
		currentFromMS = &fromMS
		current := capacityCycleDTO{FromMS: fromMS, ResetAtMS: *window.ResetAtMS}
		if used, hasReading := quota.WindowUsedPercent(window); hasReading {
			current.UsedPercent = &used
		}
		if usage, groups, scopeReason, err := h.repo.QueryCapacityUsageWithModels(ctx, authIndex, window, fromMS, toMS); err == nil && scopeReason == "" {
			current.Usage = &usage
			currentGroups = groups
		}
		response["current"] = current
	}
	if previous != nil && len(previous.Points) > 0 {
		last := previous.Points[len(previous.Points)-1]
		resetAtMS := previous.CycleResetAtMS
		if currentFromMS != nil && resetAtMS > *currentFromMS {
			resetAtMS = *currentFromMS
		}
		measuredToMS := min(last.ObservedAtMS, resetAtMS)
		cycle := capacityCycleDTO{FromMS: previous.CycleStartMS(), ResetAtMS: resetAtMS, UsedPercent: &last.UsedPercent}
		usage := quota.WindowUsage{
			FromMS:         cycle.FromMS,
			ToMS:           measuredToMS,
			Requests:       last.Requests,
			PricedRequests: last.PricedRequests,
			Tokens:         last.Tokens,
			PromptTokens:   last.PromptTokens,
			CachedTokens:   last.CachedTokens,
			CacheRate:      quota.ComputeCacheRate(last.CachedTokens, last.PromptTokens),
			CostNanos:      last.CostNanos,
		}
		if measuredToMS > cycle.FromMS {
			if recorded, scopeReason, err := h.repo.QueryCapacityUsage(ctx, authIndex, window, cycle.FromMS, measuredToMS); err == nil && scopeReason == "" && recorded.Requests >= usage.Requests {
				usage = recorded
			}
		}
		cycle.Usage = &usage
		response["previous"] = cycle
	}

	if capacity, _ := quota.EstimateWindowCapacity(window, plan, snapshot.ObservedAtMS, cycles[windowKey]); capacity != nil {
		projectionGroups := currentGroups
		if dominant, hasDom := quota.SelectDominantModelUsage(window, projectionGroups); !hasDom || dominant.Usage.Requests < 5 {
			lookbackFrom := snapshot.ObservedAtMS - recentProjectionHorizonMS(window)
			if _, recentGroups, scopeReason, err := h.repo.QueryCapacityUsageWithModels(ctx, authIndex, window, lookbackFrom, snapshot.ObservedAtMS); err == nil && scopeReason == "" && len(recentGroups) > 0 {
				projectionGroups = recentGroups
			}
		}
		prices := h.loadCapacityModelRates(ctx, snapshot.Provider, snapshot.ObservedAtMS)
		candidates := h.loadCapacityCandidateModels(ctx, snapshot.Provider)
		if projections := quota.BuildModelProjections(capacity, window, projectionGroups, candidates, prices); len(projections) > 0 {
			response["model_projections"] = projections
		}
	}
	writeJSON(writer, http.StatusOK, response)
}

func (h *Handler) loadCapacityModelRates(ctx context.Context, provider string, quoteAtMS int64) map[string]quota.ModelQuoteRate {
	rates := make(map[string]quota.ModelQuoteRate)
	if h.repo == nil {
		return rates
	}
	channelMultiplier := 1.0
	if channels, err := h.repo.ListChannelMultipliers(ctx); err == nil {
		for _, ch := range channels {
			if strings.EqualFold(ch.Channel, provider) && ch.Multiplier > 0 {
				channelMultiplier = ch.Multiplier
				break
			}
		}
	}
	toRate := func(price pricing.ModelPrice) quota.ModelQuoteRate {
		return quota.ModelQuoteRate{
			Price:             price,
			ChannelMultiplier: channelMultiplier,
			QuoteAtMS:         quoteAtMS,
		}
	}
	sharedPrices, _ := h.repo.ListModelPrices(ctx)
	sharedByModel := make(map[string]quota.ModelQuoteRate, len(sharedPrices))
	for _, row := range sharedPrices {
		rate := toRate(row)
		sharedByModel[row.Model] = rate
		rates[row.Model] = rate
	}
	if catalog, err := h.repo.ListPricingModels(ctx); err == nil {
		for served, target := range catalog {
			if _, hasDirect := rates[served]; !hasDirect && target != "" {
				if rate, ok := sharedByModel[target]; ok {
					rates[served] = rate
				}
			}
		}
	}
	if channelPrices, err := h.repo.ListChannelModelPrices(ctx); err == nil {
		for _, row := range channelPrices {
			if strings.EqualFold(row.Channel, provider) {
				rates[row.Model] = toRate(row)
			}
		}
	}
	return rates
}

func (h *Handler) loadCapacityCandidateModels(ctx context.Context, provider string) []string {
	seen := make(map[string]bool)
	var models []string
	add := func(name string) {
		name = strings.TrimSpace(name)
		if name != "" && !seen[name] {
			seen[name] = true
			models = append(models, name)
		}
	}
	h.warmupRuntime.mu.Lock()
	if cached, ok := h.warmupRuntime.models[provider]; ok {
		for _, m := range cached.models {
			add(m)
		}
	}
	h.warmupRuntime.mu.Unlock()

	if h.repo != nil {
		if providers, err := h.repo.ListPricingProviders(ctx); err == nil {
			for _, item := range providers {
				if strings.EqualFold(item.Channel, provider) || strings.EqualFold(item.Family, provider) {
					for _, m := range item.Models {
						add(m)
					}
				}
			}
		}
	}
	return models
}
