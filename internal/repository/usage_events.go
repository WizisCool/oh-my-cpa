package repository

import (
	"context"
	"database/sql"
	"encoding/base64"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/security"
	"github.com/oh-my-cpa/oh-my-cpa/internal/usage"
)

// Result filters for event queries. Kept as a small closed set so every page
// that narrows events (dashboard drill-down, ranking, analysis, export) agrees
// on what "failed" means.
const (
	ResultAll     = "all"
	ResultSuccess = "success"
	ResultFailed  = "failed"
)

// DefaultUsageEventLimit and MaxUsageEventLimit bound every event listing.
const (
	DefaultUsageEventLimit = 50
	MaxUsageEventLimit     = 500
)

// Cost availability vocabulary. It answers "does this record carry a locked
// price" instead of exposing the storage-level pricing_status machine to the
// console: a request whose price was unknown when it ran can never be repriced,
// so unpriced is a permanent property of the record rather than a state it moves
// out of. See internal/repository/usage_pricing.go for the four stored values.
const (
	CostStateAny      = ""
	CostStatePriced   = "priced"
	CostStateUnpriced = "unpriced"
)

// MaxUsageEventFilterValues bounds how many values one multi-select dimension
// may carry. The filter panel never approaches it; the cap exists so a
// hand-written URL cannot turn into a several-thousand-term IN list.
const MaxUsageEventFilterValues = 64

// ErrUsageFilterInvalid marks a filter the repository refuses to translate into
// SQL: an unknown enum value, a negative bound, an oversized dimension. Callers
// answer 400 for it, because the request is malformed rather than the server
// being broken.
var ErrUsageFilterInvalid = errors.New("invalid usage event filter")

// ErrUsageCursorStale marks a cursor whose position can no longer be resolved.
//
// This is the one case a legacy (id-only) cursor cannot be honoured: the list is
// ordered by request time, and recovering that timestamp needs the row itself.
// The handler answers 409 so the console can start over from the first page
// rather than silently serving a page from the wrong place in the list.
var ErrUsageCursorStale = errors.New("usage event cursor is stale")

// UsageEventFilter narrows event reads.
//
// This is the shared vocabulary for the whole request-record feature set: the
// dashboard drill-down, ranking, cost analysis and export all take this struct,
// so a filter added once here becomes available everywhere at once.
//
// Dimensions combine as AND; values inside one dimension combine as OR. An empty
// slice therefore means "do not narrow this dimension", which is the only
// reading that keeps a cleared multi-select equivalent to never having set it.
type UsageEventFilter struct {
	InstanceID string
	FromMS     int64
	ToMS       int64

	// Search is one literal substring applied across the identity columns in
	// usageEventSearchColumns. Wildcards a caller types are never honoured as
	// wildcards.
	Search string

	// Models matches the upstream model name exactly.
	Models []string
	// ModelAliases matches the client-requested alias when CPA reported one.
	ModelAliases []string
	// Providers is the upstream provider family CPA reported.
	Providers []string
	// APIGroupKeys are resolved API targets (client key, provider or endpoint).
	APIGroupKeys []string
	// AuthIndexes select credentials on the CPA instance.
	AuthIndexes []string
	// Sources are CPA's client-facing API key labels.
	Sources          []string
	AuthTypes        []string
	ExecutorTypes    []string
	ReasoningEfforts []string
	ServiceTiers     []string

	// Endpoint and UserAgent are substring matches. Both are long,
	// high-cardinality values that a console filters by typing rather than by
	// picking from a list, so they get a text field instead of a facet.
	Endpoint  string
	UserAgent string

	// RequestID looks up one request by its CPA id exactly.
	RequestID string
	Result    string

	// Numeric bounds are inclusive and nil means "this side is not filtering".
	// They are pointers because 0 is a meaningful bound: max_cost=0 selects the
	// records priced at nothing, which is not the same as having no bound at all.
	MinLatencyMS *int64
	MaxLatencyMS *int64
	MinTokens    *int64
	MaxTokens    *int64
	MinCostNanos *int64
	MaxCostNanos *int64

	// CostState narrows by price availability (CostStatePriced/Unpriced).
	CostState string

	// SinceID asks for a count of matching records ingested after this row id,
	// reported as ArrivedCount. It does not change which rows are returned.
	// Zero means "not requested".
	//
	// The anchor is an ingestion id on purpose, not a request time. "New records"
	// means newly recorded, and those are different questions once the list is
	// ordered by request time: a request that started earlier but finished later
	// arrives with an old timestamp, so it is genuinely new yet sorts far below
	// the top. Counting it as arrived is correct, and it also means the count does
	// not have to move when the visible sort order does.
	SinceID int64

	// Cursor is an opaque position in the list's own order. The client only ever
	// echoes it back, so its encoding is free to change with the ordering.
	Cursor string
	Limit  int
}

