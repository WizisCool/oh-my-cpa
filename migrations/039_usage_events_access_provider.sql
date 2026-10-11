-- Which access path served the request and whether a native (API-key)
-- credential served it, from CPA's usage record: newer gateways propagate the
-- authenticated API key, the access provider and the native-key flag into each
-- record, with automatic fallback resolution when the record omits them.
--
-- Empty and 0 mean unknown: an older CPA build that published neither, or a
-- record ingested before these columns existed, which cannot be backfilled
-- because the queue record was never stored.
ALTER TABLE usage_events ADD COLUMN access_provider TEXT NOT NULL DEFAULT '';
ALTER TABLE usage_events ADD COLUMN is_native_key INTEGER NOT NULL DEFAULT 0;
