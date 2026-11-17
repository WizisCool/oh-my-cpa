-- Early development builds recorded migration 067 before the client_agent
-- index/backfill and additive usage_facts_* partition columns landed. The Go
-- hook inspects the live schema and repairs any missing columns, index, and
-- historical partitions idempotently.
SELECT 1 FROM usage_events LIMIT 0;
