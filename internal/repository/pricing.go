package repository

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/pricing"
)

// ModelPrice is the shared price row type; the repository stores and reports
// exactly the domain struct the pricing package validates.
type ModelPrice = pricing.ModelPrice

// PricingSyncState is the durable result of the last models.dev sync. Running
// is an in-memory property of the service and is never trusted from disk.
type PricingSyncState = pricing.SyncState

const pricingSyncStateSelect = `SELECT source, last_success_at_ms, last_error, last_matched, last_unmatched, updated_at_ms FROM pricing_sync_state`

func scanPricingSyncState(row *sql.Row, state *pricing.SyncState) error {
	var lastSuccess sql.NullInt64
	var updatedAt sql.NullInt64
	if err := row.Scan(&state.Source, &lastSuccess, &state.LastError, &state.LastMatched, &state.LastUnmatched, &updatedAt); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return err
		}
		return fmt.Errorf("scan pricing sync state: %w", err)
	}
	if lastSuccess.Valid {
		value := lastSuccess.Int64
		state.LastSuccessAtMS = &value
	}
	if updatedAt.Valid {
		state.UpdatedAtMS = updatedAt.Int64
	}
	return nil
}

// ListModelPrices returns every price row ordered by model.
func (r *Repository) ListModelPrices(ctx context.Context) ([]ModelPrice, error) {
	if err := r.requirePricingSchema(ctx); err != nil {
		return nil, err
	}
	rows, err := r.SQL().QueryContext(ctx, `SELECT model, prompt_price_per_1m, completion_price_per_1m, cache_read_price_per_1m, cache_write_price_per_1m, price_multiplier, source, synced_at_ms, updated_at_ms FROM model_prices ORDER BY model`)
	if err != nil {
		return nil, fmt.Errorf("list model prices: %w", err)
	}
	defer rows.Close()
	result := make([]ModelPrice, 0, 64)
	for rows.Next() {
		var row ModelPrice
		if err := rows.Scan(&row.Model, &row.PromptPricePer1M, &row.CompletionPer1M, &row.CacheReadPer1M, &row.CacheWritePer1M, &row.PriceMultiplier, &row.Source, &row.SyncedAtMS, &row.UpdatedAtMS); err != nil {
			return nil, fmt.Errorf("scan model price: %w", err)
		}
		result = append(result, row)
	}
	return result, rows.Err()
}

