package repository

import (
	"context"
	"errors"
	"fmt"
)

// UsageModelBucketOptions selects how the aggregation partitions rows.
type UsageModelBucketOptions struct {
	// GroupBy is the dimension the groups are keyed on: the upstream model (the
	// zero value), the call point a client requested, or the client program.
	GroupBy UsageDimension
	// APIGroupKey narrows analytics to a single client key fingerprint.
	APIGroupKey string
}

// UsageModelBuckets is one grouped read and the part of the window it covers.
type UsageModelBuckets struct {
	Rows []UsageModelBucketRow
	// CoveredFromMS is where the read actually started. It is later than the
	// requested start when a client read reached behind the request-record
	// horizon, where no client attribution is kept.
	CoveredFromMS int64
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
func (r *Repository) QueryUsageModelBuckets(ctx context.Context, instanceID string, fromMS, toMS, bucketMS int64, opts UsageModelBucketOptions) (UsageModelBuckets, error) {
	if bucketMS <= 0 {
		return UsageModelBuckets{}, fmt.Errorf("invalid model analytics bucket width %d", bucketMS)
	}
	if toMS < fromMS {
		return UsageModelBuckets{}, errors.New("model analytics window is negative")
	}
	// The grouping key follows the view the panel is drawing. The alias is the
	// identity in the call view, not a display rewrite: it partitions the rows, so
	// one call point served by two upstream models still reads as a single line.
	dimension := opts.GroupBy
	switch dimension {
	case "":
		dimension = UsageDimensionModel
	case UsageDimensionModel, UsageDimensionCallPoint, UsageDimensionClientAgent:
	default:
		return UsageModelBuckets{}, fmt.Errorf("unsupported model analytics grouping %q", dimension)
	}
	facts, err := r.QueryUsageFacts(ctx, UsageFactQuery{
		InstanceID: instanceID, FromMS: fromMS, ToMS: toMS, BucketMS: bucketMS,
		Dimensions: []UsageDimension{dimension}, Filters: ClientKeyFilter(opts.APIGroupKey),
	})
	if err != nil {
		return UsageModelBuckets{}, fmt.Errorf("read usage model buckets: %w", err)
	}
	result := UsageModelBuckets{Rows: make([]UsageModelBucketRow, 0, len(facts.Rows)), CoveredFromMS: fromMS}
	switch {
	case facts.Clipped && facts.HorizonMS > toMS:
		result.CoveredFromMS = facts.HorizonMS
	case facts.Clipped:
		result.CoveredFromMS = facts.FromMS
	}
	for _, fact := range facts.Rows {
		costNanos, pricedRequests := fact.CostNanos, fact.CostedRequests
		// Client facts keep only the normalised total, so a client row reads that total from
		// request records too; otherwise a request would change size when it is folded.
		tokens := fact.TotalTokens
		if dimension == UsageDimensionClientAgent {
			tokens = fact.Accounting.EffectiveTotalTokens
		}
		result.Rows = append(result.Rows, UsageModelBucketRow{
			Model: fact.Keys[0], StartMS: fact.StartMS, Tokens: tokens, Requests: fact.Requests,
			CostNanos: &costNanos, PricedRequests: &pricedRequests,
		})
	}
	return result, nil
}

// UsageProviderBucketRow is one provider's traffic inside one bucket of the requested grid.
//
// It is a *row* type rather than a finished response for the same reason the model rows are:
// canonicalising the provider label and deciding how a zero-request provider reads is a
// presentation decision, and keeping it out of SQL is what lets it be tested without a database.
type UsageProviderBucketRow struct {
	Provider string
	// CredentialIndex is the runtime auth index of the API key that served the rows, and empty
	// for every other record. CPA labels an API-key request with its family ("codex"), the same
	// label an OAuth request of that family carries, so the label alone cannot say which
	// configured provider answered; the index can.
	CredentialIndex string
	StartMS         int64
	Requests        int64
	Failures        int64
}

// QueryUsageProviderBuckets aggregates the requested window, [fromMS, toMS], per provider and
// bucket, and returns the grid it actually read: a window reaching behind the request-record
// horizon is read in whole fact buckets, so the width can come back coarser than requested.
//
// The read is answered from the fact grains, not by grouping request records, which is what
// makes a per-row grid affordable on a list that polls every thirty seconds.
func (r *Repository) QueryUsageProviderBuckets(ctx context.Context, instanceID string, fromMS, toMS, bucketMS int64) ([]UsageProviderBucketRow, int64, error) {
	if toMS < fromMS {
		return nil, 0, errors.New("provider analytics window is negative")
	}
	if bucketMS <= 0 {
		return nil, 0, fmt.Errorf("invalid provider analytics bucket width %d", bucketMS)
	}
	facts, err := r.QueryUsageFacts(ctx, UsageFactQuery{
		InstanceID: instanceID, FromMS: fromMS, ToMS: toMS, BucketMS: bucketMS,
		Dimensions: []UsageDimension{UsageDimensionProvider, UsageDimensionServingKey},
	})
	if err != nil {
		return nil, 0, fmt.Errorf("read usage provider buckets: %w", err)
	}
	result := make([]UsageProviderBucketRow, 0, len(facts.Rows))
	for _, fact := range facts.Rows {
		result = append(result, UsageProviderBucketRow{
			Provider: fact.Keys[0], CredentialIndex: fact.Keys[1], StartMS: fact.StartMS,
			Requests: fact.Requests, Failures: fact.Failures,
		})
	}
	return result, facts.BucketMS, nil
}
