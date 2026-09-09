-- Repair pricing sync state written by the first revision of the models.dev
-- sync. Its upsert passed the source name for a placeholder inside the
-- DO UPDATE clause, so every repeat sync stored TEXT 'modelsdev' in the
-- INTEGER column last_success_at_ms, and SQLite accepted it because column
-- types are advisory. The state then became unreadable and the pricing page
-- failed to load. NULL simply means "no recorded success"; the next sync
-- rewrites the row correctly.
UPDATE pricing_sync_state
SET last_success_at_ms = NULL
WHERE last_success_at_ms IS NOT NULL AND typeof(last_success_at_ms) <> 'integer';

UPDATE pricing_sync_state
SET last_matched = 0
WHERE typeof(last_matched) <> 'integer';

UPDATE pricing_sync_state
SET last_unmatched = 0
WHERE typeof(last_unmatched) <> 'integer';

UPDATE pricing_sync_state
SET updated_at_ms = 0
WHERE typeof(updated_at_ms) <> 'integer';
