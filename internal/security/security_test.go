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
