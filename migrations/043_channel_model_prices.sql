-- Preserve the shared price book and its immutable version ids. Channel overrides
-- join the same history so an ingested request still locks one price version.
ALTER TABLE model_price_versions ADD COLUMN channel TEXT NOT NULL DEFAULT '';
CREATE INDEX idx_price_versions_channel_model_time
 ON model_price_versions(channel, model, effective_from_ms DESC, id DESC);

CREATE TABLE channel_model_prices (
 channel TEXT NOT NULL CHECK (length(channel) BETWEEN 1 AND 256),
 model TEXT NOT NULL CHECK (length(model) BETWEEN 1 AND 512),
 prompt_price_per_1m REAL NOT NULL CHECK (prompt_price_per_1m >= 0),
 completion_price_per_1m REAL NOT NULL CHECK (completion_price_per_1m >= 0),
 cache_read_price_per_1m REAL NOT NULL CHECK (cache_read_price_per_1m >= 0),
 cache_write_price_per_1m REAL NOT NULL CHECK (cache_write_price_per_1m >= 0),
 price_multiplier REAL NOT NULL CHECK (price_multiplier > 0),
 tiers_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tiers_json) AND json_type(tiers_json) = 'array'),
 updated_at_ms INTEGER NOT NULL,
 PRIMARY KEY (channel, model)
);

CREATE TRIGGER channel_model_price_on_insert AFTER INSERT ON channel_model_prices
BEGIN
 INSERT INTO model_price_versions(channel, model, effective_from_ms, available,
 prompt_price_per_1m, completion_price_per_1m, cache_read_price_per_1m, cache_write_price_per_1m,
 price_multiplier, source, tiers_json, upstream_id)
 VALUES(NEW.channel, NEW.model, CAST(unixepoch('subsec') * 1000 AS INTEGER), 1,
 NEW.prompt_price_per_1m, NEW.completion_price_per_1m, NEW.cache_read_price_per_1m, NEW.cache_write_price_per_1m,
 NEW.price_multiplier, 'manual', NEW.tiers_json, '');
END;

CREATE TRIGGER channel_model_price_on_update AFTER UPDATE ON channel_model_prices
WHEN OLD.prompt_price_per_1m IS NOT NEW.prompt_price_per_1m OR OLD.completion_price_per_1m IS NOT NEW.completion_price_per_1m
 OR OLD.cache_read_price_per_1m IS NOT NEW.cache_read_price_per_1m OR OLD.cache_write_price_per_1m IS NOT NEW.cache_write_price_per_1m
 OR OLD.price_multiplier IS NOT NEW.price_multiplier OR OLD.tiers_json IS NOT NEW.tiers_json
BEGIN
 INSERT INTO model_price_versions(channel, model, effective_from_ms, available,
 prompt_price_per_1m, completion_price_per_1m, cache_read_price_per_1m, cache_write_price_per_1m,
 price_multiplier, source, tiers_json, upstream_id)
 VALUES(NEW.channel, NEW.model, CAST(unixepoch('subsec') * 1000 AS INTEGER), 1,
 NEW.prompt_price_per_1m, NEW.completion_price_per_1m, NEW.cache_read_price_per_1m, NEW.cache_write_price_per_1m,
 NEW.price_multiplier, 'manual', NEW.tiers_json, '');
END;

CREATE TRIGGER channel_model_price_on_delete AFTER DELETE ON channel_model_prices
BEGIN
 INSERT INTO model_price_versions(channel, model, effective_from_ms, available,
 prompt_price_per_1m, completion_price_per_1m, cache_read_price_per_1m, cache_write_price_per_1m,
 price_multiplier, source, tiers_json, upstream_id)
 VALUES(OLD.channel, OLD.model, CAST(unixepoch('subsec') * 1000 AS INTEGER), 0,
 OLD.prompt_price_per_1m, OLD.completion_price_per_1m, OLD.cache_read_price_per_1m, OLD.cache_write_price_per_1m,
 OLD.price_multiplier, 'manual', OLD.tiers_json, '');
END;
