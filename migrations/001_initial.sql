CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS cpa_instances (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    base_url TEXT NOT NULL,
    usage_addr TEXT NOT NULL,
    management_key_ciphertext BLOB NOT NULL,
    management_key_nonce BLOB NOT NULL,
    status TEXT NOT NULL DEFAULT 'unknown',
    last_seen_at INTEGER,
    last_error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS discovered_resources (
    id TEXT PRIMARY KEY,
    instance_id TEXT NOT NULL REFERENCES cpa_instances(id) ON DELETE CASCADE,
    resource_key TEXT NOT NULL,
    cpa_resource_type TEXT NOT NULL,
    cpa_auth_index TEXT,
    cpa_resource_name TEXT,
    cpa_driver TEXT NOT NULL,
    protocol_driver TEXT NOT NULL,
    protocol_display TEXT NOT NULL,
    base_url TEXT,
    suggested_source TEXT,
    suggested_plan TEXT,
    details_json TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'unclaimed',
    last_seen_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(instance_id, resource_key)
);

CREATE INDEX IF NOT EXISTS idx_discovered_resources_status
    ON discovered_resources(status);
CREATE INDEX IF NOT EXISTS idx_discovered_resources_instance
    ON discovered_resources(instance_id);
CREATE INDEX IF NOT EXISTS idx_discovered_resources_auth_index
    ON discovered_resources(instance_id, cpa_auth_index);

CREATE TABLE IF NOT EXISTS resource_overrides (
    resource_id TEXT PRIMARY KEY REFERENCES discovered_resources(id) ON DELETE CASCADE,
    display_name TEXT,
    color TEXT,
    icon_ref TEXT,
    notes TEXT,
    updated_at INTEGER NOT NULL
);
