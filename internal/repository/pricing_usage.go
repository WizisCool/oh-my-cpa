package repository

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"slices"
	"sort"
	"strings"

	"github.com/oh-my-cpa/oh-my-cpa/internal/pricing"
)

// PricingUsage is one model's or channel's recorded traffic over a window, the
// context the price book shows beside a rate.
type PricingUsage struct {
	Requests       int64 `json:"requests"`
	PricedRequests int64 `json:"priced_requests"`
	CostNanos      int64 `json:"cost_nanos"`
}

// QueryPricingUsageByModel groups recorded requests since fromMS by upstream
// model. It spans every instance: prices are deployment-wide, not per instance.
func (r *Repository) QueryPricingUsageByModel(ctx context.Context, fromMS int64) (map[string]PricingUsage, error) {
	return r.queryPricingUsage(ctx, "model", fromMS)
}

// QueryPricingUsageByChannel groups recorded requests since fromMS by the CPA
// provider label a channel multiplier keys on.
func (r *Repository) QueryPricingUsageByChannel(ctx context.Context, fromMS int64) (map[string]PricingUsage, error) {
	return r.queryPricingUsage(ctx, "provider", fromMS)
}

// queryPricingUsage reads deployment-wide request, costed-request, and cost
// totals since fromMS by composing permanent facts up to the fold checkpoint
// with unfolded records past it in one snapshot. That keeps 30-day price-book
// summaries exact even after rolling detail retention removes aged usage_events
// and avoids scanning months of raw rows on every pricing page load.
func (r *Repository) queryPricingUsage(ctx context.Context, column string, fromMS int64) (map[string]PricingUsage, error) {
	if r == nil || r.SQL() == nil {
		return nil, errors.New("repository is not initialized")
	}
	if column != "model" && column != "provider" {
		return nil, fmt.Errorf("unsupported pricing usage column %q", column)
	}
	horizonMS, err := r.LifecycleHorizonMS(ctx, LifecycleUsageDetail)
	if err != nil {
		return nil, err
	}
	if fromMS < horizonMS {
		fromMS = alignDown(fromMS, QuarterHourBucketMS)
	}
	fineFrom := alignUp(fromMS, QuarterHourBucketMS)
	dailyFrom := alignUp(fromMS, DayBucketMS)
	const checkpoint = `(SELECT COALESCE((SELECT last_usage_event_id FROM usage_aggregation_checkpoints WHERE name = '` + CheckpointFacts + `'), 0))`

	var parts []string
	var args []any

	// Whole UTC days from daily facts.
	parts = append(parts, `
		SELECT `+column+` AS k, SUM(requests) AS requests, SUM(costed_requests) AS costed_requests, SUM(cost_nanos) AS cost_nanos
		FROM `+usageFactsDailyTable+`
		WHERE bucket_start_ms >= ? AND `+column+` <> ''
		GROUP BY `+column)
	args = append(args, dailyFrom)

	// Quarter-hour facts between fineFrom and dailyFrom.
	if fineFrom < dailyFrom {
		parts = append(parts, `
			SELECT `+column+` AS k, SUM(requests) AS requests, SUM(costed_requests) AS costed_requests, SUM(cost_nanos) AS cost_nanos
			FROM `+usageFactsFineTable+`
			WHERE bucket_start_ms >= ? AND bucket_start_ms < ? AND `+column+` <> ''
			GROUP BY `+column)
		args = append(args, fineFrom, dailyFrom)
	}

	// Folded sub-quarter-hour left edge (at most <15 minutes of records).
	if fromMS < fineFrom {
		parts = append(parts, `
			SELECT `+column+` AS k, COUNT(1) AS requests, COALESCE(SUM(cost_nanos IS NOT NULL), 0) AS costed_requests, COALESCE(SUM(cost_nanos), 0) AS cost_nanos
			FROM usage_events
			WHERE timestamp_ms >= ? AND timestamp_ms < ? AND id <= `+checkpoint+` AND `+column+` <> ''
			GROUP BY `+column)
		args = append(args, fromMS, fineFrom)
	}

	// Unfolded tail past the checkpoint.
	parts = append(parts, `
		SELECT `+column+` AS k, COUNT(1) AS requests, COALESCE(SUM(cost_nanos IS NOT NULL), 0) AS costed_requests, COALESCE(SUM(cost_nanos), 0) AS cost_nanos
		FROM usage_events
		WHERE id > `+checkpoint+` AND timestamp_ms >= ? AND `+column+` <> ''
		GROUP BY `+column)
	args = append(args, fromMS)

	query := `
		SELECT k, COALESCE(SUM(requests), 0), COALESCE(SUM(costed_requests), 0), COALESCE(SUM(cost_nanos), 0)
		FROM (` + strings.Join(parts, ` UNION ALL `) + `)
		GROUP BY k`

	rows, err := r.SQL().QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("query pricing usage: %w", err)
	}
	defer rows.Close()
	result := make(map[string]PricingUsage)
	for rows.Next() {
		var key string
		var usage PricingUsage
		if err := rows.Scan(&key, &usage.Requests, &usage.PricedRequests, &usage.CostNanos); err != nil {
			return nil, fmt.Errorf("scan pricing usage: %w", err)
		}
		result[key] = usage
	}
	return result, rows.Err()
}