// UsageEventRow is one stored request record.
type UsageEventRow struct {
	ID            int64  `json:"id"`
	InstanceID    string `json:"instance_id"`
	EventKey      string `json:"event_key"`
	RequestID     string `json:"request_id"`
	TimestampMS   int64  `json:"timestamp_ms"`
	Provider      string `json:"provider"`
	Endpoint      string `json:"endpoint"`
	ExecutorType  string `json:"executor_type"`
	AuthType      string `json:"auth_type"`
	AuthIndex     string `json:"auth_index"`
	APIGroupKey   string `json:"api_group_key"`
	APIGroupLabel string `json:"api_group_label"`
	// APIKeyMask is the display-only mask of the client key. It is empty for
	// records ingested before the mask column existed: the request record keeps
	// only the fingerprint, which cannot be turned back into a readable mask.
	APIKeyMask          string           `json:"api_key_mask,omitempty"`
	Source              string           `json:"source"`
	Model               string           `json:"model"`
	ModelAlias          *string          `json:"model_alias,omitempty"`
	ReasoningEffort     string           `json:"reasoning_effort,omitempty"`
	ServiceTier         string           `json:"service_tier,omitempty"`
	ResponseServiceTier string           `json:"response_service_tier,omitempty"`
	Failed              bool             `json:"failed"`
	Generate            bool             `json:"generate"`
	LatencyMS           int64            `json:"latency_ms"`
	TTFTMS              *int64           `json:"ttft_ms,omitempty"`
	ClientIP            *string          `json:"client_ip,omitempty"`
	XForwardedFor       *string          `json:"x_forwarded_for,omitempty"`
	UserAgent           *string          `json:"user_agent,omitempty"`
	Tokens              usage.TokenStats `json:"tokens"`
	// ResourceID and ResourceName join the event back to the user-owned Oh My
	// CPA resource record, which is what turns a raw request into something a
	// user recognises. Both are null until the credential is triaged.
	ResourceID   *string `json:"resource_id,omitempty"`
	ResourceName *string `json:"resource_name,omitempty"`
	// HasRequestLog reports whether CPA's request log can be fetched for this
	// record. It depends only on having a request id.
	HasRequestLog bool `json:"has_request_log"`
	// CostUSD is the locked request estimate; nil means no price was known,
	// never a fabricated zero.
	CostUSD        *float64 `json:"cost_usd,omitempty"`
	PricingStatus  string   `json:"pricing_status"`
	PriceVersionID *int64   `json:"price_version_id,omitempty"`
}

// UsageEventPage is one keyset-paginated result set.
type UsageEventPage struct {
	Items      []UsageEventRow `json:"items"`
	NextCursor string          `json:"next_cursor,omitempty"`
	HasMore    bool            `json:"has_more"`
	// Limit is echoed so clients can detect server-side clamping.
	Limit int `json:"limit"`
	// ArrivedCount is how many matching records were ingested after `SinceID`, in
	// the same filtered window. Only populated when the caller asked for it.
	//
	// The live pill cannot be derived from the page's own rows. The list is sorted
	// by request time, so the records that arrived most recently are not the ones
	// at the top: a request that ran for an hour is ingested long after it began
	// and lands well below the first page. Diffing loaded rows would report
	// "nothing new" while records were in fact flowing in.
	ArrivedCount int64 `json:"arrived_count,omitempty"`
}

// countUsageEventsIngestedAfter reports how many matching records were recorded
// after the given row id. It reuses the list's own WHERE clause, so the count can
// never describe a different set of records than the list it accompanies.
func (r *Repository) countUsageEventsIngestedAfter(ctx context.Context, filter UsageEventFilter, sinceID int64) (int64, error) {
	where, args, err := usageEventWhere(filter)
	if err != nil {
		return 0, err
	}
	where = append(where, `e.id > ?`)
	args = append(args, sinceID)
	query := `SELECT COUNT(1) FROM usage_events e WHERE ` + strings.Join(where, " AND ")
	var count int64
	if err := r.SQL().QueryRowContext(ctx, query, args...).Scan(&count); err != nil {
		return 0, fmt.Errorf("count usage events ingested since id: %w", err)
	}
	return count, nil
}

