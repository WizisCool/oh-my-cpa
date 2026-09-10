package repository

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"github.com/oh-my-cpa/oh-my-cpa/internal/pricing"
	"github.com/oh-my-cpa/oh-my-cpa/internal/usage"
)

// lockUsagePrice runs inside the event insert transaction. The rate is selected
// by request time, not ingestion time, so delayed queue delivery cannot reprice
// an older request. A tombstone stops a removed price from leaking forward.
func lockUsagePrice(ctx context.Context, tx *sql.Tx, event usage.Event) (cost, version *int64, status string, err error) {
	var p pricing.ModelPrice
	var id int64
	var available bool
	err = tx.QueryRowContext(ctx, `SELECT id, available, model, prompt_price_per_1m,
 completion_price_per_1m, cache_read_price_per_1m, cache_write_price_per_1m, price_multiplier, source
 FROM model_price_versions WHERE model = ? AND effective_from_ms <= ?
 ORDER BY effective_from_ms DESC, id DESC LIMIT 1`, event.Model, event.TimestampMS).Scan(
		&id, &available, &p.Model, &p.PromptPricePer1M, &p.CompletionPer1M, &p.CacheReadPer1M, &p.CacheWritePer1M, &p.PriceMultiplier, &p.Source)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil, "unpriced", nil
	}
	if err != nil {
		return nil, nil, "", fmt.Errorf("read request price: %w", err)
	}
	if !available {
		return nil, nil, "unpriced", nil
	}
	nanos, err := p.CostNanos(event.InputTokens, event.OutputTokens, event.CacheReadTokens, event.CacheCreationTokens)
	// Invalid or overflowing prices must not lose usage telemetry or look free.
	if err != nil {
		return nil, &id, "invalid_price", nil
	}
	return &nanos, &id, "priced", nil
}
