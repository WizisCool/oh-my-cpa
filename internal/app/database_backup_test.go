package app

import (
	"bytes"
	"context"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"testing"

	"github.com/oh-my-cpa/oh-my-cpa/internal/backup"
	"github.com/oh-my-cpa/oh-my-cpa/internal/config"
	appcrypto "github.com/oh-my-cpa/oh-my-cpa/internal/crypto"
	"github.com/oh-my-cpa/oh-my-cpa/internal/domain"
	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
)

func TestApplicationAppliesConfirmedBackupBeforeStartingServices(t *testing.T) {
	ctx := context.Background()
	directory := t.TempDir()
	master := "app-backup-test-master-key-0123456789"
	t.Setenv("OMCPA_MASTER_KEY", master)
	t.Setenv("OMCPA_DATA_DIR", directory)
	t.Setenv("OMCPA_USAGE_INGEST_MODE", "off")
	t.Setenv("OMCPA_UPDATE_CHECK_ENABLED", "false")
	cfg, err := config.Load()
	if err != nil {
		t.Fatal(err)
	}
	cfg.CPA.ManagementKey = ""
	cfg.DatabasePath = filepath.Join(directory, "source.db")
	cipher, _ := appcrypto.New(master)
	database, err := repository.Open(ctx, cfg.DatabasePath, repository.WithCipher(cipher))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := database.SQL.Exec(`INSERT INTO ui_preferences(pref_key,pref_value,updated_at_ms) VALUES('startup-backup','saved',1)`); err != nil {
		t.Fatal(err)
	}
	ciphertext, nonce, err := cipher.Encrypt([]byte("fixture database secret"))
	if err != nil {
		t.Fatal(err)
	}
	sourceRepo := repository.New(database)
	if err := sourceRepo.UpsertInstance(ctx, domain.CPAInstance{ID: "backup-fixture", Name: "Backup fixture", BaseURL: "http://cpa.test", ManagementKeyCiphertext: ciphertext, ManagementKeyNonce: nonce}); err != nil {
		t.Fatal(err)
	}
	identity, err := sourceRepo.UsageClientKeyFingerprint("fixture-client-key")
	if err != nil {
		t.Fatal(err)
	}
	database.Close()
	passwordPath := filepath.Join(directory, "passphrase")
	os.WriteFile(passwordPath, []byte("application recovery passphrase"), 0o600)
	artifact := filepath.Join(directory, "backup.omcbackup")
	if err := backup.RunCommand(ctx, cfg.DatabasePath, master, "test", []string{"export", "--output", artifact, "--passphrase-file", passwordPath}, io.Discard); err != nil {
		t.Fatal(err)
	}
	cfg.DatabasePath = filepath.Join(directory, "target.db")
	cfg.MasterKey = "different-target-master-key-0123456789abcdef"
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	application, err := New(ctx, cfg, logger)
	if err != nil {
		t.Fatal(err)
	}
	if other, err := New(ctx, cfg, logger); err == nil {
		other.Close()
		t.Fatal("second database owner admitted")
	}
	if _, err := application.db.SQL.Exec(`INSERT INTO ui_preferences(pref_key,pref_value,updated_at_ms) VALUES('startup-backup','changed',1)`); err != nil {
		t.Fatal(err)
	}
	encoded, err := os.ReadFile(artifact)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := application.databaseBackups.StageImport(ctx, bytes.NewReader(encoded), "incorrect passphrase"); err == nil {
		t.Fatal("wrong passphrase admitted")
	}
	if _, err := os.Stat(cfg.DatabasePath + ".key"); !os.IsNotExist(err) {
		t.Fatal("rejected import changed active key")
	}
	input, err := os.Open(artifact)
	if err != nil {
		t.Fatal(err)
	}
	job, err := application.databaseBackups.StageImport(ctx, input, "application recovery passphrase")
	input.Close()
	if err != nil {
		t.Fatal(err)
	}
	if err := application.databaseBackups.Apply(ctx, job.ID, job.Digest); err != nil {
		t.Fatal(err)
	}
	if err := application.Close(); err != nil {
		t.Fatal(err)
	}
	restored, err := New(ctx, cfg, logger)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { restored.Close() })
	var value string
	if err := restored.db.SQL.QueryRow(`SELECT pref_value FROM ui_preferences WHERE pref_key='startup-backup'`).Scan(&value); err != nil || value != "saved" {
		t.Fatalf("startup data %q: %v", value, err)
	}
	result, err := restored.databaseBackups.Get(job.ID)
	if err != nil || result.State != "completed" {
		t.Fatalf("startup status %+v: %v", result, err)
	}
	for range 2 {
		instance, err := restored.repo.GetInstance(ctx, "backup-fixture")
		if err != nil {
			t.Fatal(err)
		}
		plaintext, err := restored.cipher.Decrypt(instance.ManagementKeyCiphertext, instance.ManagementKeyNonce)
		if err != nil || string(plaintext) != "fixture database secret" {
			t.Fatalf("restored secret is unusable: %v", err)
		}
		actualIdentity, err := restored.repo.UsageClientKeyFingerprint("fixture-client-key")
		if err != nil || actualIdentity != identity {
			t.Fatalf("restored history identity changed: %v", err)
		}
		if err := restored.Close(); err != nil {
			t.Fatal(err)
		}
		restored, err = New(ctx, cfg, logger)
		if err != nil {
			t.Fatal(err)
		}
	}
	if err := restored.Close(); err != nil {
		t.Fatal(err)
	}
	if err := backup.RunCommand(ctx, cfg.DatabasePath, cfg.MasterKey, "test", []string{"restore", "--rollback-id", job.ID, "--confirm"}, io.Discard); err != nil {
		t.Fatal(err)
	}
	restored, err = New(ctx, cfg, logger)
	if err != nil {
		t.Fatal(err)
	}
	if err := restored.db.SQL.QueryRow(`SELECT pref_value FROM ui_preferences WHERE pref_key='startup-backup'`).Scan(&value); err != nil || value != "changed" {
		t.Fatalf("rollback data %q: %v", value, err)
	}
	targetCipher, _ := appcrypto.New(cfg.MasterKey)
	wantIdentity, _ := targetCipher.Fingerprint("rollback-fixture")
	actualIdentity, _ := restored.cipher.Fingerprint("rollback-fixture")
	if wantIdentity != actualIdentity {
		t.Fatal("rollback did not restore the previous database key")
	}

}
