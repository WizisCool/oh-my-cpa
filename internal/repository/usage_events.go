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

// UsageEventFilter narrows event reads.
//
// This is the shared vocabulary for the whole request-record feature set: the
// dashboard drill-down, ranking, cost analysis and export all take this struct,
// so a filter added once here becomes available everywhere at once.
type UsageEventFilter struct {
	InstanceID string
	FromMS     int64
	ToMS       int64
	// Model matches the upstream model name exactly.
	Model string
	// ModelAlias matches the client-requested alias when CPA reported one.
	ModelAlias string
	// APIGroupKey is the resolved API target (client key, provider or endpoint).
	APIGroupKey string
	// AuthIndex selects one credential on the CPA instance.
	AuthIndex string
	Provider  string
	// Source is CPA's client-facing API key label.
	Source       string
	AuthType     string
	ExecutorType string
	Result       string
	// RequestID looks up one request by its CPA id.
	RequestID string
	// Cursor is an opaque (timestamp, id) position for keyset pagination.
	Cursor string
	Limit  int
}

// UsageEventRow is one stored request record.
type UsageEventRow struct {
	ID                  int64            `json:"id"`
	InstanceID          string           `json:"instance_id"`
	EventKey            string           `json:"event_key"`
	RequestID           string           `json:"request_id"`
	TimestampMS         int64            `json:"timestamp_ms"`
	Provider            string           `json:"provider"`
	Endpoint            string           `json:"endpoint"`
	ExecutorType        string           `json:"executor_type"`
	AuthType            string           `json:"auth_type"`
	AuthIndex           string           `json:"auth_index"`
	APIGroupKey         string           `json:"api_group_key"`
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
}

// UsageEventPage is one keyset-paginated result set.
type UsageEventPage struct {
	Items      []UsageEventRow `json:"items"`
	NextCursor string          `json:"next_cursor,omitempty"`
	HasMore    bool            `json:"has_more"`
	// Limit is echoed so clients can detect server-side clamping.
	Limit int `json:"limit"`
}

