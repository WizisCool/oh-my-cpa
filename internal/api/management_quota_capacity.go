package api

import (
	"context"
	"encoding/json"

	"github.com/oh-my-cpa/oh-my-cpa/internal/quota"
)

// capacityHistoryDepth covers every snapshot a credential keeps, so an earlier
// reading of the current cycle cannot fall outside the mid-cycle reset check.
const capacityHistoryDepth = 50

// attachWindowCapacity joins recorded usage onto the windows of one quota and
// derives each window's estimated capacity. It runs when a quota is read, after
// any snapshot has been persisted, and replaces the window slice rather than
// editing it, because a refresh that failed still shares its windows with the
// prior observation.
func (h *Handler) attachWindowCapacity(ctx context.Context, q *quota.NormalizedQuota, nowMS int64) {
	if h.repo == nil || q == nil || len(q.Windows) == 0 {
		return
	}
	windows := make([]quota.QuotaWindow, len(q.Windows))
	copy(windows, q.Windows)
	q.Windows = windows

	var history []quota.ObservedWindows
	isHistoryLoaded := false
	for i := range windows {
		window := &windows[i]
		window.Usage, window.Capacity, window.CapacityUnavailable = nil, nil, ""
		if !quota.SupportsWindowCapacity(q.Provider, *window) {
			continue
		}
		// A failed or skipped refresh returns the prior windows stamped with the
		// time of the attempt, so the moment their used share was read is unknown.
		if q.Status == "stale" || q.Disabled {
			window.CapacityUnavailable = quota.CapacityReasonStale
			continue
		}
		fromMS, toMS, reason := quota.WindowCycleRange(*window, q.ObservedAtMS, nowMS)
		if reason != "" {
			window.CapacityUnavailable = reason
			continue
		}
		recorded, err := h.repo.QueryCredentialWindowUsage(ctx, q.AuthIndex, fromMS, toMS)
		if err != nil {
			continue
		}
		usage := quota.WindowUsage{
			FromMS:         fromMS,
			ToMS:           toMS,
			Requests:       recorded.Requests,
			PricedRequests: recorded.PricedRequests,
			Tokens:         recorded.Tokens,
			CostNanos:      recorded.CostNanos,
		}
		window.Usage = &usage

		if !isHistoryLoaded {
			history = h.loadObservedWindows(ctx, q.AuthIndex)
			isHistoryLoaded = true
		}
		// toMS is the current observation, so the reading being estimated is
		// itself outside the range and only earlier ones are compared.
		earlierPeak := quota.PeakUsedPercent(history, window.ID, fromMS, toMS)
		window.Capacity, window.CapacityUnavailable = quota.EstimateWindowCapacity(*window, usage, earlierPeak)
	}
}

func (h *Handler) loadObservedWindows(ctx context.Context, authIndex string) []quota.ObservedWindows {
	records, err := h.repo.GetQuotaSnapshotHistory(ctx, authIndex, capacityHistoryDepth)
	if err != nil {
		return nil
	}
	history := make([]quota.ObservedWindows, 0, len(records))
	for _, record := range records {
		var windows []quota.QuotaWindow
		if err := json.Unmarshal([]byte(record.WindowsJSON), &windows); err != nil {
			continue
		}
		history = append(history, quota.ObservedWindows{ObservedAtMS: record.ObservedAtMS, Windows: windows})
	}
	return history
}
