-- Model membership must be published atomically with the authoritative catalog.
ALTER TABLE pricing_catalog_state ADD COLUMN providers_json TEXT NOT NULL DEFAULT '[]';
