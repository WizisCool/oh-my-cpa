package repository

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"
)

// CheckpointFacts names the single watermark both fact grains advance under.
const CheckpointFacts = "facts"

// QuarterHourBucketMS is the fine fact grain. Every civil UTC offset in use is a
// multiple of it, so a local calendar day is a whole number of buckets in any
// deployment timezone.
const QuarterHourBucketMS int64 = 15 * 60 * 1000

// LifecycleUsageDetail is the lifecycle policy that rolls request records.
const LifecycleUsageDetail = "usage_detail"

const (
	usageFactsFineTable  = "usage_facts_15m"
	usageFactsDailyTable = "usage_facts_daily"
)

// usageFactDimensions are the columns a fact row is keyed on besides its bucket.
// usage_events carries the same names, so one expression groups either source.
const usageFactDimensions = `api_group_key, model, model_alias, auth_index, provider, auth_type`

// usageFactMeasures lists the additive columns, in the order every read scans them.
var usageFactMeasures = []string{
	"requests", "failures", "input_tokens", "output_tokens", "reasoning_tokens",
	"cached_tokens", "cache_read_tokens", "cache_creation_tokens", "total_tokens",
	"latency_sum_ms", "ttft_sum_ms", "ttft_count", "cost_nanos", "priced_requests",
	"costed_requests",
}

// usageEventMeasures is one request record expressed as the same measures, so a
// record that has not been folded yet contributes exactly what its fact row will.
const usageEventMeasures = `
	1 AS requests, failed AS failures, input_tokens, output_tokens, reasoning_tokens,
	cached_tokens, cache_read_tokens, cache_creation_tokens, total_tokens,
	latency_ms AS latency_sum_ms, COALESCE(ttft_ms, 0) AS ttft_sum_ms,
	(ttft_ms IS NOT NULL) AS ttft_count, COALESCE(cost_nanos, 0) AS cost_nanos,
	(pricing_status = 'priced') AS priced_requests, (cost_nanos IS NOT NULL) AS costed_requests`

// UsageFactGrouping selects how a usage read partitions its rows.
//
// A new way to slice the dashboard is one more value here with its SQL
// expression in usageFactGroupExpressions: the fact tables already carry every
// dimension, and the composition of facts and unfolded records is shared.
type UsageFactGrouping string

const (
	// UsageGroupNone returns one series for the whole deployment.
	UsageGroupNone UsageFactGrouping = ""
	// UsageGroupModel partitions by the upstream model name as CPA recorded it.
	UsageGroupModel UsageFactGrouping = "model"
	// UsageGroupCallPoint partitions by the model alias a client requested,
	// falling back to the upstream model name when no alias was set.
	UsageGroupCallPoint UsageFactGrouping = "call_point"
	// UsageGroupProviderCredential partitions by provider label and, for API-key
	// requests, by the credential that served them. CPA labels an API-key request
	// with its family, the same label an OAuth request of that family carries, so
	// the label alone cannot say which configured provider answered.
	UsageGroupProviderCredential UsageFactGrouping = "provider_credential"
)

// usageFactGroupExpressions maps a grouping to its primary and secondary key.
// The expressions only use columns present on both the fact tables and
// usage_events; model_alias is nullable on the latter, hence the COALESCE.
var usageFactGroupExpressions = map[UsageFactGrouping][2]string{
	UsageGroupNone:      {`''`, `''`},
	UsageGroupModel:     {`model`, `''`},
	UsageGroupCallPoint: {`COALESCE(NULLIF(TRIM(COALESCE(model_alias, '')), ''), model)`, `''`},
	UsageGroupProviderCredential: {
		`COALESCE(NULLIF(TRIM(provider), ''), 'unknown')`,
		`CASE WHEN auth_type = 'apikey' THEN TRIM(auth_index) ELSE '' END`,
	},
}

// UsageMeasures is the additive content of one fact row or one request record.
type UsageMeasures struct {
	UsageTotals
	// CostNanos sums request-time cost snapshots; a request with no usable price
	// contributes nothing rather than a fabricated zero price.
	CostNanos int64
	// PricedRequests counts requests priced at request time. Requests minus this
	// is the number the cost leaves out.
	PricedRequests int64
	// CostedRequests counts requests that carry a stored cost.
	CostedRequests int64
}

func (m *UsageMeasures) add(other UsageMeasures) {
	m.UsageTotals.add(other.UsageTotals)
	m.CostNanos += other.CostNanos
	m.PricedRequests += other.PricedRequests
	m.CostedRequests += other.CostedRequests
}

