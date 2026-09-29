package repository

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"time"

	appcrypto "github.com/oh-my-cpa/oh-my-cpa/internal/crypto"
)

// CONFIG_BACKUP_RETENTION is how many configuration backups are kept. A backup
// is only taken when a file is converted to the v8 layout, which happens once
// per file, so this bounds repeated conversions of restored legacy files.
const CONFIG_BACKUP_RETENTION = 10

// CONFIG_BACKUP_MAX_BYTES matches the largest document CPA's management API
// accepts.
const CONFIG_BACKUP_MAX_BYTES = 2 * 1024 * 1024

// ConfigBackup describes one kept configuration file without its content. The
// gateway address is kept for the operator reading the database, not served:
// the console shows a gateway's address masked everywhere else.
type ConfigBackup struct {
	ID          int64  `json:"id"`
	GatewayURL  string `json:"-"`
	CreatedAtMS int64  `json:"created_at_ms"`
	Revision    string `json:"revision"`
	SizeBytes   int64  `json:"size_bytes"`
}

// ConfigBackupStore keeps CPA configuration files encrypted at rest. The
// envelope repeats the revision so a ciphertext copied onto another row does not
// decrypt as that row's document.
type ConfigBackupStore struct {
	Repo   *Repository
	Cipher *appcrypto.Cipher
}

type configBackupEnvelope struct {
	Revision string `json:"revision"`
	YAML     string `json:"yaml"`
}

// ErrConfigBackupTooLarge refuses a document larger than CPA itself accepts.
var ErrConfigBackupTooLarge = errors.New("configuration backup is too large")

// Save stores one document and drops the oldest beyond the retention.
func (s ConfigBackupStore) Save(ctx context.Context, gatewayURL, document string, now time.Time) (ConfigBackup, error) {
	if s.Repo == nil || s.Cipher == nil {
		return ConfigBackup{}, errors.New("configuration backup store is not configured")
	}
	if len(document) > CONFIG_BACKUP_MAX_BYTES {
		return ConfigBackup{}, ErrConfigBackupTooLarge
	}
	digest := sha256.Sum256([]byte(document))
	revision := hex.EncodeToString(digest[:])
	plain, err := json.Marshal(configBackupEnvelope{Revision: revision, YAML: document})
	if err != nil {
		return ConfigBackup{}, err
	}
	ciphertext, nonce, err := s.Cipher.Encrypt(plain)
	if err != nil {
		return ConfigBackup{}, err
	}
	backup := ConfigBackup{GatewayURL: gatewayURL, CreatedAtMS: now.UnixMilli(), Revision: revision, SizeBytes: int64(len(document))}
	tx, err := s.Repo.SQL().BeginTx(ctx, nil)
	if err != nil {
		return ConfigBackup{}, err
	}
	defer func() { _ = tx.Rollback() }()
	result, err := tx.ExecContext(ctx, `INSERT INTO cpa_config_backups(gateway_url, created_at_ms, revision, size_bytes, ciphertext, nonce) VALUES(?,?,?,?,?,?)`,
		backup.GatewayURL, backup.CreatedAtMS, backup.Revision, backup.SizeBytes, ciphertext, nonce)
	if err != nil {
		return ConfigBackup{}, err
	}
	if backup.ID, err = result.LastInsertId(); err != nil {
		return ConfigBackup{}, err
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM cpa_config_backups WHERE id NOT IN (SELECT id FROM cpa_config_backups ORDER BY id DESC LIMIT ?)`, CONFIG_BACKUP_RETENTION); err != nil {
		return ConfigBackup{}, err
	}
	return backup, tx.Commit()
}

// List returns the kept backups, newest first, without their content.
func (s ConfigBackupStore) List(ctx context.Context) ([]ConfigBackup, error) {
	rows, err := s.Repo.SQL().QueryContext(ctx, `SELECT id, gateway_url, created_at_ms, revision, size_bytes FROM cpa_config_backups ORDER BY id DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	backups := []ConfigBackup{}
	for rows.Next() {
		var backup ConfigBackup
		if err := rows.Scan(&backup.ID, &backup.GatewayURL, &backup.CreatedAtMS, &backup.Revision, &backup.SizeBytes); err != nil {
			return nil, err
		}
		backups = append(backups, backup)
	}
	return backups, rows.Err()
}

// Load returns one backup with its document.
func (s ConfigBackupStore) Load(ctx context.Context, id int64) (ConfigBackup, string, error) {
	var backup ConfigBackup
	var ciphertext, nonce []byte
	err := s.Repo.SQL().QueryRowContext(ctx, `SELECT id, gateway_url, created_at_ms, revision, size_bytes, ciphertext, nonce FROM cpa_config_backups WHERE id = ?`, id).
		Scan(&backup.ID, &backup.GatewayURL, &backup.CreatedAtMS, &backup.Revision, &backup.SizeBytes, &ciphertext, &nonce)
	if errors.Is(err, sql.ErrNoRows) {
		return ConfigBackup{}, "", ErrNotFound
	}
	if err != nil {
		return ConfigBackup{}, "", err
	}
	plain, err := s.Cipher.Decrypt(ciphertext, nonce)
	if err != nil {
		return ConfigBackup{}, "", err
	}
	var envelope configBackupEnvelope
	if json.Unmarshal(plain, &envelope) != nil || envelope.Revision != backup.Revision {
		return ConfigBackup{}, "", errors.New("invalid configuration backup")
	}
	return backup, envelope.YAML, nil
}
