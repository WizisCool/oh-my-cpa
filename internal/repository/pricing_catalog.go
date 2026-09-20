package repository

import (
	"context"
	"fmt"
	"strings"
	"time"
)

// ListPricingModels returns the last complete CPA catalog, never traffic history.
func (r *Repository) ListPricingModels(ctx context.Context) (map[string]string, error) {
	if err := r.requirePricingSchema(ctx); err != nil {
		return nil, err
	}
	rows, err := r.SQL().QueryContext(ctx, `SELECT model,price_model FROM pricing_model_catalog ORDER BY model`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make(map[string]string)
	for rows.Next() {
		var model, target string
		if err := rows.Scan(&model, &target); err != nil {
			return nil, err
		}
		result[model] = target
	}
	return result, rows.Err()
}

// ReplacePricingModels publishes a complete snapshot atomically. Removed or
// retargeted automatic prices are retired with version tombstones in the same
// transaction; manual overrides stay archived and are hidden by the catalog.
func (r *Repository) ReplacePricingModels(ctx context.Context, models map[string]string) (int64, error) {
	if err := r.requirePricingSchema(ctx); err != nil {
		return 0, err
	}
	if len(models) == 0 {
		return 0, fmt.Errorf("refusing to publish an empty pricing catalog snapshot")
	}
	tx, err := r.SQL().BeginTx(ctx, nil)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()
	if _, err = tx.ExecContext(ctx, `CREATE TEMP TABLE IF NOT EXISTS next_pricing_catalog(model TEXT PRIMARY KEY,price_model TEXT NOT NULL); DELETE FROM next_pricing_catalog;`); err != nil {
		return 0, err
	}
	stmt, err := tx.PrepareContext(ctx, `INSERT INTO next_pricing_catalog VALUES(?,?)`)
	if err != nil {
		return 0, err
	}
	defer stmt.Close()
	for model, target := range models {
		model = strings.TrimSpace(model)
		target = strings.TrimSpace(target)
		if model == "" || len(model) > 512 || len(target) > 512 {
			return 0, fmt.Errorf("invalid pricing catalog identity")
		}
		if _, err = stmt.ExecContext(ctx, model, target); err != nil {
			return 0, err
		}
	}
	result, err := tx.ExecContext(ctx, `DELETE FROM model_prices WHERE source='modelsdev' AND (
 NOT EXISTS(SELECT 1 FROM next_pricing_catalog n WHERE n.model=model_prices.model)
 OR EXISTS(SELECT 1 FROM pricing_model_catalog old JOIN next_pricing_catalog n ON n.model=old.model
 WHERE old.model=model_prices.model AND old.price_model<>n.price_model))`)
	if err != nil {
		return 0, fmt.Errorf("retire automatic prices: %w", err)
	}
	pruned, _ := result.RowsAffected()
	if _, err = tx.ExecContext(ctx, `DELETE FROM pricing_model_catalog; INSERT INTO pricing_model_catalog SELECT * FROM next_pricing_catalog;`); err != nil {
		return 0, err
	}
	if _, err = tx.ExecContext(ctx, `UPDATE pricing_catalog_state SET updated_at_ms=? WHERE id=1`, time.Now().UnixMilli()); err != nil {
		return 0, err
	}
	return pruned, tx.Commit()
}
