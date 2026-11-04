package api

import (
	"context"
	"encoding/json"
	"fmt"
	"slices"

	"github.com/oh-my-cpa/oh-my-cpa/internal/quota"
)

const capacityHistoryDepth = 100

// Estimates are read-time joins. A failed refresh can share the prior windows,
// so replace the slice rather than writing estimates into the stored reading.
func (h *Handler) attachWindowCapacity(ctx context.Context, observation *quota.NormalizedQuota, nowMS int64) {
	if h.repo == nil || observation == nil || len(observation.Windows) == 0 {
		return
	}
	windows := slices.Clone(observation.Windows)
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
		if !hasLoadedHistory {
			history, historyErr = h.loadObservedWindows(ctx, observation.AuthIndex, observation.Provider)
			// A plan change starts new calibration, not a blend of two plans.
			if observation.Plan != nil {
				for index := len(history) - 1; index >= 0; index-- {
					prior := history[index]
					if prior.PlanType != observation.Plan.PlanType || prior.PlanTier != observation.Plan.Tier {
						history = history[index+1:]
						break
					}
				}
			}
			hasLoadedHistory = true
		}

		capacity, usage, reason := h.estimateCapacityAt(ctx, observation.AuthIndex, *window, history, observation.ObservedAtMS)
		window.Usage = usage
		// A small or missing sample leans on the latest earlier estimate with a
		// larger one, so a window that just reset still has a size.
		if capacity == nil || capacity.SamplePercent < quota.CapacityCalibrationPercent {
			for _, point := range quota.CapacityReferencePoints(*window, history, observation.ObservedAtMS) {
				reference, _, _ := h.estimateCapacityAt(ctx, observation.AuthIndex, point.Window, history, point.ObservedAtMS)
				if reference == nil || capacity != nil && reference.SamplePercent <= capacity.SamplePercent {
					continue
				}
				reference.Basis = "previous_cycle"
				capacity = quota.BlendWindowCapacity(capacity, reference)
				break
			}
		}
		if capacity == nil {
			window.CapacityUnavailable = reason
			if historyErr != nil {
				window.CapacityUnavailable = quota.CapacityReasonHistoryUnavailable
			}
			continue
		}
		isLive := observation.Status != "stale" && observation.Status != "error" && observation.Error == "" && !observation.Disabled && (window.ResetAtMS == nil || *window.ResetAtMS > nowMS)
		quota.AttachRemainingCapacity(capacity, *window, isLive)
		window.Capacity = capacity
	}
}

func (h *Handler) estimateCapacityAt(ctx context.Context, authIndex string, window quota.QuotaWindow, history []quota.ObservedWindows, observedAtMS int64) (*quota.WindowCapacity, *quota.WindowUsage, string) {
	var cycleUsage *quota.WindowUsage
	fromMS, toMS, reason := quota.WindowCycleRange(window, observedAtMS, observedAtMS)
	if reason == "" {
		usage, usageReason := h.queryCapacityUsage(ctx, authIndex, window, fromMS, toMS)
		if usageReason == "" {
			cycleUsage = &usage
		} else {
			reason = usageReason
		}
	}
	if baseline, hasBaseline := quota.CapacityBaseline(window, history, observedAtMS); hasBaseline {
		usage, usageReason := h.queryCapacityUsage(ctx, authIndex, window, baseline.ObservedAtMS, observedAtMS)
		if usageReason == "" {
			used, _ := quota.WindowUsedPercent(window)
			baselineUsed, _ := quota.WindowUsedPercent(baseline.Window)
			capacity, deltaReason := quota.EstimateDeltaCapacity(window, usage, used-baselineUsed)
			if capacity != nil {
				return capacity, cycleUsage, ""
			}
			reason = deltaReason
		}
	}
	if cycleUsage == nil {
		return nil, nil, reason
	}
	checked := window
	checked.HasMidCycleReset = quota.HasWindowCycleReset(window, history, fromMS, toMS)
	capacity, reason := quota.EstimateWindowCapacity(checked, *cycleUsage, nil)
	return capacity, cycleUsage, reason
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
		history = append(history, quota.ObservedWindows{ObservedAtMS: record.ObservedAtMS, PlanType: record.PlanType, PlanTier: record.PlanTier, Windows: windows})
	}
	slices.Reverse(history)
	return history, nil
}
