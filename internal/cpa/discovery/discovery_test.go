package discovery

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/management"
	"github.com/oh-my-cpa/oh-my-cpa/internal/crypto"
)

func TestResourceKeyPrefersCPAAuthIndex(t *testing.T) {
	cipher, err := crypto.New("01234567890123456789012345678901")
	if err != nil {
		t.Fatal(err)
	}
	discoverer := NewDiscoverer(cipher)
	first, err := discoverer.fromCodexAPIKey("default", 0, management.ConfigAPIKey{AuthIndex: "auth-1", BaseURL: "https://one.example"})
	if err != nil {
		t.Fatal(err)
	}
	second, err := discoverer.fromCodexAPIKey("default", 12, management.ConfigAPIKey{AuthIndex: "auth-1", BaseURL: "https://changed.example"})
	if err != nil {
		t.Fatal(err)
	}
	if first.ResourceKey != second.ResourceKey {
		t.Fatalf("auth-index key changed: %q vs %q", first.ResourceKey, second.ResourceKey)
	}
}

func TestDiscoveryRedactsCredentialBearingURLs(t *testing.T) {
	cipher, err := crypto.New("01234567890123456789012345678901")
	if err != nil {
		t.Fatal(err)
	}
	discoverer := NewDiscoverer(cipher)
	resource, err := discoverer.fromCodexAPIKey("default", 0, management.ConfigAPIKey{
		BaseURL:  "https://user:password@api.example.test/v1/",
		ProxyURL: "socks5://proxy-user:proxy-password@proxy.example.test:1080",
	})
	if err != nil {
		t.Fatal(err)
	}
	if resource.BaseURL != "https://api.example.test/v1" {
		t.Fatalf("public base URL = %q", resource.BaseURL)
	}
	if resource.Details.Extra["proxy_configured"] != "true" || resource.Details.Extra["proxy_url"] != "" {
		t.Fatalf("proxy metadata = %#v", resource.Details.Extra)
	}
	encoded, err := json.Marshal(resource)
	if err != nil {
		t.Fatal(err)
	}
	serialized := string(encoded)
	for _, secret := range []string{"user", "password", "proxy-user", "proxy-password"} {
		if strings.Contains(serialized, secret) {
			t.Fatalf("serialized resource contains credential %q: %s", secret, serialized)
		}
	}

	providerResources, err := discoverer.fromOpenAICompatibility("default", 0, management.OpenAICompatibility{
		BaseURL:       "https://provider-user:provider-password@provider.example.test/api",
		APIKeyEntries: []management.APIKeyEntry{{ProxyURL: "http://user:pass@proxy.example.test"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	encoded, err = json.Marshal(providerResources)
	if err != nil {
		t.Fatal(err)
	}
	serialized = string(encoded)
	for _, secret := range []string{"provider-user", "provider-password", "http://user:pass"} {
		if strings.Contains(serialized, secret) {
			t.Fatalf("provider resource contains credential %q: %s", secret, serialized)
		}
	}
}

func TestSourceSuggestionsSeparateTechnicalDriver(t *testing.T) {
	cipher, err := crypto.New("01234567890123456789012345678901")
	if err != nil {
		t.Fatal(err)
	}
	discoverer := NewDiscoverer(cipher)
	resource, err := discoverer.fromCodexAPIKey("default", 0, management.ConfigAPIKey{BaseURL: "https://api.deepseek.com"})
	if err != nil {
		t.Fatal(err)
	}
	if resource.CPADriver != "codex" || resource.ProtocolDriver != "openai_responses" {
		t.Fatalf("technical identity = %#v", resource)
	}
	if resource.SuggestedSource != "DeepSeek" {
		t.Fatalf("source suggestion = %q", resource.SuggestedSource)
	}
}

func TestAuthFileDiscoveryDoesNotPersistAccountOrCredentialMetadata(t *testing.T) {
	cipher, err := crypto.New("01234567890123456789012345678901")
	if err != nil {
		t.Fatal(err)
	}
	discoverer := NewDiscoverer(cipher)
	file := management.AuthFile{
		ID: "auth-id", AuthIndex: "", Name: "fixture.json", Provider: "openai",
		Email: "owner@example.test", AccountType: "api_key", Account: "fixture-auth-secret",
		Label: "safe-label", Status: "ready", StatusMessage: "ok", Source: "fixture-source",
	}
	resource, err := discoverer.fromAuthFile("default", file)
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(resource)
	if err != nil {
		t.Fatal(err)
	}
	text := string(encoded)
	if strings.Contains(text, file.Account) {
		t.Fatalf("resource contains auth account: %s", text)
	}
	if _, ok := resource.Details.Extra["account"]; ok {
		t.Fatalf("resource details still contain account: %#v", resource.Details.Extra)
	}
	if resource.Details.Extra["account_type"] != "api_key" || resource.Details.Extra["account_present"] != "true" {
		t.Fatalf("safe account metadata missing: %#v", resource.Details.Extra)
	}
}

func TestFallbackIdentityIgnoresArrayPosition(t *testing.T) {
	cipher, err := crypto.New("01234567890123456789012345678901")
	if err != nil {
		t.Fatal(err)
	}
	discoverer := NewDiscoverer(cipher)
	first, err := discoverer.fromCodexAPIKey("default", 0, management.ConfigAPIKey{BaseURL: "https://api.example.test/v1", Prefix: "team"})
	if err != nil {
		t.Fatal(err)
	}
	second, err := discoverer.fromCodexAPIKey("default", 12, management.ConfigAPIKey{BaseURL: "https://api.example.test/v1", Prefix: "team"})
	if err != nil {
		t.Fatal(err)
	}
	if first.ResourceKey != second.ResourceKey {
		t.Fatalf("fallback key changed with array position: %q vs %q", first.ResourceKey, second.ResourceKey)
	}
	if first.Details.Extra["identity_collision"] != "true" {
		t.Fatalf("ambiguous fallback not marked: %#v", first.Details.Extra)
	}
}

func TestPublicURLDropsQueryAndFragment(t *testing.T) {
	cipher, err := crypto.New("01234567890123456789012345678901")
	if err != nil {
		t.Fatal(err)
	}
	resource, err := NewDiscoverer(cipher).fromCodexAPIKey("default", 0, management.ConfigAPIKey{BaseURL: "https://api.example.test/v1?token=fixture#fragment"})
	if err != nil {
		t.Fatal(err)
	}
	if resource.BaseURL != "https://api.example.test/v1" {
		t.Fatalf("safe base URL = %q", resource.BaseURL)
	}
}
