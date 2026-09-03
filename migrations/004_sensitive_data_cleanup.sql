-- Sensitive-data governance and append-only operator audit.
-- This migration is additive. Historical values are normalized by the Go
-- governance hook in the same migration transaction after these columns exist.

ALTER TABLE usage_events ADD COLUMN api_group_label TEXT NOT NULL DEFAULT '';
ALTER TABLE usage_inboxes ADD COLUMN raw_message_ciphertext BLOB;
ALTER TABLE usage_inboxes ADD COLUMN raw_message_nonce BLOB;

CREATE TABLE IF NOT EXISTS audit_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    occurred_at_ms INTEGER NOT NULL,
    action TEXT NOT NULL,
    target_type TEXT NOT NULL,
    target_id TEXT NOT NULL DEFAULT '',
    result TEXT NOT NULL,
    request_id TEXT NOT NULL DEFAULT '',
    source_summary TEXT NOT NULL DEFAULT '',
    details_json TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_audit_events_time
    ON audit_events(occurred_at_ms DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_audit_events_action_time
    ON audit_events(action, occurred_at_ms DESC, id DESC);

-- JSON1 is checked before this script executes. Remove the known historical
-- credential paths immediately; the Go hook applies the same allowlist to all
-- stored and malformed values.
UPDATE discovered_resources
SET details_json = json_remove(
    CASE WHEN json_valid(details_json) THEN details_json ELSE '{}' END,
    '$.account', '$.api_key', '$.token', '$.access_token', '$.refresh_token',
    '$.password', '$.secret', '$.extra.account', '$.extra.api_key',
    '$.extra.token', '$.extra.access_token', '$.extra.refresh_token',
    '$.extra.password', '$.extra.secret', '$.extra.proxy_url'
)
WHERE details_json IS NOT NULL AND details_json <> '';
