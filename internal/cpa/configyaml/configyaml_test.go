package configyaml

import (
	"fmt"
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

	// 1. Management/TLS secrets are never in the safe YAML…
	for _, secret := range []string{"top-secret-mgmt-key-1234", "user:pass@", "?token=secret", "/etc/ssl/private.key"} {
		if strings.Contains(safe, secret) {
			t.Fatalf("safe YAML leaked secret %q: %s", secret, safe)
		}
	}

	// 2. …while client API keys must be returned in plaintext.
	for _, key := range []string{"sk-client-key-1", "sk-client-key-2"} {
		if !strings.Contains(safe, key) {
			t.Fatalf("safe YAML must keep API key %q in plaintext: %s", key, safe)
		}
	}

	// 3. Assert sentinels and cleaned proxy URL are present
	if !strings.Contains(safe, UnchangedSentinel) {
		t.Fatalf("safe YAML missing sentinel %q: %s", UnchangedSentinel, safe)
	}
	if !strings.Contains(safe, "http://proxy.example.test:8080") {
		t.Fatalf("safe YAML proxy-url corrupted: %s", safe)
	}

	// 4. Test RestoreSentinels when user did NOT touch secret-key (keeps sentinel)
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
	if !strings.Contains(restored, "user:pass@proxy.example.test") || !strings.Contains(restored, "?token=secret") {
		t.Fatalf("restored YAML failed to preserve proxy credentials: %s", restored)
	}
	if !strings.Contains(restored, "sk-client-key-1") {
		t.Fatalf("restored YAML failed to restore original api-keys: %s", restored)
	}

	// 5. Test RestoreSentinels when user explicitly CHANGED the secret-key
	userEditChangedSecret := strings.Replace(safe, UnchangedSentinel, "brand-new-secret-key", 1)
	restoredChanged, err := RestoreSentinels(userEditChangedSecret, original)
	if err != nil {
		t.Fatalf("RestoreSentinels failed: %v", err)
	}
	if !strings.Contains(restoredChanged, "brand-new-secret-key") {
		t.Fatalf("restored YAML did not keep user's newly provided secret: %s", restoredChanged)
	}
}

func TestSanitizeSafeYAMLRedactsSchemelessAndNestedProxyCredentials(t *testing.T) {
	original := `proxy-url: user:pass@proxy.example.test:8080?token=secret
servers:
  - proxy-url:
      - proxy-one:pass-one@proxy-one.example.test:8080
      - proxy-two:pass-two@proxy-two.example.test:8080
`
	safe, err := SanitizeSafeYAML(original)
	if err != nil {
		t.Fatalf("SanitizeSafeYAML failed: %v", err)
	}
	for _, secret := range []string{"user:pass@", "token=secret", "proxy-one:pass-one@", "proxy-two:pass-two@"} {
		if strings.Contains(safe, secret) {
			t.Fatalf("safe YAML leaked proxy credential %q: %s", secret, safe)
		}
	}

	restored, err := RestoreSentinels(safe, original)
	if err != nil {
		t.Fatalf("RestoreSentinels failed: %v", err)
	}
	if !strings.Contains(restored, "user:pass@proxy.example.test") || !strings.Contains(restored, "token=secret") ||
		!strings.Contains(restored, "proxy-one:pass-one@proxy-one.example.test") || !strings.Contains(restored, "proxy-two:pass-two@proxy-two.example.test") {
		t.Fatalf("proxy credentials were not restored: %s", restored)
	}
}

func TestRestoreSentinelsRecursesIntoSequencesAndLeavesLiteralSentinels(t *testing.T) {
	original := `servers:
  - name: primary
    tls:
      key: nested-private-key
plain: "__OMCPA_UNCHANGED__"
`

	safe, err := SanitizeSafeYAML(original)
	if err != nil {
		t.Fatalf("SanitizeSafeYAML failed: %v", err)
	}
	if strings.Contains(safe, "nested-private-key") {
		t.Fatalf("safe YAML leaked a nested TLS key: %s", safe)
	}

	restored, err := RestoreSentinels(safe, original)
	if err != nil {
		t.Fatalf("RestoreSentinels failed: %v", err)
	}
	if !strings.Contains(restored, "nested-private-key") {
		t.Fatalf("restored YAML lost the nested TLS key: %s", restored)
	}
	if !strings.Contains(restored, `plain: "__OMCPA_UNCHANGED__"`) {
		t.Fatalf("restore changed a literal sentinel in a non-sensitive field: %s", restored)
	}
}

// A proxy key spelled with an underscore or in a different case is redacted on
// the way out by the same predicate that decides restoration, so the restore
// path must recognize the variants too.
func TestRestoreSentinelsRecognizesProxyURLKeyVariants(t *testing.T) {
	for _, key := range []string{"proxy_url", "Proxy-URL", "PROXY_URL"} {
		t.Run(key, func(t *testing.T) {
			original := key + `: "http://user:pass@proxy.example.test:8080?token=secret"` + "\nport: 8317\n"

			safe, err := SanitizeSafeYAML(original)
			if err != nil {
				t.Fatalf("SanitizeSafeYAML failed: %v", err)
			}
			for _, secret := range []string{"user:pass@", "token=secret"} {
				if strings.Contains(safe, secret) {
					t.Fatalf("safe YAML leaked %q: %s", secret, safe)
				}
			}

			edited := strings.Replace(safe, "port: 8317", "port: 9000", 1)
			restored, err := RestoreSentinels(edited, original)
			if err != nil {
				t.Fatalf("RestoreSentinels failed: %v", err)
			}
			if !strings.Contains(restored, "user:pass@proxy.example.test") || !strings.Contains(restored, "token=secret") {
				t.Fatalf("proxy credentials were discarded for key %q: %s", key, restored)
			}
			if !strings.Contains(restored, "port: 9000") {
				t.Fatalf("restore lost the operator edit: %s", restored)
			}
		})
	}
}

