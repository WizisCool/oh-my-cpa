package repository

import (
	"bufio"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"filippo.io/age"
	appcrypto "github.com/oh-my-cpa/oh-my-cpa/internal/crypto"
)

const migrationBackupMagic = "oh-my-cpa/sqlite-backup-v2\n"

func (db *DB) createMigrationBackup(ctx context.Context, migrationVersion int) error {
	if db == nil || db.SQL == nil || db.cipher == nil {
		return ErrMigrationBackupRequired
	}
	config := db.backup
	if config.Cipher == nil {
		config.Cipher = db.cipher
	}
	databasePath, err := filepath.Abs(db.path)
	if err != nil {
		return fmt.Errorf("resolve database path for backup: %w", err)
	}
	backupDir := strings.TrimSpace(config.Directory)
	if backupDir == "" {
		backupDir = filepath.Join(filepath.Dir(databasePath), "backups")
	}
	backupDir, err = filepath.Abs(backupDir)
	if err != nil {
		return fmt.Errorf("resolve backup directory: %w", err)
	}
	if err := os.MkdirAll(backupDir, 0o700); err != nil {
		return fmt.Errorf("create backup directory: %w", err)
	}
	if err := os.Chmod(backupDir, 0o700); err != nil {
		return fmt.Errorf("protect backup directory: %w", err)
	}
	started := time.Now()
	logger := slog.Default().With("migration", migrationVersion)
	logger.InfoContext(ctx, "migration backup cleanup started")
	// Startup owns the data-directory lock. A killed attempt must not leave
	// another full snapshot or unverified artifact on every restart.
	if err := cleanMigrationBackupWorkspaces(backupDir); err != nil {
		return fmt.Errorf("clean interrupted migration backup: %w", err)
	}
	if err := retainBackups(backupDir, config.Retention); err != nil {
		return fmt.Errorf("retain migration backups before retry: %w", err)
	}
	freeSpace := config.FreeSpace
	if freeSpace == nil {
		freeSpace = availableBytes
	}
	free, err := freeSpace(backupDir)
	if err != nil {
		return fmt.Errorf("check free space for migration backup: %w", err)
	}
	minimum := config.MinFreeBytes
	if minimum == 0 {
		// Logical pages include committed WAL data that stat(main.db) misses.
		// Snapshot/encryption and artifact/restore each need two copies, plus
		// room for the streaming envelope and authentication tags.
		var pages, pageSize uint64
		if err := db.SQL.QueryRowContext(ctx, `PRAGMA page_count`).Scan(&pages); err != nil {
			return fmt.Errorf("measure migration backup pages: %w", err)
		}
		if err := db.SQL.QueryRowContext(ctx, `PRAGMA page_size`).Scan(&pageSize); err != nil {
			return fmt.Errorf("measure migration backup page size: %w", err)
		}
		size := pages * pageSize
		minimum = 2*size + size/1024 + 4096
	}
	if free < minimum {
		return fmt.Errorf("insufficient free space for migration backup: %d bytes available, %d required", free, minimum)
	}
	workspace := filepath.Join(backupDir, ".migration-backup")
	if err := os.Mkdir(workspace, 0o700); err != nil {
		return fmt.Errorf("create migration backup workspace: %w", err)
	}
	defer os.RemoveAll(workspace)
	snapshotPath := filepath.Join(workspace, "snapshot.db")
	logger.InfoContext(ctx, "migration backup snapshot started")
	// VACUUM INTO reads a consistent image through the WAL, even if a reader
	// prevents checkpointing committed frames into the main database file.
	if _, err := db.SQL.ExecContext(ctx, `VACUUM INTO ?`, snapshotPath); err != nil {
		return fmt.Errorf("snapshot database before migration backup: %w", err)
	}
	if err := os.Chmod(snapshotPath, 0o600); err != nil {
		return fmt.Errorf("protect migration backup snapshot: %w", err)
	}
	stamp := time.Now().UTC().Format("20060102T150405.000000000Z")
	name := fmt.Sprintf("oh-my-cpa-%s-before-migration-%d.db.enc", stamp, migrationVersion)
	stagedPath := filepath.Join(workspace, name)
	logger.InfoContext(ctx, "migration backup encryption started")
	if err := writeMigrationBackup(ctx, snapshotPath, stagedPath, config.Cipher); err != nil {
		return fmt.Errorf("encrypt migration backup: %w", err)
	}
	if err := os.Remove(snapshotPath); err != nil {
		return fmt.Errorf("remove migration backup snapshot: %w", err)
	}
	logger.InfoContext(ctx, "migration backup verification started")
	if err := RestoreBackupSmoke(ctx, stagedPath, config.Cipher); err != nil {
		return fmt.Errorf("%w: %w", ErrBackupRestoreFailed, err)
	}
	// Only verified artifacts enter retention. Until then, previous recovery
	// points remain untouched by the new attempt.
	backupPath := filepath.Join(backupDir, name)
	if err := os.Rename(stagedPath+".sha256", backupPath+".sha256"); err != nil {
		return fmt.Errorf("publish migration backup digest: %w", err)
	}
	if err := os.Rename(stagedPath, backupPath); err != nil {
		return fmt.Errorf("publish migration backup: %w", err)
	}
	if err := retainBackups(backupDir, config.Retention); err != nil {
		return fmt.Errorf("retain migration backups: %w", err)
	}
	logger.InfoContext(ctx, "migration backup completed", "duration", time.Since(started))
	return nil
}

