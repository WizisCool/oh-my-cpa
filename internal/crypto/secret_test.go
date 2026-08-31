package crypto

import (
	"bytes"
	"testing"
)

func TestEncryptDecryptAndAuthentication(t *testing.T) {
	cipher, err := New("01234567890123456789012345678901")
	if err != nil {
		t.Fatal(err)
	}
	plaintext := []byte("cpa management key")
	ciphertext, nonce, err := cipher.Encrypt(plaintext)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Equal(ciphertext, plaintext) {
		t.Fatal("ciphertext must not equal plaintext")
	}
	got, err := cipher.Decrypt(ciphertext, nonce)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, plaintext) {
		t.Fatalf("decrypted value = %q, want %q", got, plaintext)
	}
	ciphertext[0] ^= 1
	if _, err := cipher.Decrypt(ciphertext, nonce); err == nil {
		t.Fatal("tampered ciphertext unexpectedly decrypted")
	}
}

func TestFingerprintIsStableAndSecretIndependent(t *testing.T) {
	first, err := New("01234567890123456789012345678901")
	if err != nil {
		t.Fatal(err)
	}
	second, err := New("01234567890123456789012345678902")
	if err != nil {
		t.Fatal(err)
	}
	a, err := first.Fingerprint("instance", "codex", "https://example.test")
	if err != nil {
		t.Fatal(err)
	}
	b, err := first.Fingerprint("instance", "codex", "https://example.test")
	if err != nil {
		t.Fatal(err)
	}
	if a != b {
		t.Fatal("fingerprint is not stable")
	}
	c, err := second.Fingerprint("instance", "codex", "https://example.test")
	if err != nil {
		t.Fatal(err)
	}
	if a == c {
		t.Fatal("fingerprints from different master keys must differ")
	}
}

func TestNewRejectsShortMasterKey(t *testing.T) {
	if _, err := New("too-short"); err == nil {
		t.Fatal("short master key unexpectedly accepted")
	}
}
