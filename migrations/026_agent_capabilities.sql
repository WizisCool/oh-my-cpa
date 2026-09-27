CREATE TABLE agent_documents (
    kind TEXT NOT NULL CHECK (kind IN ('session', 'operation')),
    id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    ciphertext BLOB NOT NULL,
    nonce BLOB NOT NULL,
    expires_at_ms INTEGER NOT NULL,
    PRIMARY KEY (kind, id)
);
CREATE INDEX agent_documents_expiry ON agent_documents(expires_at_ms);
