-- Order the request list by recording order rather than request time.
--
-- CPA reports the time a request *started*. An agent request can run for
-- minutes, so a record that the collector has just written carries a timestamp
-- older than requests that started after it — and ordering by timestamp buries
-- the newest record in the middle of the list, which makes the live view look
-- stuck. Ordering by the row id puts whatever was recorded last at the top.
--
-- The index is what keeps that order cheap: without it SQLite satisfies the
-- instance/time filter from idx_usage_events_instance_time and then sorts every
-- matching row in a temp B-tree (measured 22 ms against 200k rows, versus ~0.1
-- ms with this index). `id` is the rowid alias, so the index also serves the
-- keyset cursor (`WHERE instance_id = ? AND id < ?`).
CREATE INDEX IF NOT EXISTS idx_usage_events_instance_id
    ON usage_events(instance_id, id DESC);
