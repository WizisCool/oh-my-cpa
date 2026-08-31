package discovery

import (
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
	first, err := discoverer.fromCodexAPIKey("default", 0, management.CodexAPIKey{AuthIndex: "auth-1", BaseURL: "https://one.example"})
	if err != nil {
		t.Fatal(err)
	}
	second, err := discoverer.fromCodexAPIKey("default", 12, management.CodexAPIKey{AuthIndex: "auth-1", BaseURL: "https://changed.example"})
	if err != nil {
		t.Fatal(err)
	}
	if first.ResourceKey != second.ResourceKey {
		t.Fatalf("auth-index key changed: %q vs %q", first.ResourceKey, second.ResourceKey)
	}
}

func TestSourceSuggestionsSeparateTechnicalDriver(t *testing.T) {
	cipher, err := crypto.New("01234567890123456789012345678901")
	if err != nil {
		t.Fatal(err)
	}
	discoverer := NewDiscoverer(cipher)
	resource, err := discoverer.fromCodexAPIKey("default", 0, management.CodexAPIKey{BaseURL: "https://api.deepseek.com"})
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
