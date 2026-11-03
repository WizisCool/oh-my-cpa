package backup

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"

	appcrypto "github.com/oh-my-cpa/oh-my-cpa/internal/crypto"
	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
)

type restoreJournal struct {
	JobID         string   `json:"job_id"`
	State         string   `json:"state"`
	Digest        string   `json:"digest"`
	OriginalFiles []string `json:"original_files,omitempty"`
}
type restoreTransaction struct {
	databasePath string
	directory    string
	journal      restoreJournal
}

// ApplyPendingRestore runs with the process lock held, before SQLite or any
// background service opens. It is also the offline CLI's restore entry point.
func ApplyPendingRestore(ctx context.Context, databasePath string, wrapping *appcrypto.Cipher, version string) error {
	directory := stateDirectory(databasePath)
	var journal restoreJournal
	err := readJSON(filepath.Join(directory, "restore.json"), &journal)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if !validID(journal.JobID) {
		return errors.New("invalid restore journal")
	}
	transaction := &restoreTransaction{databasePath, directory, journal}
	switch journal.State {
	case "committed", "rolled_back":
		return nil
	case "activating":
		return transaction.rollback()
	case "requested", "prepared":
	default:
		return errors.New("invalid restore state")
	}
	jobDirectory := filepath.Join(directory, journal.JobID)
	candidate := filepath.Join(jobDirectory, "candidate.db")
	digest, _, err := fileDigest(ctx, candidate)
	if err != nil {
		return err
	}
	if digest != journal.Digest {
		return ErrConfirmation
	}
	var job Job
	if err := readJSON(filepath.Join(jobDirectory, "job.json"), &job); err != nil {
		return err
	}
	recoveredCipher, err := readRecoveryCipher(filepath.Join(jobDirectory, "candidate.key"), wrapping)
	if err != nil {
		return err
	}
	if err := verifyManifestKey(job.Manifest, recoveredCipher); err != nil {
		return err
	}
	if err := repository.PrepareDatabaseBackup(ctx, candidate, recoveredCipher); err != nil {
		return err
	}
	journal.Digest, _, err = fileDigest(ctx, candidate)
	if err != nil {
		return err
	}
	transaction.journal.Digest = journal.Digest
	if err := writeJSON(filepath.Join(directory, "restore.json"), journal); err != nil {
		return err
	}
	if journal.State == "requested" {
		cipher, err := ResolveCipher(databasePath, wrapping)
		if err != nil {
			return err
		}
		if info, err := os.Stat(databasePath); err == nil {
			sourceBytes := info.Size()
			if wal, err := os.Stat(databasePath + "-wal"); err == nil {
				sourceBytes += wal.Size()
			} else if !errors.Is(err, os.ErrNotExist) {
				return err
			}
			if err := repository.RequireBackupSpace(directory, uint64(sourceBytes)*4+(16<<20)); err != nil {
				return err
			}
			snapshot := filepath.Join(jobDirectory, "rollback.db")
			defer os.Remove(snapshot)
			if err := removeIfExists(snapshot); err != nil {
				return err
			}
			if err := repository.SnapshotStoppedDatabase(ctx, databasePath, snapshot); err != nil {
				return err
			}
			schema, err := repository.ValidateDatabaseBackup(ctx, snapshot)
			if err != nil {
				return err
			}
			rollback := filepath.Join(jobDirectory, "rollback.omcbackup")
			if err := removeIfExists(rollback); err != nil {
				return err
			}
			secret, err := wrapping.Fingerprint("omc-database-rollback-v1", job.ID)
			if err != nil {
				return err
			}
			manifest, err := newCodec().pack(ctx, snapshot, rollback, secret, newManifest(job.ID, version, schema), cipher)
			if err != nil {
				return err
			}
			verified := filepath.Join(jobDirectory, "verified-rollback.db")
			defer os.Remove(verified)
			if err := removeIfExists(verified); err != nil {
				return err
			}
			input, err := os.Open(rollback)
			if err != nil {
				return err
			}
			decoded, _, unpackErr := newCodec().unpack(ctx, input, verified, secret)
			closeErr := input.Close()
			if err := errors.Join(unpackErr, closeErr); err != nil {
				return err
			}
			if manifest.SHA256 != decoded.SHA256 {
				return ErrInvalidArtifact
			}
		} else if !errors.Is(err, os.ErrNotExist) {
			return err
		}
		journal.State = "prepared"
		transaction.journal = journal
		if err := writeJSON(filepath.Join(directory, "restore.json"), journal); err != nil {
			return err
		}
	}
	// Save the closed main/WAL/SHM set first. These copies make rollback both
	// deterministic and repeatable if the process exits during the file switch.
	for _, suffix := range []string{"", "-wal", "-shm", ".key"} {
		if _, err := os.Stat(databasePath + suffix); errors.Is(err, os.ErrNotExist) {
			continue
		} else if err != nil {
			return err
		}
		if err := copyPrivate(ctx, databasePath+suffix, filepath.Join(jobDirectory, "original.db"+suffix)); err != nil {
			return err
		}
		transaction.journal.OriginalFiles = append(transaction.journal.OriginalFiles, suffix)
	}
	if err := syncDirectory(jobDirectory); err != nil {
		return err
	}
	transaction.journal.State = "activating"
	if err := writeJSON(filepath.Join(directory, "restore.json"), transaction.journal); err != nil {
		return err
	}
	if err := transaction.install(ctx, candidate, recoveredCipher); err != nil {
		return errors.Join(err, transaction.rollback())
	}
	job.State = "completed"
	job.ExpiresAtMS = time.Now().Add(jobLifetime).UnixMilli()
	if err := writeJSON(filepath.Join(jobDirectory, "job.json"), job); err != nil {
		return errors.Join(err, transaction.rollback())
	}
	transaction.journal.State = "committed"
	return writeJSON(filepath.Join(directory, "restore.json"), transaction.journal)
}

