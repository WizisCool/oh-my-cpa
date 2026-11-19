package repository

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/quota"
)

const (
	capacityRetainedCycles           = 3
	CapacityLatencyLookbackMS        = 15 * 60 * 1000
	capacityLatencyLookbackMS        = CapacityLatencyLookbackMS
	capacityWatermarkCheckpointDelta = 256
	// Above this ID gap, scanning the credential's time index avoids walking
	// tens of thousands of unrelated rows inserted for other credentials.
	lateCapacityPKScanThreshold = 4096
)

type capacityQuerier interface {
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
}

// CycleNeedsLegacyReconcile reports whether a cycle contains pre-watermark or
// usage-gap checkpoints that require full per-point reconciliation.
func CycleNeedsLegacyReconcile(points []quota.CalibrationPoint) bool {
	return cycleNeedsLegacyReconcile(points)
}

func cycleNeedsLegacyReconcile(points []quota.CalibrationPoint) bool {
	if len(points) == 0 {
		return false
	}
	for index := range points {
		if points[index].HasUsageGap {
			return true
		}
	}
	last := points[len(points)-1]
	return last.UsageWatermarkID == 0 && (last.Requests > 0 || last.UnmatchedRequests > 0)
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
			isLegacyUnwatermarked := cycleNeedsLegacyReconcile(cycle.Points)
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

// ReconcileLiveCycleForRead returns a read-time copy of cycles where the live
// cycle's checkpoints (including mid-cycle reset baselines and initial 100%
// cutoffs) incorporate delayed usage arrivals not yet persisted by a snapshot.
func (r *Repository) ReconcileLiveCycleForRead(
	ctx context.Context,
	authIndex string,
	window quota.QuotaWindow,
	plan *quota.QuotaPlan,
	observedAtMS int64,
	cycles []quota.CycleCalibration,
) []quota.CycleCalibration {
	if r == nil || r.SQL() == nil || len(cycles) == 0 {
		return cycles
	}
	live := quota.LiveCycleIndex(window, observedAtMS, cycles)
	if live < 0 || !quota.SameCalibrationPlan(cycles[live], plan) || len(cycles[live].Points) == 0 {
		return cycles
	}
	last := cycles[live].Points[len(cycles[live].Points)-1]
	isLegacy := cycleNeedsLegacyReconcile(cycles[live].Points)
	var watermark int64
	if err := r.SQL().QueryRowContext(ctx, `SELECT COALESCE(MAX(id), 0) FROM usage_events`).Scan(&watermark); err != nil {
		return cycles
	}
	effectiveWatermark := max(watermark, last.UsageWatermarkID)
	if !isLegacy && effectiveWatermark <= last.UsageWatermarkID {
		return cycles
	}
	cloned := slices.Clone(cycles)
	cloned[live].Points = slices.Clone(cycles[live].Points)
	if _, ok, err := reconcileCycleLateUsage(ctx, r.SQL(), strings.TrimSpace(authIndex), window, &cloned[live], effectiveWatermark); err != nil || !ok {
		return cycles
	}
	return cloned
}

// reconcileCycleLateUsage incorporates rows inserted after last.UsageWatermarkID
// whose completion instant predates existing points, preserving frozen cutoff
// instants (such as the first 100% exhaustion observation), reset baselines,
// and retained cumulative sums.
func reconcileCycleLateUsage(ctx context.Context, q capacityQuerier, authIndex string, window quota.QuotaWindow, cycle *quota.CycleCalibration, watermark int64) (changed bool, ok bool, err error) {
	if len(cycle.Points) == 0 {
		return false, true, nil
	}
	last := &cycle.Points[len(cycle.Points)-1]
	if cycleNeedsLegacyReconcile(cycle.Points) {
		startLowerBoundMS := max(0, cycle.CycleStartMS()-capacityLatencyLookbackMS)
		cycleStartMS := cycle.CycleStartMS()
		for index := range cycle.Points {
			point := &cycle.Points[index]
			fresh, _, scopeReason, err := queryCapacityUsageBounded(ctx, q, authIndex, window, startLowerBoundMS, cycleStartMS, point.ObservedAtMS, watermark)
			if err != nil || scopeReason != "" {
				return false, false, err
			}
			if fresh.Requests > point.Requests {
				point.Requests = fresh.Requests
				point.PricedRequests = fresh.PricedRequests
				point.Tokens = fresh.Tokens
				point.PromptTokens = fresh.PromptTokens
				point.CachedTokens = fresh.CachedTokens
				point.CostNanos = fresh.CostNanos
				changed = true
			}
			if fresh.UnmatchedRequests > point.UnmatchedRequests {
				point.UnmatchedRequests = fresh.UnmatchedRequests
				changed = true
			}
			if index > 0 {
				prev := &cycle.Points[index-1]
				if prev.Requests > point.Requests {
					point.Requests = prev.Requests
					point.PricedRequests = max(point.PricedRequests, prev.PricedRequests)
					point.Tokens = max(point.Tokens, prev.Tokens)
					point.PromptTokens = max(point.PromptTokens, prev.PromptTokens)
					point.CachedTokens = max(point.CachedTokens, prev.CachedTokens)
					point.CostNanos = max(point.CostNanos, prev.CostNanos)
					changed = true
				}
				if prev.UnmatchedRequests > point.UnmatchedRequests {
					point.UnmatchedRequests = prev.UnmatchedRequests
					changed = true
				}
			}
			if point.HasUsageGap {
				point.HasUsageGap = false
				changed = true
			}
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

// queryLateCapacityEntries inspects rows inserted in (minExclusiveID, maxInclusiveID]
// for authIndex that completed before beforeMS. When the watermark lag is small it
// scans the primary-key tail directly; when unrelated traffic creates a large ID gap
// it compares against the credential's time-index selectivity so it only switches to
// idx_usage_events_auth_time when that scan is strictly smaller than the ID tail.
func queryLateCapacityEntries(ctx context.Context, q capacityQuerier, authIndex string, window quota.QuotaWindow, cycleStartMS, beforeMS, minExclusiveID, maxInclusiveID int64) ([]lateUsageEntry, string, error) {
	if window.Scope == "model" || window.Scope == "group" {
		if _, reason := quota.SelectWindowUsage(window, nil); reason != "" {
			return nil, reason, nil
		}
	}
	startLowerMS := max(0, cycleStartMS-capacityLatencyLookbackMS)
	useAuthTimeIndex := false
	idGap := maxInclusiveID - minExclusiveID
	if idGap > lateCapacityPKScanThreshold {
		// Probe at most min(idGap, lateCapacityPKScanThreshold) index-only entries
		// in idx_usage_events_auth_time: if the credential has fewer rows in its
		// time span than the ID tail, scanning the time index is strictly cheaper
		// (and handles arbitrarily large unrelated-traffic gaps); otherwise keep
		// the bounded primary-key tail scan so dense monthly histories stay fast.
		probeLimit := min(idGap, int64(lateCapacityPKScanThreshold))
		var denseCheck int
		err := q.QueryRowContext(ctx, `
			SELECT 1
			FROM usage_events INDEXED BY idx_usage_events_auth_time
			WHERE auth_index = ? AND timestamp_ms >= ? AND timestamp_ms < ?
			LIMIT 1 OFFSET ?`,
			authIndex, startLowerMS, beforeMS, probeLimit,
		).Scan(&denseCheck)
		if errors.Is(err, sql.ErrNoRows) {
			useAuthTimeIndex = true
		} else if err != nil {
			return nil, "", fmt.Errorf("probe late quota usage selectivity: %w", err)
		}
	}
	whereClause := `
		WHERE id > ? AND id <= ?
		  AND +auth_index = ?
		  AND +timestamp_ms >= ?
		  AND timestamp_ms + MAX(latency_ms, 0) >= ?
		  AND +timestamp_ms < ?
		  AND timestamp_ms + MAX(latency_ms, 0) < ?
		  AND +total_tokens > 0`
	if useAuthTimeIndex {
		whereClause = `
		WHERE +id > ? AND +id <= ?
		  AND auth_index = ?
		  AND timestamp_ms >= ?
		  AND timestamp_ms + MAX(latency_ms, 0) >= ?
		  AND timestamp_ms < ?
		  AND timestamp_ms + MAX(latency_ms, 0) < ?
		  AND +total_tokens > 0`
	}
	rows, err := q.QueryContext(ctx, `
		SELECT
			timestamp_ms + MAX(latency_ms, 0) AS finish_ms,
			COALESCE(NULLIF(response_model, ''), model) AS resolved_model,
			input_tokens, output_tokens, cached_tokens, cache_read_tokens, cache_creation_tokens,
			total_tokens, cost_nanos, token_accounting
		FROM usage_events`+whereClause,
		minExclusiveID, maxInclusiveID, authIndex,
		startLowerMS, cycleStartMS, beforeMS, beforeMS,
	)
	if err != nil {
		return nil, "", fmt.Errorf("query late quota usage: %w", err)
	}
	defer rows.Close()

	var entries []lateUsageEntry
	for rows.Next() {
		var finishMS, inputTokens, outputTokens, cachedTokens, cacheReadTokens, cacheCreationTokens, totalTokens int64
		var costNanos sql.NullInt64
		var tokenAccounting sql.NullString
		var model string
		if err := rows.Scan(&finishMS, &model, &inputTokens, &outputTokens, &cachedTokens, &cacheReadTokens, &cacheCreationTokens, &totalTokens, &costNanos, &tokenAccounting); err != nil {
			return nil, "", fmt.Errorf("scan late quota usage: %w", err)
		}
		isCanonical, canonPrompt, canonCacheRead := parseCapacityTokenAccounting(tokenAccounting.String)
		single := buildCapacityEventUsage(isCanonical, canonPrompt, canonCacheRead, inputTokens, outputTokens, cachedTokens, cacheReadTokens, cacheCreationTokens, totalTokens, costNanos)
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

func buildCapacityEventUsage(
	isCanonical bool,
	canonPrompt, canonCacheRead int64,
	inputTokens, outputTokens, cachedTokens, cacheReadTokens, cacheCreationTokens, totalTokens int64,
	costNanos sql.NullInt64,
) quota.WindowUsage {
	hasBreakdown := isCanonical ||
		inputTokens > 0 || outputTokens > 0 || cachedTokens > 0 || cacheReadTokens > 0 || cacheCreationTokens > 0
	var rawPrompt, cachedRead int64
	if isCanonical {
		rawPrompt = canonPrompt
		cachedRead = canonCacheRead
	} else {
		if inputTokens > 0 {
			rawPrompt = inputTokens
		} else {
			rawPrompt = max(totalTokens-max(outputTokens, 0), 0)
		}
		if cacheReadTokens > 0 {
			cachedRead = cacheReadTokens
		} else {
			cachedRead = max(cachedTokens, 0)
		}
	}
	var prompt, cached int64
	if hasBreakdown {
		cached = cachedRead
		if isCanonical || cachedRead <= rawPrompt {
			prompt = rawPrompt
		} else {
			prompt = rawPrompt + cachedRead
		}
	}
	var priced, cost int64
	if costNanos.Valid {
		priced = 1
		cost = costNanos.Int64
	}
	return quota.WindowUsage{
		Requests:       1,
		PricedRequests: priced,
		Tokens:         totalTokens,
		PromptTokens:   prompt,
		CachedTokens:   cached,
		CostNanos:      cost,
	}
}

// parseCapacityTokenAccounting extracts canonical completion status and
// canonical input prompt/cache totals from usage_events.token_accounting without
// invoking SQLite json_extract repeatedly per row.
func parseCapacityTokenAccounting(raw string) (isCanonical bool, promptTokens, cacheReadTokens int64) {
	if raw == "" {
		return false, 0, 0
	}
	if ok, canon, prompt, cache := parseCapacityTokenAccountingFast(raw); ok {
		return canon, prompt, cache
	}
	var parsed struct {
		Status         string `json:"status"`
		TokenBreakdown *struct {
			Input *struct {
				TotalTokens     int64 `json:"total_tokens"`
				CacheReadTokens int64 `json:"cache_read_tokens"`
			} `json:"input"`
		} `json:"token_breakdown"`
	}
	if err := json.Unmarshal([]byte(raw), &parsed); err != nil || parsed.Status != "complete" {
		return false, 0, 0
	}
	if parsed.TokenBreakdown != nil && parsed.TokenBreakdown.Input != nil {
		return true, parsed.TokenBreakdown.Input.TotalTokens, parsed.TokenBreakdown.Input.CacheReadTokens
	}
	return true, 0, 0
}

func skipJSONSpace(s string, i int) int {
	for i < len(s) {
		switch s[i] {
		case ' ', '\t', '\r', '\n':
			i++
		default:
			return i
		}
	}
	return i
}

// parseCapacityTokenAccountingFast scans unescaped JSON objects without heap
// allocations, returning ok=false so encoding/json handles escapes, floats, or
// unusual syntax.
func parseCapacityTokenAccountingFast(raw string) (ok, isCanonical bool, promptTokens, cacheReadTokens int64) {
	if strings.ContainsRune(raw, '\\') {
		return false, false, 0, 0
	}
	if !strings.Contains(raw, `"complete"`) {
		return true, false, 0, 0
	}
	i := skipJSONSpace(raw, 0)
	if i >= len(raw) || raw[i] != '{' {
		return false, false, 0, 0
	}
	i++

	readString := func() (string, bool) {
		if i >= len(raw) || raw[i] != '"' {
			return "", false
		}
		start := i + 1
		end := strings.IndexByte(raw[start:], '"')
		if end < 0 {
			return "", false
		}
		i = start + end + 1
		return raw[start : start+end], true
	}
	readInt64 := func() (int64, bool) {
		if i >= len(raw) {
			return 0, false
		}
		neg := false
		if raw[i] == '-' {
			neg = true
			i++
		}
		start := i
		var v int64
		for i < len(raw) && raw[i] >= '0' && raw[i] <= '9' {
			d := int64(raw[i] - '0')
			if v > (1<<62-1)/10 {
				return 0, false
			}
			v = v*10 + d
			i++
		}
		if i == start {
			return 0, false
		}
		if i < len(raw) && (raw[i] == '.' || raw[i] == 'e' || raw[i] == 'E') {
			return 0, false
		}
		if neg {
			v = -v
		}
		return v, true
	}
	var skipValue func() bool
	skipObject := func() bool {
		i++ // consume '{'
		i = skipJSONSpace(raw, i)
		if i < len(raw) && raw[i] == '}' {
			i++
			return true
		}
		for {
			i = skipJSONSpace(raw, i)
			if i >= len(raw) || raw[i] != '"' {
				return false
			}
			if _, valid := readString(); !valid {
				return false
			}
			i = skipJSONSpace(raw, i)
			if i >= len(raw) || raw[i] != ':' {
				return false
			}
			i++
			if !skipValue() {
				return false
			}
			i = skipJSONSpace(raw, i)
			if i >= len(raw) {
				return false
			}
			if raw[i] == ',' {
				i++
				continue
			}
			if raw[i] == '}' {
				i++
				return true
			}
			return false
		}
	}
	skipArray := func() bool {
		i++ // consume '['
		i = skipJSONSpace(raw, i)
		if i < len(raw) && raw[i] == ']' {
			i++
			return true
		}
		for {
			if !skipValue() {
				return false
			}
			i = skipJSONSpace(raw, i)
			if i >= len(raw) {
				return false
			}
			if raw[i] == ',' {
				i++
				continue
			}
			if raw[i] == ']' {
				i++
				return true
			}
			return false
		}
	}
	skipValue = func() bool {
		i = skipJSONSpace(raw, i)
		if i >= len(raw) {
			return false
		}
		switch raw[i] {
		case '"':
			_, valid := readString()
			return valid
		case '{':
			return skipObject()
		case '[':
			return skipArray()
		default:
			start := i
			for i < len(raw) {
				switch raw[i] {
				case ',', '}', ']', ' ', '\t', '\r', '\n':
					goto doneBare
				default:
					i++
				}
			}
		doneBare:
			return isValidJSONBareLiteral(raw[start:i])
		}
	}

	parseInputObject := func() bool {
		i++ // consume '{'
		for {
			i = skipJSONSpace(raw, i)
			if i >= len(raw) {
				return false
			}
			if raw[i] == '}' {
				i++
				return true
			}
			key, valid := readString()
			if !valid {
				return false
			}
			i = skipJSONSpace(raw, i)
			if i >= len(raw) || raw[i] != ':' {
				return false
			}
			i = skipJSONSpace(raw, i+1)
			switch key {
			case "total_tokens":
				val, validInt := readInt64()
				if !validInt {
					return false
				}
				promptTokens = val
			case "cache_read_tokens":
				val, validInt := readInt64()
				if !validInt {
					return false
				}
				cacheReadTokens = val
			default:
				if !skipValue() {
					return false
				}
			}
			i = skipJSONSpace(raw, i)
			if i >= len(raw) {
				return false
			}
			if raw[i] == ',' {
				i++
				continue
			}
			if raw[i] == '}' {
				i++
				return true
			}
			return false
		}
	}

	parseBreakdownObject := func() bool {
		i++ // consume '{'
		for {
			i = skipJSONSpace(raw, i)
			if i >= len(raw) {
				return false
			}
			if raw[i] == '}' {
				i++
				return true
			}
			key, valid := readString()
			if !valid {
				return false
			}
			i = skipJSONSpace(raw, i)
			if i >= len(raw) || raw[i] != ':' {
				return false
			}
			i = skipJSONSpace(raw, i+1)
			if key == "input" {
				if i < len(raw) && raw[i] == '{' {
					if !parseInputObject() {
						return false
					}
				} else if strings.HasPrefix(raw[i:], "null") {
					i += 4
				} else {
					// Unsupported type for input: fall back to encoding/json.
					return false
				}
			} else if !skipValue() {
				return false
			}
			i = skipJSONSpace(raw, i)
			if i >= len(raw) {
				return false
			}
			if raw[i] == ',' {
				i++
				continue
			}
			if raw[i] == '}' {
				i++
				return true
			}
			return false
		}
	}

	for {
		i = skipJSONSpace(raw, i)
		if i >= len(raw) {
			return false, false, 0, 0
		}
		if raw[i] == '}' {
			i = skipJSONSpace(raw, i+1)
			if i != len(raw) {
				return false, false, 0, 0
			}
			if !isCanonical {
				return true, false, 0, 0
			}
			return true, true, promptTokens, cacheReadTokens
		}
		key, valid := readString()
		if !valid {
			return false, false, 0, 0
		}
		i = skipJSONSpace(raw, i)
		if i >= len(raw) || raw[i] != ':' {
			return false, false, 0, 0
		}
		i = skipJSONSpace(raw, i+1)
		switch key {
		case "status":
			val, validStr := readString()
			if !validStr {
				return false, false, 0, 0
			}
			isCanonical = val == "complete"
		case "token_breakdown":
			if i < len(raw) && raw[i] == '{' {
				if !parseBreakdownObject() {
					return false, false, 0, 0
				}
			} else if strings.HasPrefix(raw[i:], "null") {
				i += 4
			} else {
				// Unsupported type for token_breakdown: fall back to encoding/json.
				return false, false, 0, 0
			}
		default:
			if !skipValue() {
				return false, false, 0, 0
			}
		}
		i = skipJSONSpace(raw, i)
		if i >= len(raw) {
			return false, false, 0, 0
		}
		if raw[i] == ',' {
			i++
			continue
		}
		if raw[i] == '}' {
			i = skipJSONSpace(raw, i+1)
			if i != len(raw) {
				return false, false, 0, 0
			}
			if !isCanonical {
				return true, false, 0, 0
			}
			return true, true, promptTokens, cacheReadTokens
		}
		return false, false, 0, 0
	}
}

func isValidJSONBareLiteral(tok string) bool {
	if tok == "" {
		return false
	}
	if tok == "true" || tok == "false" || tok == "null" {
		return true
	}
	idx := 0
	if tok[idx] == '-' {
		idx++
		if idx >= len(tok) {
			return false
		}
	}
	if tok[idx] == '0' {
		idx++
	} else if tok[idx] >= '1' && tok[idx] <= '9' {
		for idx < len(tok) && tok[idx] >= '0' && tok[idx] <= '9' {
			idx++
		}
	} else {
		return false
	}
	if idx < len(tok) && tok[idx] == '.' {
		idx++
		fracStart := idx
		for idx < len(tok) && tok[idx] >= '0' && tok[idx] <= '9' {
			idx++
		}
		if idx == fracStart {
			return false
		}
	}
	if idx < len(tok) && (tok[idx] == 'e' || tok[idx] == 'E') {
		idx++
		if idx < len(tok) && (tok[idx] == '+' || tok[idx] == '-') {
			idx++
		}
		expStart := idx
		for idx < len(tok) && tok[idx] >= '0' && tok[idx] <= '9' {
			idx++
		}
		if idx == expStart {
			return false
		}
	}
	return idx == len(tok)
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

// LoadCapacityCyclesBatch returns retained cycle evidence for all specified
// credentials grouped by auth_index -> window_key (newest cycle first) in one
// batch query.
func (r *Repository) LoadCapacityCyclesBatch(ctx context.Context, authIndexes []string) (map[string]map[string][]quota.CycleCalibration, error) {
	result := make(map[string]map[string][]quota.CycleCalibration)
	if r == nil || r.SQL() == nil {
		return nil, errors.New("repository is not initialized")
	}
	seen := make(map[string]struct{}, len(authIndexes))
	validIndexes := make([]string, 0, len(authIndexes))
	for _, authIndex := range authIndexes {
		trimmed := strings.TrimSpace(authIndex)
		if trimmed == "" {
			continue
		}
		if _, exists := seen[trimmed]; exists {
			continue
		}
		seen[trimmed] = struct{}{}
		validIndexes = append(validIndexes, trimmed)
	}
	if len(validIndexes) == 0 {
		return result, nil
	}
	const chunkSize = 500
	for start := 0; start < len(validIndexes); start += chunkSize {
		chunk := validIndexes[start:min(start+chunkSize, len(validIndexes))]
		placeholders := strings.TrimSuffix(strings.Repeat("?,", len(chunk)), ",")
		args := make([]any, len(chunk))
		for i, authIndex := range chunk {
			args[i] = authIndex
		}
		rows, err := r.SQL().QueryContext(ctx, fmt.Sprintf(`
			SELECT auth_index, window_key, cycle_reset_at_ms, period_hours, plan_type, plan_tier, points_json
			FROM quota_capacity_cycles
			WHERE auth_index IN (%s)
			ORDER BY auth_index, window_key, cycle_reset_at_ms DESC`, placeholders), args...)
		if err != nil {
			return nil, fmt.Errorf("query batch capacity cycles: %w", err)
		}
		for rows.Next() {
			var authIndex, pointsJSON string
			var cycle quota.CycleCalibration
			if err := rows.Scan(&authIndex, &cycle.WindowKey, &cycle.CycleResetAtMS, &cycle.PeriodHours, &cycle.PlanType, &cycle.PlanTier, &pointsJSON); err != nil {
				_ = rows.Close()
				return nil, fmt.Errorf("scan batch capacity cycle: %w", err)
			}
			if err := json.Unmarshal([]byte(pointsJSON), &cycle.Points); err != nil {
				cycle.Points = nil
			}
			byKey := result[authIndex]
			if byKey == nil {
				byKey = make(map[string][]quota.CycleCalibration)
				result[authIndex] = byKey
			}
			byKey[cycle.WindowKey] = append(byKey[cycle.WindowKey], cycle)
		}
		if err := rows.Err(); err != nil {
			_ = rows.Close()
			return nil, fmt.Errorf("iterate batch capacity cycles: %w", err)
		}
		_ = rows.Close()
	}
	return result, nil
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

// QueryCapacityUsageSinceCycleStart sums requests completing in [fromMS, toMS)
// while keeping the start-timestamp lower bound anchored at cycleStartMS - 15m,
// so internal checkpoint-tail queries include long-running requests that started
// more than 15 minutes before the checkpoint.
func (r *Repository) QueryCapacityUsageSinceCycleStart(ctx context.Context, authIndex string, window quota.QuotaWindow, cycleStartMS, fromMS, toMS int64) (quota.WindowUsage, string, error) {
	if r == nil || r.SQL() == nil {
		return quota.WindowUsage{}, "", errors.New("repository is not initialized")
	}
	usage, _, reason, err := queryCapacityUsageSince(ctx, r.SQL(), strings.TrimSpace(authIndex), window, max(0, min(cycleStartMS, fromMS)-capacityLatencyLookbackMS), fromMS, toMS)
	return usage, reason, err
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
