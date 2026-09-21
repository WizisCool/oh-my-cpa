package repository

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	appcrypto "github.com/oh-my-cpa/oh-my-cpa/internal/crypto"
	"github.com/oh-my-cpa/oh-my-cpa/migrations"
	_ "modernc.org/sqlite"
)

var ErrMigrationBackupRequired = errors.New("an encrypted migration backup is required before changing the database")
var ErrBackupRestoreFailed = errors.New("backup restore smoke test failed")

// BackupConfig controls the secured migration backup created before a pending
// migration changes an existing on-disk database.
type BackupConfig struct {
	Cipher       *appcrypto.Cipher
	Directory    string
	Retention    int
	MinFreeBytes uint64
	FreeSpace    func(string) (uint64, error)
}

// OpenOption customizes database startup without changing the simple Open call
// used by in-memory tests and small integrations.
type OpenOption func(*openConfig) error

type openConfig struct {
	cipher *appcrypto.Cipher
	backup BackupConfig
}

// WithMigrationBackup enables encrypted migration backups and also wires the
// application cipher into repositories created from the returned DB.
func WithMigrationBackup(cipher *appcrypto.Cipher, directory string, retention int) OpenOption {
	return func(config *openConfig) error {
		if cipher == nil {
			return errors.New("migration backup cipher is required")
		}
		config.cipher = cipher
		config.backup = BackupConfig{Cipher: cipher, Directory: directory, Retention: retention}
		return nil
	}
}

// WithCipher wires the application cipher into a DB without enabling backups.
// It is useful for tests and for repositories that only need raw-payload
// encryption during normal ingestion.
func WithCipher(cipher *appcrypto.Cipher) OpenOption {
	return func(config *openConfig) error {
		if cipher == nil {
			return errors.New("database cipher is required")
		}
		config.cipher = cipher
		config.backup.Cipher = cipher
		return nil
	}
}

// WithBackupConfig supplies the full backup policy, including injectable disk
// accounting for deterministic tests.
func WithBackupConfig(backup BackupConfig) OpenOption {
	return func(config *openConfig) error {
		if backup.Cipher == nil {
			return errors.New("migration backup cipher is required")
		}
		config.cipher = backup.Cipher
		config.backup = backup
		return nil
	}
}

// DB wraps SQLite and retains the security services needed by repository
// boundaries. SQL remains exposed for the existing analytics package API.
type DB struct {
	SQL *sql.DB

	cipher    *appcrypto.Cipher
	backup    BackupConfig
	path      string
	driver    string
	writeGate *writeGate
}

// Cipher returns the application cipher associated with this connection.
func (db *DB) Cipher() *appcrypto.Cipher {
	if db == nil {
		return nil
	}
	return db.cipher
}

func Open(ctx context.Context, databasePath string, options ...OpenOption) (*DB, error) {
	if strings.TrimSpace(databasePath) == "" {
		return nil, fmt.Errorf("database path is required")
	}
	config := openConfig{}
	for _, option := range options {
		if option == nil {
			continue
		}
		if err := option(&config); err != nil {
			return nil, fmt.Errorf("configure database: %w", err)
		}
	}
	// busy_timeout and WAL are connection settings; the URI applies them to
	// every pooled connection opened by modernc.org/sqlite. The pool is opened
	// through this package's gated driver, which is what makes a maintenance job
	// and a writer unable to overlap - see writegate.go for why that boundary is
	// at the driver rather than in the call sites. Preserve an existing SQLite URI
	// query (notably file::memory:?cache=shared).
	registerGatedDriver()
	dsn := gatedDSN(databasePath)
	// One gate per database. Every pool that opens this same file - the application pool
	// and the maintenance service's own connection - receives this gate, so they exclude
	// each other without excluding an unrelated database.
	gate := &writeGate{}
	database := openGatedPool(dsn, gate)
	database.SetMaxOpenConns(1)
	database.SetMaxIdleConns(1)
	if err := database.PingContext(ctx); err != nil {
		database.Close()
		return nil, fmt.Errorf("ping sqlite: %w", err)
	}
	wrapped := &DB{SQL: database, cipher: config.backup.Cipher, backup: config.backup, path: databasePath, driver: gatedDriverName, writeGate: gate}
	if wrapped.cipher == nil {
		wrapped.cipher = config.cipher
	}
	if err := wrapped.Migrate(ctx); err != nil {
		database.Close()
		return nil, err
	}
	return wrapped, nil
}

