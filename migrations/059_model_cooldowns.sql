ALTER TABLE error_events ADD COLUMN auth_quota_aggregate INTEGER NOT NULL DEFAULT 0;
ALTER TABLE error_events ADD COLUMN model_quota_inherited INTEGER NOT NULL DEFAULT 0;
ALTER TABLE error_events ADD COLUMN cooldown_model TEXT NOT NULL DEFAULT '';
ALTER TABLE error_events ADD COLUMN model_quota_exceeded INTEGER NOT NULL DEFAULT 0;
ALTER TABLE error_events ADD COLUMN model_quota_reason TEXT NOT NULL DEFAULT '';
ALTER TABLE error_events ADD COLUMN model_next_retry_after_ms INTEGER;
ALTER TABLE error_events ADD COLUMN model_next_recover_at_ms INTEGER;
ALTER TABLE error_events ADD COLUMN model_backoff_level INTEGER NOT NULL DEFAULT 0;
