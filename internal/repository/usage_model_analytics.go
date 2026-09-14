package repository

import (
	"context"
	"errors"
	"fmt"
)

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
}

// QueryUsageModelBuckets aggregates one window per model per bucket, ordered by model
// and then by bucket.
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
// Rows are ordered by model then bucket as part of the contract, not as a convenience: the
// caller's fold walks one model at a time and never builds a map of maps.
func (r *Repository) QueryUsageModelBuckets(ctx context.Context, instanceID string, fromMS, toMS, bucketMS int64) ([]UsageModelBucketRow, error) {
	if r == nil || r.SQL() == nil {
		return nil, errors.New("repository is not initialized")
	}
	if bucketMS <= 0 {
		return nil, fmt.Errorf("invalid model analytics bucket width %d", bucketMS)
	}
	if toMS < fromMS {
		return nil, errors.New("model analytics window is negative")
	}

	rows, err := r.SQL().QueryContext(ctx, `
		SELECT model, (timestamp_ms / ?) * ? AS aligned,
		       COALESCE(SUM(total_tokens), 0), COUNT(1)
		FROM usage_events
		WHERE instance_id = ? AND timestamp_ms >= ? AND timestamp_ms <= ?
		GROUP BY model, aligned
		ORDER BY model ASC, aligned ASC`, bucketMS, bucketMS, instanceID, fromMS, toMS)
	if err != nil {
		return nil, fmt.Errorf("read usage model buckets: %w", err)
	}
	defer rows.Close()

	result := []UsageModelBucketRow{}
	for rows.Next() {
		var row UsageModelBucketRow
		if errScan := rows.Scan(&row.Model, &row.StartMS, &row.Tokens, &row.Requests); errScan != nil {
			return nil, fmt.Errorf("scan usage model bucket: %w", errScan)
		}
		result = append(result, row)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate usage model buckets: %w", err)
	}
	return result, nil
}
