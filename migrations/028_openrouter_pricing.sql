-- OpenRouter becomes the only automatic price source, prices gain tiers
-- (long-context thresholds and UTC time-of-day windows), a CPA model can be
-- pinned to a chosen OpenRouter model, and each CPA provider ("channel") can
-- carry a multiplier that is locked per request like a price version.
--
-- model_prices and pricing_sync_state are rebuilt because SQLite cannot relax a
-- CHECK constraint. model_price_versions is only extended: usage_events
-- references it and its rows are immutable. Existing rows are copied verbatim
-- with the version triggers dropped, so the upgrade mints no price version and
-- reprices nothing; a legacy 'modelsdev' row keeps its rate until a sync
-- replaces it, and that replacement records an honest new version.

DROP TRIGGER price_version_on_insert;
DROP TRIGGER price_version_on_update;
DROP TRIGGER price_version_on_delete;

ALTER TABLE model_price_versions ADD COLUMN tiers_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE model_price_versions ADD COLUMN upstream_id TEXT NOT NULL DEFAULT '';

CREATE TABLE model_prices_next (
    model TEXT PRIMARY KEY CHECK (length(model) BETWEEN 1 AND 512),
    prompt_price_per_1m REAL NOT NULL DEFAULT 0 CHECK (prompt_price_per_1m >= 0),
    completion_price_per_1m REAL NOT NULL DEFAULT 0 CHECK (completion_price_per_1m >= 0),
    cache_read_price_per_1m REAL NOT NULL DEFAULT 0 CHECK (cache_read_price_per_1m >= 0),
    cache_write_price_per_1m REAL NOT NULL DEFAULT 0 CHECK (cache_write_price_per_1m >= 0),
    price_multiplier REAL NOT NULL DEFAULT 1 CHECK (price_multiplier > 0),
    tiers_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tiers_json) AND json_type(tiers_json) = 'array'),
    source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'openrouter', 'modelsdev')),
    upstream_id TEXT NOT NULL DEFAULT '' CHECK (length(upstream_id) <= 256),
    match_kind TEXT NOT NULL DEFAULT '' CHECK (match_kind IN ('', 'exact', 'canonical', 'normalized', 'date_stripped', 'alias', 'linked')),
    synced_at_ms INTEGER NOT NULL DEFAULT 0,
    updated_at_ms INTEGER NOT NULL
);
INSERT INTO model_prices_next (model, prompt_price_per_1m, completion_price_per_1m, cache_read_price_per_1m,
    cache_write_price_per_1m, price_multiplier, source, synced_at_ms, updated_at_ms)
SELECT model, prompt_price_per_1m, completion_price_per_1m, cache_read_price_per_1m,
    cache_write_price_per_1m, price_multiplier, source, synced_at_ms, updated_at_ms
FROM model_prices;
DROP TABLE model_prices;
ALTER TABLE model_prices_next RENAME TO model_prices;

-- match_kind and the bookkeeping timestamps are not part of a price: a sync that
-- only re-labels how a model was found must not mint a version.
CREATE TRIGGER price_version_on_insert AFTER INSERT ON model_prices
BEGIN
 INSERT INTO model_price_versions(model, effective_from_ms, available, prompt_price_per_1m, completion_price_per_1m, cache_read_price_per_1m, cache_write_price_per_1m, price_multiplier, source, tiers_json, upstream_id)
 VALUES (NEW.model, CAST(unixepoch('subsec') * 1000 AS INTEGER), 1, NEW.prompt_price_per_1m, NEW.completion_price_per_1m, NEW.cache_read_price_per_1m, NEW.cache_write_price_per_1m, NEW.price_multiplier, NEW.source, NEW.tiers_json, NEW.upstream_id);
