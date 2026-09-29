package configyaml

import (
	"errors"
	"fmt"
	"reflect"
	"strings"
	"testing"
)

func TestIsV8DocumentReadsTheMigrationMarker(t *testing.T) {
	for source, want := range map[string]bool{
		"":                                false,
		"port: 8317\n":                    false,
		"config-version: 8\nserver: {}\n": true,
		"server:\n  port: 1\nconfig-version: 9\n": true,
		"config-version: 7\n":                     false,
		"config-version: eight\n":                 false,
	} {
		got, err := IsV8Document(source)
		if err != nil || got != want {
			t.Errorf("IsV8Document(%q) = %v, %v; want %v", source, got, err, want)
		}
	}
	if _, err := IsV8Document("[a, b]\n"); err == nil {
		t.Error("a document that is not a mapping must be reported")
	}
}

func TestRestoreSentinelsAtPutsBackMaskedValues(t *testing.T) {
	stored := `management:
  secret-key: stored-secret
requests:
  proxy-url: http://user:pass@proxy.example:3128
  payload:
    default:
      - models: [{name: "a"}]
        params:
          key: payload-secret
      - models: [{name: "b"}]
`
	// A masked scalar comes back from the stored document.
	value, err := RestoreSentinelsAt(UnchangedSentinel, []string{"management", "secret-key"}, stored)
	if err != nil || value != "stored-secret" {
		t.Fatalf("secret = %v, %v", value, err)
	}
	// So does the proxy URL the safe view showed without its credentials.
	value, err = RestoreSentinelsAt("http://proxy.example:3128", []string{"requests", "proxy-url"}, stored)
	if err != nil || value != "http://user:pass@proxy.example:3128" {
		t.Fatalf("proxy = %v, %v", value, err)
	}
	// A proxy URL the operator changed is theirs.
	value, err = RestoreSentinelsAt("http://other.example:1", []string{"requests", "proxy-url"}, stored)
	if err != nil || value != "http://other.example:1" {
		t.Fatalf("edited proxy = %v, %v", value, err)
	}
	// A list keeps its entries' hidden values while the entries are the ones shown.
	submitted := []any{
		map[string]any{"models": []any{map[string]any{"name": "a"}}, "params": map[string]any{"key": UnchangedSentinel}},
		map[string]any{"models": []any{map[string]any{"name": "b"}}},
	}
	value, err = RestoreSentinelsAt(submitted, []string{"requests", "payload", "default"}, stored)
	if err != nil {
		t.Fatal(err)
	}
	first := value.([]any)[0].(map[string]any)["params"].(map[string]any)["key"]
	if first != "payload-secret" {
		t.Fatalf("restored list = %#v", value)
	}
	// Reordered entries would attach one entry's secret to another.
	_, err = RestoreSentinelsAt([]any{submitted[1], submitted[0]}, []string{"requests", "payload", "default"}, stored)
	if !errors.Is(err, ErrUnprovableEntryRestore) {
		t.Fatalf("reordered list: err = %v", err)
	}
	// A value without anything to restore is passed through untouched.
	plain := map[string]any{"retry": map[string]any{"request-retry": 3}}
	value, err = RestoreSentinelsAt(plain, []string{"routing"}, stored)
	if err != nil || !reflect.DeepEqual(value, plain) {
		t.Fatalf("plain = %#v, %v", value, err)
	}
	// A masked secret with nothing stored behind it cannot be sent.
	if _, err := RestoreSentinelsAt(UnchangedSentinel, []string{"server", "tls", "key"}, stored); err == nil {
		t.Fatal("a sentinel with no stored value must be refused")
	}
	// So is one below the path under a key the stored copy lacks, which the
	// restore walk passes over.
	storedGroups := `api-keys:
  codex:
    - name: codex-1
      keys:
        - api-key: stored-key
`
	newKey := map[string]any{"codex": []any{map[string]any{"name": "codex-1", "keys": []any{map[string]any{"api-key": "stored-key"}}}}, "claude": []any{map[string]any{"api-key": UnchangedSentinel}}}
	if _, err := RestoreSentinelsAt(newKey, []string{"api-keys"}, storedGroups); err == nil {
		t.Fatal("a sentinel under a key the stored copy lacks must be refused")
	}
}

func TestSanitizeSafeYAMLMasksUpstreamCredentialsInTheV8Layout(t *testing.T) {
	stored := `access:
    api-keys:
        - omc-caller-key
api-keys:
    claude:
        - base-url: https://relay.example.test
          keys:
            - api-key: sk-upstream-secret
management:
    secret-key: management-secret
`
	safe, err := SanitizeSafeYAML(stored)
	if err != nil {
		t.Fatal(err)
	}
	for _, secret := range []string{"sk-upstream-secret", "management-secret"} {
		if strings.Contains(safe, secret) {
			t.Fatalf("safe YAML leaked %q: %s", secret, safe)
		}
	}
	if !strings.Contains(safe, "omc-caller-key") || !strings.Contains(safe, "https://relay.example.test") {
		t.Fatalf("safe YAML masked more than the secrets: %s", safe)
	}
	// A save that leaves the credential masked puts the stored one back.
	restored, err := RestoreSentinelsAt([]any{map[string]any{"base-url": "https://relay.example.test", "keys": []any{map[string]any{"api-key": UnchangedSentinel}}}}, []string{"api-keys", "claude"}, stored)
	if err != nil {
		t.Fatal(err)
	}
	if encoded := fmt.Sprint(restored); !strings.Contains(encoded, "sk-upstream-secret") {
		t.Fatalf("restored = %s", encoded)
	}
}

func TestScrubStoredSecretsRemovesHiddenValues(t *testing.T) {
	stored := `management:
  secret-key: stored-secret
requests:
  proxy-url: http://user:proxy-pass@proxy.example:3128
api-keys:
  codex:
    - keys:
        - api-key: sk-upstream
access:
  api-keys: [client-key]
`
	text := `stored-secret, http://user:proxy-pass@proxy.example:3128, proxy-pass, sk-upstream, client-key`
	got := ScrubStoredSecrets(text, stored)
	want := `[hidden], http://proxy.example:3128, [hidden], [hidden], client-key`
	if got != want {
		t.Fatalf("scrubbed = %q, want %q", got, want)
	}
}
