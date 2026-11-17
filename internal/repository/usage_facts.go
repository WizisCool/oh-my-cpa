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

// errUnknownLocalGrainZone marks derived local-day state whose zone this image
// cannot resolve, such as after a restore onto different tzdata.
var errUnknownLocalGrainZone = errors.New("local usage grain names an unknown zone")

// CheckpointFacts names the single watermark both fact grains advance under.
const CheckpointFacts = "facts"

// QuarterHourBucketMS is the fine fact grain. Every civil UTC offset in use is a
// multiple of it, so a local calendar day is a whole number of buckets in any
// deployment timezone.
const QuarterHourBucketMS int64 = 15 * 60 * 1000

// LifecycleUsageDetail is the lifecycle policy that rolls request records.
const LifecycleUsageDetail = "usage_detail"

const (
	usageFactsFineTable        = "usage_facts_15m"
	usageFactsDailyTable       = "usage_facts_daily"
	usageClientFactsFineTable  = "usage_client_facts_15m"
	usageClientFactsDailyTable = "usage_client_facts_daily"
	// usageFactsLocalTable holds whole local days in the one zone its checkpoint
	// marker names; see migration 047.
	usageFactsLocalTable = "usage_facts_local_daily"
	// localFactsMarkerPrefix names the checkpoint row that says which zone the
	// local grain is built for. The row exists exactly when the grain is complete.
	localFactsMarkerPrefix = "facts_local:"
)

// usageFactDimensions are the columns a fact row is keyed on besides its bucket.
// usage_events carries the same names, so one expression groups either source.
const usageFactDimensions = `api_group_key, model, model_alias, auth_index, provider, auth_type`

// usageClientFactDimensions extends usageFactDimensions with persisted client attribution.
const usageClientFactDimensions = usageFactDimensions + `, client_agent, client_prefix`

// Per-event additive token partition SQL shared by unfolded usage_events reads,
// 15-minute fact folding, historical upgrade reconstruction, and caller agent
// attribution.
//
// Upstream token semantics follow CPA's ordered, mutually exclusive precedence
// (sdk/cliproxy/usage/accounting.go tokenAccountingSemanticsFor):
//
//	1 = subset             (input includes cache, output includes reasoning)
//	2 = independent        (input excludes cache, output includes thinking)
//	3 = separate_reasoning (input includes cache, output excludes thoughts)
//	0 = unknown            (exact conservation equality only; inbound endpoint
//	                        is consulted ONLY when provider/executor are blank/unknown)
//
// Staged subqueries evaluate json_extract(token_accounting, '$.status') and the
// ordered protocol CASE at most once per legacy row with non-zero cache/reasoning,
// keeping 100k-row scans well inside a single-digit fraction of the 15s budget.
const (
	// Stage 1 columns computed once per row on a usage_events source.
	// Note: SQLite's ASCII LIKE is already case-insensitive, avoiding redundant LOWER() calls.
	eventSemanticsCodeExpr = `(CASE
		WHEN TRIM(COALESCE(executor_type, '')) LIKE 'openaicompatexecutor'
		  OR TRIM(COALESCE(provider, '')) LIKE 'openai-compatibility'
		  OR TRIM(COALESCE(provider, '')) LIKE 'openai-compatible-%' THEN 1
		WHEN COALESCE(provider, '') LIKE '%claude%'
		  OR COALESCE(provider, '') LIKE '%anthropic%'
		  OR COALESCE(executor_type, '') LIKE '%claude%'
		  OR COALESCE(executor_type, '') LIKE '%anthropic%' THEN 2
		WHEN COALESCE(provider, '') LIKE '%gemini%'
		  OR COALESCE(provider, '') LIKE '%aistudio%'
		  OR COALESCE(provider, '') LIKE '%antigravity%'
		  OR COALESCE(provider, '') LIKE '%vertex%'
		  OR COALESCE(provider, '') LIKE '%interaction%'
		  OR COALESCE(executor_type, '') LIKE '%gemini%'
		  OR COALESCE(executor_type, '') LIKE '%aistudio%'
		  OR COALESCE(executor_type, '') LIKE '%antigravity%'
		  OR COALESCE(executor_type, '') LIKE '%vertex%'
		  OR COALESCE(executor_type, '') LIKE '%interaction%' THEN 3
		WHEN COALESCE(provider, '') LIKE '%openai%'
		  OR COALESCE(provider, '') LIKE '%codex%'
		  OR COALESCE(provider, '') LIKE '%xai%'
		  OR COALESCE(provider, '') LIKE '%grok%'
		  OR COALESCE(provider, '') LIKE '%kimi%'
		  OR COALESCE(provider, '') LIKE '%qwen%'
		  OR COALESCE(provider, '') LIKE '%deepseek%'
		  OR COALESCE(provider, '') LIKE '%openrouter%'
		  OR COALESCE(executor_type, '') LIKE '%openai%'
		  OR COALESCE(executor_type, '') LIKE '%codex%'
		  OR COALESCE(executor_type, '') LIKE '%xai%'
		  OR COALESCE(executor_type, '') LIKE '%grok%'
		  OR COALESCE(executor_type, '') LIKE '%kimi%'
		  OR COALESCE(executor_type, '') LIKE '%qwen%'
		  OR COALESCE(executor_type, '') LIKE '%deepseek%'
		  OR COALESCE(executor_type, '') LIKE '%openrouter%' THEN 1
		WHEN (TRIM(COALESCE(provider, '')) = '' OR TRIM(COALESCE(provider, '')) LIKE 'unknown')
		  AND (TRIM(COALESCE(executor_type, '')) = '' OR TRIM(COALESCE(executor_type, '')) LIKE 'unknown') THEN (CASE
			WHEN endpoint LIKE '%/v1/messages%' THEN 2
			WHEN endpoint LIKE '%:generateContent%' OR endpoint LIKE '%:streamGenerateContent%' THEN 3
			WHEN endpoint LIKE '%/chat/completions%' OR endpoint LIKE '%/responses%' THEN 1
			ELSE 0
		END)
		ELSE 0
	END)`

	eventStage1Cols = `
		CASE WHEN token_accounting IS NULL THEN 0 WHEN json_extract(token_accounting, '$.status') = 'complete' THEN 1 ELSE 0 END AS _isc,
		CASE WHEN token_accounting IS NULL THEN 0 WHEN json_extract(token_accounting, '$.status') <> 'complete' THEN 1 ELSE 0 END AS _iur,
		CASE
			WHEN token_accounting IS NOT NULL AND json_extract(token_accounting, '$.status') = 'complete' THEN 1
			WHEN input_tokens > 0 AND cached_tokens <= 0 AND cache_read_tokens <= 0 AND cache_creation_tokens <= 0 AND reasoning_tokens <= 0 THEN 1
			ELSE ` + eventSemanticsCodeExpr + `
		END AS _sem,
		MAX(input_tokens, 0) AS _ri,
		MAX(output_tokens, 0) AS _ro,
		MAX(reasoning_tokens, 0) AS _rr,
		cached_tokens AS _rc,
		MAX(cache_read_tokens, 0) AS _rcr,
		CASE
			WHEN token_accounting IS NOT NULL AND json_extract(token_accounting, '$.status') = 'complete' THEN MAX(cache_read_tokens, 0)
			WHEN cache_read_tokens > 0 THEN cache_read_tokens
			ELSE MAX(cached_tokens, 0)
		END AS _cr,
		MAX(cache_creation_tokens, 0) AS _cw,
		MAX(total_tokens, 0) AS _rt,
		MAX(output_tokens, reasoning_tokens, 0) AS _mc,
		(MAX(output_tokens, 0) + MAX(reasoning_tokens, 0)) AS _sc`

	// Stage 2 integer-only expressions over Stage 1 columns (_isc, _sem, _ri, _ro, _rr, _rc, _rcr, _cr, _cw, _rt, _mc, _sc).
	// Known independent protocols (_sem = 2) with explicit Anthropic cache columns (_rcr > 0 OR _cw > 0)
	// always count uncached input beside cache without any total_tokens range gate.
	// Zero-input deduction (_ri = 0 && _rt > _comp) applies ONLY to unknown protocols (_sem = 0)
	// that carry no explicit cache buckets at all.
	stagePromptBaseExpr = `(CASE
		WHEN _isc = 1 THEN _ri
		WHEN (_cr + _cw) > 0 AND _ri > 0 AND (
			(_sem = 2 AND (_rcr > 0 OR _cw > 0))
			OR (_sem = 0 AND (
				(_ri < (_cr + _cw) AND _rt <= _ri + _mc)
				OR (_rc <= 0 AND ((_rr = 0 AND _rt = _ri + (_cr + _cw) + _mc) OR (_rr > 0 AND _rt = _ri + (_cr + _cw) + _sc)))
			))
		) THEN _ri + (_cr + _cw)
		ELSE MAX(_ri, _cr + _cw)
	END)`
	stageCompFromPBExpr = `(CASE
		WHEN _isc = 1 THEN _ro
		WHEN _rr > 0 AND _ro > 0 AND (
			_sem = 3
			OR (_sem = 0 AND _rt = _pb + _sc)
		) THEN _sc
		ELSE _mc
	END)`
	stagePromptFromPBCompExpr = `(CASE
		WHEN _isc = 1 THEN _ri
		WHEN _sem = 0 AND _ri = 0 AND (_cr + _cw) = 0 AND _rc <= 0 AND _rt > _comp THEN _rt - _comp
		ELSE _pb
	END)`
	stageTotalExpr = `MAX(_rt, _pr + _comp)`
)