func (db *DB) Close() error {
	if db == nil || db.SQL == nil {
		return nil
	}
	return db.SQL.Close()
}

func (db *DB) Migrate(ctx context.Context) error {
	if db == nil || db.SQL == nil {
		return fmt.Errorf("database is not initialized")
	}
	if _, err := db.SQL.ExecContext(ctx, `
		CREATE TABLE IF NOT EXISTS schema_migrations (
			version INTEGER PRIMARY KEY,
			applied_at INTEGER NOT NULL
		)`); err != nil {
		return fmt.Errorf("create schema_migrations: %w", err)
	}

	entries, err := fs.ReadDir(migrations.Files, ".")
	if err != nil {
		return fmt.Errorf("read migrations: %w", err)
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].Name() < entries[j].Name() })
	seenVersions := make(map[int]string, len(entries))
	pending := make([]fs.DirEntry, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".sql") {
			continue
		}
		version, err := migrationVersion(entry.Name())
		if err != nil {
			return err
		}
		if previous, exists := seenVersions[version]; exists {
			return fmt.Errorf("duplicate migration version %d in %q and %q", version, previous, entry.Name())
		}
		seenVersions[version] = entry.Name()
		var applied int
		if err := db.SQL.QueryRowContext(ctx, `SELECT COUNT(1) FROM schema_migrations WHERE version = ?`, version).Scan(&applied); err != nil {
			return fmt.Errorf("check migration %d: %w", version, err)
		}
		if applied == 0 {
			pending = append(pending, entry)
		}
	}
	if len(pending) == 0 {
		return nil
	}

	if db.requiresMigrationBackup(ctx) {
		if err := db.createMigrationBackup(ctx, migrationVersionMust(pending[0].Name())); err != nil {
			return err
		}
	}
	for _, entry := range pending {
		version, _ := migrationVersion(entry.Name())
		script, err := fs.ReadFile(migrations.Files, entry.Name())
		if err != nil {
			return fmt.Errorf("read migration %s: %w", entry.Name(), err)
		}
		tx, err := db.SQL.BeginTx(ctx, nil)
		if err != nil {
			return fmt.Errorf("begin migration %d: %w", version, err)
		}
		migrationSucceeded := false
		defer func() {
			if !migrationSucceeded {
				_ = tx.Rollback()
			}
		}()
		if version == 4 {
			if err := checkJSON1(ctx, tx); err != nil {
				return fmt.Errorf("migration %d requires SQLite JSON1: %w", version, err)
			}
		}
		if _, err := tx.ExecContext(ctx, string(script)); err != nil {
			return fmt.Errorf("apply migration %s: %w", entry.Name(), err)
		}
		if hook := migrationHook(version); hook != nil {
			if err := hook(ctx, tx, db); err != nil {
				return fmt.Errorf("govern migration %d: %w", version, err)
			}
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO schema_migrations(version, applied_at) VALUES (?, unixepoch())`, version); err != nil {
			return fmt.Errorf("record migration %d: %w", version, err)
		}
		if err := tx.Commit(); err != nil {
			return fmt.Errorf("commit migration %d: %w", version, err)
		}
		migrationSucceeded = true
	}
	return nil
}

func (db *DB) requiresMigrationBackup(ctx context.Context) bool {
	if !isFileDatabase(db.path) {
		return false
	}
	var tableExists int
	if err := db.SQL.QueryRowContext(ctx, `SELECT COUNT(1) FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'`).Scan(&tableExists); err != nil {
		// Unknown schema state: fail closed and attempt a backup.
		return true
	}
	if tableExists == 0 {
		return false
	}
	var applied int
	if err := db.SQL.QueryRowContext(ctx, `SELECT COUNT(1) FROM schema_migrations`).Scan(&applied); err != nil {
		// A table that exists but cannot be read makes the database state
		// unknown. Do not let the migration proceed without a recoverable copy.
		return true
	}
	if applied == 0 {
		return false
	}
	return true
}

func isFileDatabase(path string) bool {
	trimmed := strings.TrimSpace(path)
	return trimmed != "" && !strings.HasPrefix(strings.ToLower(trimmed), "file:") && !strings.Contains(trimmed, ":memory:")
}

