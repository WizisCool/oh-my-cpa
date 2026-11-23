package repository

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/crypto"
	"github.com/oh-my-cpa/oh-my-cpa/internal/domain"
)

var repoTestDBCounter atomic.Uint64

func uniqueMemoryDSN() string {
	return fmt.Sprintf("file:omc_repo_%d?mode=memory&cache=shared", repoTestDBCounter.Add(1))
}

func testRepository(t *testing.T) (*Repository, *crypto.Cipher) {
	t.Helper()
	db, err := Open(context.Background(), uniqueMemoryDSN())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	cipher, err := crypto.New("01234567890123456789012345678901")
	if err != nil {
		t.Fatal(err)
	}
	return New(db), cipher
}

func TestFreshBootstrapMatchesStepByStepMigrations(t *testing.T) {
	ctx := context.Background()
	stepped, err := Open(ctx, uniqueMemoryDSN(), withoutFastBootstrap())
	if err != nil {
		t.Fatal(err)
	}
	defer stepped.Close()

	// Prime and consume the cached post-migration bootstrap snapshot across two fresh DBs.
	firstFast, err := Open(ctx, uniqueMemoryDSN())
	if err != nil {
		t.Fatal(err)
	}
	defer firstFast.Close()
	secondFast, err := Open(ctx, uniqueMemoryDSN())
	if err != nil {
		t.Fatal(err)
	}
	defer secondFast.Close()

	readSchemaAndCounts := func(sqlDB *sql.DB) ([]string, []int, map[string]int) {
		t.Helper()
		rows, err := sqlDB.QueryContext(ctx, `
			SELECT type || ':' || name || ':' || tbl_name || ':' || COALESCE(sql, '')
			FROM sqlite_master
			WHERE name NOT LIKE 'sqlite_%'
			ORDER BY type, name`)
		if err != nil {
			t.Fatal(err)
		}
		defer rows.Close()
		var objects []string
		var tables []string
		for rows.Next() {
			var entry string
			if err := rows.Scan(&entry); err != nil {
				t.Fatal(err)
			}
			objects = append(objects, entry)
		}
		if err := rows.Err(); err != nil {
			t.Fatal(err)
		}

		tableRows, err := sqlDB.QueryContext(ctx, `
			SELECT name FROM sqlite_master
			WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
			ORDER BY name`)
		if err != nil {
			t.Fatal(err)
		}
		defer tableRows.Close()
		for tableRows.Next() {
			var table string
			if err := tableRows.Scan(&table); err != nil {
				t.Fatal(err)
			}
			tables = append(tables, table)
		}
		if err := tableRows.Err(); err != nil {
			t.Fatal(err)
		}

		counts := make(map[string]int, len(tables))
		for _, table := range tables {
			var count int
			if err := sqlDB.QueryRowContext(ctx, `SELECT COUNT(*) FROM "`+table+`"`).Scan(&count); err != nil {
				t.Fatal(err)
			}
			counts[table] = count
		}

		verRows, err := sqlDB.QueryContext(ctx, `SELECT version FROM schema_migrations ORDER BY version`)
		if err != nil {
			t.Fatal(err)
		}
		defer verRows.Close()
		var versions []int
		for verRows.Next() {
			var v int
			if err := verRows.Scan(&v); err != nil {
				t.Fatal(err)
			}
			versions = append(versions, v)
		}
		if err := verRows.Err(); err != nil {
			t.Fatal(err)
		}
		return objects, versions, counts
	}

	wantObjects, wantVersions, wantCounts := readSchemaAndCounts(stepped.SQL)
	gotObjects, gotVersions, gotCounts := readSchemaAndCounts(secondFast.SQL)
	if !reflect.DeepEqual(gotObjects, wantObjects) {
		t.Fatalf("bootstrap DDL drifted from step-by-step migrations:\ngot:  %v\nwant: %v", gotObjects, wantObjects)
	}
	if !reflect.DeepEqual(gotVersions, wantVersions) {
		t.Fatalf("bootstrap versions = %v, want %v", gotVersions, wantVersions)
	}
	if !reflect.DeepEqual(gotCounts, wantCounts) {
		t.Fatalf("bootstrap seed row counts = %v, want %v", gotCounts, wantCounts)
	}
}

