-- The evidence a quota window's capacity estimate is measured from: per cycle,
-- the readings that moved the used share, each with the usage recorded from the
-- cycle start until it. Snapshot and request-record retention leave it alone, so
-- an estimate changes only when the credential consumes quota. Pruned on write
-- to a few cycles per window.
CREATE TABLE quota_capacity_cycles (
	auth_index TEXT NOT NULL,
	window_key TEXT NOT NULL,
	cycle_reset_at_ms INTEGER NOT NULL,
	period_hours REAL NOT NULL,
	plan_type TEXT NOT NULL DEFAULT '',
	plan_tier TEXT NOT NULL DEFAULT '',
	points_json TEXT NOT NULL,
	updated_at_ms INTEGER NOT NULL,
	PRIMARY KEY (auth_index, window_key, cycle_reset_at_ms)
);
