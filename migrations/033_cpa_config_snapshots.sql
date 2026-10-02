-- Every configuration write now keeps the stored file first, not only the write
-- that converts a pre-v8 file. Each copy records the layout it was stored in,
-- because only a v8 copy can be written back through the v8 API, and the kind of
-- write it was taken before. Every earlier copy was a pre-v8 file kept before
-- its conversion.
ALTER TABLE cpa_config_backups ADD COLUMN layout TEXT NOT NULL DEFAULT 'legacy';
ALTER TABLE cpa_config_backups ADD COLUMN reason TEXT NOT NULL DEFAULT 'legacy_conversion';

-- How many v8 copies are kept. One row; absent means the default.
CREATE TABLE cpa_config_backup_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    retention INTEGER NOT NULL CHECK (retention BETWEEN 5 AND 100)
);
