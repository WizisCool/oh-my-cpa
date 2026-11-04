package crypto

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"strings"
)

var ErrInvalidMasterKey = errors.New("master key must be at least 32 bytes or a 64-character hex key")

// Cipher encrypts application secrets at rest. Recovery key material may leave
// this package only through the explicit encrypted-backup and wrapping paths.
type Cipher struct {
	key []byte
}

func New(masterKey string) (*Cipher, error) {
	masterKey = strings.TrimSpace(masterKey)
	if masterKey == "" {
		return nil, ErrInvalidMasterKey
	}

	key := []byte(masterKey)
	if len(masterKey) == 64 {
		if decoded, err := hex.DecodeString(masterKey); err == nil {
			key = decoded
		} else if decoded, err := base64.RawURLEncoding.DecodeString(masterKey); err == nil && len(decoded) >= 32 {
			key = decoded
		}
	} else if decoded, err := base64.RawURLEncoding.DecodeString(masterKey); err == nil && len(decoded) >= 32 {
		key = decoded
	}
	if len(key) < 32 {
		// A short passphrase is rejected rather than silently stretching a weak
		// deployment secret. Longer passphrases are deterministically reduced to
		// an AES-256 key.
		return nil, ErrInvalidMasterKey
	}
	if len(key) != 32 {
		digest := sha256.Sum256(key)
		key = digest[:]
	}
	return &Cipher{key: append([]byte(nil), key...)}, nil
}

func (c *Cipher) Encrypt(plaintext []byte) (ciphertext, nonce []byte, err error) {
	gcm, err := c.gcm()
	if err != nil {
		return nil, nil, err
	}
	nonce = make([]byte, gcm.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return nil, nil, fmt.Errorf("generate nonce: %w", err)
	}
	return gcm.Seal(nil, nonce, plaintext, nil), nonce, nil
}

func (c *Cipher) Decrypt(ciphertext, nonce []byte) ([]byte, error) {
	gcm, err := c.gcm()
	if err != nil {
		return nil, err
	}
	if len(nonce) != gcm.NonceSize() {
		return nil, errors.New("invalid nonce")
	}
	plaintext, err := gcm.Open(nil, nonce, ciphertext, nil)
	if err != nil {
		return nil, errors.New("decrypt secret: authentication failed")
	}
	return plaintext, nil
}

// Fingerprint creates a stable, non-reversible identity for resource matching.
// Only non-secret identity fields should be passed to it. The master key is
// used as the HMAC key so the result cannot be guessed with an offline table.
func (c *Cipher) Fingerprint(parts ...string) (string, error) {
	if c == nil || len(c.key) != 32 {
		return "", ErrInvalidMasterKey
	}
	mac := hmac.New(sha256.New, c.key)
	for index, part := range parts {
		if index > 0 {
			mac.Write([]byte{0x1f})
		}
		mac.Write([]byte(strings.TrimSpace(part)))
	}
	return "hmac:" + hex.EncodeToString(mac.Sum(nil)), nil
}

func (c *Cipher) gcm() (cipher.AEAD, error) {
	if c == nil || len(c.key) != 32 {
		return nil, ErrInvalidMasterKey
	}
	block, err := aes.NewCipher(c.key)
	if err != nil {
		return nil, fmt.Errorf("create cipher: %w", err)
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, fmt.Errorf("create gcm: %w", err)
	}
	return gcm, nil
}

// WriteRecoveryKey writes the normalized key into an already encrypted backup
// stream. It must never be used for ordinary HTTP responses or job metadata.
func (c *Cipher) WriteRecoveryKey(destination io.Writer) error {
	if c == nil || len(c.key) != 32 {
		return ErrInvalidMasterKey
	}
	count, err := destination.Write(c.key)
	if err == nil && count != len(c.key) {
		return io.ErrShortWrite
	}
	return err
}

// ReadRecoveryKey reads the fixed-size key entry from a decrypted backup stream.
func ReadRecoveryKey(source io.Reader) (*Cipher, error) {
	key, err := io.ReadAll(io.LimitReader(source, 33))
	if err != nil {
		return nil, err
	}
	if len(key) != 32 {
		return nil, ErrInvalidMasterKey
	}
	return &Cipher{key: key}, nil
}

// WrapRecoveryKey keeps the database's encryption and identity key portable
// without persisting it in plaintext under the destination deployment.
func (c *Cipher) WrapRecoveryKey(wrapping *Cipher) (ciphertext, nonce []byte, err error) {
	if c == nil || len(c.key) != 32 {
		return nil, nil, ErrInvalidMasterKey
	}
	return wrapping.Encrypt(c.key)
}

func UnwrapRecoveryKey(wrapping *Cipher, ciphertext, nonce []byte) (*Cipher, error) {
	key, err := wrapping.Decrypt(ciphertext, nonce)
	if err != nil {
		return nil, err
	}
	if len(key) != 32 {
		return nil, ErrInvalidMasterKey
	}
	return &Cipher{key: key}, nil
}
