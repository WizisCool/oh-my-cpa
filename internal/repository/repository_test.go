package repository

import (
	"context"
	"database/sql"
	"testing"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/crypto"
	"github.com/oh-my-cpa/oh-my-cpa/internal/domain"
)

func testRepository(t *testing.T) (*Repository, *crypto.Cipher) {
	t.Helper()
	db, err := Open(context.Background(), "file::memory:?cache=shared")
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
