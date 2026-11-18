-- Index request completion timestamps per credential so quota trend queries can
-- filter by completion time without bounding start times to a fixed lookback.
CREATE INDEX IF NOT EXISTS idx_usage_events_instance_auth_completed
    ON usage_events(instance_id, auth_index, (timestamp_ms + MAX(latency_ms, 0)));