func (db *DB) createMigrationBackup(ctx context.Context, migrationVersion int) error {
	if db == nil || db.SQL == nil || db.cipher == nil {
		return ErrMigrationBackupRequired
	}
	config := db.backup
	if config.Cipher == nil {
		config.Cipher = db.cipher
	}
	if config.Cipher == nil {
		return ErrMigrationBackupRequired
	}
	databasePath, err := filepath.Abs(db.path)
	if err != nil {
		return fmt.Errorf("resolve database path for backup: %w", err)
	}
	info, err := os.Stat(databasePath)
	if err != nil {
		return fmt.Errorf("stat database before migration backup: %w", err)
	}
	backupDir := strings.TrimSpace(config.Directory)
	if backupDir == "" {
		backupDir = filepath.Join(filepath.Dir(databasePath), "backups")
	}
	backupDir, err = filepath.Abs(backupDir)
	if err != nil {
		return fmt.Errorf("resolve backup directory: %w", err)
	}
	if err := os.MkdirAll(backupDir, 0o700); err != nil {
		return fmt.Errorf("create backup directory: %w", err)
	}
	_ = os.Chmod(backupDir, 0o700)
	freeSpace := config.FreeSpace
	if freeSpace == nil {
		freeSpace = availableBytes
	}
	free, err := freeSpace(backupDir)
	if err != nil {
		return fmt.Errorf("check free space for migration backup: %w", err)
	}
	minimum := config.MinFreeBytes
	if minimum == 0 {
		minimum = uint64(info.Size()) + 4096
	}
	if free < minimum {
		return fmt.Errorf("insufficient free space for migration backup: %d bytes available, %d required", free, minimum)
	}
	if _, err := db.SQL.ExecContext(ctx, `PRAGMA wal_checkpoint(TRUNCATE)`); err != nil {
		return fmt.Errorf("checkpoint database before migration backup: %w", err)
	}
	plaintext, err := os.ReadFile(databasePath)
	if err != nil {
		return fmt.Errorf("read database for migration backup: %w", err)
	}
	ciphertext, nonce, err := config.Cipher.Encrypt(plaintext)
	if err != nil {
		return fmt.Errorf("encrypt migration backup: %w", err)
	}
	envelope := encryptedBackup{
		Format:     "oh-my-cpa/sqlite-backup-v1",
		Nonce:      base64.RawStdEncoding.EncodeToString(nonce),
		Ciphertext: base64.RawStdEncoding.EncodeToString(ciphertext),
	}
	encoded, err := json.Marshal(envelope)
	if err != nil {
		return fmt.Errorf("encode migration backup: %w", err)
	}
	stamp := time.Now().UTC().Format("20060102T150405.000000000Z")
	backupPath := filepath.Join(backupDir, fmt.Sprintf("oh-my-cpa-%s-before-migration-%d.db.enc", stamp, migrationVersion))
	if err := writePrivateFile(backupPath, encoded); err != nil {
		return fmt.Errorf("write migration backup: %w", err)
	}
	digest := sha256.Sum256(encoded)
	digestText := hex.EncodeToString(digest[:])
	if err := writePrivateFile(backupPath+".sha256", []byte(digestText+"  "+filepath.Base(backupPath)+"\n")); err != nil {
		return fmt.Errorf("write migration backup digest: %w", err)
	}
	if err := RestoreBackupSmoke(ctx, backupPath, config.Cipher); err != nil {
		return fmt.Errorf("%w: %v", ErrBackupRestoreFailed, err)
	}
	if err := retainBackups(backupDir, config.Retention); err != nil {
		return fmt.Errorf("retain migration backups: %w", err)
	}
	return nil
}

// BackupArtifact describes a completed encrypted backup.
type BackupArtifact struct {
	Path      string
	SHA256    string
	Size      int64
	CreatedAt time.Time
}

