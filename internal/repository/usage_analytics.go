package repository

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"sort"
)

// Grain bucket widths in milliseconds.
const (
	HourBucketMS int64 = 60 * 60 * 1000
	DayBucketMS  int64 = 24 * 60 * 60 * 1000
)

// UsageTotals aggregates one window of CPA activity.
type UsageTotals struct {
	Requests            int64
	Failures            int64
	InputTokens         int64
	OutputTokens        int64
	ReasoningTokens     int64
	CachedTokens        int64
	CacheReadTokens     int64
	CacheCreationTokens int64
	TotalTokens         int64
	LatencySumMS        int64
	TTFTSumMS           int64
	TTFTCount           int64
}

func (t *UsageTotals) add(other UsageTotals) {
	t.Requests += other.Requests
	t.Failures += other.Failures
	t.InputTokens += other.InputTokens
	t.OutputTokens += other.OutputTokens
	t.ReasoningTokens += other.ReasoningTokens
	t.CachedTokens += other.CachedTokens
	t.CacheReadTokens += other.CacheReadTokens
	t.CacheCreationTokens += other.CacheCreationTokens
	t.TotalTokens += other.TotalTokens
	t.LatencySumMS += other.LatencySumMS
	t.TTFTSumMS += other.TTFTSumMS
	t.TTFTCount += other.TTFTCount
}

// UsageBucket is one sparkline point.
type UsageBucket struct {
	StartMS int64
	UsageTotals
}

// UsageAnalytics answers a dashboard window.
type UsageAnalytics struct {
	Totals  UsageTotals
	Buckets []UsageBucket
	// FromRollup counts requests answered from pre-aggregated buckets; the rest
	// came from the detail table. Exposed so the UI can be honest about lag.
	FromRollup int64
	FromEvents int64
}

