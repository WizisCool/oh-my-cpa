package repository

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	appcrypto "github.com/oh-my-cpa/oh-my-cpa/internal/crypto"
	"time"
)

var ErrAgentConflict = errors.New("agent_revision_conflict")

// AgentStore keeps trusted execution state separate from client-editable preferences.
// The encrypted envelope includes its identity to prevent swapping ciphertext rows.
type AgentStore struct {
	Repo   *Repository
	Cipher *appcrypto.Cipher
}
type agentEnvelope struct {
	Kind  string          `json:"kind"`
	ID    string          `json:"id"`
	Value json.RawMessage `json:"value"`
}

func (s AgentStore) Load(ctx context.Context, kind, id string, value any) (int64, error) {
	var ciphertext, nonce []byte
	var revision int64
	err := s.Repo.SQL().QueryRowContext(ctx, "SELECT ciphertext, nonce, revision FROM agent_documents WHERE kind=? AND id=? AND expires_at_ms>?", kind, id, time.Now().UnixMilli()).Scan(&ciphertext, &nonce, &revision)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, ErrNotFound
	}
	if err != nil {
		return 0, err
	}
	plain, err := s.Cipher.Decrypt(ciphertext, nonce)
	if err != nil {
		return 0, err
	}
	var envelope agentEnvelope
	if json.Unmarshal(plain, &envelope) != nil || envelope.Kind != kind || envelope.ID != id {
		return 0, errors.New("invalid_agent_document")
	}
	return revision, json.Unmarshal(envelope.Value, value)
}
func (s AgentStore) Save(ctx context.Context, kind, id string, revision int64, expires time.Time, value any) (int64, error) {
	payload, err := json.Marshal(value)
	if err != nil {
		return 0, err
	}
	if len(payload) > 1<<20 {
		return 0, errors.New("agent_document_too_large")
	}
	plain, err := json.Marshal(agentEnvelope{kind, id, payload})
	if err != nil {
		return 0, err
	}
	ciphertext, nonce, err := s.Cipher.Encrypt(plain)
	if err != nil {
		return 0, err
	}
	var result sql.Result
	if revision == 0 {
		result, err = s.Repo.SQL().ExecContext(ctx, `INSERT INTO agent_documents(kind,id,revision,ciphertext,nonce,expires_at_ms) VALUES(?,?,1,?,?,?) ON CONFLICT(kind,id) DO NOTHING`, kind, id, ciphertext, nonce, expires.UnixMilli())
	} else {
		result, err = s.Repo.SQL().ExecContext(ctx, `UPDATE agent_documents SET revision=revision+1,ciphertext=?,nonce=?,expires_at_ms=? WHERE kind=? AND id=? AND revision=?`, ciphertext, nonce, expires.UnixMilli(), kind, id, revision)
	}
	if err != nil {
		return 0, err
	}
	count, err := result.RowsAffected()
	if err != nil {
		return 0, err
	}
	if count != 1 {
		return 0, ErrAgentConflict
	}
	return revision + 1, nil
}
func (s AgentStore) Delete(ctx context.Context, kind, id string) error {
	_, err := s.Repo.SQL().ExecContext(ctx, "DELETE FROM agent_documents WHERE kind=? AND id=?", kind, id)
	return err
}
func (s AgentStore) Purge(ctx context.Context) error {
	_, err := s.Repo.SQL().ExecContext(ctx, "DELETE FROM agent_documents WHERE expires_at_ms<=?", time.Now().UnixMilli())
	return err
}
