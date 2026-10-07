package operations

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/capability"
	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
)

type UsageInput struct {
	FromMS      int64    `json:"from_ms,omitempty" jsonschema:"Inclusive epoch milliseconds; defaults to 24 hours before to_ms"`
	ToMS        int64    `json:"to_ms,omitempty" jsonschema:"Exclusive epoch milliseconds; defaults to current time"`
	Providers   []string `json:"providers,omitempty" jsonschema:"Exact provider keys"`
	Models      []string `json:"models,omitempty" jsonschema:"Exact model names; for a pattern use regex"`
	CallPoints  []string `json:"call_points,omitempty"`
	ClientKeys  []string `json:"client_keys,omitempty"`
	Credentials []string `json:"credentials,omitempty"`
	Status      string   `json:"status,omitempty" jsonschema:"success or failed; omit for both"`
	Search      string   `json:"search,omitempty" jsonschema:"Literal substring of request id, provider, model, endpoint or user agent"`
	RegexField  string   `json:"regex_field,omitempty" jsonschema:"model, model_alias, response_model, provider, endpoint, ua or request_id"`
	Regex       string   `json:"regex,omitempty" jsonschema:"RE2 pattern matched against regex_field, e.g. ^claude-.*-(opus|sonnet)"`
	MinLatency  int64    `json:"min_latency_ms,omitempty" jsonschema:"Slow requests only"`
	GroupBy     string   `json:"group_by,omitempty" jsonschema:"provider, model, call_point, client_key, credential, status, all"`
	IsTrend     bool     `json:"is_trend,omitempty"`
	Limit       int      `json:"limit,omitempty"`
	Cursor      string   `json:"cursor,omitempty"`
}
type Analysis struct {
	FromMS   int64                       `json:"from_ms"`
	ToMS     int64                       `json:"to_ms"`
	Timezone string                      `json:"timezone"`
	Source   string                      `json:"source"`
	Data     repository.UsageAggregation `json:"data"`
}

func (input UsageInput) filter(ctx context.Context) (repository.UsageEventFilter, error) {
	if input.ToMS == 0 {
		input.ToMS = capability.AnchorMS(ctx)
	}
	if input.FromMS == 0 {
		input.FromMS = input.ToMS - int64(24*time.Hour/time.Millisecond)
	}
	if input.FromMS < 1 || input.ToMS <= input.FromMS || input.ToMS-input.FromMS > int64(365*24*time.Hour/time.Millisecond) || input.ToMS > time.Now().Add(time.Minute).UnixMilli() {
		return repository.UsageEventFilter{}, errors.New("invalid_window")
	}
	if input.Status != "" && input.Status != "success" && input.Status != "failed" {
		return repository.UsageEventFilter{}, errors.New("invalid_parameters")
	}
	// A pattern the repository would refuse is refused here by name, so the model
	// reads why its call failed instead of a generic storage error.
	if err := repository.ValidateUsageRegex(input.RegexField, input.Regex); err != nil {
		return repository.UsageEventFilter{}, errors.New("invalid_regex: " + strings.TrimPrefix(err.Error(), repository.ErrUsageFilterInvalid.Error()+": "))
	}
	if input.MinLatency < 0 || len(input.Search) > 256 {
		return repository.UsageEventFilter{}, errors.New("invalid_parameters")
	}
	for _, values := range [][]string{input.Providers, input.Models, input.CallPoints, input.ClientKeys, input.Credentials} {
		if len(values) > 20 {
			return repository.UsageEventFilter{}, errors.New("invalid_parameters")
		}
	}
	limit := input.Limit
	if limit <= 0 {
		limit = 20
	}
	if limit > 100 {
		limit = 100
	}
	filter := repository.UsageEventFilter{InstanceID: "default", FromMS: input.FromMS, ToMS: input.ToMS - 1, Providers: input.Providers, Models: input.Models, ModelAliases: input.CallPoints, APIGroupKeys: input.ClientKeys, AuthIndexes: input.Credentials, Result: input.Status, Cursor: input.Cursor, Limit: limit}
	filter.Search, filter.RegexField, filter.RegexPattern = input.Search, input.RegexField, input.Regex
	if input.MinLatency > 0 {
		filter.MinLatencyMS = &input.MinLatency
	}
	return filter, nil
}
func (s *Service) AnalyzeUsage(ctx context.Context, input UsageInput) (Analysis, error) {
	filter, err := input.filter(ctx)
	if err != nil {
		return Analysis{}, err
	}
	group := input.GroupBy
	if group == "" {
		group = "provider"
	}
	var bucket int64
	if input.IsTrend {
		bucket = (filter.ToMS + 1 - filter.FromMS + 118) / 119
		if bucket < 60000 {
			bucket = 60000
		}
	}
	ctx, cancel := queryContext(ctx)
	defer cancel()
	data, err := s.Repo.AggregateUsage(ctx, filter, group, bucket)
	return Analysis{filter.FromMS, filter.ToMS + 1, "UTC", "retained_usage_events", data}, err
}