// UsageFactQuery is one read of deployment usage.
type UsageFactQuery struct {
	InstanceID string
	// FromMS and ToMS are inclusive.
	FromMS int64
	ToMS   int64
	// BucketMS is the series grid. Zero returns one row per group for the whole
	// window, with StartMS zero.
	BucketMS int64
	GroupBy  UsageFactGrouping
	// APIGroupKey narrows the read to one client key fingerprint.
	APIGroupKey string
}

// UsageFactRow is one group's usage inside one bucket.
type UsageFactRow struct {
	Group string
	// SubGroup is the secondary key of a grouping that has one, empty otherwise.
	SubGroup string
	StartMS  int64
	UsageMeasures
}

// UsageFactResult is a usage read together with what it actually covered.
type UsageFactResult struct {
	// Rows are ordered by group, sub-group and bucket.
	Rows []UsageFactRow
	// FromMS, ToMS and BucketMS are the window that was read. They differ from the
	// request only where request records for part of it have been deleted: the
	// window is then widened to whole fact buckets, because a bucket cannot be
	// split once the records behind it are gone.
	FromMS   int64
	ToMS     int64
	BucketMS int64
	// FactRequests were answered from the fact tables and DetailRequests from
	// request records, so a caller can say how much of a window was pre-aggregated.
	FactRequests   int64
	DetailRequests int64
}

// Totals sums every row of the read.
func (result UsageFactResult) Totals() UsageMeasures {
	var totals UsageMeasures
	for _, row := range result.Rows {
		totals.add(row.UsageMeasures)
	}
	return totals
}

// usageFactPlan says which source answers which part of a window.
//
// The window is cut on the fact grid: whole days come from the daily table, the
// remaining whole quarter hours from the fine table, and the sub-bucket edges
// from request records. Every request record past the checkpoint is read from
// usage_events wherever it falls, because no fact row contains it yet.
type usageFactPlan struct {
	fromMS, toMS, bucketMS int64
	// fineFrom and fineTo bound the quarter-hour-aligned core, [fineFrom, fineTo).
	// Equal values mean no fact table is read.
	fineFrom, fineTo int64
	// dailyFrom and dailyTo bound the whole days inside the core, [dailyFrom,
	// dailyTo). Equal values mean the fine table answers the whole core.
	dailyFrom, dailyTo int64
}

func alignDown(value, step int64) int64 { return (value / step) * step }

func alignUp(value, step int64) int64 { return ((value + step - 1) / step) * step }

// AlignUsageWindow widens a window so every part of it can still be answered.
//
// Request records before horizonMS have been deleted, so an edge that reaches
// behind it can only be read as whole fact buckets, and a grid finer than the
// fact grain has nothing left to bucket. The horizon itself is always a whole
// day, so a bucket is either entirely readable from request records or not at all.
func AlignUsageWindow(horizonMS, fromMS, toMS, bucketMS int64) (int64, int64, int64) {
	if fromMS < horizonMS {
		fromMS = alignDown(fromMS, QuarterHourBucketMS)
		if bucketMS > 0 && bucketMS%QuarterHourBucketMS != 0 {
			bucketMS = alignUp(bucketMS, QuarterHourBucketMS)
		}
	}
	if toMS < horizonMS {
		toMS = alignUp(toMS+1, QuarterHourBucketMS) - 1
	}
	return fromMS, toMS, bucketMS
}

func planUsageFactRead(horizonMS, fromMS, toMS, bucketMS int64) usageFactPlan {
	fromMS, toMS, bucketMS = AlignUsageWindow(horizonMS, fromMS, toMS, bucketMS)
	plan := usageFactPlan{fromMS: fromMS, toMS: toMS, bucketMS: bucketMS}

	// A fact row cannot be split across a grid finer than its grain: re-aligning
	// it would report the whole bucket in its first slot and the rest as zero,
	// leaving the total right and the distribution wrong. Such a grid is read from
	// request records alone.
	if bucketMS > 0 && bucketMS%QuarterHourBucketMS != 0 {
		return plan
	}
	fineFrom := alignUp(fromMS, QuarterHourBucketMS)
	fineTo := alignDown(toMS+1, QuarterHourBucketMS)
	if fineFrom >= fineTo {
		return plan
	}
	plan.fineFrom, plan.fineTo = fineFrom, fineTo
	plan.dailyFrom, plan.dailyTo = fineFrom, fineFrom

	if bucketMS == 0 || bucketMS%DayBucketMS == 0 {
		dailyFrom := alignUp(fromMS, DayBucketMS)
		dailyTo := alignDown(toMS+1, DayBucketMS)
		if dailyFrom < dailyTo {
			plan.dailyFrom, plan.dailyTo = dailyFrom, dailyTo
		}
	}
	return plan
}