// UpsertModelPrices writes a batch of validated rows in one transaction. It is
// the caller's job to keep manual rows out of auto-sync batches.
func (r *Repository) UpsertModelPrices(ctx context.Context, rows []ModelPrice) error {
	if err := r.requirePricingSchema(ctx); err != nil {
		return err
	}
	if len(rows) == 0 {
		return nil
	}
	now := time.Now().UnixMilli()
	tx, err := r.SQL().BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin upsert model prices: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	for _, row := range rows {
		if err := row.Validate(); err != nil {
			return fmt.Errorf("model price %q: %w", row.Model, err)
		}
		if row.UpdatedAtMS <= 0 {
			row.UpdatedAtMS = now
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO model_prices (
			model, prompt_price_per_1m, completion_price_per_1m, cache_read_price_per_1m,
			cache_write_price_per_1m, price_multiplier, source, synced_at_ms, updated_at_ms
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(model) DO UPDATE SET
			prompt_price_per_1m = excluded.prompt_price_per_1m,
			completion_price_per_1m = excluded.completion_price_per_1m,
			cache_read_price_per_1m = excluded.cache_read_price_per_1m,
			cache_write_price_per_1m = excluded.cache_write_price_per_1m,
			price_multiplier = excluded.price_multiplier,
			source = excluded.source,
			synced_at_ms = excluded.synced_at_ms,
			updated_at_ms = excluded.updated_at_ms`,
			row.Model, row.PromptPricePer1M, row.CompletionPer1M, row.CacheReadPer1M,
			row.CacheWritePer1M, row.PriceMultiplier, row.Source, row.SyncedAtMS, row.UpdatedAtMS); err != nil {
			return fmt.Errorf("upsert model price %q: %w", row.Model, err)
		}
	}
	return tx.Commit()
}

// DeleteModelPrice removes one row; history stays in audit events.
func (r *Repository) DeleteModelPrice(ctx context.Context, model string) (bool, error) {
	if err := r.requirePricingSchema(ctx); err != nil {
		return false, err
	}
	result, err := r.SQL().ExecContext(ctx, `DELETE FROM model_prices WHERE model = ?`, strings.TrimSpace(model))
	if err != nil {
		return false, fmt.Errorf("delete model price: %w", err)
	}
	deleted, _ := result.RowsAffected()
	return deleted > 0, nil
}

// GetPricingSyncState returns the models.dev sync bookkeeping; sql.ErrNoRows
// means the source has never been synced.
func (r *Repository) GetPricingSyncState(ctx context.Context, source string) (PricingSyncState, error) {
	if err := r.requirePricingSchema(ctx); err != nil {
		return PricingSyncState{}, err
	}
	var state PricingSyncState
	err := scanPricingSyncState(r.SQL().QueryRowContext(ctx, pricingSyncStateSelect+` WHERE source = ?`, source), &state)
	return state, err
}

// SavePricingSyncState persists the last sync outcome. A failed sync keeps the
// previous success fields untouched and only records the error.
func (r *Repository) SavePricingSyncState(ctx context.Context, state PricingSyncState) error {
	if err := r.requirePricingSchema(ctx); err != nil {
		return err
	}
	state.Source = strings.TrimSpace(state.Source)
	if state.Source == "" {
		return errors.New("pricing sync source is required")
	}
	var lastSuccess any
	if state.LastSuccessAtMS != nil {
		lastSuccess = *state.LastSuccessAtMS
	}
	_, err := r.SQL().ExecContext(ctx, `INSERT INTO pricing_sync_state (
		source, running, last_success_at_ms, last_error, last_matched, last_unmatched, updated_at_ms
	) VALUES (?, 0, ?, ?, ?, ?, ?)
	ON CONFLICT(source) DO UPDATE SET
		running = 0,
		last_success_at_ms = COALESCE(?, last_success_at_ms),
		last_error = excluded.last_error,
		last_matched = excluded.last_matched,
		last_unmatched = excluded.last_unmatched,
		updated_at_ms = excluded.updated_at_ms`,
		state.Source, lastSuccess, state.LastError, state.LastMatched, state.LastUnmatched, time.Now().UnixMilli(),
		state.Source)
	if err != nil {
		return fmt.Errorf("save pricing sync state: %w", err)
	}
	return nil
}

// ListEffectiveModels returns only models actually seen in usage events, most
// recently used first. Provider catalogs list hundreds of configured models;
// pricing must follow traffic, not the catalog, or the table bloats with
// models the deployment never calls. Bounded like every other read.
func (r *Repository) ListEffectiveModels(ctx context.Context) ([]string, error) {
	if err := r.requirePricingSchema(ctx); err != nil {
		return nil, err
	}
	rows, err := r.SQL().QueryContext(ctx, `SELECT model, MAX(timestamp_ms) AS last_seen FROM usage_events WHERE model <> '' GROUP BY model ORDER BY last_seen DESC LIMIT 1000`)
	if err != nil {
		return nil, fmt.Errorf("list used models: %w", err)
	}
	defer rows.Close()
	seen := make(map[string]struct{}, 256)
	result := make([]string, 0, 256)
	for rows.Next() {
		var lastSeen int64
		var model string
		if err := rows.Scan(&model, &lastSeen); err != nil {
			return nil, fmt.Errorf("scan used model: %w", err)
		}
		model = strings.TrimSpace(model)
		if model == "" || len(model) > 512 {
			continue
		}
		if _, ok := seen[model]; ok {
			continue
		}
		seen[model] = struct{}{}
		result = append(result, model)
	}
	return result, rows.Err()
}

// requirePricingSchema refuses to touch pricing tables when migration 015 has
// not been applied, mirroring the pattern other subsystems use.
func (r *Repository) requirePricingSchema(ctx context.Context) error {
	if r == nil || r.SQL() == nil {
		return errors.New("repository is not initialized")
	}
	var applied int
	if err := r.SQL().QueryRowContext(ctx, `SELECT COUNT(1) FROM schema_migrations WHERE version = 15`).Scan(&applied); err != nil {
		return fmt.Errorf("pricing schema check: %w", err)
	}
	if applied == 0 {
		return errors.New("model pricing schema migration 15 is not applied")
	}
	return nil
}

// UsageCostStats is the window cost estimate plus its coverage.
type UsageCostStats struct {
	CostUSD        float64
	PricedEvents   int64
	UnpricedEvents int64
}

// QueryUsageCost estimates one window's cost by joining model prices at query
// time. Events without a price row count as unpriced instead of free.
func (r *Repository) QueryUsageCost(ctx context.Context, instanceID string, fromMS, toMS int64) (UsageCostStats, error) {
	if err := r.requirePricingSchema(ctx); err != nil {
		return UsageCostStats{}, err
	}
	costExpr := `CASE WHEN mp.model IS NULL THEN 0 ELSE (
		           max(e.input_tokens - e.cache_read_tokens - e.cache_creation_tokens, 0) / 1000000.0 * mp.prompt_price_per_1m
		         + e.cache_read_tokens / 1000000.0 * mp.cache_read_price_per_1m
		         + e.cache_creation_tokens / 1000000.0 * mp.cache_write_price_per_1m
		         + e.output_tokens / 1000000.0 * mp.completion_price_per_1m
		       ) * mp.price_multiplier END`
	query := `SELECT
			COALESCE(SUM(` + costExpr + `), 0),
			COALESCE(SUM(CASE WHEN mp.model IS NOT NULL THEN 1 ELSE 0 END), 0),
			COALESCE(SUM(CASE WHEN mp.model IS NULL THEN 1 ELSE 0 END), 0)
		FROM usage_events e
		LEFT JOIN model_prices mp ON mp.model = e.model
		WHERE e.instance_id = ? AND e.timestamp_ms >= ? AND e.timestamp_ms <= ?`
	var stats UsageCostStats
	if err := r.SQL().QueryRowContext(ctx, query, instanceID, fromMS, toMS).Scan(&stats.CostUSD, &stats.PricedEvents, &stats.UnpricedEvents); err != nil {
		return UsageCostStats{}, fmt.Errorf("query usage cost: %w", err)
	}
	return stats, nil
}
