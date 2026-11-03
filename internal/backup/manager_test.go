package backup

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"testing"
	"time"

	appcrypto "github.com/oh-my-cpa/oh-my-cpa/internal/crypto"
	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
)

func backupTestManager(t *testing.T) (*Manager, *repository.DB) {
	t.Helper()
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "omc.db")
	cipher := testCipher(t)
	database, err := repository.Open(ctx, path, repository.WithCipher(cipher))
	if err != nil {
		t.Fatal(err)
	}
	manager, err := NewManager(ctx, Options{Database: database, DatabasePath: path, Cipher: cipher, WrappingCipher: cipher, Version: "test"})
	if err != nil {
		t.Fatal(err)
	}
	manager.codec.workFactor = 10
	t.Cleanup(func() { manager.Close(); database.Close() })
	return manager, database
}
func setBackupTestValue(t *testing.T, database *repository.DB, value string) {
	t.Helper()
	if _, err := database.SQL.Exec(`INSERT INTO ui_preferences(pref_key,pref_value,updated_at_ms) VALUES('backup-test',?,1) ON CONFLICT(pref_key) DO UPDATE SET pref_value=excluded.pref_value`, value); err != nil {
		t.Fatal(err)
	}
}
func backupTestValue(t *testing.T, database *repository.DB) string {
	t.Helper()
	var value string
	if err := database.SQL.QueryRow(`SELECT pref_value FROM ui_preferences WHERE pref_key='backup-test'`).Scan(&value); err != nil {
		t.Fatal(err)
	}
	return value
}

func setBackupTestMigrationHistory(t *testing.T, database *repository.DB) {
	t.Helper()
	if _, err := database.SQL.Exec(`INSERT INTO schema_migrations(version,applied_at) VALUES(54,1000),(55,1000)`); err != nil {
		t.Fatal(err)
	}
}

func checkBackupTestMigrationHistory(t *testing.T, database *repository.DB) {
	t.Helper()
	var count int
	if err := database.SQL.QueryRow(`SELECT COUNT(*) FROM schema_migrations WHERE version IN (54,55) AND applied_at=1000`).Scan(&count); err != nil || count != 2 {
		t.Fatalf("retained migration history changed: count=%d error=%v", count, err)
	}
}

func TestBackupExportImportAppliesOnlyAtStartupAndKeepsRollback(t *testing.T) {
	ctx := context.Background()
	manager, database := backupTestManager(t)
	setBackupTestValue(t, database, "at-snapshot")
	setBackupTestMigrationHistory(t, database)
	exported, err := manager.CreateExport(ctx, "test recovery passphrase")
	if err != nil {
		t.Fatal(err)
	}
	manager.workers.Wait()
	file, job, err := manager.OpenExport(ctx, exported.ID)
	if err != nil {
		t.Fatal(err)
	}
	content, err := io.ReadAll(file)
	file.Close()
	if err != nil || job.State != "ready" {
		t.Fatalf("export: %s %v", job.State, err)
	}
	setBackupTestValue(t, database, "after-snapshot")
	imported, err := manager.StageImport(ctx, bytes.NewReader(content), "test recovery passphrase")
	if err != nil {
		t.Fatal(err)
	}
	if err := manager.Apply(ctx, imported.ID, "different-digest"); !errors.Is(err, ErrConfirmation) {
		t.Fatalf("confirmation: %v", err)
	}
	if err := manager.Apply(ctx, imported.ID, imported.Digest); err != nil {
		t.Fatal(err)
	}
	if value := backupTestValue(t, database); value != "after-snapshot" {
		t.Fatal("confirmation changed live database")
	}
	manager.Close()
	database.Close()
	differentCipher, _ := appcrypto.New("changed-master-key-0123456789abcdef")
	if err := ApplyPendingRestore(ctx, manager.options.DatabasePath, differentCipher, "test"); err == nil {
		t.Fatalf("changed startup master key: %v", err)
	}
	if err := ApplyPendingRestore(ctx, manager.options.DatabasePath, manager.options.Cipher, "test"); err != nil {
		t.Fatal(err)
	}
	restored, err := repository.Open(ctx, manager.options.DatabasePath, repository.WithCipher(manager.options.Cipher))
	if err != nil {
		t.Fatal(err)
	}
	defer restored.Close()
	checkBackupTestMigrationHistory(t, restored)
	if value := backupTestValue(t, restored); value != "at-snapshot" {
		t.Fatalf("restored data = %q", value)
	}
	var auditCount int
	if err := restored.SQL.QueryRow(`SELECT COUNT(*) FROM audit_events WHERE action='system.database.restore.completed'`).Scan(&auditCount); err != nil || auditCount != 1 {
		t.Fatalf("restore audit: %d %v", auditCount, err)
	}
	rollback := filepath.Join(manager.jobDirectory(imported.ID), "rollback.omcbackup")
	input, err := os.Open(rollback)
	if err != nil {
		t.Fatal(err)
	}
	defer input.Close()
	secret, _ := manager.options.Cipher.Fingerprint("omc-database-rollback-v1", imported.ID)
	path := filepath.Join(t.TempDir(), "rollback.db")
	if _, _, err := manager.codec.unpack(ctx, input, path, secret); err != nil {
		t.Fatal(err)
	}
	previous, err := repository.Open(ctx, path, repository.WithCipher(manager.options.Cipher))
	if err != nil {
		t.Fatal(err)
	}
	defer previous.Close()
	checkBackupTestMigrationHistory(t, previous)
	if value := backupTestValue(t, previous); value != "after-snapshot" {
		t.Fatal("rollback did not preserve latest database")
	}
}

