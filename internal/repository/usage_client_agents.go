package repository

import (
	"cmp"
	"context"
	"database/sql"
	"errors"
	"fmt"
	"slices"
	"strings"

	"github.com/oh-my-cpa/oh-my-cpa/internal/usage"
)

const (
	maxFallbackSDKGroups      = 24
	clientBackfillBatchRows   = 2000
	clientBackfillUpdateChunk = 500
)

// UsageClientAgentRow aggregates retained request-record measures for one
// normalized caller agent or SDK family.
type UsageClientAgentRow struct {
	ID        string
	Category  string
	RawPrefix string
	UsageTotals
	NetTokens      int64
	CostNanos      int64
	PricedRequests int64
	CostedRequests int64
}

func (row *UsageClientAgentRow) add(other UsageClientAgentRow) {
	row.UsageTotals.add(other.UsageTotals)
	row.NetTokens += other.NetTokens
	row.CostNanos += other.CostNanos
	row.PricedRequests += other.PricedRequests
	row.CostedRequests += other.CostedRequests
}

// UsageClientAgentsResult reports retained client attribution within a window.
type UsageClientAgentsResult struct {
	RetainedRequests int64
	Items            []UsageClientAgentRow
}

type clientAgentAccumulator struct {
	row            UsageClientAgentRow
	prefixRequests map[string]int64
}

