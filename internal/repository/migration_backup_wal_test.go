package repository

import (
	"context"
	"database/sql"
	"os"
	"path/filepath"
	"testing"
	"time"

	appcrypto "github.com/oh-my-cpa/oh-my-cpa/internal/crypto"
)

func TestMigrationBackupContainsCommittedWAL(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	directory := t.TempDir()
	path := filepath.Join(directory, "source.db")
	backupDir := filepath.Join(directory, "backups")
	cipher, err := appcrypto.New("01234567890123456789012345678901")
	if err != nil {
		t.Fatal(err)
	}
	db, err := Open(ctx, path, WithBackupConfig(BackupConfig{Cipher: cipher, Directory: backupDir, Retention: 3, FreeSpace: func(string) (uint64, error) { return 1 << 40, nil }}))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err = db.SQL.ExecContext(ctx, `PRAGMA busy_timeout=50; CREATE TABLE sentinels (id INTEGER PRIMARY KEY, label TEXT); INSERT INTO sentinels VALUES (1,'initial');`); err != nil {
		t.Fatal(err)
	}
	var busy, frames, checkpointed int
	if err = db.SQL.QueryRowContext(ctx, `PRAGMA wal_checkpoint(TRUNCATE)`).Scan(&busy, &frames, &checkpointed); err != nil || busy != 0 {
		t.Fatalf("initial checkpoint %d %v", busy, err)
	}
	reader, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	transaction, err := reader.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		t.Fatal(err)
	}
	defer transaction.Rollback()
	var count int
	if err = transaction.QueryRowContext(ctx, `SELECT COUNT(*) FROM sentinels`).Scan(&count); err != nil || count != 1 {
		t.Fatalf("pin reader count %d %v", count, err)
	}
	if _, err = db.SQL.ExecContext(ctx, `INSERT INTO sentinels VALUES (2,'committed-in-wal')`); err != nil {
		t.Fatal(err)
	}
	if err = db.SQL.QueryRowContext(ctx, `PRAGMA wal_checkpoint(TRUNCATE)`).Scan(&busy, &frames, &checkpointed); err != nil {
		t.Fatal(err)
	}
	t.Logf("pinned-reader checkpoint busy=%d frames=%d checkpointed=%d", busy, frames, checkpointed)
	if busy == 0 {
		t.Fatal("fixture did not block checkpoint")
	}
	if err := db.createMigrationBackup(ctx, 999); err != nil {
		t.Fatal(err)
	}
	files, err := filepath.Glob(filepath.Join(backupDir, "*.db.enc"))
	if err != nil || len(files) != 1 {
		t.Fatalf("backup files=%d err=%v", len(files), err)
	}
	if err := RestoreBackupSmoke(ctx, files[0], cipher); err != nil {
		t.Fatal(err)
	}
	restoredPath := filepath.Join(directory, "restored.db")
	output, err := os.OpenFile(restoredPath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	decryptErr := decryptMigrationBackup(ctx, files[0], output, cipher)
	closeErr := output.Close()
	if decryptErr != nil || closeErr != nil {
		t.Fatalf("restore backup: %v; close: %v", decryptErr, closeErr)
	}
	restored, err := sql.Open("sqlite", restoredPath)
	if err != nil {
		t.Fatal(err)
	}
	defer restored.Close()
	if err = restored.QueryRowContext(ctx, `SELECT COUNT(*) FROM sentinels`).Scan(&count); err != nil {
		t.Fatal(err)
	}
	t.Logf("committed_rows=2 backup_rows=%d", count)
	if count != 2 {
		t.Error("readable backup omits committed WAL row")
	}
}