// Filling in new credentials for an endpoint the safe view had cleaned is an
// explicit edit and must survive, not be replaced by the stored value.
func TestRestoreSentinelsKeepsExplicitProxyCredentialChange(t *testing.T) {
	original := `proxy-url: "http://old-user:old-pass@proxy.example.test:8080?token=old"` + "\n"

	safe, err := SanitizeSafeYAML(original)
	if err != nil {
		t.Fatalf("SanitizeSafeYAML failed: %v", err)
	}
	if !strings.Contains(safe, "http://proxy.example.test:8080") {
		t.Fatalf("safe YAML lost the cleaned proxy URL: %s", safe)
	}

	edited := strings.Replace(safe, "http://proxy.example.test:8080", "http://new-user:new-pass@proxy.example.test:8080?token=new", 1)
	restored, err := RestoreSentinels(edited, original)
	if err != nil {
		t.Fatalf("RestoreSentinels failed: %v", err)
	}
	for _, want := range []string{"new-user:new-pass@proxy.example.test", "token=new"} {
		if !strings.Contains(restored, want) {
			t.Fatalf("explicit proxy credential change was discarded (missing %q): %s", want, restored)
		}
	}
	for _, unwanted := range []string{"old-user:old-pass@", "token=old"} {
		if strings.Contains(restored, unwanted) {
			t.Fatalf("restore reinstated the stored credential %q: %s", unwanted, restored)
		}
	}
}

// Sequence entries are paired with the stored document by position, so a
// structural edit made while an entry still carries a hidden value could attach
// one entry's secret to a different entry. Those edits must be refused instead.
func TestRestoreSentinelsRefusesUnprovableSequenceAlignment(t *testing.T) {
	original := `servers:
  - name: alpha
    tls:
      key: key-for-alpha
  - name: beta
    tls:
      key: key-for-beta
`

	cases := map[string]string{
		"same-length reorder": fmt.Sprintf(`servers:
  - name: beta
    tls:
      key: %[1]s
  - name: alpha
    tls:
      key: %[1]s
`, UnchangedSentinel),
		"insert at the front": fmt.Sprintf(`servers:
  - name: gamma
    tls:
      key: key-for-gamma
  - name: alpha
    tls:
      key: %[1]s
  - name: beta
    tls:
      key: %[1]s
`, UnchangedSentinel),
		"remove one entry": fmt.Sprintf(`servers:
  - name: beta
    tls:
      key: %[1]s
`, UnchangedSentinel),
	}
	for name, submitted := range cases {
		t.Run(name, func(t *testing.T) {
			restored, err := RestoreSentinels(submitted, original)
			if err == nil {
				t.Fatalf("hidden values were restored by position: %s", restored)
			}
			for _, secret := range []string{"key-for-alpha", "key-for-beta"} {
				if strings.Contains(restored, secret) {
					t.Fatalf("refused restore still returned a stored secret %q: %s", secret, restored)
				}
			}
		})
	}
}

// A reordered proxy URL list has the same failure mode: the cleaned URLs are
// indistinguishable from each other, so each one's credentials come from its
// stored position.
func TestRestoreSentinelsRefusesReorderedProxyURLSequence(t *testing.T) {
	original := `servers:
  - proxy-url:
      - one-user:one-pass@one.example.test:8080
      - two-user:two-pass@two.example.test:8080
`
	swapped := `servers:
  - proxy-url:
      - two.example.test:8080
      - one.example.test:8080
`
	restored, err := RestoreSentinels(swapped, original)
	if err == nil {
		t.Fatalf("reordered proxy URLs took credentials from the stored position: %s", restored)
	}
	for _, secret := range []string{"one-pass", "two-pass"} {
		if strings.Contains(restored, secret) {
			t.Fatalf("refused restore still returned a stored credential %q: %s", secret, restored)
		}
	}
}

// Sequences that hold no hidden value are ordinary configuration and must stay
// editable, including insertions and reordering.
func TestRestoreSentinelsAllowsSequenceEditsWithoutHiddenValues(t *testing.T) {
	original := "models:\n  - id: a\n  - id: b\n"
	edited := "models:\n  - id: b\n  - id: a\n  - id: c\n"

	restored, err := RestoreSentinels(edited, original)
	if err != nil {
		t.Fatalf("sequence edit without hidden values was rejected: %v", err)
	}
	if restored != edited {
		t.Fatalf("document with nothing to restore was rewritten: %q", restored)
	}
}

// Reordering an entry stays possible once the operator re-enters the hidden
// value explicitly, because nothing is then taken from the stored document.
func TestRestoreSentinelsAllowsReorderAfterExplicitSecretEntry(t *testing.T) {
	original := `servers:
  - name: alpha
    tls:
      key: key-for-alpha
  - name: beta
    tls:
      key: key-for-beta
`
	submitted := `servers:
  - name: beta
    tls:
      key: reentered-key-for-beta
  - name: alpha
    tls:
      key: reentered-key-for-alpha
`
	restored, err := RestoreSentinels(submitted, original)
	if err != nil {
		t.Fatalf("reorder with explicit secrets was rejected: %v", err)
	}
	for _, want := range []string{"reentered-key-for-beta", "reentered-key-for-alpha"} {
		if !strings.Contains(restored, want) {
			t.Fatalf("restored YAML lost %q: %s", want, restored)
		}
	}
}
