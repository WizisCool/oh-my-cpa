package repository

import (
	"context"
	"database/sql"
	"fmt"
	"strings"

	"github.com/oh-my-cpa/oh-my-cpa/internal/security"
)

// TrendsRedactedPrefix marks opaque group IDs emitted when redaction or email
// masking alters a raw dimension value (for example, a model name containing an
// address). Only these prefixed tokens trigger candidate resolution at query time.
const TrendsRedactedPrefix = "redacted:"

// TrendsOpaqueGroupID derives a stable keyed token for a non-key dimension value
// whose raw form was altered by redaction/masking so filters can still target it.
func TrendsOpaqueGroupID(f security.Fingerprinter, dimension UsageDimension, raw string) string {
	fp := security.FingerprintOrRedacted(f, "trends-group:"+string(dimension), raw)
	if fp == "" || fp == security.RedactedValue {
		return ""
	}
	return TrendsRedactedPrefix + fp
}

const UsageDimensionResponseModel UsageDimension = "response_model"

// UsageTelemetrySample contains only the columns needed for trends, never
// request identities, payloads, headers, or upstream error text.
type UsageTelemetrySample struct {
	GroupID, Model, Provider, ResponseModel, FailCode string
	StartMS, TimestampMS, OutputTokens, LatencyMS     int64
	TTFTMS                                            *int64
	TPS                                               *float64
	FailStatusCode                                    int
	IsFailed, IsModelSubstituted, IsTopSeries         bool
}

// ReadUsageTelemetry streams the retained request records on the same civil
// grid and with the same dimension predicates as the permanent fact read.
func (r *Repository) ReadUsageTelemetry(ctx context.Context, query UsageFactQuery, group UsageDimension, mode TpsCalculationMode, visit func(UsageTelemetrySample)) error {
	return readUsageTelemetryWithQuerier(ctx, r.SQL(), query, group, mode, nil, visit)
}

