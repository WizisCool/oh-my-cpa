-- SQLite cannot widen a column CHECK in place. Preserve every request and its
-- immutable billing evidence while adding the optional final outbound tier.
CREATE TABLE usage_events_next (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    instance_id TEXT NOT NULL REFERENCES cpa_instances(id) ON DELETE CASCADE,
    event_key TEXT NOT NULL,
    api_group_key TEXT NOT NULL,
    provider TEXT NOT NULL DEFAULT '',
    endpoint TEXT NOT NULL DEFAULT '',
    auth_type TEXT NOT NULL DEFAULT '',
    request_id TEXT NOT NULL DEFAULT '',
    client_ip TEXT,
    x_forwarded_for TEXT,
    user_agent TEXT,
    model TEXT NOT NULL DEFAULT 'unknown',
    model_alias TEXT,
    reasoning_effort TEXT NOT NULL DEFAULT '',
    service_tier TEXT NOT NULL DEFAULT '',
    response_service_tier TEXT NOT NULL DEFAULT '',
    executor_type TEXT NOT NULL DEFAULT '',
    timestamp_ms INTEGER NOT NULL,
    source TEXT NOT NULL DEFAULT '',
    auth_index TEXT NOT NULL DEFAULT '',
    failed INTEGER NOT NULL DEFAULT 0,
    generate INTEGER NOT NULL DEFAULT 1,
    latency_ms INTEGER NOT NULL DEFAULT 0,
    ttft_ms INTEGER,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    reasoning_tokens INTEGER NOT NULL DEFAULT 0,
    cached_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens INTEGER NOT NULL DEFAULT 0,
    cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
    total_tokens INTEGER NOT NULL DEFAULT 0,
    created_at_ms INTEGER NOT NULL,
    api_group_label TEXT NOT NULL DEFAULT '',
    api_key_mask TEXT NOT NULL DEFAULT '',
    cost_nanos INTEGER CHECK(cost_nanos IS NULL OR cost_nanos >= 0),
    price_version_id INTEGER REFERENCES model_price_versions(id),
    pricing_status TEXT NOT NULL DEFAULT 'legacy_unpriced'
 CHECK(pricing_status IN ('priced','unpriced','legacy_unpriced','invalid_price')),
    stream INTEGER CHECK(stream IS NULL OR stream IN (0, 1)),
    channel_version_id INTEGER REFERENCES pricing_channel_versions(id),
    price_tier INTEGER,
    response_model TEXT NOT NULL DEFAULT '',
    model_substituted INTEGER NOT NULL DEFAULT 0
    CHECK(model_substituted IN (0, 1)),
    fail_status_code INTEGER NOT NULL DEFAULT 0,
    fail_body TEXT NOT NULL DEFAULT '',
    response_headers TEXT NOT NULL DEFAULT '',
    access_provider TEXT NOT NULL DEFAULT '',
    is_native_key INTEGER NOT NULL DEFAULT 0,
    billed_service_tier TEXT,
    billed_service_tier_source TEXT
    CHECK (billed_service_tier_source IN ('', 'request', 'response', 'outbound'))
    CHECK ((billed_service_tier IS NULL) = (billed_service_tier_source IS NULL))
    CHECK (billed_service_tier = '' OR billed_service_tier_source IN ('request', 'response', 'outbound')),
    effective_service_tier TEXT NOT NULL DEFAULT ''
);

INSERT INTO usage_events_next (
    id, instance_id, event_key, api_group_key, provider,
    endpoint, auth_type, request_id, client_ip, x_forwarded_for,
    user_agent, model, model_alias, reasoning_effort, service_tier,
    response_service_tier, executor_type, timestamp_ms, source, auth_index,
    failed, generate, latency_ms, ttft_ms, input_tokens,
    output_tokens, reasoning_tokens, cached_tokens, cache_read_tokens, cache_creation_tokens,
    total_tokens, created_at_ms, api_group_label, api_key_mask, cost_nanos,
    price_version_id, pricing_status, stream, channel_version_id, price_tier,
    response_model, model_substituted, fail_status_code, fail_body, response_headers,
    access_provider, is_native_key, billed_service_tier, billed_service_tier_source)
SELECT
    id, instance_id, event_key, api_group_key, provider,
    endpoint, auth_type, request_id, client_ip, x_forwarded_for,
    user_agent, model, model_alias, reasoning_effort, service_tier,
    response_service_tier, executor_type, timestamp_ms, source, auth_index,
    failed, generate, latency_ms, ttft_ms, input_tokens,
    output_tokens, reasoning_tokens, cached_tokens, cache_read_tokens, cache_creation_tokens,
    total_tokens, created_at_ms, api_group_label, api_key_mask, cost_nanos,
    price_version_id, pricing_status, stream, channel_version_id, price_tier,
    response_model, model_substituted, fail_status_code, fail_body, response_headers,
    access_provider, is_native_key, billed_service_tier, billed_service_tier_source
FROM usage_events;

-- Retention may have removed the highest id. Keep the AUTOINCREMENT high-water
-- mark so old request links and ingestion cursors can never identify a new row.
UPDATE sqlite_sequence
SET seq = MAX(seq, COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'usage_events'), 0))
WHERE name = 'usage_events_next';
INSERT INTO sqlite_sequence(name, seq)
SELECT 'usage_events_next', seq FROM sqlite_sequence
WHERE name = 'usage_events'
  AND NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = 'usage_events_next');

DROP TABLE usage_events;
ALTER TABLE usage_events_next RENAME TO usage_events;

CREATE INDEX idx_usage_events_auth_time
    ON usage_events(auth_index, timestamp_ms DESC);

CREATE INDEX idx_usage_events_event_key
    ON usage_events(event_key);

CREATE INDEX idx_usage_events_group_time
    ON usage_events(api_group_key, timestamp_ms DESC);

CREATE INDEX idx_usage_events_instance_id
    ON usage_events(instance_id, id DESC);

CREATE INDEX idx_usage_events_instance_time
    ON usage_events(instance_id, timestamp_ms DESC, id DESC);

CREATE INDEX idx_usage_events_model_substituted
    ON usage_events(instance_id, timestamp_ms DESC, id DESC)
    WHERE model_substituted = 1;

CREATE INDEX idx_usage_events_model_time
    ON usage_events(model, timestamp_ms DESC);

CREATE INDEX idx_usage_events_time
    ON usage_events(timestamp_ms DESC, id DESC);

CREATE TRIGGER usage_cost_no_reprice BEFORE UPDATE OF cost_nanos, price_version_id, pricing_status, channel_version_id, price_tier ON usage_events
WHEN OLD.cost_nanos IS NOT NEW.cost_nanos OR OLD.price_version_id IS NOT NEW.price_version_id OR OLD.pricing_status IS NOT NEW.pricing_status
 OR OLD.channel_version_id IS NOT NEW.channel_version_id OR OLD.price_tier IS NOT NEW.price_tier
BEGIN SELECT RAISE(ABORT, 'request pricing is immutable'); END;

CREATE TRIGGER usage_tier_snapshot_no_update
BEFORE UPDATE OF billed_service_tier, billed_service_tier_source ON usage_events
WHEN OLD.billed_service_tier IS NOT NEW.billed_service_tier
  OR OLD.billed_service_tier_source IS NOT NEW.billed_service_tier_source
BEGIN
    SELECT RAISE(ABORT, 'usage service-tier snapshots are immutable');
END;
