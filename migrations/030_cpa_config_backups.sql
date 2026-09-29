-- CPA's configuration file as it was before the first v8 configuration write
-- rewrote it. The document carries upstream credentials and the management
-- secret, so it is stored encrypted with the application cipher.
CREATE TABLE cpa_config_backups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    gateway_url TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,
    revision TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    ciphertext BLOB NOT NULL,
    nonce BLOB NOT NULL
);
CREATE INDEX cpa_config_backups_created ON cpa_config_backups(created_at_ms);
