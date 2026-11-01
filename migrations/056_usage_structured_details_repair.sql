-- Plugin development databases recorded versions 053–055 without the structured
-- usage column. The Go hook checks the actual schema and applies 053's column
-- and immutability trigger only when missing; SQLite has no ADD COLUMN IF NOT EXISTS.
SELECT 1 FROM usage_events LIMIT 0;