func TestMigrationsAndResourceOverride(t *testing.T) {
	repo, cipher := testRepository(t)
	ciphertext, nonce, err := cipher.Encrypt([]byte("secret"))
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC().Truncate(time.Second)
	if err := repo.UpsertInstance(context.Background(), domain.CPAInstance{
		ID:                      "default",
		Name:                    "Default",
		BaseURL:                 "http://cpa:8317",
		UsageAddr:               "cpa:8317",
		ManagementKeyCiphertext: ciphertext,
		ManagementKeyNonce:      nonce,
		CreatedAt:               now,
		UpdatedAt:               now,
	}); err != nil {
		t.Fatal(err)
	}
	resources, err := repo.UpsertDiscoveredResources(context.Background(), "default", []domain.DiscoveredResource{{
		ResourceKey:     "hmac:one",
		CPAResourceType: "codex-api-key",
		CPADriver:       "codex",
		ProtocolDriver:  "openai_responses",
		ProtocolDisplay: "OpenAI Responses",
		BaseURL:         "https://api.deepseek.com",
		SuggestedSource: "DeepSeek",
		Status:          domain.ResourceStatusUnclaimed,
	}}, now, true)
	if err != nil {
		t.Fatal(err)
	}
	if len(resources) != 1 {
		t.Fatalf("stored resources = %d, want 1", len(resources))
	}
	name := "DeepSeek 官方主线路"
	icon := "deepseek"
	color := "#1E88E5"
	status := domain.ResourceStatusClaimed
	updated, err := repo.UpdateResourceOverride(context.Background(), resources[0].ID, domain.ResourceOverride{
		DisplayName:    &name,
		IconRef:        &icon,
		Color:          &color,
		Status:         &status,
		DisplayNameSet: true,
		IconRefSet:     true,
		ColorSet:       true,
		StatusSet:      true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if updated.DisplayName != name || updated.CustomDisplayName == nil || *updated.CustomDisplayName != name {
		t.Fatalf("updated resource name = %#v", updated)
	}
	if updated.Status != domain.ResourceStatusClaimed {
		t.Fatalf("updated status = %q", updated.Status)
	}
	unclaimed, err := repo.ListResources(context.Background(), "unclaimed")
	if err != nil {
		t.Fatal(err)
	}
	if len(unclaimed) != 0 {
		t.Fatalf("unclaimed resources = %d, want 0", len(unclaimed))
	}
	if _, err := repo.GetResource(context.Background(), "missing"); err == nil || err != sql.ErrNoRows && !containsNoRows(err) {
		t.Fatalf("missing resource error = %v", err)
	}
}

func TestResourceOverridePatchSemantics(t *testing.T) {
	repo, cipher := testRepository(t)
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Second)
	ciphertext, nonce, err := cipher.Encrypt([]byte("secret"))
	if err != nil {
		t.Fatal(err)
	}
	if err := repo.UpsertInstance(ctx, domain.CPAInstance{ID: "default", Name: "Default", BaseURL: "http://cpa:8317", UsageAddr: "cpa:8317", ManagementKeyCiphertext: ciphertext, ManagementKeyNonce: nonce, CreatedAt: now, UpdatedAt: now}); err != nil {
		t.Fatal(err)
	}
	resources, err := repo.UpsertDiscoveredResources(ctx, "default", []domain.DiscoveredResource{{ResourceKey: "patch-target", CPAResourceType: "codex-api-key", CPADriver: "codex", ProtocolDriver: "openai_responses", ProtocolDisplay: "OpenAI Responses", BaseURL: "https://example.test", SuggestedSource: "Example", Status: domain.ResourceStatusUnclaimed}}, now, true)
	if err != nil {
		t.Fatal(err)
	}
	id := resources[0].ID
	name, icon, color, notes := "Custom", "deepseek", "#123456", "keep me"
	claimed := domain.ResourceStatusClaimed
	if _, err := repo.UpdateResourceOverride(ctx, id, domain.ResourceOverride{DisplayName: &name, IconRef: &icon, Color: &color, Notes: &notes, Status: &claimed, DisplayNameSet: true, IconRefSet: true, ColorSet: true, NotesSet: true, StatusSet: true}); err != nil {
		t.Fatal(err)
	}

	// An omitted field is not a clear operation.
	if _, err := repo.UpdateResourceOverride(ctx, id, domain.ResourceOverride{Status: &claimed, StatusSet: true}); err != nil {
		t.Fatal(err)
	}
	preserved, err := repo.GetResource(ctx, id)
	if err != nil {
		t.Fatal(err)
	}
	if preserved.CustomDisplayName == nil || *preserved.CustomDisplayName != name || preserved.IconRef == nil || *preserved.IconRef != icon || preserved.Color == nil || *preserved.Color != color || preserved.Notes == nil || *preserved.Notes != notes {
		t.Fatalf("status-only update changed metadata: %#v", preserved)
	}

	// Explicit empty values clear nullable metadata.
	empty := ""
	if _, err := repo.UpdateResourceOverride(ctx, id, domain.ResourceOverride{DisplayName: &empty, IconRef: &empty, Color: &empty, Notes: &empty, DisplayNameSet: true, IconRefSet: true, ColorSet: true, NotesSet: true}); err != nil {
		t.Fatal(err)
	}
	cleared, err := repo.GetResource(ctx, id)
	if err != nil {
		t.Fatal(err)
	}
	if cleared.CustomDisplayName != nil || cleared.IconRef != nil || cleared.Color != nil || cleared.Notes != nil || cleared.Status != domain.ResourceStatusClaimed {
		t.Fatalf("explicit clear result = %#v", cleared)
	}

	invalid := domain.ResourceStatus("not-a-status")
	if _, err := repo.UpdateResourceOverride(ctx, id, domain.ResourceOverride{Status: &invalid, StatusSet: true}); err == nil {
		t.Fatal("expected invalid status error")
	}
	unchanged, err := repo.GetResource(ctx, id)
	if err != nil {
		t.Fatal(err)
	}
	if unchanged.Status != domain.ResourceStatusClaimed {
		t.Fatalf("invalid status mutated resource to %q", unchanged.Status)
	}
}

func containsNoRows(err error) bool {
	return err != nil && len(err.Error()) > 0 && (err.Error() == "sql: no rows in result set" ||
		(len(err.Error()) >= len("resource ") && (stringContains(err.Error(), "sql: no rows in result set"))))
}

func stringContains(value, fragment string) bool {
	for i := 0; i+len(fragment) <= len(value); i++ {
		if value[i:i+len(fragment)] == fragment {
			return true
		}
	}
	return false
}

func TestRepositorySanitizesSensitiveResourceDetails(t *testing.T) {
	repo, cipher := testRepository(t)
	ctx := context.Background()
	now := time.Now().UTC()
	ciphertext, nonce, err := cipher.Encrypt([]byte("secret"))
	if err != nil {
		t.Fatal(err)
	}
	if err := repo.UpsertInstance(ctx, domain.CPAInstance{ID: "default", Name: "Default", BaseURL: "http://cpa:8317", UsageAddr: "cpa:8317", ManagementKeyCiphertext: ciphertext, ManagementKeyNonce: nonce, CreatedAt: now, UpdatedAt: now}); err != nil {
		t.Fatal(err)
	}
	fixtureSecret := "fixture-resource-api-key"
	resources, err := repo.UpsertDiscoveredResources(ctx, "default", []domain.DiscoveredResource{{
		ResourceKey: "sensitive-details", CPAResourceType: "auth-file", CPADriver: "openai",
		ProtocolDriver: "openai_responses", ProtocolDisplay: "OpenAI Responses",
		Status: domain.ResourceStatusUnclaimed,
		Details: domain.ResourceDetails{Models: []string{"gpt-test"}, Email: "owner@example.test", SourceFile: "fixture-token.json", Prefix: fixtureSecret, Extra: map[string]string{
			"account": fixtureSecret, "api_key": fixtureSecret, "proxy_url": "https://user:pass@example.test?token=" + fixtureSecret,
			"api_key_present": "true", "provider": "openai",
		}},
	}}, now, true)
	if err != nil {
		t.Fatal(err)
	}
	var raw string
	if err := repo.SQL().QueryRowContext(ctx, `SELECT details_json FROM discovered_resources WHERE id = ?`, resources[0].ID).Scan(&raw); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(raw, fixtureSecret) || strings.Contains(raw, "account") || strings.Contains(raw, `"api_key":`) || strings.Contains(raw, `"proxy_url":`) {
		t.Fatalf("stored resource details contain sensitive fields: %s", raw)
	}
	loaded, err := repo.GetResource(ctx, resources[0].ID)
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(loaded)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(encoded), fixtureSecret) {
		t.Fatalf("loaded resource contains fixture secret: %s", encoded)
	}
}

