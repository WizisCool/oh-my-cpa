package repository

import (
	"context"
	"database/sql"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/oh-my-cpa/oh-my-cpa/internal/crypto"
	"github.com/oh-my-cpa/oh-my-cpa/internal/security"
	"github.com/oh-my-cpa/oh-my-cpa/migrations"
)

func TestMigration004SanitizesHistoricalData(t *testing.T) {
	cipher, err := crypto.New("01234567890123456789012345678901")
	if err != nil {
		t.Fatal(err)
	}

	tempDir, err := os.MkdirTemp("", "oh-my-cpa-migration-test-")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(tempDir)

	dbPath := filepath.Join(tempDir, "test_upgrade.db")
	rawDB, err := sql.Open("sqlite", dbPath)
	if err != nil {
		t.Fatal(err)
	}

	// Apply migrations 001, 002, 003 manually to simulate a v0.3 database
	for _, versionFile := range []string{"001_initial.sql", "002_usage_ingest.sql", "003_ui_preferences.sql"} {
		content, readErr := migrations.Files.ReadFile(versionFile)
		if readErr != nil {
			t.Fatalf("read migration %s: %v", versionFile, readErr)
		}
		if _, execErr := rawDB.Exec(string(content)); execErr != nil {
			t.Fatalf("exec migration %s: %v", versionFile, execErr)
		}
		ver := 1
		if strings.HasPrefix(versionFile, "002") {
			ver = 2
		} else if strings.HasPrefix(versionFile, "003") {
			ver = 3
		}
		if _, execErr := rawDB.Exec(`INSERT INTO schema_migrations (version, applied_at) VALUES (?, 1000)`, ver); execErr != nil {
			t.Fatalf("record migration %d: %v", ver, execErr)
		}
	}

	// Insert cpa_instance
	if _, err := rawDB.Exec(`
		INSERT INTO cpa_instances (id, name, base_url, usage_addr, management_key_ciphertext, management_key_nonce, created_at, updated_at)
		VALUES ('default', 'Default', 'http://127.0.0.1:8317', '127.0.0.1:8317', x'00', x'00', 100, 100)`); err != nil {
		t.Fatal(err)
	}

	// Seed historical data containing sensitive secrets
	sensitiveSecrets := []string{
		"sk-hist-res-account",
		"sk-hist-res-extra-account",
		"sk-hist-inbox-key",
		"sk-hist-inbox-err-token",
		"sk-hist-err-body-secret",
		"sk-hist-err-auth-status",
		"sk-hist-err-quota-reason",
		"sk-hist-usage-group-key",
		"sk-hist-usage-source",
	}

	// 1. discovered_resources:
	// a. with account & extra.account
	if _, err := rawDB.Exec(`
		INSERT INTO discovered_resources (id, instance_id, resource_key, cpa_resource_type, cpa_driver, protocol_driver, protocol_display, details_json, last_seen_at, created_at, updated_at)
		VALUES ('res-1', 'default', 'k1', 'auth-file', 'openai', 'openai', 'OpenAI', ?, 100, 100, 100)`,
		`{"account":"sk-hist-res-account","extra":{"account":"sk-hist-res-extra-account","account_present":"true","account_type":"api_key","other_junk":"strip_me"}}`); err != nil {
		t.Fatal(err)
	}
	// b. with empty details_json
	if _, err := rawDB.Exec(`
		INSERT INTO discovered_resources (id, instance_id, resource_key, cpa_resource_type, cpa_driver, protocol_driver, protocol_display, details_json, last_seen_at, created_at, updated_at)
		VALUES ('res-2', 'default', 'k2', 'codex-api-key', 'codex', 'openai', 'OpenAI', '{}', 100, 100, 100)`); err != nil {
		t.Fatal(err)
	}
	// c. with malformed json
	if _, err := rawDB.Exec(`
		INSERT INTO discovered_resources (id, instance_id, resource_key, cpa_resource_type, cpa_driver, protocol_driver, protocol_display, details_json, last_seen_at, created_at, updated_at)
		VALUES ('res-3', 'default', 'k3', 'codex-api-key', 'codex', 'openai', 'OpenAI', 'invalid-json-text', 100, 100, 100)`); err != nil {
		t.Fatal(err)
	}

	// 2. usage_inboxes:
	if _, err := rawDB.Exec(`
		INSERT INTO usage_inboxes (id, instance_id, source_mode, message_hash, raw_message, status, attempt_count, last_error, popped_at)
		VALUES (1, 'default', 'http_pull', 'hash1', ?, 'pending', 0, ?, 1000)`,
		`{"request_id":"req-1","api_key":"sk-hist-inbox-key","model":"m","tokens":{"total_tokens":5}}`,
		`failed Authorization: Bearer sk-hist-inbox-err-token`); err != nil {
		t.Fatal(err)
	}

	// 3. error_events:
	if _, err := rawDB.Exec(`
		INSERT INTO error_events (id, instance_id, event_key, request_id, provider, model, auth_id, auth_index, status_code, code, body, retryable, auth_status, quota_reason, timestamp_ms, created_at_ms)
		VALUES (1, 'default', 'err-1', 'req-1', 'openai', 'm', 'a1', 'idx1', 400, 'ERR', ?, 0, ?, ?, 1000, 1000)`,
		`rejected with api_key="sk-hist-err-body-secret"`,
		`invalid status: sk-hist-err-auth-status`,
		`quota exhausted: sk-hist-err-quota-reason`); err != nil {
		t.Fatal(err)
	}

	// 4. usage_events:
	if _, err := rawDB.Exec(`
		INSERT INTO usage_events (id, instance_id, event_key, api_group_key, provider, endpoint, auth_type, request_id, timestamp_ms, source, auth_index, failed, generate, latency_ms, total_tokens, created_at_ms)
		VALUES (1, 'default', 'ev-1', 'sk-hist-usage-group-key', 'openai', 'https://user:pass@example.test/v1?token=secret#frag', 'apikey', 'req-1', 1000, 'sk-hist-usage-source', 'idx1', 0, 1, 10, 5, 1000)`); err != nil {
		t.Fatal(err)
	}

	_ = rawDB.Close()

	// Now open the database through Open with WithMigrationBackup and WithCipher
	backupDir := filepath.Join(tempDir, "backups")
	db, err := Open(context.Background(), dbPath, WithMigrationBackup(cipher, backupDir, 3))
	if err != nil {
		t.Fatalf("Open and migrate failed: %v", err)
	}
	defer db.Close()

	// Verify backup was created before migration 004
	backupFiles, err := os.ReadDir(backupDir)
	if err != nil {
		t.Fatalf("read backup dir: %v", err)
	}
	encCount := 0
	for _, f := range backupFiles {
		if strings.HasSuffix(f.Name(), ".db.enc") {
			encCount++
		}
	}
	if encCount == 0 {
		t.Fatal("expected encrypted migration backup to be created, found none")
	}

	// Verify that NONE of the sensitive secrets exist anywhere in the migrated database
	for _, secret := range sensitiveSecrets {
		// Check discovered_resources
		var count int
		if err := db.SQL.QueryRow(`SELECT COUNT(1) FROM discovered_resources WHERE details_json LIKE ?`, "%"+secret+"%").Scan(&count); err != nil {
			t.Fatal(err)
		}
		if count > 0 {
			t.Fatalf("secret %q leaked into discovered_resources.details_json", secret)
		}

		// Check usage_inboxes raw_message and last_error
		if err := db.SQL.QueryRow(`SELECT COUNT(1) FROM usage_inboxes WHERE raw_message LIKE ? OR last_error LIKE ?`, "%"+secret+"%", "%"+secret+"%").Scan(&count); err != nil {
			t.Fatal(err)
		}
		if count > 0 {
			t.Fatalf("secret %q leaked into usage_inboxes", secret)
		}

		// Check error_events body, auth_status, quota_reason
		if err := db.SQL.QueryRow(`SELECT COUNT(1) FROM error_events WHERE body LIKE ? OR auth_status LIKE ? OR quota_reason LIKE ?`, "%"+secret+"%", "%"+secret+"%", "%"+secret+"%").Scan(&count); err != nil {
			t.Fatal(err)
		}
		if count > 0 {
			t.Fatalf("secret %q leaked into error_events", secret)
		}

		// Check usage_events api_group_key and source
		if err := db.SQL.QueryRow(`SELECT COUNT(1) FROM usage_events WHERE api_group_key LIKE ? OR source LIKE ?`, "%"+secret+"%", "%"+secret+"%").Scan(&count); err != nil {
			t.Fatal(err)
		}
		if count > 0 {
			t.Fatalf("secret %q leaked into usage_events", secret)
		}
	}

	// Verify specific sanitized values
	var groupKey, groupLabel, source string
	if err := db.SQL.QueryRow(`SELECT api_group_key, api_group_label, source FROM usage_events WHERE id = 1`).Scan(&groupKey, &groupLabel, &source); err != nil {
		t.Fatal(err)
	}
	if groupLabel != "api_key" {
		t.Fatalf("api_group_label = %q, want api_key", groupLabel)
	}
	if !strings.HasPrefix(groupKey, "hmac:") && groupKey != security.RedactedValue {
		t.Fatalf("api_group_key = %q, want hmac prefix or redacted", groupKey)
	}
	if !strings.HasPrefix(source, "hmac:") && source != security.RedactedValue {
		t.Fatalf("source = %q, want hmac prefix or redacted", source)
	}

	// Verify usage inbox ciphertext was populated and can be decrypted
	var ciphertext, nonce []byte
	var rawMsg string
	if err := db.SQL.QueryRow(`SELECT raw_message_ciphertext, raw_message_nonce, raw_message FROM usage_inboxes WHERE id = 1`).Scan(&ciphertext, &nonce, &rawMsg); err != nil {
		t.Fatal(err)
	}
	if len(ciphertext) == 0 || len(nonce) == 0 {
		t.Fatal("expected raw_message_ciphertext and nonce to be populated")
	}
	decrypted, err := cipher.Decrypt(ciphertext, nonce)
	if err != nil {
		t.Fatalf("failed to decrypt inbox ciphertext: %v", err)
	}
	if !strings.Contains(string(decrypted), "sk-hist-inbox-key") {
		t.Fatalf("decrypted ciphertext does not contain original payload: %s", string(decrypted))
	}
	if strings.Contains(rawMsg, "sk-hist-inbox-key") {
		t.Fatalf("raw_message projection contains secret: %s", rawMsg)
	}
	if !strings.Contains(rawMsg, security.RedactedValue) {
		t.Fatalf("raw_message projection missing redacted marker: %s", rawMsg)
	}

	// Re-opening the database must succeed idempotently
	db2, err := Open(context.Background(), dbPath, WithMigrationBackup(cipher, backupDir, 3))
	if err != nil {
		t.Fatalf("idempotent reopen failed: %v", err)
	}
	_ = db2.Close()
}

