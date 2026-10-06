package repository

import (
	"context"
	"errors"
	"fmt"
)

// UsageModelBucketOptions selects how the aggregation partitions rows.
//
// It is a struct rather than a boolean parameter so the next grouping question
// - by provider, by credential - lands here as a field with a name, not as a
// second positional bool nobody can read at the call site.
type UsageModelBucketOptions struct {
	// IsGroupedByCallPoint partitions by call point instead of upstream model. A
	// call point is the client-facing identity: the model alias a client
	// requested when there is one, the upstream model name otherwise.
	IsGroupedByCallPoint bool
	// APIGroupKey narrows analytics to a single client key fingerprint.
	APIGroupKey string
}

// UsageModelBucketRow is one model's traffic inside one bucket of the requested grid.
//
// This is deliberately a *row* type rather than a finished series: ranking and folding
// rows into the groups a panel draws is a presentation decision, and keeping it out of
// SQL is what lets it be tested without a database.
type UsageModelBucketRow struct {
	Model    string
	StartMS  int64
	Tokens   int64
	Requests int64
	// CostNanos sums only rows priced at request time; unpriced rows contribute
	// tokens and requests but no cost, matching the KPI cost tile's semantics.
	// A nil means the caller did not ask for costs and the handler reports none.
	CostNanos *int64
	// PricedRequests is the number of requests that carried a cost. The panel
	// shows it alongside the sum so an unpriced-heavy window cannot present a
	// partial spend as the whole picture.
	PricedRequests *int64
}

// QueryUsageModelBuckets aggregates one window per group per bucket, ordered by
// group and then by bucket.
//
// It goes through the same fact read as every other panel. The facts and the
// request records past the checkpoint are split by event id inside one statement,
// so a record that arrives late with an old timestamp is counted once: it is
// either folded or it is not. A per-model ranking is where a double count would
// do the most damage, because it reorders models and still looks plausible.
//
// The measure is `total_tokens`, the column CPA's own accounting persisted, rather than a
// sum of the individual token columns: cached and cache-read tokens overlap between
// providers, so reconstructing a total from them would double count whichever convention a
// given event followed.
//
// Rows are ordered by group then bucket as part of the contract, not as a convenience: the
// caller's fold walks one group at a time and never builds a map of maps.
func (r *Repository) QueryUsageModelBuckets(ctx context.Context, instanceID string, fromMS, toMS, bucketMS int64, opts UsageModelBucketOptions) ([]UsageModelBucketRow, error) {
	if bucketMS <= 0 {
		return nil, fmt.Errorf("invalid model analytics bucket width %d", bucketMS)
	}
	if toMS < fromMS {
		return nil, errors.New("model analytics window is negative")
	}
	// The grouping key follows the view the panel is drawing. The alias is the
	// identity in the call view, not a display rewrite: it partitions the rows, so
	// one call point served by two upstream models still reads as a single line.
	grouping := UsageGroupModel
	if opts.IsGroupedByCallPoint {
		grouping = UsageGroupCallPoint
	}
	facts, err := r.QueryUsageFacts(ctx, UsageFactQuery{
		InstanceID: instanceID, FromMS: fromMS, ToMS: toMS, BucketMS: bucketMS,
		GroupBy: grouping, APIGroupKey: opts.APIGroupKey,
	})
	if err != nil {
		return nil, fmt.Errorf("read usage model buckets: %w", err)
	}
	result := make([]UsageModelBucketRow, 0, len(facts.Rows))
	for _, fact := range facts.Rows {
		costNanos, pricedRequests := fact.CostNanos, fact.CostedRequests
		result = append(result, UsageModelBucketRow{
			Model: fact.Group, StartMS: fact.StartMS, Tokens: fact.TotalTokens, Requests: fact.Requests,
			CostNanos: &costNanos, PricedRequests: &pricedRequests,
		})
	}
	return result, nil
}

// UsageProviderTotalsRow is one provider's traffic across the whole requested window.
//
// It is a *row* type rather than a finished response for the same reason the model rows are:
// canonicalising the provider label and deciding how a zero-request provider reads is a
// presentation decision, and keeping it out of SQL is what lets it be tested without a database.
type UsageProviderTotalsRow struct {
	Provider string
	// CredentialIndex is the runtime auth index of the API key that served the rows, and empty
	// for every other record. CPA labels an API-key request with its family ("codex"), the same
	// label an OAuth request of that family carries, so the label alone cannot say which
	// configured provider answered; the index can.
	CredentialIndex string
	Requests        int64
	Failures        int64
}

// QueryUsageProviderTotals aggregates the requested window, [fromMS, toMS), per provider.
//
// One row per provider, with no bucket: the dashboard's provider list prints a window total and a
// rate, and reads the rate against the console's fixed bands.
func (r *Repository) QueryUsageProviderTotals(ctx context.Context, instanceID string, fromMS, toMS int64) ([]UsageProviderTotalsRow, error) {
	if toMS < fromMS {
		return nil, errors.New("provider analytics window is negative")
	}
	result := []UsageProviderTotalsRow{}
	if toMS == fromMS {
		return result, nil
	}
	facts, err := r.QueryUsageFacts(ctx, UsageFactQuery{
		InstanceID: instanceID, FromMS: fromMS, ToMS: toMS - 1, GroupBy: UsageGroupProviderCredential,
	})
	if err != nil {
		return nil, fmt.Errorf("read usage provider totals: %w", err)
	}
	for _, fact := range facts.Rows {
		result = append(result, UsageProviderTotalsRow{
			Provider: fact.Group, CredentialIndex: fact.SubGroup, Requests: fact.Requests, Failures: fact.Failures,
		})
	}
	return result, nil
}
