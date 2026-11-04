package backup

import (
	"errors"
	"fmt"
	"os"

	appcrypto "github.com/oh-my-cpa/oh-my-cpa/internal/crypto"
)

type wrappedRecoveryKey struct {
	Ciphertext []byte `json:"ciphertext"`
	Nonce      []byte `json:"nonce"`
}

// ResolveCipher preserves the restored database's encryption and HMAC identities.
// The deployment master key continues to protect local recovery material and is
// not replaced in configuration or in the updater's authentication contract.
func ResolveCipher(databasePath string, wrapping *appcrypto.Cipher) (*appcrypto.Cipher, error) {
	cipher, err := readRecoveryCipher(databasePath+".key", wrapping)
	if errors.Is(err, os.ErrNotExist) {
		return wrapping, nil
	}
	return cipher, err
}

func writeRecoveryCipher(path string, cipher, wrapping *appcrypto.Cipher) error {
	ciphertext, nonce, err := cipher.WrapRecoveryKey(wrapping)
	if err != nil {
		return err
	}
	return writeJSON(path, wrappedRecoveryKey{Ciphertext: ciphertext, Nonce: nonce})
}

func readRecoveryCipher(path string, wrapping *appcrypto.Cipher) (*appcrypto.Cipher, error) {
	var key wrappedRecoveryKey
	if err := readJSON(path, &key); err != nil {
		return nil, err
	}
	cipher, err := appcrypto.UnwrapRecoveryKey(wrapping, key.Ciphertext, key.Nonce)
	if err != nil {
		return nil, fmt.Errorf("open database recovery key with deployment OMCPA_MASTER_KEY: %w", err)
	}
	return cipher, nil
}
