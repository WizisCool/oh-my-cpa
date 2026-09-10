-- Existing requests have no recoverable historical rate. Never backfill them.
CREATE TABLE model_price_versions (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 model TEXT NOT NULL,
 effective_from_ms INTEGER NOT NULL,
 available INTEGER NOT NULL CHECK (available IN (0,1)),
 prompt_price_per_1m REAL NOT NULL,
 completion_price_per_1m REAL NOT NULL,
 cache_read_price_per_1m REAL NOT NULL,
 cache_write_price_per_1m REAL NOT NULL,
 price_multiplier REAL NOT NULL,
 source TEXT NOT NULL
);
CREATE INDEX idx_price_versions_model_time ON model_price_versions(model, effective_from_ms DESC, id DESC);
INSERT INTO model_price_versions(model, effective_from_ms, available, prompt_price_per_1m, completion_price_per_1m, cache_read_price_per_1m, cache_write_price_per_1m, price_multiplier, source)
 SELECT model, CAST(unixepoch('subsec') * 1000 AS INTEGER), 1, prompt_price_per_1m, completion_price_per_1m, cache_read_price_per_1m, cache_write_price_per_1m, price_multiplier, source FROM model_prices;
CREATE TRIGGER price_version_on_insert AFTER INSERT ON model_prices

BEGIN
 INSERT INTO model_price_versions(model, effective_from_ms, available, prompt_price_per_1m, completion_price_per_1m, cache_read_price_per_1m, cache_write_price_per_1m, price_multiplier, source)
 VALUES (NEW.model, CAST(unixepoch('subsec') * 1000 AS INTEGER), 1, NEW.prompt_price_per_1m, NEW.completion_price_per_1m, NEW.cache_read_price_per_1m, NEW.cache_write_price_per_1m, NEW.price_multiplier, NEW.source);
END;
CREATE TRIGGER price_version_on_update AFTER UPDATE ON model_prices
WHEN OLD.prompt_price_per_1m IS NOT NEW.prompt_price_per_1m OR OLD.completion_price_per_1m IS NOT NEW.completion_price_per_1m OR OLD.cache_read_price_per_1m IS NOT NEW.cache_read_price_per_1m OR OLD.cache_write_price_per_1m IS NOT NEW.cache_write_price_per_1m OR OLD.price_multiplier IS NOT NEW.price_multiplier OR OLD.source IS NOT NEW.source
BEGIN
 INSERT INTO model_price_versions(model, effective_from_ms, available, prompt_price_per_1m, completion_price_per_1m, cache_read_price_per_1m, cache_write_price_per_1m, price_multiplier, source)
 VALUES (NEW.model, CAST(unixepoch('subsec') * 1000 AS INTEGER), 1, NEW.prompt_price_per_1m, NEW.completion_price_per_1m, NEW.cache_read_price_per_1m, NEW.cache_write_price_per_1m, NEW.price_multiplier, NEW.source);
END;
CREATE TRIGGER price_version_on_delete AFTER DELETE ON model_prices

BEGIN
 INSERT INTO model_price_versions(model, effective_from_ms, available, prompt_price_per_1m, completion_price_per_1m, cache_read_price_per_1m, cache_write_price_per_1m, price_multiplier, source)
 VALUES (OLD.model, CAST(unixepoch('subsec') * 1000 AS INTEGER), 0, OLD.prompt_price_per_1m, OLD.completion_price_per_1m, OLD.cache_read_price_per_1m, OLD.cache_write_price_per_1m, OLD.price_multiplier, OLD.source);
END;
CREATE TRIGGER price_versions_no_update BEFORE UPDATE ON model_price_versions
BEGIN SELECT RAISE(ABORT, 'price versions are immutable'); END;
CREATE TRIGGER price_versions_no_delete BEFORE DELETE ON model_price_versions
BEGIN SELECT RAISE(ABORT, 'price versions are immutable'); END;

ALTER TABLE usage_events ADD COLUMN cost_nanos INTEGER CHECK(cost_nanos IS NULL OR cost_nanos >= 0);
ALTER TABLE usage_events ADD COLUMN price_version_id INTEGER REFERENCES model_price_versions(id);
ALTER TABLE usage_events ADD COLUMN pricing_status TEXT NOT NULL DEFAULT 'legacy_unpriced'
 CHECK(pricing_status IN ('priced','unpriced','legacy_unpriced','invalid_price'));
CREATE TRIGGER usage_cost_no_reprice BEFORE UPDATE OF cost_nanos, price_version_id, pricing_status ON usage_events
WHEN OLD.cost_nanos IS NOT NEW.cost_nanos OR OLD.price_version_id IS NOT NEW.price_version_id OR OLD.pricing_status IS NOT NEW.pricing_status
BEGIN SELECT RAISE(ABORT, 'request pricing is immutable'); END;
