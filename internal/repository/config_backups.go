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

// The layout a kept file was stored in. Only a v8 copy can be written back
// through the v8 API; a legacy copy is kept for download.
const (
	ConfigLayoutV8     = "v8"
	ConfigLayoutLegacy = "legacy"
)

// CONFIG_BACKUP_RETENTION_DEFAULT is how many v8 copies are kept until the
// operator chooses otherwise. A copy is taken before every configuration write,
// so this is roughly how many operations can be undone.
const CONFIG_BACKUP_RETENTION_DEFAULT = 20

// CONFIG_BACKUP_RETENTION_MIN and CONFIG_BACKUP_RETENTION_MAX bound the
// operator's choice. The floor keeps a burst of writes from leaving nothing to go
// back to; the ceiling bounds the table at a few hundred MiB in the worst case.
const (
	CONFIG_BACKUP_RETENTION_MIN = 5
	CONFIG_BACKUP_RETENTION_MAX = 100
)

// CONFIG_LEGACY_BACKUP_RETENTION is how many pre-v8 copies are kept, apart from
// the v8 ones: the copy taken before a conversion is the only record of the
// original file, so everyday writes must not push it out.
const CONFIG_LEGACY_BACKUP_RETENTION = 10

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
	Layout      string `json:"layout"`
	Reason      string `json:"reason"`
}

// ConfigBackupInput is one stored file to keep, with what it was kept before.
type ConfigBackupInput struct {
	GatewayURL string
	Document   string
	Layout     string
	Reason     string
}

