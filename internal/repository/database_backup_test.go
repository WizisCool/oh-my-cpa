package repository

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"

	appcrypto "github.com/oh-my-cpa/oh-my-cpa/internal/crypto"
)

func TestDatabaseSnapshotPreservesWALAndMigrationHistory(t *testing.T) {
	ctx := context.Background()
	directory := t.TempDir()
	cipher, _ := appcrypto.New("database-backup-test-master-key-0123456789")
	database, err := Open(ctx, filepath.Join(directory, "live.db"), WithCipher(cipher), withMigrationsUntil(56))
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	if _, err := database.SQL.ExecContext(ctx, `PRAGMA wal_autocheckpoint=0`); err != nil {
		t.Fatal(err)
	}
	if _, err := database.SQL.ExecContext(ctx, `INSERT INTO ui_preferences(pref_key,pref_value,updated_at_ms) VALUES('backup-test','{"preserved":true}',1)`); err != nil {
		t.Fatal(err)
	}
	// Upgraded development databases retain migration records whose scripts are no
	// longer embedded. They remain part of the supported history after repair.
	if _, err := database.SQL.ExecContext(ctx, `INSERT INTO schema_migrations(version,applied_at) VALUES(54,1000),(55,1000)`); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(directory, "snapshot.db")
	if err := database.SnapshotDatabase(ctx, path); err != nil {
		t.Fatal(err)
	}
	if _, err := ValidateDatabaseBackup(ctx, path); err != nil {
		t.Fatal(err)
	}
	if err := PrepareDatabaseBackup(ctx, path, cipher); err != nil {
		t.Fatalf("prepare older backup: %v", err)
	}
	if version, err := ValidateDatabaseBackup(ctx, path); err != nil || version != BackupSchemaVersion() {
		t.Fatalf("prepared schema: %d %v", version, err)
	}
	snapshot, err := backupReadOnly(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	var value string
	if err := snapshot.QueryRowContext(ctx, `SELECT pref_value FROM ui_preferences WHERE pref_key='backup-test'`).Scan(&value); err != nil || value != `{"preserved":true}` {
		t.Fatalf("WAL row missing: %s, %v", value, err)
	}
	var historicalCount int
	if err := snapshot.QueryRowContext(ctx, `SELECT COUNT(*) FROM schema_migrations WHERE version IN (54,55) AND applied_at=1000`).Scan(&historicalCount); err != nil || historicalCount != 2 {
		t.Fatalf("retained migration history changed: count=%d error=%v", historicalCount, err)
	}
	snapshot.Close()
	for _, invalid := range []struct {
		name  string
		query string
	}{
		{"future version", `INSERT INTO schema_migrations(version,applied_at) VALUES(999999,1)`},
		{"missing required migration", `DELETE FROM schema_migrations WHERE version=1`},
		{"nonpositive version", `INSERT INTO schema_migrations(version,applied_at) VALUES(0,1)`},
	} {
		t.Run(invalid.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "invalid.db")
			if err := database.SnapshotDatabase(ctx, path); err != nil {
				t.Fatal(err)
			}
			corrupted, err := Open(ctx, path, WithCipher(cipher))
			if err != nil {
				t.Fatal(err)
			}
			if _, err := corrupted.SQL.ExecContext(ctx, invalid.query); err != nil {
				corrupted.Close()
				t.Fatal(err)
			}
			corrupted.Close()
			_, err = ValidateDatabaseBackup(ctx, path)
			if err == nil {
				t.Fatal("invalid migration history was accepted")
			}
			if invalid.name == "future version" && !errors.Is(err, ErrBackupSchemaNewer) {
				t.Fatalf("future schema: %v", err)
			}
		})
	}
	if info, err := os.Stat(path); err != nil || info.Mode().Perm()&0o077 != 0 {
		t.Fatal("snapshot permissions are not private")
	}
}
