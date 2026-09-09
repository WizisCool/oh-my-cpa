-- Simplified model pricing, modeled on cpa-usage-keeper and CPA-Manager-Plus:
-- one row per model with four per-1M token rates plus an optional multiplier.
-- Auto-synced prices (models.dev) never overwrite manual rows; sync failures
-- keep the last good prices. Unknown models simply have no row and reports
-- show them as unpriced instead of fabricating zero.

CREATE TABLE IF NOT EXISTS model_prices (
    model TEXT PRIMARY KEY CHECK (length(model) BETWEEN 1 AND 512),
    prompt_price_per_1m REAL NOT NULL DEFAULT 0 CHECK (prompt_price_per_1m >= 0),
    completion_price_per_1m REAL NOT NULL DEFAULT 0 CHECK (completion_price_per_1m >= 0),
    cache_read_price_per_1m REAL NOT NULL DEFAULT 0 CHECK (cache_read_price_per_1m >= 0),
    cache_write_price_per_1m REAL NOT NULL DEFAULT 0 CHECK (cache_write_price_per_1m >= 0),
    price_multiplier REAL NOT NULL DEFAULT 1 CHECK (price_multiplier > 0),
    source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'modelsdev')),
    synced_at_ms INTEGER NOT NULL DEFAULT 0,
    updated_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS pricing_sync_state (
    source TEXT PRIMARY KEY CHECK (source = 'modelsdev'),
    running INTEGER NOT NULL DEFAULT 0 CHECK (running IN (0, 1)),
    last_success_at_ms INTEGER,
    last_error TEXT NOT NULL DEFAULT '',
    last_matched INTEGER NOT NULL DEFAULT 0,
    last_unmatched INTEGER NOT NULL DEFAULT 0,
    updated_at_ms INTEGER NOT NULL
);
