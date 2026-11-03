package backup

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"

	appcrypto "github.com/oh-my-cpa/oh-my-cpa/internal/crypto"
)

func testCipher(t *testing.T) *appcrypto.Cipher {
	t.Helper()
	cipher, err := appcrypto.New("backup-test-master-key-0123456789abcdef")
	if err != nil {
		t.Fatal(err)
	}
	return cipher
}

func TestArtifactRoundTripAndAuthentication(t *testing.T) {
	ctx := context.Background()
	directory := t.TempDir()
	database := filepath.Join(directory, "source.db")
	artifact := filepath.Join(directory, "backup.omcbackup")
	content := bytes.Repeat([]byte("sqlite test image\x00"), 1<<16)
	if err := os.WriteFile(database, content, 0o600); err != nil {
		t.Fatal(err)
	}
	cipher := testCipher(t)
	codec := codec{workFactor: 10}
	password := "independent backup passphrase"
	manifest, err := codec.pack(ctx, database, artifact, password, newManifest(newID(), "test", 1), cipher)
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := os.ReadFile(artifact)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(encoded, content[:128]) {
		t.Fatal("backup contains plaintext")
	}
	restored := filepath.Join(directory, "restored.db")
	decoded, recoveredCipher, err := codec.unpack(ctx, bytes.NewReader(encoded), restored, password)
	if err != nil {
		t.Fatal(err)
	}
	if decoded != manifest {
		t.Fatal("manifest changed")
	}
	actual, err := os.ReadFile(restored)
	if err != nil || !bytes.Equal(actual, content) {
		t.Fatal("database bytes changed")
	}
	identity, _ := cipher.Fingerprint("usage-client-key", "fixture")
	recoveredIdentity, _ := recoveredCipher.Fingerprint("usage-client-key", "fixture")
	if identity != recoveredIdentity {
		t.Fatal("recovery changed historical identities")
	}
	ciphertext, nonce, err := cipher.Encrypt([]byte("encrypted database value"))
	if err != nil {
		t.Fatal(err)
	}
	if value, err := recoveredCipher.Decrypt(ciphertext, nonce); err != nil || string(value) != "encrypted database value" {
		t.Fatalf("recovery lost encryption key: %v", err)
	}
	for _, scenario := range []struct {
		name     string
		encoded  []byte
		password string
		want     error
	}{
		{"wrong password", encoded, "incorrect passphrase", ErrInvalidArtifact},
		{"truncated final chunk", encoded[:len(encoded)-1], password, ErrInvalidArtifact},
		{"invalid file", []byte("not a backup"), password, ErrInvalidArtifact},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "rejected.db")
			_, _, err := codec.unpack(ctx, bytes.NewReader(scenario.encoded), path, scenario.password)
			if !errors.Is(err, scenario.want) {
				t.Fatalf("got %v, want %v", err, scenario.want)
			}
			if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
				t.Fatal("rejected import left database behind")
			}
		})
	}
}

func TestDatabaseLockExcludesAnotherProcessHandle(t *testing.T) {
	path := filepath.Join(t.TempDir(), "database.db")
	first, err := LockDatabase(path)
	if err != nil {
		t.Fatal(err)
	}
	if second, err := LockDatabase(path); err == nil {
		second.Close()
		t.Fatal("second owner admitted")
	}
	if err := first.Close(); err != nil {
		t.Fatal(err)
	}
	second, err := LockDatabase(path)
	if err != nil {
		t.Fatal(err)
	}
	second.Close()
}
