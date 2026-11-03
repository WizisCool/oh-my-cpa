package backup

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	appcrypto "github.com/oh-my-cpa/oh-my-cpa/internal/crypto"
	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
)

func TestOfflineCommandRestoresCleanDirectoryAndItsPreRestoreCopy(t *testing.T) {
	ctx := context.Background()
	directory := t.TempDir()
	path := filepath.Join(directory, "source.db")
	masterKey := "backup-test-master-key-0123456789abcdef"
	cipher := testCipher(t)
	database, err := repository.Open(ctx, path, repository.WithCipher(cipher))
	if err != nil {
		t.Fatal(err)
	}
	setBackupTestValue(t, database, "exported")
	setBackupTestMigrationHistory(t, database)
	database.Close()
	passwordFile := filepath.Join(directory, "passphrase")
	if err := os.WriteFile(passwordFile, []byte("offline recovery passphrase\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	archive := filepath.Join(directory, "backup.omcbackup")
	var output bytes.Buffer
	if err := RunCommand(ctx, path, masterKey, "test", []string{"export", "--output", archive, "--passphrase-file", passwordFile}, &output); err != nil {
		t.Fatal(err)
	}
	targetKey := "target-deployment-key-0123456789abcdef"
	wrapping, _ := appcrypto.New(targetKey)
	cleanPath := filepath.Join(directory, "recovered.db")
	if err := RunCommand(ctx, cleanPath, "", "test", []string{"inspect", "--file", archive, "--passphrase-file", passwordFile}, &output); err != nil {
		t.Fatal(err)
	}
	if err := RunCommand(ctx, cleanPath, targetKey, "test", []string{"restore", "--file", archive, "--passphrase-file", passwordFile, "--confirm"}, &output); err != nil {
		t.Fatal(err)
	}
	recoveredCipher, err := ResolveCipher(cleanPath, wrapping)
	if err != nil {
		t.Fatal(err)
	}
	identity, _ := cipher.Fingerprint("usage-client-key", "fixture")
	resolvedIdentity, _ := recoveredCipher.Fingerprint("usage-client-key", "fixture")
	if identity != resolvedIdentity {
		t.Fatal("cross-deployment recovery changed identity")
	}
	portableAgain := filepath.Join(directory, "reexported.omcbackup")
	if err := RunCommand(ctx, cleanPath, targetKey, "test", []string{"export", "--output", portableAgain, "--passphrase-file", passwordFile}, &output); err != nil {
		t.Fatal(err)
	}
	archive = portableAgain
	recovered, err := repository.Open(ctx, cleanPath, repository.WithCipher(recoveredCipher))
	if err != nil {
		t.Fatal(err)
	}
	checkBackupTestMigrationHistory(t, recovered)
	if backupTestValue(t, recovered) != "exported" {
		t.Fatal("clean-directory recovery lost data")
	}
	setBackupTestValue(t, recovered, "before-second-restore")
	if _, err := recovered.SQL.Exec(`CREATE TRIGGER reject_offline_restore_audit BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT,'audit unavailable'); END`); err != nil {
		t.Fatal(err)
	}
	recovered.Close()
	if err := RunCommand(ctx, cleanPath, targetKey, "test", []string{"restore", "--file", archive, "--passphrase-file", passwordFile, "--confirm"}, &output); !errors.Is(err, ErrAudit) {
		t.Fatalf("offline restore audit refusal: %v", err)
	}
	recovered, err = repository.Open(ctx, cleanPath, repository.WithCipher(recoveredCipher))
	if err != nil {
		t.Fatal(err)
	}
	if backupTestValue(t, recovered) != "before-second-restore" {
		t.Fatal("refused offline restore changed the database")
	}
	if _, err := recovered.SQL.Exec(`DROP TRIGGER reject_offline_restore_audit`); err != nil {
		t.Fatal(err)
	}
	recovered.Close()
	output.Reset()
	if err := RunCommand(ctx, cleanPath, targetKey, "test", []string{"restore", "--file", archive, "--passphrase-file", passwordFile, "--confirm"}, &output); err != nil {
		t.Fatal(err)
	}
	id := strings.TrimSpace(strings.TrimPrefix(output.String(), "Database restored:"))
	if !validID(id) {
		t.Fatalf("restore id: %q", output.String())
	}
	if err := RunCommand(ctx, cleanPath, targetKey, "test", []string{"restore", "--rollback-id", id, "--confirm"}, &output); err != nil {
		t.Fatal(err)
	}
	previous, err := repository.Open(ctx, cleanPath, repository.WithCipher(recoveredCipher))
	if err != nil {
		t.Fatal(err)
	}
	defer previous.Close()
	checkBackupTestMigrationHistory(t, previous)
	if backupTestValue(t, previous) != "before-second-restore" {
		t.Fatal("offline rollback lost the previous database")
	}
	if strings.Contains(output.String(), targetKey) || strings.Contains(output.String(), masterKey) || strings.Contains(output.String(), "offline recovery passphrase") {
		t.Fatal("CLI exposed key material")
	}
}