func cleanMigrationBackupWorkspaces(directory string) error {
	entries, err := os.ReadDir(directory)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		name := entry.Name()
		// Include the random plaintext workspaces used by the v1 writer.
		if entry.IsDir() && (name == ".migration-backup" || strings.HasPrefix(name, ".snapshot-") || strings.HasPrefix(name, ".restore-")) {
			if err := os.RemoveAll(filepath.Join(directory, name)); err != nil {
				return err
			}
		}
	}
	return nil
}

// migrationBackupKey adapts the existing database cipher to age's file-key
// wrapping interface. age owns authenticated chunking and end-of-stream checks;
// AES-GCM only handles the small random file key, never the database itself.
type migrationBackupKey struct{ cipher *appcrypto.Cipher }

func (key migrationBackupKey) Wrap(fileKey []byte) ([]*age.Stanza, error) {
	ciphertext, nonce, err := key.cipher.Encrypt(fileKey)
	if err != nil {
		return nil, err
	}
	return []*age.Stanza{{Type: "oh-my-cpa", Args: []string{base64.RawStdEncoding.EncodeToString(nonce)}, Body: ciphertext}}, nil
}

func (key migrationBackupKey) Unwrap(stanzas []*age.Stanza) ([]byte, error) {
	for _, stanza := range stanzas {
		if stanza.Type != "oh-my-cpa" {
			continue
		}
		if len(stanza.Args) != 1 {
			return nil, errors.New("invalid migration backup key")
		}
		nonce, err := base64.RawStdEncoding.DecodeString(stanza.Args[0])
		if err != nil {
			return nil, err
		}
		return key.cipher.Decrypt(stanza.Body, nonce)
	}
	return nil, age.ErrIncorrectIdentity
}

type migrationBackupReader struct {
	ctx    context.Context
	source io.Reader
}

func (reader migrationBackupReader) Read(data []byte) (int, error) {
	if err := reader.ctx.Err(); err != nil {
		return 0, err
	}
	return reader.source.Read(data)
}

