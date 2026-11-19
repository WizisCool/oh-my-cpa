package repository

import (
	"context"
	"database/sql"
	"fmt"
	"strings"

	"github.com/oh-my-cpa/oh-my-cpa/internal/quota"
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
	GroupID, Model, Provider, AuthIndex, ResponseModel, FailCode string
	StartMS, TimestampMS, OutputTokens, LatencyMS                int64
	TTFTMS                                                       *int64
	TPS                                                          *float64
	FailStatusCode                                               int
	IsFailed, IsModelSubstituted, IsTopSeries                    bool
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
		model, `+usageDimensionExpressions[UsageDimensionProvider]+`, `+usageDimensionExpressions[UsageDimensionCredential]+`, response_model, fail_code, fail_status_code,
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
			&sample.AuthIndex, &sample.ResponseModel, &sample.FailCode, &sample.FailStatusCode, &sample.IsFailed, &sample.IsModelSubstituted,
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

// QuotaTrendCredentialSpan bounds the completion-time interval [FromMS, ToMS)
// for one credential inside a batched quota trend read.
type QuotaTrendCredentialSpan struct {
	AuthIndex     string
	FromMS        int64
	ToMS          int64
	NeedModel     bool
	NeedCapFromMS int64
	NeedCapToMS   int64
}

// QuotaTrendStreamEvent is one retained usage_events row delivered to callers
// during ReadQuotaTrendBatch, carrying both normalized physical usage measures
// and capacity-accounting fields so burn curves, cycle history, live-cycle late
// reconciliation, and window capacity all compute in a single pass.
type QuotaTrendStreamEvent struct {
	ID                int64
	StartedMS         int64
	CompletedMS       int64
	Model             string
	Measures          UsageMeasures
	CapacityUsage     quota.WindowUsage
	HasCapacityTokens bool
}

// QuotaTrendBatchFacts holds the retention horizon, usage_events watermark ID,
// and deleted-only pre-horizon 15m fact residuals returned by ReadQuotaTrendBatch
// after its SQLite read snapshot closes.
type QuotaTrendBatchFacts struct {
	HorizonMS   int64
	WatermarkID int64
	FactsByAuth map[string][]UsageFactRow
}

// ReadQuotaTrendUsage attributes retained request records by completion time
// and actual served model, matching the quota calibration's scope and clock.
func (r *Repository) ReadQuotaTrendUsage(ctx context.Context, instanceID, authIndex string, fromMS, toMS, retentionStartMS int64, visit func(completedMS int64, model string, measures UsageMeasures)) error {
	return readQuotaTrendUsageWithQuerier(ctx, r.SQL(), instanceID, authIndex, fromMS, toMS, retentionStartMS, func(_, completedMS int64, model string, measures UsageMeasures) {
		visit(completedMS, model, measures)
	})
}

// ReadQuotaTrendBatch reads the retention horizon, current usage_events
// watermark ID, deleted-only pre-horizon 15m fact residuals for all requested
// credentials in one batched scan, and streams retained completion-time records
// per credential inside a single SQLite read snapshot. Deleted-only facts are
// returned after the read snapshot closes so callers apply them without holding
// the SQLite connection.
func (r *Repository) ReadQuotaTrendBatch(
	ctx context.Context,
	instanceID string,
	spans []QuotaTrendCredentialSpan,
	visitRetained func(authIndex string, watermarkID int64, event QuotaTrendStreamEvent),
) (QuotaTrendBatchFacts, error) {
	result := QuotaTrendBatchFacts{FactsByAuth: map[string][]UsageFactRow{}}
	if r == nil || r.SQL() == nil {
		return result, fmt.Errorf("repository is not initialized")
	}
	tx, err := r.SQL().BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return result, fmt.Errorf("begin quota trend batch snapshot: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	horizon, err := lifecycleHorizonMS(ctx, tx, LifecycleUsageDetail)
	if err != nil {
		return result, err
	}
	var watermark int64
	if err := tx.QueryRowContext(ctx, `SELECT COALESCE(MAX(id), 0) FROM usage_events`).Scan(&watermark); err != nil {
		return result, fmt.Errorf("read quota trend usage watermark: %w", err)
	}
	factsByAuth, err := readDeletedQuotaFactsBatch(ctx, tx, instanceID, horizon, spans)
	if err != nil {
		return result, err
	}
	result.HorizonMS = horizon
	result.WatermarkID = watermark
	result.FactsByAuth = factsByAuth
	if visitRetained == nil {
		return result, nil
	}
	stmt, err := tx.PrepareContext(ctx, quotaTrendBatchRetainedSelectSQL)
	if err != nil {
		return result, fmt.Errorf("prepare quota trend retained query: %w", err)
	}
	defer stmt.Close()
	for _, span := range mergeQuotaTrendSpans(spans) {
		if err := ctx.Err(); err != nil {
			return result, err
		}
		needModel := 0
		if span.NeedModel {
			needModel = 1
		}
		if err := streamQuotaTrendBatchRetained(ctx, stmt, instanceID, span.AuthIndex, span.FromMS, span.ToMS, needModel, span.NeedCapFromMS, span.NeedCapToMS, func(ev QuotaTrendStreamEvent) {
			visitRetained(span.AuthIndex, watermark, ev)
		}); err != nil {
			return result, err
		}
	}
	return result, nil
}

// mergeQuotaTrendSpans normalizes spans to at most one non-empty merged span per
// credential so repeated or overlapping spans never emit the same usage_events row twice.
func mergeQuotaTrendSpans(spans []QuotaTrendCredentialSpan) []QuotaTrendCredentialSpan {
	if len(spans) == 0 {
		return nil
	}
	indexByAuth := make(map[string]int, len(spans))
	merged := make([]QuotaTrendCredentialSpan, 0, len(spans))
	for _, span := range spans {
		authIndex := strings.TrimSpace(span.AuthIndex)
		if authIndex == "" || span.ToMS <= span.FromMS {
			continue
		}
		span.AuthIndex = authIndex
		if idx, exists := indexByAuth[authIndex]; exists {
			cur := &merged[idx]
			cur.FromMS = min(cur.FromMS, span.FromMS)
			cur.ToMS = max(cur.ToMS, span.ToMS)
			cur.NeedModel = cur.NeedModel || span.NeedModel
			if span.NeedCapToMS > span.NeedCapFromMS {
				if cur.NeedCapToMS <= cur.NeedCapFromMS {
					cur.NeedCapFromMS, cur.NeedCapToMS = span.NeedCapFromMS, span.NeedCapToMS
				} else {
					cur.NeedCapFromMS = min(cur.NeedCapFromMS, span.NeedCapFromMS)
					cur.NeedCapToMS = max(cur.NeedCapToMS, span.NeedCapToMS)
				}
			}
			continue
		}
		indexByAuth[authIndex] = len(merged)
		merged = append(merged, span)
	}
	return merged
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

// quotaTrendBatchRetainedSelectSQL projects the minimal plain-typed columns
// needed by trendsQuota, avoiding sql.Null* reflection, unused text columns,
// and 200-byte token_accounting copies outside the capacity window.
const quotaTrendBatchRetainedSelectSQL = `
	SELECT id, timestamp_ms, (timestamp_ms + MAX(latency_ms, 0)),
	       CASE WHEN ?1 = 1 THEN COALESCE(NULLIF(response_model, ''), model) ELSE '' END,
	       CASE
	         WHEN token_accounting IS NOT NULL AND instr(token_accounting, '"status":"complete"') > 0 THEN ''
	         ELSE provider || char(31) || executor_type || char(31) || endpoint
	       END,
	       input_tokens, output_tokens, reasoning_tokens,
	       cached_tokens, cache_read_tokens, cache_creation_tokens, total_tokens,
	       COALESCE(cost_nanos, -1),
	       CASE
	         WHEN token_accounting IS NULL THEN ''
	         WHEN (timestamp_ms + MAX(latency_ms, 0)) >= ?2 AND (timestamp_ms + MAX(latency_ms, 0)) < ?3 THEN token_accounting
	         WHEN instr(token_accounting, '"status":"complete"') > 0 THEN 'c'
	         ELSE token_accounting
	       END
	FROM usage_events
	WHERE instance_id = ?4 AND auth_index = ?5
	  AND (timestamp_ms + MAX(latency_ms, 0)) >= ?6
	  AND (timestamp_ms + MAX(latency_ms, 0)) < ?7`

func usageMeasuresFromRawEvent(
	failed bool,
	provider, executorType, endpoint string,
	inputTokens, outputTokens, reasoningTokens, cachedTokens, cacheReadTokens, cacheCreationTokens, totalTokens int64,
	latencyMS int64,
	ttftMS sql.NullInt64,
	costNanos sql.NullInt64,
	pricingStatus string,
	hasTokenAccounting bool,
	isCanonical bool,
) UsageMeasures {
	prompt, comp, effCacheRead, effTotal := NormalizeEventPartition(EventPartitionInput{
		IsCanonical:         isCanonical,
		Provider:            provider,
		ExecutorType:        executorType,
		Endpoint:            endpoint,
		InputTokens:         inputTokens,
		OutputTokens:        outputTokens,
		ReasoningTokens:     reasoningTokens,
		CachedTokens:        cachedTokens,
		CacheReadTokens:     cacheReadTokens,
		CacheCreationTokens: cacheCreationTokens,
		TotalTokens:         totalTokens,
	})
	var failures, ttftSum, ttftCount, costVal, pricedReqs, costedReqs, canonicalReqs, unresolvedReqs int64
	if failed {
		failures = 1
	}
	if ttftMS.Valid {
		ttftSum = ttftMS.Int64
		ttftCount = 1
	}
	if costNanos.Valid {
		costVal = costNanos.Int64
		costedReqs = 1
	}
	if pricingStatus == "priced" {
		pricedReqs = 1
	}
	if isCanonical {
		canonicalReqs = 1
	} else if hasTokenAccounting {
		unresolvedReqs = 1
	}
	return UsageMeasures{
		Accounting: TokenAccountingMeasures{
			CanonicalRequests:        canonicalReqs,
			UnresolvedRequests:       unresolvedReqs,
			PromptTokens:             prompt,
			CompletionTokens:         comp,
			EffectiveCacheReadTokens: effCacheRead,
			EffectiveTotalTokens:     effTotal,
		},
		UsageTotals: UsageTotals{
			Requests:            1,
			Failures:            failures,
			InputTokens:         inputTokens,
			OutputTokens:        outputTokens,
			ReasoningTokens:     reasoningTokens,
			CachedTokens:        cachedTokens,
			CacheReadTokens:     cacheReadTokens,
			CacheCreationTokens: cacheCreationTokens,
			TotalTokens:         totalTokens,
			LatencySumMS:        latencyMS,
			TTFTSumMS:           ttftSum,
			TTFTCount:           ttftCount,
		},
		CostNanos:      costVal,
		PricedRequests: pricedReqs,
		CostedRequests: costedReqs,
	}
}

func streamQuotaTrendBatchRetained(
	ctx context.Context,
	stmt *sql.Stmt,
	instanceID, authIndex string,
	fromMS, toMS int64,
	needModel int,
	capFromMS, capToMS int64,
	visit func(QuotaTrendStreamEvent),
) error {
	rows, err := stmt.QueryContext(ctx, needModel, capFromMS, capToMS, instanceID, authIndex, fromMS, toMS)
	if err != nil {
		return fmt.Errorf("query quota trend usage: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var (
			id, startedMS, completedMS                                                                         int64
			model, legacyMeta, tokenAccounting                                                                 string
			inputTokens, outputTokens, reasoningTokens, cachedTokens, cacheReadTokens, cacheWrite, totalTokens int64
			costOrNeg                                                                                          int64
		)
		if err := rows.Scan(
			&id, &startedMS, &completedMS,
			&model, &legacyMeta,
			&inputTokens, &outputTokens, &reasoningTokens,
			&cachedTokens, &cacheReadTokens, &cacheWrite, &totalTokens,
			&costOrNeg, &tokenAccounting,
		); err != nil {
			return fmt.Errorf("scan quota trend usage: %w", err)
		}
		var isCanonical bool
		var canonPrompt, canonCacheRead int64
		if tokenAccounting == "c" {
			isCanonical = true
		} else if tokenAccounting != "" {
			isCanonical, canonPrompt, canonCacheRead = parseCapacityTokenAccounting(tokenAccounting)
		}
		var provider, executorType, endpoint string
		if !isCanonical && legacyMeta != "" {
			if first := strings.IndexByte(legacyMeta, 31); first >= 0 {
				provider = legacyMeta[:first]
				rest := legacyMeta[first+1:]
				if second := strings.IndexByte(rest, 31); second >= 0 {
					executorType = rest[:second]
					endpoint = rest[second+1:]
				}
			}
		}
		costNanos := sql.NullInt64{Int64: costOrNeg, Valid: costOrNeg >= 0}
		measures := usageMeasuresFromRawEvent(
			false, provider, executorType, endpoint,
			inputTokens, outputTokens, reasoningTokens, cachedTokens, cacheReadTokens, cacheWrite, totalTokens,
			0, sql.NullInt64{}, costNanos, "", tokenAccounting != "", isCanonical,
		)
		ev := QuotaTrendStreamEvent{
			ID:          id,
			StartedMS:   startedMS,
			CompletedMS: completedMS,
			Model:       model,
			Measures:    measures,
		}
		if totalTokens > 0 && completedMS >= capFromMS && completedMS < capToMS {
			ev.HasCapacityTokens = true
			ev.CapacityUsage = buildCapacityEventUsage(
				isCanonical, canonPrompt, canonCacheRead,
				inputTokens, outputTokens, cachedTokens, cacheReadTokens, cacheWrite, totalTokens, costNanos,
			)
		}
		visit(ev)
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("iterate quota trend usage: %w", err)
	}
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
		instanceID, strings.TrimSpace(authIndex), fromMS, toMS)
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

func readDeletedQuotaFactsBatch(ctx context.Context, tx *sql.Tx, instanceID string, horizon int64, spans []QuotaTrendCredentialSpan) (map[string][]UsageFactRow, error) {
	result := make(map[string][]UsageFactRow)
	if horizon <= 0 || len(spans) == 0 {
		return result, nil
	}
	type fineBounds struct {
		fromMS int64
		toMS   int64
	}
	boundsByAuth := make(map[string]fineBounds)
	authList := make([]string, 0, len(spans))
	var globalFrom, globalTo int64
	hasAny := false
	for _, span := range spans {
		authIndex := strings.TrimSpace(span.AuthIndex)
		if authIndex == "" || span.ToMS <= span.FromMS || horizon <= span.FromMS {
			continue
		}
		fineFrom := alignDown(span.FromMS, QuarterHourBucketMS)
		fineTo := alignUp(min(span.ToMS, horizon), QuarterHourBucketMS)
		if fineTo <= fineFrom {
			continue
		}
		if existing, ok := boundsByAuth[authIndex]; ok {
			boundsByAuth[authIndex] = fineBounds{fromMS: min(existing.fromMS, fineFrom), toMS: max(existing.toMS, fineTo)}
		} else {
			boundsByAuth[authIndex] = fineBounds{fromMS: fineFrom, toMS: fineTo}
			authList = append(authList, authIndex)
		}
		if !hasAny {
			globalFrom, globalTo, hasAny = fineFrom, fineTo, true
		} else {
			globalFrom = min(globalFrom, fineFrom)
			globalTo = max(globalTo, fineTo)
		}
	}
	if !hasAny {
		return result, nil
	}

	var factsCheckpoint int64
	if err := tx.QueryRowContext(ctx, `
		SELECT COALESCE((SELECT last_usage_event_id FROM usage_aggregation_checkpoints WHERE name = ?), 0)`,
		CheckpointFacts,
	).Scan(&factsCheckpoint); err != nil {
		return nil, fmt.Errorf("read facts checkpoint for quota trends: %w", err)
	}
	if factsCheckpoint <= 0 {
		return result, nil
	}

	// Single index probe on idx_usage_events_instance_time: determine upfront
	// whether any surviving usage_events row can overlap [globalFrom, globalTo).
	var minRetainedTS sql.NullInt64
	if err := tx.QueryRowContext(ctx, `SELECT MIN(timestamp_ms) FROM usage_events WHERE instance_id = ?`, instanceID).Scan(&minRetainedTS); err != nil {
		return nil, fmt.Errorf("probe oldest surviving usage event: %w", err)
	}
	hasSurvivingOverlap := minRetainedTS.Valid && minRetainedTS.Int64 < globalTo
	needModel := hasSurvivingOverlap

	// Stream usage_facts_15m directly in PK order (instance_id, bucket_start_ms, ...)
	// with no SQL GROUP BY temp B-tree, folding rows per bucket in Go as bucket_start_ms
	// advances monotonically. Filter each credential's exact [fromMS, toMS) interval
	// inside SQL so a long-span credential never causes out-of-span rows from a busy
	// narrow-span credential to cross the SQLite->Go boundary.
	const chunkSize = 200
	var maxFactEnd int64
	type foldKey struct {
		authIndex string
		model     string
	}
	for start := 0; start < len(authList); start += chunkSize {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		chunk := authList[start:min(start+chunkSize, len(authList))]
		var chunkFrom, chunkTo int64
		for i, authIndex := range chunk {
			b := boundsByAuth[authIndex]
			if i == 0 {
				chunkFrom, chunkTo = b.fromMS, b.toMS
			} else {
				chunkFrom = min(chunkFrom, b.fromMS)
				chunkTo = max(chunkTo, b.toMS)
			}
		}
		// Build a per-credential WHERE predicate so SQLite rejects out-of-span rows
		// for narrow credentials inside the B-tree loop without allocating Go scan values.
		spanPredicates := make([]string, len(chunk))
		args := make([]any, 0, 3+len(chunk)*3)
		args = append(args, instanceID, chunkFrom, chunkTo)
		for i, authIndex := range chunk {
			b := boundsByAuth[authIndex]
			spanPredicates[i] = `(TRIM(auth_index) = ? AND bucket_start_ms >= ? AND bucket_start_ms < ?)`
			args = append(args, authIndex, b.fromMS, b.toMS)
		}
		modelExpr := `''`
		if needModel {
			modelExpr = `model`
		}
		query := fmt.Sprintf(`
			SELECT TRIM(auth_index), %s, bucket_start_ms,
			       requests, input_tokens, output_tokens, reasoning_tokens,
			       cached_tokens, cache_read_tokens, cache_creation_tokens, total_tokens,
			       cost_nanos, priced_requests, costed_requests,
			       canonical_requests, prompt_tokens, completion_tokens,
			       effective_cache_read_tokens, effective_total_tokens
			FROM %s
			WHERE instance_id = ? AND bucket_start_ms >= ? AND bucket_start_ms < ?
			  AND (%s)
			ORDER BY bucket_start_ms`, modelExpr, usageFactsFineTable, strings.Join(spanPredicates, " OR "))
		rows, err := tx.QueryContext(ctx, query, args...)
		if err != nil {
			return nil, fmt.Errorf("query batch quota facts: %w", err)
		}
		var currentBucket int64 = -1
		bucketAgg := make(map[foldKey]UsageMeasures, len(chunk)*2)
		flushBucket := func() {
			if currentBucket < 0 || len(bucketAgg) == 0 {
				return
			}
			for key, measures := range bucketAgg {
				if measures.Requests <= 0 {
					continue
				}
				row := UsageFactRow{
					StartMS:       currentBucket,
					UsageMeasures: measures,
				}
				if needModel {
					row.Keys = []string{key.model}
				}
				result[key.authIndex] = append(result[key.authIndex], row)
			}
			if end := currentBucket + QuarterHourBucketMS; end > maxFactEnd {
				maxFactEnd = end
			}
			clear(bucketAgg)
		}
		for rows.Next() {
			var authIndex, model string
			var startMS int64
			var m UsageMeasures
			if err := rows.Scan(
				&authIndex, &model, &startMS,
				&m.Requests, &m.InputTokens, &m.OutputTokens, &m.ReasoningTokens,
				&m.CachedTokens, &m.CacheReadTokens, &m.CacheCreationTokens, &m.TotalTokens,
				&m.CostNanos, &m.PricedRequests, &m.CostedRequests,
				&m.Accounting.CanonicalRequests, &m.Accounting.PromptTokens, &m.Accounting.CompletionTokens,
				&m.Accounting.EffectiveCacheReadTokens, &m.Accounting.EffectiveTotalTokens,
			); err != nil {
				_ = rows.Close()
				return nil, fmt.Errorf("scan batch quota facts: %w", err)
			}
			bounds, ok := boundsByAuth[authIndex]
			if !ok || startMS < bounds.fromMS || startMS >= bounds.toMS || m.Requests <= 0 {
				continue
			}
			if startMS != currentBucket {
				flushBucket()
				currentBucket = startMS
			}
			key := foldKey{authIndex: authIndex, model: model}
			existing := bucketAgg[key]
			existing.add(m)
			bucketAgg[key] = existing
		}
		if err := rows.Err(); err != nil {
			_ = rows.Close()
			return nil, fmt.Errorf("iterate batch quota facts: %w", err)
		}
		_ = rows.Close()
		flushBucket()
	}
	if len(result) == 0 || !hasSurvivingOverlap || minRetainedTS.Int64 >= maxFactEnd {
		return result, nil
	}

	subStmt, err := tx.PrepareContext(ctx, `
		SELECT model, timestamp_ms, failed, provider, executor_type, endpoint,
		       input_tokens, output_tokens, reasoning_tokens,
		       cached_tokens, cache_read_tokens, cache_creation_tokens, total_tokens,
		       latency_ms, ttft_ms, cost_nanos, pricing_status, token_accounting
		FROM usage_events INDEXED BY idx_usage_events_auth_time
		WHERE auth_index = ? AND timestamp_ms >= ? AND timestamp_ms < ?
		  AND instance_id = ? AND id <= ?`)
	if err != nil {
		return nil, fmt.Errorf("prepare surviving quota fact subtraction: %w", err)
	}
	defer subStmt.Close()

	type bucketKey struct {
		startMS int64
		model   string
	}
	for authIndex, factRows := range result {
		if len(factRows) == 0 {
			continue
		}
		minBucket := factRows[0].StartMS
		maxBucketEnd := factRows[0].StartMS + QuarterHourBucketMS
		bucketIndex := make(map[bucketKey]int, len(factRows))
		for idx, row := range factRows {
			minBucket = min(minBucket, row.StartMS)
			maxBucketEnd = max(maxBucketEnd, row.StartMS+QuarterHourBucketMS)
			if len(row.Keys) > 0 {
				bucketIndex[bucketKey{startMS: row.StartMS, model: row.Keys[0]}] = idx
			}
		}
		if minRetainedTS.Int64 >= maxBucketEnd {
			continue
		}
		rows, err := subStmt.QueryContext(ctx, authIndex, minBucket, maxBucketEnd, instanceID, factsCheckpoint)
		if err != nil {
			return nil, fmt.Errorf("query surviving quota fact overlap: %w", err)
		}
		for rows.Next() {
			var (
				model, provider, executorType, endpoint, pricingStatus                                             string
				startedMS, latencyMS                                                                               int64
				failed                                                                                             bool
				inputTokens, outputTokens, reasoningTokens, cachedTokens, cacheReadTokens, cacheWrite, totalTokens int64
				ttftMS, costNanos                                                                                  sql.NullInt64
				tokenAccounting                                                                                    sql.NullString
			)
			if err := rows.Scan(
				&model, &startedMS, &failed, &provider, &executorType, &endpoint,
				&inputTokens, &outputTokens, &reasoningTokens,
				&cachedTokens, &cacheReadTokens, &cacheWrite, &totalTokens,
				&latencyMS, &ttftMS, &costNanos, &pricingStatus, &tokenAccounting,
			); err != nil {
				_ = rows.Close()
				return nil, fmt.Errorf("scan surviving quota fact overlap: %w", err)
			}
			startMS := (startedMS / QuarterHourBucketMS) * QuarterHourBucketMS
			idx, ok := bucketIndex[bucketKey{startMS: startMS, model: model}]
			if !ok {
				continue
			}
			isCanonical, _, _ := parseCapacityTokenAccounting(tokenAccounting.String)
			measures := usageMeasuresFromRawEvent(
				failed, provider, executorType, endpoint,
				inputTokens, outputTokens, reasoningTokens, cachedTokens, cacheReadTokens, cacheWrite, totalTokens,
				latencyMS, ttftMS, costNanos, pricingStatus, tokenAccounting.Valid, isCanonical,
			)
			factRows[idx].UsageMeasures.subtractClamped(measures)
		}
		if err := rows.Err(); err != nil {
			_ = rows.Close()
			return nil, fmt.Errorf("iterate surviving quota fact overlap: %w", err)
		}
		_ = rows.Close()

		filtered := factRows[:0]
		for _, row := range factRows {
			if row.Requests > 0 {
				filtered = append(filtered, row)
			}
		}
		result[authIndex] = filtered
	}
	return result, nil
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
