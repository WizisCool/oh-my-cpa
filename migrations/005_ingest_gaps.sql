-- Ingest gaps: durable tracking of collector coverage and pop-vs-write failures.
--
-- CPA's queue is popped destructively over HTTP/RESP. When an inbox write to
-- SQLite fails, the remote records are gone. Recording the gap range and
-- estimated count ensures coverage loss is durable, observable, and auditable
-- across restarts.
CREATE TABLE IF NOT EXISTS ingest_gaps (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    instance_id TEXT NOT NULL REFERENCES cpa_instances(id) ON DELETE CASCADE,
    source_mode TEXT NOT NULL,
    started_at_ms INTEGER NOT NULL,
    ended_at_ms INTEGER NOT NULL,
    estimated_count INTEGER NOT NULL DEFAULT 0,
    reason_code TEXT NOT NULL,
    summary TEXT NOT NULL DEFAULT '',
    acknowledged_at_ms INTEGER
);

CREATE INDEX IF NOT EXISTS idx_ingest_gaps_instance
    ON ingest_gaps(instance_id, started_at_ms DESC);
