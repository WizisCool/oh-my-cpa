package security

import (
	"strings"
	"testing"

	"github.com/oh-my-cpa/oh-my-cpa/internal/crypto"
)

func TestPublicURLRemovesCredentialsQueryAndFragment(t *testing.T) {
	got := PublicURL("HTTPS://user:pass@example.test/v1/?api_key=fixture#secret")
	if got != "https://example.test/v1" {
		t.Fatalf("public URL = %q", got)
	}
	for _, value := range []string{"ftp://example.test/path", "not a url"} {
		if got := PublicURL(value); got != "" {
			t.Fatalf("PublicURL(%q) = %q, want empty", value, got)
		}
	}
}

func TestFingerprintFailsClosedWithoutFingerprinter(t *testing.T) {
	if got := FingerprintOrRedacted(nil, "test", "fixture-secret"); got != RedactedValue {
		t.Fatalf("fallback fingerprint = %q", got)
	}
	cipher, err := crypto.New("01234567890123456789012345678901")
	if err != nil {
		t.Fatal(err)
	}
	got := FingerprintOrRedacted(cipher, "test", "fixture-secret")
	if got == "fixture-secret" || !strings.HasPrefix(got, "hmac:") {
		t.Fatalf("fingerprint = %q", got)
	}
	if got != FingerprintOrRedacted(cipher, "test", "fixture-secret") {
		t.Fatal("fingerprint is not stable")
	}
}

func TestRedactJSONAndText(t *testing.T) {
	raw := `{"api_key":"fixture-api-key","headers":{"Authorization":"Bearer fixture-token"},"proxy_url":"https://u:p@example.test?token=fixture-token","message":"Authorization: Bearer fixture-token"}`
	redacted, err := RedactJSON([]byte(raw))
	if err != nil {
		t.Fatal(err)
	}
	text := string(redacted)
	for _, secret := range []string{"fixture-api-key", "fixture-token", "u:p", "?token="} {
		if strings.Contains(text, secret) {
			t.Fatalf("redacted JSON contains %q: %s", secret, text)
		}
	}
	if !strings.Contains(text, RedactedValue) {
		t.Fatalf("redacted JSON has no marker: %s", text)
	}
	if text := RedactText(`Authorization: Bearer fixture-token https://u:p@example.test/path?token=fixture-token`); strings.Contains(text, "fixture-token") || strings.Contains(text, "u:p") {
		t.Fatalf("redacted text = %s", text)
	}
}

func TestPrivacyProjections(t *testing.T) {
	if got := MaskIP("10.20.30.40"); got == nil || *got != "10.20.30.0/24" {
		t.Fatalf("masked IPv4 = %v", got)
	}
	if got := MaskForwardedFor("bad, 2001:db8::1234"); got == nil || !strings.HasSuffix(*got, "/64") {
		t.Fatalf("masked forwarded-for = %v", got)
	}
	if got := MinimizeUserAgent("codex-cli/0.46 fixture-secret"); got == nil || *got != "codex-cli/0.46" {
		t.Fatalf("minimized user agent = %v", got)
	}
}

func TestMaskSecretKeepsOnlyRecognisableEdges(t *testing.T) {
	cases := []struct {
		name  string
		value string
		want  string
	}{
		{"empty", "", ""},
		{"long key keeps 8+4", "sk-1234567890abcdefghij7890", "sk-12345••••••••7890"},
		{"medium key keeps 4+2", "sk-1234567890ab", "sk-1••••••••ab"},
		// A short key exposes nothing: four of eight characters would give away
		// half the secret while still failing to identify it.
		{"short key is fully hidden", "admin", "••••••••"},
		{"short key is fully hidden", "sk-local", "••••••••"},
		{"boundary 19 runes keeps 4+2", "sk-1234567890123456", "sk-1••••••••56"},
		{"boundary 20 runes keeps 8+4", "sk-12345678901234567", "sk-12345••••••••4567"},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			if got := MaskSecret(test.value); got != test.want {
				t.Fatalf("MaskSecret(%q) = %q, want %q", test.value, got, test.want)
			}
		})
	}
	// The mask must never carry the whole secret, whatever its length.
	for _, value := range []string{"admin", "sk-local", "sk-1234567890ab", "sk-1234567890abcdefghij7890"} {
		if masked := MaskSecret(value); masked == value {
			t.Fatalf("MaskSecret(%q) leaked the value unchanged", value)
		}
	}
	// A short secret must not survive in any form, not even a single rune.
	for _, value := range []string{"admin", "root", "k", "a-1"} {
		if masked := MaskSecret(value); masked != maskRun {
			t.Fatalf("MaskSecret(%q) = %q, want a full mask", value, masked)
		}
	}
	// Every mask is recognised as one, and the filler is not a letter run.
	for _, value := range []string{"admin", "sk-1234567890ab", "sk-1234567890abcdefghij7890"} {
		if masked := MaskSecret(value); !IsMask(masked) {
			t.Fatalf("IsMask(%q) = false for a mask", masked)
		}
	}
	// IsMask is a shape check, so it accepts the legacy filler too: rows written
	// before the switch must stay reinsertable. It does not prove a value is not
	// a secret, because a credential may contain the filler itself.
	for _, value := range []string{"••••••••", "sk-12345••••••••7890", "xxxxxxx", "sk-12345xxxxxxx7890"} {
		if !IsMask(value) {
			t.Fatalf("IsMask(%q) = false for a supported mask shape", value)
		}
	}
	for _, raw := range []string{"", "   ", "sk-1234567890abcdefghij7890", "has space••••••••", "tab\t••••••••", "line\n••••••••"} {
		if IsMask(raw) {
			t.Fatalf("IsMask(%q) accepted a non-mask", raw)
		}
	}
	// NormalizeMask converts only the filler and keeps the visible edges; it is
	// a display convenience, never a way to reconstruct a secret.
	for _, test := range []struct{ in, want string }{
		{"", ""},
		{"sk-12345xxxxxxx7890", "sk-12345••••••••7890"},
		{"sk-1xxxxxxxab", "sk-1••••••••ab"},
		{"xxxxxxx", "••••••••"},
		{"sk-12345••••••••7890", "sk-12345••••••••7890"},
		{"sk-raw-secret-value", "sk-raw-secret-value"},
		{"hmac:12345678901234567890", "hmac:12345678901234567890"},
	} {
		if got := NormalizeMask(test.in); got != test.want {
			t.Fatalf("NormalizeMask(%q) = %q, want %q", test.in, got, test.want)
		}
	}
}
