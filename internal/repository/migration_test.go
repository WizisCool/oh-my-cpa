package repository

import (
	"context"
	"database/sql"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/crypto"
	"github.com/oh-my-cpa/oh-my-cpa/internal/pricing"
	"github.com/oh-my-cpa/oh-my-cpa/internal/security"
	"github.com/oh-my-cpa/oh-my-cpa/internal/usage"
	"github.com/oh-my-cpa/oh-my-cpa/migrations"
)

func TestFailureCodeMigrationLeavesHistoricalClassificationUnknown(t *testing.T) {
	ctx := context.Background()
	cipher, err := crypto.New("01234567890123456789012345678901")
	if err != nil {
		t.Fatal(err)
	}
	directory := t.TempDir()
	db, err := Open(ctx, filepath.Join(directory, "failure-upgrade.db"), withMigrationsUntil(57),
		WithMigrationBackup(cipher, filepath.Join(directory, "backups"), 3))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := db.SQL.ExecContext(ctx, `INSERT INTO cpa_instances
		(id, name, base_url, usage_addr, management_key_ciphertext, management_key_nonce, created_at, updated_at)
		VALUES ('default', 'Default', 'http://127.0.0.1:8317', '', x'00', x'00', 0, 0)`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.SQL.ExecContext(ctx, `INSERT INTO usage_events
		(instance_id, event_key, api_group_key, request_id, failed, fail_status_code, fail_body, timestamp_ms, created_at_ms)
		VALUES ('default', 'historical-failure', '', 'historical-failure', 1, 400, 'request_scoped', 1234, 2345)`); err != nil {
		t.Fatal(err)
	}
	db.migrateUntil = 0
	if err := db.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	var code, body string
	var status int
	if err := db.SQL.QueryRowContext(ctx, `SELECT fail_code, fail_status_code, fail_body FROM usage_events`).Scan(&code, &status, &body); err != nil {
		t.Fatal(err)
	}
	if code != "" || status != 400 || body != "request_scoped" {
		t.Fatalf("historical evidence changed: %q %d %q", code, status, body)
	}
}

func TestFailureCodeMigrationPreservesExistingEvidence(t *testing.T) {
	ctx := context.Background()
	cipher, err := crypto.New("01234567890123456789012345678901")
	if err != nil {
		t.Fatal(err)
	}
	directory := t.TempDir()
	db, err := Open(ctx, filepath.Join(directory, "failure-code-upgrade.db"), withMigrationsUntil(61),
		WithMigrationBackup(cipher, filepath.Join(directory, "backups"), 3))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := db.SQL.ExecContext(ctx, `INSERT INTO cpa_instances
		(id, name, base_url, usage_addr, management_key_ciphertext, management_key_nonce, created_at, updated_at)
		VALUES ('default', 'Default', 'http://127.0.0.1:8317', '', x'00', x'00', 0, 0)`); err != nil {
		t.Fatal(err)
	}
	for _, code := range []string{"", "request_scoped", "stream_truncated"} {
		if _, err := db.SQL.ExecContext(ctx, `INSERT INTO usage_events
			(instance_id, event_key, api_group_key, request_id, failed, fail_code, fail_status_code, fail_body, timestamp_ms, created_at_ms)
			VALUES ('default', ?, '', ?, 1, ?, 429, 'original evidence', 1234, 2345)`, code, code, code); err != nil {
			t.Fatal(err)
		}
	}

	schemaObjects := func() map[string]string {
		t.Helper()
		rows, err := db.SQL.QueryContext(ctx, `SELECT name, sql FROM sqlite_schema
			WHERE tbl_name = 'usage_events' AND type IN ('index', 'trigger') AND sql IS NOT NULL`)
		if err != nil {
			t.Fatal(err)
		}
		defer rows.Close()
		objects := map[string]string{}
		for rows.Next() {
			var name, definition string
			if err := rows.Scan(&name, &definition); err != nil {
				t.Fatal(err)
			}
			objects[name] = definition
		}
		if err := rows.Err(); err != nil {
			t.Fatal(err)
		}
		return objects
	}
	before := schemaObjects()
	db.migrateUntil = 0
	if err := db.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	after := schemaObjects()
	// 065 reshapes usage_cost_no_reprice and 067 adds idx_usage_events_instance_client_time;
	// each has its own dedicated migration test below.
	delete(before, "usage_cost_no_reprice")
	delete(after, "usage_cost_no_reprice")
	delete(after, "idx_usage_events_instance_client_time")
	if !reflect.DeepEqual(before, after) {
		t.Fatalf("usage-event indexes or triggers changed: before=%v after=%v", before, after)
	}
	for _, code := range []string{"", "request_scoped", "stream_truncated"} {
		var gotCode, body string
		var status int
		if err := db.SQL.QueryRowContext(ctx, `SELECT fail_code, fail_status_code, fail_body FROM usage_events WHERE event_key = ?`, code).Scan(&gotCode, &status, &body); err != nil {
			t.Fatal(err)
		}
		if gotCode != code || status != 429 || body != "original evidence" {
			t.Fatalf("historical evidence changed: %q %d %q", gotCode, status, body)
		}
	}
	if _, err := db.SQL.ExecContext(ctx, `UPDATE usage_events SET fail_code = 'force_cooldown' WHERE event_key = ''`); err != nil {
		t.Fatalf("new classification rejected after upgrade: %v", err)
	}
	if _, err := db.SQL.ExecContext(ctx, `UPDATE usage_events SET fail_code = 'future_classification' WHERE event_key = ''`); err == nil {
		t.Fatal("unknown classification accepted after upgrade")
	}
	var integrity string
	if err := db.SQL.QueryRowContext(ctx, `PRAGMA integrity_check`).Scan(&integrity); err != nil || integrity != "ok" {
		t.Fatalf("integrity check = %q: %v", integrity, err)
	}
	rows, err := db.SQL.QueryContext(ctx, `PRAGMA foreign_key_check`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	if rows.Next() {
		t.Fatal("foreign key check found a violation")
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
}

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

func TestStructuredUsageMigrationPreservesBothSchemaHistories(t *testing.T) {
	for _, history := range []struct {
		name    string
		version int
	}{
		{"plugin development versions 53 to 55", 52},
		{"structured usage version 53", 53},
	} {
		t.Run(history.name, func(t *testing.T) {
			ctx := context.Background()
			cipher, err := crypto.New("01234567890123456789012345678901")
			if err != nil {
				t.Fatal(err)
			}
			directory := t.TempDir()
			databasePath := filepath.Join(directory, "upgrade.db")
			backup := WithMigrationBackup(cipher, filepath.Join(directory, "backups"), 3)
			db, err := Open(ctx, databasePath, backup, withMigrationsUntil(history.version))
			if err != nil {
				t.Fatal(err)
			}
			defer db.Close()
			if history.version == 52 {
				// The plugin development branch recorded these versions without adding
				// structured usage. Build that history without undoing any migration.
				if _, err := db.SQL.ExecContext(ctx, `INSERT INTO schema_migrations(version, applied_at) VALUES (53, 1000), (54, 1000), (55, 1000)`); err != nil {
					t.Fatal(err)
				}
			}
			if _, err := db.SQL.ExecContext(ctx, `INSERT INTO cpa_instances(id, name, base_url, usage_addr, management_key_ciphertext, management_key_nonce, created_at, updated_at)
 VALUES ('default', 'Default', 'http://127.0.0.1:8317', '', x'00', x'00', 0, 0);
 INSERT INTO usage_events(id, instance_id, event_key, api_group_key, timestamp_ms, created_at_ms, total_tokens, cost_nanos, pricing_status)
 VALUES (41, 'default', 'historical', '', 1234, 2345, 100, 6000000, 'priced')`); err != nil {
				t.Fatal(err)
			}
			var wantHistoricalDetails *string
			if history.version == 53 {
				details := `{"web_search_requests":0}`
				wantHistoricalDetails = &details
				if _, err := db.SQL.ExecContext(ctx, `INSERT INTO usage_events(id, instance_id, event_key, api_group_key, timestamp_ms, created_at_ms, structured_usage)
 VALUES (42, 'default', 'structured-historical', '', 1234, 2345, ?)`, details); err != nil {
					t.Fatal(err)
				}
			}
			var appliedAt int64
			if err := db.SQL.QueryRowContext(ctx, `SELECT applied_at FROM schema_migrations WHERE version = 53`).Scan(&appliedAt); err != nil {
				t.Fatal(err)
			}
			repo := New(db)
			raw := `{"request_id":"pending-structured-usage","model":"fixture","tokens":{"total_tokens":5},"web_search_requests":0}`
			if _, err := repo.AppendUsageInbox(ctx, "default", "http_pull", []string{raw}, time.Now()); err != nil {
				t.Fatal(err)
			}

			db.migrateUntil = 0
			if err := db.Migrate(ctx); err != nil {
				t.Fatal(err)
			}
			var historicalDetails *string
			var tokens, cost, recordedAt int64
			if err := db.SQL.QueryRowContext(ctx, `SELECT total_tokens, cost_nanos, structured_usage FROM usage_events WHERE id = 41`).Scan(&tokens, &cost, &historicalDetails); err != nil {
				t.Fatal(err)
			}
			if tokens != 100 || cost != 6000000 || historicalDetails != nil {
				t.Fatalf("historical usage changed: tokens=%d cost=%d details=%v", tokens, cost, historicalDetails)
			}
			if wantHistoricalDetails != nil {
				var details string
				if err := db.SQL.QueryRowContext(ctx, `SELECT structured_usage FROM usage_events WHERE id = 42`).Scan(&details); err != nil || details != *wantHistoricalDetails {
					t.Fatalf("existing structured evidence changed: %q %v", details, err)
				}
			}
			if err := db.SQL.QueryRowContext(ctx, `SELECT applied_at FROM schema_migrations WHERE version = 53`).Scan(&recordedAt); err != nil || recordedAt != appliedAt {
				t.Fatalf("migration history changed: %d -> %d, %v", appliedAt, recordedAt, err)
			}

			inbox, err := repo.ClaimUsageInboxBatch(ctx, 1)
			if err != nil || len(inbox) != 1 || inbox[0].RawMessage != raw {
				t.Fatalf("pending payload lost: count=%d error=%v", len(inbox), err)
			}
			event, err := usage.DecodeEvent(inbox[0].RawMessage, "default", time.Now())
			if err != nil {
				t.Fatal(err)
			}
			if _, err := repo.CommitUsageDecoded(ctx, []UsageDecoded{{InboxID: inbox[0].ID, Event: event}}); err != nil {
				t.Fatalf("decode pending usage after upgrade: %v", err)
			}
			var details string
			if err := db.SQL.QueryRowContext(ctx, `SELECT structured_usage FROM usage_events WHERE request_id = 'pending-structured-usage'`).Scan(&details); err != nil || details != `{"web_search_requests":0}` {
				t.Fatalf("structured evidence not retained: %q %v", details, err)
			}
			if _, err := db.SQL.ExecContext(ctx, `UPDATE usage_events SET structured_usage = NULL WHERE request_id = 'pending-structured-usage'`); err == nil || !strings.Contains(err.Error(), "immutable") {
				t.Fatalf("structured evidence lost immutability: %v", err)
			}
			if err := db.Close(); err != nil {
				t.Fatal(err)
			}
			reopened, err := Open(ctx, databasePath, backup)
			if err != nil {
				t.Fatalf("idempotent reopen: %v", err)
			}
			defer reopened.Close()
		})
	}
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

	// A release container only guarantees a writable data volume, not system temp.
	unavailableTemporaryPath := filepath.Join(tempDir, "unavailable-system-temp")
	if err := os.WriteFile(unavailableTemporaryPath, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"TMPDIR", "TMP", "TEMP"} {
		t.Setenv(name, unavailableTemporaryPath)
	}
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
		if e.IsDir() {
			t.Fatalf("backup left a plaintext workspace behind: %s", e.Name())
		}
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

func TestMigration067PersistsClientAgentAndResolvesHistoricalRows(t *testing.T) {
	ctx := context.Background()
	cipher, err := crypto.New("01234567890123456789012345678901")
	if err != nil {
		t.Fatal(err)
	}
	directory := t.TempDir()
	db, err := Open(ctx, filepath.Join(directory, "client-agent-upgrade.db"), withMigrationsUntil(66),
		WithMigrationBackup(cipher, filepath.Join(directory, "backups"), 3))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	if _, err := db.SQL.ExecContext(ctx, `INSERT INTO cpa_instances
		(id, name, base_url, usage_addr, management_key_ciphertext, management_key_nonce, created_at, updated_at)
		VALUES ('default', 'Default', 'http://127.0.0.1:8317', '', x'00', x'00', 0, 0)`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.SQL.ExecContext(ctx, `INSERT INTO usage_events
		(instance_id, event_key, api_group_key, request_id, endpoint, user_agent, model, generate, timestamp_ms, created_at_ms)
		VALUES
		('default', 'hist-qwen', 'hmac:test', 'hist-qwen', 'POST /v1/messages', 'claude-cli/0.1.5', 'qwen-max', 1, 1000, 1000),
		('default', 'hist-empty', 'hmac:test', 'hist-empty', 'POST /v1/chat/completions', NULL, 'gpt-5', 1, 1500, 1500)`); err != nil {
		t.Fatal(err)
	}
	// Seed 10,000 additional historical rows across 1,000 distinct UA versions to
	// guard against O(N*K) table-scan regressions during migration 067 backfill.
	if _, err := db.SQL.ExecContext(ctx, `
		WITH RECURSIVE seq(n) AS (VALUES(1) UNION ALL SELECT n + 1 FROM seq WHERE n < 10000)
		INSERT INTO usage_events
			(instance_id, event_key, api_group_key, request_id, endpoint, user_agent, model, generate, timestamp_ms, created_at_ms)
		SELECT
			'default', 'hist-bulk-' || n, 'hmac:test', 'hist-bulk-' || n, 'POST /v1/responses',
			'codex_cli_rs/0.47.' || (n % 1000), 'gpt-5', 1, 1600 + (n % 300), 1600
		FROM seq`); err != nil {
		t.Fatal(err)
	}

	db.migrateUntil = 0
	if err := db.Migrate(ctx); err != nil {
		t.Fatal(err)
	}

	repo := New(db)
	electronUA := "Mozilla/5.0 (Macintosh; Intel Mac OS X) CherryStudio/1.2.4 Electron/32.0.0"
	if _, err := repo.InsertUsageEvents(ctx, []usage.Event{{
		InstanceID:  "default",
		EventKey:    "new-cherry",
		RequestID:   "new-cherry",
		APIGroupKey: "hmac:test",
		Endpoint:    "POST /v1/chat/completions",
		UserAgent:   &electronUA,
		Model:       "gpt-5",
		Generate:    true,
		TimestampMS: 2000,
	}}); err != nil {
		t.Fatal(err)
	}

	var storedAgent string
	var storedUA string
	if err := db.SQL.QueryRowContext(ctx, `SELECT client_agent, user_agent FROM usage_events WHERE event_key = 'new-cherry'`).Scan(&storedAgent, &storedUA); err != nil {
		t.Fatal(err)
	}
	if storedAgent != usage.ClientAgentCherryStudio || storedUA != "Mozilla/5.0" {
		t.Fatalf("persisted cherry-studio row = agent %q ua %q", storedAgent, storedUA)
	}

	page, err := repo.ListUsageEvents(ctx, UsageEventFilter{InstanceID: "default", Limit: 10})
	if err != nil || len(page.Items) != 10 {
		t.Fatalf("ListUsageEvents = %+v, err=%v", page, err)
	}
	if page.Items[0].ClientAgent != usage.ClientAgentCherryStudio {
		t.Fatalf("new row ClientAgent = %q, want %q", page.Items[0].ClientAgent, usage.ClientAgentCherryStudio)
	}

	var bulkCount int
	if err := db.SQL.QueryRowContext(ctx, `SELECT COUNT(1) FROM usage_events WHERE client_agent = ?`, usage.ClientAgentCodexCLI).Scan(&bulkCount); err != nil || bulkCount != 10000 {
		t.Fatalf("backfilled codex-cli count = %d (err=%v), want 10000", bulkCount, err)
	}

	qwenFiltered, err := repo.ListUsageEvents(ctx, UsageEventFilter{
		InstanceID:   "default",
		ClientAgents: []string{usage.ClientAgentQwenCode},
		Limit:        10,
	})
	if err != nil || len(qwenFiltered.Items) != 1 || qwenFiltered.Items[0].EventKey != "hist-qwen" {
		t.Fatalf("ClientAgents=[qwen-code] = %+v, err=%v", qwenFiltered, err)
	}

	unknownFiltered, err := repo.ListUsageEvents(ctx, UsageEventFilter{
		InstanceID:   "default",
		ClientAgents: []string{usage.ClientAgentUnknown},
		Limit:        10,
	})
	if err != nil || len(unknownFiltered.Items) != 1 || unknownFiltered.Items[0].EventKey != "hist-empty" || unknownFiltered.Items[0].ClientAgent != "" {
		t.Fatalf("ClientAgents=[unknown] = %+v, err=%v", unknownFiltered, err)
	}

	planRows, err := db.SQL.QueryContext(ctx, `
		EXPLAIN QUERY PLAN
		SELECT e.id FROM usage_events e
		WHERE e.instance_id = ? AND e.timestamp_ms BETWEEN ? AND ? AND e.client_agent = ?
		ORDER BY e.timestamp_ms DESC, e.id DESC LIMIT 51`, "default", 0, 5000, usage.ClientAgentQwenCode)
	if err != nil {
		t.Fatal(err)
	}
	defer planRows.Close()
	var planDetails []string
	for planRows.Next() {
		var id, parent, notused int
		var detail string
		if err := planRows.Scan(&id, &parent, &notused, &detail); err != nil {
			t.Fatal(err)
		}
		planDetails = append(planDetails, detail)
	}
	if joined := strings.Join(planDetails, " | "); !strings.Contains(joined, "idx_usage_events_instance_client_time") {
		t.Fatalf("expected client_agent filter to use idx_usage_events_instance_client_time, got %s", joined)
	}
}

func TestMigration067RebuildsMixedHistoricalFactPartitionsAndJointCacheReasoning(t *testing.T) {
	ctx := context.Background()
	db, err := Open(ctx, "file:mig067_mixed_facts?mode=memory&cache=shared", withMigrationsUntil(66))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	if _, err := db.SQL.ExecContext(ctx, `INSERT INTO cpa_instances
		(id, name, base_url, usage_addr, management_key_ciphertext, management_key_nonce, status, created_at, updated_at)
		VALUES ('default', 'Default', 'http://127.0.0.1:8317', '', x'00', x'00', 'unknown', 0, 0)`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.SQL.ExecContext(ctx, `
		INSERT INTO usage_events(instance_id, event_key, api_group_key, provider, model, timestamp_ms, created_at_ms,
			input_tokens, output_tokens, cached_tokens, cache_read_tokens, total_tokens, token_accounting)
		VALUES
		('default', 'a', 'group', 'openai', 'gpt-5', 1000, 1000, 1000, 100, 900, 0, 1100, NULL),
		('default', 'b', 'group', 'openai', 'gpt-5', 2000, 2000, 1000, 100, 900, 900, 1100,
			'{"version":2,"status":"complete","raw_tokens":{"input_tokens":1000,"output_tokens":100,"cached_tokens":900,"cache_read_tokens":900,"total_tokens":1100},"token_breakdown":{"schema_version":2,"quality":"complete","total_tokens":1100,"input":{"total_tokens":1000,"uncached_tokens":100,"cache_read_tokens":900,"cache_write_tokens":0},"output":{"total_tokens":100,"non_reasoning_tokens":100,"reasoning_tokens":0},"unclassified_tokens":0}}')`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.SQL.ExecContext(ctx, `
		INSERT INTO usage_facts_15m(instance_id, bucket_start_ms, api_group_key, model, provider,
			requests, input_tokens, output_tokens, cached_tokens, cache_read_tokens, total_tokens, canonical_requests)
		VALUES ('default', 0, 'group', 'gpt-5', 'openai', 2, 2000, 200, 1800, 900, 2200, 1)`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.SQL.ExecContext(ctx, `
		INSERT INTO usage_facts_daily(instance_id, bucket_start_ms, api_group_key, model, provider,
			requests, input_tokens, output_tokens, cached_tokens, cache_read_tokens, total_tokens, canonical_requests)
		VALUES ('default', 0, 'group', 'gpt-5', 'openai', 2, 2000, 200, 1800, 900, 2200, 1)`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.SQL.ExecContext(ctx, `UPDATE usage_aggregation_checkpoints SET last_usage_event_id = 2 WHERE name = 'facts'`); err != nil {
		t.Fatal(err)
	}
	// Seed a tail event past checkpoint (id=3) and a stale local-daily cache row + marker.
	if _, err := db.SQL.ExecContext(ctx, `
		INSERT INTO usage_events(instance_id, event_key, api_group_key, provider, model, timestamp_ms, created_at_ms,
			input_tokens, output_tokens, cached_tokens, cache_read_tokens, total_tokens, token_accounting)
		VALUES ('default', 'tail', 'group', 'openai', 'gpt-5', 3000, 3000, 1000, 100, 900, 0, 1100, NULL)`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.SQL.ExecContext(ctx, `
		INSERT INTO usage_facts_local_daily(instance_id, zone, day_wall_ms, api_group_key, model, provider,
			requests, input_tokens, output_tokens, cached_tokens, cache_read_tokens, total_tokens, canonical_requests)
		VALUES ('default', 'Asia/Kuala_Lumpur', 0, 'group', 'gpt-5', 'openai', 2, 2000, 200, 1800, 900, 2200, 1)`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.SQL.ExecContext(ctx, `
		INSERT INTO usage_aggregation_checkpoints(name, last_usage_event_id, stats_updated_at_ms, created_at_ms, updated_at_ms)
		VALUES ('facts_local:Asia/Kuala_Lumpur', 2, 0, 0, 0)`); err != nil {
		t.Fatal(err)
	}

	db.migrateUntil = 0
	if err := db.Migrate(ctx); err != nil {
		t.Fatal(err)
	}

	for _, table := range []string{"usage_facts_15m", "usage_facts_daily"} {
		var prompt, completion, read, effTotal, requests int64
		if err := db.SQL.QueryRowContext(ctx, `SELECT prompt_tokens, completion_tokens, effective_cache_read_tokens, effective_total_tokens, requests FROM `+table).Scan(&prompt, &completion, &read, &effTotal, &requests); err != nil {
			t.Fatal(err)
		}
		if prompt != 2000 || completion != 200 || read != 1800 || effTotal != 2200 || requests != 2 || (prompt-read)+completion != 400 {
			t.Fatalf("%s upgraded partitions = prompt=%d completion=%d read=%d total=%d requests=%d net=%d; want 2000/200/1800/2200/2/400",
				table, prompt, completion, read, effTotal, requests, (prompt-read)+completion)
		}
	}
	for _, query := range []string{
		`SELECT COUNT(*) FROM usage_facts_local_daily`,
		`SELECT COUNT(*) FROM usage_aggregation_checkpoints WHERE name LIKE 'facts_local:%'`,
	} {
		var count int64
		if err := db.SQL.QueryRowContext(ctx, query).Scan(&count); err != nil {
			t.Fatal(err)
		}
		if count != 0 {
			t.Fatalf("expected stale local cache/marker cleared for %q, got %d", query, count)
		}
	}

	repo := New(db)
	factsRes, err := repo.QueryUsageFacts(ctx, UsageFactQuery{InstanceID: "default", FromMS: 0, ToMS: 10000})
	if err != nil {
		t.Fatal(err)
	}
	var sumReq, sumP, sumC, sumR, sumTot int64
	for _, row := range factsRes.Rows {
		sumReq += row.Requests
		sumP += row.Accounting.PromptTokens
		sumC += row.Accounting.CompletionTokens
		sumR += row.Accounting.EffectiveCacheReadTokens
		sumTot += row.Accounting.EffectiveTotalTokens
	}
	if sumReq != 3 || sumP != 3000 || sumC != 300 || sumR != 2700 || sumTot != 3300 {
		t.Fatalf("fact+tail = req=%d prompt=%d comp=%d read=%d total=%d, want 3/3000/300/2700/3300", sumReq, sumP, sumC, sumR, sumTot)
	}

	clients, err := repo.QueryUsageClientAgents(ctx, "default", 0, 10000, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(clients.Items) != 1 || clients.Items[0].NetTokens != 600 || clients.Items[0].CacheReadTokens != 2700 {
		t.Fatalf("retained client attribution = %+v, want net=600 read=2700", clients.Items)
	}

	// Verify joint disjoint-cache + inclusive/separate reasoning resolution (R1 & R5).
	cases := []struct {
		key         string
		provider    string
		endpoint    string
		in, read    int64
		out, reason int64
		total       int64
		wantPrompt  int64
		wantComp    int64
		wantNet     int64
	}{
		{"subset-gt", "claude", "POST /v1/messages", 1000, 100, 200, 50, 1300, 1100, 200, 1200},
		{"subset-lt", "claude", "POST /v1/messages", 50, 900, 100, 20, 1050, 950, 100, 150},
		{"subset-eq", "claude", "POST /v1/messages", 200, 200, 100, 30, 500, 400, 100, 300},
		{"unknown-separate-gt", "", "", 1000, 100, 150, 50, 1300, 1100, 200, 1200},
	}
	for idx, tc := range cases {
		ts := int64(5000 + idx*100)
		ua := "claude-cli/2.1.3"
		if _, err := repo.InsertUsageEvents(ctx, []usage.Event{{
			InstanceID:      "default",
			EventKey:        tc.key,
			RequestID:       tc.key,
			APIGroupKey:     "group",
			Provider:        tc.provider,
			Endpoint:        tc.endpoint,
			Model:           "claude-sonnet",
			UserAgent:       &ua,
			TimestampMS:     ts,
			Generate:        true,
			InputTokens:     tc.in,
			CacheReadTokens: tc.read,
			OutputTokens:    tc.out,
			ReasoningTokens: tc.reason,
			TotalTokens:     tc.total,
		}}); err != nil {
			t.Fatal(err)
		}
		got, err := repo.QueryUsageClientAgents(ctx, "default", ts, ts, nil)
		if err != nil || len(got.Items) != 1 {
			t.Fatalf("%s: got=%+v err=%v", tc.key, got.Items, err)
		}
		item := got.Items[0]
		if item.InputTokens != tc.wantPrompt || item.OutputTokens != tc.wantComp || item.NetTokens != tc.wantNet {
			t.Fatalf("%s: got prompt=%d comp=%d net=%d, want %d/%d/%d",
				tc.key, item.InputTokens, item.OutputTokens, item.NetTokens, tc.wantPrompt, tc.wantComp, tc.wantNet)
		}
	}

	// Verify inclusive-cache + unclassified total surplus (OpenAI) and inclusive-cache + separate reasoning (Gemini),
	// including when cache == reasoning or output == cache (R4 counterexamples A & B).
	r4Cases := []struct {
		key         string
		provider    string
		endpoint    string
		model       string
		in, cached  int64
		read        int64
		out, reason int64
		total       int64
		wantPrompt  int64
		wantComp    int64
		wantNet     int64
		wantTotal   int64
	}{
		{"openai-surplus", "openai", "POST /v1/chat/completions", "gpt-5", 100, 80, 0, 20, 0, 1000, 100, 20, 40, 1000},
		{"openai-eq-reason", "openai", "POST /v1/chat/completions", "gpt-5", 1000, 50, 0, 100, 50, 1150, 1000, 100, 1050, 1150},
		{"gemini-cache-eq-reason", "gemini", "POST /v1beta/models/gemini:generateContent", "gemini-2.5-pro", 100, 10, 10, 30, 10, 140, 100, 40, 130, 140},
		{"gemini-output-eq-cache", "gemini", "POST /v1beta/models/gemini:generateContent", "gemini-2.5-pro", 100, 25, 25, 25, 10, 135, 100, 35, 110, 135},
		{"claude-cached-mirror", "claude", "POST /v1/messages", "claude-sonnet", 1000, 100, 100, 200, 50, 1300, 1100, 200, 1200, 1300},
	}
	for idx, tc := range r4Cases {
		ts := int64(7000 + idx*100)
		if _, err := repo.InsertUsageEvents(ctx, []usage.Event{{
			InstanceID:      "default",
			EventKey:        tc.key,
			RequestID:       tc.key,
			APIGroupKey:     "group",
			Provider:        tc.provider,
			Endpoint:        tc.endpoint,
			Model:           tc.model,
			TimestampMS:     ts,
			Generate:        true,
			InputTokens:     tc.in,
			CachedTokens:    tc.cached,
			CacheReadTokens: tc.read,
			OutputTokens:    tc.out,
			ReasoningTokens: tc.reason,
			TotalTokens:     tc.total,
		}}); err != nil {
			t.Fatal(err)
		}
		got, err := repo.QueryUsageClientAgents(ctx, "default", ts, ts, nil)
		if err != nil || len(got.Items) != 1 {
			t.Fatalf("%s: got=%+v err=%v", tc.key, got.Items, err)
		}
		item := got.Items[0]
		if item.InputTokens != tc.wantPrompt || item.OutputTokens != tc.wantComp || item.NetTokens != tc.wantNet || item.TotalTokens != tc.wantTotal {
			t.Fatalf("%s: got prompt=%d comp=%d net=%d total=%d, want %d/%d/%d/%d",
				tc.key, item.InputTokens, item.OutputTokens, item.NetTokens, item.TotalTokens,
				tc.wantPrompt, tc.wantComp, tc.wantNet, tc.wantTotal)
		}
	}

	// Verify mutually exclusive ordered protocol precedence over inbound endpoints (R5).
	r5Cases := []struct {
		key         string
		provider    string
		executor    string
		endpoint    string
		in, cached  int64
		read        int64
		out, reason int64
		total       int64
		wantPrompt  int64
		wantComp    int64
		wantNet     int64
		wantTotal   int64
	}{
		{"claude-via-chat", "claude", "ClaudeExecutor", "POST /v1/chat/completions", 1000, 100, 100, 20, 0, 1120, 1100, 20, 1020, 1120},
		{"gemini-via-chat", "gemini", "GeminiExecutor", "POST /v1/chat/completions", 100, 10, 10, 30, 10, 140, 100, 40, 130, 140},
		{"gemini-via-responses", "gemini", "GeminiExecutor", "POST /v1/responses", 100, 10, 10, 30, 10, 140, 100, 40, 130, 140},
		{"plugin-claude-messages", "plugin-claude", "PluginExecutor", "POST /v1/messages", 100, 10, 10, 30, 10, 140, 110, 30, 130, 140},
		{"claude-surplus-never-adds-thinking", "claude", "ClaudeExecutor", "POST /v1/messages", 100, 10, 10, 30, 10, 150, 110, 30, 130, 150},
		{"claude-compat-bridge", "claude", "OpenAICompatExecutor", "POST /v1/messages", 100, 10, 10, 30, 10, 130, 100, 30, 120, 130},
		{"gemini-compat-bridge", "gemini", "OpenAICompatExecutor", "POST /v1/messages", 100, 10, 10, 30, 10, 130, 100, 30, 120, 130},
		{"unknown-chat-endpoint", "", "", "POST /v1/chat/completions", 100, 10, 10, 30, 10, 130, 100, 30, 120, 130},
		{"unknown-messages-endpoint", "", "", "POST /v1/messages", 100, 10, 10, 30, 10, 140, 110, 30, 130, 140},
		{"unknown-exact-disjoint-sep", "", "", "", 100, 0, 10, 30, 10, 150, 110, 40, 140, 150},
	}
	for idx, tc := range r5Cases {
		ts := int64(9000 + idx*100)
		if _, err := repo.InsertUsageEvents(ctx, []usage.Event{{
			InstanceID:      "default",
			EventKey:        tc.key,
			RequestID:       tc.key,
			APIGroupKey:     "group",
			Provider:        tc.provider,
			ExecutorType:    tc.executor,
			Endpoint:        tc.endpoint,
			Model:           "model",
			TimestampMS:     ts,
			Generate:        true,
			InputTokens:     tc.in,
			CachedTokens:    tc.cached,
			CacheReadTokens: tc.read,
			OutputTokens:    tc.out,
			ReasoningTokens: tc.reason,
			TotalTokens:     tc.total,
		}}); err != nil {
			t.Fatal(err)
		}
		got, err := repo.QueryUsageClientAgents(ctx, "default", ts, ts, nil)
		if err != nil || len(got.Items) != 1 {
			t.Fatalf("%s: got=%+v err=%v", tc.key, got.Items, err)
		}
		item := got.Items[0]
		if item.InputTokens != tc.wantPrompt || item.OutputTokens != tc.wantComp || item.NetTokens != tc.wantNet || item.TotalTokens != tc.wantTotal {
			t.Fatalf("%s: SQL got prompt=%d comp=%d net=%d total=%d, want %d/%d/%d/%d",
				tc.key, item.InputTokens, item.OutputTokens, item.NetTokens, item.TotalTokens,
				tc.wantPrompt, tc.wantComp, tc.wantNet, tc.wantTotal)
		}
		goP, goC, goR, goTot := NormalizeEventPartition(EventPartitionInput{
			Provider:        tc.provider,
			ExecutorType:    tc.executor,
			Endpoint:        tc.endpoint,
			InputTokens:     tc.in,
			CachedTokens:    tc.cached,
			CacheReadTokens: tc.read,
			OutputTokens:    tc.out,
			ReasoningTokens: tc.reason,
			TotalTokens:     tc.total,
		})
		if goP != tc.wantPrompt || goC != tc.wantComp || (goP-goR)+goC != tc.wantNet || goTot != tc.wantTotal {
			t.Fatalf("%s: Go NormalizeEventPartition got prompt=%d comp=%d net=%d total=%d, want %d/%d/%d/%d",
				tc.key, goP, goC, (goP-goR)+goC, goTot,
				tc.wantPrompt, tc.wantComp, tc.wantNet, tc.wantTotal)
		}
	}
}

func TestMigration067MixedOpenAISubsetSurplusHistoricalFallback(t *testing.T) {
	ctx := context.Background()
	db, err := Open(ctx, "file:mig067_mixed_openai_subset?mode=memory&cache=shared", withMigrationsUntil(66))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	if _, err := db.SQL.ExecContext(ctx, `INSERT INTO cpa_instances
		(id, name, base_url, usage_addr, management_key_ciphertext, management_key_nonce, status, created_at, updated_at)
		VALUES ('default', 'Default', 'http://127.0.0.1:8317', '', x'00', x'00', 'unknown', 0, 0)`); err != nil {
		t.Fatal(err)
	}
	for _, table := range []string{"usage_facts_15m", "usage_facts_daily"} {
		if _, err := db.SQL.ExecContext(ctx, `
			INSERT INTO `+table+`(instance_id, bucket_start_ms, api_group_key, model, provider,
				requests, input_tokens, output_tokens, reasoning_tokens, cached_tokens, cache_read_tokens, total_tokens, canonical_requests)
			VALUES ('default', 0, 'group', 'model', 'openai', 2, 200, 40, 20, 160, 80, 260, 1)`); err != nil {
			t.Fatal(err)
		}
	}
	db.migrateUntil = 0
	if err := db.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	for _, table := range []string{"usage_facts_15m", "usage_facts_daily"} {
		var p, c, r, total int64
		if err := db.SQL.QueryRowContext(ctx, `SELECT prompt_tokens, completion_tokens, effective_cache_read_tokens, effective_total_tokens FROM `+table).Scan(&p, &c, &r, &total); err != nil {
			t.Fatal(err)
		}
		if p != 200 || c != 40 || r != 160 || total != 260 {
			t.Fatalf("%s: got prompt=%d comp=%d read=%d total=%d net=%d; want 200/40/160/260 net=80",
				table, p, c, r, total, (p-r)+c)
		}
	}
}

func TestMigration067ZeroUncachedSurplusAndPartialTotalAnthropic(t *testing.T) {
	ctx := context.Background()
	db, err := Open(ctx, "file:mig067_r6_zero_uncached?mode=memory&cache=shared", withMigrationsUntil(66))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	if _, err := db.SQL.ExecContext(ctx, `INSERT INTO cpa_instances
		(id, name, base_url, usage_addr, management_key_ciphertext, management_key_nonce, status, created_at, updated_at)
		VALUES ('default', 'Default', 'http://127.0.0.1:8317', '', x'00', x'00', 'unknown', 0, 0)`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.SQL.ExecContext(ctx, `
		INSERT INTO usage_events(instance_id, event_key, api_group_key, provider, executor_type, endpoint, model,
			timestamp_ms, created_at_ms, input_tokens, output_tokens, reasoning_tokens,
			cached_tokens, cache_read_tokens, cache_creation_tokens, total_tokens, token_accounting)
		VALUES ('default', 'zero', 'group', 'claude', 'ClaudeExecutor', 'POST /v1/messages', 'model',
			1000, 1000, 0, 30, 10, 100, 100, 50, 200, '{"version":2,"status":"unclassified"}')`); err != nil {
		t.Fatal(err)
	}
	for _, table := range []string{"usage_facts_15m", "usage_facts_daily"} {
		if _, err := db.SQL.ExecContext(ctx, `
			INSERT INTO `+table+`(instance_id, bucket_start_ms, api_group_key, model, provider,
				requests, input_tokens, output_tokens, reasoning_tokens,
				cached_tokens, cache_read_tokens, cache_creation_tokens, total_tokens,
				canonical_requests, unresolved_accounting_requests)
			VALUES ('default', 0, 'group', 'model', 'claude', 1, 0, 30, 10, 100, 100, 50, 200, 0, 1)`); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := db.SQL.ExecContext(ctx, `UPDATE usage_aggregation_checkpoints SET last_usage_event_id = 1 WHERE name = 'facts'`); err != nil {
		t.Fatal(err)
	}
	db.migrateUntil = 0
	if err := db.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	for _, table := range []string{"usage_facts_15m", "usage_facts_daily"} {
		var p, c, cr, total int64
		if err := db.SQL.QueryRowContext(ctx, `SELECT prompt_tokens, completion_tokens, effective_cache_read_tokens, effective_total_tokens FROM `+table).Scan(&p, &c, &cr, &total); err != nil {
			t.Fatal(err)
		}
		if p != 150 || c != 30 || cr != 100 || total != 200 {
			t.Fatalf("%s: prompt=%d completion=%d read=%d net=%d total=%d; want 150/30/100/30/200",
				table, p, c, cr, max(p-cr-50, 0)+c, total)
		}
	}

	// Verify real DecodeEvent + unfolded/folded QueryUsageFacts + QueryUsageClientAgents + partial-total Claude.
	repo := usageTestRepository(t)
	breakdown := usage.TokenBreakdown{
		SchemaVersion:      2,
		Quality:            "unclassified",
		TotalTokens:        200,
		Input:              usage.TokenInputBreakdown{TotalTokens: 150, UncachedTokens: 0, CacheReadTokens: 100, CacheWriteTokens: 50},
		Output:             usage.TokenOutputBreakdown{TotalTokens: 30, NonReasoningTokens: 20, ReasoningTokens: 10},
		UnclassifiedTokens: 20,
	}
	encoded, err := json.Marshal(breakdown)
	if err != nil {
		t.Fatal(err)
	}
	isGen := true
	payload := usage.Payload{
		AccountingVersion: json.RawMessage("2"),
		TokenBreakdown:    encoded,
		Timestamp:         time.UnixMilli(1000),
		RequestID:         "r6-zero",
		Provider:          "claude",
		ExecutorType:      "ClaudeExecutor",
		Endpoint:          "POST /v1/messages",
		Model:             "claude-sonnet",
		Generate:          &isGen,
		Tokens: usage.TokenStats{
			InputTokens:         0,
			OutputTokens:        30,
			ReasoningTokens:     10,
			CacheReadTokens:     100,
			CachedTokens:        100,
			CacheCreationTokens: 50,
			TotalTokens:         200,
		},
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	decodedEv, err := usage.DecodeEvent(string(raw), "default", time.UnixMilli(1000))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := repo.InsertUsageEvents(ctx, []usage.Event{decodedEv}); err != nil {
		t.Fatal(err)
	}
	goP, goC, goCr, goTot := NormalizeEventPartition(EventPartitionInput{
		Provider:            decodedEv.Provider,
		ExecutorType:        decodedEv.ExecutorType,
		Endpoint:            decodedEv.Endpoint,
		InputTokens:         decodedEv.InputTokens,
		OutputTokens:        decodedEv.OutputTokens,
		ReasoningTokens:     decodedEv.ReasoningTokens,
		CachedTokens:        decodedEv.CachedTokens,
		CacheReadTokens:     decodedEv.CacheReadTokens,
		CacheCreationTokens: decodedEv.CacheCreationTokens,
		TotalTokens:         decodedEv.TotalTokens,
	})
	if goP != 150 || goC != 30 || goCr != 100 || goTot != 200 {
		t.Fatalf("Go zero-uncached: got %d/%d/%d/%d, want 150/30/100/200", goP, goC, goCr, goTot)
	}
	for _, fold := range []bool{false, true} {
		if fold {
			if _, err := repo.AggregateUsageFacts(ctx, 100); err != nil {
				t.Fatal(err)
			}
		}
		facts, err := repo.QueryUsageFacts(ctx, UsageFactQuery{InstanceID: "default", FromMS: 0, ToMS: QuarterHourBucketMS - 1, BucketMS: QuarterHourBucketMS})
		if err != nil {
			t.Fatal(err)
		}
		var prompt, comp, read, effective, reqs int64
		for _, x := range facts.Rows {
			prompt += x.Accounting.PromptTokens
			comp += x.Accounting.CompletionTokens
			read += x.Accounting.EffectiveCacheReadTokens
			effective += x.Accounting.EffectiveTotalTokens
			reqs += x.Requests
		}
		if reqs != 1 || prompt != 150 || comp != 30 || read != 100 || effective != 200 {
			t.Fatalf("SQL fold=%v: got req=%d prompt=%d comp=%d read=%d total=%d, want 1/150/30/100/200",
				fold, reqs, prompt, comp, read, effective)
		}
	}

	// Partial-total Claude (total=180 omits read cache): still preserves uncached input 100 -> prompt=250, net=130, total=280.
	partialEv := usage.Event{
		InstanceID:          "default",
		EventKey:            "r6-partial",
		RequestID:           "r6-partial",
		APIGroupKey:         "group",
		Provider:            "claude",
		ExecutorType:        "ClaudeExecutor",
		Endpoint:            "POST /v1/messages",
		Model:               "claude-sonnet",
		TimestampMS:         5000,
		Generate:            true,
		InputTokens:         100,
		OutputTokens:        30,
		ReasoningTokens:     10,
		CachedTokens:        100,
		CacheReadTokens:     100,
		CacheCreationTokens: 50,
		TotalTokens:         180,
	}
	if _, err := repo.InsertUsageEvents(ctx, []usage.Event{partialEv}); err != nil {
		t.Fatal(err)
	}
	if partialClients, err := repo.QueryUsageClientAgents(ctx, "default", 5000, 5000, nil); err != nil || len(partialClients.Items) != 1 {
		t.Fatalf("partial clients: %+v err=%v", partialClients.Items, err)
	} else {
		item := partialClients.Items[0]
		if item.InputTokens != 250 || item.OutputTokens != 30 || item.NetTokens != 130 || item.TotalTokens != 280 {
			t.Fatalf("partial-total Claude: got prompt=%d comp=%d net=%d total=%d, want 250/30/130/280",
				item.InputTokens, item.OutputTokens, item.NetTokens, item.TotalTokens)
		}
	}

	// Verify InsertUsageEvents classifies endpoint query hints before PublicEndpoint strips query params,
	// while still persisting only the sanitized endpoint.
	if _, err := repo.InsertUsageEvents(ctx, []usage.Event{{
		InstanceID:  "default",
		EventKey:    "codex-models-query",
		RequestID:   "codex-models-query",
		APIGroupKey: "group",
		Provider:    "codex",
		Endpoint:    "GET /v1/models?client_version=0.47.0",
		Model:       "gpt-5-codex",
		TimestampMS: 6000,
		Generate:    true,
	}}); err != nil {
		t.Fatal(err)
	}
	var storedEndpoint, storedClient string
	if err := repo.SQL().QueryRowContext(ctx, `SELECT endpoint, client_agent FROM usage_events WHERE event_key = 'codex-models-query'`).Scan(&storedEndpoint, &storedClient); err != nil {
		t.Fatal(err)
	}
	if storedEndpoint != "GET /v1/models" || storedClient != usage.ClientAgentCodexCLI {
		t.Fatalf("expected sanitized endpoint GET /v1/models and client_agent codex-cli, got endpoint=%q client_agent=%q", storedEndpoint, storedClient)
	}
}

func TestMigration068RepairsPartial067SchemaAndFactPartitions(t *testing.T) {
	ctx := context.Background()

	t.Run("early 067 draft without fact partitions or index", func(t *testing.T) {
		cipher, err := crypto.New("01234567890123456789012345678901")
		if err != nil {
			t.Fatal(err)
		}
		directory := t.TempDir()
		db, err := Open(ctx, filepath.Join(directory, "drifted-067.db"), withMigrationsUntil(66),
			WithMigrationBackup(cipher, filepath.Join(directory, "backups"), 3))
		if err != nil {
			t.Fatal(err)
		}
		defer db.Close()

		if _, err := db.SQL.ExecContext(ctx, `INSERT INTO cpa_instances
			(id, name, base_url, usage_addr, management_key_ciphertext, management_key_nonce, status, created_at, updated_at)
			VALUES ('default', 'Default', 'http://127.0.0.1:8317', '', x'00', x'00', 'unknown', 0, 0)`); err != nil {
			t.Fatal(err)
		}
		if _, err := db.SQL.ExecContext(ctx, `
			ALTER TABLE usage_events ADD COLUMN client_agent TEXT NOT NULL DEFAULT '';
			INSERT INTO schema_migrations(version, applied_at) VALUES (67, 1000);
			INSERT INTO usage_events(instance_id, event_key, api_group_key, provider, model, endpoint, user_agent, timestamp_ms, created_at_ms,
				input_tokens, output_tokens, cached_tokens, cache_read_tokens, total_tokens, token_accounting)
			VALUES
			('default', 'ev-qwen', 'group', 'openai', 'gpt-5', 'POST /v1/messages', 'claude-cli/0.1.5', 1000, 1000, 1000, 100, 900, 0, 1100, NULL),
			('default', 'ev-empty', 'group', 'openai', 'gpt-5', 'POST /v1/chat/completions', NULL, 2000, 2000, 1000, 100, 900, 900, 1100,
				'{"version":2,"status":"complete","raw_tokens":{"input_tokens":1000,"output_tokens":100,"cached_tokens":900,"cache_read_tokens":900,"total_tokens":1100},"token_breakdown":{"schema_version":2,"quality":"complete","total_tokens":1100,"input":{"total_tokens":1000,"uncached_tokens":100,"cache_read_tokens":900,"cache_write_tokens":0},"output":{"total_tokens":100,"non_reasoning_tokens":100,"reasoning_tokens":0},"unclassified_tokens":0}}');
			INSERT INTO usage_facts_15m(instance_id, bucket_start_ms, api_group_key, model, provider,
				requests, input_tokens, output_tokens, cached_tokens, cache_read_tokens, total_tokens, canonical_requests)
			VALUES ('default', 0, 'group', 'gpt-5', 'openai', 2, 2000, 200, 1800, 900, 2200, 1);
			INSERT INTO usage_facts_daily(instance_id, bucket_start_ms, api_group_key, model, provider,
				requests, input_tokens, output_tokens, cached_tokens, cache_read_tokens, total_tokens, canonical_requests)
			VALUES ('default', 0, 'group', 'gpt-5', 'openai', 2, 2000, 200, 1800, 900, 2200, 1);
			UPDATE usage_aggregation_checkpoints SET last_usage_event_id = 2 WHERE name = 'facts';
			INSERT INTO usage_events(instance_id, event_key, api_group_key, provider, model, endpoint, user_agent, timestamp_ms, created_at_ms,
				input_tokens, output_tokens, cached_tokens, cache_read_tokens, total_tokens, token_accounting)
			VALUES ('default', 'ev-tail', 'group', 'openai', 'gpt-5', 'POST /v1/responses', 'codex_cli_rs/0.47.0', 3000, 3000, 1000, 100, 900, 0, 1100, NULL);
			INSERT INTO usage_facts_local_daily(instance_id, zone, day_wall_ms, api_group_key, model, provider,
				requests, input_tokens, output_tokens, cached_tokens, cache_read_tokens, total_tokens, canonical_requests)
			VALUES ('default', 'Asia/Kuala_Lumpur', 0, 'group', 'gpt-5', 'openai', 2, 2000, 200, 1800, 900, 2200, 1);
			INSERT INTO usage_aggregation_checkpoints(name, last_usage_event_id, stats_updated_at_ms, created_at_ms, updated_at_ms)
			VALUES ('facts_local:Asia/Kuala_Lumpur', 2, 0, 0, 0);
		`); err != nil {
			t.Fatal(err)
		}

		repo := New(db)
		if _, err := repo.QueryUsageFacts(ctx, UsageFactQuery{InstanceID: "default", FromMS: 0, ToMS: QuarterHourBucketMS - 1, BucketMS: QuarterHourBucketMS}); err == nil || !strings.Contains(err.Error(), "prompt_tokens") {
			t.Fatalf("expected QueryUsageFacts to fail on drifted 067 schema before repair, got %v", err)
		}

		db.migrateUntil = 0
		if err := db.Migrate(ctx); err != nil {
			t.Fatalf("Migrate(068) failed: %v", err)
		}

		for _, table := range []string{"usage_facts_15m", "usage_facts_daily"} {
			var prompt, completion, read, effTotal, requests int64
			if err := db.SQL.QueryRowContext(ctx, `SELECT prompt_tokens, completion_tokens, effective_cache_read_tokens, effective_total_tokens, requests FROM `+table).Scan(&prompt, &completion, &read, &effTotal, &requests); err != nil {
				t.Fatal(err)
			}
			if prompt != 2000 || completion != 200 || read != 1800 || effTotal != 2200 || requests != 2 {
				t.Fatalf("%s repaired partitions = %d/%d/%d/%d req=%d, want 2000/200/1800/2200 req=2", table, prompt, completion, read, effTotal, requests)
			}
		}

		if folded, err := repo.AggregateUsageFacts(ctx, 100); err != nil || folded != 1 {
			t.Fatalf("AggregateUsageFacts after repair = folded=%d err=%v, want folded=1", folded, err)
		}
		if rebuilt, err := repo.EnsureLocalUsageFacts(ctx); err != nil || !rebuilt {
			t.Fatalf("EnsureLocalUsageFacts after repair = rebuilt=%v err=%v", rebuilt, err)
		}
		factsRes, err := repo.QueryUsageFacts(ctx, UsageFactQuery{InstanceID: "default", FromMS: 0, ToMS: 10000})
		if err != nil {
			t.Fatalf("QueryUsageFacts after repair: %v", err)
		}
		var sumReq, sumP, sumC, sumR, sumTot int64
		for _, row := range factsRes.Rows {
			sumReq += row.Requests
			sumP += row.Accounting.PromptTokens
			sumC += row.Accounting.CompletionTokens
			sumR += row.Accounting.EffectiveCacheReadTokens
			sumTot += row.Accounting.EffectiveTotalTokens
		}
		if sumReq != 3 || sumP != 3000 || sumC != 300 || sumR != 2700 || sumTot != 3300 {
			t.Fatalf("QueryUsageFacts totals = req=%d p=%d c=%d r=%d tot=%d, want 3/3000/300/2700/3300",
				sumReq, sumP, sumC, sumR, sumTot)
		}

		var idxCount int
		if err := db.SQL.QueryRowContext(ctx, `SELECT COUNT(1) FROM sqlite_master WHERE type='index' AND name='idx_usage_events_instance_client_time'`).Scan(&idxCount); err != nil || idxCount != 1 {
			t.Fatalf("expected idx_usage_events_instance_client_time rebuilt, count=%d err=%v", idxCount, err)
		}
		var qwenAgent, emptyAgent, codexAgent string
		if err := db.SQL.QueryRowContext(ctx, `SELECT client_agent FROM usage_events WHERE event_key='ev-qwen'`).Scan(&qwenAgent); err != nil || qwenAgent != usage.ClientAgentQwenCode {
			t.Fatalf("ev-qwen client_agent = %q (err=%v), want %q", qwenAgent, err, usage.ClientAgentQwenCode)
		}
		if err := db.SQL.QueryRowContext(ctx, `SELECT client_agent FROM usage_events WHERE event_key='ev-empty'`).Scan(&emptyAgent); err != nil || emptyAgent != usage.ClientAgentUnknown {
			t.Fatalf("ev-empty client_agent = %q (err=%v), want %q", emptyAgent, err, usage.ClientAgentUnknown)
		}
		if err := db.SQL.QueryRowContext(ctx, `SELECT client_agent FROM usage_events WHERE event_key='ev-tail'`).Scan(&codexAgent); err != nil || codexAgent != usage.ClientAgentCodexCLI {
			t.Fatalf("ev-tail client_agent = %q (err=%v), want %q", codexAgent, err, usage.ClientAgentCodexCLI)
		}

		clients, err := repo.QueryUsageClientAgents(ctx, "default", 0, 10000, nil)
		if err != nil || clients.RetainedRequests != 3 || len(clients.Items) != 3 {
			t.Fatalf("QueryUsageClientAgents = %+v err=%v", clients, err)
		}
	})

	t.Run("partial 067 draft missing effective_total_tokens and index", func(t *testing.T) {
		db, err := Open(ctx, "file:mig068_partial_cols?mode=memory&cache=shared", withMigrationsUntil(66))
		if err != nil {
			t.Fatal(err)
		}
		defer db.Close()

		if _, err := db.SQL.ExecContext(ctx, `INSERT INTO cpa_instances
			(id, name, base_url, usage_addr, management_key_ciphertext, management_key_nonce, status, created_at, updated_at)
			VALUES ('default', 'Default', 'http://127.0.0.1:8317', '', x'00', x'00', 'unknown', 0, 0)`); err != nil {
			t.Fatal(err)
		}
		// Simulate an intermediate 067 draft that added 3 partition columns without
		// effective_total_tokens and skipped creating the client_agent index.
		if _, err := db.SQL.ExecContext(ctx, `
			ALTER TABLE usage_events ADD COLUMN client_agent TEXT NOT NULL DEFAULT '';
			ALTER TABLE usage_facts_15m ADD COLUMN prompt_tokens INTEGER NOT NULL DEFAULT 0;
			ALTER TABLE usage_facts_15m ADD COLUMN completion_tokens INTEGER NOT NULL DEFAULT 0;
			ALTER TABLE usage_facts_15m ADD COLUMN effective_cache_read_tokens INTEGER NOT NULL DEFAULT 0;
			ALTER TABLE usage_facts_daily ADD COLUMN prompt_tokens INTEGER NOT NULL DEFAULT 0;
			ALTER TABLE usage_facts_daily ADD COLUMN completion_tokens INTEGER NOT NULL DEFAULT 0;
			ALTER TABLE usage_facts_daily ADD COLUMN effective_cache_read_tokens INTEGER NOT NULL DEFAULT 0;
			ALTER TABLE usage_facts_local_daily ADD COLUMN prompt_tokens INTEGER NOT NULL DEFAULT 0;
			ALTER TABLE usage_facts_local_daily ADD COLUMN completion_tokens INTEGER NOT NULL DEFAULT 0;
			ALTER TABLE usage_facts_local_daily ADD COLUMN effective_cache_read_tokens INTEGER NOT NULL DEFAULT 0;
			INSERT INTO schema_migrations(version, applied_at) VALUES (67, 1000);
			-- Expired mixed Claude bucket whose exact prompt=2000 differs from the
			-- aggregate estimate (1900) when canonical_requests=1 < requests=2.
			INSERT INTO usage_facts_15m(instance_id, bucket_start_ms, api_group_key, model, provider,
				requests, canonical_requests, input_tokens, output_tokens, cache_read_tokens, total_tokens,
				prompt_tokens, completion_tokens, effective_cache_read_tokens)
			VALUES ('default', 0, 'group', 'claude-sonnet', 'claude', 2, 1, 1900, 200, 200, 2100, 2000, 200, 200);
			INSERT INTO usage_facts_daily(instance_id, bucket_start_ms, api_group_key, model, provider,
				requests, canonical_requests, input_tokens, output_tokens, cache_read_tokens, total_tokens,
				prompt_tokens, completion_tokens, effective_cache_read_tokens)
			VALUES ('default', 0, 'group', 'claude-sonnet', 'claude', 2, 1, 1900, 200, 200, 2100, 2000, 200, 200);
			-- Two 15m buckets under one day where MAX(total, prompt+comp) differs across grains:
			-- fine yields 200 + 200 = 400, whereas daily standalone MAX(300, 300) would yield 300.
			INSERT INTO usage_facts_15m(instance_id, bucket_start_ms, api_group_key, model, provider,
				requests, input_tokens, output_tokens, total_tokens, prompt_tokens, completion_tokens, effective_cache_read_tokens)
			VALUES
				('default', 0, 'group', 'gpt-5', 'openai', 1, 200, 0, 100, 200, 0, 0),
				('default', 900000, 'group', 'gpt-5', 'openai', 1, 100, 0, 200, 100, 0, 0);
			INSERT INTO usage_facts_daily(instance_id, bucket_start_ms, api_group_key, model, provider,
				requests, input_tokens, output_tokens, total_tokens, prompt_tokens, completion_tokens, effective_cache_read_tokens)
			VALUES ('default', 0, 'group', 'gpt-5', 'openai', 2, 300, 0, 300, 300, 0, 0);
		`); err != nil {
			t.Fatal(err)
		}

		db.migrateUntil = 0
		if err := db.Migrate(ctx); err != nil {
			t.Fatalf("Migrate(068) failed: %v", err)
		}

		for _, table := range []string{"usage_facts_15m", "usage_facts_daily"} {
			var prompt, comp, cr, effTotal int64
			if err := db.SQL.QueryRowContext(ctx, `SELECT prompt_tokens, completion_tokens, effective_cache_read_tokens, effective_total_tokens FROM `+table+` WHERE model = 'claude-sonnet'`).Scan(&prompt, &comp, &cr, &effTotal); err != nil {
				t.Fatal(err)
			}
			if prompt != 2000 || comp != 200 || cr != 200 || effTotal != 2200 {
				t.Fatalf("%s mixed partitions = %d/%d/%d/%d, want preserved 2000/200/200/2200", table, prompt, comp, cr, effTotal)
			}
		}
		var fineGPTSum, dailyGPTTotal int64
		if err := db.SQL.QueryRowContext(ctx, `SELECT COALESCE(SUM(effective_total_tokens), 0) FROM usage_facts_15m WHERE model = 'gpt-5'`).Scan(&fineGPTSum); err != nil || fineGPTSum != 400 {
			t.Fatalf("fine gpt-5 effective_total_tokens sum = %d (err=%v), want 400", fineGPTSum, err)
		}
		if err := db.SQL.QueryRowContext(ctx, `SELECT effective_total_tokens FROM usage_facts_daily WHERE model = 'gpt-5'`).Scan(&dailyGPTTotal); err != nil || dailyGPTTotal != 400 {
			t.Fatalf("daily gpt-5 effective_total_tokens rolled up = %d (err=%v), want 400", dailyGPTTotal, err)
		}
		var idxCount int
		if err := db.SQL.QueryRowContext(ctx, `SELECT COUNT(1) FROM sqlite_master WHERE type='index' AND name='idx_usage_events_instance_client_time'`).Scan(&idxCount); err != nil || idxCount != 1 {
			t.Fatalf("expected idx_usage_events_instance_client_time ensured even with 0 pending rows, count=%d err=%v", idxCount, err)
		}
	})

	t.Run("partial 067 draft with effective_total_tokens but missing base partition columns", func(t *testing.T) {
		db, err := Open(ctx, "file:mig068_missing_base_cols?mode=memory&cache=shared", withMigrationsUntil(66))
		if err != nil {
			t.Fatal(err)
		}
		defer db.Close()

		if _, err := db.SQL.ExecContext(ctx, `INSERT INTO cpa_instances
			(id, name, base_url, usage_addr, management_key_ciphertext, management_key_nonce, status, created_at, updated_at)
			VALUES ('default', 'Default', 'http://127.0.0.1:8317', '', x'00', x'00', 'unknown', 0, 0)`); err != nil {
			t.Fatal(err)
		}
		if _, err := db.SQL.ExecContext(ctx, `
			ALTER TABLE usage_events ADD COLUMN client_agent TEXT NOT NULL DEFAULT '';
			ALTER TABLE usage_facts_15m ADD COLUMN effective_total_tokens INTEGER NOT NULL DEFAULT 0;
			ALTER TABLE usage_facts_daily ADD COLUMN effective_total_tokens INTEGER NOT NULL DEFAULT 0;
			ALTER TABLE usage_facts_local_daily ADD COLUMN effective_total_tokens INTEGER NOT NULL DEFAULT 0;
			INSERT INTO schema_migrations(version, applied_at) VALUES (67, 1000);
			INSERT INTO usage_facts_15m(instance_id, bucket_start_ms, api_group_key, model, provider,
				requests, input_tokens, output_tokens, total_tokens, effective_total_tokens)
			VALUES
				('default', 0, 'group', 'gpt-5', 'openai', 1, 500, 100, 600, 600),
				('default', 900000, 'group', 'legacy-total', '', 1, 0, 0, 600, 600);
			INSERT INTO usage_facts_daily(instance_id, bucket_start_ms, api_group_key, model, provider,
				requests, input_tokens, output_tokens, total_tokens, effective_total_tokens)
			VALUES
				('default', 0, 'group', 'gpt-5', 'openai', 1, 500, 100, 600, 600),
				('default', 0, 'group', 'legacy-total', '', 1, 0, 0, 600, 600);
		`); err != nil {
			t.Fatal(err)
		}

		db.migrateUntil = 0
		if err := db.Migrate(ctx); err != nil {
			t.Fatalf("Migrate(068) failed: %v", err)
		}

		for _, table := range []string{"usage_facts_15m", "usage_facts_daily"} {
			var prompt, comp, cr, effTotal int64
			if err := db.SQL.QueryRowContext(ctx, `SELECT prompt_tokens, completion_tokens, effective_cache_read_tokens, effective_total_tokens FROM `+table+` WHERE model = 'gpt-5'`).Scan(&prompt, &comp, &cr, &effTotal); err != nil {
				t.Fatal(err)
			}
			if prompt != 500 || comp != 100 || cr != 0 || effTotal != 600 {
				t.Fatalf("%s repaired gpt-5 partitions = %d/%d/%d/%d, want 500/100/0/600", table, prompt, comp, cr, effTotal)
			}
			if err := db.SQL.QueryRowContext(ctx, `SELECT prompt_tokens, completion_tokens, effective_cache_read_tokens, effective_total_tokens FROM `+table+` WHERE model = 'legacy-total'`).Scan(&prompt, &comp, &cr, &effTotal); err != nil {
				t.Fatal(err)
			}
			if prompt != 600 || comp != 0 || cr != 0 || effTotal != 600 {
				t.Fatalf("%s repaired total-only unknown-provider = %d/%d/%d/%d, want 600/0/0/600", table, prompt, comp, cr, effTotal)
			}
		}
	})

	t.Run("partial 067 draft missing only effective_cache_read_tokens", func(t *testing.T) {
		db, err := Open(ctx, "file:mig068_missing_cache_read?mode=memory&cache=shared", withMigrationsUntil(66))
		if err != nil {
			t.Fatal(err)
		}
		defer db.Close()

		if _, err := db.SQL.ExecContext(ctx, `INSERT INTO cpa_instances
			(id, name, base_url, usage_addr, management_key_ciphertext, management_key_nonce, status, created_at, updated_at)
			VALUES ('default', 'Default', 'http://127.0.0.1:8317', '', x'00', x'00', 'unknown', 0, 0)`); err != nil {
			t.Fatal(err)
		}
		if _, err := db.SQL.ExecContext(ctx, `
			ALTER TABLE usage_events ADD COLUMN client_agent TEXT NOT NULL DEFAULT '';
			ALTER TABLE usage_facts_15m ADD COLUMN prompt_tokens INTEGER NOT NULL DEFAULT 0;
			ALTER TABLE usage_facts_15m ADD COLUMN completion_tokens INTEGER NOT NULL DEFAULT 0;
			ALTER TABLE usage_facts_15m ADD COLUMN effective_total_tokens INTEGER NOT NULL DEFAULT 0;
			ALTER TABLE usage_facts_daily ADD COLUMN prompt_tokens INTEGER NOT NULL DEFAULT 0;
			ALTER TABLE usage_facts_daily ADD COLUMN completion_tokens INTEGER NOT NULL DEFAULT 0;
			ALTER TABLE usage_facts_daily ADD COLUMN effective_total_tokens INTEGER NOT NULL DEFAULT 0;
			ALTER TABLE usage_facts_local_daily ADD COLUMN prompt_tokens INTEGER NOT NULL DEFAULT 0;
			ALTER TABLE usage_facts_local_daily ADD COLUMN completion_tokens INTEGER NOT NULL DEFAULT 0;
			ALTER TABLE usage_facts_local_daily ADD COLUMN effective_total_tokens INTEGER NOT NULL DEFAULT 0;
			INSERT INTO schema_migrations(version, applied_at) VALUES (67, 1000);
			INSERT INTO usage_facts_15m(instance_id, bucket_start_ms, api_group_key, model, provider,
				requests, input_tokens, output_tokens, cached_tokens, cache_read_tokens, total_tokens,
				prompt_tokens, completion_tokens, effective_total_tokens)
			VALUES
				('default', 0, 'group', 'claude-sonnet', 'claude', 1, 100, 100, 0, 900, 1100, 1000, 100, 1100),
				('default', 900000, 'group', 'gpt-unpart', 'openai', 1, 500, 100, 300, 0, 600, 0, 0, 0);
			INSERT INTO usage_facts_daily(instance_id, bucket_start_ms, api_group_key, model, provider,
				requests, input_tokens, output_tokens, cached_tokens, cache_read_tokens, total_tokens,
				prompt_tokens, completion_tokens, effective_total_tokens)
			VALUES
				('default', 0, 'group', 'claude-sonnet', 'claude', 1, 100, 100, 0, 900, 1100, 1000, 100, 1100),
				('default', 0, 'group', 'gpt-unpart', 'openai', 1, 500, 100, 300, 0, 600, 0, 0, 0);
		`); err != nil {
			t.Fatal(err)
		}

		db.migrateUntil = 0
		if err := db.Migrate(ctx); err != nil {
			t.Fatalf("Migrate(068) failed: %v", err)
		}

		for _, table := range []string{"usage_facts_15m", "usage_facts_daily"} {
			var prompt, comp, cr, effTotal int64
			if err := db.SQL.QueryRowContext(ctx, `SELECT prompt_tokens, completion_tokens, effective_cache_read_tokens, effective_total_tokens FROM `+table+` WHERE model = 'claude-sonnet'`).Scan(&prompt, &comp, &cr, &effTotal); err != nil {
				t.Fatal(err)
			}
			if prompt != 1000 || comp != 100 || cr != 900 || effTotal != 1100 {
				t.Fatalf("%s repaired cache_read = %d/%d/%d/%d, want 1000/100/900/1100", table, prompt, comp, cr, effTotal)
			}
			if err := db.SQL.QueryRowContext(ctx, `SELECT prompt_tokens, completion_tokens, effective_cache_read_tokens, effective_total_tokens FROM `+table+` WHERE model = 'gpt-unpart'`).Scan(&prompt, &comp, &cr, &effTotal); err != nil {
				t.Fatal(err)
			}
			if prompt != 500 || comp != 100 || cr != 300 || effTotal != 600 {
				t.Fatalf("%s unpartitioned alongside missing cache_read = %d/%d/%d/%d, want 500/100/300/600", table, prompt, comp, cr, effTotal)
			}
		}
	})

	t.Run("asymmetric fine missing all base cols while daily already holds total-only row", func(t *testing.T) {
		db, err := Open(ctx, "file:mig068_asym_total_only?mode=memory&cache=shared", withMigrationsUntil(66))
		if err != nil {
			t.Fatal(err)
		}
		defer db.Close()

		if _, err := db.SQL.ExecContext(ctx, `INSERT INTO cpa_instances
			(id, name, base_url, usage_addr, management_key_ciphertext, management_key_nonce, status, created_at, updated_at)
			VALUES ('default', 'Default', 'http://127.0.0.1:8317', '', x'00', x'00', 'unknown', 0, 0)`); err != nil {
			t.Fatal(err)
		}
		// Fine lacks all 3 base columns (has effective_total_tokens); daily already has all 4 columns
		// and an already-valid total-only row.
		if _, err := db.SQL.ExecContext(ctx, `
			ALTER TABLE usage_events ADD COLUMN client_agent TEXT NOT NULL DEFAULT '';
			ALTER TABLE usage_facts_15m ADD COLUMN effective_total_tokens INTEGER NOT NULL DEFAULT 0;
			ALTER TABLE usage_facts_daily ADD COLUMN prompt_tokens INTEGER NOT NULL DEFAULT 0;
			ALTER TABLE usage_facts_daily ADD COLUMN completion_tokens INTEGER NOT NULL DEFAULT 0;
			ALTER TABLE usage_facts_daily ADD COLUMN effective_cache_read_tokens INTEGER NOT NULL DEFAULT 0;
			ALTER TABLE usage_facts_daily ADD COLUMN effective_total_tokens INTEGER NOT NULL DEFAULT 0;
			ALTER TABLE usage_facts_local_daily ADD COLUMN prompt_tokens INTEGER NOT NULL DEFAULT 0;
			ALTER TABLE usage_facts_local_daily ADD COLUMN completion_tokens INTEGER NOT NULL DEFAULT 0;
			ALTER TABLE usage_facts_local_daily ADD COLUMN effective_cache_read_tokens INTEGER NOT NULL DEFAULT 0;
			ALTER TABLE usage_facts_local_daily ADD COLUMN effective_total_tokens INTEGER NOT NULL DEFAULT 0;
			INSERT INTO schema_migrations(version, applied_at) VALUES (67, 1000);
			INSERT INTO usage_facts_15m(instance_id, bucket_start_ms, api_group_key, model, provider,
				requests, input_tokens, output_tokens, total_tokens, effective_total_tokens)
			VALUES ('default', 0, 'group', 'legacy-total', '', 1, 0, 0, 600, 600);
			INSERT INTO usage_facts_daily(instance_id, bucket_start_ms, api_group_key, model, provider,
				requests, input_tokens, output_tokens, total_tokens,
				prompt_tokens, completion_tokens, effective_cache_read_tokens, effective_total_tokens)
			VALUES ('default', 0, 'group', 'legacy-total', '', 1, 0, 0, 600, 600, 0, 0, 600);
		`); err != nil {
			t.Fatal(err)
		}

		db.migrateUntil = 0
		if err := db.Migrate(ctx); err != nil {
			t.Fatalf("Migrate(068) failed: %v", err)
		}

		for _, table := range []string{"usage_facts_15m", "usage_facts_daily"} {
			var p, c, cr, tot int64
			if err := db.SQL.QueryRowContext(ctx, `SELECT prompt_tokens, completion_tokens, effective_cache_read_tokens, effective_total_tokens FROM `+table).Scan(&p, &c, &cr, &tot); err != nil {
				t.Fatal(err)
			}
			if p != 600 || c != 0 || cr != 0 || tot != 600 {
				t.Fatalf("%s asymmetric total-only = %d/%d/%d/%d, want 600/0/0/600", table, p, c, cr, tot)
			}
		}
	})

	t.Run("fine partial completion repaired before daily full base rollup", func(t *testing.T) {
		db, err := Open(ctx, "file:mig068_fine_before_daily?mode=memory&cache=shared", withMigrationsUntil(66))
		if err != nil {
			t.Fatal(err)
		}
		defer db.Close()

		if _, err := db.SQL.ExecContext(ctx, `INSERT INTO cpa_instances
			(id, name, base_url, usage_addr, management_key_ciphertext, management_key_nonce, status, created_at, updated_at)
			VALUES ('default', 'Default', 'http://127.0.0.1:8317', '', x'00', x'00', 'unknown', 0, 0)`); err != nil {
			t.Fatal(err)
		}
		// Fine lacks only completion_tokens; daily lacks all base columns.
		// Fine completion=100 must be repaired before daily rolls up from 15m.
		if _, err := db.SQL.ExecContext(ctx, `
			ALTER TABLE usage_events ADD COLUMN client_agent TEXT NOT NULL DEFAULT '';
			ALTER TABLE usage_facts_15m ADD COLUMN prompt_tokens INTEGER NOT NULL DEFAULT 0;
			ALTER TABLE usage_facts_15m ADD COLUMN effective_cache_read_tokens INTEGER NOT NULL DEFAULT 0;
			ALTER TABLE usage_facts_15m ADD COLUMN effective_total_tokens INTEGER NOT NULL DEFAULT 0;
			INSERT INTO schema_migrations(version, applied_at) VALUES (67, 1000);
			INSERT INTO usage_facts_15m(instance_id, bucket_start_ms, api_group_key, model, provider,
				requests, input_tokens, output_tokens, total_tokens, prompt_tokens, effective_total_tokens)
			VALUES ('default', 0, 'group', 'gpt-5', 'openai', 1, 500, 100, 600, 500, 600);
			INSERT INTO usage_facts_daily(instance_id, bucket_start_ms, api_group_key, model, provider,
				requests, input_tokens, output_tokens, total_tokens)
			VALUES ('default', 0, 'group', 'gpt-5', 'openai', 1, 500, 100, 600);
		`); err != nil {
			t.Fatal(err)
		}

		db.migrateUntil = 0
		if err := db.Migrate(ctx); err != nil {
			t.Fatalf("Migrate(068) failed: %v", err)
		}

		for _, table := range []string{"usage_facts_15m", "usage_facts_daily"} {
			var p, c, cr, tot int64
			if err := db.SQL.QueryRowContext(ctx, `SELECT prompt_tokens, completion_tokens, effective_cache_read_tokens, effective_total_tokens FROM `+table).Scan(&p, &c, &cr, &tot); err != nil {
				t.Fatal(err)
			}
			if p != 500 || c != 100 || cr != 0 || tot != 600 {
				t.Fatalf("%s fine-before-daily = %d/%d/%d/%d, want 500/100/0/600", table, p, c, cr, tot)
			}
		}
	})

	t.Run("asymmetric fine missing effective_total_tokens reconciles existing daily nonzero total and preserves zero-base canonical daily rollup", func(t *testing.T) {
		db, err := Open(ctx, "file:mig068_total_reconcile_and_zero_daily?mode=memory&cache=shared", withMigrationsUntil(66))
		if err != nil {
			t.Fatal(err)
		}
		defer db.Close()

		if _, err := db.SQL.ExecContext(ctx, `INSERT INTO cpa_instances
			(id, name, base_url, usage_addr, management_key_ciphertext, management_key_nonce, status, created_at, updated_at)
			VALUES ('default', 'Default', 'http://127.0.0.1:8317', '', x'00', x'00', 'unknown', 0, 0)`); err != nil {
			t.Fatal(err)
		}
		// 1) Fine lacks effective_total_tokens while daily already holds nonzero 300;
		//    fine repairs to 200+200=400 and reconciliation must raise daily from 300 to 400.
		// 2) Fine and daily hold retained canonical zero-base row with cached_tokens=100,
		//    cache_read_tokens=0, total_tokens=120; daily rollup copies cr=0 and standalone
		//    fallback must not overwrite cr to 100.
		if _, err := db.SQL.ExecContext(ctx, `
			ALTER TABLE usage_events ADD COLUMN client_agent TEXT NOT NULL DEFAULT '';
			ALTER TABLE usage_facts_15m ADD COLUMN prompt_tokens INTEGER NOT NULL DEFAULT 0;
			ALTER TABLE usage_facts_15m ADD COLUMN completion_tokens INTEGER NOT NULL DEFAULT 0;
			ALTER TABLE usage_facts_15m ADD COLUMN effective_cache_read_tokens INTEGER NOT NULL DEFAULT 0;
			ALTER TABLE usage_facts_daily ADD COLUMN prompt_tokens INTEGER NOT NULL DEFAULT 0;
			ALTER TABLE usage_facts_daily ADD COLUMN completion_tokens INTEGER NOT NULL DEFAULT 0;
			ALTER TABLE usage_facts_daily ADD COLUMN effective_cache_read_tokens INTEGER NOT NULL DEFAULT 0;
			ALTER TABLE usage_facts_daily ADD COLUMN effective_total_tokens INTEGER NOT NULL DEFAULT 0;
			ALTER TABLE usage_facts_local_daily ADD COLUMN prompt_tokens INTEGER NOT NULL DEFAULT 0;
			ALTER TABLE usage_facts_local_daily ADD COLUMN completion_tokens INTEGER NOT NULL DEFAULT 0;
			ALTER TABLE usage_facts_local_daily ADD COLUMN effective_cache_read_tokens INTEGER NOT NULL DEFAULT 0;
			ALTER TABLE usage_facts_local_daily ADD COLUMN effective_total_tokens INTEGER NOT NULL DEFAULT 0;
			INSERT INTO schema_migrations(version, applied_at) VALUES (67, 1000);
			INSERT INTO usage_facts_15m(instance_id, bucket_start_ms, api_group_key, model, provider,
				requests, input_tokens, output_tokens, total_tokens, prompt_tokens, completion_tokens, effective_cache_read_tokens)
			VALUES
				('default', 0, 'group', 'gpt-5', 'openai', 1, 200, 0, 100, 200, 0, 0),
				('default', 900000, 'group', 'gpt-5', 'openai', 1, 100, 0, 200, 100, 0, 0);
			INSERT INTO usage_facts_daily(instance_id, bucket_start_ms, api_group_key, model, provider,
				requests, input_tokens, output_tokens, total_tokens,
				prompt_tokens, completion_tokens, effective_cache_read_tokens, effective_total_tokens)
			VALUES ('default', 0, 'group', 'gpt-5', 'openai', 2, 300, 0, 300, 300, 0, 0, 300);
			INSERT INTO usage_events(instance_id, event_key, api_group_key, provider, model, timestamp_ms, created_at_ms,
				input_tokens, output_tokens, cached_tokens, cache_read_tokens, total_tokens, token_accounting)
			VALUES ('default', 'ev-zero-base', 'group', 'openai', 'zero-base', 1000, 1000, 0, 0, 100, 0, 120,
				'{"version":2,"status":"complete","raw_tokens":{"input_tokens":0,"output_tokens":0,"cached_tokens":100,"cache_read_tokens":0,"total_tokens":120},"token_breakdown":{"schema_version":2,"quality":"complete","total_tokens":120,"input":{"total_tokens":0,"uncached_tokens":0,"cache_read_tokens":0,"cache_write_tokens":0},"output":{"total_tokens":0,"non_reasoning_tokens":0,"reasoning_tokens":0},"unclassified_tokens":120}}');
			INSERT INTO usage_facts_15m(instance_id, bucket_start_ms, api_group_key, model, provider,
				requests, canonical_requests, cached_tokens, total_tokens, prompt_tokens, completion_tokens, effective_cache_read_tokens)
			VALUES ('default', 0, 'group', 'zero-base', 'openai', 1, 1, 100, 120, 0, 0, 0);
			INSERT INTO usage_facts_daily(instance_id, bucket_start_ms, api_group_key, model, provider,
				requests, canonical_requests, cached_tokens, total_tokens,
				prompt_tokens, completion_tokens, effective_cache_read_tokens, effective_total_tokens)
			VALUES ('default', 0, 'group', 'zero-base', 'openai', 1, 1, 100, 120, 0, 0, 0, 120);
			UPDATE usage_aggregation_checkpoints SET last_usage_event_id = 1 WHERE name = 'facts';
		`); err != nil {
			t.Fatal(err)
		}

		db.migrateUntil = 0
		if err := db.Migrate(ctx); err != nil {
			t.Fatalf("Migrate(068) failed: %v", err)
		}

		var dailyGPTTotal int64
		if err := db.SQL.QueryRowContext(ctx, `SELECT effective_total_tokens FROM usage_facts_daily WHERE model = 'gpt-5'`).Scan(&dailyGPTTotal); err != nil || dailyGPTTotal != 400 {
			t.Fatalf("daily gpt-5 effective_total_tokens = %d (err=%v), want 400", dailyGPTTotal, err)
		}
		for _, table := range []string{"usage_facts_15m", "usage_facts_daily"} {
			var p, c, cr, tot int64
			if err := db.SQL.QueryRowContext(ctx, `SELECT prompt_tokens, completion_tokens, effective_cache_read_tokens, effective_total_tokens FROM `+table+` WHERE model = 'zero-base'`).Scan(&p, &c, &cr, &tot); err != nil {
				t.Fatal(err)
			}
			if p != 0 || c != 0 || cr != 0 || tot != 120 {
				t.Fatalf("%s zero-base canonical = %d/%d/%d/%d, want 0/0/0/120", table, p, c, cr, tot)
			}
		}
	})

	t.Run("expired canonical zero cache_read preserved and asymmetric daily exact total preserved", func(t *testing.T) {
		db, err := Open(ctx, "file:mig068_expired_zero_cr_and_daily_max?mode=memory&cache=shared", withMigrationsUntil(66))
		if err != nil {
			t.Fatal(err)
		}
		defer db.Close()

		if _, err := db.SQL.ExecContext(ctx, `INSERT INTO cpa_instances
			(id, name, base_url, usage_addr, management_key_ciphertext, management_key_nonce, status, created_at, updated_at)
			VALUES ('default', 'Default', 'http://127.0.0.1:8317', '', x'00', x'00', 'unknown', 0, 0)`); err != nil {
			t.Fatal(err)
		}
		// 1) Canonical zero-base row with expired event (no usage_events row) and cached_tokens=100,
		//    cache_read_tokens=0, effective_total_tokens=120: must keep effective_cache_read_tokens=0.
		// 2) Expired mixed-Claude tuple: fine lacks all 4 partition cols (reconstructs total=2100),
		//    while daily lacks only base cols and holds exact effective_total_tokens=2200:
		//    daily total must remain 2200, not drop to 2100.
		if _, err := db.SQL.ExecContext(ctx, `
			ALTER TABLE usage_events ADD COLUMN client_agent TEXT NOT NULL DEFAULT '';
			ALTER TABLE usage_facts_daily ADD COLUMN effective_total_tokens INTEGER NOT NULL DEFAULT 0;
			ALTER TABLE usage_facts_local_daily ADD COLUMN prompt_tokens INTEGER NOT NULL DEFAULT 0;
			ALTER TABLE usage_facts_local_daily ADD COLUMN completion_tokens INTEGER NOT NULL DEFAULT 0;
			ALTER TABLE usage_facts_local_daily ADD COLUMN effective_cache_read_tokens INTEGER NOT NULL DEFAULT 0;
			ALTER TABLE usage_facts_local_daily ADD COLUMN effective_total_tokens INTEGER NOT NULL DEFAULT 0;
			INSERT INTO schema_migrations(version, applied_at) VALUES (67, 1000);
			INSERT INTO usage_facts_15m(instance_id, bucket_start_ms, api_group_key, model, provider,
				requests, canonical_requests, cached_tokens, cache_read_tokens, total_tokens)
			VALUES
				('default', 0, 'group', 'zero-base-expired', 'openai', 1, 1, 100, 0, 120),
				('default', 900000, 'group', 'claude-mixed-expired', 'claude', 2, 1, 0, 200, 2100);
			UPDATE usage_facts_15m SET input_tokens = 1900, output_tokens = 200 WHERE model = 'claude-mixed-expired';
			INSERT INTO usage_facts_daily(instance_id, bucket_start_ms, api_group_key, model, provider,
				requests, canonical_requests, cached_tokens, cache_read_tokens, total_tokens, effective_total_tokens)
			VALUES
				('default', 0, 'group', 'zero-base-expired', 'openai', 1, 1, 100, 0, 120, 120),
				('default', 0, 'group', 'claude-mixed-expired', 'claude', 2, 1, 0, 200, 2100, 2200);
			UPDATE usage_facts_daily SET input_tokens = 1900, output_tokens = 200 WHERE model = 'claude-mixed-expired';
		`); err != nil {
			t.Fatal(err)
		}

		db.migrateUntil = 0
		if err := db.Migrate(ctx); err != nil {
			t.Fatalf("Migrate(068) failed: %v", err)
		}

		for _, table := range []string{"usage_facts_15m", "usage_facts_daily"} {
			var p, c, cr, tot int64
			if err := db.SQL.QueryRowContext(ctx, `SELECT prompt_tokens, completion_tokens, effective_cache_read_tokens, effective_total_tokens FROM `+table+` WHERE model = 'zero-base-expired'`).Scan(&p, &c, &cr, &tot); err != nil {
				t.Fatal(err)
			}
			if p != 0 || c != 0 || cr != 0 || tot != 120 {
				t.Fatalf("%s zero-base-expired = %d/%d/%d/%d, want 0/0/0/120", table, p, c, cr, tot)
			}
		}
		var dailyMixedTotal int64
		if err := db.SQL.QueryRowContext(ctx, `SELECT effective_total_tokens FROM usage_facts_daily WHERE model = 'claude-mixed-expired'`).Scan(&dailyMixedTotal); err != nil || dailyMixedTotal != 2200 {
			t.Fatalf("daily claude-mixed-expired effective_total_tokens = %d (err=%v), want 2200", dailyMixedTotal, err)
		}
	})

	t.Run("asymmetric columns per table, retained exact zero cache_read, and nonzero total reconciliation", func(t *testing.T) {
		db, err := Open(ctx, "file:mig068_asymmetric_reconcile?mode=memory&cache=shared", withMigrationsUntil(66))
		if err != nil {
			t.Fatal(err)
		}
		defer db.Close()

		if _, err := db.SQL.ExecContext(ctx, `INSERT INTO cpa_instances
			(id, name, base_url, usage_addr, management_key_ciphertext, management_key_nonce, status, created_at, updated_at)
			VALUES ('default', 'Default', 'http://127.0.0.1:8317', '', x'00', x'00', 'unknown', 0, 0)`); err != nil {
			t.Fatal(err)
		}
		// Asymmetric schema across tables:
		// - usage_facts_15m lacks prompt_tokens + effective_cache_read_tokens (has completion_tokens, effective_total_tokens)
		// - usage_facts_daily lacks completion_tokens + effective_cache_read_tokens (has prompt_tokens, effective_total_tokens)
		// - usage_facts_local_daily lacks effective_cache_read_tokens
		if _, err := db.SQL.ExecContext(ctx, `
			ALTER TABLE usage_events ADD COLUMN client_agent TEXT NOT NULL DEFAULT '';
			ALTER TABLE usage_facts_15m ADD COLUMN completion_tokens INTEGER NOT NULL DEFAULT 0;
			ALTER TABLE usage_facts_15m ADD COLUMN effective_total_tokens INTEGER NOT NULL DEFAULT 0;
			ALTER TABLE usage_facts_daily ADD COLUMN prompt_tokens INTEGER NOT NULL DEFAULT 0;
			ALTER TABLE usage_facts_daily ADD COLUMN effective_total_tokens INTEGER NOT NULL DEFAULT 0;
			ALTER TABLE usage_facts_local_daily ADD COLUMN prompt_tokens INTEGER NOT NULL DEFAULT 0;
			ALTER TABLE usage_facts_local_daily ADD COLUMN completion_tokens INTEGER NOT NULL DEFAULT 0;
			ALTER TABLE usage_facts_local_daily ADD COLUMN effective_total_tokens INTEGER NOT NULL DEFAULT 0;
			INSERT INTO schema_migrations(version, applied_at) VALUES (67, 1000);
			-- Row 1: retained OpenAI event with cached_tokens=100, cache_read_tokens=0 (exact cache_read must remain 0, not 100).
			INSERT INTO usage_events(instance_id, event_key, api_group_key, provider, model, timestamp_ms, created_at_ms,
				input_tokens, output_tokens, cached_tokens, cache_read_tokens, total_tokens, token_accounting)
			VALUES ('default', 'ev-zero-cr', 'group', 'openai', 'gpt-5', 1000, 1000, 100, 20, 100, 0, 120,
				'{"version":2,"status":"complete","raw_tokens":{"input_tokens":100,"output_tokens":20,"cached_tokens":100,"cache_read_tokens":0,"total_tokens":120},"token_breakdown":{"schema_version":2,"quality":"complete","total_tokens":120,"input":{"total_tokens":100,"uncached_tokens":100,"cache_read_tokens":0,"cache_write_tokens":0},"output":{"total_tokens":20,"non_reasoning_tokens":20,"reasoning_tokens":0},"unclassified_tokens":0}}');
			INSERT INTO usage_facts_15m(instance_id, bucket_start_ms, api_group_key, model, provider,
				requests, canonical_requests, input_tokens, output_tokens, cached_tokens, cache_read_tokens, total_tokens,
				completion_tokens, effective_total_tokens)
			VALUES ('default', 0, 'group', 'gpt-5', 'openai', 1, 1, 100, 20, 100, 0, 120, 20, 120);
			INSERT INTO usage_facts_daily(instance_id, bucket_start_ms, api_group_key, model, provider,
				requests, canonical_requests, input_tokens, output_tokens, cached_tokens, cache_read_tokens, total_tokens,
				prompt_tokens, effective_total_tokens)
			VALUES ('default', 0, 'group', 'gpt-5', 'openai', 1, 1, 100, 20, 100, 0, 120, 100, 120);
			UPDATE usage_aggregation_checkpoints SET last_usage_event_id = 1 WHERE name = 'facts';
			-- Row 2: expired Claude row missing prompt_tokens on 15m and completion_tokens on daily,
			-- with nonzero effective_total_tokens=200 that must be reconciled up to 1100.
			INSERT INTO usage_facts_15m(instance_id, bucket_start_ms, api_group_key, model, provider,
				requests, input_tokens, output_tokens, cache_read_tokens, total_tokens,
				completion_tokens, effective_total_tokens)
			VALUES ('default', 900000, 'group', 'claude-sonnet', 'claude', 1, 100, 100, 900, 200, 100, 200);
			INSERT INTO usage_facts_daily(instance_id, bucket_start_ms, api_group_key, model, provider,
				requests, input_tokens, output_tokens, cache_read_tokens, total_tokens,
				prompt_tokens, effective_total_tokens)
			VALUES ('default', 0, 'group', 'claude-sonnet', 'claude', 1, 100, 100, 900, 200, 1000, 200);
		`); err != nil {
			t.Fatal(err)
		}

		db.migrateUntil = 0
		if err := db.Migrate(ctx); err != nil {
			t.Fatalf("Migrate(068) failed: %v", err)
		}

		for _, table := range []string{"usage_facts_15m", "usage_facts_daily"} {
			var p, c, cr, tot int64
			if err := db.SQL.QueryRowContext(ctx, `SELECT prompt_tokens, completion_tokens, effective_cache_read_tokens, effective_total_tokens FROM `+table+` WHERE model = 'gpt-5'`).Scan(&p, &c, &cr, &tot); err != nil {
				t.Fatal(err)
			}
			if p != 100 || c != 20 || cr != 0 || tot != 120 {
				t.Fatalf("%s retained exact zero cache_read = %d/%d/%d/%d, want 100/20/0/120", table, p, c, cr, tot)
			}
			if err := db.SQL.QueryRowContext(ctx, `SELECT prompt_tokens, completion_tokens, effective_cache_read_tokens, effective_total_tokens FROM `+table+` WHERE model = 'claude-sonnet'`).Scan(&p, &c, &cr, &tot); err != nil {
				t.Fatal(err)
			}
			if p != 1000 || c != 100 || cr != 900 || tot != 1100 {
				t.Fatalf("%s reconciled claude = %d/%d/%d/%d, want 1000/100/900/1100", table, p, c, cr, tot)
			}
		}
	})

	t.Run("clean 067 upgrade preserves valid local daily cache", func(t *testing.T) {
		db, err := Open(ctx, "file:mig068_clean_067?mode=memory&cache=shared", withMigrationsUntil(67))
		if err != nil {
			t.Fatal(err)
		}
		defer db.Close()

		if _, err := db.SQL.ExecContext(ctx, `
			INSERT INTO usage_facts_15m(instance_id, bucket_start_ms, api_group_key, model, provider,
				requests, input_tokens, output_tokens, cached_tokens, total_tokens,
				prompt_tokens, completion_tokens, effective_cache_read_tokens, effective_total_tokens)
			VALUES ('default', 0, 'group', 'gpt-5', 'openai', 1, 500, 100, 300, 600, 500, 100, 300, 600);
			INSERT INTO usage_facts_daily(instance_id, bucket_start_ms, api_group_key, model, provider,
				requests, input_tokens, output_tokens, cached_tokens, total_tokens,
				prompt_tokens, completion_tokens, effective_cache_read_tokens, effective_total_tokens)
			VALUES ('default', 0, 'group', 'gpt-5', 'openai', 1, 500, 100, 300, 600, 500, 100, 300, 600);
			INSERT INTO usage_facts_local_daily(instance_id, zone, day_wall_ms, api_group_key, model, provider,
				requests, input_tokens, output_tokens, cached_tokens, total_tokens,
				prompt_tokens, completion_tokens, effective_cache_read_tokens, effective_total_tokens)
			VALUES ('default', 'UTC', 0, 'group', 'gpt-5', 'openai', 1, 500, 100, 300, 600, 500, 100, 300, 600);
			INSERT INTO usage_aggregation_checkpoints(name, last_usage_event_id, stats_updated_at_ms, created_at_ms, updated_at_ms)
			VALUES ('facts_local:UTC', 1, 0, 0, 0);
		`); err != nil {
			t.Fatal(err)
		}

		db.migrateUntil = 0
		if err := db.Migrate(ctx); err != nil {
			t.Fatalf("Migrate(068) on clean 067 failed: %v", err)
		}

		var localCount int
		if err := db.SQL.QueryRowContext(ctx, `SELECT COUNT(*) FROM usage_facts_local_daily`).Scan(&localCount); err != nil || localCount != 1 {
			t.Fatalf("expected valid local daily cache preserved on clean 067 upgrade, got %d (err=%v)", localCount, err)
		}
	})
}

func TestMigration069BackfillsClientPrefixAndPopulatesClientRollups(t *testing.T) {
	ctx := context.Background()
	db, err := Open(ctx, "file:mig069_client_rollup?mode=memory&cache=shared", withMigrationsUntil(68))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	if _, err := db.SQL.ExecContext(ctx, `INSERT INTO cpa_instances
		(id, name, base_url, usage_addr, management_key_ciphertext, management_key_nonce, status, created_at, updated_at)
		VALUES ('default', 'Default', 'http://127.0.0.1:8317', '', x'00', x'00', 'unknown', 0, 0)`); err != nil {
		t.Fatal(err)
	}
	dayStart := int64(1700006400000) // UTC midnight
	if _, err := db.SQL.ExecContext(ctx, `
		INSERT INTO usage_events (
			instance_id, event_key, api_group_key, provider, endpoint, model, generate,
			client_agent, user_agent, timestamp_ms, created_at_ms, input_tokens, output_tokens, total_tokens, pricing_status
		) VALUES
			('default', 'folded-claude', 'hmac:k1', 'claude', 'POST /v1/messages', 'claude-sonnet', 1,
			 'claude-code', 'claude-cli/2.1.14', ?, 0, 100, 40, 140, 'unpriced'),
			('default', 'folded-qwen', 'hmac:k1', 'openai', 'POST /v1/messages', 'qwen-coder', 1,
			 'qwen-code', 'claude-cli/0.1.5', ?, 0, 200, 50, 250, 'unpriced'),
			('default', 'folded-warmup', 'hmac:k1', 'codex', 'GET /v1/realtime', 'gpt-5', 0,
			 'codex-cli', 'codex_cli_rs/0.47.0', ?, 0, 0, 0, 0, 'unpriced'),
			('default', 'tail-pi', 'hmac:k1', 'codex', 'POST /v1/responses', 'gpt-5', 1,
			 '', 'pi/1.5.0', ?, 0, 300, 60, 360, 'unpriced');
		UPDATE usage_aggregation_checkpoints SET last_usage_event_id = 3 WHERE name = 'facts';
	`, dayStart+1000, dayStart+2000, dayStart+3000, dayStart+DayBucketMS+1000); err != nil {
		t.Fatal(err)
	}

	db.migrateUntil = 0
	if err := db.Migrate(ctx); err != nil {
		t.Fatalf("Migrate(069) failed: %v", err)
	}

	var claudePrefix, qwenPrefix, piAgent, piPrefix string
	if err := db.SQL.QueryRowContext(ctx, `SELECT client_prefix FROM usage_events WHERE event_key = 'folded-claude'`).Scan(&claudePrefix); err != nil || claudePrefix != "claude-cli/2." {
		t.Fatalf("folded-claude client_prefix = %q (err=%v), want claude-cli/2.", claudePrefix, err)
	}
	if err := db.SQL.QueryRowContext(ctx, `SELECT client_prefix FROM usage_events WHERE event_key = 'folded-qwen'`).Scan(&qwenPrefix); err != nil || qwenPrefix != "claude-cli/0." {
		t.Fatalf("folded-qwen client_prefix = %q (err=%v), want claude-cli/0.", qwenPrefix, err)
	}
	if err := db.SQL.QueryRowContext(ctx, `SELECT client_agent, client_prefix FROM usage_events WHERE event_key = 'tail-pi'`).Scan(&piAgent, &piPrefix); err != nil || piAgent != usage.ClientAgentPi || piPrefix != "pi" {
		t.Fatalf("tail-pi = (%q, %q) (err=%v), want (pi, pi)", piAgent, piPrefix, err)
	}

	var dailyRows int
	if err := db.SQL.QueryRowContext(ctx, `SELECT COUNT(*) FROM usage_client_facts_daily`).Scan(&dailyRows); err != nil || dailyRows != 3 {
		t.Fatalf("expected 3 daily client rollup rows (claude-code, qwen-code, warmup), got %d (err=%v)", dailyRows, err)
	}

	repo := New(db)
	res, err := repo.QueryUsageClientAgents(ctx, "default", dayStart, dayStart+2*DayBucketMS-1, nil)
	if err != nil {
		t.Fatalf("QueryUsageClientAgents failed: %v", err)
	}
	if res.RetainedRequests != 4 || len(res.Items) != 3 {
		t.Fatalf("QueryUsageClientAgents = %+v, want RetainedRequests=4 and 3 items", res)
	}
	byID := map[string]UsageClientAgentRow{}
	for _, item := range res.Items {
		byID[item.ID] = item
	}
	if byID[usage.ClientAgentClaudeCode].RawPrefix != "claude-cli/2." || byID[usage.ClientAgentQwenCode].RawPrefix != "claude-cli/0." || byID[usage.ClientAgentPi].RawPrefix != "pi" {
		t.Fatalf("unexpected prefixes after 069 upgrade: %+v", byID)
	}

	// Verify foldPricedCorrections propagates repriced cost into client rollups after AggregateUsageFacts.
	if folded, err := repo.AggregateUsageFacts(ctx, 100); err != nil || folded != 1 {
		t.Fatalf("AggregateUsageFacts = %d err=%v", folded, err)
	}
	if err := repo.UpsertModelPrices(ctx, []pricing.ModelPrice{{
		Model:            "claude-sonnet",
		PromptPricePer1M: 10,
		CompletionPer1M:  20,
		PriceMultiplier:  1,
		Source:           pricing.SourceOpenRouter,
	}}); err != nil {
		t.Fatal(err)
	}
	if priced, err := repo.PriceUnpricedUsage(ctx, "claude-sonnet", time.Now().UnixMilli()+1000); err != nil || priced != 1 {
		t.Fatalf("PriceUnpricedUsage = %d err=%v", priced, err)
	}
	afterReprice, err := repo.QueryUsageClientAgents(ctx, "default", dayStart, dayStart+2*DayBucketMS-1, nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, item := range afterReprice.Items {
		if item.ID == usage.ClientAgentClaudeCode && (item.CostNanos <= 0 || item.PricedRequests != 1 || item.CostedRequests != 1) {
			t.Fatalf("expected repriced cost propagated to client rollup, got %+v", item)
		}
	}
}

func TestMigration070RepairsCodexDesktopClientAgentAndMergesRollups(t *testing.T) {
	ctx := context.Background()
	db, err := Open(ctx, "file:mig070_codex_desktop?mode=memory&cache=shared", withMigrationsUntil(69))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	if _, err := db.SQL.ExecContext(ctx, `INSERT INTO cpa_instances
		(id, name, base_url, usage_addr, management_key_ciphertext, management_key_nonce, status, created_at, updated_at)
		VALUES ('default', 'Default', 'http://127.0.0.1:8317', '', x'00', x'00', 'unknown', 0, 0)`); err != nil {
		t.Fatal(err)
	}
	dayStart := int64(1700006400000) // UTC midnight
	if _, err := db.SQL.ExecContext(ctx, `
		INSERT INTO usage_events (
			instance_id, event_key, api_group_key, provider, endpoint, model, generate,
			client_agent, client_prefix, user_agent, timestamp_ms, created_at_ms, input_tokens, output_tokens, total_tokens, pricing_status
		) VALUES
			('default', 'folded-desktop-fallback', 'hmac:k1', 'codex', 'POST /v1/responses', 'gpt-5', 1,
			 'codex', 'Codex', 'Codex', ?, 0, 100, 50, 150, 'unpriced'),
			('default', 'folded-codex-versioned', 'hmac:k1', 'codex', 'POST /v1/responses', 'gpt-5', 1,
			 'codex-cli', 'Codex', 'Codex/0.150.0', ?, 0, 200, 80, 280, 'unpriced'),
			('default', 'folded-chatgpt-desktop', 'hmac:k1', 'codex', 'POST /v1/responses', 'gpt-5', 1,
			 'codex_chatgpt_desktop', 'codex_chatgpt_desktop', 'codex_chatgpt_desktop/1.0.0', ?, 0, 50, 10, 60, 'unpriced'),
			('default', 'folded-codex-cli-rs', 'hmac:k1', 'codex', 'POST /v1/responses', 'gpt-5', 1,
			 'codex-cli', 'codex_cli_rs', 'codex_cli_rs/0.47.0', ?, 0, 300, 100, 400, 'unpriced')`,
		dayStart+1000, dayStart+2000, dayStart+3000, dayStart+4000); err != nil {
		t.Fatal(err)
	}

	repo := New(db)
	if folded, err := repo.AggregateUsageFacts(ctx, 100); err != nil || folded != 4 {
		t.Fatalf("AggregateUsageFacts pre-070 = %d err=%v", folded, err)
	}
	if _, err := db.SQL.ExecContext(ctx, `
		INSERT INTO usage_events (
			instance_id, event_key, api_group_key, provider, endpoint, model, generate,
			client_agent, client_prefix, user_agent, timestamp_ms, created_at_ms, input_tokens, output_tokens, total_tokens, pricing_status
		) VALUES
			('default', 'tail-desktop-fallback', 'hmac:k1', 'codex', 'POST /v1/responses', 'gpt-5', 1,
			 'codex', 'Codex', 'Codex', ?, 0, 40, 20, 60, 'unpriced')`,
		dayStart+DayBucketMS+1000); err != nil {
		t.Fatal(err)
	}

	db.migrateUntil = 0
	if err := db.Migrate(ctx); err != nil {
		t.Fatalf("Migrate(070) failed: %v", err)
	}

	var leftoverEvents, leftoverFine, leftoverDaily int
	if err := db.SQL.QueryRowContext(ctx, `SELECT COUNT(*) FROM usage_events WHERE client_agent <> ?`, usage.ClientAgentCodexCLI).Scan(&leftoverEvents); err != nil || leftoverEvents != 0 {
		t.Fatalf("expected 0 non-codex-cli usage_events rows, got %d (err=%v)", leftoverEvents, err)
	}
	if err := db.SQL.QueryRowContext(ctx, `SELECT COUNT(*) FROM usage_client_facts_15m WHERE client_agent <> ?`, usage.ClientAgentCodexCLI).Scan(&leftoverFine); err != nil || leftoverFine != 0 {
		t.Fatalf("expected 0 non-codex-cli 15m rows, got %d (err=%v)", leftoverFine, err)
	}
	if err := db.SQL.QueryRowContext(ctx, `SELECT COUNT(*) FROM usage_client_facts_daily WHERE client_agent <> ?`, usage.ClientAgentCodexCLI).Scan(&leftoverDaily); err != nil || leftoverDaily != 0 {
		t.Fatalf("expected 0 non-codex-cli daily rows, got %d (err=%v)", leftoverDaily, err)
	}

	var mergedReqs, mergedPrompt, mergedComp, mergedTotal int64
	if err := db.SQL.QueryRowContext(ctx, `
		SELECT requests, prompt_tokens, completion_tokens, effective_total_tokens
		FROM usage_client_facts_daily
		WHERE instance_id = 'default' AND client_agent = ? AND client_prefix = 'Codex'`,
		usage.ClientAgentCodexCLI,
	).Scan(&mergedReqs, &mergedPrompt, &mergedComp, &mergedTotal); err != nil {
		t.Fatalf("query merged daily row: %v", err)
	}
	if mergedReqs != 2 || mergedPrompt != 300 || mergedComp != 130 || mergedTotal != 430 {
		t.Fatalf("merged daily row = (reqs=%d, prompt=%d, comp=%d, total=%d), want (2, 300, 130, 430)",
			mergedReqs, mergedPrompt, mergedComp, mergedTotal)
	}

	res, err := repo.QueryUsageClientAgents(ctx, "default", dayStart, dayStart+2*DayBucketMS-1, nil)
	if err != nil {
		t.Fatalf("QueryUsageClientAgents failed: %v", err)
	}
	if res.RetainedRequests != 5 || len(res.Items) != 1 {
		t.Fatalf("QueryUsageClientAgents = %+v, want RetainedRequests=5 and 1 unified item", res)
	}
	if got := res.Items[0]; got.ID != usage.ClientAgentCodexCLI || got.Category != string(usage.ClientAgentCategoryAgent) || got.Requests != 5 || got.TotalTokens != 950 || got.RawPrefix != "Codex" {
		t.Fatalf("unified codex client item = %+v", got)
	}

	eventsPage, err := repo.ListUsageEvents(ctx, UsageEventFilter{
		InstanceID:   "default",
		FromMS:       dayStart,
		ToMS:         dayStart + 2*DayBucketMS - 1,
		ClientAgents: []string{usage.ClientAgentCodexCLI},
		Limit:        10,
	})
	if err != nil || len(eventsPage.Items) != 5 {
		t.Fatalf("ListUsageEvents(client_agent=codex-cli) = %d items (err=%v), want 5", len(eventsPage.Items), err)
	}

	// Verify tail folding and re-running the repair hook after 070 remain clean and idempotent.
	if foldedTail, err := repo.AggregateUsageFacts(ctx, 100); err != nil || foldedTail != 1 {
		t.Fatalf("AggregateUsageFacts post-070 = %d err=%v", foldedTail, err)
	}
	postFold, err := repo.QueryUsageClientAgents(ctx, "default", dayStart, dayStart+2*DayBucketMS-1, nil)
	if err != nil || postFold.RetainedRequests != 5 || len(postFold.Items) != 1 || postFold.Items[0].Requests != 5 {
		t.Fatalf("QueryUsageClientAgents post-fold = %+v (err=%v)", postFold, err)
	}
}

func TestMigration066To070PreservesMinimizedCodexDesktopAttribution(t *testing.T) {
	ctx := context.Background()
	db, err := Open(ctx, "file:mig066_to_070_codex?mode=memory&cache=shared", withMigrationsUntil(66))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	if _, err := db.SQL.ExecContext(ctx, `INSERT INTO cpa_instances
		(id, name, base_url, usage_addr, management_key_ciphertext, management_key_nonce, status, created_at, updated_at)
		VALUES ('default', 'Default', 'http://127.0.0.1:8317', '', x'00', x'00', 'unknown', 0, 0)`); err != nil {
		t.Fatal(err)
	}
	dayStart := int64(1700006400000) // UTC midnight
	if _, err := db.SQL.ExecContext(ctx, `
		INSERT INTO usage_events (
			instance_id, event_key, api_group_key, provider, endpoint, model, generate,
			user_agent, timestamp_ms, created_at_ms, input_tokens, output_tokens, total_tokens, pricing_status
		) VALUES
			('default', 'hist-066-desktop', 'hmac:k1', 'codex', 'POST /v1/responses', 'gpt-5', 1,
			 'Codex', ?, 0, 120, 30, 150, 'unpriced'),
			('default', 'hist-066-cli', 'hmac:k1', 'codex', 'POST /v1/responses', 'gpt-5', 1,
			 'codex_cli_rs/0.47.0', ?, 0, 80, 20, 100, 'unpriced');
		INSERT INTO usage_facts_15m (
			instance_id, bucket_start_ms, api_group_key, model, provider,
			requests, input_tokens, output_tokens, total_tokens
		) VALUES ('default', ?, 'hmac:k1', 'gpt-5', 'codex', 1, 120, 30, 150);
		INSERT INTO usage_facts_daily (
			instance_id, bucket_start_ms, api_group_key, model, provider,
			requests, input_tokens, output_tokens, total_tokens
		) VALUES ('default', ?, 'hmac:k1', 'gpt-5', 'codex', 1, 120, 30, 150);
		UPDATE usage_aggregation_checkpoints SET last_usage_event_id = 1 WHERE name = 'facts'`,
		dayStart+1000, dayStart+2000, dayStart, dayStart); err != nil {
		t.Fatal(err)
	}

	repo := New(db)
	db.migrateUntil = 0
	if err := db.Migrate(ctx); err != nil {
		t.Fatalf("Migrate(066->070) failed: %v", err)
	}

	var storedAgent, storedPrefix string
	if err := db.SQL.QueryRowContext(ctx, `SELECT client_agent, client_prefix FROM usage_events WHERE event_key = 'hist-066-desktop'`).Scan(&storedAgent, &storedPrefix); err != nil {
		t.Fatal(err)
	}
	if storedAgent != usage.ClientAgentCodexCLI || storedPrefix != "Codex" {
		t.Fatalf("hist-066-desktop = (%q, %q), want (%q, %q)", storedAgent, storedPrefix, usage.ClientAgentCodexCLI, "Codex")
	}

	res, err := repo.QueryUsageClientAgents(ctx, "default", dayStart, dayStart+DayBucketMS-1, nil)
	if err != nil {
		t.Fatalf("QueryUsageClientAgents failed: %v", err)
	}
	if res.RetainedRequests != 2 || len(res.Items) != 1 {
		t.Fatalf("QueryUsageClientAgents = %+v, want RetainedRequests=2 and 1 unified item", res)
	}
	if got := res.Items[0]; got.ID != usage.ClientAgentCodexCLI || got.Category != string(usage.ClientAgentCategoryAgent) || got.Requests != 2 || got.TotalTokens != 250 {
		t.Fatalf("QueryUsageClientAgents item = %+v, want unified codex-cli with 2 requests and 250 tokens", got)
	}

	eventsPage, err := repo.ListUsageEvents(ctx, UsageEventFilter{
		InstanceID:   "default",
		FromMS:       dayStart,
		ToMS:         dayStart + DayBucketMS - 1,
		ClientAgents: []string{usage.ClientAgentCodexCLI},
		Limit:        10,
	})
	if err != nil || len(eventsPage.Items) != 2 {
		t.Fatalf("ListUsageEvents(client_agent=codex-cli) = %d items (err=%v), want 2", len(eventsPage.Items), err)
	}
}

func TestMigration068To070PreservesCodexAliasPrefix(t *testing.T) {
	ctx := context.Background()
	db, err := Open(ctx, "file:mig068_to_070_codex_alias?mode=memory&cache=shared", withMigrationsUntil(68))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	if _, err := db.SQL.ExecContext(ctx, `INSERT INTO cpa_instances
		(id, name, base_url, usage_addr, management_key_ciphertext, management_key_nonce, status, created_at, updated_at)
		VALUES ('default', 'Default', 'http://127.0.0.1:8317', '', x'00', x'00', 'unknown', 0, 0)`); err != nil {
		t.Fatal(err)
	}
	dayStart := int64(1700006400000) // UTC midnight
	if _, err := db.SQL.ExecContext(ctx, `
		INSERT INTO usage_events (
			instance_id, event_key, api_group_key, provider, endpoint, model, generate,
			client_agent, user_agent, timestamp_ms, created_at_ms, input_tokens, output_tokens, total_tokens, pricing_status
		) VALUES
			('default', 'hist-068-chatgpt-desktop', 'hmac:k1', 'codex', 'POST /v1/responses', 'gpt-5', 1,
			 'codex_chatgpt_desktop', 'codex_chatgpt_desktop/1.0.0', ?, 0, 100, 25, 125, 'unpriced'),
			('default', 'hist-068-tail', 'hmac:k1', 'codex', 'POST /v1/responses', 'gpt-5', 1,
			 'codex', 'Codex', ?, 0, 60, 15, 75, 'unpriced');
		UPDATE usage_aggregation_checkpoints SET last_usage_event_id = 1 WHERE name = 'facts'`,
		dayStart+1000, dayStart+2000); err != nil {
		t.Fatal(err)
	}

	repo := New(db)
	db.migrateUntil = 0
	if err := db.Migrate(ctx); err != nil {
		t.Fatalf("Migrate(068->070) failed: %v", err)
	}

	var storedAgent, storedPrefix string
	if err := db.SQL.QueryRowContext(ctx, `SELECT client_agent, client_prefix FROM usage_events WHERE event_key = 'hist-068-chatgpt-desktop'`).Scan(&storedAgent, &storedPrefix); err != nil {
		t.Fatal(err)
	}
	if storedAgent != usage.ClientAgentCodexCLI || storedPrefix != "codex_chatgpt_desktop" {
		t.Fatalf("hist-068-chatgpt-desktop = (%q, %q), want (%q, %q)", storedAgent, storedPrefix, usage.ClientAgentCodexCLI, "codex_chatgpt_desktop")
	}
	if err := db.SQL.QueryRowContext(ctx, `SELECT client_agent, client_prefix FROM usage_events WHERE event_key = 'hist-068-tail'`).Scan(&storedAgent, &storedPrefix); err != nil {
		t.Fatal(err)
	}
	if storedAgent != usage.ClientAgentCodexCLI || storedPrefix != "Codex" {
		t.Fatalf("hist-068-tail = (%q, %q), want (%q, %q)", storedAgent, storedPrefix, usage.ClientAgentCodexCLI, "Codex")
	}

	res, err := repo.QueryUsageClientAgents(ctx, "default", dayStart, dayStart+DayBucketMS-1, nil)
	if err != nil {
		t.Fatalf("QueryUsageClientAgents failed: %v", err)
	}
	if res.RetainedRequests != 2 || len(res.Items) != 1 {
		t.Fatalf("QueryUsageClientAgents = %+v, want RetainedRequests=2 and 1 unified item", res)
	}
	if got := res.Items[0]; got.ID != usage.ClientAgentCodexCLI || got.Requests != 2 || got.TotalTokens != 200 || got.RawPrefix == "" {
		t.Fatalf("QueryUsageClientAgents item = %+v, want unified codex-cli with retained prefix", got)
	}
}
