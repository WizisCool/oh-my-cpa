package backup

import (
	"archive/tar"
	"bufio"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"testing"
	"time"

	"filippo.io/age"
	appcrypto "github.com/oh-my-cpa/oh-my-cpa/internal/crypto"
	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
)

const (
	Format                 = "oh-my-cpa/database-backup-v1"
	MaxDatabaseBytes int64 = 8 << 30
	MaxUploadBytes   int64 = MaxDatabaseBytes + (128 << 20)
	maxManifestBytes int64 = 64 << 10
)

var (
	ErrInvalidArtifact    = errors.New("backup file, passphrase or authentication is invalid")
	ErrUnsupportedVersion = errors.New("backup requires a newer OMC version")
	ErrBusy               = errors.New("another database backup or restore is running")
	ErrNotFound           = errors.New("backup job was not found or has expired")
	ErrConfirmation       = errors.New("backup confirmation is invalid or has expired")
	ErrPassphrase         = errors.New("backup passphrase must contain between 12 and 1024 characters")
)

type Manifest struct {
	Format        string `json:"format"`
	BackupID      string `json:"backup_id"`
	Version       string `json:"omc_version"`
	SchemaVersion int    `json:"schema_version"`
	CreatedAtMS   int64  `json:"created_at_ms"`
	SizeBytes     int64  `json:"size_bytes"`
	SHA256        string `json:"sha256"`
	KeyProof      string `json:"key_proof"`
}

type codec struct{ workFactor int }

func defaultWorkFactor() int {
	if testing.Testing() {
		return 10
	}
	return 18
}

func newCodec() codec { return codec{workFactor: defaultWorkFactor()} }

func validatePassphrase(passphrase string) error {
	if len([]rune(passphrase)) < 12 || len(passphrase) > 1024 {
		return ErrPassphrase
	}
	return nil
}

type contextReader struct {
	ctx    context.Context
	reader io.Reader
}

func (r contextReader) Read(data []byte) (int, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	return r.reader.Read(data)
}

func fileDigest(ctx context.Context, path string) (string, int64, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", 0, err
	}
	defer file.Close()
	hash := sha256.New()
	size, err := io.Copy(hash, contextReader{ctx, file})
	if err != nil {
		return "", 0, err
	}
	return hex.EncodeToString(hash.Sum(nil)), size, nil
}

func (c codec) pack(ctx context.Context, databasePath, outputPath, passphrase string, manifest Manifest, cipher *appcrypto.Cipher) (Manifest, error) {
	if err := validatePassphrase(passphrase); err != nil {
		return manifest, err
	}
	digest, size, err := fileDigest(ctx, databasePath)
	if err != nil {
		return manifest, err
	}
	if size <= 0 || size > MaxDatabaseBytes {
		return manifest, errors.New("database exceeds backup size limit")
	}
	manifest.Format = Format
	manifest.SHA256 = digest
	manifest.SizeBytes = size
	manifest.KeyProof, err = cipher.Fingerprint("omc-database-backup-key-v1", manifest.BackupID, manifest.SHA256)
	if err != nil {
		return manifest, err
	}
	content, err := json.Marshal(manifest)
	if err != nil {
		return manifest, err
	}
	recipient, err := age.NewScryptRecipient(passphrase)
	if err != nil {
		return manifest, err
	}
	recipient.SetWorkFactor(c.workFactor)
	output, err := os.OpenFile(outputPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return manifest, err
	}
	isComplete := false
	defer func() {
		output.Close()
		if !isComplete {
			os.Remove(outputPath)
		}
	}()
	encrypted, err := age.Encrypt(output, recipient)
	if err != nil {
		return manifest, err
	}
	compressed := gzip.NewWriter(encrypted)
	archive := tar.NewWriter(compressed)
	if err := archive.WriteHeader(&tar.Header{Name: "manifest.json", Mode: 0o600, Size: int64(len(content)), Typeflag: tar.TypeReg}); err != nil {
		return manifest, err
	}
	if _, err := archive.Write(content); err != nil {
		return manifest, err
	}
	if err := archive.WriteHeader(&tar.Header{Name: "recovery.key", Mode: 0o600, Size: 32, Typeflag: tar.TypeReg}); err != nil {
		return manifest, err
	}
	if err := cipher.WriteRecoveryKey(archive); err != nil {
		return manifest, err
	}
	if err := archive.WriteHeader(&tar.Header{Name: "database.sqlite", Mode: 0o600, Size: size, Typeflag: tar.TypeReg}); err != nil {
		return manifest, err
	}
	database, err := os.Open(databasePath)
	if err != nil {
		return manifest, err
	}
	_, copyErr := io.Copy(archive, contextReader{ctx, database})
	closeErr := database.Close()
	if err := errors.Join(copyErr, closeErr); err != nil {
		return manifest, err
	}
	if err := archive.Close(); err != nil {
		return manifest, err
	}
	if err := compressed.Close(); err != nil {
		return manifest, err
	}
	if err := encrypted.Close(); err != nil {
		return manifest, err
	}
	if err := output.Sync(); err != nil {
		return manifest, err
	}
	if err := output.Close(); err != nil {
		return manifest, err
	}
	isComplete = true
	return manifest, nil
}

