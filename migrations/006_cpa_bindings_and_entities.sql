-- CPA Bindings and domain entities (Stage 5)
-- Establishes durable runtime binding mappings and stable connection references.

CREATE TABLE IF NOT EXISTS cpa_bindings (
    id TEXT PRIMARY KEY,
    instance_id TEXT NOT NULL REFERENCES cpa_instances(id) ON DELETE CASCADE,
    resource_id TEXT REFERENCES discovered_resources(id) ON DELETE SET NULL,
    cpa_resource_type TEXT NOT NULL,
    cpa_auth_index TEXT NOT NULL DEFAULT '',
    binding_fingerprint TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    first_seen_at_ms INTEGER NOT NULL,
    last_seen_at_ms INTEGER NOT NULL,
    missing_at_ms INTEGER,
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL,
    UNIQUE(instance_id, cpa_resource_type, binding_fingerprint)
);

CREATE INDEX IF NOT EXISTS idx_cpa_bindings_auth_index
    ON cpa_bindings(instance_id, cpa_auth_index);
CREATE INDEX IF NOT EXISTS idx_cpa_bindings_resource
    ON cpa_bindings(resource_id);

CREATE TABLE IF NOT EXISTS connections (
    id TEXT PRIMARY KEY,
    source_name TEXT NOT NULL DEFAULT '',
    display_name TEXT NOT NULL,
    custom_name TEXT,
    icon_ref TEXT,
    color TEXT,
    notes TEXT,
    status TEXT NOT NULL DEFAULT 'unclaimed',
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_connections_status
    ON connections(status);
