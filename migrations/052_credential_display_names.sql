-- Operator-assigned names for OAuth credentials.
--
-- An auth file is identified on every console surface by the account it reports,
-- masked. That tells two of an operator's own accounts apart only by their first
-- letters and domain, and says nothing about what the account is for. This table
-- lets the operator name a credential once and have every surface that reads the
-- auth-file list print that name instead.
--
-- The row is keyed by the auth file name, which is the identity CPA's management
-- API addresses a credential by and which survives a CPA restart; signing the same
-- account in again writes the same file. The runtime `auth_index` is not used: it
-- is CPA's own projection, and request records already reach the file through it.
--
-- The name is Oh My CPA's own metadata, separate from the note CPA stores inside
-- the auth file: the note is free prose, the name is a label. Rows are kept when
-- the credential disappears, like caller-key aliases, so a credential signed in
-- again under the same file keeps its name.
--
-- `version` is monotonic per row so a save prepared against a stale read is
-- rejected instead of overwriting another session's rename.

CREATE TABLE IF NOT EXISTS credential_display_names (
    instance_id TEXT NOT NULL REFERENCES cpa_instances(id) ON DELETE CASCADE,
    file_name TEXT NOT NULL,
    display_name TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL,
    PRIMARY KEY (instance_id, file_name)
);