// ListUsageEvents returns records with the newest request time first.
//
// The order is the request's own start time, which is the column the list shows.
// Sorting by anything else makes the visible time column non-monotonic: the
// reader sees 14:53:34, then 14:52:57, then 14:53:36, and concludes the sort is
// broken. That is what happened while this list was ordered by row id - a just
// finished long-running request carries a start time older than requests that
// began after it, so it landed above them and inverted the column the reader is
// reading. Against a real instance roughly a quarter of adjacent rows were out of
// order.
//
// `id` is the tiebreaker, and it is not optional. Several records can share a
// start time (a client fanning out, or a second-granularity source), and without
// a total order the keyset boundary would skip or repeat rows as the reader pages.
//
// Keyset pagination is used instead of OFFSET: records are append-only and high
// volume, so OFFSET would degrade linearly as the user pages deeper. Migration 018
// already provides the (instance_id, timestamp_ms DESC, id DESC) index that makes
// this a plain index scan.
func (r *Repository) ListUsageEvents(ctx context.Context, filter UsageEventFilter) (UsageEventPage, error) {
	page := UsageEventPage{Items: []UsageEventRow{}, Limit: normalizeEventLimit(filter.Limit)}
	if r == nil || r.SQL() == nil {
		return page, errors.New("repository is not initialized")
	}

	where, args, err := usageEventWhere(filter)
	if err != nil {
		return page, err
	}
	cursor, err := decodeEventCursor(filter.Cursor)
	if err != nil {
		return page, err
	}
	cursor, err = r.resolveEventCursor(ctx, filter.InstanceID, cursor)
	if err != nil {
		return page, err
	}
	if cursor != nil {
		// The columns must be qualified: the query joins discovered_resources,
		// which also has an id, and an unqualified name is ambiguous to SQLite.
		//
		// The row comparison is what makes the tiebreaker correct: comparing the
		// timestamp alone would skip every row sharing the boundary timestamp,
		// and comparing them as two independent predicates would repeat rows.
		where = append(where, `(e.timestamp_ms, e.id) < (?, ?)`)
		args = append(args, cursor.TimestampMS, cursor.ID)
	}

	query := `
		SELECT e.id, e.instance_id, e.event_key, e.request_id, e.timestamp_ms,
		       e.provider, e.endpoint, e.executor_type, e.auth_type, e.auth_index,
		       e.api_group_key, e.api_group_label, e.api_key_mask, e.source, e.model, e.model_alias, e.reasoning_effort,
		       e.service_tier, e.response_service_tier, e.failed, e.generate,
		       e.latency_ms, e.ttft_ms, e.client_ip, e.x_forwarded_for, e.user_agent,
		       e.input_tokens, e.output_tokens, e.reasoning_tokens, e.cached_tokens,
		       e.cache_read_tokens, e.cache_creation_tokens, e.total_tokens,
		       d.id, d.cpa_resource_name AS resource_name,
		       e.cost_nanos / 1000000000.0 AS cost_usd, e.pricing_status, e.price_version_id
		FROM usage_events e
		LEFT JOIN (
			SELECT instance_id, cpa_auth_index,
			       CASE WHEN COUNT(1) = 1 THEN MIN(d.id) ELSE NULL END AS id,
			       CASE WHEN COUNT(1) = 1 THEN MIN(d.cpa_resource_name) ELSE NULL END AS cpa_resource_name
			FROM discovered_resources d
			WHERE cpa_auth_index IS NOT NULL AND cpa_auth_index <> ''
			GROUP BY instance_id, cpa_auth_index
		) d ON d.instance_id = e.instance_id AND d.cpa_auth_index = e.auth_index`
	if len(where) > 0 {
		query += " WHERE " + strings.Join(where, " AND ")
	}
	query += " ORDER BY e.timestamp_ms DESC, e.id DESC LIMIT ?"
	args = append(args, page.Limit+1)

	rows, err := r.SQL().QueryContext(ctx, query, args...)
	if err != nil {
		return page, fmt.Errorf("list usage events: %w", err)
	}
	defer rows.Close()

	for rows.Next() {
		var row UsageEventRow
		var failed, generate int
		var resourceID, resourceName sql.NullString
		var costUSD sql.NullFloat64
		if errScan := rows.Scan(
			&row.ID, &row.InstanceID, &row.EventKey, &row.RequestID, &row.TimestampMS,
			&row.Provider, &row.Endpoint, &row.ExecutorType, &row.AuthType, &row.AuthIndex,
			&row.APIGroupKey, &row.APIGroupLabel, &row.APIKeyMask, &row.Source, &row.Model, &row.ModelAlias, &row.ReasoningEffort,
			&row.ServiceTier, &row.ResponseServiceTier, &failed, &generate,
			&row.LatencyMS, &row.TTFTMS, &row.ClientIP, &row.XForwardedFor, &row.UserAgent,
			&row.Tokens.InputTokens, &row.Tokens.OutputTokens, &row.Tokens.ReasoningTokens,
			&row.Tokens.CachedTokens, &row.Tokens.CacheReadTokens, &row.Tokens.CacheCreationTokens,
			&row.Tokens.TotalTokens, &resourceID, &resourceName, &costUSD, &row.PricingStatus, &row.PriceVersionID); errScan != nil {
			return page, fmt.Errorf("scan usage event: %w", errScan)
		}
		row.Failed = failed == 1
		row.Generate = generate == 1
		if resourceID.Valid {
			value := resourceID.String
			row.ResourceID = &value
		}
		if resourceName.Valid && strings.TrimSpace(resourceName.String) != "" {
			value := resourceName.String
			row.ResourceName = &value
		}
		if costUSD.Valid {
			row.CostUSD = &costUSD.Float64
		}
		row.HasRequestLog = strings.TrimSpace(row.RequestID) != ""
		page.Items = append(page.Items, row)
	}
	if err := rows.Err(); err != nil {
		return page, fmt.Errorf("iterate usage events: %w", err)
	}

	if len(page.Items) > page.Limit {
		page.Items = page.Items[:page.Limit]
		page.HasMore = true
		last := page.Items[len(page.Items)-1]
		page.NextCursor = encodeEventCursor(last.TimestampMS, last.ID)
	}
	if filter.SinceID > 0 {
		arrived, countErr := r.countUsageEventsIngestedAfter(ctx, filter, filter.SinceID)
		if countErr != nil {
			return page, countErr
		}
		page.ArrivedCount = arrived
	}
	return page, nil
}