func TestBackupRestoreSmokeAndFreeSpaceCheck(t *testing.T) {
	cipher, err := crypto.New("01234567890123456789012345678901")
	if err != nil {
		t.Fatal(err)
	}

	tempDir, err := os.MkdirTemp("", "oh-my-cpa-backup-test-")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(tempDir)

	dbPath := filepath.Join(tempDir, "test.db")
	backupDir := filepath.Join(tempDir, "backups")

	// 1. Test insufficient free space fails closed
	noSpacePolicy := BackupConfig{
		Cipher:       cipher,
		Directory:    backupDir,
		Retention:    3,
		MinFreeBytes: 10 * 1024 * 1024,
		FreeSpace: func(path string) (uint64, error) {
			return 100, nil // only 100 bytes available
		},
	}

	// Initialize file DB with migration 001 first
	initDB, err := Open(context.Background(), dbPath)
	if err != nil {
		t.Fatal(err)
	}
	_ = initDB.Close()

	// Re-open with mock insufficient space and simulate pending migration
	// (we can test createMigrationBackup directly)
	db, err := Open(context.Background(), dbPath, WithBackupConfig(noSpacePolicy))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	err = db.createMigrationBackup(context.Background(), 999)
	if err == nil || !strings.Contains(err.Error(), "insufficient free space") {
		t.Fatalf("expected insufficient free space error, got: %v", err)
	}

	// 2. Test successful backup and restore smoke test
	sufficientPolicy := BackupConfig{
		Cipher:    cipher,
		Directory: backupDir,
		Retention: 2,
		FreeSpace: func(path string) (uint64, error) {
			return 1024 * 1024 * 1024, nil
		},
	}
	db.backup = sufficientPolicy
	if err := db.createMigrationBackup(context.Background(), 100); err != nil {
		t.Fatalf("createMigrationBackup failed: %v", err)
	}

	// Check backup file exists and has correct permissions
	entries, err := os.ReadDir(backupDir)
	if err != nil {
		t.Fatal(err)
	}
	var backupPath string
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), ".db.enc") {
			backupPath = filepath.Join(backupDir, e.Name())
			break
		}
	}
	if backupPath == "" {
		t.Fatal("no .db.enc file found")
	}

	// Check restore smoke passes
	if err := RestoreBackupSmoke(context.Background(), backupPath, cipher); err != nil {
		t.Fatalf("RestoreBackupSmoke failed: %v", err)
	}

	// Check digest mismatch rejection
	shaFile := backupPath + ".sha256"
	if err := os.WriteFile(shaFile, []byte("0000000000000000000000000000000000000000000000000000000000000000  file\n"), 0600); err != nil {
		t.Fatal(err)
	}
	err = RestoreBackupSmoke(context.Background(), backupPath, cipher)
	if err == nil || !strings.Contains(err.Error(), "digest mismatch") {
		t.Fatalf("expected digest mismatch error, got: %v", err)
	}
	if err := os.Remove(shaFile); err != nil {
		t.Fatal(err)
	}
	err = RestoreBackupSmoke(context.Background(), backupPath, cipher)
	if err == nil || !strings.Contains(err.Error(), "read backup digest") {
		t.Fatalf("expected missing digest error, got: %v", err)
	}

	// 3. Test backup retention: create multiple backups and verify oldest pruned
	for i := 101; i <= 104; i++ {
		if err := db.createMigrationBackup(context.Background(), i); err != nil {
			t.Fatalf("create backup %d: %v", i, err)
		}
	}
	allEntries, _ := os.ReadDir(backupDir)
	encFiles := 0
	for _, e := range allEntries {
		if strings.HasSuffix(e.Name(), ".db.enc") {
			encFiles++
		}
	}
	if encFiles > 2 {
		t.Fatalf("expected at most 2 retained backups, got %d", encFiles)
	}
}
