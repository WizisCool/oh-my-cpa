package repository

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/pricing"
)

func (r *Repository) ListChannelModelPrices(ctx context.Context) ([]pricing.ModelPrice, error) {
	rows, err := r.SQL().QueryContext(ctx, `SELECT channel, model, prompt_price_per_1m, completion_price_per_1m,
 cache_read_price_per_1m, cache_write_price_per_1m, price_multiplier, tiers_json, updated_at_ms
 FROM channel_model_prices ORDER BY channel, model`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []pricing.ModelPrice{}
	for rows.Next() {
		var row pricing.ModelPrice
		var tiers string
		if err := rows.Scan(&row.Channel, &row.Model, &row.PromptPricePer1M, &row.CompletionPer1M,
			&row.CacheReadPer1M, &row.CacheWritePer1M, &row.PriceMultiplier, &tiers, &row.UpdatedAtMS); err != nil {
			return nil, err
		}
		row.Tiers, err = pricing.DecodeTiers(tiers)
		if err != nil {
			return nil, err
		}
		row.Source, row.Mode = pricing.SourceManual, pricing.ModeCustom
		result = append(result, row)
	}
	return result, rows.Err()
}

func (r *Repository) UpsertChannelModelPrice(ctx context.Context, row pricing.ModelPrice) error {
	if row.Channel == "" || len(row.Channel) > 256 {
		return errors.New("channel is required (max 256 chars)")
	}
	if err := row.ValidateWrite(); err != nil {
		return err
	}
	tiers, err := pricing.EncodeTiers(row.Tiers)
	if err != nil {
		return err
	}
	_, err = r.SQL().ExecContext(ctx, `INSERT INTO channel_model_prices(channel, model, prompt_price_per_1m,
 completion_price_per_1m, cache_read_price_per_1m, cache_write_price_per_1m, price_multiplier, tiers_json, updated_at_ms)
 VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(channel, model) DO UPDATE SET
 prompt_price_per_1m=excluded.prompt_price_per_1m, completion_price_per_1m=excluded.completion_price_per_1m,
 cache_read_price_per_1m=excluded.cache_read_price_per_1m, cache_write_price_per_1m=excluded.cache_write_price_per_1m,
 price_multiplier=excluded.price_multiplier, tiers_json=excluded.tiers_json, updated_at_ms=excluded.updated_at_ms`,
		row.Channel, row.Model, row.PromptPricePer1M, row.CompletionPer1M, row.CacheReadPer1M,
		row.CacheWritePer1M, row.PriceMultiplier, tiers, time.Now().UnixMilli())
	if err != nil {
		return fmt.Errorf("save channel model price: %w", err)
	}
	return nil
}

func (r *Repository) DeleteChannelModelPrice(ctx context.Context, channel, model string) (bool, error) {
	result, err := r.SQL().ExecContext(ctx, `DELETE FROM channel_model_prices WHERE channel=? AND model=?`, channel, model)
	if err != nil {
		return false, err
	}
	count, err := result.RowsAffected()
	return count > 0, err
}
