package repository

import (
	"context"
	"fmt"
	"sort"
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

func (r *Repository) queryPricingUsage(ctx context.Context, column string, fromMS int64) (map[string]PricingUsage, error) {
	rows, err := r.SQL().QueryContext(ctx, `SELECT `+column+`, COUNT(1), COALESCE(SUM(cost_nanos IS NOT NULL), 0), COALESCE(SUM(cost_nanos), 0)
 FROM usage_events WHERE timestamp_ms >= ? AND `+column+` <> '' GROUP BY `+column, fromMS)
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
