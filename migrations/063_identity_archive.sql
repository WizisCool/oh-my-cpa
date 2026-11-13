-- Persistent non-secret presentation archive for providers, OAuth portals, and credentials.
--
-- Request records and usage facts outlive the provider entries, OAuth auth files, and plugins
-- that served them, and CPA omits runtime auth_index values while an OpenAI-compatible provider
-- is disabled. Storing the sanitized display projection (operator names, masked accounts, masked
-- keys, keyed-HMAC key fingerprints, brand icon overrides, and plugin portal metadata) lets every
-- console surface keep naming and drawing disabled, rotated, or deleted identities consistently
-- without persisting raw secrets or unmasked account addresses.

-- Note: ROWID is kept intentionally on archived_credentials so the read-only Agent SQL policy
-- can redact `key_fingerprint` in-place while leaving sanitized presentation columns queryable.
CREATE TABLE IF NOT EXISTS archived_credentials (
    instance_id TEXT NOT NULL REFERENCES cpa_instances(id) ON DELETE CASCADE,
    auth_index TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('oauth', 'apikey')),
    provider_key TEXT NOT NULL DEFAULT '',
    oauth_provider TEXT NOT NULL DEFAULT '',
    provider_family TEXT NOT NULL DEFAULT '',
    provider_name TEXT NOT NULL DEFAULT '',
    upstream_name TEXT NOT NULL DEFAULT '',
    base_url TEXT NOT NULL DEFAULT '',
    icon_id TEXT NOT NULL DEFAULT '',
    file_name TEXT NOT NULL DEFAULT '',
    display_name TEXT NOT NULL DEFAULT '',
    masked_account TEXT NOT NULL DEFAULT '',
    key_mask TEXT NOT NULL DEFAULT '',
    key_fingerprint TEXT NOT NULL DEFAULT '',
    is_ambiguous INTEGER NOT NULL DEFAULT 0 CHECK (is_ambiguous IN (0, 1)),
    updated_at_ms INTEGER NOT NULL,
    PRIMARY KEY (instance_id, auth_index)
);

CREATE TABLE IF NOT EXISTS archived_providers (
    instance_id TEXT NOT NULL REFERENCES cpa_instances(id) ON DELETE CASCADE,
    provider_key TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('ai_provider', 'oauth_plugin')),
    name TEXT NOT NULL DEFAULT '',
    upstream_name TEXT NOT NULL DEFAULT '',
    family TEXT NOT NULL DEFAULT '',
    base_url TEXT NOT NULL DEFAULT '',
    icon_id TEXT NOT NULL DEFAULT '',
    logo TEXT NOT NULL DEFAULT '',
    is_multi_portal INTEGER NOT NULL DEFAULT 0 CHECK (is_multi_portal IN (0, 1)),
    is_plugin_owned INTEGER NOT NULL DEFAULT 0 CHECK (is_plugin_owned IN (0, 1)),
    is_ambiguous INTEGER NOT NULL DEFAULT 0 CHECK (is_ambiguous IN (0, 1)),
    updated_at_ms INTEGER NOT NULL,
    PRIMARY KEY (instance_id, provider_key)
) WITHOUT ROWID;
