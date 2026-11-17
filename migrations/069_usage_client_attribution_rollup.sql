-- Persist normalized client prefix alongside client_agent so read paths never
-- re-run User-Agent classification, and materialize rolling 15-minute and daily
-- client-attribution fact tables alongside usage_facts_* so Insights client
-- attribution reads pre-aggregated buckets instead of scanning usage_events.
ALTER TABLE usage_events ADD COLUMN client_prefix TEXT NOT NULL DEFAULT '';

CREATE TABLE usage_client_facts_15m (
    instance_id TEXT NOT NULL,
    bucket_start_ms INTEGER NOT NULL,
    api_group_key TEXT NOT NULL DEFAULT '',
    model TEXT NOT NULL DEFAULT '',
    model_alias TEXT NOT NULL DEFAULT '',
    auth_index TEXT NOT NULL DEFAULT '',
    provider TEXT NOT NULL DEFAULT '',
    auth_type TEXT NOT NULL DEFAULT '',
    client_agent TEXT NOT NULL DEFAULT '',
    client_prefix TEXT NOT NULL DEFAULT '',
    retained_requests INTEGER NOT NULL DEFAULT 0,
    requests INTEGER NOT NULL DEFAULT 0,
    failures INTEGER NOT NULL DEFAULT 0,
    prompt_tokens INTEGER NOT NULL DEFAULT 0,
    completion_tokens INTEGER NOT NULL DEFAULT 0,
    reasoning_tokens INTEGER NOT NULL DEFAULT 0,
    effective_cache_read_tokens INTEGER NOT NULL DEFAULT 0,
    cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
    effective_total_tokens INTEGER NOT NULL DEFAULT 0,
    latency_sum_ms INTEGER NOT NULL DEFAULT 0,
    ttft_sum_ms INTEGER NOT NULL DEFAULT 0,
    ttft_count INTEGER NOT NULL DEFAULT 0,
    cost_nanos INTEGER NOT NULL DEFAULT 0,
    priced_requests INTEGER NOT NULL DEFAULT 0,
    costed_requests INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (instance_id, bucket_start_ms, api_group_key, model, model_alias, auth_index, provider, auth_type, client_agent, client_prefix)
);

CREATE INDEX idx_usage_client_facts_15m_group
    ON usage_client_facts_15m(instance_id, api_group_key, bucket_start_ms);

CREATE INDEX idx_usage_client_facts_15m_bucket
    ON usage_client_facts_15m(bucket_start_ms);

CREATE TABLE usage_client_facts_daily (
    instance_id TEXT NOT NULL,
    bucket_start_ms INTEGER NOT NULL,
    api_group_key TEXT NOT NULL DEFAULT '',
    model TEXT NOT NULL DEFAULT '',
    model_alias TEXT NOT NULL DEFAULT '',
    auth_index TEXT NOT NULL DEFAULT '',
    provider TEXT NOT NULL DEFAULT '',
    auth_type TEXT NOT NULL DEFAULT '',
    client_agent TEXT NOT NULL DEFAULT '',
    client_prefix TEXT NOT NULL DEFAULT '',
    retained_requests INTEGER NOT NULL DEFAULT 0,
    requests INTEGER NOT NULL DEFAULT 0,
    failures INTEGER NOT NULL DEFAULT 0,
    prompt_tokens INTEGER NOT NULL DEFAULT 0,
    completion_tokens INTEGER NOT NULL DEFAULT 0,
    reasoning_tokens INTEGER NOT NULL DEFAULT 0,
    effective_cache_read_tokens INTEGER NOT NULL DEFAULT 0,
    cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
    effective_total_tokens INTEGER NOT NULL DEFAULT 0,
    latency_sum_ms INTEGER NOT NULL DEFAULT 0,
    ttft_sum_ms INTEGER NOT NULL DEFAULT 0,
    ttft_count INTEGER NOT NULL DEFAULT 0,
    cost_nanos INTEGER NOT NULL DEFAULT 0,
    priced_requests INTEGER NOT NULL DEFAULT 0,
    costed_requests INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (instance_id, bucket_start_ms, api_group_key, model, model_alias, auth_index, provider, auth_type, client_agent, client_prefix)
);

CREATE INDEX idx_usage_client_facts_daily_group
    ON usage_client_facts_daily(instance_id, api_group_key, bucket_start_ms);

CREATE INDEX idx_usage_client_facts_daily_bucket
    ON usage_client_facts_daily(bucket_start_ms);
