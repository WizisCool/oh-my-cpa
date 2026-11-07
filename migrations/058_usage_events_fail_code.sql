-- Keep only explicit request-level classifications; historical records stay unknown.
ALTER TABLE usage_events ADD COLUMN fail_code TEXT NOT NULL DEFAULT ''
    CHECK (fail_code IN ('', 'request_scoped', 'stream_truncated'));
