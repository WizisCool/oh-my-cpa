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
		// What the cycle has recorded so far is shown while there is no estimate.
		usageReason := ""
		if fromMS, toMS, reason := quota.WindowCycleRange(*window, observation.ObservedAtMS, observation.ObservedAtMS); reason == "" {
			usage, scopeReason, err := h.repo.QueryCapacityUsage(ctx, observation.AuthIndex, *window, fromMS, toMS)
			switch {
			case err != nil:
				usageReason = quota.CapacityReasonUsageUnavailable
			case scopeReason != "":
				usageReason = scopeReason
			default:
				window.Usage = &usage
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
		window.Capacity = capacity
	}
}

// capacityCycleDTO is one cycle of a window as the capacity details state it:
// its span, its latest share and what this gateway recorded in it.
type capacityCycleDTO struct {
	FromMS      int64              `json:"from_ms"`
	ResetAtMS   int64              `json:"reset_at_ms"`
	UsedPercent *float64           `json:"used_percent,omitempty"`
	Usage       *quota.WindowUsage `json:"usage,omitempty"`
}

// getQuotaCapacityHistory answers the capacity details of one window from local
// evidence alone: the cycle the latest reading belongs to and the one before it.
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
	previous := quota.PreviousCapacityCycle(window, snapshot.ObservedAtMS, cycles[quota.CapacityWindowKey(snapshot.Provider, window)])

	response := map[string]any{"window_id": window.ID, "current": nil, "previous": nil}
	if fromMS, toMS, reason := quota.WindowCycleRange(window, snapshot.ObservedAtMS, snapshot.ObservedAtMS); reason == "" {
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
		cycle := capacityCycleDTO{FromMS: previous.CycleStartMS(), ResetAtMS: previous.CycleResetAtMS, UsedPercent: &last.UsedPercent}
		// Records retention removed are still counted up to the cycle's last change.
		usage := quota.WindowUsage{FromMS: cycle.FromMS, ToMS: cycle.ResetAtMS, Requests: last.Requests, PricedRequests: last.PricedRequests, Tokens: last.Tokens, CostNanos: last.CostNanos}
		if recorded, scopeReason, err := h.repo.QueryCapacityUsage(ctx, authIndex, window, cycle.FromMS, cycle.ResetAtMS); err == nil && scopeReason == "" && recorded.Requests >= usage.Requests {
			usage = recorded
		}
		cycle.Usage = &usage
		response["previous"] = cycle
	}
	writeJSON(writer, http.StatusOK, response)
}