END;
CREATE TRIGGER price_version_on_update AFTER UPDATE ON model_prices
WHEN OLD.prompt_price_per_1m IS NOT NEW.prompt_price_per_1m OR OLD.completion_price_per_1m IS NOT NEW.completion_price_per_1m
 OR OLD.cache_read_price_per_1m IS NOT NEW.cache_read_price_per_1m OR OLD.cache_write_price_per_1m IS NOT NEW.cache_write_price_per_1m
 OR OLD.price_multiplier IS NOT NEW.price_multiplier OR OLD.source IS NOT NEW.source
 OR OLD.tiers_json IS NOT NEW.tiers_json OR OLD.upstream_id IS NOT NEW.upstream_id
BEGIN
 INSERT INTO model_price_versions(model, effective_from_ms, available, prompt_price_per_1m, completion_price_per_1m, cache_read_price_per_1m, cache_write_price_per_1m, price_multiplier, source, tiers_json, upstream_id)
 VALUES (NEW.model, CAST(unixepoch('subsec') * 1000 AS INTEGER), 1, NEW.prompt_price_per_1m, NEW.completion_price_per_1m, NEW.cache_read_price_per_1m, NEW.cache_write_price_per_1m, NEW.price_multiplier, NEW.source, NEW.tiers_json, NEW.upstream_id);
END;
CREATE TRIGGER price_version_on_delete AFTER DELETE ON model_prices
BEGIN
 INSERT INTO model_price_versions(model, effective_from_ms, available, prompt_price_per_1m, completion_price_per_1m, cache_read_price_per_1m, cache_write_price_per_1m, price_multiplier, source, tiers_json, upstream_id)
 VALUES (OLD.model, CAST(unixepoch('subsec') * 1000 AS INTEGER), 0, OLD.prompt_price_per_1m, OLD.completion_price_per_1m, OLD.cache_read_price_per_1m, OLD.cache_write_price_per_1m, OLD.price_multiplier, OLD.source, OLD.tiers_json, OLD.upstream_id);
END;

-- The sync schedule is the only operator setting in the old bookkeeping row; the
-- rest described models.dev and would misreport the new source's history.
CREATE TABLE pricing_sync_state_next (
    source TEXT PRIMARY KEY CHECK (source = 'openrouter'),
    running INTEGER NOT NULL DEFAULT 0 CHECK (running IN (0, 1)),
    last_success_at_ms INTEGER,
    last_error TEXT NOT NULL DEFAULT '',
    last_matched INTEGER NOT NULL DEFAULT 0,
    last_unmatched INTEGER NOT NULL DEFAULT 0,
    updated_at_ms INTEGER NOT NULL,
    auto_sync_interval_hours INTEGER NOT NULL DEFAULT 24 CHECK (auto_sync_interval_hours BETWEEN 0 AND 168)
);
INSERT INTO pricing_sync_state_next (source, updated_at_ms, auto_sync_interval_hours)
SELECT 'openrouter', CAST(unixepoch('subsec') * 1000 AS INTEGER),
    CASE WHEN typeof(auto_sync_interval_hours) = 'integer' AND auto_sync_interval_hours BETWEEN 0 AND 168
         THEN auto_sync_interval_hours ELSE 24 END
FROM pricing_sync_state WHERE source = 'modelsdev';
DROP TABLE pricing_sync_state;
ALTER TABLE pricing_sync_state_next RENAME TO pricing_sync_state;

-- An operator's pin of a CPA model to one OpenRouter model. Syncs follow it
-- instead of matching; catalog pruning never removes it.
CREATE TABLE pricing_model_links (
    model TEXT PRIMARY KEY CHECK (length(model) BETWEEN 1 AND 512),
    upstream_id TEXT NOT NULL CHECK (length(upstream_id) BETWEEN 1 AND 256),
    updated_at_ms INTEGER NOT NULL
);