func TestBackupExportReportsSnapshotValidationFailure(t *testing.T) {
	ctx := context.Background()
	manager, database := backupTestManager(t)
	if _, err := database.SQL.ExecContext(ctx, `DELETE FROM schema_migrations WHERE version=1`); err != nil {
		t.Fatal(err)
	}
	exported, err := manager.CreateExport(ctx, "test recovery passphrase")
	if err != nil {
		t.Fatal(err)
	}
	manager.workers.Wait()
	failed, err := manager.Get(exported.ID)
	if err != nil {
		t.Fatal(err)
	}
	if failed.State != "failed" || failed.Error == "" || failed.Error == ErrInvalidArtifact.Error() {
		t.Fatalf("snapshot validation failure misclassified: state=%s error=%q", failed.State, failed.Error)
	}
	if file, _, err := manager.OpenExport(ctx, exported.ID); err == nil {
		file.Close()
		t.Fatal("invalid snapshot was available for download")
	}
}

func TestBackupAuditFailureRefusesExportDownloadAndRestore(t *testing.T) {
	ctx := context.Background()
	manager, database := backupTestManager(t)
	exported, err := manager.CreateExport(ctx, "test recovery passphrase")
	if err != nil {
		t.Fatal(err)
	}
	manager.workers.Wait()
	file, _, err := manager.OpenExport(ctx, exported.ID)
	if err != nil {
		t.Fatal(err)
	}
	content, _ := io.ReadAll(file)
	file.Close()
	imported, err := manager.StageImport(ctx, bytes.NewReader(content), "test recovery passphrase")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := database.SQL.Exec(`CREATE TRIGGER reject_backup_audit BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT,'audit unavailable'); END`); err != nil {
		t.Fatal(err)
	}
	if _, err := manager.CreateExport(ctx, "test recovery passphrase"); !errors.Is(err, ErrAudit) {
		t.Fatalf("export audit: %v", err)
	}
	if file, _, err := manager.OpenExport(ctx, exported.ID); !errors.Is(err, ErrAudit) {
		if file != nil {
			file.Close()
		}
		t.Fatalf("download audit: %v", err)
	}
	if err := manager.Apply(ctx, imported.ID, imported.Digest); !errors.Is(err, ErrAudit) {
		t.Fatalf("restore audit: %v", err)
	}
	if _, err := os.Stat(filepath.Join(manager.directory, "restore.json")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("refused restore was scheduled")
	}
	if _, err := database.SQL.Exec(`DROP TRIGGER reject_backup_audit`); err != nil {
		t.Fatal(err)
	}
	setBackupTestValue(t, database, "keep-current-data")
	candidate := filepath.Join(manager.jobDirectory(imported.ID), "candidate.db")
	staged, err := repository.Open(ctx, candidate, repository.WithCipher(manager.options.Cipher))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := staged.SQL.Exec(`CREATE TRIGGER reject_restore_completion BEFORE INSERT ON audit_events WHEN NEW.action='system.database.restore.completed' BEGIN SELECT RAISE(ABORT,'audit unavailable'); END`); err != nil {
		t.Fatal(err)
	}
	staged.Close()
	artifact := filepath.Join(t.TempDir(), "completion-failure.omcbackup")
	schema := repository.BackupSchemaVersion()
	if _, err := manager.codec.pack(ctx, candidate, artifact, "test recovery passphrase", newManifest(newID(), "test", schema), manager.options.Cipher); err != nil {
		t.Fatal(err)
	}
	input, err := os.Open(artifact)
	if err != nil {
		t.Fatal(err)
	}
	confirmed, err := manager.StageImport(ctx, input, "test recovery passphrase")
	input.Close()
	if err != nil {
		t.Fatal(err)
	}
	if err := manager.Apply(ctx, confirmed.ID, confirmed.Digest); err != nil {
		t.Fatal(err)
	}
	manager.Close()
	database.Close()
	if err := ApplyPendingRestore(ctx, manager.options.DatabasePath, manager.options.WrappingCipher, "test"); err == nil {
		t.Fatal("restore committed without its required outcome audit")
	}
	previous, err := repository.Open(ctx, manager.options.DatabasePath, repository.WithCipher(manager.options.Cipher))
	if err != nil {
		t.Fatal(err)
	}
	defer previous.Close()
	if value := backupTestValue(t, previous); value != "keep-current-data" {
		t.Fatalf("audit failure did not roll back data: %s", value)
	}
	if _, err := os.Stat(manager.options.DatabasePath + ".key"); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("audit failure did not roll back the key envelope")
	}
}