func (c codec) unpack(ctx context.Context, input io.Reader, databasePath, passphrase string) (Manifest, *appcrypto.Cipher, error) {
	manifest := Manifest{}
	identity, err := age.NewScryptIdentity(passphrase)
	if err != nil {
		return manifest, nil, ErrInvalidArtifact
	}
	identity.SetMaxWorkFactor(18)
	plaintext, err := age.Decrypt(contextReader{ctx, io.LimitReader(input, MaxUploadBytes+1)}, identity)
	if err != nil {
		return manifest, nil, ErrInvalidArtifact
	}
	buffered := bufio.NewReader(plaintext)
	compressed, err := gzip.NewReader(buffered)
	if err != nil {
		return manifest, nil, ErrInvalidArtifact
	}
	defer compressed.Close()
	compressed.Multistream(false)
	archive := tar.NewReader(compressed)
	header, err := archive.Next()
	if err != nil || header.Name != "manifest.json" || header.Typeflag != tar.TypeReg || header.Size <= 0 || header.Size > maxManifestBytes {
		return manifest, nil, ErrInvalidArtifact
	}
	decoder := json.NewDecoder(archive)
	decoder.DisallowUnknownFields()
	if decoder.Decode(&manifest) != nil || decoder.Decode(new(any)) != io.EOF || manifest.Format != Format || !validID(manifest.BackupID) || manifest.SizeBytes <= 0 || manifest.SizeBytes > MaxDatabaseBytes || len(manifest.SHA256) != 64 || manifest.CreatedAtMS <= 0 {
		return manifest, nil, ErrInvalidArtifact
	}
	header, err = archive.Next()
	if err != nil || header.Name != "recovery.key" || header.Typeflag != tar.TypeReg || header.Size != 32 {
		return manifest, nil, ErrInvalidArtifact
	}
	recoveredCipher, err := appcrypto.ReadRecoveryKey(archive)
	if err != nil {
		return manifest, nil, ErrInvalidArtifact
	}
	if err := verifyManifestKey(manifest, recoveredCipher); err != nil {
		return manifest, nil, err
	}
	if err := repository.RequireBackupSpace(filepath.Dir(databasePath), uint64(manifest.SizeBytes)*2+(16<<20)); err != nil {
		return manifest, nil, err
	}
	header, err = archive.Next()
	if err != nil || header.Name != "database.sqlite" || header.Typeflag != tar.TypeReg || header.Size != manifest.SizeBytes {
		return manifest, nil, ErrInvalidArtifact
	}
	output, err := os.OpenFile(databasePath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return manifest, nil, err
	}
	isComplete := false
	defer func() {
		output.Close()
		if !isComplete {
			os.Remove(databasePath)
		}
	}()
	hash := sha256.New()
	size, err := io.Copy(io.MultiWriter(output, hash), contextReader{ctx, archive})
	if err != nil || size != manifest.SizeBytes {
		return manifest, nil, ErrInvalidArtifact
	}
	if hex.EncodeToString(hash.Sum(nil)) != manifest.SHA256 {
		return manifest, nil, ErrInvalidArtifact
	}
	if _, err := archive.Next(); err != io.EOF {
		return manifest, nil, ErrInvalidArtifact
	}
	// tar EOF is not encrypted-stream EOF. Consume the gzip footer and the age
	// final chunk so a correctly shaped but truncated file cannot pass validation.
	var tail [1]byte
	if count, err := compressed.Read(tail[:]); count != 0 || err != io.EOF {
		return manifest, nil, ErrInvalidArtifact
	}
	if count, err := buffered.Read(tail[:]); count != 0 || err != io.EOF {
		return manifest, nil, ErrInvalidArtifact
	}
	if err := output.Sync(); err != nil {
		return manifest, nil, err
	}
	if err := output.Close(); err != nil {
		return manifest, nil, err
	}
	isComplete = true
	return manifest, recoveredCipher, nil
}

func newManifest(id, version string, schema int) Manifest {
	return Manifest{BackupID: id, Version: version, SchemaVersion: schema, CreatedAtMS: time.Now().UTC().UnixMilli()}
}

func publicError(err error) string {
	for _, known := range []error{ErrPassphrase, ErrInvalidArtifact, ErrBusy, ErrNotFound, ErrConfirmation, ErrUnsupportedVersion, ErrDestinationConfig, ErrDestinationFailed, ErrCredentialPersistence, ErrAutomationConfig} {
		if errors.Is(err, known) {
			return known.Error()
		}
	}
	if errors.Is(err, repository.ErrInsufficientDiskSpace) {
		// The sentinel's own text is about rebuilding the database, which would mislead here.
		return "not enough free disk space for the database backup"
	}
	if errors.Is(err, context.Canceled) {
		return "database operation was interrupted"
	}
	return "database operation failed; inspect the server log"
}

func inspectError(err error) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, repository.ErrBackupSchemaNewer) {
		return ErrUnsupportedVersion
	}
	return fmt.Errorf("%w: database validation failed: %v", ErrInvalidArtifact, err)
}

func verifyManifestKey(manifest Manifest, cipher *appcrypto.Cipher) error {
	expected, err := cipher.Fingerprint("omc-database-backup-key-v1", manifest.BackupID, manifest.SHA256)
	if err != nil {
		return err
	}
	if subtle.ConstantTimeCompare([]byte(expected), []byte(manifest.KeyProof)) != 1 {
		return ErrInvalidArtifact
	}
	return nil
}
