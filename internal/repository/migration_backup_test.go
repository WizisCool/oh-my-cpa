package repository

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	appcrypto "github.com/oh-my-cpa/oh-my-cpa/internal/crypto"
)

func TestMigrationBackupRecoversInterruptedAttempt(t *testing.T) {
	ctx := context.Background()
	directory := t.TempDir()
	backupDir := filepath.Join(directory, "backups")
	cipher, err := appcrypto.New("01234567890123456789012345678901")
	if err != nil {
		t.Fatal(err)
	}
	database, err := Open(ctx, filepath.Join(directory, "source.db"), WithMigrationBackup(cipher, backupDir, 2))
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	if err := database.createMigrationBackup(ctx, 57); err != nil {
		t.Fatal(err)
	}
	files, err := filepath.Glob(filepath.Join(backupDir, "*.db.enc"))
	if err != nil || len(files) != 1 {
		t.Fatalf("backups = %v, err = %v", files, err)
	}
	content, err := os.ReadFile(files[0])
	if err != nil {
		t.Fatal(err)
	}
	digest, err := os.ReadFile(files[0] + ".sha256")
	if err != nil {
		t.Fatal(err)
	}
	// Reproduce the completed files and abandoned plaintext left by repeated
	// SIGKILLs in the old writer, without requiring an actual host OOM.
	for attempt := 0; attempt < 7; attempt++ {
		path := filepath.Join(backupDir, fmt.Sprintf("oh-my-cpa-retry-%d-before-migration-57.db.enc", attempt))
		if err := writePrivateFile(path, content); err != nil {
			t.Fatal(err)
		}
		if err := writePrivateFile(path+".sha256", digest); err != nil {
			t.Fatal(err)
		}
		stamp := time.Unix(int64(attempt), 0)
		if err := os.Chtimes(path, stamp, stamp); err != nil {
			t.Fatal(err)
		}
	}
	partialPath := filepath.Join(backupDir, "oh-my-cpa-partial-before-migration-57.db.enc")
	if err := writePrivateFile(partialPath, content[:len(content)/2]); err != nil {
		t.Fatal(err)
	}
	future := time.Now().Add(time.Hour)
	if err := os.Chtimes(partialPath, future, future); err != nil {
		t.Fatal(err)
	}
	workspaces := []string{".snapshot-interrupted", ".restore-interrupted", ".migration-backup"}
	for _, workspace := range append(workspaces, "unrelated") {
		path := filepath.Join(backupDir, workspace)
		if err := os.MkdirAll(path, 0o700); err != nil {
			t.Fatal(err)
		}
		if err := writePrivateFile(filepath.Join(path, "partial.db"), []byte("partial snapshot")); err != nil {
			t.Fatal(err)
		}
	}
	database.backup.FreeSpace = func(string) (uint64, error) { return 0, nil }
	for attempt := 0; attempt < 3; attempt++ {
		err := database.createMigrationBackup(ctx, 57)
		if err == nil || !strings.Contains(err.Error(), "insufficient free space") {
			t.Fatalf("expected disk refusal, got %v", err)
		}
		files, err := filepath.Glob(filepath.Join(backupDir, "*.db.enc"))
		if err != nil || len(files) != 2 {
			t.Fatalf("retry retained %d backups, want 2: %v", len(files), err)
		}
		for _, path := range files {
			if err := RestoreBackupSmoke(ctx, path, cipher); err != nil {
				t.Fatalf("retained recovery point: %v", err)
			}
		}
		for _, workspace := range workspaces {
			if _, err := os.Stat(filepath.Join(backupDir, workspace)); !os.IsNotExist(err) {
				t.Fatalf("abandoned workspace %s remains: %v", workspace, err)
			}
		}
	}
	if _, err := os.Stat(filepath.Join(backupDir, "unrelated", "partial.db")); err != nil {
		t.Fatalf("unrelated file changed: %v", err)
	}
	database.backup.FreeSpace = func(string) (uint64, error) { return 1 << 40, nil }
	if err := database.createMigrationBackup(ctx, 57); err != nil {
		t.Fatal(err)
	}
	files, err = filepath.Glob(filepath.Join(backupDir, "*.db.enc"))
	if err != nil || len(files) != 2 {
		t.Fatalf("successful retry backups = %v, err = %v", files, err)
	}
	for _, path := range files {
		if err := RestoreBackupSmoke(ctx, path, cipher); err != nil {
			t.Fatal(err)
		}
		info, err := os.Stat(path)
		if err != nil || info.Mode().Perm() != 0o600 {
			t.Fatalf("backup permissions: %v, %v", info, err)
		}
	}
}