// usageFactMeasures lists the additive columns, in the order every read scans them.
var usageFactMeasures = []string{
	"requests", "failures", "input_tokens", "output_tokens", "reasoning_tokens",
	"cached_tokens", "cache_read_tokens", "cache_creation_tokens", "total_tokens",
	"latency_sum_ms", "ttft_sum_ms", "ttft_count", "cost_nanos", "priced_requests",
	"costed_requests", "canonical_requests", "unresolved_accounting_requests",
	"raw_input_tokens", "raw_output_tokens", "raw_total_tokens",
	"prompt_tokens", "completion_tokens", "effective_cache_read_tokens", "effective_total_tokens",
}

// usageClientFactMeasures lists the additive columns rolled into usage_client_facts_*.
var usageClientFactMeasures = []string{
	"retained_requests", "requests", "failures", "prompt_tokens", "completion_tokens",
	"reasoning_tokens", "effective_cache_read_tokens", "cache_creation_tokens",
	"effective_total_tokens", "latency_sum_ms", "ttft_sum_ms", "ttft_count",
	"cost_nanos", "priced_requests", "costed_requests",
}

// usageClientFactProjection reads a client fact row under usageFactMeasures'
// names and order. Client facts hold the normalised accounting only, so the
// normalised partitions stand in for the raw columns and every row is canonical.
var usageClientFactProjection = func() string {
	sources := []string{
		"requests", "failures", "prompt_tokens", "completion_tokens", "reasoning_tokens",
		"effective_cache_read_tokens", "effective_cache_read_tokens", "cache_creation_tokens", "effective_total_tokens",
		"latency_sum_ms", "ttft_sum_ms", "ttft_count", "cost_nanos", "priced_requests",
		"costed_requests", "requests", "0",
		"0", "0", "0",
		"prompt_tokens", "completion_tokens", "effective_cache_read_tokens", "effective_total_tokens",
	}
	columns := make([]string, len(sources))
	for index, source := range sources {
		columns[index] = source + " AS " + usageFactMeasures[index]
	}
	return strings.Join(columns, ", ")
}()

// buildStagedUsageEventsArm builds a single-MATERIALIZED pipeline over usage_events
// so protocol classification executes at most once per legacy row with non-zero
// cache/reasoning, while integer arithmetic stays streaming without extra temp B-trees.
func buildStagedUsageEventsArm(keySelect, keyPass, alignedExpr, indexClause, wherePredicate string) string {
	return `
		SELECT 0 AS from_facts, ` + keyPass + `aligned,
		       1 AS requests, failed AS failures, input_tokens, output_tokens, reasoning_tokens,
		       cached_tokens, cache_read_tokens, cache_creation_tokens, total_tokens,
		       latency_ms AS latency_sum_ms, COALESCE(ttft_ms, 0) AS ttft_sum_ms,
		       (ttft_ms IS NOT NULL) AS ttft_count, COALESCE(cost_nanos, 0) AS cost_nanos,
		       (pricing_status = 'priced') AS priced_requests, (cost_nanos IS NOT NULL) AS costed_requests,
		       _isc AS canonical_requests, _iur AS unresolved_accounting_requests,
		       raw_input_tokens, raw_output_tokens, raw_total_tokens,
		       _pr AS prompt_tokens, _comp AS completion_tokens, _cr AS effective_cache_read_tokens, ` + stageTotalExpr + ` AS effective_total_tokens
		FROM (
			WITH s1 AS MATERIALIZED (
				SELECT ` + keySelect + alignedExpr + ` AS aligned,
				       failed, input_tokens, output_tokens, reasoning_tokens,
				       cached_tokens, cache_read_tokens, cache_creation_tokens, total_tokens,
				       latency_ms, ttft_ms, cost_nanos, pricing_status,
				       CASE WHEN token_accounting IS NULL THEN 0 ELSE COALESCE(json_extract(token_accounting, '$.raw_tokens.input_tokens'), 0) END AS raw_input_tokens,
				       CASE WHEN token_accounting IS NULL THEN 0 ELSE COALESCE(json_extract(token_accounting, '$.raw_tokens.output_tokens'), 0) END AS raw_output_tokens,
				       CASE WHEN token_accounting IS NULL THEN 0 ELSE COALESCE(json_extract(token_accounting, '$.raw_tokens.total_tokens'), 0) END AS raw_total_tokens,
				       ` + eventStage1Cols + `
				FROM usage_events ` + indexClause + `
				WHERE ` + wherePredicate + `
			)
			SELECT *, ` + stagePromptFromPBCompExpr + ` AS _pr
			FROM (
				SELECT *, ` + stageCompFromPBExpr + ` AS _comp
				FROM (
					SELECT *, ` + stagePromptBaseExpr + ` AS _pb FROM s1
				)
			)
		)`
}

// UsageDimension is one column a usage read can partition or narrow by.
//
// A new way to slice usage is one more value here with its SQL expression in
// usageDimensionExpressions: the fact tables already carry every dimension, and
// the composition of facts and unfolded records is shared by every read.
type UsageDimension string

const (
	// UsageDimensionKey is the client key fingerprint (api_group_key). Traffic that
	// reached CPA without a client key carries CPA's own fallback label instead of
	// an `hmac:` fingerprint.
	UsageDimensionKey UsageDimension = "key"
	// UsageDimensionModel is the upstream model name as CPA recorded it.
	UsageDimensionModel UsageDimension = "model"
	// UsageDimensionCallPoint is the model alias a client requested, falling back
	// to the upstream model name when no alias was set.
	UsageDimensionCallPoint UsageDimension = "call_point"
	// UsageDimensionProvider is CPA's provider label, `unknown` when it sent none.
	UsageDimensionProvider UsageDimension = "provider"
	// UsageDimensionCredential is the runtime auth index of the credential that
	// served the request, whatever its type.
	UsageDimensionCredential UsageDimension = "credential"
	// UsageDimensionAuthType is the type of that credential (`apikey`, `oauth`, …).
	UsageDimensionAuthType UsageDimension = "auth_type"
	// UsageDimensionServingKey is the auth index of the API key that served an
	// API-key request, and empty for every other record. CPA labels an API-key
	// request with its family, the same label an OAuth request of that family
	// carries, so the provider label alone cannot say which configured provider
	// answered.
	UsageDimensionServingKey UsageDimension = "serving_key"
)

// usageDimensionExpressions maps a dimension to its SQL expression. The
// expressions only use columns present on both the fact tables and usage_events;
// model_alias is nullable on the latter, hence the COALESCE.
var usageDimensionExpressions = map[UsageDimension]string{
	UsageDimensionKey:        `api_group_key`,
	UsageDimensionModel:      `model`,
	UsageDimensionCallPoint:  `COALESCE(NULLIF(TRIM(COALESCE(model_alias, '')), ''), model)`,
	UsageDimensionProvider:   `COALESCE(NULLIF(TRIM(provider), ''), 'unknown')`,
	UsageDimensionCredential: `TRIM(auth_index)`,
	UsageDimensionAuthType:   `auth_type`,
	UsageDimensionServingKey: `CASE WHEN auth_type = 'apikey' THEN TRIM(auth_index) ELSE '' END`,
}

