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

// Native quota readings and recorded usage stay separate from model-conditioned
// forecasts. Failed reads may share their window slice with the previous reading.
func (h *Handler) attachQuotaForecasts(ctx context.Context, observation *quota.NormalizedQuota, nowMS int64) {
	if h.repo == nil || observation == nil {
		return
	}
	observation.Windows = slices.Clone(observation.Windows)
	var cycles map[string][]quota.CycleCalibration
	var cyclesErr error
	hasLoadedCycles := false
	for index := range observation.Windows {
		window := &observation.Windows[index]
		window.Usage, window.ModelForecasts, window.ForecastUnavailable = nil, nil, ""
		if !quota.SupportsWindowCapacity(observation.Provider, *window) {
			continue
		}
		if fromMS, toMS, reason := quota.WindowCycleRange(*window, observation.ObservedAtMS, observation.ObservedAtMS); reason == "" {
			usage, scopeReason, err := h.repo.QueryCapacityUsage(ctx, observation.AuthIndex, *window, fromMS, toMS)
			if err != nil {
				window.ForecastUnavailable = quota.CapacityReasonUsageUnavailable
			} else if scopeReason != "" {
				window.ForecastUnavailable = scopeReason
			} else {
				window.Usage = &usage
			}
		}
		if window.ForecastUnavailable != "" {
			continue
		}
		if _, _, reason := quota.WindowCycleRange(*window, observation.ObservedAtMS, nowMS); reason != "" {
			window.ForecastUnavailable = reason
			continue
		}
		if observation.Status == "stale" || observation.Status == "error" || observation.Error != "" || observation.Disabled || observation.HasFailedRead {
			window.ForecastUnavailable = quota.CapacityReasonNoReading
			continue
		}
		if !hasLoadedCycles {
			cycles, cyclesErr = h.repo.LoadCapacityCycles(ctx, observation.AuthIndex)
			hasLoadedCycles = true
		}
		if cyclesErr != nil {
			window.ForecastUnavailable = quota.CapacityReasonHistoryUnavailable
			continue
		}
		window.ModelForecasts, window.ForecastUnavailable = quota.BuildModelForecasts(*window, observation.Plan, observation.ObservedAtMS, cycles[quota.CapacityWindowKey(observation.Provider, *window)])
	}
}

type capacityCycleDTO struct {
	FromMS      int64              `json:"from_ms"`
	ResetAtMS   int64              `json:"reset_at_ms"`
	UsedPercent *float64           `json:"used_percent,omitempty"`
	Usage       *quota.WindowUsage `json:"usage,omitempty"`
}

// getQuotaCapacityHistory returns recorded consumption for two cycles and
// forecasts supported by direct single-model observations in the current cycle.
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
	previous := quota.PreviousCapacityCycle(window, plan, snapshot.ObservedAtMS, cycles[windowKey])

	response := map[string]any{"window_id": window.ID, "current": nil, "previous": nil}
	var currentFromMS *int64
	if fromMS, toMS, reason := quota.WindowCycleRange(window, snapshot.ObservedAtMS, snapshot.ObservedAtMS); reason == "" {
		currentFromMS = &fromMS
		current := capacityCycleDTO{FromMS: fromMS, ResetAtMS: *window.ResetAtMS}
		if used, hasReading := quota.WindowUsedPercent(window); hasReading {
			current.UsedPercent = &used
		}
		if usage, scopeReason, err := h.repo.QueryCapacityUsage(ctx, authIndex, window, fromMS, toMS); err == nil && scopeReason == "" {
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
	h.attachQuotaForecasts(ctx, observation, h.now().UnixMilli())
	result := observation.Windows[index]
	if len(result.ModelForecasts) > 0 {
		response["model_forecasts"] = result.ModelForecasts
	}
	if result.ForecastUnavailable != "" {
		response["forecast_unavailable"] = result.ForecastUnavailable
	}
	writeJSON(writer, http.StatusOK, response)
}