// backfillUsageClientAgentsTx runs in O(N) over existing usage_events rows by
// keyset-scanning primary keys in bounded batches, caching (user_agent, endpoint)
// classifications in memory, and updating rows by integer primary key before
// rebuilding the composite client_agent index once. It also initializes the new
// additive partition columns on pre-067 permanent fact rows.
func backfillUsageClientAgentsTx(ctx context.Context, tx *sql.Tx, _ *DB) error {
	if err := backfillHistoricalFactPartitionsTx(ctx, tx); err != nil {
		return err
	}

	var hasPending bool
	if err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM usage_events WHERE client_agent = '' LIMIT 1)`).Scan(&hasPending); err != nil {
		return fmt.Errorf("check historical client_agent rows: %w", err)
	}
	if !hasPending {
		return nil
	}

	if _, err := tx.ExecContext(ctx, `DROP INDEX IF EXISTS idx_usage_events_instance_client_time`); err != nil {
		return fmt.Errorf("drop client_agent index before bulk backfill: %w", err)
	}

	type pendingRow struct {
		id       int64
		ua       string
		endpoint string
	}
	cache := make(map[[2]string]string, 256)
	var lastID int64
	for {
		rows, err := tx.QueryContext(ctx, `
			SELECT id, COALESCE(user_agent, ''), endpoint
			FROM usage_events
			WHERE id > ? AND client_agent = ''
			ORDER BY id ASC
			LIMIT ?`, lastID, clientBackfillBatchRows)
		if err != nil {
			return fmt.Errorf("scan historical client_agent batch: %w", err)
		}
		batch := make([]pendingRow, 0, clientBackfillBatchRows)
		for rows.Next() {
			var item pendingRow
			if scanErr := rows.Scan(&item.id, &item.ua, &item.endpoint); scanErr != nil {
				_ = rows.Close()
				return fmt.Errorf("scan historical client_agent row: %w", scanErr)
			}
			batch = append(batch, item)
		}
		if err := rows.Err(); err != nil {
			_ = rows.Close()
			return fmt.Errorf("iterate historical client_agent batch: %w", err)
		}
		if err := rows.Close(); err != nil {
			return fmt.Errorf("close historical client_agent batch: %w", err)
		}
		if len(batch) == 0 {
			break
		}

		byAgent := make(map[string][]int64, 16)
		for _, item := range batch {
			key := [2]string{item.ua, item.endpoint}
			resolved, ok := cache[key]
			if !ok {
				resolved = usage.PersistedClientAgent("", item.ua, item.endpoint)
				cache[key] = resolved
			}
			byAgent[resolved] = append(byAgent[resolved], item.id)
		}

		agents := make([]string, 0, len(byAgent))
		for agentID := range byAgent {
			agents = append(agents, agentID)
		}
		slices.Sort(agents)
		for _, agentID := range agents {
			ids := byAgent[agentID]
			for start := 0; start < len(ids); start += clientBackfillUpdateChunk {
				chunk := ids[start:min(start+clientBackfillUpdateChunk, len(ids))]
				args := make([]any, 0, 1+len(chunk))
				args = append(args, agentID)
				for _, id := range chunk {
					args = append(args, id)
				}
				placeholders := strings.TrimSuffix(strings.Repeat("?,", len(chunk)), ",")
				if _, err := tx.ExecContext(ctx, `UPDATE usage_events SET client_agent = ? WHERE id IN (`+placeholders+`)`, args...); err != nil {
					return fmt.Errorf("update historical client_agent chunk: %w", err)
				}
			}
		}

		lastID = batch[len(batch)-1].id
		if len(batch) < clientBackfillBatchRows {
			break
		}
	}

	if _, err := tx.ExecContext(ctx, `
		CREATE INDEX IF NOT EXISTS idx_usage_events_instance_client_time
		ON usage_events(instance_id, client_agent, timestamp_ms DESC, id DESC)`); err != nil {
		return fmt.Errorf("rebuild client_agent index after bulk backfill: %w", err)
	}
	return nil
}

func backfillHistoricalFactPartitionsTx(ctx context.Context, tx *sql.Tx) error {
	var fineHasRows, dailyHasRows, localHasRows bool
	if err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM `+usageFactsFineTable+` LIMIT 1)`).Scan(&fineHasRows); err != nil {
		return fmt.Errorf("check historical rows in %s: %w", usageFactsFineTable, err)
	}
	if err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM `+usageFactsDailyTable+` LIMIT 1)`).Scan(&dailyHasRows); err != nil {
		return fmt.Errorf("check historical rows in %s: %w", usageFactsDailyTable, err)
	}
	if err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM `+usageFactsLocalTable+` LIMIT 1)`).Scan(&localHasRows); err != nil {
		return fmt.Errorf("check historical rows in %s: %w", usageFactsLocalTable, err)
	}
	if !fineHasRows && !dailyHasRows && !localHasRows {
		return nil
	}

	factCrExpr := `(CASE
		WHEN canonical_requests > 0 AND canonical_requests < requests THEN MAX(cache_read_tokens, cached_tokens, 0)
		WHEN cache_read_tokens > 0 THEN cache_read_tokens
		ELSE MAX(cached_tokens, 0)
	END)`
	factCwExpr := `MAX(cache_creation_tokens, 0)`
	factCacheTotal := `(` + factCrExpr + ` + ` + factCwExpr + `)`
	factMinComp := `MAX(output_tokens, reasoning_tokens, 0)`
	factSepComp := `(MAX(output_tokens, 0) + MAX(reasoning_tokens, 0))`
	factSemExpr := `(CASE
		WHEN LOWER(TRIM(COALESCE(provider, ''))) = 'openai-compatibility'
		  OR LOWER(TRIM(COALESCE(provider, ''))) LIKE 'openai-compatible-%' THEN 1
		WHEN LOWER(COALESCE(provider, '')) LIKE '%claude%'
		  OR LOWER(COALESCE(provider, '')) LIKE '%anthropic%' THEN 2
		WHEN LOWER(COALESCE(provider, '')) LIKE '%gemini%'
		  OR LOWER(COALESCE(provider, '')) LIKE '%aistudio%'
		  OR LOWER(COALESCE(provider, '')) LIKE '%antigravity%'
		  OR LOWER(COALESCE(provider, '')) LIKE '%vertex%'
		  OR LOWER(COALESCE(provider, '')) LIKE '%interaction%' THEN 3
		WHEN LOWER(COALESCE(provider, '')) LIKE '%openai%'
		  OR LOWER(COALESCE(provider, '')) LIKE '%codex%'
		  OR LOWER(COALESCE(provider, '')) LIKE '%xai%'
		  OR LOWER(COALESCE(provider, '')) LIKE '%grok%'
		  OR LOWER(COALESCE(provider, '')) LIKE '%kimi%'
		  OR LOWER(COALESCE(provider, '')) LIKE '%qwen%'
		  OR LOWER(COALESCE(provider, '')) LIKE '%deepseek%'
		  OR LOWER(COALESCE(provider, '')) LIKE '%openrouter%' THEN 1
		ELSE 0
	END)`
	factDisjointExpr := `(canonical_requests = 0 AND ` + factCacheTotal + ` > 0 AND MAX(input_tokens, 0) > 0 AND (
		(` + factSemExpr + ` = 2 AND (cache_read_tokens > 0 OR cache_creation_tokens > 0))
		OR (` + factSemExpr + ` = 0 AND (
			(MAX(input_tokens, 0) < ` + factCacheTotal + ` AND MAX(total_tokens, 0) <= MAX(input_tokens, 0) + ` + factMinComp + `)
			OR (cached_tokens <= 0 AND (
				(MAX(reasoning_tokens, 0) = 0 AND MAX(total_tokens, 0) = MAX(input_tokens, 0) + ` + factCacheTotal + ` + ` + factMinComp + `)
				OR (MAX(reasoning_tokens, 0) > 0 AND MAX(total_tokens, 0) = MAX(input_tokens, 0) + ` + factCacheTotal + ` + ` + factSepComp + `)
			))
		))
	))`
	factPromptBase := `(CASE
		WHEN canonical_requests = requests AND requests > 0 THEN MAX(input_tokens, 0)
		WHEN ` + factDisjointExpr + ` THEN MAX(input_tokens, 0) + ` + factCacheTotal + `
		ELSE MAX(MAX(input_tokens, 0), ` + factCacheTotal + `)
	END)`
	// OpenAI subset (sem = 1) uses inclusive output in both canonical and legacy records,
	// so even mixed expired buckets (0 < canonical_requests < requests) never enter unknown equality fallback.
	factCompExpr := `(CASE
		WHEN canonical_requests = requests AND requests > 0 THEN MAX(output_tokens, 0)
		WHEN canonical_requests = 0 AND MAX(reasoning_tokens, 0) > 0 AND MAX(output_tokens, 0) > 0 AND (
			` + factSemExpr + ` = 3
			OR (` + factSemExpr + ` = 0 AND MAX(total_tokens, 0) = ` + factPromptBase + ` + ` + factSepComp + `)
		)
			THEN ` + factSepComp + `
		ELSE ` + factMinComp + `
	END)`
	factPromptExpr := `(CASE
		WHEN canonical_requests = requests AND requests > 0 THEN MAX(input_tokens, 0)
		WHEN canonical_requests = 0 AND ` + factSemExpr + ` = 0 AND MAX(input_tokens, 0) = 0 AND ` + factCacheTotal + ` = 0 AND cached_tokens <= 0 AND MAX(total_tokens, 0) > ` + factCompExpr + `
			THEN MAX(total_tokens, 0) - ` + factCompExpr + `
		ELSE ` + factPromptBase + `
	END)`
	factTotalExpr := `MAX(MAX(total_tokens, 0), ` + factPromptExpr + ` + ` + factCompExpr + `)`

	if fineHasRows {
		// 1. Initialize all 15m rows so buckets past retention still hold best-effort partitions.
		if _, err := tx.ExecContext(ctx, `
			UPDATE `+usageFactsFineTable+`
			SET effective_cache_read_tokens = `+factCrExpr+`,
			    completion_tokens = `+factCompExpr+`,
			    prompt_tokens = `+factPromptExpr+`,
			    effective_total_tokens = `+factTotalExpr+`
			WHERE prompt_tokens = 0 AND completion_tokens = 0 AND effective_cache_read_tokens = 0 AND effective_total_tokens = 0`); err != nil {
			return fmt.Errorf("initialize historical partitions in %s: %w", usageFactsFineTable, err)
		}

		// 2. Where raw folded events up to the checkpoint are completely retained for a 15m tuple,
		// replace the approximation with exact per-event sums from usage_events.
		var checkpointID int64
		if err := tx.QueryRowContext(ctx, `SELECT COALESCE((SELECT last_usage_event_id FROM usage_aggregation_checkpoints WHERE name = ?), 0)`, CheckpointFacts).Scan(&checkpointID); err != nil {
			return fmt.Errorf("read checkpoint for historical fact partition rebuild: %w", err)
		}
		if checkpointID > 0 {
			if _, err := tx.ExecContext(ctx, `DROP TABLE IF EXISTS temp._omc_mig067_15m`); err != nil {
				return fmt.Errorf("drop temp mig067 table: %w", err)
			}
			if _, err := tx.ExecContext(ctx, `
				CREATE TEMP TABLE _omc_mig067_15m (
					instance_id TEXT NOT NULL,
					bucket_start_ms INTEGER NOT NULL,
					api_group_key TEXT NOT NULL,
					model TEXT NOT NULL,
					model_alias TEXT NOT NULL,
					auth_index TEXT NOT NULL,
					provider TEXT NOT NULL,
					auth_type TEXT NOT NULL,
					ev_requests INTEGER NOT NULL,
					prompt_tokens INTEGER NOT NULL,
					completion_tokens INTEGER NOT NULL,
					effective_cache_read_tokens INTEGER NOT NULL,
					effective_total_tokens INTEGER NOT NULL,
					PRIMARY KEY (instance_id, bucket_start_ms, api_group_key, model, model_alias, auth_index, provider, auth_type)
				)`); err != nil {
				return fmt.Errorf("create temp mig067 table: %w", err)
			}
			defer func() { _, _ = tx.ExecContext(ctx, `DROP TABLE IF EXISTS temp._omc_mig067_15m`) }()

			if _, err := tx.ExecContext(ctx, `
				WITH s1 AS MATERIALIZED (
					SELECT instance_id, (timestamp_ms / ?1) * ?1 AS bucket_start_ms,
					       api_group_key, model, COALESCE(model_alias, '') AS model_alias,
					       auth_index, provider, auth_type,
					       `+eventStage1Cols+`
					FROM usage_events
					WHERE id <= ?2
				)
				INSERT INTO temp._omc_mig067_15m
				SELECT instance_id, bucket_start_ms, api_group_key, model, model_alias,
				       auth_index, provider, auth_type,
				       COUNT(1),
				       COALESCE(SUM(_pr), 0),
				       COALESCE(SUM(_comp), 0),
				       COALESCE(SUM(_cr), 0),
				       COALESCE(SUM(`+stageTotalExpr+`), 0)
				FROM (
					SELECT *, `+stagePromptFromPBCompExpr+` AS _pr
					FROM (
						SELECT *, `+stageCompFromPBExpr+` AS _comp
						FROM (
							SELECT *, `+stagePromptBaseExpr+` AS _pb FROM s1
						)
					)
				)
				GROUP BY instance_id, bucket_start_ms, api_group_key, model, model_alias,
				         auth_index, provider, auth_type`, QuarterHourBucketMS, checkpointID); err != nil {
				return fmt.Errorf("aggregate retained events for mig067: %w", err)
			}

			if _, err := tx.ExecContext(ctx, `
				UPDATE `+usageFactsFineTable+` AS f
				SET prompt_tokens = r.prompt_tokens,
				    completion_tokens = r.completion_tokens,
				    effective_cache_read_tokens = r.effective_cache_read_tokens,
				    effective_total_tokens = r.effective_total_tokens
				FROM temp._omc_mig067_15m AS r
				WHERE f.instance_id = r.instance_id
				  AND f.bucket_start_ms = r.bucket_start_ms
				  AND f.api_group_key = r.api_group_key
				  AND f.model = r.model
				  AND f.model_alias = r.model_alias
				  AND f.auth_index = r.auth_index
				  AND f.provider = r.provider
				  AND f.auth_type = r.auth_type
				  AND f.requests = r.ev_requests`); err != nil {
				return fmt.Errorf("apply exact retained event partitions to %s: %w", usageFactsFineTable, err)
			}
		}
	}

	// 3. Roll up daily partitions from the corrected 15m grain so hourly and daily reads stay equal,
	// initializing any standalone daily rows that lack 15m counterparts.
	if dailyHasRows {
		if fineHasRows {
			if _, err := tx.ExecContext(ctx, `
				WITH rolled AS (
					SELECT instance_id, (bucket_start_ms / ?1) * ?1 AS day_start_ms,
					       api_group_key, model, model_alias, auth_index, provider, auth_type,
					       SUM(requests) AS fine_requests,
					       SUM(prompt_tokens) AS prompt_tokens,
					       SUM(completion_tokens) AS completion_tokens,
					       SUM(effective_cache_read_tokens) AS effective_cache_read_tokens,
					       SUM(effective_total_tokens) AS effective_total_tokens
					FROM `+usageFactsFineTable+`
					GROUP BY instance_id, (bucket_start_ms / ?1) * ?1, api_group_key, model, model_alias, auth_index, provider, auth_type
				)
				UPDATE `+usageFactsDailyTable+` AS d
				SET prompt_tokens = rolled.prompt_tokens,
				    completion_tokens = rolled.completion_tokens,
				    effective_cache_read_tokens = rolled.effective_cache_read_tokens,
				    effective_total_tokens = rolled.effective_total_tokens
				FROM rolled
				WHERE d.instance_id = rolled.instance_id
				  AND d.bucket_start_ms = rolled.day_start_ms
				  AND d.api_group_key = rolled.api_group_key
				  AND d.model = rolled.model
				  AND d.model_alias = rolled.model_alias
				  AND d.auth_index = rolled.auth_index
				  AND d.provider = rolled.provider
				  AND d.auth_type = rolled.auth_type
				  AND d.requests = rolled.fine_requests`, DayBucketMS); err != nil {
				return fmt.Errorf("roll up daily historical partitions: %w", err)
			}
		}
		if _, err := tx.ExecContext(ctx, `
			UPDATE `+usageFactsDailyTable+`
			SET effective_cache_read_tokens = `+factCrExpr+`,
			    completion_tokens = `+factCompExpr+`,
			    prompt_tokens = `+factPromptExpr+`,
			    effective_total_tokens = `+factTotalExpr+`
			WHERE prompt_tokens = 0 AND completion_tokens = 0 AND effective_cache_read_tokens = 0 AND effective_total_tokens = 0
			  AND (input_tokens > 0 OR output_tokens > 0 OR cached_tokens > 0 OR cache_read_tokens > 0 OR cache_creation_tokens > 0 OR total_tokens > 0)`); err != nil {
			return fmt.Errorf("initialize standalone daily historical partitions: %w", err)
		}
	}

	// 4. Clear derived local-day cache if pre-existing so QueryUsageFacts reads the corrected 15m grain
	// immediately and EnsureLocalUsageFacts rebuilds local days from 15m on next check.
	if localHasRows {
		if err := clearLocalUsageFacts(ctx, tx); err != nil {
			return fmt.Errorf("clear stale local usage grain during mig067: %w", err)
		}
	}
	return nil
}