// GetUsageEvent loads one record by primary key.
func (r *Repository) GetUsageEvent(ctx context.Context, id int64) (UsageEventRow, error) {
	var row UsageEventRow
	if r == nil || r.SQL() == nil {
		return row, errors.New("repository is not initialized")
	}
	if id <= 0 {
		return row, errors.New("usage event id must be positive")
	}
	var failed, generate int
	var resourceID, resourceName sql.NullString
	var costUSD sql.NullFloat64
	err := r.SQL().QueryRowContext(ctx, `
		SELECT e.id, e.instance_id, e.event_key, e.request_id, e.timestamp_ms,
		       e.provider, e.endpoint, e.executor_type, e.auth_type, e.auth_index,
		       e.api_group_key, e.api_group_label, e.api_key_mask, e.source, e.model, e.model_alias, e.reasoning_effort,
		       e.service_tier, e.response_service_tier, e.failed, e.generate,
		       e.latency_ms, e.ttft_ms, e.client_ip, e.x_forwarded_for, e.user_agent,
		       e.input_tokens, e.output_tokens, e.reasoning_tokens, e.cached_tokens,
		       e.cache_read_tokens, e.cache_creation_tokens, e.total_tokens,
		       d.id, d.cpa_resource_name AS resource_name,
		       e.cost_nanos / 1000000000.0 AS cost_usd, e.pricing_status, e.price_version_id
		FROM usage_events e
		LEFT JOIN (
			SELECT instance_id, cpa_auth_index,
			       CASE WHEN COUNT(1) = 1 THEN MIN(d.id) ELSE NULL END AS id,
			       CASE WHEN COUNT(1) = 1 THEN MIN(d.cpa_resource_name) ELSE NULL END AS cpa_resource_name
			FROM discovered_resources d
			WHERE cpa_auth_index IS NOT NULL AND cpa_auth_index <> ''
			GROUP BY instance_id, cpa_auth_index
		) d ON d.instance_id = e.instance_id AND d.cpa_auth_index = e.auth_index
		WHERE e.id = ?`, id).Scan(
		&row.ID, &row.InstanceID, &row.EventKey, &row.RequestID, &row.TimestampMS,
		&row.Provider, &row.Endpoint, &row.ExecutorType, &row.AuthType, &row.AuthIndex,
		&row.APIGroupKey, &row.APIGroupLabel, &row.APIKeyMask, &row.Source, &row.Model, &row.ModelAlias, &row.ReasoningEffort,
		&row.ServiceTier, &row.ResponseServiceTier, &failed, &generate,
		&row.LatencyMS, &row.TTFTMS, &row.ClientIP, &row.XForwardedFor, &row.UserAgent,
		&row.Tokens.InputTokens, &row.Tokens.OutputTokens, &row.Tokens.ReasoningTokens,
		&row.Tokens.CachedTokens, &row.Tokens.CacheReadTokens, &row.Tokens.CacheCreationTokens,
		&row.Tokens.TotalTokens, &resourceID, &resourceName, &costUSD, &row.PricingStatus, &row.PriceVersionID)
	if errors.Is(err, sql.ErrNoRows) {
		return row, ErrNotFound
	}
	if err != nil {
		return row, fmt.Errorf("read usage event: %w", err)
	}
	row.Failed = failed == 1
	row.Generate = generate == 1
	if resourceID.Valid {
		value := resourceID.String
		row.ResourceID = &value
	}
	if resourceName.Valid && strings.TrimSpace(resourceName.String) != "" {
		value := resourceName.String
		row.ResourceName = &value
	}
	if costUSD.Valid {
		row.CostUSD = &costUSD.Float64
	}
	row.HasRequestLog = strings.TrimSpace(row.RequestID) != ""
	return row, nil
}