// TokenProfile is the median request of a model's recent traffic: what a
// typical request looks like, so the editor can preview a rate change in real
// money instead of against invented token counts.
type TokenProfile struct {
	Samples    int64 `json:"samples"`
	Input      int64 `json:"input"`
	Output     int64 `json:"output"`
	CacheRead  int64 `json:"cache_read"`
	CacheWrite int64 `json:"cache_write"`
	// MaxInput is the largest prompt sampled, which tells the editor whether a
	// long-context tier is ever reached.
	MaxInput int64 `json:"max_input"`
}

// tokenProfileSampleLimit bounds the profile read to the newest requests, which
// the (model, timestamp) index serves without scanning the model's history.
const tokenProfileSampleLimit = 1000

// QueryModelTokenProfile returns the per-bucket median of the model's newest
// successful requests since fromMS.
func (r *Repository) QueryModelTokenProfile(ctx context.Context, model string, fromMS int64) (TokenProfile, error) {
	rows, err := r.SQL().QueryContext(ctx, `SELECT input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens
 FROM usage_events WHERE model = ? AND timestamp_ms >= ? AND failed = 0
 ORDER BY timestamp_ms DESC LIMIT ?`, model, fromMS, tokenProfileSampleLimit)
	if err != nil {
		return TokenProfile{}, fmt.Errorf("query token profile: %w", err)
	}
	defer rows.Close()
	var inputs, outputs, reads, writes []int64
	var profile TokenProfile
	for rows.Next() {
		var input, output, read, write int64
		if err := rows.Scan(&input, &output, &read, &write); err != nil {
			return TokenProfile{}, fmt.Errorf("scan token profile: %w", err)
		}
		inputs, outputs, reads, writes = append(inputs, input), append(outputs, output), append(reads, read), append(writes, write)
		profile.MaxInput = max(profile.MaxInput, input)
	}
	if err := rows.Err(); err != nil {
		return TokenProfile{}, err
	}
	profile.Samples = int64(len(inputs))
	profile.Input, profile.Output, profile.CacheRead, profile.CacheWrite = median(inputs), median(outputs), median(reads), median(writes)
	return profile, nil
}

func median(values []int64) int64 {
	if len(values) == 0 {
		return 0
	}
	sort.Slice(values, func(i, j int) bool { return values[i] < values[j] })
	return values[len(values)/2]
}

// HasObservedModel reports whether model has been recorded in real execution
// traffic (retained events or daily usage facts). The placeholder "unknown" is
// never admitted as a priceable model.
func (r *Repository) HasObservedModel(ctx context.Context, model string) (bool, error) {
	if r == nil || r.SQL() == nil {
		return false, errors.New("repository is not initialized")
	}
	model = strings.TrimSpace(model)
	if model == "" || model == "unknown" {
		return false, nil
	}
	var marker int
	err := r.SQL().QueryRowContext(ctx, `SELECT 1 FROM usage_events WHERE model = ? LIMIT 1`, model).Scan(&marker)
	if err == nil {
		return true, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return false, fmt.Errorf("check observed model: %w", err)
	}
	err = r.SQL().QueryRowContext(ctx, `SELECT 1 FROM `+usageFactsDailyTable+` WHERE model = ? LIMIT 1`, model).Scan(&marker)
	if err == nil {
		return true, nil
	}
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	return false, fmt.Errorf("check observed model facts: %w", err)
}

// HasObservedChannelModel reports whether (channel, model) has been recorded in
// real execution traffic, enabling channel-specific custom pricing for runtime
// model variants that CPA's static discovery does not enumerate.
func (r *Repository) HasObservedChannelModel(ctx context.Context, channel, model string) (bool, error) {
	if r == nil || r.SQL() == nil {
		return false, errors.New("repository is not initialized")
	}
	channel, model = strings.TrimSpace(channel), strings.TrimSpace(model)
	if channel == "" || model == "" || model == "unknown" {
		return false, nil
	}
	var marker int
	err := r.SQL().QueryRowContext(ctx, `SELECT 1 FROM usage_events WHERE model = ? AND provider = ? LIMIT 1`, model, channel).Scan(&marker)
	if err == nil {
		return true, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return false, fmt.Errorf("check observed channel model: %w", err)
	}
	err = r.SQL().QueryRowContext(ctx, `SELECT 1 FROM `+usageFactsDailyTable+` WHERE model = ? AND provider = ? LIMIT 1`, model, channel).Scan(&marker)
	if err == nil {
		return true, nil
	}
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	return false, fmt.Errorf("check observed channel model facts: %w", err)
}

