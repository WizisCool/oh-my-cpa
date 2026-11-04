package repository

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"io/fs"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strings"

	appcrypto "github.com/oh-my-cpa/oh-my-cpa/internal/crypto"
	"github.com/oh-my-cpa/oh-my-cpa/migrations"
)

var ErrBackupSchemaNewer = errors.New("backup schema is newer than this OMC version")

// SnapshotDatabase holds the database's maintenance gate only while SQLite creates
// its consistent file image. Encryption and delivery must happen after it returns.
func (db *DB) SnapshotDatabase(ctx context.Context, path string) error {
	if err := db.writeGate.enterMaintenance(ctx); err != nil {
		return err
	}
	defer db.writeGate.leaveMaintenance()
	work := openGatedPool(gatedDSN(db.path), db.writeGate)
	defer work.Close()
	work.SetMaxOpenConns(1)
	if _, err := work.ExecContext(withMaintenanceContext(ctx), `VACUUM INTO ?`, path); err != nil {
		return fmt.Errorf("snapshot database: %w", err)
	}
	return os.Chmod(path, 0o600)
}

// RequireBackupSpace accounts against the writable data volume, including scratch
// files; a failed measurement is not permission to proceed with a destructive job.
func RequireBackupSpace(directory string, bytes uint64) error {
	free, err := availableBytes(directory)
	if err != nil {
		return fmt.Errorf("measure backup disk space: %w", err)
	}
	if free < bytes {
		return ErrInsufficientDiskSpace
	}
	return nil
}

// BackupSchemaVersion is derived from the migration files rather than maintained
// as another version literal beside the migration engine.
func BackupSchemaVersion() int {
	entries, _ := fs.ReadDir(migrations.Files, ".")
	version := 0
	for _, entry := range entries {
		if strings.HasSuffix(entry.Name(), ".sql") {
			if next := migrationVersionMust(entry.Name()); next > version {
				version = next
			}
		}
	}
	return version
}

func backupReadOnly(ctx context.Context, path string) (*sql.DB, error) {
	absolute, err := filepath.Abs(path)
	if err != nil {
		return nil, err
	}
	uri := (&url.URL{Scheme: "file", Path: filepath.ToSlash(absolute)}).String()
	database, err := sql.Open("sqlite", uri+"?mode=ro&immutable=1&_pragma=query_only(1)&_pragma=trusted_schema(0)&_pragma=mmap_size(0)")
	if err != nil {
		return nil, err
	}
	database.SetMaxOpenConns(1)
	if err := database.PingContext(ctx); err != nil {
		database.Close()
		return nil, err
	}
	return database, nil
}

// ValidateDatabaseBackup treats the upload as an untrusted database, not as an
// application repository: opening it must not run migrations or startup hooks.
// The authenticated backup manifest is checked before this storage-level validation.
func ValidateDatabaseBackup(ctx context.Context, path string) (int, error) {
	database, err := backupReadOnly(ctx, path)
	if err != nil {
		return 0, errors.New("backup database cannot be opened")
	}
	defer database.Close()
	if err := checkBackupIntegrity(ctx, database); err != nil {
		return 0, err
	}
	rows, err := database.QueryContext(ctx, `SELECT version FROM schema_migrations ORDER BY version`)
	if err != nil {
		return 0, errors.New("backup migration history is invalid")
	}
	var applied []int
	for rows.Next() {
		var version int
		if err := rows.Scan(&version); err != nil {
			rows.Close()
			return 0, err
		}
		applied = append(applied, version)
	}
	err = errors.Join(rows.Err(), rows.Close())
	if err != nil {
		return 0, err
	}
	if len(applied) == 0 {
		return 0, errors.New("backup migration history is empty")
	}
	if applied[0] <= 0 {
		return 0, errors.New("backup migration history is invalid")
	}
	version := applied[len(applied)-1]
	if version > BackupSchemaVersion() {
		return 0, ErrBackupSchemaNewer
	}
	entries, err := fs.ReadDir(migrations.Files, ".")
	if err != nil {
		return 0, err
	}
	// Match the migrator's supported histories: shipped migrations are required,
	// but retained records from development branches must not invalidate a backup.
	for _, entry := range entries {
		if strings.HasSuffix(entry.Name(), ".sql") {
			next := migrationVersionMust(entry.Name())
			if next <= version && !slices.Contains(applied, next) {
				return 0, fmt.Errorf("backup migration history is missing required version %03d", next)
			}
		}
	}
	return version, nil
}

func checkBackupIntegrity(ctx context.Context, database *sql.DB) error {
	rows, err := database.QueryContext(ctx, `PRAGMA integrity_check`)
	if err != nil {
		return errors.New("backup database integrity check failed")
	}
	count := 0
	for rows.Next() {
		var result string
		if rows.Scan(&result) != nil || result != "ok" {
			rows.Close()
			return errors.New("backup database integrity check failed")
		}
		count++
	}
	err = errors.Join(rows.Err(), rows.Close())
	if err != nil || count != 1 {
		return errors.New("backup database integrity check failed")
	}
	rows, err = database.QueryContext(ctx, `PRAGMA foreign_key_check`)
	if err != nil {
		return errors.New("backup foreign key check failed")
	}
	hasViolation := rows.Next()
	err = errors.Join(rows.Err(), rows.Close())
	if hasViolation || err != nil {
		return errors.New("backup foreign key check failed")
	}
	return nil
}

// PrepareDatabaseBackup upgrades only the isolated, already-validated candidate.
func PrepareDatabaseBackup(ctx context.Context, path string, cipher *appcrypto.Cipher) error {
	if _, err := ValidateDatabaseBackup(ctx, path); err != nil {
		return err
	}
	database, err := Open(ctx, path, WithCipher(cipher))
	if err != nil {
		return err
	}
	if err := database.Close(); err != nil {
		return err
	}
	_, err = ValidateDatabaseBackup(ctx, path)
	return err
}

// SnapshotStoppedDatabase is the offline/startup counterpart of SnapshotDatabase.
// Its caller holds the process lock, so it needs no application maintenance gate.
func SnapshotStoppedDatabase(ctx context.Context, source, destination string) error {
	absolute, err := filepath.Abs(source)
	if err != nil {
		return err
	}
	uri := (&url.URL{Scheme: "file", Path: filepath.ToSlash(absolute)}).String()
	database, err := sql.Open("sqlite", uri+"?mode=rw&_pragma=busy_timeout(5000)")
	if err != nil {
		return err
	}
	defer database.Close()
	database.SetMaxOpenConns(1)
	if _, err := database.ExecContext(ctx, `VACUUM INTO ?`, destination); err != nil {
		return fmt.Errorf("snapshot stopped database: %w", err)
	}
	return os.Chmod(destination, 0o600)
}

// RecordStoppedDatabaseAudit does not migrate the source just to export it.
// The CLI holds the same exclusive file lock as the running application.
func RecordStoppedDatabaseAudit(ctx context.Context, path string, event AuditEvent) error {
	absolute, err := filepath.Abs(path)
	if err != nil {
		return err
	}
	uri := (&url.URL{Scheme: "file", Path: filepath.ToSlash(absolute)}).String()
	database, err := sql.Open("sqlite", uri+"?mode=rw&_pragma=busy_timeout(5000)")
	if err != nil {
		return err
	}
	defer database.Close()
	database.SetMaxOpenConns(1)
	_, err = New(&DB{SQL: database}).RecordAuditEvent(ctx, event)
	return err
}
