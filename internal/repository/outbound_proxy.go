package repository

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"

	appcrypto "github.com/oh-my-cpa/oh-my-cpa/internal/crypto"
)

// OutboundProxySettings is kept encrypted because URL may contain credentials.
// It must not be returned directly to clients or included in audit records.
type OutboundProxySettings struct {
	Mode    string `json:"mode"`
	URL     string `json:"url"`
	NoProxy string `json:"no_proxy"`
}

var ErrOutboundProxyConflict = errors.New("outbound_proxy_conflict")

// OutboundProxyStore owns the encrypted settings independently of UI preferences.
type OutboundProxyStore struct {
	Repo   *Repository
	Cipher *appcrypto.Cipher
}

func (s OutboundProxyStore) Load(ctx context.Context) (OutboundProxySettings, int64, error) {
	if s.Repo == nil || s.Cipher == nil {
		return OutboundProxySettings{}, 0, errors.New("outbound proxy store is not configured")
	}
	var ciphertext, nonce []byte
	var revision int64
	err := s.Repo.SQL().QueryRowContext(ctx, `SELECT revision,ciphertext,nonce FROM outbound_proxy_settings WHERE id=1`).Scan(&revision, &ciphertext, &nonce)
	if errors.Is(err, sql.ErrNoRows) {
		return OutboundProxySettings{Mode: "environment"}, 0, nil
	}
	if err != nil {
		return OutboundProxySettings{}, 0, err
	}
	plain, err := s.Cipher.Decrypt(ciphertext, nonce)
	if err != nil {
		return OutboundProxySettings{}, 0, err
	}
	var settings OutboundProxySettings
	if err := json.Unmarshal(plain, &settings); err != nil {
		return OutboundProxySettings{}, 0, err
	}
	return settings, revision, nil
}

// Save refuses a stale revision so operators cannot overwrite each other's changes.
func (s OutboundProxyStore) Save(ctx context.Context, revision int64, settings OutboundProxySettings) (int64, error) {
	if s.Repo == nil || s.Cipher == nil {
		return 0, errors.New("outbound proxy store is not configured")
	}
	plain, err := json.Marshal(settings)
	if err != nil {
		return 0, err
	}
	ciphertext, nonce, err := s.Cipher.Encrypt(plain)
	if err != nil {
		return 0, err
	}
	var result sql.Result
	if revision == 0 {
		result, err = s.Repo.SQL().ExecContext(ctx, `INSERT INTO outbound_proxy_settings(id,revision,ciphertext,nonce) VALUES(1,1,?,?) ON CONFLICT(id) DO NOTHING`, ciphertext, nonce)
	} else {
		result, err = s.Repo.SQL().ExecContext(ctx, `UPDATE outbound_proxy_settings SET revision=revision+1,ciphertext=?,nonce=? WHERE id=1 AND revision=?`, ciphertext, nonce, revision)
	}
	if err != nil {
		return 0, err
	}
	count, err := result.RowsAffected()
	if err != nil {
		return 0, err
	}
	if count != 1 {
		return 0, ErrOutboundProxyConflict
	}
	return revision + 1, nil
}
