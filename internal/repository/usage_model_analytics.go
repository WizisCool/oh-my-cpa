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
// **It reads the detail table only, and never the hourly or daily rollup.**
// `QueryUsageAnalytics` splits its window at the aggregation checkpoint and reads the two
// halves from different tables, and that split is not reusable here. Its boundary is a
// *timestamp*, while the rollup's unit of read is a whole row whose start can precede that
// boundary: an event timestamped inside an already-folded hour that arrived late stays on
// the detail side of the boundary while its own hour is already inside the rollup, so both
// halves count it. In a windowed total that artefact is a quiet double count; in a
// per-model ranking it also reorders models, which is the kind of wrong that still looks
// plausible. One source has no boundary to get wrong - the argument ADR 0005 already made
// for the daily token grid.
//
// The cost is a scan of the retained detail rows rather than a read of the rollup, bounded
// by the retention horizon rather than by total history. Its callers are panels that read
// on their own cadence rather than on the dashboard's live tail poll, and
// `BenchmarkQueryUsageModelBuckets` pins the budget.
//
// The measure is `total_tokens`, the column CPA's own accounting persisted, rather than a
// sum of the individual token columns: cached and cache-read tokens overlap between
// providers, so reconstructing a total from them would double count whichever convention a
// given event followed.
//
// Rows are ordered by group then bucket as part of the contract, not as a convenience: the
// caller's fold walks one group at a time and never builds a map of maps.
func (r *Repository) QueryUsageModelBuckets(ctx context.Context, instanceID string, fromMS, toMS, bucketMS int64, opts UsageModelBucketOptions) ([]UsageModelBucketRow, error) {
	if r == nil || r.SQL() == nil {
		return nil, errors.New("repository is not initialized")
	}
	if bucketMS <= 0 {
		return nil, fmt.Errorf("invalid model analytics bucket width %d", bucketMS)
	}
	if toMS < fromMS {
		return nil, errors.New("model analytics window is negative")
	}

	// The grouping key follows the view the panel is drawing. The model view
	// groups by the upstream model name as CPA recorded it. The call view groups
	// by call point: the operator-assigned model alias when the client requested
	// one, falling back to the bare model name, so one call point served by two
	// upstream aliases still reads as the single line the operator called for.
	// The alias is the identity, not a display rewrite: it partitions the rows.
	groupExpression := "model"
	if opts.IsGroupedByCallPoint {
		groupExpression = `COALESCE(NULLIF(TRIM(COALESCE(model_alias, '')), ''), model)`
	}

	query := `
		SELECT ` + groupExpression + ` AS group_key, (timestamp_ms / ?) * ? AS aligned,
		       COALESCE(SUM(total_tokens), 0), COUNT(1),
		       COALESCE(SUM(cost_nanos), 0), COALESCE(SUM(cost_nanos IS NOT NULL), 0)
		FROM usage_events
		WHERE instance_id = ? AND timestamp_ms >= ? AND timestamp_ms <= ?
		GROUP BY group_key, aligned
		ORDER BY group_key ASC, aligned ASC`
	rows, err := r.SQL().QueryContext(ctx, query, bucketMS, bucketMS, instanceID, fromMS, toMS)
	if err != nil {
		return nil, fmt.Errorf("read usage model buckets: %w", err)
	}
	defer rows.Close()

	result := []UsageModelBucketRow{}
	for rows.Next() {
		var row UsageModelBucketRow
		var costNanos, pricedRequests int64
		if errScan := rows.Scan(&row.Model, &row.StartMS, &row.Tokens, &row.Requests, &costNanos, &pricedRequests); errScan != nil {
			return nil, fmt.Errorf("scan usage model bucket: %w", errScan)
		}
		row.CostNanos = &costNanos
		row.PricedRequests = &pricedRequests
		result = append(result, row)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate usage model buckets: %w", err)
	}
	return result, nil
}

// UsageProviderBucketRow is one provider's traffic inside one bucket of the requested grid.
type UsageProviderBucketRow struct {
	Provider string
	StartMS  int64
	Requests int64
	Failures int64
}

// QueryUsageProviderBuckets aggregates one window per provider per bucket, ordered by
// provider and then by bucket.
func (r *Repository) QueryUsageProviderBuckets(ctx context.Context, instanceID string, fromMS, toMS, bucketMS int64) ([]UsageProviderBucketRow, error) {
	if r == nil || r.SQL() == nil {
		return nil, errors.New("repository is not initialized")
	}
	if bucketMS <= 0 {
		return nil, fmt.Errorf("invalid provider analytics bucket width %d", bucketMS)
	}
	if toMS < fromMS {
		return nil, errors.New("provider analytics window is negative")
	}

	query := `
		SELECT COALESCE(NULLIF(TRIM(provider), ''), 'unknown') AS provider_key,
		       (timestamp_ms / ?) * ? AS aligned,
		       COUNT(1),
		       COALESCE(SUM(failed), 0)
		FROM usage_events
		WHERE instance_id = ? AND timestamp_ms >= ? AND timestamp_ms < ?
		GROUP BY provider_key, aligned
		ORDER BY provider_key ASC, aligned ASC`
	rows, err := r.SQL().QueryContext(ctx, query, bucketMS, bucketMS, instanceID, fromMS, toMS)
	if err != nil {
		return nil, fmt.Errorf("read usage provider buckets: %w", err)
	}
	defer rows.Close()

	result := []UsageProviderBucketRow{}
	for rows.Next() {
		var row UsageProviderBucketRow
		if errScan := rows.Scan(&row.Provider, &row.StartMS, &row.Requests, &row.Failures); errScan != nil {
			return nil, fmt.Errorf("scan usage provider bucket: %w", errScan)
		}
		result = append(result, row)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate usage provider buckets: %w", err)
	}
	return result, nil
}

