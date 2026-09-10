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

// pricingSyncStateSelect reads last_success_at_ms through a typeof() guard: SQLite
// does not enforce column types, so the defective upsert below once stored TEXT in an
// INTEGER column, and one unreadable bookkeeping field must not take the whole
// pricing page down. Migration 016 repairs the stored rows; the guard keeps a dirty
// row non-fatal.
const pricingSyncStateSelect = `SELECT source,
	CASE WHEN typeof(last_success_at_ms) = 'integer' THEN last_success_at_ms ELSE NULL END AS last_success_at_ms,
	last_error, last_matched, last_unmatched, updated_at_ms,
	CASE WHEN typeof(auto_sync_interval_hours) = 'integer' THEN auto_sync_interval_hours ELSE 24 END AS auto_sync_interval_hours,
 (SELECT updated_at_ms FROM pricing_catalog_state WHERE id=1)
	FROM pricing_sync_state`

func scanPricingSyncState(row *sql.Row, state *pricing.SyncState) error {
	var lastSuccess sql.NullInt64
	var updatedAt sql.NullInt64
	var autoSyncHours sql.NullInt64
	if err := row.Scan(&state.Source, &lastSuccess, &state.LastError, &state.LastMatched, &state.LastUnmatched, &updatedAt, &autoSyncHours, &state.CatalogUpdatedAtMS); err != nil {
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
	if autoSyncHours.Valid {
		state.AutoSyncIntervalHours = autoSyncHours.Int64
	} else {
		state.AutoSyncIntervalHours = 24
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
// auto-sync cannot overwrite manual rows, including concurrent edits.
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
			updated_at_ms = excluded.updated_at_ms
        WHERE excluded.source = 'manual' OR model_prices.source <> 'manual'`,
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
	// Every UPDATE term must read from excluded/ or the target row: an earlier
	// revision put a seventh placeholder in COALESCE() here and passed the source
	// name for it, so each repeat sync overwrote last_success_at_ms with the TEXT
	// 'modelsdev' and the pricing page could no longer read its own state.
	// COALESCE against the existing row still keeps the last good success when a
	// sync fails, without any placeholder in the UPDATE clause.
	autoInterval := state.AutoSyncIntervalHours
	if autoInterval <= 0 {
		autoInterval = 24
	}
	_, err := r.SQL().ExecContext(ctx, `INSERT INTO pricing_sync_state (
		source, running, last_success_at_ms, last_error, last_matched, last_unmatched, auto_sync_interval_hours, updated_at_ms
	) VALUES (?, 0, ?, ?, ?, ?, ?, ?)
	ON CONFLICT(source) DO UPDATE SET
		running = 0,
		last_success_at_ms = COALESCE(excluded.last_success_at_ms, pricing_sync_state.last_success_at_ms),
		last_error = excluded.last_error,
		last_matched = excluded.last_matched,
		last_unmatched = excluded.last_unmatched,
		updated_at_ms = excluded.updated_at_ms`,
		state.Source, lastSuccess, state.LastError, state.LastMatched, state.LastUnmatched, autoInterval, time.Now().UnixMilli())
	if err != nil {
		return fmt.Errorf("save pricing sync state: %w", err)
	}
	return nil
}

// UpdatePricingSyncSchedule sets the background auto sync interval in hours.
// 0 disables background auto sync.
func (r *Repository) UpdatePricingSyncSchedule(ctx context.Context, source string, intervalHours int64) error {
	if err := r.requirePricingSchema(ctx); err != nil {
		return err
	}
	source = strings.TrimSpace(source)
	if source == "" {
		return errors.New("pricing sync source is required")
	}
	if intervalHours < 0 || intervalHours > 168 {
		return fmt.Errorf("invalid auto sync interval: %d hours (must be 0-168)", intervalHours)
	}
	_, err := r.SQL().ExecContext(ctx, `INSERT INTO pricing_sync_state (
		source, running, last_success_at_ms, last_error, last_matched, last_unmatched, auto_sync_interval_hours, updated_at_ms
	) VALUES (?, 0, NULL, '', 0, 0, ?, ?)
	ON CONFLICT(source) DO UPDATE SET
		auto_sync_interval_hours = excluded.auto_sync_interval_hours,
		updated_at_ms = excluded.updated_at_ms`,
		source, intervalHours, time.Now().UnixMilli())
	if err != nil {
		return fmt.Errorf("update pricing sync schedule: %w", err)
	}
	return nil
}

// requirePricingSchema refuses to touch pricing tables until the immutable
// snapshot and current-catalog migrations are present.
func (r *Repository) requirePricingSchema(ctx context.Context) error {
	if r == nil || r.SQL() == nil {
		return errors.New("repository is not initialized")
	}
	var applied int
	if err := r.SQL().QueryRowContext(ctx, `SELECT COUNT(1) FROM schema_migrations WHERE version = 20`).Scan(&applied); err != nil {
		return fmt.Errorf("pricing schema check: %w", err)
	}
	if applied == 0 {
		return errors.New("model pricing schema migration 20 is not applied")
	}
	return nil
}

// UsageCostStats is the window cost estimate plus its coverage.
type UsageCostStats struct {
	CostUSD        float64
	PricedEvents   int64
	UnpricedEvents int64
}

// QueryUsageCost sums locked request costs, never the mutable price catalog.
func (r *Repository) QueryUsageCost(ctx context.Context, instanceID string, fromMS, toMS int64) (UsageCostStats, error) {
	query := `SELECT COALESCE(TOTAL(cost_nanos), 0) / 1000000000.0,
 COALESCE(SUM(pricing_status = 'priced'), 0), COALESCE(SUM(pricing_status <> 'priced'), 0)
 FROM usage_events WHERE instance_id = ? AND timestamp_ms >= ? AND timestamp_ms <= ?`
	var stats UsageCostStats
	if err := r.SQL().QueryRowContext(ctx, query, instanceID, fromMS, toMS).Scan(&stats.CostUSD, &stats.PricedEvents, &stats.UnpricedEvents); err != nil {
		return UsageCostStats{}, fmt.Errorf("query usage cost: %w", err)
	}
	return stats, nil
}
