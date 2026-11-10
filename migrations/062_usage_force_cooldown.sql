-- Preserve existing classifications while extending the closed set of CPA failure codes.
ALTER TABLE usage_events RENAME COLUMN fail_code TO previous_fail_code;
ALTER TABLE usage_events ADD COLUMN fail_code TEXT NOT NULL DEFAULT ''
    CHECK (fail_code IN ('', 'request_scoped', 'stream_truncated', 'force_cooldown'));
UPDATE usage_events SET fail_code = previous_fail_code WHERE previous_fail_code <> '';
ALTER TABLE usage_events DROP COLUMN previous_fail_code;
