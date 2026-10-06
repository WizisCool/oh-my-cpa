-- Permanent usage facts: what the dashboard reads once request records have
-- rolled out of retention.
--
-- The hourly and daily overview rollups were deleted at the same horizon as the
-- detail rows and carried neither cost nor provider, so every panel except the
-- KPI tiles had to read usage_events and lost its history with them. These two
-- tables carry every dimension and measure a dashboard panel asks for and are
-- never pruned.
--
-- The fine grain is fifteen minutes because every civil UTC offset in use is a
-- multiple of fifteen minutes: a local calendar day is then a whole number of
-- buckets in any deployment timezone, which an hourly bucket cannot offer
-- (+05:30, +05:45). The daily grain keeps a multi-year window cheap to total.
--
-- Both grains are folded in one transaction under one checkpoint, so they always
-- cover exactly the same set of event ids. That is what lets a read combine
-- whole days from the daily table, the remainder from the fifteen-minute table
-- and everything past the checkpoint from usage_events without counting an
-- event twice.
--
-- WITHOUT ROWID makes the primary key the table: a window is one range scan over
-- (instance_id, bucket_start_ms) with no second lookup.
CREATE TABLE usage_facts_15m (
    instance_id TEXT NOT NULL,
    bucket_start_ms INTEGER NOT NULL,
    api_group_key TEXT NOT NULL DEFAULT '',
    model TEXT NOT NULL DEFAULT '',
    model_alias TEXT NOT NULL DEFAULT '',
    auth_index TEXT NOT NULL DEFAULT '',
    provider TEXT NOT NULL DEFAULT '',
    auth_type TEXT NOT NULL DEFAULT '',
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
    -- Sum of request-time cost snapshots. A request's cost is immutable once
    -- stored (usage_cost_no_reprice), so the sum never needs recomputing.
    cost_nanos INTEGER NOT NULL DEFAULT 0,
    -- Requests whose pricing_status is 'priced'; the rest of `requests` had no
    -- usable price at request time.
    priced_requests INTEGER NOT NULL DEFAULT 0,
    -- Requests that carry a stored cost, which is what a per-model spend is
    -- reported against.
    costed_requests INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (instance_id, bucket_start_ms, api_group_key, model, model_alias, auth_index, provider, auth_type)
) WITHOUT ROWID;

-- Serves the dashboard's single-client-key filter without scanning every key.
CREATE INDEX idx_usage_facts_15m_group
    ON usage_facts_15m(instance_id, api_group_key, bucket_start_ms);

CREATE TABLE usage_facts_daily (
    instance_id TEXT NOT NULL,
    bucket_start_ms INTEGER NOT NULL,
    api_group_key TEXT NOT NULL DEFAULT '',
    model TEXT NOT NULL DEFAULT '',
    model_alias TEXT NOT NULL DEFAULT '',
    auth_index TEXT NOT NULL DEFAULT '',
    provider TEXT NOT NULL DEFAULT '',
    auth_type TEXT NOT NULL DEFAULT '',
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
    cost_nanos INTEGER NOT NULL DEFAULT 0,
    priced_requests INTEGER NOT NULL DEFAULT 0,
    costed_requests INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (instance_id, bucket_start_ms, api_group_key, model, model_alias, auth_index, provider, auth_type)
) WITHOUT ROWID;

CREATE INDEX idx_usage_facts_daily_group
    ON usage_facts_daily(instance_id, api_group_key, bucket_start_ms);

-- The facts start empty and the maintenance loop folds every stored event into
-- them from id zero. Until it catches up, reads take the unfolded events from
-- usage_events, so totals are exact throughout; retention is gated on the same
-- checkpoint and cannot delete an event the facts have not absorbed.
INSERT INTO usage_aggregation_checkpoints
    (name, last_usage_event_id, created_at_ms, updated_at_ms)
VALUES
    ('facts', 0, unixepoch() * 1000, unixepoch() * 1000);

-- The overview rollups are superseded. Nothing is lost: they never outlived the
-- detail rows they were built from, and those rows are still here to be folded.
DELETE FROM usage_aggregation_checkpoints WHERE name IN ('hourly', 'daily');
DROP TABLE usage_overview_hourly_stats;
DROP TABLE usage_overview_daily_stats;

-- Decoded payloads are deleted a few days after decoding. The existing
-- (status, id) index would make each pass walk every decoded row to learn that
-- none has expired; this one goes straight to the oldest.
CREATE INDEX idx_usage_inboxes_processed_at
    ON usage_inboxes(processed_at) WHERE status = 'processed';

-- What each rolling lifecycle policy has already removed.
--
-- horizon_ms is the instant before which a policy's rows are gone. Reads need it
-- to be exact rather than inferred from the oldest surviving row: a request
-- record that arrives late with an old timestamp would make the oldest row look
-- older than the data that is really still there.
CREATE TABLE data_lifecycle_state (
    policy TEXT PRIMARY KEY,
    horizon_ms INTEGER NOT NULL DEFAULT 0,
    deleted_rows INTEGER NOT NULL DEFAULT 0,
    last_run_at_ms INTEGER
) WITHOUT ROWID;
