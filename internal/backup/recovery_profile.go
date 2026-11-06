package backup

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"

	"filippo.io/age"
)

const recoveryProfileFormat = "oh-my-cpa/recovery-profile-v1"
const maxAutomationBytes = 256 << 10

type recoveryProfile struct {
	Format       string              `json:"format"`
	Destinations []DestinationConfig `json:"destinations"`
}

// A separately held profile bootstraps cloud access after the database and host
// are lost. It never contains the source deployment key or backup passphrase.
func (m *Manager) WriteRecoveryProfile(ctx context.Context, output io.Writer) error {
	value, err := m.Automation(ctx)
	if err != nil {
		return err
	}
	if len(value.Destinations) == 0 {
		return ErrDestinationConfig
	}
	if err := validatePassphrase(value.Passphrase); err != nil {
		return err
	}
	if err := m.audit(ctx, "recovery_profile.export", value.ID, "admitted"); err != nil {
		return err
	}
	recipient, err := age.NewScryptRecipient(value.Passphrase)
	if err != nil {
		return err
	}
	recipient.SetWorkFactor(m.codec.workFactor)
	writer, err := age.Encrypt(output, recipient)
	if err != nil {
		return err
	}
	encodeErr := json.NewEncoder(writer).Encode(recoveryProfile{recoveryProfileFormat, value.Destinations})
	return errors.Join(encodeErr, writer.Close())
}
func readRecoveryProfile(input io.Reader, passphrase string) (recoveryProfile, error) {
	var value recoveryProfile
	identity, err := age.NewScryptIdentity(passphrase)
	if err != nil {
		return value, ErrInvalidArtifact
	}
	identity.SetMaxWorkFactor(20)
	reader, err := age.Decrypt(io.LimitReader(input, maxAutomationBytes+(64<<10)), identity)
	if err != nil {
		return value, ErrInvalidArtifact
	}
	content, err := io.ReadAll(io.LimitReader(reader, maxAutomationBytes+1))
	if err != nil || len(content) > maxAutomationBytes || json.Unmarshal(content, &value) != nil || value.Format != recoveryProfileFormat || len(value.Destinations) > 8 {
		return recoveryProfile{}, ErrInvalidArtifact
	}
	for _, c := range value.Destinations {
		if validateDestination(c) != nil {
			return recoveryProfile{}, ErrDestinationConfig
		}
	}
	return value, nil
}

// Remote recovery does not open, lock or migrate the target database. It needs
// only the separately saved profile and passphrase, even on a clean machine.
func runRemoteCommand(ctx context.Context, command, profilePath, destinationID, key, outputPath, passphrasePath string, output io.Writer) error {
	passphrase, err := readPassphraseFile(passphrasePath)
	if err != nil {
		return err
	}
	input, err := os.Open(profilePath)
	if err != nil {
		return err
	}
	defer input.Close()
	profile, err := readRecoveryProfile(input, passphrase)
	if err != nil {
		return err
	}
	if destinationID == "" {
		// A secret-free selection list is enough to choose a target without a DB.
		if command != "remote-list" {
			return ErrDestinationConfig
		}
		for _, c := range profile.Destinations {
			if err := json.NewEncoder(output).Encode(struct {
				ID       string `json:"id"`
				Name     string `json:"name"`
				Provider string `json:"provider"`
			}{c.ID, c.Name, c.Provider}); err != nil {
				return err
			}
		}
		return nil
	}
	for index, c := range profile.Destinations {
		if c.ID != destinationID {
			continue
		}
		// Refresh-token rotations must survive repeated recovery commands too.
		destination, err := newRcloneDestination(ctx, c, func(values map[string]string) error {
			profile.Destinations[index].Options = values
			return writeProfileFile(profilePath, passphrase, profile)
		})
		if err != nil {
			return err
		}
		defer destination.Close()
		if command == "remote-list" {
			page, err := destination.List(ctx, "")
			if err != nil {
				return err
			}
			for _, item := range page.Items {
				if err := json.NewEncoder(output).Encode(struct {
					Key  string `json:"key"`
					Size int64  `json:"size_bytes"`
				}{item.Key, item.SizeBytes}); err != nil {
					return err
				}
			}
			return nil
		}
		if outputPath == "" || !validArchiveKey(key) {
			return ErrDestinationConfig
		}
		reader, err := destination.Open(ctx, ObjectRef{Key: key})
		if err != nil {
			return err
		}
		defer reader.Close()
		file, err := os.OpenFile(outputPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
		if err != nil {
			return err
		}
		size, copyErr := io.Copy(file, io.LimitReader(contextReader{ctx, reader}, MaxUploadBytes+1))
		err = errors.Join(copyErr, file.Sync(), file.Close())
		if size > MaxUploadBytes {
			err = ErrInvalidArtifact
		}
		if err != nil {
			os.Remove(outputPath)
			return err
		}
		_, err = io.WriteString(output, "Encrypted backup downloaded; inspect it before restoring\n")
		return err
	}
	return ErrNotFound
}
func writeProfileFile(path, passphrase string, profile recoveryProfile) error {
	file, err := os.CreateTemp(filepath.Dir(path), ".profile-")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	recipient, err := age.NewScryptRecipient(passphrase)
	if err != nil {
		file.Close()
		return err
	}
	recipient.SetWorkFactor(defaultWorkFactor())
	writer, err := age.Encrypt(file, recipient)
	if err != nil {
		file.Close()
		return err
	}
	encodeErr := json.NewEncoder(writer).Encode(profile)
	err = errors.Join(encodeErr, writer.Close(), file.Sync(), file.Close())
	if err != nil {
		return err
	}
	if err := os.Rename(file.Name(), path); err != nil {
		return err
	}
	return syncDirectory(filepath.Dir(path))
}
