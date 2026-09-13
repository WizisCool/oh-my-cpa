-- Operator-assigned names for gateway client API keys.
--
-- The request list identifies a caller by `usage_events.api_key_mask`, which is a
-- recognisable but unreadable label (`sk-5Yalm……………odar`) and, worse, ambiguous:
-- a mask preserves only a short head and tail, so two different keys can share
-- one. This table lets the operator name a key once and have every request
-- surface show that name.
--
-- The row is keyed by the same keyed fingerprint the usage records already carry
-- (`usage_events.api_group_key`, produced with the "usage-api-key" purpose), not
-- by a configuration array index and not by the mask. An array index is not an
-- identity - reordering CPA's `api-keys` list would silently move one key's name
-- onto another - and a mask is not unique. The fingerprint is the only value that
-- survives reordering, a rename of the surrounding configuration, and a restart.
--
-- No raw key material is stored here. The secret lives in CPA's configuration
-- document, which is where CPA reads it from; this table only records what the
-- operator calls it.
--
-- Rows are deliberately not deleted when a key disappears from CPA's
-- configuration. Historical requests keep their `api_group_key` forever, so
-- removing the alias on deletion would strip the name from exactly the records an
-- operator is trying to interpret. An alias is a property of the identity, not of
-- the current configuration.
--
-- `version` is monotonic per row so a save can be rejected when it was prepared
-- against a stale read, the same conflict protection the configuration editor
-- gives its own writes.

CREATE TABLE IF NOT EXISTS client_key_aliases (
    instance_id TEXT NOT NULL REFERENCES cpa_instances(id) ON DELETE CASCADE,
    -- Keyed fingerprint of the client key, matching usage_events.api_group_key.
    key_fingerprint TEXT NOT NULL,
    alias TEXT NOT NULL,
    -- Bumped on every change; a writer supplies the version it read.
    version INTEGER NOT NULL DEFAULT 1,
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL,
    PRIMARY KEY (instance_id, key_fingerprint)
);

-- The list view resolves a whole page of fingerprints in one IN lookup, which the
-- primary key already serves. This index answers the reverse question the
-- management page asks: the aliases for one instance, to render the key table.
CREATE INDEX IF NOT EXISTS idx_client_key_aliases_instance
    ON client_key_aliases(instance_id, updated_at_ms DESC);
