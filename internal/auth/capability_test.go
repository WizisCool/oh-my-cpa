package auth

import "testing"

func TestCapabilityIdentityUsesTheExistingAuthority(t *testing.T) {
	current, _ := New("management-key-one", "/omc", "")
	same, _ := New("management-key-one", "/different", "")
	rotated, _ := New("management-key-two", "/omc", "")
	if current.CapabilityIdentity() == "" || current.CapabilityIdentity() != same.CapabilityIdentity() {
		t.Fatal("authority depends on session or path")
	}
	if current.CapabilityIdentity() == rotated.CapabilityIdentity() {
		t.Fatal("rotation did not invalidate authority")
	}
	if current.KeyMatches(current.CapabilityIdentity()) {
		t.Fatal("identity can authenticate")
	}
}