type Comparison struct {
	Current  Analysis `json:"current"`
	Previous Analysis `json:"previous"`
}
type RequestItem struct {
	ID          int64    `json:"id"`
	TimestampMS int64    `json:"timestamp_ms"`
	Provider    string   `json:"provider"`
	Model       string   `json:"model"`
	CallPoint   string   `json:"call_point"`
	IsFailed    bool     `json:"is_failed"`
	Tokens      int64    `json:"tokens"`
	LatencyMS   int64    `json:"latency_ms"`
	TTFTMS      *int64   `json:"ttft_ms,omitempty"`
	CostUSD     *float64 `json:"cost_usd,omitempty"`
	// RequestID is CPA's id for the request, which is what an operator searches by.
	RequestID string `json:"request_id,omitempty"`
	// ServedModel is set only when the upstream served a different model than was requested.
	ServedModel string `json:"served_model,omitempty"`
	// UserAgent is the client product label, already redacted and shortened at ingestion.
	UserAgent string `json:"user_agent,omitempty"`
}

func projectRequest(row repository.UsageEventRow) RequestItem {
	callPoint := row.Model
	if row.ModelAlias != nil && *row.ModelAlias != "" {
		callPoint = *row.ModelAlias
	}
	item := RequestItem{
		ID: row.ID, TimestampMS: row.TimestampMS, Provider: safeLabel(row.Provider), Model: safeLabel(row.Model),
		CallPoint: safeLabel(callPoint), IsFailed: row.Failed, Tokens: row.Tokens.TotalTokens,
		LatencyMS: row.LatencyMS, TTFTMS: row.TTFTMS, CostUSD: row.CostUSD, RequestID: safeLabel(row.RequestID),
	}
	if row.ModelSubstituted {
		item.ServedModel = safeLabel(row.ResponseModel)
	}
	if row.UserAgent != nil {
		item.UserAgent = safeLabel(*row.UserAgent)
	}
	return item
}

type RequestPage struct {
	Items      []RequestItem `json:"items"`
	NextCursor string        `json:"next_cursor,omitempty"`
	HasMore    bool          `json:"has_more"`
}

func (s *Service) registerUsage(registry *capability.Registry) error {
	if err := read(registry, "usage_aggregate", "The first stop for usage questions: requests, tokens, cost and failures over a window (default last 24 hours), grouped by group_by; is_trend groups by time bucket instead (data.groups is then a time series). Covers retained request records only.", s.AnalyzeUsage); err != nil {
		return err
	}
	if err := read(registry, "usage_compare", "Compare the requested window with the immediately preceding equal-length window.", func(ctx context.Context, input UsageInput) (Comparison, error) {
		current, err := s.AnalyzeUsage(ctx, input)
		if err != nil {
			return Comparison{}, err
		}
		input.ToMS = current.FromMS
		input.FromMS = current.FromMS - (current.ToMS - current.FromMS)
		previous, err := s.AnalyzeUsage(ctx, input)
		return Comparison{current, previous}, err
	}); err != nil {
		return err
	}
	if err := read(registry, "requests_list", "Page through individual request records matching the filters, newest first. For counts, totals or trends use usage_aggregate with the same filters.", func(ctx context.Context, input UsageInput) (RequestPage, error) {
		filter, err := input.filter(ctx)
		if err != nil {
			return RequestPage{}, err
		}
		ctx, cancel := queryContext(ctx)
		defer cancel()
		page, err := s.Repo.ListUsageEvents(ctx, filter)
		output := RequestPage{Items: []RequestItem{}, NextCursor: page.NextCursor, HasMore: page.HasMore}
		for _, row := range page.Items {
			output.Items = append(output.Items, projectRequest(row))
		}
		return output, err
	}); err != nil {
		return err
	}
	if err := read(registry, "requests_get", "Read one request's safe accounting metadata; excludes raw logs and network identity.", func(ctx context.Context, input struct {
		ID int64 `json:"id"`
	}) (RequestItem, error) {
		row, err := s.Repo.GetUsageEvent(ctx, input.ID)
		return projectRequest(row), err
	}); err != nil {
		return err
	}
	return read(registry, "requests_cost_breakdown", "Explain one recorded request's cost: its pricing status, the stored amount in USD nanos, the price and channel versions it locked, the tier that governed it and each token bucket's rate. Use it to answer why a request cost what it did or why it is unpriced.", func(ctx context.Context, input struct {
		ID int64 `json:"id"`
	}) (repository.RequestCostBreakdown, error) {
		ctx, cancel := queryContext(ctx)
		defer cancel()
		breakdown, err := s.Repo.GetUsageEventCostBreakdown(ctx, input.ID)
		if errors.Is(err, repository.ErrNotFound) {
			return breakdown, errors.New("resource_missing")
		}
		return breakdown, err
	})
}
