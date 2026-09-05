-- Quota snapshot plan payload
-- Persists the full normalized plan (label, tier, subscription expiry, extra usage)
-- alongside the legacy plan_type/plan_tier columns so renewal times survive restarts.

ALTER TABLE quota_snapshots ADD COLUMN plan_json TEXT;