// UsageCalendarUnit is a civil bucket on the deployment's calendar.
type UsageCalendarUnit string

const (
	UsageCalendarHour UsageCalendarUnit = "hour"
	UsageCalendarDay  UsageCalendarUnit = "day"
	// UsageCalendarWeek starts on Monday, as the token activity grid does.
	UsageCalendarWeek UsageCalendarUnit = "week"
)

// UsageCalendar asks for buckets that follow a time zone's wall clock instead of
// the epoch grid: a day bucket then starts at local midnight even across a
// daylight-saving change, when the day is 23 or 25 hours long.
type UsageCalendar struct {
	Location *time.Location
	Unit     UsageCalendarUnit
}

// TokenAccountingMeasures retain the scope of raw evidence alongside the
// normalized sums. Requests not counted here are legacy, not known zero usage.
type TokenAccountingMeasures struct {
	CanonicalRequests        int64 `json:"canonical_requests"`
	UnresolvedRequests       int64 `json:"unresolved_requests"`
	RawInputTokens           int64 `json:"raw_input_tokens"`
	RawOutputTokens          int64 `json:"raw_output_tokens"`
	RawTotalTokens           int64 `json:"raw_total_tokens"`
	PromptTokens             int64 `json:"prompt_tokens"`
	CompletionTokens         int64 `json:"completion_tokens"`
	EffectiveCacheReadTokens int64 `json:"effective_cache_read_tokens"`
	EffectiveTotalTokens     int64 `json:"effective_total_tokens"`
}

// EventPartitionInput holds the raw per-record fields used by NormalizeEventPartition.
type EventPartitionInput struct {
	IsCanonical         bool
	Provider            string
	ExecutorType        string
	Endpoint            string
	InputTokens         int64
	OutputTokens        int64
	ReasoningTokens     int64
	CachedTokens        int64
	CacheReadTokens     int64
	CacheCreationTokens int64
	TotalTokens         int64
}

// NormalizeEventPartition is the pure Go equivalent of eventPromptExpr,
// eventCompletionExpr, eventCacheReadExpr, and eventTotalExpr for single-record oracles.
func NormalizeEventPartition(in EventPartitionInput) (promptTokens, completionTokens, effectiveCacheRead, effectiveTotal int64) {
	rawInput := max(in.InputTokens, 0)
	rawOutput := max(in.OutputTokens, 0)
	total := max(in.TotalTokens, 0)
	if in.IsCanonical {
		promptTokens = rawInput
		completionTokens = rawOutput
		effectiveCacheRead = max(in.CacheReadTokens, 0)
		effectiveTotal = max(total, promptTokens+completionTokens)
		return
	}
	if in.CacheReadTokens > 0 {
		effectiveCacheRead = in.CacheReadTokens
	} else {
		effectiveCacheRead = max(in.CachedTokens, 0)
	}
	cacheWrite := max(in.CacheCreationTokens, 0)
	cacheTotal := effectiveCacheRead + cacheWrite
	reasoning := max(in.ReasoningTokens, 0)
	minComp := max(rawOutput, reasoning, 0)
	sepComp := rawOutput + reasoning

	semantics := resolveEventTokenSemantics(in.Provider, in.ExecutorType, in.Endpoint)

	isDisjointInput := cacheTotal > 0 && rawInput > 0 && ((semantics == 2 && (in.CacheReadTokens > 0 || in.CacheCreationTokens > 0)) ||
		(semantics == 0 && ((rawInput < cacheTotal && total <= rawInput+minComp) ||
			(in.CachedTokens <= 0 && ((reasoning == 0 && total == rawInput+cacheTotal+minComp) ||
				(reasoning > 0 && total == rawInput+cacheTotal+sepComp))))))

	var promptBase int64
	if isDisjointInput {
		promptBase = rawInput + cacheTotal
	} else {
		promptBase = max(rawInput, cacheTotal)
	}

	if reasoning > 0 && rawOutput > 0 && (semantics == 3 || (semantics == 0 && total == promptBase+sepComp)) {
		completionTokens = sepComp
	} else {
		completionTokens = minComp
	}

	if semantics == 0 && rawInput == 0 && cacheTotal == 0 && in.CachedTokens <= 0 && total > completionTokens {
		promptTokens = total - completionTokens
	} else {
		promptTokens = promptBase
	}
	effectiveTotal = max(total, promptTokens+completionTokens)
	return
}

// resolveEventTokenSemantics mirrors eventSemanticsCodeExpr and CPA's
// tokenAccountingSemanticsFor: 1=subset, 2=independent, 3=separate_reasoning, 0=unknown.
func resolveEventTokenSemantics(provider, executorType, endpoint string) int {
	prov := strings.ToLower(strings.TrimSpace(provider))
	exec := strings.ToLower(strings.TrimSpace(executorType))
	if exec == "openaicompatexecutor" || prov == "openai-compatibility" || strings.HasPrefix(prov, "openai-compatible-") {
		return 1
	}
	combined := strings.TrimSpace(prov + " " + exec)
	if combined != "" && combined != "unknown" && combined != "unknown unknown" {
		if strings.Contains(combined, "claude") || strings.Contains(combined, "anthropic") {
			return 2
		}
		for _, m := range []string{"gemini", "aistudio", "antigravity", "vertex", "interaction"} {
			if strings.Contains(combined, m) {
				return 3
			}
		}
		for _, m := range []string{"openai", "codex", "xai", "grok", "kimi", "qwen", "deepseek", "openrouter"} {
			if strings.Contains(combined, m) {
				return 1
			}
		}
		return 0
	}
	switch {
	case strings.Contains(endpoint, "/v1/messages"):
		return 2
	case strings.Contains(endpoint, ":generateContent") || strings.Contains(endpoint, ":streamGenerateContent"):
		return 3
	case strings.Contains(endpoint, "/chat/completions") || strings.Contains(endpoint, "/responses"):
		return 1
	default:
		return 0
	}
}

// UsageMeasures is the additive content of one fact row or one request record.
type UsageMeasures struct {
	Accounting TokenAccountingMeasures
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
	m.Accounting.CanonicalRequests += other.Accounting.CanonicalRequests
	m.Accounting.UnresolvedRequests += other.Accounting.UnresolvedRequests
	m.Accounting.RawInputTokens += other.Accounting.RawInputTokens
	m.Accounting.RawOutputTokens += other.Accounting.RawOutputTokens
	m.Accounting.RawTotalTokens += other.Accounting.RawTotalTokens
	m.Accounting.PromptTokens += other.Accounting.PromptTokens
	m.Accounting.CompletionTokens += other.Accounting.CompletionTokens
	m.Accounting.EffectiveCacheReadTokens += other.Accounting.EffectiveCacheReadTokens
	m.Accounting.EffectiveTotalTokens += other.Accounting.EffectiveTotalTokens
}

// UsageFactQuery is one read of deployment usage.
type UsageFactQuery struct {
	InstanceID string
	// FromMS and ToMS are inclusive.
	FromMS int64
	ToMS   int64
	// BucketMS is the series grid on the epoch. Zero returns one row per group for
	// the whole window, with StartMS zero. Ignored when Calendar is set.
	BucketMS int64
	// Calendar replaces the epoch grid with civil buckets in a time zone.
	Calendar *UsageCalendar
	// Dimensions partition the rows, in this order; none returns one series for
	// the whole deployment.
	Dimensions []UsageDimension
	// Filters keep only rows whose dimension value is one of the listed values.
	// An empty list for a dimension is no constraint.
	Filters map[UsageDimension][]string
	// ClientAgents keeps only the generation requests of these client programs.
	// Client attribution is rolled up beside the request records and pruned with
	// them, so such a read starts no earlier than the request-record horizon.
	ClientAgents []string
}

// UsageFactRow is one group's usage inside one bucket.
type UsageFactRow struct {
	// Keys holds one value per requested dimension, in the query's order.
	Keys    []string
	StartMS int64
	UsageMeasures
}

