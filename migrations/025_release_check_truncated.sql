-- Adds the truncation flag the release checker records.
--
-- The column records whether a release-feed walk stopped at its page limit with more releases
-- available, so the page can state that the interval it shows is not fully known rather than
-- presenting a partial range as the whole story.
--
-- Why the column is added by a Go hook rather than by an `ALTER TABLE` here: this migration has
-- to survive two different histories. A deployment that applied the original
-- `024_release_index.sql` has the table without the column, and an `ALTER TABLE ... ADD COLUMN`
-- repairs it. A database created while the column briefly lived inside 024 already has it, and
-- the same statement fails with `duplicate column name: truncated` - which would abort the whole
-- migration transaction and stop the process from starting. SQLite has no
-- `ADD COLUMN IF NOT EXISTS`, so the statement cannot carry the condition itself.
--
-- The hook therefore asks the schema whether the column exists and adds it only when it does
-- not. It cannot be expressed here, so this file states the table the hook expects to find and
-- carries the reasoning a reader would otherwise look for in the Go source.

SELECT 1 FROM release_check_state LIMIT 0;