func TestInterruptedRestoreRollsBackTheEntireFileSet(t *testing.T) {
	directory := t.TempDir()
	path := filepath.Join(directory, "omc.db")
	id := newID()
	jobDirectory := filepath.Join(stateDirectory(path), id)
	if err := os.MkdirAll(jobDirectory, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := writeJSON(filepath.Join(jobDirectory, "job.json"), Job{ID: id, Kind: "import", State: "scheduled", ExpiresAtMS: time.Now().Add(time.Hour).UnixMilli()}); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("partial-new-database"), 0o600); err != nil {
		t.Fatal(err)
	}
	for _, suffix := range []string{"", "-wal", ".key"} {
		if err := os.WriteFile(filepath.Join(jobDirectory, "original.db"+suffix), []byte("original"+suffix), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if err := writeJSON(filepath.Join(stateDirectory(path), "restore.json"), restoreJournal{JobID: id, State: "activating", OriginalFiles: []string{"", "-wal", ".key"}}); err != nil {
		t.Fatal(err)
	}
	for range 2 {
		if err := ApplyPendingRestore(context.Background(), path, testCipher(t), "test"); err != nil {
			t.Fatal(err)
		}
	}
	for _, suffix := range []string{"", "-wal", ".key"} {
		actual, err := os.ReadFile(path + suffix)
		if err != nil || string(actual) != "original"+suffix {
			t.Fatalf("rollback %s: %q %v", suffix, actual, err)
		}
	}
}

func TestPendingRestoreCanBeCancelledWithoutChangingData(t *testing.T) {
	manager, database := backupTestManager(t)
	setBackupTestValue(t, database, "current")
	job, err := manager.CreateExport(context.Background(), "test recovery passphrase")
	if err != nil {
		t.Fatal(err)
	}
	manager.workers.Wait()
	file, _, err := manager.OpenExport(context.Background(), job.ID)
	if err != nil {
		t.Fatal(err)
	}
	content, _ := io.ReadAll(file)
	file.Close()
	imported, err := manager.StageImport(context.Background(), bytes.NewReader(content), "test recovery passphrase")
	if err != nil {
		t.Fatal(err)
	}
	if err := manager.Apply(context.Background(), imported.ID, imported.Digest); err != nil {
		t.Fatal(err)
	}
	if err := manager.Delete(context.Background(), imported.ID); err != nil {
		t.Fatal(err)
	}
	if backupTestValue(t, database) != "current" {
		t.Fatal("cancellation changed database")
	}
	if _, err := os.Stat(filepath.Join(manager.directory, "restore.json")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("cancelled restore is still pending")
	}
	imported, err = manager.StageImport(context.Background(), bytes.NewReader(content), "test recovery passphrase")
	if err != nil {
		t.Fatal(err)
	}
	if err := manager.Apply(context.Background(), imported.ID, imported.Digest); err != nil {
		t.Fatal(err)
	}
	manager.Close()
	candidate := filepath.Join(manager.jobDirectory(imported.ID), "candidate.db")
	prepared, err := repository.Open(context.Background(), candidate, repository.WithCipher(manager.options.Cipher))
	if err != nil {
		t.Fatal(err)
	}
	setBackupTestValue(t, prepared, "migrated-candidate")
	prepared.Close()
	digest, _, err := fileDigest(context.Background(), candidate)
	if err != nil {
		t.Fatal(err)
	}
	if err := writeJSON(filepath.Join(manager.directory, "restore.json"), restoreJournal{JobID: imported.ID, State: "prepared", Digest: digest}); err != nil {
		t.Fatal(err)
	}
	if err := CancelPendingRestore(manager.options.DatabasePath); err != nil {
		t.Fatal(err)
	}
	reloaded, err := NewManager(context.Background(), manager.options)
	if err != nil {
		t.Fatal(err)
	}
	defer reloaded.Close()
	if err := reloaded.Apply(context.Background(), imported.ID, imported.Digest); !errors.Is(err, ErrConfirmation) {
		t.Fatalf("cancelled candidate can be confirmed with stale digest: %v", err)
	}
	if backupTestValue(t, database) != "current" {
		t.Fatal("offline cancellation changed database")
	}
}
