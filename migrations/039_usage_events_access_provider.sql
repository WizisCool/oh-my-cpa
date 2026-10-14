-- CPA reports the access provider that authenticated the caller and whether
-- the caller used a native configured API key, independently of the upstream
-- credential that executed the request.
--
-- Empty access_provider means unknown for older gateways and historical rows
-- that cannot be backfilled because the queue record was never stored.
-- is_native_key = 0 means unknown only when access_provider is empty; with a
-- nonempty access_provider it means the caller did not use a native key.
ALTER TABLE usage_events ADD COLUMN access_provider TEXT NOT NULL DEFAULT '';
ALTER TABLE usage_events ADD COLUMN is_native_key INTEGER NOT NULL DEFAULT 0;
