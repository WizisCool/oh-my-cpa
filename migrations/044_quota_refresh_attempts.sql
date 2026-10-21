-- Quota refresh attempts
-- A failed read never replaces a stored observation: the last good reading stays, and the
-- snapshot table is the record of readings rather than of tries. Without a record of the try
-- itself the console could only report a failure in the toast the operator happened to see,
-- and would keep presenting a reading days old as current. One row per credential, holding
-- the most recent attempt; a successful attempt overwrites the failure it followed.

CREATE TABLE IF NOT EXISTS quota_refresh_attempts (
    auth_index TEXT PRIMARY KEY,
    attempted_at_ms INTEGER NOT NULL,
    outcome TEXT NOT NULL CHECK(outcome IN ('succeeded','failed')),
    error TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_quota_refresh_attempts_attempted
    ON quota_refresh_attempts(attempted_at_ms);