// CorrelatedErrorEvents returns CPA error notifications for the same credential
// around an event's timestamp. CPA's error payload has no request id, so time
// plus credential is the only available link.
func (r *Repository) CorrelatedErrorEvents(ctx context.Context, authIndex string, timestampMS int64, windowMS int64) ([]ErrorEventRow, error) {
	items := []ErrorEventRow{}
	if r == nil || r.SQL() == nil {
		return items, errors.New("repository is not initialized")
	}
	if windowMS <= 0 {
		windowMS = 2 * 60 * 1000
	}
	rows, err := r.SQL().QueryContext(ctx, `
		SELECT id, instance_id, event_key, provider, model, auth_index, status_code, code,
		       body, retryable, auth_status, auth_disabled, auth_unavailable, quota_exceeded,
		       quota_reason, next_retry_after_ms, next_recover_at_ms, backoff_level, timestamp_ms
		FROM error_events
		WHERE auth_index = ? AND timestamp_ms BETWEEN ? AND ?
		ORDER BY timestamp_ms DESC
		LIMIT 20`, authIndex, timestampMS-windowMS, timestampMS+windowMS)
	if err != nil {
		return items, fmt.Errorf("read correlated errors: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var item ErrorEventRow
		var retryable, disabled, unavailable, exceeded int
		if errScan := rows.Scan(&item.ID, &item.InstanceID, &item.EventKey, &item.Provider,
			&item.Model, &item.AuthIndex, &item.StatusCode, &item.Code, &item.Body,
			&retryable, &item.AuthStatus, &disabled, &unavailable, &item.QuotaExceeded,
			&item.QuotaReason, &item.NextRetryAfterMS, &item.NextRecoverAtMS,
			&item.BackoffLevel, &item.TimestampMS); errScan != nil {
			return items, fmt.Errorf("scan correlated error: %w", errScan)
		}
		item.Retryable = retryable == 1
		item.AuthDisabled = disabled == 1
		item.AuthUnavailable = unavailable == 1
		item.QuotaExceeded = exceeded == 1
		items = append(items, item)
	}
	return items, rows.Err()
}

// ErrorEventRow is a stored CPA error notification.
type ErrorEventRow struct {
	ID               int64  `json:"id"`
	InstanceID       string `json:"instance_id"`
	EventKey         string `json:"event_key"`
	Provider         string `json:"provider"`
	Model            string `json:"model"`
	AuthIndex        string `json:"auth_index"`
	StatusCode       int    `json:"status_code"`
	Code             string `json:"code,omitempty"`
	Body             string `json:"body"`
	Retryable        bool   `json:"retryable"`
	AuthStatus       string `json:"auth_status,omitempty"`
	AuthDisabled     bool   `json:"auth_disabled"`
	AuthUnavailable  bool   `json:"auth_unavailable"`
	QuotaExceeded    bool   `json:"quota_exceeded"`
	QuotaReason      string `json:"quota_reason,omitempty"`
	NextRetryAfterMS *int64 `json:"next_retry_after_ms,omitempty"`
	NextRecoverAtMS  *int64 `json:"next_recover_at_ms,omitempty"`
	BackoffLevel     int    `json:"backoff_level"`
	TimestampMS      int64  `json:"timestamp_ms"`
}

// UsageFacets lists the distinct filter values actually present in a window, so
// the UI never offers a dropdown choice that returns nothing.
type UsageFacets struct {
	Models      []UsageFacetValue `json:"models"`
	Providers   []UsageFacetValue `json:"providers"`
	APIGroupKey []UsageFacetValue `json:"api_group_keys"`
	AuthIndexes []UsageFacetValue `json:"auth_indexes"`
	Sources     []UsageFacetValue `json:"sources"`
	Executors   []UsageFacetValue `json:"executors"`
	// AuthTypes, ReasoningEfforts and ServiceTiers are closed vocabularies CPA
	// reports, which is exactly what a dropdown is for. ModelAliases is the same
	// shape: a client-requested alias is a short label with few distinct values,
	// and it is a filter dimension, so it needs a dropdown rather than a text box
	// whose edits would have to guess at exact matching. Endpoint and UserAgent are
	// deliberately absent: both are long free-form values where a typed substring
	// beats a 200-row list, and the endpoint URL must never be handed to the
	// browser (the list projection drops it for the same reason).
	ModelAliases     []UsageFacetValue `json:"model_aliases"`
	AuthTypes        []UsageFacetValue `json:"auth_types"`
	ReasoningEfforts []UsageFacetValue `json:"reasoning_efforts"`
	ServiceTiers     []UsageFacetValue `json:"service_tiers"`
}

// UsageFacetValue is one distinct value plus how often it occurred. Mask carries
// the display label for a key-shaped facet (api_group_keys) so the dropdown can
// show a recognisable mask instead of the stored fingerprint.
type UsageFacetValue struct {
	Value    string `json:"value"`
	Requests int64  `json:"requests"`
	Mask     string `json:"mask,omitempty"`
}

// GetUsageFacets enumerates filter options within a time window.
func (r *Repository) GetUsageFacets(ctx context.Context, instanceID string, fromMS, toMS int64) (UsageFacets, error) {
	facets := UsageFacets{
		Models:           []UsageFacetValue{},
		Providers:        []UsageFacetValue{},
		APIGroupKey:      []UsageFacetValue{},
		AuthIndexes:      []UsageFacetValue{},
		Sources:          []UsageFacetValue{},
		Executors:        []UsageFacetValue{},
		ModelAliases:     []UsageFacetValue{},
		AuthTypes:        []UsageFacetValue{},
		ReasoningEfforts: []UsageFacetValue{},
		ServiceTiers:     []UsageFacetValue{},
	}
	if r == nil || r.SQL() == nil {
		return facets, errors.New("repository is not initialized")
	}
	// Each entry costs one grouped scan of the window. The set is kept to the
	// dimensions a dropdown genuinely serves, because the count of these queries -
	// not the size of any one of them - is what makes facets the expensive part of
	// opening the page. BenchmarkUsageFacets pins the budget.
	columns := []struct {
		column     string
		maskColumn string
		target     *[]UsageFacetValue
	}{
		{column: "model", target: &facets.Models},
		{column: "provider", target: &facets.Providers},
		// The api_group_keys facet is the caller-key list, so it carries the
		// display mask. The mask is deterministic per key, so any non-empty mask
		// in the group labels the whole group.
		{column: "api_group_key", maskColumn: "api_key_mask", target: &facets.APIGroupKey},
		{column: "auth_index", target: &facets.AuthIndexes},
		{column: "source", target: &facets.Sources},
		{column: "executor_type", target: &facets.Executors},
		{column: "model_alias", target: &facets.ModelAliases},
		{column: "auth_type", target: &facets.AuthTypes},
		{column: "reasoning_effort", target: &facets.ReasoningEfforts},
		{column: "service_tier", target: &facets.ServiceTiers},
	}
	for _, entry := range columns {
		if strings.TrimSpace(entry.column) == "" {
			continue
		}
		maskExpression := "''"
		if entry.maskColumn != "" {
			maskExpression = `COALESCE(MAX(NULLIF(` + entry.maskColumn + `, '')), '')`
		}
		rows, err := r.SQL().QueryContext(ctx, `
			SELECT `+entry.column+`, COUNT(1), `+maskExpression+`
			FROM usage_events
			WHERE instance_id = ? AND timestamp_ms BETWEEN ? AND ? AND `+entry.column+` <> ''
			GROUP BY `+entry.column+`
			ORDER BY COUNT(1) DESC, `+entry.column+` ASC
			LIMIT 200`, instanceID, fromMS, toMS)
		if err != nil {
			return facets, fmt.Errorf("read usage facets %s: %w", entry.column, err)
		}
		values := []UsageFacetValue{}
		for rows.Next() {
			var value UsageFacetValue
			if errScan := rows.Scan(&value.Value, &value.Requests, &value.Mask); errScan != nil {
				rows.Close()
				return facets, fmt.Errorf("scan usage facet %s: %w", entry.column, errScan)
			}
			// Facet masks are stored values too, so legacy rows are converted here
			// as well; the list and detail views do the same in the API projection.
			value.Mask = security.NormalizeMask(value.Mask)
			values = append(values, value)
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return facets, err
		}
		rows.Close()
		*entry.target = values
	}
	return facets, nil
}

// usageEventSearchColumns is what the console's single search box covers. It is
// deliberately the request's identity - who called, what they asked for and
// which upstream served it. Client IP, X-Forwarded-For, the endpoint URL and the
// raw caller key are all absent: the first three are private to the operator and
// the last is never retained in readable form.
var usageEventSearchColumns = []string{
	"e.request_id",
	"e.model",
	"e.model_alias",
	"e.provider",
	"e.executor_type",
	"e.source",
	"e.api_group_key",
	"e.api_key_mask",
	"e.auth_index",
	"e.user_agent",
}

// likeEscape is the explicit escape character for the substring filters. SQLite's
// LIKE has none by default, so a caller's literal `%` or `_` would otherwise act
// as a wildcard: searching for "50%" would match every row, and "gpt_5" would
// also match "gpt-5".
const likeEscape = `\`

// escapeLikePattern neutralises the escape character and both LIKE wildcards.
// The escape character is replaced first so the backslashes introduced for the
// wildcards are not themselves escaped a second time.
func escapeLikePattern(value string) string {
	return strings.NewReplacer(
		likeEscape, likeEscape+likeEscape,
		"%", likeEscape+"%",
		"_", likeEscape+"_",
	).Replace(value)
}

// usageEventInClause renders one OR dimension. Blank entries are dropped rather
// than matching the empty column, duplicates are collapsed so a repeated value
// cannot inflate the statement, and an over-long list is refused instead of
// truncated: dropping values would quietly widen the result set.
func usageEventInClause(column string, values []string) (string, []any, error) {
	cleaned := make([]string, 0, len(values))
	seen := make(map[string]struct{}, len(values))
	for _, value := range values {
		trimmed := strings.TrimSpace(value)
		if trimmed == "" {
			continue
		}
		if _, duplicate := seen[trimmed]; duplicate {
			continue
		}
		seen[trimmed] = struct{}{}
		cleaned = append(cleaned, trimmed)
	}
	switch {
	case len(cleaned) == 0:
		return "", nil, nil
	case len(cleaned) > MaxUsageEventFilterValues:
		return "", nil, fmt.Errorf("%w: %s carries %d values, at most %d are accepted",
			ErrUsageFilterInvalid, column, len(cleaned), MaxUsageEventFilterValues)
	}
	args := make([]any, 0, len(cleaned))
	for _, value := range cleaned {
		args = append(args, value)
	}
	if len(cleaned) == 1 {
		return column + " = ?", args, nil
	}
	placeholders := strings.TrimSuffix(strings.Repeat("?, ", len(cleaned)), ", ")
	return column + " IN (" + placeholders + ")", args, nil
}

// usageEventSubstringClause renders one literal contains-match.
func usageEventSubstringClause(column, value string) (string, []any) {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return "", nil
	}
	return column + ` LIKE ? ESCAPE '` + likeEscape + `'`, []any{"%" + escapeLikePattern(trimmed) + "%"}
}

func usageEventWhere(filter UsageEventFilter) ([]string, []any, error) {
	where := []string{}
	args := []any{}
	if strings.TrimSpace(filter.InstanceID) != "" {
		where = append(where, `e.instance_id = ?`)
		args = append(args, filter.InstanceID)
	}
	if filter.FromMS > 0 && filter.ToMS > 0 {
		if filter.ToMS <= filter.FromMS {
			return nil, nil, fmt.Errorf("%w: event window must be positive", ErrUsageFilterInvalid)
		}
		where = append(where, `e.timestamp_ms BETWEEN ? AND ?`)
		args = append(args, filter.FromMS, filter.ToMS)
	}

	dimensions := []struct {
		column string
		values []string
	}{
		{"e.model", filter.Models},
		{"e.model_alias", filter.ModelAliases},
		{"e.provider", filter.Providers},
		{"e.api_group_key", filter.APIGroupKeys},
		{"e.auth_index", filter.AuthIndexes},
		{"e.source", filter.Sources},
		{"e.auth_type", filter.AuthTypes},
		{"e.executor_type", filter.ExecutorTypes},
		{"e.reasoning_effort", filter.ReasoningEfforts},
		{"e.service_tier", filter.ServiceTiers},
	}
	for _, dimension := range dimensions {
		clause, clauseArgs, err := usageEventInClause(dimension.column, dimension.values)
		if err != nil {
			return nil, nil, err
		}
		if clause == "" {
			continue
		}
		where = append(where, clause)
		args = append(args, clauseArgs...)
	}

	if value := strings.TrimSpace(filter.RequestID); value != "" {
		where = append(where, `e.request_id = ?`)
		args = append(args, value)
	}
	for _, entry := range []struct {
		column string
		value  string
	}{
		{"e.endpoint", filter.Endpoint},
		{"e.user_agent", filter.UserAgent},
	} {
		clause, clauseArgs := usageEventSubstringClause(entry.column, entry.value)
		if clause == "" {
			continue
		}
		where = append(where, clause)
		args = append(args, clauseArgs...)
	}

	if search := strings.TrimSpace(filter.Search); search != "" {
		pattern := "%" + escapeLikePattern(search) + "%"
		terms := make([]string, 0, len(usageEventSearchColumns))
		for _, column := range usageEventSearchColumns {
			terms = append(terms, column+` LIKE ? ESCAPE '`+likeEscape+`'`)
			args = append(args, pattern)
		}
		// The disjunction must be parenthesised: loose ORs would bind more weakly
		// than the ANDs built above and silently drop every other filter.
		where = append(where, "("+strings.Join(terms, " OR ")+")")
	}

	bounds := []struct {
		column   string
		operator string
		value    *int64
	}{
		{"e.latency_ms", ">=", filter.MinLatencyMS},
		{"e.latency_ms", "<=", filter.MaxLatencyMS},
		{"e.total_tokens", ">=", filter.MinTokens},
		{"e.total_tokens", "<=", filter.MaxTokens},
		{"e.cost_nanos", ">=", filter.MinCostNanos},
		{"e.cost_nanos", "<=", filter.MaxCostNanos},
	}
	for _, bound := range bounds {
		if bound.value == nil {
			continue
		}
		if *bound.value < 0 {
			return nil, nil, fmt.Errorf("%w: %s cannot be negative", ErrUsageFilterInvalid, bound.column)
		}
		where = append(where, bound.column+" "+bound.operator+" ?")
		args = append(args, *bound.value)
	}

	switch strings.ToLower(strings.TrimSpace(filter.CostState)) {
	case CostStateAny:
	case CostStatePriced:
		where = append(where, `e.cost_nanos IS NOT NULL`)
	case CostStateUnpriced:
		where = append(where, `e.cost_nanos IS NULL`)
	default:
		return nil, nil, fmt.Errorf("%w: unknown cost state %q", ErrUsageFilterInvalid, filter.CostState)
	}

	switch strings.ToLower(strings.TrimSpace(filter.Result)) {
	case "", ResultAll:
	case ResultSuccess:
		where = append(where, `e.failed = 0`)
	case ResultFailed:
		where = append(where, `e.failed = 1`)
	default:
		return nil, nil, fmt.Errorf("%w: unknown result filter %q", ErrUsageFilterInvalid, filter.Result)
	}
	return where, args, nil
}

func normalizeEventLimit(limit int) int {
	switch {
	case limit <= 0:
		return DefaultUsageEventLimit
	case limit > MaxUsageEventLimit:
		return MaxUsageEventLimit
	default:
		return limit
	}
}

// ValidUsageCursor reports whether a client-supplied cursor is well formed, so
// handlers can answer 400 instead of surfacing a storage error as 500.
func ValidUsageCursor(cursor string) error {
	_, err := decodeEventCursor(cursor)
	return err
}

// eventCursor is one keyset position in the list's (timestamp, id) order.
//
// Legacy marks a position written before the list was ordered by request time.
// Those cursors carry only an id, which cannot be turned into a timestamp
// without reading the row, so they are resolved against the database before use.
// The distinction exists so an old cursor is converted rather than fed to a
// predicate that means something different under the new order.
type eventCursor struct {
	TimestampMS int64
	ID          int64
	Legacy      bool
}

// encodeEventCursor builds an opaque keyset position. It is intentionally not
// user-parsable: the client treats it as a token, which lets the ordering change
// without breaking callers.
func encodeEventCursor(timestampMS, id int64) string {
	return base64.RawURLEncoding.EncodeToString([]byte(strconv.FormatInt(timestampMS, 10) + ":" + strconv.FormatInt(id, 10)))
}

// decodeEventCursor parses a cursor into a position, or nil for "first page".
//
// Two encodings are accepted. The current form is "<timestamp>:<id>". A
// bare "<id>" is the pre-existing recording-order cursor; it is returned marked
// as legacy so the caller resolves its timestamp instead of applying it as-is.
func decodeEventCursor(cursor string) (*eventCursor, error) {
	trimmed := strings.TrimSpace(cursor)
	if trimmed == "" {
		return nil, nil
	}
	decoded, err := base64.RawURLEncoding.DecodeString(trimmed)
	if err != nil {
		return nil, errors.New("cursor is not valid")
	}
	text := string(decoded)

	timestampPart, idPart, hasPair := strings.Cut(text, ":")
	if !hasPair {
		id, err := strconv.ParseInt(text, 10, 64)
		if err != nil || id <= 0 {
			return nil, errors.New("cursor is malformed")
		}
		return &eventCursor{ID: id, Legacy: true}, nil
	}

	timestampMS, err := strconv.ParseInt(timestampPart, 10, 64)
	if err != nil || timestampMS < 0 {
		return nil, errors.New("cursor is malformed")
	}
	id, err := strconv.ParseInt(idPart, 10, 64)
	if err != nil || id <= 0 {
		return nil, errors.New("cursor is malformed")
	}
	return &eventCursor{TimestampMS: timestampMS, ID: id}, nil
}

// resolveEventCursor converts a legacy id-only cursor into its keyset position.
//
// A legacy cursor named a row, and that row's timestamp is what the new order
// needs. When the row is gone — aged out of the retention window, or belonging to
// another instance — the position cannot be reconstructed, and guessing would
// silently show the reader a page from somewhere else in the list. The caller is
// told to restart instead.
func (r *Repository) resolveEventCursor(ctx context.Context, instanceID string, cursor *eventCursor) (*eventCursor, error) {
	if cursor == nil || !cursor.Legacy {
		return cursor, nil
	}
	var timestampMS int64
	err := r.SQL().QueryRowContext(ctx,
		`SELECT timestamp_ms FROM usage_events WHERE instance_id = ? AND id = ?`,
		instanceID, cursor.ID).Scan(&timestampMS)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrUsageCursorStale
	}
	if err != nil {
		return nil, fmt.Errorf("resolve legacy usage cursor: %w", err)
	}
	return &eventCursor{TimestampMS: timestampMS, ID: cursor.ID}, nil
}

// UsageEventSpan returns the earliest and latest stored event times, which the
// UI uses to bound a custom range picker on an instance with sparse history.
func (r *Repository) UsageEventSpan(ctx context.Context, instanceID string) (firstMS, lastMS int64, err error) {
	if r == nil || r.SQL() == nil {
		return 0, 0, errors.New("repository is not initialized")
	}
	// Separate endpoint seeks use the instance/time index. COUNT and paired
	// MIN/MAX in one aggregate force a scan of the entire instance history.
	err = r.SQL().QueryRowContext(ctx, `
		SELECT COALESCE((SELECT timestamp_ms FROM usage_events WHERE instance_id = ? ORDER BY timestamp_ms ASC LIMIT 1), 0),
		       COALESCE((SELECT timestamp_ms FROM usage_events WHERE instance_id = ? ORDER BY timestamp_ms DESC LIMIT 1), 0)`,
		instanceID, instanceID).Scan(&firstMS, &lastMS)
	if err != nil {
		return 0, 0, fmt.Errorf("read usage event span: %w", err)
	}
	return firstMS, lastMS, nil
}

// NewUsageEventFilter is a small helper for handlers: a window ending now.
func NewUsageEventFilter(instanceID string, span time.Duration) UsageEventFilter {
	now := time.Now().UTC()
	return UsageEventFilter{
		InstanceID: instanceID,
		FromMS:     now.Add(-span).UnixMilli(),
		ToMS:       now.UnixMilli(),
		Result:     ResultAll,
	}
}
