-- The model the upstream reported having served, as CPA v8 publishes it in each
-- usage record. Empty means unknown: an upstream that declared nothing, or a
-- record ingested before this column existed, which cannot be backfilled
-- because the response it came from was never stored.
ALTER TABLE usage_events ADD COLUMN response_model TEXT NOT NULL DEFAULT '';

-- Decided once at ingestion (internal/usage/served_model.go) so the list can
-- filter on it without re-deriving a string rule in SQL. 0 covers both "served
-- as requested" and "unknown"; response_model tells the two apart.
ALTER TABLE usage_events ADD COLUMN model_substituted INTEGER NOT NULL DEFAULT 0
    CHECK(model_substituted IN (0, 1));

-- Substitutions are rare, so a partial index keeps "only substituted" cheap
-- without widening every insert.
CREATE INDEX IF NOT EXISTS idx_usage_events_model_substituted
    ON usage_events(instance_id, timestamp_ms DESC, id DESC)
    WHERE model_substituted = 1;
