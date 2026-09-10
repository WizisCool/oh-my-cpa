-- Supports instance-scoped range scans, cursor pagination and endpoint seeks.
CREATE INDEX IF NOT EXISTS idx_usage_events_instance_time
    ON usage_events(instance_id, timestamp_ms DESC, id DESC);