-- The last complete OpenRouter download, kept so the console's model picker and
-- catalog reconciliation work offline and cost OpenRouter nothing.
CREATE TABLE pricing_upstream_catalog (
    id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 256),
    canonical_slug TEXT NOT NULL DEFAULT '',
    name TEXT NOT NULL DEFAULT '',
    author TEXT NOT NULL DEFAULT '',
    context_length INTEGER NOT NULL DEFAULT 0,
    prompt_price_per_1m REAL NOT NULL CHECK (prompt_price_per_1m >= 0),
    completion_price_per_1m REAL NOT NULL CHECK (completion_price_per_1m >= 0),
    cache_read_price_per_1m REAL NOT NULL CHECK (cache_read_price_per_1m >= 0),
    cache_write_price_per_1m REAL NOT NULL CHECK (cache_write_price_per_1m >= 0),
    tiers_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tiers_json) AND json_type(tiers_json) = 'array')
);

-- A channel is the CPA provider label a request records (usage_events.provider).
CREATE TABLE pricing_channels (
    channel TEXT PRIMARY KEY CHECK (length(channel) BETWEEN 1 AND 256),
    multiplier REAL NOT NULL CHECK (multiplier > 0 AND multiplier <= 100),
    note TEXT NOT NULL DEFAULT '' CHECK (length(note) <= 512),
    updated_at_ms INTEGER NOT NULL
);

CREATE TABLE pricing_channel_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel TEXT NOT NULL,
    effective_from_ms INTEGER NOT NULL,
    available INTEGER NOT NULL CHECK (available IN (0, 1)),
    multiplier REAL NOT NULL CHECK (multiplier > 0)
);
CREATE INDEX idx_channel_versions_channel_time ON pricing_channel_versions(channel, effective_from_ms DESC, id DESC);
CREATE TRIGGER channel_version_on_insert AFTER INSERT ON pricing_channels
BEGIN
 INSERT INTO pricing_channel_versions(channel, effective_from_ms, available, multiplier)
 VALUES (NEW.channel, CAST(unixepoch('subsec') * 1000 AS INTEGER), 1, NEW.multiplier);
END;
CREATE TRIGGER channel_version_on_update AFTER UPDATE ON pricing_channels
WHEN OLD.multiplier IS NOT NEW.multiplier
BEGIN
 INSERT INTO pricing_channel_versions(channel, effective_from_ms, available, multiplier)
 VALUES (NEW.channel, CAST(unixepoch('subsec') * 1000 AS INTEGER), 1, NEW.multiplier);
END;
CREATE TRIGGER channel_version_on_delete AFTER DELETE ON pricing_channels
BEGIN
 INSERT INTO pricing_channel_versions(channel, effective_from_ms, available, multiplier)
 VALUES (OLD.channel, CAST(unixepoch('subsec') * 1000 AS INTEGER), 0, OLD.multiplier);
END;
CREATE TRIGGER channel_versions_no_update BEFORE UPDATE ON pricing_channel_versions
BEGIN SELECT RAISE(ABORT, 'channel versions are immutable'); END;
CREATE TRIGGER channel_versions_no_delete BEFORE DELETE ON pricing_channel_versions
BEGIN SELECT RAISE(ABORT, 'channel versions are immutable'); END;

-- channel_version_id is NULL when no multiplier governed the request (1x);
-- price_tier is NULL when the base rates applied.
ALTER TABLE usage_events ADD COLUMN channel_version_id INTEGER REFERENCES pricing_channel_versions(id);
ALTER TABLE usage_events ADD COLUMN price_tier INTEGER;

DROP TRIGGER usage_cost_no_reprice;
CREATE TRIGGER usage_cost_no_reprice BEFORE UPDATE OF cost_nanos, price_version_id, pricing_status, channel_version_id, price_tier ON usage_events
WHEN OLD.cost_nanos IS NOT NEW.cost_nanos OR OLD.price_version_id IS NOT NEW.price_version_id OR OLD.pricing_status IS NOT NEW.pricing_status
 OR OLD.channel_version_id IS NOT NEW.channel_version_id OR OLD.price_tier IS NOT NEW.price_tier
BEGIN SELECT RAISE(ABORT, 'request pricing is immutable'); END;
