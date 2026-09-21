-- Adds the truncation flag the release checker records.
--
-- Why this is a new migration rather than part of 024: 024 was already applied on
-- existing databases when the flag was introduced, so editing 024 would have changed a
-- migration that had already run. SQLite applies a migration once, keyed by version, so
-- the edited file would never be re-read: a fresh database would get the column and an
-- existing one would not, and the queries would then fail only on the deployments that
-- had been running longest. That is the failure this migration exists to repair, and it
-- is why the rule is "forward-only" (`docs/ops/sqlite-operations.md`).
--
-- The column records whether a release-feed walk stopped at its page limit with more
-- releases available. The page states that the interval it shows is not fully known
-- rather than presenting a partial range as the whole story.

ALTER TABLE release_check_state ADD COLUMN truncated INTEGER NOT NULL DEFAULT 0;
