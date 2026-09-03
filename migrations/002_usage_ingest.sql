-- Usage ingestion: durable capture of CPA usage and error events.
--
-- All timestamps in these tables are epoch MILLISECONDS (CPA reports
-- sub-second request times and the dashboard buckets by minute), unlike the
-- older tables which store unixepoch() seconds.
--
-- Pipeline shape (mirrors cpa-usage-keeper):
--   pop from CPA  ->  usage_inboxes (raw, durable write immediately following pop; tracked via ingest_gaps on write failure)
--   inbox         ->  usage_events  (typed, decode may be retried)
--   usage_events  ->  *_stats       (checkpoint-gated incremental rollup)

-- Stage 1: durable inbox. A payload is persisted the moment it is popped from
-- CPA's destructive queue, so a decode bug or crash can never lose records.
CREATE TABLE IF NOT EXISTS usage_inboxes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    instance_id TEXT NOT NULL REFERENCES cpa_instances(id) ON DELETE CASCADE,
    -- subscribe | resp_pull | http_pull: which collector path produced it.
    source_mode TEXT NOT NULL,
    -- SHA-256 hex of raw_message; only used for diagnostics, never to dedupe
    -- (CPA legitimately emits several usage records for one request).
    message_hash TEXT NOT NULL,
    raw_message TEXT NOT NULL,
    -- pending | processed | failed | discarded
    status TEXT NOT NULL DEFAULT 'pending',
    attempt_count INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    -- event_key of the usage_events row produced from this message.
    event_key TEXT,
    popped_at INTEGER NOT NULL,
    processed_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_usage_inboxes_pending
    ON usage_inboxes(status, id);
CREATE INDEX IF NOT EXISTS idx_usage_inboxes_instance
    ON usage_inboxes(instance_id, id);

