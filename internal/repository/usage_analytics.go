package repository

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"
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

	tx, err := r.SQL().BeginTx(ctx, nil)
	if err != nil {
		return 0, fmt.Errorf("begin usage rollup: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	var lastID int64
	err = tx.QueryRowContext(ctx, `
		SELECT last_usage_event_id FROM usage_aggregation_checkpoints WHERE name = ?`, grain).Scan(&lastID)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return 0, fmt.Errorf("read checkpoint inside rollup tx: %w", err)
	}

	var highID sql.NullInt64
	err = tx.QueryRowContext(ctx, `
		SELECT MAX(id) FROM (SELECT id FROM usage_events WHERE id > ? ORDER BY id ASC LIMIT ?)`,
		lastID, batchSize).Scan(&highID)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return 0, fmt.Errorf("find aggregation high water: %w", err)
	}
	if !highID.Valid {
		return 0, nil
	}

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

	nowMS := time.Now().UnixMilli()
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO usage_aggregation_checkpoints (name, last_usage_event_id, stats_updated_at_ms, created_at_ms, updated_at_ms)
		VALUES (?, ?, ?, ?, ?)
		ON CONFLICT(name) DO UPDATE SET
			last_usage_event_id = CASE WHEN excluded.last_usage_event_id > usage_aggregation_checkpoints.last_usage_event_id
				THEN excluded.last_usage_event_id ELSE usage_aggregation_checkpoints.last_usage_event_id END,
			stats_updated_at_ms = excluded.stats_updated_at_ms,
			updated_at_ms = excluded.updated_at_ms`,
		grain, highID.Int64, nowMS, nowMS, nowMS); err != nil {
		return 0, fmt.Errorf("advance checkpoint in rollup tx %s: %w", grain, err)
	}

	if err := tx.Commit(); err != nil {
		return 0, fmt.Errorf("commit usage rollup: %w", err)
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
		// An hourly (or daily) rollup row cannot be split across a finer grid. Every
		// rollup timestamp is already a multiple of any bucket that divides its
		// grain, so re-aligning collapses the whole hour onto its first bucket and
		// reports the rest of it as zero: the window total stays right while the
		// distribution is wrong, which is how a chart shows one spike per hour and
		// an empty window immediately after a request.
		//
		// The detail rows are still there for the whole retention window, so when the
		// requested grid is finer than the grain, read them instead. That costs more
		// rows, but it is the only way to bucket below the aggregation grain; the
		// rollup stays the cheap path for hourly and coarser requests.
		if bucketMS < grainMS {
			totals, buckets, errQuery := r.readEventWindow(ctx, instanceID, rollupFrom, rollupEnd-1, bucketMS)
			if errQuery != nil {
				return UsageAnalytics{}, errQuery
			}
			appendWindow(totals, buckets, false)
		} else {
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
	// Totals are the sum of the same buckets; avoid scanning the window twice.

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
		totals.add(bucket.UsageTotals)
		buckets = append(buckets, bucket)
	}
	if err := rows.Err(); err != nil {
		return totals, nil, fmt.Errorf("iterate usage rollup buckets: %w", err)
	}
	return totals, buckets, nil
}

func (r *Repository) readEventWindow(ctx context.Context, instanceID string, fromMS, toMS, bucketMS int64) (UsageTotals, []UsageBucket, error) {
	var totals UsageTotals
	// Totals are the sum of the same buckets; avoid scanning the window twice.

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
		totals.add(bucket.UsageTotals)
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

// UsageDayWindow is one local calendar day, expressed as the exact instant range it
// covers on the viewer's calendar.
//
// The window carries its own bounds rather than leaving the caller to recompute them
// because the two must not be derived twice: the day a request is attributed to and
// the day a drill-down opens are the same interval, and a second derivation is a
// second chance to disagree.
type UsageDayWindow struct {
	Day string
	// FromMS and ToMS are inclusive. ToMS of the final day is the read instant
	// rather than the end of that day, so records timestamped in the future cannot
	// contribute to today's total.
	FromMS int64
	ToMS   int64
}

// UsageDayTotals is one local day's token volume.
//
// It is deliberately not a `UsageBucket`: a day and a sparkline bucket are different
// concepts that happen to share a shape, and one shared type would invite a daily
// series into a trend line.
type UsageDayTotals struct {
	Day        string
	FromMS     int64
	ToMS       int64
	Tokens     int64
	Requests   int64
	Failures   int64
	Input      int64
	Output     int64
	Reasoning  int64
	CacheRead  int64
	CacheWrite int64
}

// QueryDailyTokenTotals aggregates one window of request records per local day.
//
// Days are supplied by the caller as exact instant ranges, which is what makes this
// exact under a real timezone. The alternative - grouping the hourly rollup by an
// offset-shifted bucket start - is wrong for any offset that is not a whole hour: a
// UTC hour straddling a fractional-offset local midnight (India's :30, Nepal's :45)
// belongs to two local days, and a rollup row cannot be split. The same fold is also
// wrong across a daylight-saving transition, where the offset in force is not the
// offset the rest of the span used.
//
// So this reads the detail table, which carries a per-request timestamp, and lets
// SQLite bucket it: the whole aggregation stays inside the database and at most one
// row per day crosses into Go, which is the reason the rollup existed. The scan is
// bounded by the retention window (400 days by default) rather than by total history,
// and the panel calls it once per visit on a five-minute cache, not on the dashboard's
// poll cadence.
//
// Unlike `QueryUsageAnalytics` there is no rollup-plus-tail split here, and that is
// deliberate: the split needs a boundary that is disjoint for both halves, and the
// hourly checkpoint is not one. A request that arrives with an earlier timestamp
// after its hour was folded - CPA event times can arrive slightly out of order - sits
// on the detail side of the boundary while its own hour is already inside the rollup,
// so a hybrid read counts it twice. One source has no boundary to get wrong.
func (r *Repository) QueryDailyTokenTotals(ctx context.Context, instanceID string, days []UsageDayWindow) ([]UsageDayTotals, error) {
	result := make([]UsageDayTotals, 0, len(days))
	for _, window := range days {
		result = append(result, UsageDayTotals{Day: window.Day, FromMS: window.FromMS, ToMS: window.ToMS})
	}
	if r == nil || r.SQL() == nil {
		return nil, errors.New("repository is not initialized")
	}
	if len(days) == 0 {
		return result, nil
	}
	for _, window := range days {
		if window.ToMS < window.FromMS {
			return nil, fmt.Errorf("day window %s is negative", window.Day)
		}
	}

	// The days are contiguous, so the union of their ranges is a single range and
	// every row inside it belongs to exactly one day. The final day's `to` doubles as
	// the range's upper bound, so it is not bound again in the CASE ladder.
	from := days[0].FromMS
	to := days[len(days)-1].ToMS
	args := make([]any, 0, len(days)+2)
	args = append(args, instanceID, from, to)
	var ladder strings.Builder
	ladder.WriteString("CASE")
	for index, window := range days[:len(days)-1] {
		ladder.WriteString(fmt.Sprintf(" WHEN timestamp_ms <= ?%d THEN %d", len(args)+1, index))
		args = append(args, window.ToMS)
	}
	ladder.WriteString(fmt.Sprintf(" ELSE %d END", len(days)-1))

	query := `
		SELECT ` + ladder.String() + ` AS day_index,
		       COUNT(1), COALESCE(SUM(failed), 0),
		       COALESCE(SUM(input_tokens), 0), COALESCE(SUM(output_tokens), 0),
		       COALESCE(SUM(reasoning_tokens), 0), COALESCE(SUM(cache_read_tokens), 0),
		       COALESCE(SUM(cache_creation_tokens), 0), COALESCE(SUM(total_tokens), 0)
		FROM usage_events
		WHERE instance_id = ?1 AND timestamp_ms >= ?2 AND timestamp_ms <= ?3
		GROUP BY day_index
		ORDER BY day_index ASC`

	rows, err := r.SQL().QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("read daily token totals: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var index int
		var day UsageDayTotals
		if errScan := rows.Scan(&index, &day.Requests, &day.Failures, &day.Input, &day.Output,
			&day.Reasoning, &day.CacheRead, &day.CacheWrite, &day.Tokens); errScan != nil {
			return nil, fmt.Errorf("scan daily token totals: %w", errScan)
		}
		if index < 0 || index >= len(result) {
			// Unreachable while the ladder and the range describe the same days, and
			// reported rather than silently dropped: an out-of-range index would be a
			// day's traffic vanishing from a total that still looks complete.
			return nil, fmt.Errorf("daily token bucket %d is outside the requested %d days", index, len(days))
		}
		result[index].Requests = day.Requests
		result[index].Failures = day.Failures
		result[index].Input = day.Input
		result[index].Output = day.Output
		result[index].Reasoning = day.Reasoning
		result[index].CacheRead = day.CacheRead
		result[index].CacheWrite = day.CacheWrite
		result[index].Tokens = day.Tokens
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate daily token totals: %w", err)
	}
	return result, nil
}

// FirstUsageEventMS reports the earliest request record for one instance, or nil when
// none has been captured.
//
// It answers a question about the record, not about the collector: a request is only
// in here once it has been captured and decoded, so a day before this instant has no
// stored usage. Whether the collector was running, and whether it lost anything, is
// not something this can see, and the panel's copy says only what is known.
func (r *Repository) FirstUsageEventMS(ctx context.Context, instanceID string) (*int64, error) {
	if r == nil || r.SQL() == nil {
		return nil, errors.New("repository is not initialized")
	}
	var value *int64
	err := r.SQL().QueryRowContext(ctx,
		`SELECT MIN(timestamp_ms) FROM usage_events WHERE instance_id = ?`, instanceID).Scan(&value)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return nil, fmt.Errorf("read first usage event: %w", err)
	}
	return value, nil
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
