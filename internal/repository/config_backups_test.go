package repository

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"
)

func v8Backup(gateway, document string) ConfigBackupInput {
	return ConfigBackupInput{GatewayURL: gateway, Document: document, Layout: ConfigLayoutV8, Reason: "config_changes"}
}

func TestConfigBackupsKeepTheNewestAndStoreThemEncrypted(t *testing.T) {
	repo, cipher := testRepository(t)
	store := ConfigBackupStore{Repo: repo, Cipher: cipher}
	ctx := context.Background()
	start := time.UnixMilli(1_767_225_600_000)
	for i := 0; i < CONFIG_BACKUP_RETENTION_DEFAULT+2; i++ {
		document := "config-version: 8\n# copy " + strings.Repeat("x", i) + "\nsecret-key: stored-secret\n"
		if _, isCreated, err := store.Save(ctx, v8Backup("http://gateway.test", document), start.Add(time.Duration(i)*time.Minute)); err != nil || !isCreated {
			t.Fatal(isCreated, err)
		}
	}
	backups, err := store.List(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(backups) != CONFIG_BACKUP_RETENTION_DEFAULT || backups[0].CreatedAtMS <= backups[len(backups)-1].CreatedAtMS {
		t.Fatalf("backups = %+v", backups)
	}
	if backups[0].Layout != ConfigLayoutV8 || backups[0].Reason != "config_changes" {
		t.Fatalf("newest = %+v", backups[0])
	}
	var stored []byte
	if err := repo.SQL().QueryRowContext(ctx, `SELECT ciphertext FROM cpa_config_backups WHERE id = ?`, backups[0].ID).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(stored), "stored-secret") {
		t.Fatal("backup stored in plaintext")
	}
	loaded, document, err := store.Load(ctx, backups[0].ID)
	if err != nil {
		t.Fatal(err)
	}
	if loaded.Revision != backups[0].Revision || !strings.Contains(document, "stored-secret") || int64(len(document)) != loaded.SizeBytes {
		t.Fatalf("loaded = %+v, %q", loaded, document)
	}
	if _, _, err := store.Save(ctx, v8Backup("http://gateway.test", strings.Repeat("x", CONFIG_BACKUP_MAX_BYTES+1)), start); !errors.Is(err, ErrConfigBackupTooLarge) {
		t.Fatalf("oversized save err = %v", err)
	}
}

func TestConfigBackupsKeepOneCopyOfARetriedDocument(t *testing.T) {
	repo, cipher := testRepository(t)
	store := ConfigBackupStore{Repo: repo, Cipher: cipher}
	ctx := context.Background()
	start := time.UnixMilli(1_767_225_600_000)
	if _, _, err := store.Save(ctx, v8Backup("http://gateway.test", "port: 1\n"), start); err != nil {
		t.Fatal(err)
	}
	first, _, err := store.Save(ctx, v8Backup("http://gateway.test", "port: 2\n"), start)
	if err != nil {
		t.Fatal(err)
	}
	// Every write CPA refuses leaves the same file behind and retries.
	for i := 0; i < CONFIG_BACKUP_RETENTION_DEFAULT+2; i++ {
		again, isCreated, err := store.Save(ctx, v8Backup("http://gateway.test", "port: 2\n"), start.Add(time.Duration(i+1)*time.Minute))
		if err != nil {
			t.Fatal(err)
		}
		if isCreated || again.ID != first.ID {
			t.Fatalf("retry %d stored a new copy: %+v", i, again)
		}
	}
	// Another gateway's identical file is its own copy.
	if other, isCreated, err := store.Save(ctx, v8Backup("http://other.test", "port: 2\n"), start); err != nil || !isCreated || other.ID == first.ID {
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

func TestEverydayWritesDoNotPushOutTheLegacyCopy(t *testing.T) {
	repo, cipher := testRepository(t)
	store := ConfigBackupStore{Repo: repo, Cipher: cipher}
	ctx := context.Background()
	start := time.UnixMilli(1_767_225_600_000)
	legacy, _, err := store.Save(ctx, ConfigBackupInput{GatewayURL: "http://gateway.test", Document: "port: 8317\n", Layout: ConfigLayoutLegacy, Reason: "config_changes"}, start)
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < CONFIG_BACKUP_RETENTION_MAX+5; i++ {
		document := "config-version: 8\n# " + strings.Repeat("x", i) + "\n"
		if _, _, err := store.Save(ctx, v8Backup("http://gateway.test", document), start.Add(time.Duration(i+1)*time.Second)); err != nil {
			t.Fatal(err)
		}
	}
	backups, err := store.List(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(backups) != CONFIG_BACKUP_RETENTION_DEFAULT+1 || backups[len(backups)-1].ID != legacy.ID {
		t.Fatalf("backups = %d, oldest = %+v", len(backups), backups[len(backups)-1])
	}
}

func TestConfigBackupRetentionIsTheOperatorsAndAppliesAtOnce(t *testing.T) {
	repo, cipher := testRepository(t)
	store := ConfigBackupStore{Repo: repo, Cipher: cipher}
	ctx := context.Background()
	settings, err := store.Settings(ctx)
	if err != nil || settings.Retention != CONFIG_BACKUP_RETENTION_DEFAULT || settings.RetentionMin != CONFIG_BACKUP_RETENTION_MIN || settings.RetentionMax != CONFIG_BACKUP_RETENTION_MAX {
		t.Fatalf("settings = %+v, %v", settings, err)
	}
	start := time.UnixMilli(1_767_225_600_000)
	for i := 0; i < 12; i++ {
		if _, _, err := store.Save(ctx, v8Backup("http://gateway.test", "config-version: 8\n#"+strings.Repeat("x", i)+"\n"), start); err != nil {
			t.Fatal(err)
		}
	}
	for _, retention := range []int{CONFIG_BACKUP_RETENTION_MIN - 1, CONFIG_BACKUP_RETENTION_MAX + 1} {
		if _, err := store.SetRetention(ctx, retention); !errors.Is(err, ErrConfigBackupRetention) {
			t.Fatalf("retention %d err = %v", retention, err)
		}
	}
	if settings, err = store.SetRetention(ctx, 8); err != nil || settings.Retention != 8 {
		t.Fatalf("settings = %+v, %v", settings, err)
	}
	backups, err := store.List(ctx)
	if err != nil || len(backups) != 8 {
		t.Fatalf("backups = %d, %v", len(backups), err)
	}
	// The next write keeps the chosen count as well.
	if _, _, err := store.Save(ctx, v8Backup("http://gateway.test", "config-version: 8\n# newest\n"), start); err != nil {
		t.Fatal(err)
	}
	if backups, err = store.List(ctx); err != nil || len(backups) != 8 {
		t.Fatalf("backups = %d, %v", len(backups), err)
	}
}

func TestConfigBackupDeleteRemovesOneCopy(t *testing.T) {
	repo, cipher := testRepository(t)
	store := ConfigBackupStore{Repo: repo, Cipher: cipher}
	ctx := context.Background()
	backup, _, err := store.Save(ctx, v8Backup("http://gateway.test", "config-version: 8\n"), time.UnixMilli(1_767_225_600_000))
	if err != nil {
		t.Fatal(err)
	}
	deleted, err := store.Delete(ctx, backup.ID)
	if err != nil || deleted.ID != backup.ID || deleted.Revision != backup.Revision {
		t.Fatalf("deleted = %+v, %v", deleted, err)
	}
	if _, err := store.Delete(ctx, backup.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("second delete err = %v", err)
	}
	if _, _, err := store.Load(ctx, backup.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("load after delete err = %v", err)
	}
}
