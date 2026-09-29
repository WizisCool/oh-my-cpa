package repository

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"
)

func TestConfigBackupsKeepTheNewestAndStoreThemEncrypted(t *testing.T) {
	repo, cipher := testRepository(t)
	store := ConfigBackupStore{Repo: repo, Cipher: cipher}
	ctx := context.Background()
	start := time.UnixMilli(1_767_225_600_000)
	for i := 0; i < CONFIG_BACKUP_RETENTION+2; i++ {
		document := "port: 8317\n# copy " + strings.Repeat("x", i) + "\nsecret-key: legacy-secret\n"
		if _, err := store.Save(ctx, "http://gateway.test", document, start.Add(time.Duration(i)*time.Minute)); err != nil {
			t.Fatal(err)
		}
	}
	backups, err := store.List(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(backups) != CONFIG_BACKUP_RETENTION || backups[0].CreatedAtMS <= backups[len(backups)-1].CreatedAtMS {
		t.Fatalf("backups = %+v", backups)
	}
	var stored []byte
	if err := repo.SQL().QueryRowContext(ctx, `SELECT ciphertext FROM cpa_config_backups WHERE id = ?`, backups[0].ID).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(stored), "legacy-secret") {
		t.Fatal("backup stored in plaintext")
	}
	loaded, document, err := store.Load(ctx, backups[0].ID)
	if err != nil {
		t.Fatal(err)
	}
	if loaded.Revision != backups[0].Revision || !strings.Contains(document, "legacy-secret") || int64(len(document)) != loaded.SizeBytes {
		t.Fatalf("loaded = %+v, %q", loaded, document)
	}
	if _, err := store.Save(ctx, "http://gateway.test", strings.Repeat("x", CONFIG_BACKUP_MAX_BYTES+1), start); !errors.Is(err, ErrConfigBackupTooLarge) {
		t.Fatalf("oversized save err = %v", err)
	}
}

func TestConfigBackupsKeepOneCopyOfARetriedDocument(t *testing.T) {
	repo, cipher := testRepository(t)
	store := ConfigBackupStore{Repo: repo, Cipher: cipher}
	ctx := context.Background()
	start := time.UnixMilli(1_767_225_600_000)
	if _, err := store.Save(ctx, "http://gateway.test", "port: 1\n", start); err != nil {
		t.Fatal(err)
	}
	first, err := store.Save(ctx, "http://gateway.test", "port: 2\n", start)
	if err != nil {
		t.Fatal(err)
	}
	// Every save CPA refuses leaves the same legacy file behind and retries.
	for i := 0; i < CONFIG_BACKUP_RETENTION+2; i++ {
		again, err := store.Save(ctx, "http://gateway.test", "port: 2\n", start.Add(time.Duration(i+1)*time.Minute))
		if err != nil {
			t.Fatal(err)
		}
		if again.ID != first.ID {
			t.Fatalf("retry %d stored a new copy: %+v", i, again)
		}
	}
	// Another gateway's identical file is its own copy.
	if other, err := store.Save(ctx, "http://other.test", "port: 2\n", start); err != nil || other.ID == first.ID {
		t.Fatalf("other gateway = %+v, %v", other, err)
	}
	backups, err := store.List(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(backups) != 3 {
		t.Fatalf("backups = %+v", backups)
	}
}