// observedActivityWindow aligns fromMS to the quarter-hour fact boundary when
// it reaches past the retained detail horizon, returning (fromMS, fineFrom, dailyFrom).
func observedActivityWindow(ctx context.Context, q sqlQuerier, fromMS int64) (int64, int64, int64, error) {
	horizonMS, err := lifecycleHorizonMS(ctx, q, LifecycleUsageDetail)
	if err != nil {
		return 0, 0, 0, err
	}
	if fromMS < horizonMS {
		fromMS = alignDown(fromMS, QuarterHourBucketMS)
	}
	return fromMS, alignUp(fromMS, QuarterHourBucketMS), alignUp(fromMS, DayBucketMS), nil
}

// ListObservedPricingModels summarizes models observed in recent execution
// traffic (since fromMS), their serving channels, and whether they have any
// retained unpriced complete-accounting requests in that window.
func (r *Repository) ListObservedPricingModels(ctx context.Context, fromMS int64) (map[string]pricing.ObservedModel, error) {
	if r == nil || r.SQL() == nil {
		return nil, errors.New("repository is not initialized")
	}
	fromMS, fineFrom, dailyFrom, err := observedActivityWindow(ctx, r.SQL(), fromMS)
	if err != nil {
		return nil, err
	}
	const checkpoint = `(SELECT COALESCE((SELECT last_usage_event_id FROM usage_aggregation_checkpoints WHERE name = '` + CheckpointFacts + `'), 0))`

	var parts []string
	var args []any

	parts = append(parts, `
		SELECT model, provider, SUM(requests) AS requests, SUM(costed_requests) AS costed_requests
		FROM `+usageFactsDailyTable+`
		WHERE bucket_start_ms >= ? AND model <> '' AND model <> 'unknown'
		GROUP BY model, provider`)
	args = append(args, dailyFrom)

	if fineFrom < dailyFrom {
		parts = append(parts, `
			SELECT model, provider, SUM(requests) AS requests, SUM(costed_requests) AS costed_requests
			FROM `+usageFactsFineTable+`
			WHERE bucket_start_ms >= ? AND bucket_start_ms < ? AND model <> '' AND model <> 'unknown'
			GROUP BY model, provider`)
		args = append(args, fineFrom, dailyFrom)
	}

	if fromMS < fineFrom {
		parts = append(parts, `
			SELECT model, provider, COUNT(1) AS requests, COALESCE(SUM(cost_nanos IS NOT NULL), 0) AS costed_requests
			FROM usage_events
			WHERE timestamp_ms >= ? AND timestamp_ms < ? AND id <= `+checkpoint+` AND model <> '' AND model <> 'unknown'
			GROUP BY model, provider`)
		args = append(args, fromMS, fineFrom)
	}

	parts = append(parts, `
		SELECT model, provider, COUNT(1) AS requests, COALESCE(SUM(cost_nanos IS NOT NULL), 0) AS costed_requests
		FROM usage_events
		WHERE id > `+checkpoint+` AND timestamp_ms >= ? AND model <> '' AND model <> 'unknown'
		GROUP BY model, provider`)
	args = append(args, fromMS)

	query := `
		SELECT model, provider, COALESCE(SUM(requests), 0), COALESCE(SUM(costed_requests), 0)
		FROM (` + strings.Join(parts, ` UNION ALL `) + `)
		GROUP BY model, provider`

	rows, err := r.SQL().QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("list observed pricing models: %w", err)
	}
	defer rows.Close()

	result := make(map[string]pricing.ObservedModel)
	unpricedCandidates := make(map[string]struct{})
	for rows.Next() {
		var model, provider string
		var requests, costed int64
		if err := rows.Scan(&model, &provider, &requests, &costed); err != nil {
			return nil, fmt.Errorf("scan observed pricing model: %w", err)
		}
		if requests <= 0 {
			continue
		}
		entry := result[model]
		entry.Model = model
		entry.HasRecentUsage = true
		if provider = strings.TrimSpace(provider); provider != "" && !slices.Contains(entry.Channels, provider) {
			entry.Channels = append(entry.Channels, provider)
		}
		result[model] = entry
		if requests > costed {
			unpricedCandidates[model] = struct{}{}
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	for model, entry := range result {
		if len(entry.Channels) > 1 {
			sort.Strings(entry.Channels)
			result[model] = entry
		}
	}
	// Verify each candidate has at least one retained unpriced event with complete
	// accounting, so unresolved-accounting or legacy rows never surface as unpriced.
	for model := range unpricedCandidates {
		var hasUnpriced int
		if err := r.SQL().QueryRowContext(ctx, `
			SELECT EXISTS(
				SELECT 1 FROM usage_events
				WHERE model = ?1 AND timestamp_ms >= ?2
				  AND pricing_status = 'unpriced' AND cost_nanos IS NULL
				  AND (token_accounting IS NULL OR json_extract(token_accounting, '$.status') = 'complete')
				LIMIT 1
			)`, model, fromMS).Scan(&hasUnpriced); err != nil {
			return nil, fmt.Errorf("check observed unpriced model %q: %w", model, err)
		}
		if hasUnpriced == 1 {
			entry := result[model]
			entry.HasUnpriced = true
			result[model] = entry
		}
	}
	return result, nil
}