// ReadTrendsTelemetrySnapshot reads the retention horizon, any pre-horizon
// permanent facts, the top listed group IDs, and retained telemetry samples
// inside a single SQLite read snapshot so high-cardinality queries only track
// per-bucket percentiles for the top series.
func (r *Repository) ReadTrendsTelemetrySnapshot(
	ctx context.Context,
	query UsageFactQuery,
	group UsageDimension,
	mode TpsCalculationMode,
	includeFacts bool,
	seriesLimit, listedLimit int,
	visit func(UsageTelemetrySample),
) (horizon int64, facts UsageFactResult, listedGroupIDs []string, err error) {
	facts = UsageFactResult{Rows: []UsageFactRow{}}
	if r == nil || r.SQL() == nil {
		return 0, facts, nil, fmt.Errorf("repository is not initialized")
	}
	tx, err := r.SQL().BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return 0, facts, nil, fmt.Errorf("begin telemetry read snapshot: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	horizon, err = lifecycleHorizonMS(ctx, tx, LifecycleUsageDetail)
	if err != nil {
		return 0, facts, nil, err
	}
	if includeFacts && horizon > 0 && query.FromMS < horizon {
		factQuery := query
		factQuery.Calendar = nil
		factQuery.HorizonMS = &horizon
		facts, err = queryUsageFactsWithQuerier(ctx, tx, factQuery)
		if err != nil {
			return 0, facts, nil, err
		}
	}
	retainedQuery := query
	if horizon > 0 {
		retainedQuery.FromMS = max(retainedQuery.FromMS, horizon)
	}
	var topSet map[string]struct{}
	if listedLimit > 0 && retainedQuery.ToMS >= retainedQuery.FromMS {
		listedGroupIDs, err = readUsageTelemetryTopGroupsWithQuerier(ctx, tx, retainedQuery, group, listedLimit)
		if err != nil {
			return 0, facts, nil, err
		}
		if seriesLimit > 0 && len(listedGroupIDs) > 0 {
			capCount := min(seriesLimit, len(listedGroupIDs))
			topSet = make(map[string]struct{}, capCount)
			for _, id := range listedGroupIDs[:capCount] {
				topSet[id] = struct{}{}
			}
		}
	}
	if err := readUsageTelemetryWithQuerier(ctx, tx, retainedQuery, group, mode, topSet, visit); err != nil {
		return 0, facts, nil, err
	}
	return horizon, facts, listedGroupIDs, nil
}

func telemetryFilters(query UsageFactQuery) (map[UsageDimension][]string, error) {
	filters := make(map[UsageDimension][]string, len(query.Filters)+1)
	for dimension, values := range query.Filters {
		if _, known := usageDimensionExpressions[dimension]; !known {
			return nil, fmt.Errorf("unknown telemetry filter %q", dimension)
		}
		filters[dimension] = values
	}
	if len(query.ClientAgents) > 0 {
		filters[UsageDimensionClientAgent] = query.ClientAgents
	}
	return filters, nil
}

func readUsageTelemetryTopGroupsWithQuerier(ctx context.Context, q sqlQuerier, query UsageFactQuery, group UsageDimension, limit int) ([]string, error) {
	if query.ToMS < query.FromMS || limit <= 0 {
		return nil, nil
	}
	groupExpr, known := usageDimensionExpressions[group]
	if !known {
		return nil, fmt.Errorf("invalid telemetry grouping")
	}
	filters, err := telemetryFilters(query)
	if err != nil {
		return nil, err
	}
	clause, filterArgs := usageFilterClause(filters)
	clientClause := ""
	if query.isClientRead() || group == UsageDimensionClientAgent {
		clientClause = " AND generate = 1"
	}
	args := make([]any, 0, 4+len(filterArgs))
	args = append(args, query.InstanceID, query.FromMS, query.ToMS)
	args = append(args, filterArgs...)
	args = append(args, limit)
	rows, err := q.QueryContext(ctx, `SELECT `+groupExpr+` AS gid, COUNT(1) AS cnt
		FROM usage_events WHERE instance_id = ? AND timestamp_ms BETWEEN ? AND ?`+clause+clientClause+`
		GROUP BY gid ORDER BY cnt DESC, gid ASC LIMIT ?`, args...)
	if err != nil {
		return nil, fmt.Errorf("query telemetry top groups: %w", err)
	}
	defer rows.Close()
	ids := make([]string, 0, min(limit, 32))
	for rows.Next() {
		var id string
		var cnt int64
		if err := rows.Scan(&id, &cnt); err != nil {
			return nil, fmt.Errorf("scan telemetry top group: %w", err)
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate telemetry top groups: %w", err)
	}
	return ids, nil
}

func readUsageTelemetryWithQuerier(ctx context.Context, q sqlQuerier, query UsageFactQuery, group UsageDimension, mode TpsCalculationMode, topSet map[string]struct{}, visit func(UsageTelemetrySample)) error {
	if query.ToMS < query.FromMS {
		return nil
	}
	groupExpr, known := usageDimensionExpressions[group]
	if !known || query.Calendar == nil {
		return fmt.Errorf("invalid telemetry grouping or calendar")
	}
	grid, err := compileCalendar(*query.Calendar, query.FromMS, query.ToMS)
	if err != nil {
		return err
	}
	filters, err := telemetryFilters(query)
	if err != nil {
		return err
	}
	clause, filterArgs := usageFilterClause(filters)
	clientClause := ""
	if query.isClientRead() || group == UsageDimensionClientAgent {
		clientClause = " AND generate = 1"
	}
	rows, err := q.QueryContext(ctx, `SELECT `+groupExpr+`, `+grid.bucket("timestamp_ms")+`, timestamp_ms,
		model, `+usageDimensionExpressions[UsageDimensionProvider]+`, response_model, fail_code, fail_status_code,
		failed, model_substituted, generate, latency_ms, ttft_ms,
		COALESCE(json_extract(token_accounting, '$.status') = 'complete', 0), provider, executor_type, endpoint,
		input_tokens, output_tokens, reasoning_tokens, cached_tokens, cache_read_tokens, cache_creation_tokens, total_tokens
		FROM usage_events WHERE instance_id = ? AND timestamp_ms BETWEEN ? AND ?`+clause+clientClause+`
		ORDER BY timestamp_ms, id`, append([]any{query.InstanceID, query.FromMS, query.ToMS}, filterArgs...)...)
	if err != nil {
		return fmt.Errorf("query telemetry records: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var sample UsageTelemetrySample
		var wallStart int64
		var isGenerate bool
		var ttft sql.NullInt64
		var input EventPartitionInput
		if err := rows.Scan(&sample.GroupID, &wallStart, &sample.TimestampMS, &sample.Model, &sample.Provider,
			&sample.ResponseModel, &sample.FailCode, &sample.FailStatusCode, &sample.IsFailed, &sample.IsModelSubstituted,
			&isGenerate, &sample.LatencyMS, &ttft, &input.IsCanonical, &input.Provider, &input.ExecutorType, &input.Endpoint,
			&input.InputTokens, &input.OutputTokens, &input.ReasoningTokens, &input.CachedTokens,
			&input.CacheReadTokens, &input.CacheCreationTokens, &input.TotalTokens); err != nil {
			return fmt.Errorf("scan telemetry record: %w", err)
		}
		sample.StartMS = grid.instant(wallStart)
		_, sample.OutputTokens, _, _ = NormalizeEventPartition(input)
		if ttft.Valid && ttft.Int64 > 0 {
			sample.TTFTMS = &ttft.Int64
		}
		if isGenerate && sample.OutputTokens > 0 && sample.LatencyMS > 0 {
			duration := sample.LatencyMS
			if mode == TpsExcludeTTFT {
				duration = 0
				if sample.TTFTMS != nil {
					duration = sample.LatencyMS - *sample.TTFTMS
				}
			}
			if duration > 0 {
				tps := 1000 * float64(sample.OutputTokens) / float64(duration)
				sample.TPS = &tps
			}
		}
		if len(topSet) > 0 {
			_, sample.IsTopSeries = topSet[sample.GroupID]
		}
		visit(sample)
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("iterate telemetry records: %w", err)
	}
	return nil
}

// QuotaTrendRetainedUsage holds one served-model retained usage aggregate for a
// quota physical-consumption read, preserving both start and completion times so
// pre-horizon fact deduplication stays exact across boundary-spanning requests.
type QuotaTrendRetainedUsage struct {
	StartedMS   int64
	CompletedMS int64
	Model       string
	Measures    UsageMeasures
}

// ReadQuotaTrendUsage attributes retained request records by completion time
// and actual served model, matching the quota calibration's scope and clock.
func (r *Repository) ReadQuotaTrendUsage(ctx context.Context, instanceID, authIndex string, fromMS, toMS, retentionStartMS int64, visit func(completedMS int64, model string, measures UsageMeasures)) error {
	return readQuotaTrendUsageWithQuerier(ctx, r.SQL(), instanceID, authIndex, fromMS, toMS, retentionStartMS, func(_, completedMS int64, model string, measures UsageMeasures) {
		visit(completedMS, model, measures)
	})
}

// ReadQuotaTrendPhysical reads the retention horizon, deleted-only pre-horizon
// 15m fact residuals, and all retained serving-model records completing within
// [fromMS, toMS) inside one SQLite read snapshot so facts and retained detail
// remain strictly disjoint across cycles.
func (r *Repository) ReadQuotaTrendPhysical(ctx context.Context, instanceID, authIndex string, fromMS, toMS int64) (horizon int64, facts UsageFactResult, retained []QuotaTrendRetainedUsage, err error) {
	facts = UsageFactResult{Rows: []UsageFactRow{}}
	if toMS <= fromMS {
		return 0, facts, nil, nil
	}
	if r == nil || r.SQL() == nil {
		return 0, facts, nil, fmt.Errorf("repository is not initialized")
	}
	authIndex = strings.TrimSpace(authIndex)
	tx, err := r.SQL().BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return 0, facts, nil, fmt.Errorf("begin quota physical read snapshot: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	horizon, err = lifecycleHorizonMS(ctx, tx, LifecycleUsageDetail)
	if err != nil {
		return 0, facts, nil, err
	}
	if horizon > fromMS {
		factQuery := UsageFactQuery{
			InstanceID: instanceID, FromMS: fromMS, ToMS: min(toMS, horizon) - 1, BucketMS: QuarterHourBucketMS,
			HorizonMS:  &horizon,
			Filters:    map[UsageDimension][]string{UsageDimensionCredential: {authIndex}},
			Dimensions: []UsageDimension{UsageDimensionModel},
		}
		facts, err = queryUsageFactsWithQuerier(ctx, tx, factQuery)
		if err != nil {
			return 0, facts, nil, err
		}
		if len(facts.Rows) > 0 {
			if err := subtractSurvivingUsageEventsFromFacts(ctx, tx, instanceID, authIndex, &facts); err != nil {
				return 0, facts, nil, err
			}
		}
	}
	err = readQuotaTrendUsageWithQuerier(ctx, tx, instanceID, authIndex, fromMS, toMS, 0, func(startedMS, completedMS int64, model string, measures UsageMeasures) {
		retained = append(retained, QuotaTrendRetainedUsage{
			StartedMS:   startedMS,
			CompletedMS: completedMS,
			Model:       model,
			Measures:    measures,
		})
	})
	return horizon, facts, retained, err
}

func subtractSurvivingUsageEventsFromFacts(ctx context.Context, q sqlQuerier, instanceID, authIndex string, facts *UsageFactResult) error {
	if facts == nil || len(facts.Rows) == 0 || facts.ToMS < facts.FromMS {
		return nil
	}
	type bucketKey struct {
		startMS int64
		model   string
	}
	bucketIndex := make(map[bucketKey]int, len(facts.Rows))
	for index, row := range facts.Rows {
		if len(row.Keys) > 0 {
			bucketIndex[bucketKey{startMS: row.StartMS, model: row.Keys[0]}] = index
		}
	}
	bucketExpr := fmt.Sprintf("(timestamp_ms / %d) * %d", QuarterHourBucketMS, QuarterHourBucketMS)
	statement := buildStagedUsageEventsArm(`model AS k0, `, `k0, `, bucketExpr, "",
		`instance_id = ? AND auth_index = ? AND timestamp_ms >= ? AND timestamp_ms <= ?`)
	rows, err := q.QueryContext(ctx,
		`SELECT k0, aligned, `+strings.Join(usageFactMeasures, ", ")+` FROM (`+statement+`)`,
		instanceID, authIndex, facts.FromMS, facts.ToMS)
	if err != nil {
		return fmt.Errorf("query surviving quota fact overlap: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var model string
		var startMS int64
		var measures UsageMeasures
		targets := make([]any, 2+len(usageFactMeasures))
		targets[0], targets[1] = &model, &startMS
		fillUsageMeasureTargets(targets[2:], &measures)
		if err := rows.Scan(targets...); err != nil {
			return fmt.Errorf("scan surviving quota fact overlap: %w", err)
		}
		if idx, ok := bucketIndex[bucketKey{startMS: startMS, model: model}]; ok {
			facts.Rows[idx].UsageMeasures.subtractClamped(measures)
		}
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("iterate surviving quota fact overlap: %w", err)
	}
	filtered := facts.Rows[:0]
	for _, row := range facts.Rows {
		if row.Requests > 0 {
			filtered = append(filtered, row)
		}
	}
	facts.Rows = filtered
	return nil
}

func readQuotaTrendUsageWithQuerier(ctx context.Context, q sqlQuerier, instanceID, authIndex string, fromMS, toMS, retentionStartMS int64, visit func(startedMS, completedMS int64, model string, measures UsageMeasures)) error {
	if retentionStartMS > fromMS {
		fromMS = retentionStartMS
	}
	if toMS <= fromMS {
		return nil
	}
	const completed = `(timestamp_ms + MAX(latency_ms, 0))`
	statement := buildStagedUsageEventsArm(`timestamp_ms AS started_ms, COALESCE(NULLIF(response_model, ''), model) AS served_model, `, `started_ms, served_model, `,
		completed, "", `instance_id = ? AND auth_index = ? AND `+completed+` >= ? AND `+completed+` < ?`)
	rows, err := q.QueryContext(ctx, `SELECT started_ms, served_model, aligned, `+strings.Join(usageFactMeasures, ", ")+` FROM (`+statement+`)`,
		instanceID, authIndex, fromMS, toMS)
	if err != nil {
		return fmt.Errorf("query quota trend usage: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var model string
		var startedMS, completedMS int64
		var measures UsageMeasures
		targets := make([]any, 3+len(usageFactMeasures))
		targets[0], targets[1], targets[2] = &startedMS, &model, &completedMS
		fillUsageMeasureTargets(targets[3:], &measures)
		if err := rows.Scan(targets...); err != nil {
			return fmt.Errorf("scan quota trend usage: %w", err)
		}
		visit(startedMS, completedMS, model, measures)
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("iterate quota trend usage: %w", err)
	}
	return nil
}

// ResolveTrendsDimensionFilters maps any opaque `redacted:` filter tokens back
// to the raw dimension values stored in permanent facts or retained records
// within [fromMS, toMS]. Ordinary filter values incur no database queries.
func (r *Repository) ResolveTrendsDimensionFilters(ctx context.Context, instanceID string, fromMS, toMS int64, filters map[UsageDimension][]string, clientAgents []string) ([]string, error) {
	hasOpaque := false
	for _, values := range filters {
		for _, value := range values {
			if strings.HasPrefix(value, TrendsRedactedPrefix) {
				hasOpaque = true
				break
			}
		}
		if hasOpaque {
			break
		}
	}
	if !hasOpaque {
		for _, value := range clientAgents {
			if strings.HasPrefix(value, TrendsRedactedPrefix) {
				hasOpaque = true
				break
			}
		}
	}
	if !hasOpaque || r == nil || r.SQL() == nil || r.db == nil {
		return clientAgents, nil
	}
	cipher := r.db.Cipher()
	if cipher == nil {
		return clientAgents, nil
	}

	resolveList := func(dimension UsageDimension, values []string) ([]string, error) {
		tokens := make(map[string]struct{})
		for _, value := range values {
			if strings.HasPrefix(value, TrendsRedactedPrefix) {
				tokens[value] = struct{}{}
			}
		}
		if len(tokens) == 0 {
			return values, nil
		}
		expr, known := usageDimensionExpressions[dimension]
		if !known && dimension != UsageDimensionResponseModel {
			return values, nil
		}
		var sqlText string
		var args []any
		hasWindow := toMS >= fromMS
		dailyFrom := (fromMS / DayBucketMS) * DayBucketMS
		fineFrom := (fromMS / QuarterHourBucketMS) * QuarterHourBucketMS
		switch dimension {
		case UsageDimensionResponseModel:
			if hasWindow {
				sqlText = `SELECT DISTINCT response_model AS val FROM usage_events WHERE instance_id = ? AND timestamp_ms >= ? AND timestamp_ms <= ? AND response_model <> ''`
				args = []any{instanceID, fromMS, toMS}
			} else {
				sqlText = `SELECT DISTINCT response_model AS val FROM usage_events WHERE instance_id = ? AND response_model <> ''`
				args = []any{instanceID}
			}
		case UsageDimensionClientAgent:
			if hasWindow {
				sqlText = `
					SELECT ` + expr + ` AS val FROM usage_client_facts_daily WHERE instance_id = ? AND bucket_start_ms >= ? AND bucket_start_ms <= ?
					UNION
					SELECT ` + expr + ` AS val FROM usage_client_facts_15m WHERE instance_id = ? AND bucket_start_ms >= ? AND bucket_start_ms <= ?
					UNION
					SELECT ` + expr + ` AS val FROM usage_events WHERE instance_id = ? AND timestamp_ms >= ? AND timestamp_ms <= ?`
				args = []any{instanceID, dailyFrom, toMS, instanceID, fineFrom, toMS, instanceID, fromMS, toMS}
			} else {
				sqlText = `
					SELECT ` + expr + ` AS val FROM usage_client_facts_daily WHERE instance_id = ?
					UNION
					SELECT ` + expr + ` AS val FROM usage_client_facts_15m WHERE instance_id = ?
					UNION
					SELECT ` + expr + ` AS val FROM usage_events WHERE instance_id = ?`
				args = []any{instanceID, instanceID, instanceID}
			}
		default:
			if hasWindow {
				sqlText = `
					SELECT ` + expr + ` AS val FROM usage_facts_daily WHERE instance_id = ? AND bucket_start_ms >= ? AND bucket_start_ms <= ?
					UNION
					SELECT ` + expr + ` AS val FROM usage_facts_15m WHERE instance_id = ? AND bucket_start_ms >= ? AND bucket_start_ms <= ?
					UNION
					SELECT ` + expr + ` AS val FROM usage_events WHERE instance_id = ? AND timestamp_ms >= ? AND timestamp_ms <= ?`
				args = []any{instanceID, dailyFrom, toMS, instanceID, fineFrom, toMS, instanceID, fromMS, toMS}
			} else {
				sqlText = `
					SELECT ` + expr + ` AS val FROM usage_facts_daily WHERE instance_id = ?
					UNION
					SELECT ` + expr + ` AS val FROM usage_facts_15m WHERE instance_id = ?
					UNION
					SELECT ` + expr + ` AS val FROM usage_events WHERE instance_id = ?`
				args = []any{instanceID, instanceID, instanceID}
			}
		}
		rows, err := r.SQL().QueryContext(ctx, sqlText, args...)
		if err != nil {
			return nil, fmt.Errorf("resolve redacted %s filter: %w", dimension, err)
		}
		defer rows.Close()
		resolvedByToken := make(map[string][]string, len(tokens))
		for rows.Next() {
			var candidate string
			if err := rows.Scan(&candidate); err != nil {
				return nil, fmt.Errorf("scan redacted %s candidate: %w", dimension, err)
			}
			if token := TrendsOpaqueGroupID(cipher, dimension, candidate); token != "" {
				if _, wanted := tokens[token]; wanted {
					resolvedByToken[token] = append(resolvedByToken[token], candidate)
				}
			}
		}
		if err := rows.Err(); err != nil {
			return nil, fmt.Errorf("iterate redacted %s candidates: %w", dimension, err)
		}
		out := make([]string, 0, len(values))
		for _, value := range values {
			if matches, ok := resolvedByToken[value]; ok && len(matches) > 0 {
				out = append(out, matches...)
			} else {
				out = append(out, value)
			}
		}
		return out, nil
	}

	for dimension, values := range filters {
		resolved, err := resolveList(dimension, values)
		if err != nil {
			return nil, err
		}
		filters[dimension] = resolved
	}
	return resolveList(UsageDimensionClientAgent, clientAgents)
}