-- Stage 2: typed detail. One row per CPA usage record.
CREATE TABLE IF NOT EXISTS usage_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    instance_id TEXT NOT NULL REFERENCES cpa_instances(id) ON DELETE CASCADE,
    -- CPA request_id. Not unique: retries can emit several records per id.
    event_key TEXT NOT NULL,
    -- Groups one logical API target: api_key, else provider, else endpoint.
    api_group_key TEXT NOT NULL,
    provider TEXT NOT NULL DEFAULT '',
    endpoint TEXT NOT NULL DEFAULT '',
    -- Normalized CPA auth type ("apikey" rather than "api_key").
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
    -- Client-facing API key label from CPA, empty for OAuth credentials.
    source TEXT NOT NULL DEFAULT '',
    auth_index TEXT NOT NULL DEFAULT '',
    failed INTEGER NOT NULL DEFAULT 0,
    -- CPA "generate" flag: false marks warm-up/preflight calls with no output.
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
    created_at_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_usage_events_time
    ON usage_events(timestamp_ms DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_usage_events_auth_time
    ON usage_events(auth_index, timestamp_ms DESC);
CREATE INDEX IF NOT EXISTS idx_usage_events_model_time
    ON usage_events(model, timestamp_ms DESC);
CREATE INDEX IF NOT EXISTS idx_usage_events_group_time
    ON usage_events(api_group_key, timestamp_ms DESC);
CREATE INDEX IF NOT EXISTS idx_usage_events_event_key
    ON usage_events(event_key);

-- CPA's errors channel is push-only (no queue), so these rows are best-effort:
-- complete while a subscriber is attached, absent otherwise.
CREATE TABLE IF NOT EXISTS error_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    instance_id TEXT NOT NULL REFERENCES cpa_instances(id) ON DELETE CASCADE,
    event_key TEXT NOT NULL,
    request_id TEXT NOT NULL DEFAULT '',
    provider TEXT NOT NULL DEFAULT '',
    model TEXT NOT NULL DEFAULT '',
    auth_id TEXT NOT NULL DEFAULT '',
    auth_index TEXT NOT NULL DEFAULT '',
    status_code INTEGER NOT NULL DEFAULT 0,
    code TEXT NOT NULL DEFAULT '',
    body TEXT NOT NULL DEFAULT '',
    retryable INTEGER NOT NULL DEFAULT 0,
    -- Credential state snapshot CPA attached to the error.
    auth_status TEXT NOT NULL DEFAULT '',
    auth_disabled INTEGER NOT NULL DEFAULT 0,
    auth_unavailable INTEGER NOT NULL DEFAULT 0,
    quota_exceeded INTEGER NOT NULL DEFAULT 0,
    quota_reason TEXT NOT NULL DEFAULT '',
    next_retry_after_ms INTEGER,
    next_recover_at_ms INTEGER,
    backoff_level INTEGER NOT NULL DEFAULT 0,
    timestamp_ms INTEGER NOT NULL,
    created_at_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_error_events_time
    ON error_events(timestamp_ms DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_error_events_auth_time
    ON error_events(auth_index, timestamp_ms DESC);
-- event_key is derived from the payload hash, so this unique index makes
-- re-delivery idempotent instead of storing the same error twice.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_error_events_key
    ON error_events(event_key);

-- Incremental rollups. Each event contributes to exactly one hourly and one
-- daily bucket, so additive upserts keyed by the bucket tuple are correct as
-- long as the aggregation checkpoint guarantees one pass per event.
CREATE TABLE IF NOT EXISTS usage_overview_hourly_stats (
    bucket_start_ms INTEGER NOT NULL,
    instance_id TEXT NOT NULL,
    api_group_key TEXT NOT NULL DEFAULT '',
    model TEXT NOT NULL DEFAULT '',
    auth_index TEXT NOT NULL DEFAULT '',
    model_alias TEXT NOT NULL DEFAULT '',
    requests INTEGER NOT NULL DEFAULT 0,
    failures INTEGER NOT NULL DEFAULT 0,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    reasoning_tokens INTEGER NOT NULL DEFAULT 0,
    cached_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens INTEGER NOT NULL DEFAULT 0,
    cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
    total_tokens INTEGER NOT NULL DEFAULT 0,
    latency_sum_ms INTEGER NOT NULL DEFAULT 0,
    ttft_sum_ms INTEGER NOT NULL DEFAULT 0,
    ttft_count INTEGER NOT NULL DEFAULT 0,
    updated_at_ms INTEGER NOT NULL,
    UNIQUE(instance_id, bucket_start_ms, api_group_key, model, auth_index, model_alias)
);

CREATE INDEX IF NOT EXISTS idx_usage_hourly_bucket
    ON usage_overview_hourly_stats(bucket_start_ms);
CREATE INDEX IF NOT EXISTS idx_usage_hourly_group_bucket
    ON usage_overview_hourly_stats(api_group_key, bucket_start_ms);

CREATE TABLE IF NOT EXISTS usage_overview_daily_stats (
    bucket_start_ms INTEGER NOT NULL,
    instance_id TEXT NOT NULL,
    api_group_key TEXT NOT NULL DEFAULT '',
    model TEXT NOT NULL DEFAULT '',
    auth_index TEXT NOT NULL DEFAULT '',
    model_alias TEXT NOT NULL DEFAULT '',
    requests INTEGER NOT NULL DEFAULT 0,
    failures INTEGER NOT NULL DEFAULT 0,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    reasoning_tokens INTEGER NOT NULL DEFAULT 0,
    cached_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens INTEGER NOT NULL DEFAULT 0,
    cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
    total_tokens INTEGER NOT NULL DEFAULT 0,
    latency_sum_ms INTEGER NOT NULL DEFAULT 0,
    ttft_sum_ms INTEGER NOT NULL DEFAULT 0,
    ttft_count INTEGER NOT NULL DEFAULT 0,
    updated_at_ms INTEGER NOT NULL,
    UNIQUE(instance_id, bucket_start_ms, api_group_key, model, auth_index, model_alias)
);

CREATE INDEX IF NOT EXISTS idx_usage_daily_bucket
    ON usage_overview_daily_stats(bucket_start_ms);
CREATE INDEX IF NOT EXISTS idx_usage_daily_group_bucket
    ON usage_overview_daily_stats(api_group_key, bucket_start_ms);

-- Aggregation watermark: the highest usage_events.id already folded into the
-- rollups. Kept per grain so a lagging daily pass cannot corrupt hourly.
CREATE TABLE IF NOT EXISTS usage_aggregation_checkpoints (
    name TEXT PRIMARY KEY,
    last_usage_event_id INTEGER NOT NULL DEFAULT 0,
    stats_updated_at_ms INTEGER,
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL
);

INSERT OR IGNORE INTO usage_aggregation_checkpoints
    (name, last_usage_event_id, created_at_ms, updated_at_ms)
VALUES
    ('hourly', 0, unixepoch() * 1000, unixepoch() * 1000),
    ('daily', 0, unixepoch() * 1000, unixepoch() * 1000);