func (t *restoreTransaction) install(ctx context.Context, candidate string, cipher *appcrypto.Cipher) error {
	for _, suffix := range []string{"-wal", "-shm"} {
		if err := removeIfExists(t.databasePath + suffix); err != nil {
			return err
		}
	}
	if err := os.Rename(candidate, t.databasePath); err != nil {
		return err
	}
	if err := syncDirectory(filepath.Dir(t.databasePath)); err != nil {
		return err
	}
	key, err := os.ReadFile(filepath.Join(t.directory, t.journal.JobID, "candidate.key"))
	if err != nil {
		return err
	}
	if err := writePrivate(t.databasePath+".key", key); err != nil {
		return err
	}
	database, err := repository.Open(ctx, t.databasePath, repository.WithCipher(cipher))
	if err != nil {
		return err
	}
	if err := resetRestoredAutomation(ctx, database, cipher); err != nil {
		return errors.Join(err, database.Close())
	}
	_, auditErr := repository.New(database).RecordAuditEvent(ctx, repository.AuditEvent{Action: "system.database.restore.completed", TargetType: "database_backup", TargetID: t.journal.JobID, Result: "success"})
	return errors.Join(auditErr, database.Close())
}
func (t *restoreTransaction) rollback() error {
	for _, suffix := range []string{"", "-wal", "-shm", ".key"} {
		hasOriginal := false
		for _, original := range t.journal.OriginalFiles {
			if original == suffix {
				hasOriginal = true
			}
		}
		if hasOriginal {
			if err := copyPrivate(context.Background(), filepath.Join(t.directory, t.journal.JobID, "original.db"+suffix), t.databasePath+suffix); err != nil {
				return err
			}
		} else if err := removeIfExists(t.databasePath + suffix); err != nil {
			return err
		}
	}
	if err := syncDirectory(filepath.Dir(t.databasePath)); err != nil {
		return err
	}
	var job Job
	if err := readJSON(filepath.Join(t.directory, t.journal.JobID, "job.json"), &job); err != nil {
		return err
	}
	job.State = "failed"
	job.Error = "database restoration was rolled back"
	if err := writeJSON(filepath.Join(t.directory, job.ID, "job.json"), job); err != nil {
		return err
	}
	t.journal.State = "rolled_back"
	return writeJSON(filepath.Join(t.directory, "restore.json"), t.journal)
}
func copyPrivate(ctx context.Context, source, destination string) error {
	input, err := os.Open(source)
	if err != nil {
		return err
	}
	defer input.Close()
	output, err := os.OpenFile(destination, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	_, copyErr := io.Copy(output, contextReader{ctx, input})
	syncErr := output.Sync()
	closeErr := output.Close()
	return errors.Join(copyErr, syncErr, closeErr)
}

func stageOfflineRestore(ctx context.Context, databasePath, inputPath, passphrase string, wrapping *appcrypto.Cipher) (string, error) {
	directory := stateDirectory(databasePath)
	var pending restoreJournal
	if err := readJSON(filepath.Join(directory, "restore.json"), &pending); err == nil {
		if pending.State != "committed" && pending.State != "rolled_back" {
			return "", errors.New("a database restore is already pending; finish or cancel it first")
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return "", err
	}
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return "", err
	}
	id := newID()
	jobDirectory := filepath.Join(directory, id)
	if err := os.Mkdir(jobDirectory, 0o700); err != nil {
		return "", err
	}
	isStaged := false
	defer func() {
		if !isStaged {
			os.RemoveAll(jobDirectory)
		}
	}()
	input, err := os.Open(inputPath)
	if err != nil {
		return "", err
	}
	defer input.Close()
	candidate := filepath.Join(jobDirectory, "candidate.db")
	manifest, recoveredCipher, err := newCodec().unpack(ctx, input, candidate, passphrase)
	if err != nil {
		return "", err
	}
	if _, err := repositoryValidation(ctx, candidate, recoveredCipher, manifest.SchemaVersion); err != nil {
		return "", err
	}
	auditPath := databasePath
	if _, err := os.Stat(databasePath); errors.Is(err, os.ErrNotExist) {
		auditPath = candidate
	} else if err != nil {
		return "", err
	}
	if err := repository.RecordStoppedDatabaseAudit(ctx, auditPath, repository.AuditEvent{Action: "system.database.restore", TargetType: "database_backup", TargetID: id, Result: "admitted"}); err != nil {
		return "", fmt.Errorf("%w: %v", ErrAudit, err)
	}
	digest, size, err := fileDigest(ctx, candidate)
	if err != nil {
		return "", err
	}
	if err := writeRecoveryCipher(filepath.Join(jobDirectory, "candidate.key"), recoveredCipher, wrapping); err != nil {
		return "", err
	}
	job := Job{ID: id, Kind: "import", State: "ready", Digest: digest, SizeBytes: size, Manifest: manifest, CreatedAtMS: time.Now().UnixMilli(), ExpiresAtMS: time.Now().Add(importLifetime).UnixMilli()}
	if err := writeJSON(filepath.Join(jobDirectory, "job.json"), job); err != nil {
		return "", err
	}
	if err := writeJSON(filepath.Join(directory, "restore.json"), restoreJournal{JobID: id, State: "requested", Digest: digest}); err != nil {
		return "", err
	}
	isStaged = true
	return id, nil
}

func CancelPendingRestore(databasePath string) error {
	directory := stateDirectory(databasePath)
	var journal restoreJournal
	if err := readJSON(filepath.Join(directory, "restore.json"), &journal); err != nil {
		return err
	}
	if journal.State != "requested" && journal.State != "prepared" {
		return fmt.Errorf("restoration cannot be cancelled in state %s", journal.State)
	}
	if !validID(journal.JobID) {
		return errors.New("invalid restore journal")
	}
	jobPath := filepath.Join(directory, journal.JobID, "job.json")
	var job Job
	if err := readJSON(jobPath, &job); err == nil {
		// Startup preparation may have migrated the candidate since validation.
		// Cancellation requires a fresh upload rather than another stale confirmation.
		job.State = "failed"
		job.Error = "database restoration was cancelled"
		if err := writeJSON(jobPath, job); err != nil {
			return err
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return removeIfExists(filepath.Join(directory, "restore.json"))
}