// ListUsageEvents returns newest-first records matching the filter.
//
// Keyset pagination on (timestamp_ms, id) is used instead of OFFSET: request
// records are append-only and high volume, and OFFSET would degrade linearly as
// the user pages deeper.
func (r *Repository) ListUsageEvents(ctx context.Context, filter UsageEventFilter) (UsageEventPage, error) {
	page := UsageEventPage{Items: []UsageEventRow{}, Limit: normalizeEventLimit(filter.Limit)}
	if r == nil || r.SQL() == nil {
		return page, errors.New("repository is not initialized")
	}

	where, args, err := usageEventWhere(filter)
	if err != nil {
		return page, err
	}
	cursorTime, cursorID, err := decodeEventCursor(filter.Cursor)
	if err != nil {
		return page, err
	}
	if cursorID > 0 {
		// The columns must be qualified: the query joins discovered_resources,
		// which also has an id, and an unqualified name is ambiguous to SQLite.
		where = append(where, `(e.timestamp_ms < ? OR (e.timestamp_ms = ? AND e.id < ?))`)
		args = append(args, cursorTime, cursorTime, cursorID)
	}

	query := `
		SELECT e.id, e.instance_id, e.event_key, e.request_id, e.timestamp_ms,
		       e.provider, e.endpoint, e.executor_type, e.auth_type, e.auth_index,
		       e.api_group_key, e.source, e.model, e.model_alias, e.reasoning_effort,
		       e.service_tier, e.response_service_tier, e.failed, e.generate,
		       e.latency_ms, e.ttft_ms, e.client_ip, e.x_forwarded_for, e.user_agent,
		       e.input_tokens, e.output_tokens, e.reasoning_tokens, e.cached_tokens,
		       e.cache_read_tokens, e.cache_creation_tokens, e.total_tokens,
		       d.id, COALESCE(o.display_name, d.suggested_source)
		FROM usage_events e
		LEFT JOIN discovered_resources d
		       ON d.instance_id = e.instance_id AND d.cpa_auth_index = e.auth_index
		LEFT JOIN resource_overrides o ON o.resource_id = d.id`
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
		if errScan := rows.Scan(
			&row.ID, &row.InstanceID, &row.EventKey, &row.RequestID, &row.TimestampMS,
			&row.Provider, &row.Endpoint, &row.ExecutorType, &row.AuthType, &row.AuthIndex,
			&row.APIGroupKey, &row.Source, &row.Model, &row.ModelAlias, &row.ReasoningEffort,
			&row.ServiceTier, &row.ResponseServiceTier, &failed, &generate,
			&row.LatencyMS, &row.TTFTMS, &row.ClientIP, &row.XForwardedFor, &row.UserAgent,
			&row.Tokens.InputTokens, &row.Tokens.OutputTokens, &row.Tokens.ReasoningTokens,
			&row.Tokens.CachedTokens, &row.Tokens.CacheReadTokens, &row.Tokens.CacheCreationTokens,
			&row.Tokens.TotalTokens, &resourceID, &resourceName); errScan != nil {
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
	err := r.SQL().QueryRowContext(ctx, `
		SELECT e.id, e.instance_id, e.event_key, e.request_id, e.timestamp_ms,
		       e.provider, e.endpoint, e.executor_type, e.auth_type, e.auth_index,
		       e.api_group_key, e.source, e.model, e.model_alias, e.reasoning_effort,
		       e.service_tier, e.response_service_tier, e.failed, e.generate,
		       e.latency_ms, e.ttft_ms, e.client_ip, e.x_forwarded_for, e.user_agent,
		       e.input_tokens, e.output_tokens, e.reasoning_tokens, e.cached_tokens,
		       e.cache_read_tokens, e.cache_creation_tokens, e.total_tokens,
		       d.id, COALESCE(o.display_name, d.suggested_source)
		FROM usage_events e
		LEFT JOIN discovered_resources d
		       ON d.instance_id = e.instance_id AND d.cpa_auth_index = e.auth_index
		LEFT JOIN resource_overrides o ON o.resource_id = d.id
		WHERE e.id = ?`, id).Scan(
		&row.ID, &row.InstanceID, &row.EventKey, &row.RequestID, &row.TimestampMS,
		&row.Provider, &row.Endpoint, &row.ExecutorType, &row.AuthType, &row.AuthIndex,
		&row.APIGroupKey, &row.Source, &row.Model, &row.ModelAlias, &row.ReasoningEffort,
		&row.ServiceTier, &row.ResponseServiceTier, &failed, &generate,
		&row.LatencyMS, &row.TTFTMS, &row.ClientIP, &row.XForwardedFor, &row.UserAgent,
		&row.Tokens.InputTokens, &row.Tokens.OutputTokens, &row.Tokens.ReasoningTokens,
		&row.Tokens.CachedTokens, &row.Tokens.CacheReadTokens, &row.Tokens.CacheCreationTokens,
		&row.Tokens.TotalTokens, &resourceID, &resourceName)
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
}

// UsageFacetValue is one distinct value plus how often it occurred.
type UsageFacetValue struct {
	Value    string `json:"value"`
	Requests int64  `json:"requests"`
}

// GetUsageFacets enumerates filter options within a time window.
func (r *Repository) GetUsageFacets(ctx context.Context, instanceID string, fromMS, toMS int64) (UsageFacets, error) {
	facets := UsageFacets{
		Models:      []UsageFacetValue{},
		Providers:   []UsageFacetValue{},
		APIGroupKey: []UsageFacetValue{},
		AuthIndexes: []UsageFacetValue{},
		Sources:     []UsageFacetValue{},
		Executors:   []UsageFacetValue{},
	}
	if r == nil || r.SQL() == nil {
		return facets, errors.New("repository is not initialized")
	}
	columns := []struct {
		column string
		target *[]UsageFacetValue
	}{
		{"model", &facets.Models},
		{"provider", &facets.Providers},
		{"api_group_key", &facets.APIGroupKey},
		{"auth_index", &facets.AuthIndexes},
		{"source", &facets.Sources},
		{"executor_type", &facets.Executors},
	}
	for _, entry := range columns {
		if strings.TrimSpace(entry.column) == "" {
			continue
		}
		rows, err := r.SQL().QueryContext(ctx, `
			SELECT `+entry.column+`, COUNT(1)
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
			if errScan := rows.Scan(&value.Value, &value.Requests); errScan != nil {
				rows.Close()
				return facets, fmt.Errorf("scan usage facet %s: %w", entry.column, errScan)
			}
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

func usageEventWhere(filter UsageEventFilter) ([]string, []any, error) {
	where := []string{}
	args := []any{}
	if strings.TrimSpace(filter.InstanceID) != "" {
		where = append(where, `e.instance_id = ?`)
		args = append(args, filter.InstanceID)
	}
	if filter.FromMS > 0 && filter.ToMS > 0 {
		if filter.ToMS <= filter.FromMS {
			return nil, nil, errors.New("event window must be positive")
		}
		where = append(where, `e.timestamp_ms BETWEEN ? AND ?`)
		args = append(args, filter.FromMS, filter.ToMS)
	}
	exact := []struct {
		column string
		value  string
	}{
		{"e.model", filter.Model},
		{"e.provider", filter.Provider},
		{"e.api_group_key", filter.APIGroupKey},
		{"e.auth_index", filter.AuthIndex},
		{"e.source", filter.Source},
		{"e.auth_type", filter.AuthType},
		{"e.executor_type", filter.ExecutorType},
		{"e.request_id", filter.RequestID},
	}
	for _, entry := range exact {
		value := strings.TrimSpace(entry.value)
		if value == "" {
			continue
		}
		where = append(where, entry.column+` = ?`)
		args = append(args, value)
	}
	if alias := strings.TrimSpace(filter.ModelAlias); alias != "" {
		where = append(where, `e.model_alias = ?`)
		args = append(args, alias)
	}
	switch strings.ToLower(strings.TrimSpace(filter.Result)) {
	case "", ResultAll:
	case ResultSuccess:
		where = append(where, `e.failed = 0`)
	case ResultFailed:
		where = append(where, `e.failed = 1`)
	default:
		return nil, nil, fmt.Errorf("unknown result filter %q", filter.Result)
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
	_, _, err := decodeEventCursor(cursor)
	return err
}

// encodeEventCursor builds an opaque keyset position. It is intentionally not
// user-parsable: the client treats it as a token, which lets the ordering change
// later without breaking callers.
func encodeEventCursor(timestampMS, id int64) string {
	raw := strconv.FormatInt(timestampMS, 10) + ":" + strconv.FormatInt(id, 10)
	return base64.RawURLEncoding.EncodeToString([]byte(raw))
}

func decodeEventCursor(cursor string) (int64, int64, error) {
	trimmed := strings.TrimSpace(cursor)
	if trimmed == "" {
		return 0, 0, nil
	}
	decoded, err := base64.RawURLEncoding.DecodeString(trimmed)
	if err != nil {
		return 0, 0, errors.New("cursor is not valid")
	}
	parts := strings.SplitN(string(decoded), ":", 2)
	if len(parts) != 2 {
		return 0, 0, errors.New("cursor is malformed")
	}
	timestampMS, errTime := strconv.ParseInt(parts[0], 10, 64)
	id, errID := strconv.ParseInt(parts[1], 10, 64)
	if errTime != nil || errID != nil || timestampMS <= 0 || id <= 0 {
		return 0, 0, errors.New("cursor is malformed")
	}
	return timestampMS, id, nil
}

// UsageEventSpan returns the earliest and latest stored event times, which the
// UI uses to bound a custom range picker on an instance with sparse history.
func (r *Repository) UsageEventSpan(ctx context.Context, instanceID string) (firstMS, lastMS int64, err error) {
	if r == nil || r.SQL() == nil {
		return 0, 0, errors.New("repository is not initialized")
	}
	var count int64
	err = r.SQL().QueryRowContext(ctx, `
		SELECT COUNT(1), COALESCE(MIN(timestamp_ms), 0), COALESCE(MAX(timestamp_ms), 0)
		FROM usage_events WHERE instance_id = ?`, instanceID).Scan(&count, &firstMS, &lastMS)
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
