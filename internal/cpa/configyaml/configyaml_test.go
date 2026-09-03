package configyaml

import (
	"strings"
	"testing"
)

func TestValidateSyntax(t *testing.T) {
	valid := `
host: 127.0.0.1
port: 8317
debug: true
`
	if err := ValidateSyntax([]byte(valid)); err != nil {
		t.Fatalf("expected valid syntax, got error: %v", err)
	}

	invalid := `
host: 127.0.0.1
port: [unclosed
`
	err := ValidateSyntax([]byte(invalid))
	if err == nil {
		t.Fatal("expected syntax error on unclosed array, got nil")
	}
	if err.Line <= 0 {
		t.Fatalf("expected positive line number, got %d", err.Line)
	}
}

func TestComputeRevision(t *testing.T) {
	yaml1 := "host: 127.0.0.1\nport: 8317\n"
	yaml2 := "host: 127.0.0.1\nport: 8318\n"

	rev1 := ComputeRevision(yaml1)
	rev1Again := ComputeRevision(yaml1)
	rev2 := ComputeRevision(yaml2)

	if rev1 != rev1Again {
		t.Fatalf("revision not deterministic: %q vs %q", rev1, rev1Again)
	}
	if rev1 == rev2 {
		t.Fatalf("revisions should differ: %q vs %q", rev1, rev2)
	}
	if len(rev1) != 64 {
		t.Fatalf("expected 64-char sha256 hex, got len %d (%q)", len(rev1), rev1)
	}
}

func TestSanitizeSafeYAMLAndRestoreSentinels(t *testing.T) {
	original := `# Global service configuration
host: 127.0.0.1
port: 8317
proxy-url: "http://user:pass@proxy.example.test:8080?token=secret"

# Remote management credentials
remote-management:
  allow-remote: true
  secret-key: "top-secret-mgmt-key-1234"

# Client API keys
api-keys:
  - "sk-client-key-1"
  - "sk-client-key-2"

tls:
  enable: true
  cert: "/etc/ssl/cert.pem"
  key: "/etc/ssl/private.key"
`

	safe, err := SanitizeSafeYAML(original)
	if err != nil {
		t.Fatalf("SanitizeSafeYAML failed: %v", err)
	}

	// 1. Assert secrets are never in the safe YAML
	for _, secret := range []string{"top-secret-mgmt-key-1234", "user:pass@", "?token=secret", "sk-client-key-1", "sk-client-key-2", "/etc/ssl/private.key"} {
		if strings.Contains(safe, secret) {
			t.Fatalf("safe YAML leaked secret %q: %s", secret, safe)
		}
	}

	// 2. Assert sentinels and cleaned proxy URL are present
	if !strings.Contains(safe, UnchangedSentinel) {
		t.Fatalf("safe YAML missing sentinel %q: %s", UnchangedSentinel, safe)
	}
	if !strings.Contains(safe, "http://proxy.example.test:8080") {
		t.Fatalf("safe YAML proxy-url corrupted: %s", safe)
	}

	// 3. Test RestoreSentinels when user did NOT touch secret-key (keeps sentinel)
	userEditNoSecretChange := strings.Replace(safe, "port: 8317", "port: 9000", 1)
	restored, err := RestoreSentinels(userEditNoSecretChange, original)
	if err != nil {
		t.Fatalf("RestoreSentinels failed: %v", err)
	}
	if strings.Contains(restored, UnchangedSentinel) {
		t.Fatalf("restored YAML still contains sentinel: %s", restored)
	}
	if !strings.Contains(restored, "port: 9000") {
		t.Fatalf("restored YAML lost user edit: %s", restored)
	}
	if !strings.Contains(restored, "top-secret-mgmt-key-1234") {
		t.Fatalf("restored YAML failed to restore original secret key: %s", restored)
	}
	if !strings.Contains(restored, "sk-client-key-1") {
		t.Fatalf("restored YAML failed to restore original api-keys: %s", restored)
	}

	// 4. Test RestoreSentinels when user explicitly CHANGED the secret-key
	userEditChangedSecret := strings.Replace(safe, UnchangedSentinel, "brand-new-secret-key", 1)
	restoredChanged, err := RestoreSentinels(userEditChangedSecret, original)
	if err != nil {
		t.Fatalf("RestoreSentinels failed: %v", err)
	}
	if !strings.Contains(restoredChanged, "brand-new-secret-key") {
		t.Fatalf("restored YAML did not keep user's newly provided secret: %s", restoredChanged)
	}
}