// AggregateUsageGrain folds events beyond a grain's checkpoint into its rollup
// table and returns the number of events absorbed.
//
// Each event lands in exactly one bucket per grain and the checkpoint only
// advances over ids this pass covered, so repeated runs cannot double count.
func (r *Repository) AggregateUsageGrain(ctx context.Context, grain string, bucketMS int64, batchSize int) (int, error) {
	if r == nil || r.SQL() == nil {
		return 0, errors.New("repository is not initialized")
	}
	if bucketMS <= 0 {
		return 0, fmt.Errorf("invalid rollup bucket width %d", bucketMS)
	}
	if batchSize <= 0 {
		batchSize = 5000
	}
	table, err := rollupTable(grain)
	if err != nil {
		return 0, err
	}
	lastID, err := r.UsageCheckpoint(ctx, grain)
	if err != nil {
		return 0, err
	}

	var highID sql.NullInt64
	err = r.SQL().QueryRowContext(ctx, `
		SELECT MAX(id) FROM (SELECT id FROM usage_events WHERE id > ? ORDER BY id ASC LIMIT ?)`,
		lastID, batchSize).Scan(&highID)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return 0, fmt.Errorf("find aggregation high water: %w", err)
	}
	if !highID.Valid {
		return 0, nil
	}

	tx, err := r.SQL().BeginTx(ctx, nil)
	if err != nil {
		return 0, fmt.Errorf("begin usage rollup: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	// INSERT..SELECT keeps aggregation inside SQLite: the detail rows never
	// cross the Go boundary, which is the whole reason the rollup exists.
	result, err := tx.ExecContext(ctx, `
		INSERT INTO `+table+` (
			instance_id, bucket_start_ms, api_group_key, model, auth_index, model_alias,
			requests, failures, input_tokens, output_tokens, reasoning_tokens, cached_tokens,
			cache_read_tokens, cache_creation_tokens, total_tokens,
			latency_sum_ms, ttft_sum_ms, ttft_count, updated_at_ms
		)
		SELECT instance_id, (timestamp_ms / ?) * ?, api_group_key, model, auth_index,
		       COALESCE(model_alias, ''),
		       COUNT(1), SUM(failed), SUM(input_tokens), SUM(output_tokens), SUM(reasoning_tokens),
		       SUM(cached_tokens), SUM(cache_read_tokens), SUM(cache_creation_tokens), SUM(total_tokens),
		       SUM(latency_ms), SUM(COALESCE(ttft_ms, 0)),
		       SUM(CASE WHEN ttft_ms IS NOT NULL THEN 1 ELSE 0 END),
		       unixepoch() * 1000
		FROM usage_events
		WHERE id > ? AND id <= ?
		GROUP BY instance_id, (timestamp_ms / ?) * ?, api_group_key, model, auth_index, COALESCE(model_alias, '')
		ON CONFLICT(instance_id, bucket_start_ms, api_group_key, model, auth_index, model_alias) DO UPDATE SET
			requests = requests + excluded.requests,
			failures = failures + excluded.failures,
			input_tokens = input_tokens + excluded.input_tokens,
			output_tokens = output_tokens + excluded.output_tokens,
			reasoning_tokens = reasoning_tokens + excluded.reasoning_tokens,
			cached_tokens = cached_tokens + excluded.cached_tokens,
			cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens,
			cache_creation_tokens = cache_creation_tokens + excluded.cache_creation_tokens,
			total_tokens = total_tokens + excluded.total_tokens,
			latency_sum_ms = latency_sum_ms + excluded.latency_sum_ms,
			ttft_sum_ms = ttft_sum_ms + excluded.ttft_sum_ms,
			ttft_count = ttft_count + excluded.ttft_count,
			updated_at_ms = excluded.updated_at_ms`,
		bucketMS, bucketMS, lastID, highID.Int64, bucketMS, bucketMS)
	if err != nil {
		return 0, fmt.Errorf("aggregate usage rollup %s: %w", grain, err)
	}
	absorbed, _ := result.RowsAffected()
	if err := tx.Commit(); err != nil {
		return 0, fmt.Errorf("commit usage rollup: %w", err)
	}
	if err := r.SetUsageCheckpoint(ctx, grain, highID.Int64); err != nil {
		return int(absorbed), err
	}
	return int(absorbed), nil
}

func rollupTable(grain string) (string, error) {
	switch grain {
	case CheckpointHourly:
		return "usage_overview_hourly_stats", nil
	case CheckpointDaily:
		return "usage_overview_daily_stats", nil
	default:
		return "", fmt.Errorf("unknown rollup grain %q", grain)
	}
}

// QueryUsageAnalytics answers a window using the rollup for everything already
// aggregated and the detail table for the fresh tail.
//
// Two boundaries keep the hybrid exact:
//
//   - left: rollup buckets only align to the grain, so a window starting
//     mid-bucket reads that partial bucket from the detail table instead of
//     dropping it whole.
//   - right: everything at or after the oldest unaggregated event time is read
//     from the detail table. A timestamp boundary is required rather than an id
//     because CPA event times can arrive slightly out of order.
func (r *Repository) QueryUsageAnalytics(ctx context.Context, instanceID string, fromMS, toMS, bucketMS int64) (UsageAnalytics, error) {
	result := UsageAnalytics{Buckets: []UsageBucket{}}
	if r == nil || r.SQL() == nil {
		return result, errors.New("repository is not initialized")
	}
	if toMS <= fromMS {
		return result, fmt.Errorf("analytics window must be positive")
	}
	if bucketMS <= 0 {
		return result, fmt.Errorf("invalid analytics bucket width %d", bucketMS)
	}

	grain := CheckpointHourly
	grainMS := HourBucketMS
	if toMS-fromMS > 7*DayBucketMS {
		grain = CheckpointDaily
		grainMS = DayBucketMS
	}
	coveredUntil, err := r.OldestUnaggregatedEventMS(ctx, grain)
	if err != nil {
		return UsageAnalytics{}, err
	}
	rollupEnd := toMS + 1
	if coveredUntil != nil && *coveredUntil <= toMS {
		rollupEnd = *coveredUntil
	}
	// First grain-aligned bucket that lies entirely inside the window.
	rollupFrom := fromMS
	if aligned := ((fromMS + int64(grainMS) - 1) / int64(grainMS)) * int64(grainMS); aligned > rollupFrom {
		rollupFrom = aligned
	}

	appendWindow := func(totals UsageTotals, buckets []UsageBucket, fromRollup bool) {
		result.Totals.add(totals)
		if fromRollup {
			result.FromRollup += totals.Requests
		} else {
			result.FromEvents += totals.Requests
		}
		result.Buckets = mergeBuckets(result.Buckets, buckets)
	}

	// Partial leading bucket straight from the detail table.
	if rollupFrom > fromMS {
		totals, buckets, errQuery := r.readEventWindow(ctx, instanceID, fromMS, rollupFrom-1, bucketMS)
		if errQuery != nil {
			return UsageAnalytics{}, errQuery
		}
		appendWindow(totals, buckets, false)
	}

	if rollupFrom < rollupEnd {
		table, errTable := rollupTable(grain)
		if errTable != nil {
			return UsageAnalytics{}, errTable
		}
		totals, buckets, errQuery := r.readRollupWindow(ctx, table, instanceID, rollupFrom, rollupEnd, bucketMS)
		if errQuery != nil {
			return UsageAnalytics{}, errQuery
		}
		appendWindow(totals, buckets, true)
	}

	// Everything at or after the aggregation watermark. The tail cannot start
	// before rollupFrom, because that span was already read as the partial
	// leading bucket; with nothing aggregated yet the watermark sits at the
	// oldest event and an unclamped tail would double count it.
	tailStart := rollupEnd
	if rollupFrom > tailStart {
		tailStart = rollupFrom
	}
	if tailStart <= toMS {
		totals, buckets, errQuery := r.readEventWindow(ctx, instanceID, tailStart, toMS, bucketMS)
		if errQuery != nil {
			return UsageAnalytics{}, errQuery
		}
		appendWindow(totals, buckets, false)
	}
	return result, nil
}

const rollupTotalsColumns = `
	COALESCE(SUM(requests), 0), COALESCE(SUM(failures), 0),
	COALESCE(SUM(input_tokens), 0), COALESCE(SUM(output_tokens), 0),
	COALESCE(SUM(reasoning_tokens), 0), COALESCE(SUM(cached_tokens), 0),
	COALESCE(SUM(cache_read_tokens), 0), COALESCE(SUM(cache_creation_tokens), 0),
	COALESCE(SUM(total_tokens), 0), COALESCE(SUM(latency_sum_ms), 0),
	COALESCE(SUM(ttft_sum_ms), 0), COALESCE(SUM(ttft_count), 0)`

const eventTotalsColumns = `
	COUNT(1), COALESCE(SUM(failed), 0),
	COALESCE(SUM(input_tokens), 0), COALESCE(SUM(output_tokens), 0),
	COALESCE(SUM(reasoning_tokens), 0), COALESCE(SUM(cached_tokens), 0),
	COALESCE(SUM(cache_read_tokens), 0), COALESCE(SUM(cache_creation_tokens), 0),
	COALESCE(SUM(total_tokens), 0), COALESCE(SUM(latency_ms), 0),
	COALESCE(SUM(COALESCE(ttft_ms, 0)), 0), COALESCE(SUM(CASE WHEN ttft_ms IS NOT NULL THEN 1 ELSE 0 END), 0)`

func (r *Repository) readRollupWindow(ctx context.Context, table, instanceID string, fromMS, toMS, bucketMS int64) (UsageTotals, []UsageBucket, error) {
	var totals UsageTotals
	err := r.SQL().QueryRowContext(ctx, `
		SELECT `+rollupTotalsColumns+`
		FROM `+table+`
		WHERE instance_id = ? AND bucket_start_ms >= ? AND bucket_start_ms < ?`,
		instanceID, fromMS, toMS).Scan(scanTargets(&totals)...)
	if err != nil {
		return totals, nil, fmt.Errorf("read usage rollup totals: %w", err)
	}

	rows, err := r.SQL().QueryContext(ctx, `
		SELECT (bucket_start_ms / ?) * ? AS aligned, `+rollupTotalsColumns+`
		FROM `+table+`
		WHERE instance_id = ? AND bucket_start_ms >= ? AND bucket_start_ms < ?
		GROUP BY aligned
		ORDER BY aligned ASC`,
		bucketMS, bucketMS, instanceID, fromMS, toMS)
	if err != nil {
		return totals, nil, fmt.Errorf("read usage rollup buckets: %w", err)
	}
	defer rows.Close()

	buckets := make([]UsageBucket, 0, 64)
	for rows.Next() {
		var bucket UsageBucket
		if errScan := rows.Scan(scanBucketTargets(&bucket)...); errScan != nil {
			return totals, nil, fmt.Errorf("scan usage rollup bucket: %w", errScan)
		}
		buckets = append(buckets, bucket)
	}
	if err := rows.Err(); err != nil {
		return totals, nil, fmt.Errorf("iterate usage rollup buckets: %w", err)
	}
	return totals, buckets, nil
}

func (r *Repository) readEventWindow(ctx context.Context, instanceID string, fromMS, toMS, bucketMS int64) (UsageTotals, []UsageBucket, error) {
	var totals UsageTotals
	err := r.SQL().QueryRowContext(ctx, `
		SELECT `+eventTotalsColumns+`
		FROM usage_events
		WHERE instance_id = ? AND timestamp_ms >= ? AND timestamp_ms <= ?`,
		instanceID, fromMS, toMS).Scan(scanTargets(&totals)...)
	if err != nil {
		return totals, nil, fmt.Errorf("read usage event totals: %w", err)
	}

	rows, err := r.SQL().QueryContext(ctx, `
		SELECT (timestamp_ms / ?) * ? AS aligned, `+eventTotalsColumns+`
		FROM usage_events
		WHERE instance_id = ? AND timestamp_ms >= ? AND timestamp_ms <= ?
		GROUP BY aligned
		ORDER BY aligned ASC`,
		bucketMS, bucketMS, instanceID, fromMS, toMS)
	if err != nil {
		return totals, nil, fmt.Errorf("read usage event buckets: %w", err)
	}
	defer rows.Close()

	buckets := make([]UsageBucket, 0, 64)
	for rows.Next() {
		var bucket UsageBucket
		if errScan := rows.Scan(scanBucketTargets(&bucket)...); errScan != nil {
			return totals, nil, fmt.Errorf("scan usage event bucket: %w", errScan)
		}
		buckets = append(buckets, bucket)
	}
	if err := rows.Err(); err != nil {
		return totals, nil, fmt.Errorf("iterate usage event buckets: %w", err)
	}
	return totals, buckets, nil
}

func scanTargets(totals *UsageTotals) []any {
	return []any{
		&totals.Requests, &totals.Failures, &totals.InputTokens, &totals.OutputTokens,
		&totals.ReasoningTokens, &totals.CachedTokens, &totals.CacheReadTokens,
		&totals.CacheCreationTokens, &totals.TotalTokens, &totals.LatencySumMS,
		&totals.TTFTSumMS, &totals.TTFTCount,
	}
}

func scanBucketTargets(bucket *UsageBucket) []any {
	return append([]any{&bucket.StartMS}, scanTargets(&bucket.UsageTotals)...)
}

func mergeBuckets(primary, extra []UsageBucket) []UsageBucket {
	if len(extra) == 0 {
		return primary
	}
	index := make(map[int64]int, len(primary))
	for position, bucket := range primary {
		index[bucket.StartMS] = position
	}
	for _, bucket := range extra {
		if position, exists := index[bucket.StartMS]; exists {
			primary[position].add(bucket.UsageTotals)
			continue
		}
		primary = append(primary, bucket)
		index[bucket.StartMS] = len(primary) - 1
	}
	// Appended tail buckets can sort after merged ones; keep the series ordered.
	sort.Slice(primary, func(i, j int) bool { return primary[i].StartMS < primary[j].StartMS })
	return primary
}
