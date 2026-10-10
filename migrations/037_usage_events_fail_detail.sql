-- The failure CPA publishes on each usage record: the HTTP status the request
-- ended with and the upstream's own error body. A failed request is diagnosed
-- from these, because CPA keeps a per-request log file only while request
-- logging is on (otherwise just its newest few error logs).
--
-- 0 and '' mean unknown: a successful request, a CPA build that published no
-- failure, or a record ingested before these columns existed, which cannot be
-- backfilled because the queue record was never stored.
ALTER TABLE usage_events ADD COLUMN fail_status_code INTEGER NOT NULL DEFAULT 0;
ALTER TABLE usage_events ADD COLUMN fail_body TEXT NOT NULL DEFAULT '';
