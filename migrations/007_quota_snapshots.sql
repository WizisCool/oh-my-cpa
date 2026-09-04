-- Quota Snapshots (Stage 7)
-- Persists normalized provider quota observations for audit, history, and transient fallback.

CREATE TABLE IF NOT EXISTS quota_snapshots (
    id TEXT PRIMARY KEY,
    auth_index TEXT NOT NULL,
    provider TEXT NOT NULL,
    status TEXT NOT NULL,
    plan_type TEXT NOT NULL DEFAULT '',
    plan_tier TEXT NOT NULL DEFAULT '',
    windows_json TEXT NOT NULL DEFAULT '[]',
    reset_credits_json TEXT,
    observed_at_ms INTEGER NOT NULL,
    created_at_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_quota_snapshots_auth_observed
    ON quota_snapshots(auth_index, observed_at_ms DESC);

CREATE INDEX IF NOT EXISTS idx_quota_snapshots_observed
    ON quota_snapshots(observed_at_ms);