// QueryUsageFacts answers one usage window, for any grouping, from the permanent
// facts plus whatever request records the facts do not cover yet.
//
// It is one SQL statement on purpose. The parts are only disjoint against a
// single view of the checkpoint: a fold committing between two statements would
// move records from "past the checkpoint" into the fact tables and one of the
// two reads would count them twice or not at all. A statement reads one snapshot.
//
// The boundary between facts and records is the event id, not a timestamp. CPA
// reports a request's start time, so records arrive out of time order; an id
// boundary is exact regardless, because a fold covers precisely the ids up to
// its checkpoint.
func (r *Repository) QueryUsageFacts(ctx context.Context, query UsageFactQuery) (UsageFactResult, error) {
	result := UsageFactResult{Rows: []UsageFactRow{}}
	if r == nil || r.SQL() == nil {
		return result, errors.New("repository is not initialized")
	}
	if query.ToMS < query.FromMS {
		return result, errors.New("usage window is negative")
	}
	if query.BucketMS < 0 {
		return result, fmt.Errorf("invalid usage bucket width %d", query.BucketMS)
	}
	groupExpressions, known := usageFactGroupExpressions[query.GroupBy]
	if !known {
		return result, fmt.Errorf("unknown usage grouping %q", query.GroupBy)
	}
	horizonMS, err := r.LifecycleHorizonMS(ctx, LifecycleUsageDetail)
	if err != nil {
		return result, err
	}
	plan := planUsageFactRead(horizonMS, query.FromMS, query.ToMS, query.BucketMS)
	result.FromMS, result.ToMS, result.BucketMS = plan.fromMS, plan.toMS, plan.bucketMS

	statement, args := buildUsageFactStatement(plan, query, groupExpressions)
	rows, err := r.SQL().QueryContext(ctx, statement, args...)
	if err != nil {
		return result, fmt.Errorf("read usage facts: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var row UsageFactRow
		var factRequests int64
		targets := []any{&row.Group, &row.SubGroup, &row.StartMS}
		targets = append(targets, usageMeasureTargets(&row.UsageMeasures)...)
		targets = append(targets, &factRequests)
		if errScan := rows.Scan(targets...); errScan != nil {
			return result, fmt.Errorf("scan usage fact row: %w", errScan)
		}
		result.FactRequests += factRequests
		result.DetailRequests += row.Requests - factRequests
		result.Rows = append(result.Rows, row)
	}
	if err := rows.Err(); err != nil {
		return result, fmt.Errorf("iterate usage facts: %w", err)
	}
	return result, nil
}

func usageMeasureTargets(measures *UsageMeasures) []any {
	return append(scanTargets(&measures.UsageTotals),
		&measures.CostNanos, &measures.PricedRequests, &measures.CostedRequests)
}

func buildUsageFactStatement(plan usageFactPlan, query UsageFactQuery, groupExpressions [2]string) (string, []any) {
	aligned := func(column string) string {
		if plan.bucketMS == 0 {
			return "0"
		}
		return fmt.Sprintf("(%s / %d) * %d", column, plan.bucketMS, plan.bucketMS)
	}
	keyFilter := ""
	if query.APIGroupKey != "" {
		keyFilter = " AND api_group_key = ?"
	}
	withKey := func(args ...any) []any {
		if query.APIGroupKey != "" {
			args = append(args, query.APIGroupKey)
		}
		return args
	}

	var parts []string
	var args []any
	factArm := func(table string, fromMS, toMS int64) {
		if fromMS >= toMS {
			return
		}
		parts = append(parts, `
			SELECT 1 AS from_facts, `+groupExpressions[0]+` AS group_key, `+groupExpressions[1]+` AS sub_group_key,
			       `+aligned("bucket_start_ms")+` AS aligned, `+strings.Join(usageFactMeasures, ", ")+`
			FROM `+table+`
			WHERE instance_id = ? AND bucket_start_ms >= ? AND bucket_start_ms < ?`+keyFilter)
		args = append(args, withKey(query.InstanceID, fromMS, toMS)...)
	}
	// Each arm over usage_events names its index. The planner cannot know that the
	// records past the checkpoint are a handful while the window may span years,
	// and the wrong choice turns the dashboard's five-second poll into a scan of
	// every retained record.
	eventArm := func(index, predicate string, predicateArgs ...any) {
		parts = append(parts, `
			SELECT 0 AS from_facts, `+groupExpressions[0]+` AS group_key, `+groupExpressions[1]+` AS sub_group_key,
			       `+aligned("timestamp_ms")+` AS aligned, `+usageEventMeasures+`
			FROM usage_events INDEXED BY `+index+`
			WHERE instance_id = ? AND `+predicate+keyFilter)
		args = append(args, withKey(append([]any{query.InstanceID}, predicateArgs...)...)...)
	}
	const checkpoint = `(SELECT last_usage_event_id FROM usage_aggregation_checkpoints WHERE name = '` + CheckpointFacts + `')`

	if plan.fineFrom < plan.fineTo {
		factArm(usageFactsDailyTable, plan.dailyFrom, plan.dailyTo)
		factArm(usageFactsFineTable, plan.fineFrom, plan.dailyFrom)
		factArm(usageFactsFineTable, plan.dailyTo, plan.fineTo)
		// Folded records on the sub-bucket edges, which no whole fact bucket covers.
		if plan.fromMS < plan.fineFrom {
			eventArm("idx_usage_events_instance_time",
				`timestamp_ms >= ? AND timestamp_ms < ? AND id <= `+checkpoint, plan.fromMS, plan.fineFrom)
		}
		if plan.fineTo <= plan.toMS {
			eventArm("idx_usage_events_instance_time",
				`timestamp_ms >= ? AND timestamp_ms <= ? AND id <= `+checkpoint, plan.fineTo, plan.toMS)
		}
	} else {
		eventArm("idx_usage_events_instance_time",
			`timestamp_ms >= ? AND timestamp_ms <= ? AND id <= `+checkpoint, plan.fromMS, plan.toMS)
	}
	// Everything not folded yet, wherever in the window it falls.
	eventArm("idx_usage_events_instance_id",
		`id > `+checkpoint+` AND timestamp_ms >= ? AND timestamp_ms <= ?`, plan.fromMS, plan.toMS)

	sums := make([]string, 0, len(usageFactMeasures))
	for _, measure := range usageFactMeasures {
		sums = append(sums, "COALESCE(SUM("+measure+"), 0)")
	}
	statement := `
		SELECT group_key, sub_group_key, aligned, ` + strings.Join(sums, ", ") + `,
		       COALESCE(SUM(CASE WHEN from_facts = 1 THEN requests ELSE 0 END), 0)
		FROM (` + strings.Join(parts, `
			UNION ALL`) + `
		)
		GROUP BY group_key, sub_group_key, aligned
		ORDER BY group_key ASC, sub_group_key ASC, aligned ASC`
	return statement, args
}

// AggregateUsageFacts folds request records beyond the checkpoint into both fact
// grains and returns how many records it absorbed.
//
// Both grains and the checkpoint move in one transaction. A crash leaves either
// all three as they were or all three advanced, so a record is never in one grain
// and missing from the other, and a repeated pass cannot count it twice.
func (r *Repository) AggregateUsageFacts(ctx context.Context, batchSize int) (int, error) {
	if r == nil || r.SQL() == nil {
		return 0, errors.New("repository is not initialized")
	}
	if batchSize <= 0 {
		batchSize = 5000
	}
	tx, err := r.SQL().BeginTx(ctx, nil)
	if err != nil {
		return 0, fmt.Errorf("begin usage fold: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	var lastID int64
	err = tx.QueryRowContext(ctx, `
		SELECT last_usage_event_id FROM usage_aggregation_checkpoints WHERE name = ?`, CheckpointFacts).Scan(&lastID)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return 0, fmt.Errorf("read checkpoint inside usage fold: %w", err)
	}
	var highID sql.NullInt64
	var absorbed int
	err = tx.QueryRowContext(ctx, `
		SELECT MAX(id), COUNT(1) FROM (SELECT id FROM usage_events WHERE id > ? ORDER BY id ASC LIMIT ?)`,
		lastID, batchSize).Scan(&highID, &absorbed)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return 0, fmt.Errorf("find usage fold high water: %w", err)
	}
	if !highID.Valid {
		return 0, nil
	}

	updates := make([]string, 0, len(usageFactMeasures))
	for _, measure := range usageFactMeasures {
		updates = append(updates, measure+" = "+measure+" + excluded."+measure)
	}
	for _, grain := range []struct {
		table    string
		bucketMS int64
	}{{usageFactsFineTable, QuarterHourBucketMS}, {usageFactsDailyTable, DayBucketMS}} {
		// INSERT..SELECT keeps the fold inside SQLite: the records never cross into Go.
		_, err = tx.ExecContext(ctx, `
			INSERT INTO `+grain.table+` (instance_id, bucket_start_ms, `+usageFactDimensions+`, `+strings.Join(usageFactMeasures, ", ")+`)
			SELECT instance_id, (timestamp_ms / ?1) * ?1, api_group_key, model, COALESCE(model_alias, ''),
			       auth_index, provider, auth_type,
			       COUNT(1), SUM(failed), SUM(input_tokens), SUM(output_tokens), SUM(reasoning_tokens),
			       SUM(cached_tokens), SUM(cache_read_tokens), SUM(cache_creation_tokens), SUM(total_tokens),
			       SUM(latency_ms), SUM(COALESCE(ttft_ms, 0)), SUM(ttft_ms IS NOT NULL),
			       SUM(COALESCE(cost_nanos, 0)), SUM(pricing_status = 'priced'), SUM(cost_nanos IS NOT NULL)
			FROM usage_events
			WHERE id > ?2 AND id <= ?3
			GROUP BY instance_id, (timestamp_ms / ?1) * ?1, api_group_key, model, COALESCE(model_alias, ''),
			         auth_index, provider, auth_type
			ON CONFLICT DO UPDATE SET `+strings.Join(updates, ", "),
			grain.bucketMS, lastID, highID.Int64)
		if err != nil {
			return 0, fmt.Errorf("fold usage into %s: %w", grain.table, err)
		}
	}

	nowMS := time.Now().UnixMilli()
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO usage_aggregation_checkpoints (name, last_usage_event_id, stats_updated_at_ms, created_at_ms, updated_at_ms)
		VALUES (?, ?, ?, ?, ?)
		ON CONFLICT(name) DO UPDATE SET
			last_usage_event_id = MAX(excluded.last_usage_event_id, usage_aggregation_checkpoints.last_usage_event_id),
			stats_updated_at_ms = excluded.stats_updated_at_ms,
			updated_at_ms = excluded.updated_at_ms`,
		CheckpointFacts, highID.Int64, nowMS, nowMS, nowMS); err != nil {
		return 0, fmt.Errorf("advance usage fold checkpoint: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return 0, fmt.Errorf("commit usage fold: %w", err)
	}
	return absorbed, nil
}

// FirstUsageRecordMS reports the earliest instant the deployment has usage for,
// or nil when nothing has been captured.
//
// It reads the facts as well as the request records: once retention has rolled
// the early records away, the facts are the only thing that still remembers when
// usage began. The fact side is a bucket start, so the answer is exact to the
// quarter hour, which is as fine as anything read from the facts can be.
func (r *Repository) FirstUsageRecordMS(ctx context.Context, instanceID string) (*int64, error) {
	if r == nil || r.SQL() == nil {
		return nil, errors.New("repository is not initialized")
	}
	var value *int64
	err := r.SQL().QueryRowContext(ctx, `
		SELECT MIN(first_ms) FROM (
			SELECT MIN(bucket_start_ms) AS first_ms FROM `+usageFactsFineTable+` WHERE instance_id = ?1
			UNION ALL
			SELECT MIN(timestamp_ms) FROM usage_events WHERE instance_id = ?1
		)`, instanceID).Scan(&value)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return nil, fmt.Errorf("read first usage record: %w", err)
	}
	return value, nil
}

// LifecycleHorizonMS reports the instant before which a rolling policy's rows
// have been deleted, zero when it has deleted nothing.
func (r *Repository) LifecycleHorizonMS(ctx context.Context, policy string) (int64, error) {
	if r == nil || r.SQL() == nil {
		return 0, errors.New("repository is not initialized")
	}
	var horizonMS int64
	err := r.SQL().QueryRowContext(ctx,
		`SELECT horizon_ms FROM data_lifecycle_state WHERE policy = ?`, policy).Scan(&horizonMS)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, nil
	}
	if err != nil {
		return 0, fmt.Errorf("read lifecycle horizon %s: %w", policy, err)
	}
	return horizonMS, nil
}