// QueryUsageClientAgents scans retained usage_events inside [fromMS, toMS]
// under the shared Insights dimension filters: every retained record contributes
// to RetainedRequests (matching permanent usage_facts population), while
// generating records fold per-request additive token partitions into caller
// agent / SDK groups.
func (r *Repository) QueryUsageClientAgents(
	ctx context.Context,
	instanceID string,
	fromMS, toMS int64,
	filters map[UsageDimension][]string,
) (UsageClientAgentsResult, error) {
	result := UsageClientAgentsResult{Items: []UsageClientAgentRow{}}
	if r == nil || r.SQL() == nil {
		return result, errors.New("repository is not initialized")
	}
	if toMS < fromMS {
		return result, errors.New("usage window is negative")
	}
	for dimension := range filters {
		if _, known := usageDimensionExpressions[dimension]; !known {
			return result, fmt.Errorf("unknown usage filter %q", dimension)
		}
	}

	filterClause, filterArgs := usageFilterClause(filters)
	args := make([]any, 0, 3+len(filterArgs))
	args = append(args, instanceID, fromMS, toMS)
	args = append(args, filterArgs...)

	statement := `
		WITH s1 AS MATERIALIZED (
			SELECT generate, client_agent,
			       COALESCE(user_agent, '') AS user_agent_nn,
			       CASE WHEN client_agent = '' THEN endpoint ELSE '' END AS endpoint_hint,
			       failed, latency_ms, ttft_ms, cost_nanos,
			       (pricing_status = 'priced') AS is_priced,
			       ` + eventStage1Cols + `
			FROM usage_events INDEXED BY idx_usage_events_instance_time
			WHERE instance_id = ? AND timestamp_ms >= ? AND timestamp_ms <= ?` + filterClause + `
		)
		SELECT
			generate,
			client_agent,
			CASE WHEN client_agent = '' THEN user_agent_nn ELSE COALESCE(MAX(NULLIF(user_agent_nn, '')), '') END AS sample_ua,
			endpoint_hint,
			COUNT(1),
			COALESCE(SUM(failed), 0),
			COALESCE(SUM(_pr), 0),
			COALESCE(SUM(_comp), 0),
			COALESCE(SUM(_rr), 0),
			COALESCE(SUM(_cr), 0),
			COALESCE(SUM(_cw), 0),
			COALESCE(SUM(` + stageTotalExpr + `), 0),
			COALESCE(SUM(latency_ms), 0),
			COALESCE(SUM(ttft_ms), 0),
			COUNT(ttft_ms),
			COALESCE(SUM(cost_nanos), 0),
			COALESCE(SUM(is_priced), 0),
			COUNT(cost_nanos)
		FROM (
			SELECT *, ` + stagePromptFromPBCompExpr + ` AS _pr
			FROM (
				SELECT *, ` + stageCompFromPBExpr + ` AS _comp
				FROM (
					SELECT *, ` + stagePromptBaseExpr + ` AS _pb FROM s1
				)
			)
		)
		GROUP BY
			generate,
			client_agent,
			CASE WHEN client_agent = '' THEN user_agent_nn ELSE '' END,
			endpoint_hint`

	rows, err := r.SQL().QueryContext(ctx, statement, args...)
	if err != nil {
		return result, fmt.Errorf("query usage client agents: %w", err)
	}
	defer rows.Close()

	groups := make(map[string]*clientAgentAccumulator, 16)
	for rows.Next() {
		var generate int
		var storedAgent, sampleUA, endpointHint string
		var item UsageClientAgentRow
		if errScan := rows.Scan(
			&generate,
			&storedAgent, &sampleUA, &endpointHint,
			&item.Requests, &item.Failures,
			&item.InputTokens, &item.OutputTokens, &item.ReasoningTokens,
			&item.CacheReadTokens, &item.CacheCreationTokens,
			&item.TotalTokens, &item.LatencySumMS, &item.TTFTSumMS, &item.TTFTCount,
			&item.CostNanos, &item.PricedRequests, &item.CostedRequests,
		); errScan != nil {
			return result, fmt.Errorf("scan usage client agent row: %w", errScan)
		}
		item.CachedTokens = item.CacheReadTokens
		uncached := max(item.InputTokens-item.CacheReadTokens-item.CacheCreationTokens, 0)
		item.NetTokens = uncached + item.OutputTokens
		result.RetainedRequests += item.Requests
		if generate != 1 {
			continue
		}
		match := usage.ResolveClientAgent(storedAgent, sampleUA, endpointHint)
		acc, exists := groups[match.ID]
		if !exists {
			acc = &clientAgentAccumulator{
				row: UsageClientAgentRow{
					ID:       match.ID,
					Category: string(match.Category),
				},
				prefixRequests: map[string]int64{},
			}
			groups[match.ID] = acc
		}
		acc.row.add(item)
		if match.RawPrefix != "" {
			acc.prefixRequests[match.RawPrefix] += item.Requests
		}
	}
	if err := rows.Err(); err != nil {
		return result, fmt.Errorf("iterate usage client agent rows: %w", err)
	}

	canonicalItems := make([]UsageClientAgentRow, 0, len(groups))
	fallbackItems := make([]UsageClientAgentRow, 0)
	for _, acc := range groups {
		if acc.row.ID != usage.ClientAgentUnknown && acc.row.ID != usage.ClientAgentOther {
			var bestPrefix string
			var bestCount int64
			for prefix, count := range acc.prefixRequests {
				if count > bestCount || (count == bestCount && (bestPrefix == "" || prefix < bestPrefix)) {
					bestPrefix = prefix
					bestCount = count
				}
			}
			acc.row.RawPrefix = bestPrefix
		}
		if usage.IsCanonicalClientAgentID(acc.row.ID) {
			canonicalItems = append(canonicalItems, acc.row)
		} else {
			fallbackItems = append(fallbackItems, acc.row)
		}
	}

	sortClientAgentRows := func(slice []UsageClientAgentRow) {
		slices.SortFunc(slice, func(left, right UsageClientAgentRow) int {
			if order := cmp.Compare(right.Requests, left.Requests); order != 0 {
				return order
			}
			if order := cmp.Compare(right.TotalTokens, left.TotalTokens); order != 0 {
				return order
			}
			if order := cmp.Compare(right.CostNanos, left.CostNanos); order != 0 {
				return order
			}
			return cmp.Compare(left.ID, right.ID)
		})
	}

	if len(fallbackItems) > maxFallbackSDKGroups {
		sortClientAgentRows(fallbackItems)
		folded := UsageClientAgentRow{
			ID:       usage.ClientAgentOther,
			Category: string(usage.ClientAgentCategorySDK),
		}
		for _, tailItem := range fallbackItems[maxFallbackSDKGroups-1:] {
			folded.add(tailItem)
		}
		fallbackItems = append(fallbackItems[:maxFallbackSDKGroups-1], folded)
	}

	items := append(canonicalItems, fallbackItems...)
	sortClientAgentRows(items)
	result.Items = items
	return result, nil
}