// RestoreBackupSmoke decrypts a backup into a temporary SQLite file, opens it,
// and verifies that SQLite can read its schema before the source database is
// changed.
func RestoreBackupSmoke(ctx context.Context, backupPath string, cipher *appcrypto.Cipher) error {
	if strings.TrimSpace(backupPath) == "" || cipher == nil {
		return errors.New("backup path and cipher are required")
	}
	encoded, err := os.ReadFile(backupPath)
	if err != nil {
		return fmt.Errorf("read backup: %w", err)
	}
	digestData, err := os.ReadFile(backupPath + ".sha256")
	if err != nil {
		return fmt.Errorf("read backup digest: %w", err)
	}
	{
		parts := strings.Fields(string(digestData))
		if len(parts) == 0 {
			return errors.New("backup digest is empty")
		}
		digest := sha256.Sum256(encoded)
		if !strings.EqualFold(parts[0], hex.EncodeToString(digest[:])) {
			return errors.New("backup digest mismatch")
		}
	}
	var envelope encryptedBackup
	if err := json.Unmarshal(encoded, &envelope); err != nil || envelope.Format != "oh-my-cpa/sqlite-backup-v1" {
		return errors.New("backup envelope is invalid")
	}
	nonce, err := base64.RawStdEncoding.DecodeString(envelope.Nonce)
	if err != nil {
		return fmt.Errorf("decode backup nonce: %w", err)
	}
	ciphertext, err := base64.RawStdEncoding.DecodeString(envelope.Ciphertext)
	if err != nil {
		return fmt.Errorf("decode backup ciphertext: %w", err)
	}
	plaintext, err := cipher.Decrypt(ciphertext, nonce)
	if err != nil {
		return fmt.Errorf("decrypt backup: %w", err)
	}
	temporaryDirectory, err := os.MkdirTemp("", "oh-my-cpa-restore-")
	if err != nil {
		return fmt.Errorf("create restore directory: %w", err)
	}
	defer os.RemoveAll(temporaryDirectory)
	temporaryPath := filepath.Join(temporaryDirectory, "restore.db")
	if err := writePrivateFile(temporaryPath, plaintext); err != nil {
		return fmt.Errorf("write restore database: %w", err)
	}
	restored, err := sql.Open("sqlite", temporaryPath)
	if err != nil {
		return fmt.Errorf("open restored database: %w", err)
	}
	defer restored.Close()
	restored.SetMaxOpenConns(1)
	if err := restored.PingContext(ctx); err != nil {
		return fmt.Errorf("ping restored database: %w", err)
	}
	var count int
	if err := restored.QueryRowContext(ctx, `SELECT COUNT(1) FROM sqlite_master`).Scan(&count); err != nil {
		return fmt.Errorf("read restored schema: %w", err)
	}
	if count == 0 {
		return errors.New("restored database has no schema")
	}
	return nil
}

type encryptedBackup struct {
	Format     string `json:"format"`
	Nonce      string `json:"nonce"`
	Ciphertext string `json:"ciphertext"`
}

func writePrivateFile(path string, data []byte) error {
	file, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	if _, err := file.Write(data); err != nil {
		file.Close()
		return err
	}
	if err := file.Sync(); err != nil {
		file.Close()
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	return os.Chmod(path, 0o600)
}

func retainBackups(directory string, retention int) error {
	if retention <= 0 {
		retention = 5
	}
	entries, err := os.ReadDir(directory)
	if err != nil {
		return err
	}
	type backupEntry struct {
		path string
		info os.FileInfo
	}
	backups := make([]backupEntry, 0)
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".db.enc") {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		backups = append(backups, backupEntry{path: filepath.Join(directory, entry.Name()), info: info})
	}
	sort.Slice(backups, func(i, j int) bool { return backups[i].info.ModTime().After(backups[j].info.ModTime()) })
	if len(backups) <= retention {
		return nil
	}
	for _, entry := range backups[retention:] {
		if err := os.Remove(entry.path); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
		_ = os.Remove(entry.path + ".sha256")
	}
	return nil
}

func checkJSON1(ctx context.Context, tx *sql.Tx) error {
	var valid int
	if err := tx.QueryRowContext(ctx, `SELECT json_valid('{}')`).Scan(&valid); err != nil {
		return err
	}
	if valid != 1 {
		return errors.New("JSON1 returned an invalid result")
	}
	return nil
}

func migrationHook(version int) func(context.Context, *sql.Tx, *DB) error {
	if version == 4 {
		return sanitizeHistoricalDataTx
	}
	return nil
}

func migrationVersionMust(name string) int {
	version, _ := migrationVersion(name)
	return version
}

func migrationVersion(name string) (int, error) {
	var version int
	if _, err := fmt.Sscanf(name, "%d_", &version); err != nil || version <= 0 {
		return 0, fmt.Errorf("invalid migration filename %q", name)
	}
	return version, nil
}