// ConfigBackupSettings is the retention the operator chose and its bounds.
type ConfigBackupSettings struct {
	Retention       int `json:"retention"`
	RetentionMin    int `json:"retention_min"`
	RetentionMax    int `json:"retention_max"`
	LegacyRetention int `json:"legacy_retention"`
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

// ErrConfigBackupRetention refuses a retention outside its bounds.
var ErrConfigBackupRetention = errors.New("configuration backup retention is out of range")

const configBackupColumns = `id, gateway_url, created_at_ms, revision, size_bytes, layout, reason`

func scanConfigBackup(row interface{ Scan(...any) error }, extra ...any) (ConfigBackup, error) {
	var backup ConfigBackup
	targets := append([]any{&backup.ID, &backup.GatewayURL, &backup.CreatedAtMS, &backup.Revision, &backup.SizeBytes, &backup.Layout, &backup.Reason}, extra...)
	return backup, row.Scan(targets...)
}

// Save stores one document and drops the oldest of its layout beyond the
// retention. The boolean is false when the newest copy of this gateway already
// holds the same document, which is returned instead: a write CPA refuses leaves
// the file unchanged, and every retry would otherwise push an older, different
// copy out of the retention.
func (s ConfigBackupStore) Save(ctx context.Context, input ConfigBackupInput, now time.Time) (ConfigBackup, bool, error) {
	if s.Repo == nil || s.Cipher == nil {
		return ConfigBackup{}, false, errors.New("configuration backup store is not configured")
	}
	if len(input.Document) > CONFIG_BACKUP_MAX_BYTES {
		return ConfigBackup{}, false, ErrConfigBackupTooLarge
	}
	if input.Layout != ConfigLayoutV8 {
		input.Layout = ConfigLayoutLegacy
	}
	digest := sha256.Sum256([]byte(input.Document))
	revision := hex.EncodeToString(digest[:])
	plain, err := json.Marshal(configBackupEnvelope{Revision: revision, YAML: input.Document})
	if err != nil {
		return ConfigBackup{}, false, err
	}
	ciphertext, nonce, err := s.Cipher.Encrypt(plain)
	if err != nil {
		return ConfigBackup{}, false, err
	}
	backup := ConfigBackup{
		GatewayURL:  input.GatewayURL,
		CreatedAtMS: now.UnixMilli(),
		Revision:    revision,
		SizeBytes:   int64(len(input.Document)),
		Layout:      input.Layout,
		Reason:      input.Reason,
	}
	tx, err := s.Repo.SQL().BeginTx(ctx, nil)
	if err != nil {
		return ConfigBackup{}, false, err
	}
	defer func() { _ = tx.Rollback() }()
	latest, err := scanConfigBackup(tx.QueryRowContext(ctx, `SELECT `+configBackupColumns+` FROM cpa_config_backups WHERE gateway_url = ? ORDER BY id DESC LIMIT 1`, input.GatewayURL))
	switch {
	case err == nil && latest.Revision == revision:
		return latest, false, nil
	case err != nil && !errors.Is(err, sql.ErrNoRows):
		return ConfigBackup{}, false, err
	}
	result, err := tx.ExecContext(ctx, `INSERT INTO cpa_config_backups(gateway_url, created_at_ms, revision, size_bytes, layout, reason, ciphertext, nonce) VALUES(?,?,?,?,?,?,?,?)`,
		backup.GatewayURL, backup.CreatedAtMS, backup.Revision, backup.SizeBytes, backup.Layout, backup.Reason, ciphertext, nonce)
	if err != nil {
		return ConfigBackup{}, false, err
	}
	if backup.ID, err = result.LastInsertId(); err != nil {
		return ConfigBackup{}, false, err
	}
	retention, err := readConfigBackupRetention(ctx, tx)
	if err != nil {
		return ConfigBackup{}, false, err
	}
	if err := pruneConfigBackups(ctx, tx, retention); err != nil {
		return ConfigBackup{}, false, err
	}
	return backup, true, tx.Commit()
}

// pruneConfigBackups keeps the newest copies of each layout class within its
// own retention.
func pruneConfigBackups(ctx context.Context, tx *sql.Tx, retention int) error {
	if _, err := tx.ExecContext(ctx, `DELETE FROM cpa_config_backups WHERE layout = ? AND id NOT IN (SELECT id FROM cpa_config_backups WHERE layout = ? ORDER BY id DESC LIMIT ?)`,
		ConfigLayoutLegacy, ConfigLayoutLegacy, CONFIG_LEGACY_BACKUP_RETENTION); err != nil {
		return err
	}
	_, err := tx.ExecContext(ctx, `DELETE FROM cpa_config_backups WHERE layout <> ? AND id NOT IN (SELECT id FROM cpa_config_backups WHERE layout <> ? ORDER BY id DESC LIMIT ?)`,
		ConfigLayoutLegacy, ConfigLayoutLegacy, retention)
	return err
}

type queryRower interface {
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
}

func readConfigBackupRetention(ctx context.Context, db queryRower) (int, error) {
	var retention int
	err := db.QueryRowContext(ctx, `SELECT retention FROM cpa_config_backup_settings WHERE id = 1`).Scan(&retention)
	if errors.Is(err, sql.ErrNoRows) {
		return CONFIG_BACKUP_RETENTION_DEFAULT, nil
	}
	return retention, err
}

// Settings returns the retention in force and its bounds.
func (s ConfigBackupStore) Settings(ctx context.Context) (ConfigBackupSettings, error) {
	retention, err := readConfigBackupRetention(ctx, s.Repo.SQL())
	if err != nil {
		return ConfigBackupSettings{}, err
	}
	return ConfigBackupSettings{
		Retention:       retention,
		RetentionMin:    CONFIG_BACKUP_RETENTION_MIN,
		RetentionMax:    CONFIG_BACKUP_RETENTION_MAX,
		LegacyRetention: CONFIG_LEGACY_BACKUP_RETENTION,
	}, nil
}

// SetRetention stores a new retention and applies it at once, so a lowered
// value does not wait for the next write to take effect.
func (s ConfigBackupStore) SetRetention(ctx context.Context, retention int) (ConfigBackupSettings, error) {
	if retention < CONFIG_BACKUP_RETENTION_MIN || retention > CONFIG_BACKUP_RETENTION_MAX {
		return ConfigBackupSettings{}, ErrConfigBackupRetention
	}
	tx, err := s.Repo.SQL().BeginTx(ctx, nil)
	if err != nil {
		return ConfigBackupSettings{}, err
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx, `INSERT INTO cpa_config_backup_settings(id, retention) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET retention = excluded.retention`, retention); err != nil {
		return ConfigBackupSettings{}, err
	}
	if err := pruneConfigBackups(ctx, tx, retention); err != nil {
		return ConfigBackupSettings{}, err
	}
	if err := tx.Commit(); err != nil {
		return ConfigBackupSettings{}, err
	}
	return s.Settings(ctx)
}

// List returns the kept backups, newest first, without their content.
func (s ConfigBackupStore) List(ctx context.Context) ([]ConfigBackup, error) {
	rows, err := s.Repo.SQL().QueryContext(ctx, `SELECT `+configBackupColumns+` FROM cpa_config_backups ORDER BY id DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	backups := []ConfigBackup{}
	for rows.Next() {
		backup, err := scanConfigBackup(rows)
		if err != nil {
			return nil, err
		}
		backups = append(backups, backup)
	}
	return backups, rows.Err()
}

// Load returns one backup with its document.
func (s ConfigBackupStore) Load(ctx context.Context, id int64) (ConfigBackup, string, error) {
	var ciphertext, nonce []byte
	backup, err := scanConfigBackup(s.Repo.SQL().QueryRowContext(ctx, `SELECT `+configBackupColumns+`, ciphertext, nonce FROM cpa_config_backups WHERE id = ?`, id), &ciphertext, &nonce)
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

// Delete removes one backup.
func (s ConfigBackupStore) Delete(ctx context.Context, id int64) (ConfigBackup, error) {
	backup, err := scanConfigBackup(s.Repo.SQL().QueryRowContext(ctx, `DELETE FROM cpa_config_backups WHERE id = ? RETURNING `+configBackupColumns, id))
	if errors.Is(err, sql.ErrNoRows) {
		return ConfigBackup{}, ErrNotFound
	}
	return backup, err
}
