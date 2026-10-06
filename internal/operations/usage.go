package operations

import (
	"context"
	"errors"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/capability"
	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
)

type UsageInput struct {
	FromMS      int64    `json:"from_ms,omitempty" jsonschema:"Inclusive epoch milliseconds; defaults to 24 hours before to_ms"`
	ToMS        int64    `json:"to_ms,omitempty" jsonschema:"Exclusive epoch milliseconds; defaults to current time"`
	Providers   []string `json:"providers,omitempty"`
	Models      []string `json:"models,omitempty"`
	CallPoints  []string `json:"call_points,omitempty"`
	ClientKeys  []string `json:"client_keys,omitempty"`
	Credentials []string `json:"credentials,omitempty"`
	Status      string   `json:"status,omitempty" jsonschema:"success or failed; omit for both"`
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
	return repository.UsageEventFilter{InstanceID: "default", FromMS: input.FromMS, ToMS: input.ToMS - 1, Providers: input.Providers, Models: input.Models, ModelAliases: input.CallPoints, APIGroupKeys: input.ClientKeys, AuthIndexes: input.Credentials, Result: input.Status, Cursor: input.Cursor, Limit: limit}, nil
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
	CostUSD     *float64 `json:"cost_usd,omitempty"`
}

func projectRequest(row repository.UsageEventRow) RequestItem {
	callPoint := row.Model
	if row.ModelAlias != nil && *row.ModelAlias != "" {
		callPoint = *row.ModelAlias
	}
	return RequestItem{row.ID, row.TimestampMS, safeLabel(row.Provider), safeLabel(row.Model), safeLabel(callPoint), row.Failed, row.Tokens.TotalTokens, row.LatencyMS, row.CostUSD}
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
	if err := read(registry, "requests_list", "Page through individual request records matching the filters. For counts, totals or trends use usage_aggregate instead.", func(ctx context.Context, input UsageInput) (RequestPage, error) {
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
