-- The operator's request-record retention, chosen in the console. No row means
-- the deployment still follows OMCPA_USAGE_RETENTION_DAYS; zero keeps every
-- record. payload_days is set only through the API: NULL keeps following
-- OMCPA_USAGE_INBOX_RETENTION_DAYS, and zero follows the request records.
CREATE TABLE usage_retention_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    request_record_days INTEGER NOT NULL CHECK (request_record_days BETWEEN 0 AND 3650),
    payload_days INTEGER CHECK (payload_days IS NULL OR payload_days BETWEEN 0 AND 3650),
    updated_at_ms INTEGER NOT NULL
);
