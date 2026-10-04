package api

import (
	"context"
	"encoding/json"
	"fmt"
	"slices"

	"github.com/oh-my-cpa/oh-my-cpa/internal/quota"
)

const capacityHistoryDepth = 50

// attachWindowCapacity replaces the slice because failed refreshes can share
// windows with a prior observation. Estimates are read-time joins, not snapshots.
func (h *Handler) attachWindowCapacity(ctx context.Context, observation *quota.NormalizedQuota, nowMS int64) {
	if h.repo == nil || observation == nil || len(observation.Windows) == 0 {
		return
	}
	windows := append([]quota.QuotaWindow(nil), observation.Windows...)
	observation.Windows = windows
	var history []quota.ObservedWindows
	var historyErr error
	hasLoadedHistory := false
	for i := range windows {
		window := &windows[i]
		window.Usage, window.Capacity, window.CapacityUnavailable = nil, nil, ""
		if !quota.SupportsWindowCapacity(observation.Provider, *window) {
			continue
		}
		if observation.Status == "stale" || observation.Status == "error" || observation.Error != "" || observation.Disabled {
			window.CapacityUnavailable = quota.CapacityReasonStale
			continue
		}
		fromMS, toMS, reason := quota.WindowCycleRange(*window, observation.ObservedAtMS, nowMS)
		if reason != "" {
			window.CapacityUnavailable = reason
			continue
		}
		if !hasLoadedHistory {
			history, historyErr = h.loadObservedWindows(ctx, observation.AuthIndex, observation.Provider)
			hasLoadedHistory = true
		}
		if historyErr != nil {
			window.CapacityUnavailable = quota.CapacityReasonHistoryUnavailable
			continue
		}
		usage, reason := h.queryCapacityUsage(ctx, observation.AuthIndex, *window, fromMS, toMS)
		if reason != "" {
			window.CapacityUnavailable = reason
			continue
		}
		window.Usage = &usage
		checkedWindow := *window
		checkedWindow.HasIncompleteHistory = quota.HasIncompleteWindowHistory(*window, history, fromMS, toMS)
		checkedWindow.HasMidCycleReset = quota.HasWindowCycleReset(*window, history, fromMS, toMS)
		window.Capacity, window.CapacityUnavailable = quota.EstimateWindowCapacity(checkedWindow, usage, nil)
		if window.Capacity != nil {
			continue
		}
		switch window.CapacityUnavailable {
		case quota.CapacityReasonLowUsage, quota.CapacityReasonNoTraffic, quota.CapacityReasonNoReading:
		default:
			continue
		}
		previous, previousAtMS, hasPrevious := quota.PreviousWindowObservation(*window, history, observation.ObservedAtMS, nowMS)
		if !hasPrevious {
			continue
		}
		previousFromMS, previousToMS, previousReason := quota.WindowCycleRange(previous, previousAtMS, previousAtMS)
		if previousReason != "" {
			continue
		}
		previousUsage, previousReason := h.queryCapacityUsage(ctx, observation.AuthIndex, previous, previousFromMS, previousToMS)
		if previousReason != "" {
			continue
		}
		capacity, previousReason := quota.EstimateWindowCapacity(previous, previousUsage, nil)
		if previousReason != "" {
			continue
		}
		capacity.Basis = "previous_cycle"
		window.Capacity = capacity
	}
}

func (h *Handler) queryCapacityUsage(ctx context.Context, authIndex string, window quota.QuotaWindow, fromMS, toMS int64) (quota.WindowUsage, string) {
	if window.Scope == "model" || window.Scope == "group" {
		recorded, err := h.repo.QueryCredentialModelWindowUsage(ctx, authIndex, fromMS, toMS)
		if err != nil {
			return quota.WindowUsage{}, quota.CapacityReasonUsageUnavailable
		}
		groups := make([]quota.ModelWindowUsage, 0, len(recorded))
		for _, group := range recorded {
			groups = append(groups, quota.ModelWindowUsage{Model: group.Model, Usage: quota.WindowUsage{Requests: group.Requests, PricedRequests: group.PricedRequests, Tokens: group.Tokens, CostNanos: group.CostNanos}})
		}
		usage, reason := quota.SelectWindowUsage(window, groups)
		usage.FromMS, usage.ToMS = fromMS, toMS
		return usage, reason
	}
	recorded, err := h.repo.QueryCredentialWindowUsage(ctx, authIndex, fromMS, toMS)
	if err != nil {
		return quota.WindowUsage{}, quota.CapacityReasonUsageUnavailable
	}
	return quota.WindowUsage{FromMS: fromMS, ToMS: toMS, Requests: recorded.Requests, PricedRequests: recorded.PricedRequests, Tokens: recorded.Tokens, CostNanos: recorded.CostNanos}, ""
}

func (h *Handler) loadObservedWindows(ctx context.Context, authIndex, provider string) ([]quota.ObservedWindows, error) {
	records, err := h.repo.GetQuotaSnapshotHistory(ctx, authIndex, capacityHistoryDepth)
	if err != nil {
		return nil, err
	}
	history := make([]quota.ObservedWindows, 0, len(records))
	for _, record := range records {
		if record.Provider != provider || record.Status == "error" || record.Status == "stale" {
			continue
		}
		var windows []quota.QuotaWindow
		if err := json.Unmarshal([]byte(record.WindowsJSON), &windows); err != nil {
			return nil, fmt.Errorf("decode quota capacity history: %w", err)
		}
		history = append(history, quota.ObservedWindows{ObservedAtMS: record.ObservedAtMS, Windows: windows})
	}
	slices.Reverse(history)
	return history, nil
}
