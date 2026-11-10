-- Proxy URLs can carry credentials, so the complete settings document is encrypted
-- and excluded from ordinary preferences and read-only SQL.
CREATE TABLE outbound_proxy_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    revision INTEGER NOT NULL,
    ciphertext BLOB NOT NULL,
    nonce BLOB NOT NULL
);