func writeMigrationBackup(ctx context.Context, snapshotPath, backupPath string, cipher *appcrypto.Cipher) error {
	source, err := os.Open(snapshotPath)
	if err != nil {
		return err
	}
	defer source.Close()
	output, err := os.OpenFile(backupPath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	defer output.Close()
	digest := sha256.New()
	destination := io.MultiWriter(output, digest)
	if _, err := io.WriteString(destination, migrationBackupMagic); err != nil {
		return err
	}
	encrypted, err := age.Encrypt(destination, migrationBackupKey{cipher})
	if err != nil {
		return err
	}
	if _, err := io.Copy(encrypted, migrationBackupReader{ctx, source}); err != nil {
		return err
	}
	if err := encrypted.Close(); err != nil {
		return err
	}
	if err := output.Sync(); err != nil {
		return err
	}
	if err := output.Close(); err != nil {
		return err
	}
	digestText := hex.EncodeToString(digest.Sum(nil))
	return writePrivateFile(backupPath+".sha256", []byte(digestText+"  "+filepath.Base(backupPath)+"\n"))
}

// BackupArtifact describes a completed encrypted backup.
type BackupArtifact struct {
	Path      string
	SHA256    string
	Size      int64
	CreatedAt time.Time
}

// RestoreBackupSmoke decrypts a backup into a temporary SQLite file and checks
// its schema before the source database changes. It never runs migrations.
func RestoreBackupSmoke(ctx context.Context, backupPath string, cipher *appcrypto.Cipher) error {
	if strings.TrimSpace(backupPath) == "" || cipher == nil {
		return errors.New("backup path and cipher are required")
	}
	// Keep plaintext on the writable backup volume, including in read-only
	// containers. A killed migration leaves this inside its retry workspace.
	directory, err := os.MkdirTemp(filepath.Dir(backupPath), ".restore-")
	if err != nil {
		return fmt.Errorf("create restore directory: %w", err)
	}
	defer os.RemoveAll(directory)
	restoredPath := filepath.Join(directory, "restore.db")
	output, err := os.OpenFile(restoredPath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return fmt.Errorf("write restore database: %w", err)
	}
	decryptErr := decryptMigrationBackup(ctx, backupPath, output, cipher)
	if err := errors.Join(decryptErr, output.Close()); err != nil {
		return err
	}
	restored, err := sql.Open("sqlite", restoredPath)
	if err != nil {
		return fmt.Errorf("open restored database: %w", err)
	}
	defer restored.Close()
	restored.SetMaxOpenConns(1)
	if err := restored.PingContext(ctx); err != nil {
		return fmt.Errorf("ping restored database: %w", err)
	}
	var count int
	if err := restored.QueryRowContext(ctx, `SELECT COUNT(1) FROM sqlite_master`).Scan(&count); err != nil {
		return fmt.Errorf("read restored schema: %w", err)
	}
	if count == 0 {
		return errors.New("restored database has no schema")
	}
	return nil
}

func decryptMigrationBackup(ctx context.Context, path string, destination io.Writer, cipher *appcrypto.Cipher) error {
	source, err := os.Open(path)
	if err != nil {
		return fmt.Errorf("read backup: %w", err)
	}
	defer source.Close()
	digestData, err := os.ReadFile(path + ".sha256")
	if err != nil {
		return fmt.Errorf("read backup digest: %w", err)
	}
	parts := strings.Fields(string(digestData))
	if len(parts) == 0 {
		return errors.New("backup digest is empty")
	}
	digest := sha256.New()
	if _, err := io.Copy(digest, migrationBackupReader{ctx, source}); err != nil {
		return fmt.Errorf("hash backup: %w", err)
	}
	if !strings.EqualFold(parts[0], hex.EncodeToString(digest.Sum(nil))) {
		return errors.New("backup digest mismatch")
	}
	if _, err := source.Seek(0, io.SeekStart); err != nil {
		return err
	}
	buffered := bufio.NewReader(migrationBackupReader{ctx, source})
	if prefix, _ := buffered.Peek(len(migrationBackupMagic)); string(prefix) == migrationBackupMagic {
		if _, err := buffered.Discard(len(migrationBackupMagic)); err != nil {
			return err
		}
		plaintext, err := age.Decrypt(buffered, migrationBackupKey{cipher})
		if err != nil {
			return fmt.Errorf("decrypt backup: %w", err)
		}
		if _, err := io.Copy(destination, plaintext); err != nil {
			return fmt.Errorf("restore backup stream: %w", err)
		}
		return nil
	}
	// v1 artifacts already on disk use one AES-GCM message. Retain the reader
	// for recovery compatibility; new writes never use this whole-file format.
	encoded, err := io.ReadAll(buffered)
	if err != nil {
		return fmt.Errorf("read backup envelope: %w", err)
	}
	var envelope encryptedBackup
	if err := json.Unmarshal(encoded, &envelope); err != nil || envelope.Format != "oh-my-cpa/sqlite-backup-v1" {
		return errors.New("backup envelope is invalid")
	}
	nonce, err := base64.RawStdEncoding.DecodeString(envelope.Nonce)
	if err != nil {
		return fmt.Errorf("decode backup nonce: %w", err)
	}
	ciphertext, err := base64.RawStdEncoding.DecodeString(envelope.Ciphertext)
	if err != nil {
		return fmt.Errorf("decode backup ciphertext: %w", err)
	}
	plaintext, err := cipher.Decrypt(ciphertext, nonce)
	if err != nil {
		return fmt.Errorf("decrypt backup: %w", err)
	}
	_, err = destination.Write(plaintext)
	return err
}

type encryptedBackup struct {
	Format     string `json:"format"`
	Nonce      string `json:"nonce"`
	Ciphertext string `json:"ciphertext"`
}

func writePrivateFile(path string, data []byte) error {
	file, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	if _, err := file.Write(data); err != nil {
		file.Close()
		return err
	}
	if err := file.Sync(); err != nil {
		file.Close()
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	return os.Chmod(path, 0o600)
}

func retainBackups(directory string, retention int) error {
	if retention <= 0 {
		retention = 5
	}
	entries, err := os.ReadDir(directory)
	if err != nil {
		return err
	}
	type backupEntry struct {
		path string
		info os.FileInfo
	}
	backups := make([]backupEntry, 0)
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".db.enc") {
			continue
		}
		path := filepath.Join(directory, entry.Name())
		if _, err := os.Stat(path + ".sha256"); errors.Is(err, os.ErrNotExist) {
			// The v1 writer published ciphertext before its digest. A kill
			// during that write must not evict a complete recovery point.
			if err := os.Remove(path); err != nil {
				return err
			}
			continue
		} else if err != nil {
			return err
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		backups = append(backups, backupEntry{path: path, info: info})
	}
	sort.Slice(backups, func(i, j int) bool { return backups[i].info.ModTime().After(backups[j].info.ModTime()) })
	if len(backups) <= retention {
		return nil
	}
	for _, entry := range backups[retention:] {
		if err := os.Remove(entry.path); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
		if err := os.Remove(entry.path + ".sha256"); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	return nil
}
