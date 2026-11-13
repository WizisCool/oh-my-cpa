package security

import "testing"

func TestMaskAccountAndEmailAddresses(t *testing.T) {
	cases := []struct {
		input string
		want  string
	}{
		{"owner@example.com", "ow•••r@example.com"},
		{"ab@example.com", "a•••@example.com"},
		{"alice!@example.com", "al•••!@example.com"},
		{"acme-prod-01", "acm•••01"},
		{"short", "•••"},
		{"ow•••r@example.com", "ow•••r@example.com"},
	}
	for _, tc := range cases {
		if got := MaskAccount(tc.input); got != tc.want {
			t.Errorf("MaskAccount(%q) = %q, want %q", tc.input, got, tc.want)
		}
	}

	if got := MaskAccountIn("codex-Owner@Example.com.json", "owner@example.com"); got != "codex-ow•••r@example.com.json" {
		t.Fatalf("MaskAccountIn case-insensitive = %q", got)
	}

	// Fallback filename/label masking must catch RFC 5322 punctuation in local parts and stay idempotent.
	if got := MaskEmailAddresses("seat alice!@example.com"); got != "seat al•••!@example.com" {
		t.Fatalf("MaskEmailAddresses punctuation = %q, want seat al•••!@example.com", got)
	}
	maskedFile := MaskEmailAddresses("login-alice!@example.com.json")
	if maskedFile != "lo•••!@example.com.json" {
		t.Fatalf("MaskEmailAddresses filename = %q, want lo•••!@example.com.json", maskedFile)
	}
	if twice := MaskEmailAddresses(maskedFile); twice != maskedFile {
		t.Fatalf("MaskEmailAddresses idempotence failed: %q -> %q", maskedFile, twice)
	}
}