func TestMigrationBackupReadsLegacyEnvelope(t *testing.T) {
	ctx := context.Background()
	directory := t.TempDir()
	sourcePath := filepath.Join(directory, "source.db")
	database, err := sql.Open("sqlite", sourcePath)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := database.ExecContext(ctx, `CREATE TABLE sentinel (value TEXT); INSERT INTO sentinel VALUES ('legacy recovery point')`); err != nil {
		database.Close()
		t.Fatal(err)
	}
	if err := database.Close(); err != nil {
		t.Fatal(err)
	}
	plaintext, err := os.ReadFile(sourcePath)
	if err != nil {
		t.Fatal(err)
	}
	cipher, err := appcrypto.New("01234567890123456789012345678901")
	if err != nil {
		t.Fatal(err)
	}
	ciphertext, nonce, err := cipher.Encrypt(plaintext)
	if err != nil {
		t.Fatal(err)
	}
	content, err := json.Marshal(encryptedBackup{
		Format: "oh-my-cpa/sqlite-backup-v1", Nonce: base64.RawStdEncoding.EncodeToString(nonce),
		Ciphertext: base64.RawStdEncoding.EncodeToString(ciphertext),
	})
	if err != nil {
		t.Fatal(err)
	}
	backupPath := filepath.Join(directory, "legacy.db.enc")
	writeMigrationBackupFixture(t, backupPath, content)
	if err := RestoreBackupSmoke(ctx, backupPath, cipher); err != nil {
		t.Fatal(err)
	}
	var restored bytes.Buffer
	if err := decryptMigrationBackup(ctx, backupPath, &restored, cipher); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(restored.Bytes(), plaintext) {
		t.Fatal("legacy recovery changed the database image")
	}
}

func TestMigrationBackupStreamAuthentication(t *testing.T) {
	ctx := context.Background()
	directory := t.TempDir()
	cipher, err := appcrypto.New("01234567890123456789012345678901")
	if err != nil {
		t.Fatal(err)
	}
	otherCipher, err := appcrypto.New("abcdefghijklmnopqrstuvwxyz012345")
	if err != nil {
		t.Fatal(err)
	}
	sourcePath := filepath.Join(directory, "source.db")
	// Cross more than one age chunk, including a partial final chunk.
	plaintext := bytes.Repeat([]byte("streaming recovery\n"), 8000)
	if err := writePrivateFile(sourcePath, plaintext); err != nil {
		t.Fatal(err)
	}
	backupPath := filepath.Join(directory, "stream.db.enc")
	if err := writeMigrationBackup(ctx, sourcePath, backupPath, cipher); err != nil {
		t.Fatal(err)
	}
	var restored bytes.Buffer
	if err := decryptMigrationBackup(ctx, backupPath, &restored, cipher); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(restored.Bytes(), plaintext) {
		t.Fatal("streaming recovery changed the database image")
	}
	content, err := os.ReadFile(backupPath)
	if err != nil {
		t.Fatal(err)
	}
	for _, damage := range []string{"truncated", "modified"} {
		t.Run(damage, func(t *testing.T) {
			damaged := bytes.Clone(content)
			if damage == "truncated" {
				damaged = damaged[:len(damaged)-16]
			} else {
				damaged[len(damaged)-1] ^= 1
			}
			path := filepath.Join(directory, damage+".db.enc")
			// A fresh checksum must not bypass authenticated end-of-stream checks.
			writeMigrationBackupFixture(t, path, damaged)
			if err := decryptMigrationBackup(ctx, path, io.Discard, cipher); err == nil {
				t.Fatal("accepted damaged encrypted stream")
			}
		})
	}
	if err := decryptMigrationBackup(ctx, backupPath, io.Discard, otherCipher); err == nil {
		t.Fatal("accepted a different database cipher")
	}
	cancelled, cancel := context.WithCancel(ctx)
	cancel()
	if err := decryptMigrationBackup(cancelled, backupPath, io.Discard, cipher); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled restore: %v", err)
	}
}

func writeMigrationBackupFixture(t *testing.T, path string, content []byte) {
	t.Helper()
	if err := writePrivateFile(path, content); err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(content)
	if err := writePrivateFile(path+".sha256", []byte(hex.EncodeToString(digest[:])+"  "+filepath.Base(path)+"\n")); err != nil {
		t.Fatal(err)
	}
}

func BenchmarkMigrationBackup(b *testing.B) {
	for _, megabytes := range []int{1, 32, 384} {
		b.Run(fmt.Sprintf("%dMiB", megabytes), func(b *testing.B) {
			ctx := context.Background()
			directory := b.TempDir()
			cipher, err := appcrypto.New("01234567890123456789012345678901")
			if err != nil {
				b.Fatal(err)
			}
			database, err := Open(ctx, filepath.Join(directory, "source.db"), WithMigrationBackup(cipher, filepath.Join(directory, "backups"), 2))
			if err != nil {
				b.Fatal(err)
			}
			defer database.Close()
			if _, err := database.SQL.ExecContext(ctx, `CREATE TABLE backup_payloads (id INTEGER PRIMARY KEY, payload BLOB)`); err != nil {
				b.Fatal(err)
			}
			for range megabytes {
				if _, err := database.SQL.ExecContext(ctx, `INSERT INTO backup_payloads (payload) VALUES (zeroblob(1048576))`); err != nil {
					b.Fatal(err)
				}
			}
			b.SetBytes(int64(megabytes) << 20)
			b.ReportAllocs()
			b.ResetTimer()
			for range b.N {
				if err := database.createMigrationBackup(ctx, 57); err != nil {
					b.Fatal(err)
				}
			}
		})
	}
}
