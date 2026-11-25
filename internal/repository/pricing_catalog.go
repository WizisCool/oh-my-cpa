package repository

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/pricing"
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
// transaction; custom prices and pins stay archived and are hidden by the
// catalog, so a model that returns resumes them.
func (r *Repository) ReplacePricingModels(ctx context.Context, models map[string]string, providers ...pricing.CatalogProvider) (int64, error) {
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
		// An empty target is CPA's ambiguous-alias sentinel, not a missing model.
		// Persist it so unrelated models still sync without guessing an alias price.
		if model == "" || len(model) > 512 || len(target) > 512 {
			return 0, fmt.Errorf("invalid pricing catalog identity")
		}
		if _, err = stmt.ExecContext(ctx, model, target); err != nil {
			return 0, err
		}
	}
	// A model that left the catalog, or whose alias target changed, loses its
	// automatic price. A pinned price is the operator's choice like a custom one:
	// the pin, not the catalog or the alias, decides what a linked model costs, so
	// it is kept for the model's return rather than tombstoned. An automatic price
	// for a purely observed execution model (never in the static catalog, still
	// active in recent facts or unfolded events) is likewise kept across catalog refreshes.
	fromMS, fineFrom, dailyFrom, err := observedActivityWindow(ctx, tx, time.Now().Add(-pricing.ObservedPricingWindow).UnixMilli())
	if err != nil {
		return 0, fmt.Errorf("compute observed pricing activity window: %w", err)
	}
	const checkpoint = `(SELECT COALESCE((SELECT last_usage_event_id FROM usage_aggregation_checkpoints WHERE name = '` + CheckpointFacts + `'), 0))`
	result, err := tx.ExecContext(ctx, `DELETE FROM model_prices WHERE source<>'manual'
 AND NOT EXISTS(SELECT 1 FROM pricing_model_links l WHERE l.model=model_prices.model) AND (
 (NOT EXISTS(SELECT 1 FROM next_pricing_catalog n WHERE n.model=model_prices.model)
  AND (EXISTS(SELECT 1 FROM pricing_model_catalog old WHERE old.model=model_prices.model)
   OR model_prices.model='' OR model_prices.model='unknown'
   OR NOT (
    EXISTS(SELECT 1 FROM `+usageFactsDailyTable+` d WHERE d.model=model_prices.model AND d.bucket_start_ms>=?3 AND d.requests>0)
    OR EXISTS(SELECT 1 FROM `+usageFactsFineTable+` f WHERE f.model=model_prices.model AND f.bucket_start_ms>=?2 AND f.bucket_start_ms<?3 AND f.requests>0)
    OR EXISTS(SELECT 1 FROM usage_events u WHERE u.model=model_prices.model AND u.timestamp_ms>=?1 AND (u.timestamp_ms<?2 OR u.id>`+checkpoint+`))
   )))
 OR EXISTS(SELECT 1 FROM pricing_model_catalog old JOIN next_pricing_catalog n ON n.model=old.model
 WHERE old.model=model_prices.model AND old.price_model<>n.price_model))`, fromMS, fineFrom, dailyFrom)
	if err != nil {
		return 0, fmt.Errorf("retire automatic prices: %w", err)
	}
	pruned, _ := result.RowsAffected()
	if _, err = tx.ExecContext(ctx, `DELETE FROM pricing_model_catalog; INSERT INTO pricing_model_catalog SELECT * FROM next_pricing_catalog;`); err != nil {
		return 0, err
	}
	if providers == nil {
		providers = []pricing.CatalogProvider{}
	}
	providerJSON, err := json.Marshal(providers)
	if err != nil {
		return 0, err
	}
	if _, err = tx.ExecContext(ctx, `UPDATE pricing_catalog_state SET updated_at_ms=?,providers_json=? WHERE id=1`, time.Now().UnixMilli(), string(providerJSON)); err != nil {
		return 0, err
	}
	return pruned, tx.Commit()
}

// ListPricingProviders is a local read of the last complete discovery sweep.
func (r *Repository) ListPricingProviders(ctx context.Context) ([]pricing.CatalogProvider, error) {
	if err := r.requirePricingSchema(ctx); err != nil {
		return nil, err
	}
	var encoded string
	if err := r.SQL().QueryRowContext(ctx, `SELECT providers_json FROM pricing_catalog_state WHERE id=1`).Scan(&encoded); err != nil {
		return nil, err
	}
	providers := []pricing.CatalogProvider{}
	if err := json.Unmarshal([]byte(encoded), &providers); err != nil {
		return nil, err
	}
	return providers, nil
}

// PutProviderPreferencesAfterDelete moves membership and identity overlays together;
// otherwise an old positional group can display the next provider's new name.
func (r *Repository) PutProviderPreferencesAfterDelete(ctx context.Context, values map[string]string, idPrefix string, deletedIndex int) error {
	if err := r.requirePricingSchema(ctx); err != nil {
		return err
	}
	return r.putPreferences(ctx, values, func(tx *sql.Tx) error {
		var encoded string
		if err := tx.QueryRowContext(ctx, `SELECT providers_json FROM pricing_catalog_state WHERE id=1`).Scan(&encoded); err != nil {
			return err
		}
		var providers []pricing.CatalogProvider
		if err := json.Unmarshal([]byte(encoded), &providers); err != nil {
			return err
		}
		shifted := make([]pricing.CatalogProvider, 0, len(providers))
		for _, provider := range providers {
			if strings.HasPrefix(provider.ID, idPrefix) {
				index, err := strconv.Atoi(strings.TrimPrefix(provider.ID, idPrefix))
				if err == nil {
					if index == deletedIndex {
						continue
					}
					if index > deletedIndex {
						provider.ID = fmt.Sprintf("%s%d", idPrefix, index-1)
					}
				}
			}
			shifted = append(shifted, provider)
		}
		document, err := json.Marshal(shifted)
		if err != nil {
			return err
		}
		_, err = tx.ExecContext(ctx, `UPDATE pricing_catalog_state SET providers_json=? WHERE id=1`, string(document))
		return err
	})
}
