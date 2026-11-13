package repository

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/quota"
)

const (
	capacityRetainedCycles           = 3
	capacityLatencyLookbackMS        = 15 * 60 * 1000
	capacityWatermarkCheckpointDelta = 256
)

type capacityQuerier interface {
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
}

// recordCapacityCycles records a snapshot's cycle consumption inside the
// snapshot's own transaction. Corrupt window JSON is skipped rather than
// rejecting the raw snapshot save.
func recordCapacityCycles(ctx context.Context, tx *sql.Tx, snapshot QuotaSnapshotRecord) error {
	if snapshot.Status == "stale" || snapshot.Status == "error" || snapshot.ObservedAtMS <= 0 {
		return nil
	}
	var windows []quota.QuotaWindow
	if err := json.Unmarshal([]byte(snapshot.WindowsJSON), &windows); err != nil || len(windows) == 0 {
		return nil
	}
	var dbWatermark int64
	hasWatermark := false
	readWatermark := func() (int64, error) {
		if !hasWatermark {
			if err := tx.QueryRowContext(ctx, `SELECT COALESCE(MAX(id), 0) FROM usage_events`).Scan(&dbWatermark); err != nil {
				return 0, fmt.Errorf("read quota usage watermark: %w", err)
			}
			hasWatermark = true
		}
		return dbWatermark, nil
	}

	plan := &quota.QuotaPlan{PlanType: snapshot.PlanType, Tier: snapshot.PlanTier}
	for _, window := range windows {
		if !quota.SupportsWindowCapacity(snapshot.Provider, window) {
			continue
		}
		key := quota.CapacityWindowKey(snapshot.Provider, window)
		stored, err := queryCapacityCycles(ctx, tx, snapshot.AuthIndex, key, capacityRetainedCycles)
		if err != nil {
			return err
		}
		cycle, isEvidence := quota.NextCalibrationCycle(stored, snapshot.Provider, window, plan, snapshot.ObservedAtMS)
		if !isEvidence {
			if len(cycle.Points) == 0 {
				continue
			}
			watermark, err := readWatermark()
			if err != nil {
				return err
			}
			last := &cycle.Points[len(cycle.Points)-1]
			effectiveWatermark := max(watermark, last.UsageWatermarkID)
			isLegacyUnwatermarked := last.HasUsageGap || (last.UsageWatermarkID == 0 && (last.Requests > 0 || last.UnmatchedRequests > 0))
			if !isLegacyUnwatermarked && effectiveWatermark <= last.UsageWatermarkID {
				continue
			}
			oldWatermark := last.UsageWatermarkID
			changed, ok, err := reconcileCycleLateUsage(ctx, tx, snapshot.AuthIndex, window, &cycle, effectiveWatermark)
			if err != nil {
				return err
			}
			if !ok || (!changed && !isLegacyUnwatermarked && effectiveWatermark-oldWatermark < capacityWatermarkCheckpointDelta) {
				continue
			}
		} else {
			watermark, err := readWatermark()
			if err != nil {
				return err
			}
			effectiveWatermark := watermark
			if len(cycle.Points) > 0 {
				effectiveWatermark = max(watermark, cycle.Points[len(cycle.Points)-1].UsageWatermarkID)
			}
			point, isMeasured, err := capacityPoint(ctx, tx, snapshot.AuthIndex, window, &cycle, snapshot.ObservedAtMS, effectiveWatermark)
			if err != nil {
				return err
			}
			if !isMeasured {
				continue
			}
			cycle.Points = quota.AppendCalibrationPoint(cycle.Points, point)
		}
		pointsJSON, err := json.Marshal(cycle.Points)
		if err != nil {
			return fmt.Errorf("encode capacity points: %w", err)
		}
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO quota_capacity_cycles (
				auth_index, window_key, cycle_reset_at_ms, period_hours, plan_type, plan_tier, points_json, updated_at_ms
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(auth_index, window_key, cycle_reset_at_ms) DO UPDATE SET
				points_json = excluded.points_json, updated_at_ms = excluded.updated_at_ms,
				plan_type = excluded.plan_type, plan_tier = excluded.plan_tier, period_hours = excluded.period_hours`,
			snapshot.AuthIndex, key, cycle.CycleResetAtMS, cycle.PeriodHours, cycle.PlanType, cycle.PlanTier,
			string(pointsJSON), time.Now().UnixMilli(),
		); err != nil {
			return fmt.Errorf("save capacity cycle: %w", err)
		}
		if _, err := tx.ExecContext(ctx, `
			DELETE FROM quota_capacity_cycles
			WHERE auth_index = ? AND window_key = ? AND cycle_reset_at_ms NOT IN (
				SELECT cycle_reset_at_ms FROM quota_capacity_cycles
				WHERE auth_index = ? AND window_key = ?
				ORDER BY cycle_reset_at_ms DESC LIMIT ?
			)`,
			snapshot.AuthIndex, key, snapshot.AuthIndex, key, capacityRetainedCycles,
		); err != nil {
			return fmt.Errorf("trim capacity cycles: %w", err)
		}
	}
	return nil
}

type lateUsageEntry struct {
	finishMS int64
	usage    quota.WindowUsage
}

// reconcileCycleLateUsage incorporates rows inserted after last.UsageWatermarkID
// whose completion instant predates existing points, preserving frozen cutoff
// instants (such as the first 100% exhaustion observation) and retained sums.
func reconcileCycleLateUsage(ctx context.Context, q capacityQuerier, authIndex string, window quota.QuotaWindow, cycle *quota.CycleCalibration, watermark int64) (changed bool, ok bool, err error) {
	if len(cycle.Points) == 0 {
		return false, true, nil
	}
	last := &cycle.Points[len(cycle.Points)-1]
	if last.HasUsageGap || (last.UsageWatermarkID == 0 && (last.Requests > 0 || last.UnmatchedRequests > 0)) {
		fresh, _, scopeReason, err := queryCapacityUsageBounded(ctx, q, authIndex, window, max(0, cycle.CycleStartMS()-capacityLatencyLookbackMS), cycle.CycleStartMS(), last.ObservedAtMS, watermark)
		if err != nil || scopeReason != "" {
			return false, false, err
		}
		if fresh.Requests > last.Requests {
			last.Requests = fresh.Requests
			last.PricedRequests = fresh.PricedRequests
			last.Tokens = fresh.Tokens
			last.PromptTokens = fresh.PromptTokens
			last.CachedTokens = fresh.CachedTokens
			last.CostNanos = fresh.CostNanos
			changed = true
		}
		if fresh.UnmatchedRequests > last.UnmatchedRequests {
			last.UnmatchedRequests = fresh.UnmatchedRequests
			changed = true
		}
		if last.HasUsageGap {
			last.HasUsageGap = false
			changed = true
		}
		last.UsageWatermarkID = watermark
		return changed, true, nil
	}
	if watermark <= last.UsageWatermarkID {
		return false, true, nil
	}
	entries, scopeReason, err := queryLateCapacityEntries(ctx, q, authIndex, window, cycle.CycleStartMS(), last.ObservedAtMS, last.UsageWatermarkID, watermark)
	if err != nil || scopeReason != "" {
		return false, false, err
	}
	for _, entry := range entries {
		for index := range cycle.Points {
			point := &cycle.Points[index]
			if entry.finishMS < point.ObservedAtMS {
				point.Requests += entry.usage.Requests
				point.PricedRequests += entry.usage.PricedRequests
				point.Tokens += entry.usage.Tokens
				point.PromptTokens += entry.usage.PromptTokens
				point.CachedTokens += entry.usage.CachedTokens
				point.CostNanos += entry.usage.CostNanos
				point.UnmatchedRequests += entry.usage.UnmatchedRequests
				changed = true
			}
		}
	}
	last.UsageWatermarkID = watermark
	return changed, true, nil
}

// queryLateCapacityEntries uses the primary key range (minExclusiveID, maxInclusiveID]
// via unary + predicates on secondary-index columns so SQLite inspects only newly
// inserted rows rather than scanning an entire multi-day window.
func queryLateCapacityEntries(ctx context.Context, q capacityQuerier, authIndex string, window quota.QuotaWindow, cycleStartMS, beforeMS, minExclusiveID, maxInclusiveID int64) ([]lateUsageEntry, string, error) {
	if window.Scope == "model" || window.Scope == "group" {
		if _, reason := quota.SelectWindowUsage(window, nil); reason != "" {
			return nil, reason, nil
		}
	}
	rows, err := q.QueryContext(ctx, `
		SELECT
			timestamp_ms + MAX(latency_ms, 0) AS finish_ms,
			COALESCE(NULLIF(response_model, ''), model) AS resolved_model,
			CASE WHEN cost_nanos IS NOT NULL THEN 1 ELSE 0 END,
			total_tokens,
			CASE
				WHEN token_accounting IS NOT NULL AND json_extract(token_accounting, '$.status') = 'complete'
					THEN COALESCE(json_extract(token_accounting, '$.token_breakdown.input.total_tokens'), 0)
				WHEN input_tokens > 0 THEN input_tokens
				ELSE MAX(total_tokens - MAX(output_tokens, 0), 0)
			END AS raw_prompt,
			CASE
				WHEN token_accounting IS NOT NULL AND json_extract(token_accounting, '$.status') = 'complete'
					THEN COALESCE(json_extract(token_accounting, '$.token_breakdown.input.cache_read_tokens'), 0)
				WHEN cache_read_tokens > 0 THEN cache_read_tokens
				ELSE MAX(cached_tokens, 0)
			END AS cached_read,
			CASE
				WHEN token_accounting IS NOT NULL AND json_extract(token_accounting, '$.status') = 'complete' THEN 1
				ELSE 0
			END AS is_canonical,
			CASE
				WHEN (token_accounting IS NOT NULL AND json_extract(token_accounting, '$.status') = 'complete')
					OR input_tokens > 0 OR output_tokens > 0 OR cached_tokens > 0 OR cache_read_tokens > 0 OR cache_creation_tokens > 0
					THEN 1
				ELSE 0
			END AS has_breakdown,
			COALESCE(cost_nanos, 0)
		FROM usage_events
		WHERE id > ? AND id <= ?
		  AND +auth_index = ?
		  AND +timestamp_ms >= ?
		  AND timestamp_ms + MAX(latency_ms, 0) >= ?
		  AND +timestamp_ms < ?
		  AND timestamp_ms + MAX(latency_ms, 0) < ?
		  AND +total_tokens > 0`,
		minExclusiveID, maxInclusiveID, authIndex,
		max(0, cycleStartMS-capacityLatencyLookbackMS), cycleStartMS, beforeMS, beforeMS,
	)
	if err != nil {
		return nil, "", fmt.Errorf("query late quota usage: %w", err)
	}
	defer rows.Close()

	var entries []lateUsageEntry
	for rows.Next() {
		var finishMS, priced, tokens, rawPrompt, cachedRead, isCanonical, hasBreakdown, costNanos int64
		var model string
		if err := rows.Scan(&finishMS, &model, &priced, &tokens, &rawPrompt, &cachedRead, &isCanonical, &hasBreakdown, &costNanos); err != nil {
			return nil, "", fmt.Errorf("scan late quota usage: %w", err)
		}
		prompt := int64(0)
		cached := int64(0)
		if hasBreakdown == 1 {
			cached = cachedRead
			if isCanonical == 1 || cachedRead <= rawPrompt {
				prompt = rawPrompt
			} else {
				prompt = rawPrompt + cachedRead
			}
		}
		single := quota.WindowUsage{
			Requests:       1,
			PricedRequests: priced,
			Tokens:         tokens,
			PromptTokens:   prompt,
			CachedTokens:   cached,
			CostNanos:      costNanos,
		}
		if window.Scope == "model" || window.Scope == "group" {
			selected, reason := quota.SelectWindowUsage(window, []quota.ModelWindowUsage{{Model: model, Usage: single}})
			if reason != "" {
				return nil, reason, nil
			}
			single = selected
		}
		if single.Requests == 0 && single.UnmatchedRequests == 0 {
			continue
		}
		entries = append(entries, lateUsageEntry{finishMS: finishMS, usage: single})
	}
	if err := rows.Err(); err != nil {
		return nil, "", fmt.Errorf("query late quota usage: %w", err)
	}
	return entries, "", nil
}

// capacityPoint pairs a reading with the usage recorded from the cycle start.
// Reconciling the prior point via insertion watermark before adding the new
// completion interval preserves both delayed arrivals and pruned history.
func capacityPoint(ctx context.Context, q capacityQuerier, authIndex string, window quota.QuotaWindow, cycle *quota.CycleCalibration, observedAtMS, watermark int64) (quota.CalibrationPoint, bool, error) {
	used, _ := quota.WindowUsedPercent(window)
	startLowerBoundMS := max(0, cycle.CycleStartMS()-capacityLatencyLookbackMS)
	if len(cycle.Points) == 0 {
		usage, _, scopeReason, err := queryCapacityUsageBounded(ctx, q, authIndex, window, startLowerBoundMS, cycle.CycleStartMS(), observedAtMS, watermark)
		if err != nil || scopeReason != "" {
			return quota.CalibrationPoint{}, false, err
		}
		return quota.CalibrationPoint{
			ObservedAtMS:      observedAtMS,
			UsedPercent:       used,
			Requests:          usage.Requests,
			PricedRequests:    usage.PricedRequests,
			Tokens:            usage.Tokens,
			PromptTokens:      usage.PromptTokens,
			CachedTokens:      usage.CachedTokens,
			CostNanos:         usage.CostNanos,
			UnmatchedRequests: usage.UnmatchedRequests,
			UsageWatermarkID:  watermark,
		}, true, nil
	}

	if _, ok, err := reconcileCycleLateUsage(ctx, q, authIndex, window, cycle, watermark); err != nil || !ok {
		return quota.CalibrationPoint{}, false, err
	}
	last := cycle.Points[len(cycle.Points)-1]
	since, _, scopeReason, err := queryCapacityUsageBounded(ctx, q, authIndex, window, startLowerBoundMS, last.ObservedAtMS, observedAtMS, watermark)
	if err != nil || scopeReason != "" {
		return quota.CalibrationPoint{}, false, err
	}
	return quota.CalibrationPoint{
		ObservedAtMS:      observedAtMS,
		UsedPercent:       used,
		Requests:          last.Requests + since.Requests,
		PricedRequests:    last.PricedRequests + since.PricedRequests,
		Tokens:            last.Tokens + since.Tokens,
		PromptTokens:      last.PromptTokens + since.PromptTokens,
		CachedTokens:      last.CachedTokens + since.CachedTokens,
		CostNanos:         last.CostNanos + since.CostNanos,
		UnmatchedRequests: last.UnmatchedRequests + since.UnmatchedRequests,
		UsageWatermarkID:  watermark,
	}, true, nil
}

// LoadCapacityCycles returns a credential's retained cycle evidence by window
// key, newest cycle first.
func (r *Repository) LoadCapacityCycles(ctx context.Context, authIndex string) (map[string][]quota.CycleCalibration, error) {
	if r == nil || r.SQL() == nil {
		return nil, errors.New("repository is not initialized")
	}
	cycles, err := queryCapacityCycles(ctx, r.SQL(), strings.TrimSpace(authIndex), "", -1)
	if err != nil {
		return nil, err
	}
	byKey := make(map[string][]quota.CycleCalibration)
	for _, cycle := range cycles {
		byKey[cycle.WindowKey] = append(byKey[cycle.WindowKey], cycle)
	}
	return byKey, nil
}

func queryCapacityCycles(ctx context.Context, q capacityQuerier, authIndex, key string, limit int) ([]quota.CycleCalibration, error) {
	rows, err := q.QueryContext(ctx, `
		SELECT window_key, cycle_reset_at_ms, period_hours, plan_type, plan_tier, points_json
		FROM quota_capacity_cycles
		WHERE auth_index = ? AND (? = '' OR window_key = ?)
		ORDER BY window_key, cycle_reset_at_ms DESC LIMIT ?`,
		authIndex, key, key, limit,
	)
	if err != nil {
		return nil, fmt.Errorf("query capacity cycles: %w", err)
	}
	defer rows.Close()
	var cycles []quota.CycleCalibration
	for rows.Next() {
		var cycle quota.CycleCalibration
		var pointsJSON string
		if err := rows.Scan(&cycle.WindowKey, &cycle.CycleResetAtMS, &cycle.PeriodHours, &cycle.PlanType, &cycle.PlanTier, &pointsJSON); err != nil {
			return nil, fmt.Errorf("scan capacity cycle: %w", err)
		}
		if err := json.Unmarshal([]byte(pointsJSON), &cycle.Points); err != nil {
			cycle.Points = nil
		}
		cycles = append(cycles, cycle)
	}
	return cycles, rows.Err()
}

// QueryCapacityUsage sums the requests that consumed a credential's window in
// [fromMS, toMS). A request that started slightly before the rolling window
// anchor and completed within [fromMS, toMS) is included via lookback.
func (r *Repository) QueryCapacityUsage(ctx context.Context, authIndex string, window quota.QuotaWindow, fromMS, toMS int64) (quota.WindowUsage, string, error) {
	usage, _, reason, err := r.QueryCapacityUsageWithModels(ctx, authIndex, window, fromMS, toMS)
	return usage, reason, err
}

// QueryCapacityUsageAfterWatermark sums requests inserted after minExclusiveID
// that completed within [fromMS, toMS), so read-time displays and exhaustion
// cutoffs remain exact across retention pruning and delayed usage arrivals.
func (r *Repository) QueryCapacityUsageAfterWatermark(ctx context.Context, authIndex string, window quota.QuotaWindow, fromMS, toMS, minExclusiveID int64) (quota.WindowUsage, string, error) {
	if r == nil || r.SQL() == nil {
		return quota.WindowUsage{}, "", errors.New("repository is not initialized")
	}
	if minExclusiveID <= 0 || toMS <= fromMS {
		return quota.WindowUsage{FromMS: fromMS, ToMS: toMS}, "", nil
	}
	var maxID int64
	if err := r.SQL().QueryRowContext(ctx, `SELECT COALESCE(MAX(id), 0) FROM usage_events`).Scan(&maxID); err != nil {
		return quota.WindowUsage{}, "", fmt.Errorf("read quota usage watermark: %w", err)
	}
	if maxID <= minExclusiveID {
		return quota.WindowUsage{FromMS: fromMS, ToMS: toMS}, "", nil
	}
	entries, reason, err := queryLateCapacityEntries(ctx, r.SQL(), strings.TrimSpace(authIndex), window, fromMS, toMS, minExclusiveID, maxID)
	if err != nil || reason != "" {
		return quota.WindowUsage{}, reason, err
	}
	out := quota.WindowUsage{FromMS: fromMS, ToMS: toMS}
	for _, entry := range entries {
		out = quota.AddWindowUsage(out, entry.usage)
	}
	return out, "", nil
}

// QueryCapacityUsageWithModels returns both the aggregated window usage and the
// per-model breakdown of completed requests in [fromMS, toMS).
func (r *Repository) QueryCapacityUsageWithModels(ctx context.Context, authIndex string, window quota.QuotaWindow, fromMS, toMS int64) (quota.WindowUsage, []quota.ModelWindowUsage, string, error) {
	if r == nil || r.SQL() == nil {
		return quota.WindowUsage{}, nil, "", errors.New("repository is not initialized")
	}
	return queryCapacityUsageSince(ctx, r.SQL(), strings.TrimSpace(authIndex), window, max(0, fromMS-capacityLatencyLookbackMS), fromMS, toMS)
}

func queryCapacityUsageSince(ctx context.Context, q capacityQuerier, authIndex string, window quota.QuotaWindow, startLowerBoundMS, fromMS, toMS int64) (quota.WindowUsage, []quota.ModelWindowUsage, string, error) {
	return queryCapacityUsageBounded(ctx, q, authIndex, window, startLowerBoundMS, fromMS, toMS, 0)
}

func queryCapacityUsageBounded(ctx context.Context, q capacityQuerier, authIndex string, window quota.QuotaWindow, startLowerBoundMS, fromMS, toMS, maxInclusiveID int64) (quota.WindowUsage, []quota.ModelWindowUsage, string, error) {
	rows, err := q.QueryContext(ctx, `
		WITH events AS (
			SELECT
				COALESCE(NULLIF(response_model, ''), model) AS resolved_model,
				cost_nanos,
				total_tokens,
				CASE
					WHEN token_accounting IS NOT NULL AND json_extract(token_accounting, '$.status') = 'complete' THEN 1
					ELSE 0
				END AS is_canonical,
				CASE
					WHEN token_accounting IS NOT NULL AND json_extract(token_accounting, '$.status') = 'complete'
						THEN COALESCE(json_extract(token_accounting, '$.token_breakdown.input.total_tokens'), 0)
					WHEN input_tokens > 0 THEN input_tokens
					ELSE MAX(total_tokens - MAX(output_tokens, 0), 0)
				END AS raw_prompt,
				CASE
					WHEN token_accounting IS NOT NULL AND json_extract(token_accounting, '$.status') = 'complete'
						THEN COALESCE(json_extract(token_accounting, '$.token_breakdown.input.cache_read_tokens'), 0)
					WHEN cache_read_tokens > 0 THEN cache_read_tokens
					ELSE MAX(cached_tokens, 0)
				END AS cached_read,
				CASE
					WHEN (token_accounting IS NOT NULL AND json_extract(token_accounting, '$.status') = 'complete')
						OR input_tokens > 0 OR output_tokens > 0 OR cached_tokens > 0 OR cache_read_tokens > 0 OR cache_creation_tokens > 0
						THEN 1
					ELSE 0
				END AS has_breakdown
			FROM usage_events
			WHERE auth_index = ? AND timestamp_ms >= ? AND timestamp_ms + MAX(latency_ms, 0) >= ? AND timestamp_ms < ?
			  AND timestamp_ms + MAX(latency_ms, 0) < ? AND total_tokens > 0
			  AND (? <= 0 OR id <= ?)
		)
		SELECT
			resolved_model,
			COUNT(1),
			COALESCE(SUM(cost_nanos IS NOT NULL), 0),
			COALESCE(SUM(total_tokens), 0),
			COALESCE(SUM(CASE
				WHEN has_breakdown = 0 THEN 0
				WHEN is_canonical = 1 THEN raw_prompt
				WHEN cached_read > raw_prompt THEN raw_prompt + cached_read
				ELSE raw_prompt
			END), 0),
			COALESCE(SUM(CASE WHEN has_breakdown = 0 THEN 0 ELSE cached_read END), 0),
			COALESCE(SUM(cost_nanos), 0)
		FROM events
		GROUP BY 1`,
		authIndex, startLowerBoundMS, fromMS, toMS, toMS, maxInclusiveID, maxInclusiveID,
	)
	if err != nil {
		return quota.WindowUsage{}, nil, "", fmt.Errorf("query capacity usage: %w", err)
	}
	defer rows.Close()
	var groups []quota.ModelWindowUsage
	for rows.Next() {
		var group quota.ModelWindowUsage
		if err := rows.Scan(
			&group.Model,
			&group.Usage.Requests,
			&group.Usage.PricedRequests,
			&group.Usage.Tokens,
			&group.Usage.PromptTokens,
			&group.Usage.CachedTokens,
			&group.Usage.CostNanos,
		); err != nil {
			return quota.WindowUsage{}, nil, "", fmt.Errorf("scan capacity usage: %w", err)
		}
		group.Usage.CacheRate = quota.ComputeCacheRate(group.Usage.CachedTokens, group.Usage.PromptTokens)
		groups = append(groups, group)
	}
	if err := rows.Err(); err != nil {
		return quota.WindowUsage{}, nil, "", fmt.Errorf("query capacity usage: %w", err)
	}
	var usage quota.WindowUsage
	reason := ""
	if window.Scope == "model" || window.Scope == "group" {
		usage, reason = quota.SelectWindowUsage(window, groups)
	} else {
		for _, group := range groups {
			usage.Requests += group.Usage.Requests
			usage.PricedRequests += group.Usage.PricedRequests
			usage.Tokens += group.Usage.Tokens
			usage.PromptTokens += group.Usage.PromptTokens
			usage.CachedTokens += group.Usage.CachedTokens
			usage.CostNanos += group.Usage.CostNanos
		}
		usage.CacheRate = quota.ComputeCacheRate(usage.CachedTokens, usage.PromptTokens)
	}
	usage.FromMS, usage.ToMS = fromMS, toMS
	return usage, groups, reason, nil
}