// UsageFactResult is a usage read together with what it actually covered.
type UsageFactResult struct {
	// Rows are ordered by their keys and then by bucket.
	Rows []UsageFactRow
	// FromMS, ToMS and BucketMS are the window that was read. They differ from the
	// request only where request records for part of it have been deleted: the
	// window is then widened to whole fact buckets, because a bucket cannot be
	// split once the records behind it are gone. BucketMS is zero for a calendar read.
	FromMS   int64
	ToMS     int64
	BucketMS int64
	// FactRequests were answered from the fact tables and DetailRequests from
	// request records, so a caller can say how much of a window was pre-aggregated.
	FactRequests   int64
	DetailRequests int64
	// Clipped reports that a client read started at the request-record horizon
	// rather than at the requested FromMS.
	Clipped bool
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
	// localFrom and localTo bound the whole local days inside the core, as
	// instants, and wallFrom and wallTo name the same days on the wall clock.
	// Equal instants mean the local grain is not read.
	localFrom, localTo int64
	wallFrom, wallTo   int64
	// localMarker is the checkpoint row that must exist for the local grain to
	// answer [localFrom, localTo); without it the fine table answers instead.
	localMarker string
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

// planUsageFactRead cuts a window into sources. isDailyUsable says whether a whole
// UTC day of the daily table falls inside a single output bucket; an epoch grid of
// whole days and the totals read guarantee it, and a calendar grid only when its
// zone keeps a zero offset over the window.
func planUsageFactRead(horizonMS, fromMS, toMS, bucketMS int64, isDailyUsable bool) usageFactPlan {
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

	if isDailyUsable {
		dailyFrom := alignUp(fromMS, DayBucketMS)
		dailyTo := alignDown(toMS+1, DayBucketMS)
		if dailyFrom < dailyTo {
			plan.dailyFrom, plan.dailyTo = dailyFrom, dailyTo
		}
	}
	return plan
}

// calendarGrid is a calendar read compiled for SQL: the wall-clock bucket width and
// the zone's offsets over the window, as half-open instant segments.
type calendarGrid struct {
	location *time.Location
	unit     UsageCalendarUnit
	segments []offsetSegment
}

type offsetSegment struct {
	// untilMS is exclusive; the last segment's is unused.
	untilMS  int64
	offsetMS int64
}

// compileCalendar lists the offsets a zone takes over [fromMS, toMS]. Zones change
// offset a handful of times a year, so the list stays short however long the window.
func compileCalendar(calendar UsageCalendar, fromMS, toMS int64) (calendarGrid, error) {
	if calendar.Location == nil {
		return calendarGrid{}, errors.New("calendar read needs a time zone")
	}
	switch calendar.Unit {
	case UsageCalendarHour, UsageCalendarDay, UsageCalendarWeek:
	default:
		return calendarGrid{}, fmt.Errorf("unknown calendar unit %q", calendar.Unit)
	}
	grid := calendarGrid{location: calendar.Location, unit: calendar.Unit}
	at := time.UnixMilli(fromMS).In(calendar.Location)
	for {
		_, offset := at.Zone()
		_, end := at.ZoneBounds()
		segment := offsetSegment{offsetMS: int64(offset) * 1000}
		if end.IsZero() || end.UnixMilli() > toMS {
			grid.segments = append(grid.segments, segment)
			return grid, nil
		}
		segment.untilMS = end.UnixMilli()
		grid.segments = append(grid.segments, segment)
		at = end.In(calendar.Location)
	}
}

// isZeroOffset reports whether the zone sits on UTC for the whole window, which is
// the only case where a UTC day of the daily table is also a local day.
func (grid calendarGrid) isZeroOffset() bool {
	for _, segment := range grid.segments {
		if segment.offsetMS != 0 {
			return false
		}
	}
	return true
}

// wallClock renders the SQL for an instant column's local wall-clock time, as
// milliseconds on a clock that never changes offset.
//
// Bucketing the wall clock rather than the instant is what keeps a local day one
// bucket when daylight saving starts or ends inside it: every row of that day has
// the same wall-clock date, whichever offset it was recorded under. Every offset in
// use is a multiple of fifteen minutes and transitions fall on fact buckets, so a
// fact row never straddles a local hour.
func (grid calendarGrid) wallClock(column string) string {
	if len(grid.segments) == 1 {
		return fmt.Sprintf("(%s + %d)", column, grid.segments[0].offsetMS)
	}
	var builder strings.Builder
	builder.WriteString("(" + column + " + CASE")
	for _, segment := range grid.segments[:len(grid.segments)-1] {
		fmt.Fprintf(&builder, " WHEN %s < %d THEN %d", column, segment.untilMS, segment.offsetMS)
	}
	fmt.Fprintf(&builder, " ELSE %d END)", grid.segments[len(grid.segments)-1].offsetMS)
	return builder.String()
}

// The Unix epoch fell on a Thursday; shifting by three days puts week boundaries
// on Monday.
const mondayShiftMS = 3 * DayBucketMS

// bucket renders the SQL for the wall-clock start of the bucket holding a column.
func (grid calendarGrid) bucket(column string) string {
	wall := grid.wallClock(column)
	switch grid.unit {
	case UsageCalendarHour:
		return fmt.Sprintf("((%s / %d) * %d)", wall, HourBucketMS, HourBucketMS)
	case UsageCalendarDay:
		return fmt.Sprintf("((%s / %d) * %d)", wall, DayBucketMS, DayBucketMS)
	default:
		week := 7 * DayBucketMS
		return fmt.Sprintf("(((%s + %d) / %d) * %d - %d)", wall, mondayShiftMS, week, week, mondayShiftMS)
	}
}

// instant turns a wall-clock bucket start back into the instant it names. A local
// midnight or hour that a daylight-saving jump skips resolves forward, as Go's
// time.Date does.
func (grid calendarGrid) instant(wallMS int64) int64 {
	wall := time.UnixMilli(wallMS).UTC()
	return time.Date(wall.Year(), wall.Month(), wall.Day(), wall.Hour(), 0, 0, 0, grid.location).UnixMilli()
}

// bucketFromWall renders the bucket for a column that already holds a wall-clock
// local midnight, as the local grain does.
func (grid calendarGrid) bucketFromWall(column string) string {
	if grid.unit == UsageCalendarDay {
		return column
	}
	week := 7 * DayBucketMS
	return fmt.Sprintf("(((%s + %d) / %d) * %d - %d)", column, mondayShiftMS, week, week, mondayShiftMS)
}

// localMidnight is the instant a local day begins, and the same day's midnight on
// the wall clock. A midnight that a daylight-saving jump skips resolves to the
// first instant of that day, which is also where its records start.
func localMidnight(at time.Time, location *time.Location, dayOffset int) (int64, int64) {
	local := at.In(location)
	start := time.Date(local.Year(), local.Month(), local.Day()+dayOffset, 0, 0, 0, 0, location)
	wall := time.Date(start.Year(), start.Month(), start.Day(), 0, 0, 0, 0, time.UTC)
	return start.UnixMilli(), wall.UnixMilli()
}

// planLocalDays marks the whole local days inside the plan's quarter-hour core for
// the local grain. Local midnights fall on quarter hours in every zone, so the
// fine table still answers exactly what is left on either side.
func planLocalDays(plan *usageFactPlan, location *time.Location) {
	if plan.fineFrom >= plan.fineTo {
		return
	}
	fromMS, fromWall := localMidnight(time.UnixMilli(plan.fineFrom), location, 0)
	if fromMS < plan.fineFrom {
		fromMS, fromWall = localMidnight(time.UnixMilli(plan.fineFrom), location, 1)
	}
	toMS, toWall := localMidnight(time.UnixMilli(plan.fineTo), location, 0)
	if fromMS >= toMS {
		return
	}
	plan.localFrom, plan.localTo, plan.wallFrom, plan.wallTo = fromMS, toMS, fromWall, toWall
	plan.localMarker = localFactsMarkerPrefix + location.String()
}

// QueryUsageFacts answers one usage window, for any partition, from the permanent
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
	for _, dimension := range query.Dimensions {
		if _, known := usageDimensionExpressions[dimension]; !known {
			return result, fmt.Errorf("unknown usage dimension %q", dimension)
		}
	}
	for dimension := range query.Filters {
		if _, known := usageDimensionExpressions[dimension]; !known {
			return result, fmt.Errorf("unknown usage filter %q", dimension)
		}
	}
	horizonMS, err := r.LifecycleHorizonMS(ctx, LifecycleUsageDetail)
	if err != nil {
		return result, err
	}
	isClientRead := len(query.ClientAgents) > 0
	if isClientRead && horizonMS > 0 && query.FromMS < horizonMS {
		result.Clipped = true
		if query.ToMS < horizonMS {
			result.FromMS, result.ToMS, result.BucketMS = query.FromMS, query.ToMS, query.BucketMS
			if query.Calendar != nil {
				result.BucketMS = 0
			}
			return result, nil
		}
		query.FromMS = horizonMS
	}
	var grid *calendarGrid
	bucketMS := query.BucketMS
	isDailyUsable := bucketMS == 0 || bucketMS%DayBucketMS == 0
	if query.Calendar != nil {
		compiled, errCompile := compileCalendar(*query.Calendar, query.FromMS, query.ToMS)
		if errCompile != nil {
			return result, errCompile
		}
		grid = &compiled
		// The grid only needs to be a multiple of the fact grain here; the calendar
		// expression does the bucketing.
		bucketMS = QuarterHourBucketMS
		isDailyUsable = query.Calendar.Unit != UsageCalendarHour && compiled.isZeroOffset()
	}
	plan := planUsageFactRead(horizonMS, query.FromMS, query.ToMS, bucketMS, isDailyUsable)
	// The local-day grain has no client counterpart; the fine table answers instead.
	if grid != nil && !isDailyUsable && grid.unit != UsageCalendarHour && !isClientRead {
		planLocalDays(&plan, grid.location)
	}
	hasLocalMarker := false
	if plan.localMarker != "" {
		if err := r.SQL().QueryRowContext(ctx, `
			SELECT EXISTS (SELECT 1 FROM usage_aggregation_checkpoints WHERE name = ?)`,
			plan.localMarker).Scan(&hasLocalMarker); err != nil {
			return result, fmt.Errorf("read local usage fact marker: %w", err)
		}
	}
	result.FromMS, result.ToMS, result.BucketMS = plan.fromMS, plan.toMS, plan.bucketMS
	if grid != nil {
		result.BucketMS = 0
	}

	statement, args := buildUsageFactStatement(plan, query, grid, hasLocalMarker, true)
	rows, err := r.SQL().QueryContext(ctx, statement, args...)
	if err != nil {
		return result, fmt.Errorf("read usage facts: %w", err)
	}
	defer rows.Close()
	dimCount := len(query.Dimensions)
	var factRequests int64
	targets := make([]any, dimCount+1+len(usageFactMeasures)+1)
	targets[dimCount+1+len(usageFactMeasures)] = &factRequests
	var instantCache map[int64]int64
	if grid != nil {
		instantCache = make(map[int64]int64, 128)
	}
	for rows.Next() {
		row := UsageFactRow{Keys: make([]string, dimCount)}
		for index := 0; index < dimCount; index++ {
			targets[index] = &row.Keys[index]
		}
		targets[dimCount] = &row.StartMS
		fillUsageMeasureTargets(targets[dimCount+1:dimCount+1+len(usageFactMeasures)], &row.UsageMeasures)
		if errScan := rows.Scan(targets...); errScan != nil {
			return result, fmt.Errorf("scan usage fact row: %w", errScan)
		}
		if grid != nil {
			if converted, ok := instantCache[row.StartMS]; ok {
				row.StartMS = converted
			} else {
				converted = grid.instant(row.StartMS)
				instantCache[row.StartMS] = converted
				row.StartMS = converted
			}
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

func fillUsageMeasureTargets(dst []any, measures *UsageMeasures) {
	t := &measures.UsageTotals
	dst[0], dst[1] = &t.Requests, &t.Failures
	dst[2], dst[3], dst[4] = &t.InputTokens, &t.OutputTokens, &t.ReasoningTokens
	dst[5], dst[6], dst[7] = &t.CachedTokens, &t.CacheReadTokens, &t.CacheCreationTokens
	dst[8] = &t.TotalTokens
	dst[9], dst[10], dst[11] = &t.LatencySumMS, &t.TTFTSumMS, &t.TTFTCount
	dst[12], dst[13], dst[14] = &measures.CostNanos, &measures.PricedRequests, &measures.CostedRequests
	dst[15], dst[16] = &measures.Accounting.CanonicalRequests, &measures.Accounting.UnresolvedRequests
	dst[17], dst[18], dst[19] = &measures.Accounting.RawInputTokens, &measures.Accounting.RawOutputTokens, &measures.Accounting.RawTotalTokens
	dst[20], dst[21], dst[22] = &measures.Accounting.PromptTokens, &measures.Accounting.CompletionTokens, &measures.Accounting.EffectiveCacheReadTokens
	dst[23] = &measures.Accounting.EffectiveTotalTokens
}

// ClientKeyFilter narrows a read to one client key fingerprint, or to nothing
// when the fingerprint is empty.
func ClientKeyFilter(fingerprint string) map[UsageDimension][]string {
	if fingerprint == "" {
		return nil
	}
	return map[UsageDimension][]string{UsageDimensionKey: {fingerprint}}
}

// usageFilterClause renders the filters in a stable order, so one query always
// compiles to one statement.
func usageFilterClause(filters map[UsageDimension][]string) (string, []any) {
	dimensions := make([]string, 0, len(filters))
	for dimension, values := range filters {
		if len(values) > 0 {
			dimensions = append(dimensions, string(dimension))
		}
	}
	sort.Strings(dimensions)
	var clause strings.Builder
	var args []any
	for _, name := range dimensions {
		values := filters[UsageDimension(name)]
		clause.WriteString(" AND " + usageDimensionExpressions[UsageDimension(name)] + " IN (" +
			strings.TrimSuffix(strings.Repeat("?, ", len(values)), ", ") + ")")
		for _, value := range values {
			args = append(args, value)
		}
	}
	return clause.String(), args
}

func buildUsageFactStatement(plan usageFactPlan, query UsageFactQuery, grid *calendarGrid, hasLocalMarker, includeTailArm bool) (string, []any) {
	aligned := func(column string) string {
		if grid != nil {
			return grid.bucket(column)
		}
		if plan.bucketMS == 0 {
			return "0"
		}
		return fmt.Sprintf("(%s / %d) * %d", column, plan.bucketMS, plan.bucketMS)
	}
	keyColumns := make([]string, 0, len(query.Dimensions))
	keyNames := make([]string, 0, len(query.Dimensions))
	for index, dimension := range query.Dimensions {
		name := fmt.Sprintf("k%d", index)
		keyColumns = append(keyColumns, usageDimensionExpressions[dimension]+" AS "+name)
		keyNames = append(keyNames, name)
	}
	keySelect := ""
	keyPass := ""
	if len(keyColumns) > 0 {
		keySelect = strings.Join(keyColumns, ", ") + ", "
		keyPass = strings.Join(keyNames, ", ") + ", "
	}

	filterClause, filterArgs := usageFilterClause(query.Filters)
	factFilter, eventFilter := filterClause, filterClause
	fineTable, dailyTable := usageFactsFineTable, usageFactsDailyTable
	factMeasures := strings.Join(usageFactMeasures, ", ")
	if len(query.ClientAgents) > 0 {
		// Client facts count generation requests only and fold an unattributed one as
		// "unknown", so the request-record arms read the same way.
		in := " IN (" + strings.TrimSuffix(strings.Repeat("?, ", len(query.ClientAgents)), ", ") + ")"
		factFilter += " AND client_agent" + in
		eventFilter += " AND generate = 1 AND (CASE WHEN client_agent = '' THEN 'unknown' ELSE client_agent END)" + in
		for _, agent := range query.ClientAgents {
			filterArgs = append(filterArgs, agent)
		}
		fineTable, dailyTable = usageClientFactsFineTable, usageClientFactsDailyTable
		factMeasures = usageClientFactProjection
	}
	withFilters := func(args ...any) []any { return append(args, filterArgs...) }

	var parts []string
	var args []any
	factArm := func(table string, fromMS, toMS int64) {
		if fromMS >= toMS {
			return
		}
		parts = append(parts, `
			SELECT 1 AS from_facts, `+keySelect+aligned("bucket_start_ms")+` AS aligned, `+factMeasures+`
			FROM `+table+`
			WHERE instance_id = ? AND bucket_start_ms >= ? AND bucket_start_ms < ?`+factFilter)
		args = append(args, withFilters(query.InstanceID, fromMS, toMS)...)
	}
	// Each arm over usage_events names its index. The planner cannot know that the
	// records past the checkpoint are a handful while the window may span years,
	// and the wrong choice turns the dashboard's five-second poll into a scan of
	// every retained record.
	eventArm := func(index, predicate string, predicateArgs ...any) {
		parts = append(parts, buildStagedUsageEventsArm(keySelect, keyPass, aligned("timestamp_ms"), "INDEXED BY "+index, "instance_id = ? AND "+predicate+eventFilter))
		args = append(args, withFilters(append([]any{query.InstanceID}, predicateArgs...)...)...)
	}
	const checkpoint = `(SELECT COALESCE((SELECT last_usage_event_id FROM usage_aggregation_checkpoints WHERE name = '` + CheckpointFacts + `'), 0))`

	if plan.fineFrom < plan.fineTo && plan.localFrom < plan.localTo {
		factArm(usageFactsFineTable, plan.fineFrom, plan.localFrom)
		factArm(usageFactsFineTable, plan.localTo, plan.fineTo)
		// When the local-day grain was already marked complete, include both the
		// EXISTS local arm and a NOT EXISTS fine fallback in the same snapshot so a
		// concurrent timezone rebuild still reads a complete partition while NOT EXISTS
		// short-circuits when the marker holds. When the pre-check found no marker,
		// read the fine table unconditionally so a marker committed between the
		// pre-check and this snapshot cannot silence both arms.
		const marker = ` AND EXISTS (SELECT 1 FROM usage_aggregation_checkpoints WHERE name = ?)`
		fallbackGuard := ""
		if hasLocalMarker {
			parts = append(parts, `
			SELECT 1 AS from_facts, `+keySelect+grid.bucketFromWall("day_wall_ms")+` AS aligned, `+strings.Join(usageFactMeasures, ", ")+`
			FROM `+usageFactsLocalTable+`
			WHERE instance_id = ? AND zone = ? AND day_wall_ms >= ? AND day_wall_ms < ?`+filterClause+marker)
			args = append(args, withFilters(query.InstanceID, grid.location.String(), plan.wallFrom, plan.wallTo)...)
			args = append(args, plan.localMarker)
			fallbackGuard = ` AND NOT` + strings.TrimPrefix(marker, " AND")
		}
		parts = append(parts, `
			SELECT 1 AS from_facts, `+keySelect+aligned("bucket_start_ms")+` AS aligned, `+strings.Join(usageFactMeasures, ", ")+`
			FROM `+usageFactsFineTable+`
			WHERE instance_id = ? AND bucket_start_ms >= ? AND bucket_start_ms < ?`+filterClause+fallbackGuard)
		args = append(args, withFilters(query.InstanceID, plan.localFrom, plan.localTo)...)
		if hasLocalMarker {
			args = append(args, plan.localMarker)
		}
	} else if plan.fineFrom < plan.fineTo {
		factArm(dailyTable, plan.dailyFrom, plan.dailyTo)
		factArm(fineTable, plan.fineFrom, plan.dailyFrom)
		factArm(fineTable, plan.dailyTo, plan.fineTo)
	}
	if plan.fineFrom < plan.fineTo {
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
	if includeTailArm {
		eventArm("idx_usage_events_instance_id",
			`id > `+checkpoint+` AND timestamp_ms >= ? AND timestamp_ms <= ?`, plan.fromMS, plan.toMS)
	}

	sums := make([]string, 0, len(usageFactMeasures))
	for _, measure := range usageFactMeasures {
		sums = append(sums, "COALESCE(SUM("+measure+"), 0)")
	}
	groupColumns := strings.Join(append(append([]string{}, keyNames...), "aligned"), ", ")
	keyOutput := ""
	if len(keyNames) > 0 {
		keyOutput = strings.Join(keyNames, ", ") + ", "
	}
	statement := `
		SELECT ` + keyOutput + `aligned, ` + strings.Join(sums, ", ") + `,
		       COALESCE(SUM(CASE WHEN from_facts = 1 THEN requests ELSE 0 END), 0)
		FROM (` + strings.Join(parts, `
			UNION ALL`) + `
		)
		GROUP BY ` + groupColumns + `
		ORDER BY ` + strings.ReplaceAll(groupColumns, ", ", " ASC, ") + ` ASC`
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
	var minTS, maxTS sql.NullInt64
	err = tx.QueryRowContext(ctx, `
		SELECT MAX(id), COUNT(1), MIN(timestamp_ms), MAX(timestamp_ms)
		FROM (SELECT id, timestamp_ms FROM usage_events WHERE id > ? ORDER BY id ASC LIMIT ?)`,
		lastID, batchSize).Scan(&highID, &absorbed, &minTS, &maxTS)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return 0, fmt.Errorf("find usage fold high water: %w", err)
	}
	if !highID.Valid {
		return 0, nil
	}

	measureColumns := strings.Join(usageFactMeasures, ", ")
	clientMeasureColumns := strings.Join(usageClientFactMeasures, ", ")
	if err := resetUsageStageBuffer(ctx, tx); err != nil {
		return 0, err
	}
	defer func() { _, _ = tx.ExecContext(ctx, `DELETE FROM temp._omc_usage_stage_15m`) }()
	if err := resetUsageFoldBuffer(ctx, tx); err != nil {
		return 0, err
	}
	defer func() { _, _ = tx.ExecContext(ctx, `DELETE FROM temp._omc_usage_fold_15m`) }()
	if err := resetClientUsageFoldBuffer(ctx, tx); err != nil {
		return 0, err
	}
	defer func() { _, _ = tx.ExecContext(ctx, `DELETE FROM temp._omc_usage_client_fold_15m`) }()

	_, err = tx.ExecContext(ctx, `
		WITH s1 AS MATERIALIZED (
			SELECT instance_id, (timestamp_ms / ?1) * ?1 AS bucket_start_ms,
			       api_group_key, model, COALESCE(model_alias, '') AS model_alias,
			       auth_index, provider, auth_type,
			       generate,
			       CASE WHEN generate = 1 THEN CASE WHEN client_agent = '' THEN 'unknown' ELSE client_agent END ELSE '' END AS client_agent,
			       CASE WHEN generate = 1 THEN client_prefix ELSE '' END AS client_prefix,
			       failed, input_tokens, output_tokens, reasoning_tokens,
			       cached_tokens, cache_read_tokens, cache_creation_tokens, total_tokens,
			       latency_ms, ttft_ms, cost_nanos, pricing_status,
			       CASE WHEN token_accounting IS NULL THEN 0 ELSE COALESCE(json_extract(token_accounting, '$.raw_tokens.input_tokens'), 0) END AS raw_input_tokens,
			       CASE WHEN token_accounting IS NULL THEN 0 ELSE COALESCE(json_extract(token_accounting, '$.raw_tokens.output_tokens'), 0) END AS raw_output_tokens,
			       CASE WHEN token_accounting IS NULL THEN 0 ELSE COALESCE(json_extract(token_accounting, '$.raw_tokens.total_tokens'), 0) END AS raw_total_tokens,
			       `+eventStage1Cols+`
			FROM usage_events
			WHERE id > ?2 AND id <= ?3
		)
		INSERT INTO temp._omc_usage_stage_15m (instance_id, bucket_start_ms, `+usageClientFactDimensions+`, generate, `+measureColumns+`)
		SELECT instance_id, bucket_start_ms, api_group_key, model, model_alias, auth_index, provider, auth_type,
		       client_agent, client_prefix, generate,
		       COUNT(1), SUM(failed), SUM(input_tokens), SUM(output_tokens), SUM(reasoning_tokens),
		       SUM(cached_tokens), SUM(cache_read_tokens), SUM(cache_creation_tokens), SUM(total_tokens),
		       SUM(latency_ms), SUM(COALESCE(ttft_ms, 0)), SUM(ttft_ms IS NOT NULL),
		       SUM(COALESCE(cost_nanos, 0)), SUM(pricing_status = 'priced'), SUM(cost_nanos IS NOT NULL),
		       SUM(_isc), SUM(_iur),
		       SUM(raw_input_tokens), SUM(raw_output_tokens), SUM(raw_total_tokens),
		       SUM(_pr), SUM(_comp), SUM(_cr), SUM(`+stageTotalExpr+`)
		FROM (
			SELECT *, `+stagePromptFromPBCompExpr+` AS _pr
			FROM (
				SELECT *, `+stageCompFromPBExpr+` AS _comp
				FROM (
					SELECT *, `+stagePromptBaseExpr+` AS _pb FROM s1
				)
			)
		)
		GROUP BY instance_id, bucket_start_ms, api_group_key, model, model_alias, auth_index, provider, auth_type, client_agent, client_prefix, generate`,
		QuarterHourBucketMS, lastID, highID.Int64)
	if err != nil {
		return 0, fmt.Errorf("stage usage fold batch: %w", err)
	}

	factSums := make([]string, 0, len(usageFactMeasures))
	for _, measure := range usageFactMeasures {
		factSums = append(factSums, "SUM("+measure+")")
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO temp._omc_usage_fold_15m (instance_id, bucket_start_ms, `+usageFactDimensions+`, `+measureColumns+`)
		SELECT instance_id, bucket_start_ms, `+usageFactDimensions+`, `+strings.Join(factSums, ", ")+`
		FROM temp._omc_usage_stage_15m
		GROUP BY instance_id, bucket_start_ms, `+usageFactDimensions); err != nil {
		return 0, fmt.Errorf("stage usage facts fold batch: %w", err)
	}

	if _, err := tx.ExecContext(ctx, `
		INSERT INTO temp._omc_usage_client_fold_15m (instance_id, bucket_start_ms, `+usageClientFactDimensions+`, `+clientMeasureColumns+`)
		SELECT instance_id, bucket_start_ms, `+usageClientFactDimensions+`,
		       SUM(requests),
		       SUM(CASE WHEN generate = 1 THEN requests ELSE 0 END),
		       SUM(CASE WHEN generate = 1 THEN failures ELSE 0 END),
		       SUM(CASE WHEN generate = 1 THEN prompt_tokens ELSE 0 END),
		       SUM(CASE WHEN generate = 1 THEN completion_tokens ELSE 0 END),
		       SUM(CASE WHEN generate = 1 THEN reasoning_tokens ELSE 0 END),
		       SUM(CASE WHEN generate = 1 THEN effective_cache_read_tokens ELSE 0 END),
		       SUM(CASE WHEN generate = 1 THEN cache_creation_tokens ELSE 0 END),
		       SUM(CASE WHEN generate = 1 THEN effective_total_tokens ELSE 0 END),
		       SUM(CASE WHEN generate = 1 THEN latency_sum_ms ELSE 0 END),
		       SUM(CASE WHEN generate = 1 THEN ttft_sum_ms ELSE 0 END),
		       SUM(CASE WHEN generate = 1 THEN ttft_count ELSE 0 END),
		       SUM(CASE WHEN generate = 1 THEN cost_nanos ELSE 0 END),
		       SUM(CASE WHEN generate = 1 THEN priced_requests ELSE 0 END),
		       SUM(CASE WHEN generate = 1 THEN costed_requests ELSE 0 END)
		FROM temp._omc_usage_stage_15m
		GROUP BY instance_id, bucket_start_ms, `+usageClientFactDimensions); err != nil {
		return 0, fmt.Errorf("stage client usage fold batch: %w", err)
	}

	if err := foldUsageBuffer(ctx, tx, minTS.Int64, maxTS.Int64); err != nil {
		return 0, err
	}
	if err := foldClientUsageBuffer(ctx, tx); err != nil {
		return 0, err
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

// resetUsageStageBuffer prepares the connection-local TEMP table that stages
// one raw batch once before populating both usage_facts_* and usage_client_facts_*.
func resetUsageStageBuffer(ctx context.Context, tx *sql.Tx) error {
	if _, err := tx.ExecContext(ctx, `
		CREATE TEMP TABLE IF NOT EXISTS _omc_usage_stage_15m AS
		SELECT instance_id, bucket_start_ms, `+usageClientFactDimensions+`, 0 AS generate, `+strings.Join(usageFactMeasures, ", ")+`
		FROM `+usageFactsFineTable+`, (SELECT '' AS client_agent, '' AS client_prefix) WHERE 0`); err != nil {
		return fmt.Errorf("prepare temp usage stage buffer: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM temp._omc_usage_stage_15m`); err != nil {
		return fmt.Errorf("reset temp usage stage buffer: %w", err)
	}
	return nil
}

// resetUsageFoldBuffer readies the connection-local TEMP table a fold stages its
// 15-minute rows in. Because every civil UTC offset is a multiple of 15 minutes,
// 15m, UTC-daily and local-daily all roll up from those rows.
func resetUsageFoldBuffer(ctx context.Context, tx *sql.Tx) error {
	if _, err := tx.ExecContext(ctx, `
		CREATE TEMP TABLE IF NOT EXISTS _omc_usage_fold_15m AS
		SELECT instance_id, bucket_start_ms, `+usageFactDimensions+`, `+strings.Join(usageFactMeasures, ", ")+`
		FROM `+usageFactsFineTable+` WHERE 0`); err != nil {
		return fmt.Errorf("prepare temp usage fold buffer: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM temp._omc_usage_fold_15m`); err != nil {
		return fmt.Errorf("reset temp usage fold buffer: %w", err)
	}
	return nil
}

// resetClientUsageFoldBuffer prepares the connection-local TEMP table that
// stages 15-minute client attribution rows before folding into 15m and daily grains.
func resetClientUsageFoldBuffer(ctx context.Context, tx *sql.Tx) error {
	if _, err := tx.ExecContext(ctx, `
		CREATE TEMP TABLE IF NOT EXISTS _omc_usage_client_fold_15m AS
		SELECT instance_id, bucket_start_ms, `+usageClientFactDimensions+`, `+strings.Join(usageClientFactMeasures, ", ")+`
		FROM `+usageClientFactsFineTable+` WHERE 0`); err != nil {
		return fmt.Errorf("prepare temp client usage fold buffer: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM temp._omc_usage_client_fold_15m`); err != nil {
		return fmt.Errorf("reset temp client usage fold buffer: %w", err)
	}
	return nil
}

// foldClientUsageBuffer adds the staged 15-minute client attribution rows into
// both usage_client_facts_15m and usage_client_facts_daily inside one transaction.
func foldClientUsageBuffer(ctx context.Context, tx *sql.Tx) error {
	updates := make([]string, 0, len(usageClientFactMeasures))
	sums := make([]string, 0, len(usageClientFactMeasures))
	for _, measure := range usageClientFactMeasures {
		updates = append(updates, measure+" = "+measure+" + excluded."+measure)
		sums = append(sums, "SUM("+measure+")")
	}
	updateSet := strings.Join(updates, ", ")
	sumSelect := strings.Join(sums, ", ")
	measureColumns := strings.Join(usageClientFactMeasures, ", ")

	if _, err := tx.ExecContext(ctx, `
		INSERT INTO `+usageClientFactsFineTable+` (instance_id, bucket_start_ms, `+usageClientFactDimensions+`, `+measureColumns+`)
		SELECT instance_id, bucket_start_ms, `+usageClientFactDimensions+`, `+measureColumns+`
		FROM temp._omc_usage_client_fold_15m
		WHERE true
		ON CONFLICT DO UPDATE SET `+updateSet); err != nil {
		return fmt.Errorf("fold usage into %s: %w", usageClientFactsFineTable, err)
	}

	if _, err := tx.ExecContext(ctx, `
		INSERT INTO `+usageClientFactsDailyTable+` (instance_id, bucket_start_ms, `+usageClientFactDimensions+`, `+measureColumns+`)
		SELECT instance_id, (bucket_start_ms / ?1) * ?1, `+usageClientFactDimensions+`, `+sumSelect+`
		FROM temp._omc_usage_client_fold_15m
		GROUP BY instance_id, (bucket_start_ms / ?1) * ?1, `+usageClientFactDimensions+`
		ON CONFLICT DO UPDATE SET `+updateSet,
		DayBucketMS); err != nil {
		return fmt.Errorf("fold usage into %s: %w", usageClientFactsDailyTable, err)
	}
	return nil
}

// foldUsageBuffer adds the staged rows, whose requests started between fromMS and
// toMS, to every fact grain. Rows are additive, so a staged row may be a batch of
// new records or a correction to records already folded.
func foldUsageBuffer(ctx context.Context, tx *sql.Tx, fromMS, toMS int64) error {
	updates := make([]string, 0, len(usageFactMeasures))
	sums := make([]string, 0, len(usageFactMeasures))
	for _, measure := range usageFactMeasures {
		updates = append(updates, measure+" = "+measure+" + excluded."+measure)
		sums = append(sums, "SUM("+measure+")")
	}
	updateSet := strings.Join(updates, ", ")
	sumSelect := strings.Join(sums, ", ")
	measureColumns := strings.Join(usageFactMeasures, ", ")

	if _, err := tx.ExecContext(ctx, `
		INSERT INTO `+usageFactsFineTable+` (instance_id, bucket_start_ms, `+usageFactDimensions+`, `+measureColumns+`)
		SELECT instance_id, bucket_start_ms, `+usageFactDimensions+`, `+measureColumns+`
		FROM temp._omc_usage_fold_15m
		WHERE true
		ON CONFLICT DO UPDATE SET `+updateSet); err != nil {
		return fmt.Errorf("fold usage into %s: %w", usageFactsFineTable, err)
	}

	if _, err := tx.ExecContext(ctx, `
		INSERT INTO `+usageFactsDailyTable+` (instance_id, bucket_start_ms, `+usageFactDimensions+`, `+measureColumns+`)
		SELECT instance_id, (bucket_start_ms / ?1) * ?1, `+usageFactDimensions+`, `+sumSelect+`
		FROM temp._omc_usage_fold_15m
		GROUP BY instance_id, (bucket_start_ms / ?1) * ?1, `+usageFactDimensions+`
		ON CONFLICT DO UPDATE SET `+updateSet,
		DayBucketMS); err != nil {
		return fmt.Errorf("fold usage into %s: %w", usageFactsDailyTable, err)
	}

	return foldLocalUsageFactsFromStaged(ctx, tx, (fromMS/QuarterHourBucketMS)*QuarterHourBucketMS, (toMS/QuarterHourBucketMS)*QuarterHourBucketMS, measureColumns, sumSelect, updateSet)
}

// localFactsSelect renders the grouped SELECT that turns rows of a source with an
// instant column into local-day rows, with the zone's offsets over [fromMS, toMS].
func localFactsSelect(location *time.Location, column string, fromMS, toMS int64) (string, error) {
	grid, err := compileCalendar(UsageCalendar{Location: location, Unit: UsageCalendarDay}, fromMS, toMS)
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("((%s / %d) * %d)", grid.wallClock(column), DayBucketMS, DayBucketMS), nil
}

// builtLocalZone names the zone the local grain is complete for, or nil.
func builtLocalZone(ctx context.Context, querier interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}) (*time.Location, error) {
	var name string
	err := querier.QueryRowContext(ctx, `
		SELECT name FROM usage_aggregation_checkpoints WHERE name LIKE ? ORDER BY name LIMIT 1`,
		localFactsMarkerPrefix+"%").Scan(&name)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read local usage grain: %w", err)
	}
	location, err := time.LoadLocation(strings.TrimPrefix(name, localFactsMarkerPrefix))
	if err != nil {
		return nil, fmt.Errorf("%w %q: %v", errUnknownLocalGrainZone, name, err)
	}
	return location, nil
}

// foldLocalUsageFactsFromStaged adds one staged 15-minute fold batch to the local
// grain, inside the fold's own transaction, when the grain is built. A grain that
// is not built is left alone: the rebuild that creates it reads the quarter hours,
// which already hold this batch by the time it runs.
func foldLocalUsageFactsFromStaged(ctx context.Context, tx *sql.Tx, fromBucketMS, toBucketMS int64, measureColumns, sumSelect, updateSet string) error {
	location, err := builtLocalZone(ctx, tx)
	if errors.Is(err, errUnknownLocalGrainZone) {
		// Derived rows cannot be extended without their calendar. Drop their claim
		// so reads fall back to quarter hours and a later rebuild can replace them.
		if errClear := clearLocalUsageFacts(ctx, tx); errClear != nil {
			return errClear
		}
		return nil
	}
	if err != nil || location == nil {
		return err
	}
	day, err := localFactsSelect(location, "bucket_start_ms", fromBucketMS, toBucketMS)
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `
		INSERT INTO `+usageFactsLocalTable+` (instance_id, zone, day_wall_ms, `+usageFactDimensions+`, `+measureColumns+`)
		SELECT instance_id, ?1, `+day+`, `+usageFactDimensions+`, `+sumSelect+`
		FROM temp._omc_usage_fold_15m
		GROUP BY instance_id, `+day+`, `+usageFactDimensions+`
		ON CONFLICT DO UPDATE SET `+updateSet,
		location.String())
	if err != nil {
		return fmt.Errorf("fold usage into %s: %w", usageFactsLocalTable, err)
	}
	return nil
}

// clearLocalUsageFacts removes the derived rows and every zone marker together;
// callers run it inside the transaction that makes the next state authoritative.
func clearLocalUsageFacts(ctx context.Context, tx *sql.Tx) error {
	if _, err := tx.ExecContext(ctx, `DELETE FROM `+usageFactsLocalTable); err != nil {
		return fmt.Errorf("clear local usage grain: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM usage_aggregation_checkpoints WHERE name LIKE ?`, localFactsMarkerPrefix+"%"); err != nil {
		return fmt.Errorf("clear local usage marker: %w", err)
	}
	return nil
}

// EnsureLocalUsageFacts builds the local grain for the deployment's current time
// zone when it is built for another one, or not at all, and reports whether it did.
//
// The rebuild is one transaction over the quarter hours: they cover exactly the
// event ids the checkpoint covers, so the rebuilt grain does too, and a read never
// sees a half-built table because the marker row commits with it. A zone the
// process only knows as `Local` has no name to rebuild under; reads in it keep
// folding quarter hours.
func (r *Repository) EnsureLocalUsageFacts(ctx context.Context) (bool, error) {
	if r == nil || r.SQL() == nil {
		return false, errors.New("repository is not initialized")
	}
	if r.Timezone() == nil {
		return false, nil
	}
	location := r.Timezone().Location()
	if location == nil || location.String() == "Local" {
		return false, nil
	}
	built, err := builtLocalZone(ctx, r.SQL())
	if err != nil && !errors.Is(err, errUnknownLocalGrainZone) {
		return false, err
	}
	if built != nil && built.String() == location.String() {
		return false, nil
	}
	tx, err := r.SQL().BeginTx(ctx, nil)
	if err != nil {
		return false, fmt.Errorf("begin local usage rebuild: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if err := clearLocalUsageFacts(ctx, tx); err != nil {
		return false, err
	}
	var fromMS, toMS sql.NullInt64
	if err := tx.QueryRowContext(ctx, `SELECT MIN(bucket_start_ms), MAX(bucket_start_ms) FROM `+usageFactsFineTable).Scan(&fromMS, &toMS); err != nil {
		return false, fmt.Errorf("bound local usage rebuild: %w", err)
	}
	if fromMS.Valid {
		day, errSelect := localFactsSelect(location, "bucket_start_ms", fromMS.Int64, toMS.Int64)
		if errSelect != nil {
			return false, errSelect
		}
		sums := make([]string, 0, len(usageFactMeasures))
		for _, measure := range usageFactMeasures {
			sums = append(sums, "SUM("+measure+")")
		}
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO `+usageFactsLocalTable+` (instance_id, zone, day_wall_ms, `+usageFactDimensions+`, `+strings.Join(usageFactMeasures, ", ")+`)
			SELECT instance_id, ?, `+day+`, `+usageFactDimensions+`, `+strings.Join(sums, ", ")+`
			FROM `+usageFactsFineTable+`
			GROUP BY instance_id, `+day+`, `+usageFactDimensions, location.String()); err != nil {
			return false, fmt.Errorf("rebuild local usage grain: %w", err)
		}
	}
	nowMS := time.Now().UnixMilli()
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO usage_aggregation_checkpoints (name, last_usage_event_id, stats_updated_at_ms, created_at_ms, updated_at_ms)
		VALUES (?, COALESCE((SELECT last_usage_event_id FROM usage_aggregation_checkpoints WHERE name = ?), 0), ?, ?, ?)`,
		localFactsMarkerPrefix+location.String(), CheckpointFacts, nowMS, nowMS, nowMS); err != nil {
		return false, fmt.Errorf("mark local usage grain: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return false, fmt.Errorf("commit local usage rebuild: %w", err)
	}
	return true, nil
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
