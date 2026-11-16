-- Normalized caller agent or SDK family resolved at request ingestion from
-- User-Agent and endpoint (internal/usage/client_agent.go). Migration 067's
-- repository hook backfills pre-existing rows so indexed equality filters and
-- read projections agree on historical records.
ALTER TABLE usage_events ADD COLUMN client_agent TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_usage_events_instance_client_time
    ON usage_events(instance_id, client_agent, timestamp_ms DESC, id DESC);

-- Additive per-event normalized token partitions folded alongside vendor counts
-- so Insights Cube, Rhythm, and permanent usage summaries never guess dialects
-- or apply non-linear MAX after SUM when canonical and legacy records share a bucket.
ALTER TABLE usage_facts_15m ADD COLUMN prompt_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE usage_facts_15m ADD COLUMN completion_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE usage_facts_15m ADD COLUMN effective_cache_read_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE usage_facts_15m ADD COLUMN effective_total_tokens INTEGER NOT NULL DEFAULT 0;

ALTER TABLE usage_facts_daily ADD COLUMN prompt_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE usage_facts_daily ADD COLUMN completion_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE usage_facts_daily ADD COLUMN effective_cache_read_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE usage_facts_daily ADD COLUMN effective_total_tokens INTEGER NOT NULL DEFAULT 0;

ALTER TABLE usage_facts_local_daily ADD COLUMN prompt_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE usage_facts_local_daily ADD COLUMN completion_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE usage_facts_local_daily ADD COLUMN effective_cache_read_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE usage_facts_local_daily ADD COLUMN effective_total_tokens INTEGER NOT NULL DEFAULT 0;
