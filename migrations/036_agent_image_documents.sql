-- Images attached to an Agent message are stored beside the conversation that
-- references them rather than inside it, so the conversation document stays
-- small enough to rewrite on every round. SQLite cannot widen a CHECK in place,
-- so the table is rebuilt with the third kind.
CREATE TABLE agent_documents_next (
    kind TEXT NOT NULL CHECK (kind IN ('session', 'operation', 'image')),
    id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    ciphertext BLOB NOT NULL,
    nonce BLOB NOT NULL,
    expires_at_ms INTEGER NOT NULL,
    PRIMARY KEY (kind, id)
);
INSERT INTO agent_documents_next(kind, id, revision, ciphertext, nonce, expires_at_ms)
    SELECT kind, id, revision, ciphertext, nonce, expires_at_ms FROM agent_documents;
DROP INDEX agent_documents_expiry;
DROP TABLE agent_documents;
ALTER TABLE agent_documents_next RENAME TO agent_documents;
CREATE INDEX agent_documents_expiry ON agent_documents(expires_at_ms);
