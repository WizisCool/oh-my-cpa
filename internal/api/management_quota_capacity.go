package api

import (
	"context"
	"encoding/json"
	"net/http"
	"slices"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/oh-my-cpa/oh-my-cpa/internal/quota"
)

func (h *Handler) resolveCurrentCycleUsage(
	ctx context.Context,
	authIndex string,
	window quota.QuotaWindow,
	plan *quota.QuotaPlan,
	observedAtMS, fromMS, toMS int64,
	reconciledCycles []quota.CycleCalibration,
) (quota.WindowUsage, string, error) {
	live, scopeReason, err := h.repo.QueryCapacityUsage(ctx, authIndex, window, fromMS, toMS)
	if err != nil || scopeReason != "" {
		return quota.WindowUsage{}, scopeReason, err
	}
	effective := quota.EffectiveWindowUsage(window, plan, observedAtMS, live, reconciledCycles)
	if latest, ok := quota.LatestLiveCalibrationPoint(window, plan, observedAtMS, reconciledCycles); ok {
		fromPoint := quota.WindowUsage{
			FromMS:            fromMS,
			ToMS:              toMS,
			Requests:          latest.Requests,
			PricedRequests:    latest.PricedRequests,
			Tokens:            latest.Tokens,
			PromptTokens:      latest.PromptTokens,
			CachedTokens:      latest.CachedTokens,
			CacheRate:         quota.ComputeCacheRate(latest.CachedTokens, latest.PromptTokens),
			CostNanos:         latest.CostNanos,
			UnmatchedRequests: latest.UnmatchedRequests,
		}
		if latest.ObservedAtMS < toMS {
			if postPoint, reason, postErr := h.repo.QueryCapacityUsageSinceCycleStart(ctx, authIndex, window, fromMS, max(fromMS, latest.ObservedAtMS), toMS); postErr == nil && reason == "" {
				fromPoint = quota.AddWindowUsage(fromPoint, postPoint)
			}
		}
		if fromPoint.Requests > effective.Requests {
			effective = fromPoint
		}
	}
	return effective, "", nil
}

// Native quota readings stay authoritative; recorded usage and estimated full
// window capacity are attached at read time without mutating shared window slices.
func (h *Handler) attachQuotaCapacity(ctx context.Context, observation *quota.NormalizedQuota, nowMS int64) {
	if h.repo == nil || observation == nil {
		return
	}
	observation.Windows = slices.Clone(observation.Windows)
	var cycles map[string][]quota.CycleCalibration
	var cyclesErr error
	hasLoadedCycles := false
	loadCycles := func() bool {
		if !hasLoadedCycles {
			cycles, cyclesErr = h.repo.LoadCapacityCycles(ctx, observation.AuthIndex)
			hasLoadedCycles = true
		}
		return cyclesErr == nil
	}
	for index := range observation.Windows {
		window := &observation.Windows[index]
		window.Usage, window.Capacity, window.CapacityUnavailable = nil, nil, ""
		if !quota.SupportsWindowCapacity(observation.Provider, *window) {
			continue
		}
		windowKey := quota.CapacityWindowKey(observation.Provider, *window)
		var windowCycles []quota.CycleCalibration
		if loadCycles() {
			windowCycles = h.repo.ReconcileLiveCycleForRead(ctx, observation.AuthIndex, *window, observation.Plan, observation.ObservedAtMS, cycles[windowKey])
		}
		if fromMS, toMS, reason := quota.WindowCycleRange(*window, observation.ObservedAtMS, observation.ObservedAtMS); reason == "" {
			usage, scopeReason, err := h.resolveCurrentCycleUsage(ctx, observation.AuthIndex, *window, observation.Plan, observation.ObservedAtMS, fromMS, toMS, windowCycles)
			if err != nil {
				window.CapacityUnavailable = quota.CapacityReasonUsageUnavailable
			} else if scopeReason != "" {
				window.CapacityUnavailable = scopeReason
			} else {
				window.Usage = &usage
			}
		}
		if window.CapacityUnavailable != "" {
			continue
		}
		if _, _, reason := quota.WindowCycleRange(*window, observation.ObservedAtMS, nowMS); reason != "" {
			window.CapacityUnavailable = reason
			continue
		}
		if observation.Status == "stale" || observation.Status == "error" || observation.Error != "" || observation.Disabled || observation.HasFailedRead {
			window.CapacityUnavailable = quota.CapacityReasonNoReading
			continue
		}
		if !loadCycles() {
			window.CapacityUnavailable = quota.CapacityReasonHistoryUnavailable
			continue
		}
		estimateUsage := window.Usage
		if cutoff, _, ok := quota.ExhaustionCutoffPoint(*window, observation.Plan, observation.ObservedAtMS, windowCycles); ok && estimateUsage != nil && cutoff.ObservedAtMS < observation.ObservedAtMS && cutoff.ObservedAtMS > estimateUsage.FromMS {
			preFull := quota.WindowUsage{
				FromMS:            estimateUsage.FromMS,
				ToMS:              cutoff.ObservedAtMS,
				Requests:          cutoff.Requests,
				PricedRequests:    cutoff.PricedRequests,
				Tokens:            cutoff.Tokens,
				PromptTokens:      cutoff.PromptTokens,
				CachedTokens:      cutoff.CachedTokens,
				CacheRate:         quota.ComputeCacheRate(cutoff.CachedTokens, cutoff.PromptTokens),
				CostNanos:         cutoff.CostNanos,
				UnmatchedRequests: cutoff.UnmatchedRequests,
			}
			if livePreFull, scopeReason, err := h.repo.QueryCapacityUsage(ctx, observation.AuthIndex, *window, estimateUsage.FromMS, cutoff.ObservedAtMS); err == nil && scopeReason == "" && livePreFull.Requests > preFull.Requests {
				preFull = livePreFull
			}
			estimateUsage = &preFull
		}
		window.Capacity, window.CapacityUnavailable = quota.EstimateWindowCapacity(
			*window,
			observation.Plan,
			observation.ObservedAtMS,
			nowMS,
			estimateUsage,
			windowCycles,
		)
	}
}