func TestOutboundProxyStore(t *testing.T) {
	repo, cipher := testRepository(t)
	store := OutboundProxyStore{Repo: repo, Cipher: cipher}
	ctx := context.Background()
	settings, revision, err := store.Load(ctx)
	if err != nil || revision != 0 || settings.Mode != "environment" {
		t.Fatalf("default settings = %#v, %d, %v", settings, revision, err)
	}
	want := OutboundProxySettings{Mode: "proxy", URL: "http://fixture-user:fixture-password@proxy.test:8080", NoProxy: "localhost,.internal"}
	revision, err = store.Save(ctx, revision, want)
	if err != nil || revision != 1 {
		t.Fatalf("save revision = %d, %v", revision, err)
	}
	var ciphertext []byte
	if err := repo.SQL().QueryRowContext(ctx, `SELECT ciphertext FROM outbound_proxy_settings WHERE id=1`).Scan(&ciphertext); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(ciphertext), "fixture-password") {
		t.Fatal("proxy credential was stored in plaintext")
	}
	got, loadedRevision, err := store.Load(ctx)
	if err != nil || loadedRevision != revision || got != want {
		t.Fatalf("load = %#v, %d, %v", got, loadedRevision, err)
	}
	if _, err := store.Save(ctx, 0, want); err != ErrOutboundProxyConflict {
		t.Fatalf("stale save error = %v", err)
	}
	if _, err := store.Save(ctx, revision, OutboundProxySettings{Mode: "direct"}); err != nil {
		t.Fatal(err)
	}
}
