package discovery

import (
	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/management"
	"github.com/oh-my-cpa/oh-my-cpa/internal/crypto"
	"testing"
)

func TestMetadataIdenticalEntriesWithDifferentKeysPreserveIdentityAcrossRearrangement(t *testing.T) {
	cipher, err := crypto.New("01234567890123456789012345678901")
	if err != nil {
		t.Fatal(err)
	}
	discoverer := NewDiscoverer(cipher)

	entryA := management.ConfigAPIKey{BaseURL: "https://api.example.test", Prefix: "prod", APIKey: "key-alpha"}
	entryB := management.ConfigAPIKey{BaseURL: "https://api.example.test", Prefix: "prod", APIKey: "key-beta"}

	// Order 1: A at index 0, B at index 1
	resA1, err := discoverer.fromCodexAPIKey("default", 0, entryA)
	if err != nil {
		t.Fatal(err)
	}
	resB1, err := discoverer.fromCodexAPIKey("default", 1, entryB)
	if err != nil {
		t.Fatal(err)
	}

	// Order 2: Reordered! B at index 0, A at index 1
	resB2, err := discoverer.fromCodexAPIKey("default", 0, entryB)
	if err != nil {
		t.Fatal(err)
	}
	resA2, err := discoverer.fromCodexAPIKey("default", 1, entryA)
	if err != nil {
		t.Fatal(err)
	}

	if resA1.ResourceKey != resA2.ResourceKey {
		t.Fatalf("identity of entryA changed across rearrangement: %q vs %q", resA1.ResourceKey, resA2.ResourceKey)
	}
	if resB1.ResourceKey != resB2.ResourceKey {
		t.Fatalf("identity of entryB changed across rearrangement: %q vs %q", resB1.ResourceKey, resB2.ResourceKey)
	}
	if resA1.ResourceKey == resB1.ResourceKey {
		t.Fatalf("different keys must not collide: %q", resA1.ResourceKey)
	}
}

func TestKeyRotationPreservesIdentityWhenAuthIndexPresent(t *testing.T) {
	cipher, err := crypto.New("01234567890123456789012345678901")
	if err != nil {
		t.Fatal(err)
	}
	discoverer := NewDiscoverer(cipher)

	// When stable auth_index exists: key rotation keeps exact same identity
	resOld, _ := discoverer.fromCodexAPIKey("default", 0, management.ConfigAPIKey{AuthIndex: "idx-stable", APIKey: "old-secret"})
	resNew, _ := discoverer.fromCodexAPIKey("default", 0, management.ConfigAPIKey{AuthIndex: "idx-stable", APIKey: "rotated-new-secret"})

	if resOld.ResourceKey != resNew.ResourceKey {
		t.Fatalf("expected stable identity with auth_index across rotation: %q vs %q", resOld.ResourceKey, resNew.ResourceKey)
	}

	// Without auth_index: changing key changes keyed HMAC cleanly
	resNoIdx1, _ := discoverer.fromCodexAPIKey("default", 0, management.ConfigAPIKey{APIKey: "secret-1"})
	resNoIdx2, _ := discoverer.fromCodexAPIKey("default", 0, management.ConfigAPIKey{APIKey: "secret-2"})
	if resNoIdx1.ResourceKey == resNoIdx2.ResourceKey {
		t.Fatalf("without auth_index, rotated secret must produce distinct pseudonymous HMAC: %q", resNoIdx1.ResourceKey)
	}
}