type capacityCycleDTO struct {
	FromMS      int64              `json:"from_ms"`
	ResetAtMS   int64              `json:"reset_at_ms"`
	UsedPercent *float64           `json:"used_percent,omitempty"`
	Usage       *quota.WindowUsage `json:"usage,omitempty"`
}

// getQuotaCapacityHistory returns recorded consumption for the current and
// previous cycles alongside the window's estimated full capacity.
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
		writeError(writer, http.StatusNotFound, "the credential has no observable window "+strconv.Quote(windowID))
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
	windowCycles := h.repo.ReconcileLiveCycleForRead(ctx, authIndex, window, plan, snapshot.ObservedAtMS, cycles[windowKey])
	previous := quota.PreviousCapacityCycle(window, plan, snapshot.ObservedAtMS, windowCycles)

	response := map[string]any{"window_id": window.ID, "current": nil, "previous": nil}
	var currentFromMS *int64
	if fromMS, toMS, reason := quota.WindowCycleRange(window, snapshot.ObservedAtMS, snapshot.ObservedAtMS); reason == "" {
		currentFromMS = &fromMS
		current := capacityCycleDTO{FromMS: fromMS, ResetAtMS: *window.ResetAtMS}
		if used, hasReading := quota.WindowUsedPercent(window); hasReading {
			current.UsedPercent = &used
		}
		if usage, scopeReason, err := h.resolveCurrentCycleUsage(ctx, authIndex, window, plan, snapshot.ObservedAtMS, fromMS, toMS, windowCycles); err == nil && scopeReason == "" {
			current.Usage = &usage
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

	observation := normalizedQuotaFromSnapshot(authIndex, snapshot)
	attempts := h.lastQuotaAttempts(ctx, []string{authIndex})
	quota.ApplyReadingHealth(observation, quotaAttemptOf(attempts[authIndex]), true, h.now().UnixMilli())
	h.attachQuotaCapacity(ctx, observation, h.now().UnixMilli())
	result := observation.Windows[index]
	if result.Capacity != nil {
		response["capacity"] = result.Capacity
	}
	if result.CapacityUnavailable != "" {
		response["capacity_unavailable"] = result.CapacityUnavailable
	}
	writeJSON(writer, http.StatusOK, response)
}
