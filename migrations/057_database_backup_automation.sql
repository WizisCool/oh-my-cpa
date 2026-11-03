-- The envelope includes the backup passphrase and cloud credentials. It is kept
-- apart from preferences and ordinary read-only SQL projections.
CREATE TABLE database_backup_automation (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    ciphertext BLOB NOT NULL,
    nonce BLOB NOT NULL
);
