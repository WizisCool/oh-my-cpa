package backup

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"

	appcrypto "github.com/oh-my-cpa/oh-my-cpa/internal/crypto"
	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
)

const jobLifetime = 24 * time.Hour
const importLifetime = time.Hour

var ErrAudit = errors.New("required database backup audit could not be recorded")

type Job struct {
	ID            string   `json:"id"`
	Kind          string   `json:"kind"`
	State         string   `json:"state"`
	CreatedAtMS   int64    `json:"created_at_ms"`
	ExpiresAtMS   int64    `json:"expires_at_ms"`
	SizeBytes     int64    `json:"size_bytes"`
	Digest        string   `json:"digest"`
	Manifest      Manifest `json:"manifest"`
	Error         string   `json:"error,omitempty"`
	HasAuditError bool     `json:"has_audit_error"`
}

type Options struct {
	Database           *repository.DB
	DatabasePath       string
	Cipher             *appcrypto.Cipher
	WrappingCipher     *appcrypto.Cipher
	Version            string
	Logger             *slog.Logger
	DestinationFactory func(context.Context, DestinationConfig, func(map[string]string) error) (Destination, error)
}

type Manager struct {
	options      Options
	directory    string
	codec        codec
	lifecycle    context.Context
	cancel       context.CancelFunc
	workers      sync.WaitGroup
	mutex        sync.Mutex
	isBusy       bool
	isClosed     bool
	jobs         map[string]Job
	automationMu sync.Mutex
	oauth        oauthConnections
}

func stateDirectory(databasePath string) string { return databasePath + ".recovery" }
func NewManager(ctx context.Context, options Options) (*Manager, error) {
	directory := stateDirectory(options.DatabasePath)
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return nil, err
	}
	if err := os.Chmod(directory, 0o700); err != nil {
		return nil, err
	}
	if options.Logger == nil {
		options.Logger = slog.Default()
	}
	lifecycle, cancel := context.WithCancel(ctx)
	manager := &Manager{options: options, directory: directory, codec: newCodec(), lifecycle: lifecycle, cancel: cancel, jobs: map[string]Job{}}
	entries, err := os.ReadDir(directory)
	if err != nil {
		cancel()
		return nil, err
	}
	for _, entry := range entries {
		if !entry.IsDir() || !validID(entry.Name()) {
			continue
		}
		var job Job
		if err := readJSON(filepath.Join(directory, entry.Name(), "job.json"), &job); err != nil {
			options.Logger.Warn("backup job metadata could not be read", "job_id", entry.Name(), "error", err)
			continue
		}
		if job.ID != entry.Name() {
			cancel()
			return nil, errors.New("backup job metadata identity mismatch")
		}
		if job.ExpiresAtMS < time.Now().UnixMilli() && job.State != "scheduled" && job.State != "completed" {
			if err := os.RemoveAll(filepath.Join(directory, entry.Name())); err != nil {
				cancel()
				return nil, err
			}
			continue
		}
		if job.State != "ready" && job.State != "completed" && job.State != "failed" {
			job.State = "failed"
			job.Error = "database operation was interrupted"
			if err := writeJSON(filepath.Join(directory, job.ID, "job.json"), job); err != nil {
				cancel()
				return nil, err
			}
		}
		manager.jobs[job.ID] = job

	}
	var pending restoreJournal
	if err := readJSON(filepath.Join(directory, "restore.json"), &pending); err == nil && pending.State == "requested" {
		job, ok := manager.jobs[pending.JobID]
		if !ok {
			cancel()
			return nil, errors.New("pending restore job is missing")
		}
		job.State = "scheduled"
		manager.jobs[job.ID] = job
		manager.isBusy = true
	} else if err != nil && !errors.Is(err, os.ErrNotExist) {
		cancel()
		return nil, err
	}
	return manager, nil
}

func (m *Manager) StartAutomation() { m.startAutomation() }

func (m *Manager) Close() error {
	m.mutex.Lock()
	m.isClosed = true
	m.mutex.Unlock()
	m.cancel()
	m.workers.Wait()
	return nil
}
func (m *Manager) reserve(kind string) (Job, error) {
	m.mutex.Lock()
	defer m.mutex.Unlock()
	if m.isClosed || m.isBusy {
		return Job{}, ErrBusy
	}
	for id, job := range m.jobs {
		if job.ExpiresAtMS < time.Now().UnixMilli() && job.State != "completed" {
			if err := os.RemoveAll(m.jobDirectory(id)); err != nil {
				return Job{}, err
			}
			delete(m.jobs, id)
		}
	}
	job := Job{ID: newID(), Kind: kind, State: "queued", CreatedAtMS: time.Now().UnixMilli(), ExpiresAtMS: time.Now().Add(jobLifetime).UnixMilli()}
	if kind == "import" {
		job.ExpiresAtMS = time.Now().Add(importLifetime).UnixMilli()
	}
	if err := os.Mkdir(m.jobDirectory(job.ID), 0o700); err != nil {
		return Job{}, err
	}
	if err := writeJSON(m.jobPath(job.ID), job); err != nil {
		os.RemoveAll(m.jobDirectory(job.ID))
		return Job{}, err
	}
	m.jobs[job.ID] = job
	m.isBusy = true
	m.workers.Add(1)
	return job, nil
}
func (m *Manager) release()                      { m.mutex.Lock(); m.isBusy = false; m.mutex.Unlock(); m.workers.Done() }
func (m *Manager) jobDirectory(id string) string { return filepath.Join(m.directory, id) }
func (m *Manager) jobPath(id string) string      { return filepath.Join(m.jobDirectory(id), "job.json") }
func (m *Manager) save(job Job) error {
	m.mutex.Lock()
	defer m.mutex.Unlock()
	if err := writeJSON(m.jobPath(job.ID), job); err != nil {
		return err
	}
	m.jobs[job.ID] = job
	return nil
}
func (m *Manager) audit(ctx context.Context, action, id, result string) error {
	_, err := repository.New(m.options.Database).RecordAuditEvent(ctx, repository.AuditEvent{Action: "system.database." + action, TargetType: "database_backup", TargetID: id, Result: result})
	if err != nil {
		return fmt.Errorf("%w: %v", ErrAudit, err)
	}
	return nil
}
func (m *Manager) failed(job Job, err error) {
	job.State = "failed"
	job.Error = publicError(err)
	m.options.Logger.Error("database backup operation failed", "job_id", job.ID, "kind", job.Kind, "error", err)
	if saveErr := m.save(job); saveErr != nil {
		m.options.Logger.Error("persist database backup failure", "error", saveErr)
	}
}
func (m *Manager) Get(id string) (Job, error) {
	m.mutex.Lock()
	defer m.mutex.Unlock()
	job, ok := m.jobs[id]
	if !ok || job.ExpiresAtMS < time.Now().UnixMilli() && job.State != "scheduled" && job.State != "completed" {
		return Job{}, ErrNotFound
	}
	return job, nil
}
func (m *Manager) List() []Job {
	m.mutex.Lock()
	defer m.mutex.Unlock()
	items := []Job{}
	for _, job := range m.jobs {
		if job.ExpiresAtMS >= time.Now().UnixMilli() || job.State == "scheduled" || job.State == "completed" {
			items = append(items, job)
		}
	}
	sort.Slice(items, func(i, j int) bool { return items[i].CreatedAtMS > items[j].CreatedAtMS })
	return items
}

func (m *Manager) CreateExport(ctx context.Context, passphrase string) (Job, error) {
	if err := validatePassphrase(passphrase); err != nil {
		return Job{}, err
	}
	job, err := m.reserve("export")
	if err != nil {
		return Job{}, err
	}
	if err := m.audit(ctx, "export", job.ID, "admitted"); err != nil {
		m.failed(job, err)
		m.release()
		return Job{}, err
	}
	go func() {
		defer m.release()
		if err := m.export(job, passphrase); err != nil {
			m.failed(job, err)
		}
	}()
	return job, nil
}
func (m *Manager) export(job Job, passphrase string) error {
	ctx := m.lifecycle
	snapshot := filepath.Join(m.jobDirectory(job.ID), "snapshot.db")
	defer os.Remove(snapshot)
	if err := repository.RequireBackupSpace(m.directory, uint64(m.options.Database.FootprintBytes())*3+(16<<20)); err != nil {
		return err
	}
	job.State = "snapshotting"
	if err := m.save(job); err != nil {
		return err
	}
	if err := m.options.Database.SnapshotDatabase(ctx, snapshot); err != nil {
		return err
	}
	job.State = "packaging"
	if err := m.save(job); err != nil {
		return err
	}
	schema, err := repository.ValidateDatabaseBackup(ctx, snapshot)
	if err != nil {
		return fmt.Errorf("validate database export snapshot: %w", err)
	}
	manifest, err := m.codec.pack(ctx, snapshot, filepath.Join(m.jobDirectory(job.ID), "backup.omcbackup"), passphrase, newManifest(job.ID, m.options.Version, schema), m.options.Cipher)
	if err != nil {
		return err
	}
	job.Manifest = manifest
	job.Digest, job.SizeBytes, err = fileDigest(ctx, filepath.Join(m.jobDirectory(job.ID), "backup.omcbackup"))
	if err != nil {
		return err
	}
	job.State = "ready"
	if err := m.audit(ctx, "export.completed", job.ID, "success"); err != nil {
		m.options.Logger.Warn("database backup created but outcome audit failed", "job_id", job.ID, "error", err)
		job.HasAuditError = true
	}
	return m.save(job)
}

func (m *Manager) OpenExport(ctx context.Context, id string) (io.ReadCloser, Job, error) {
	job, err := m.Get(id)
	if err != nil {
		return nil, job, err
	}
	if job.Kind != "export" || job.State != "ready" {
		return nil, job, ErrNotFound
	}
	if err := m.audit(ctx, "export.download", id, "admitted"); err != nil {
		return nil, job, err
	}
	path := filepath.Join(m.jobDirectory(id), "backup.omcbackup")
	file, err := os.Open(path)
	if err != nil {
		return nil, job, err
	}
	info, err := file.Stat()
	if err != nil || info.Size() != job.SizeBytes {
		file.Close()
		if err != nil {
			return nil, job, err
		}
		return nil, job, ErrInvalidArtifact
	}
	return file, job, nil
}

func (m *Manager) StageImport(ctx context.Context, input io.Reader, passphrase string) (job Job, err error) {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	stop := context.AfterFunc(m.lifecycle, cancel)
	defer stop()
	job, err = m.reserve("import")
	if err != nil {
		return job, err
	}
	defer m.release()
	candidate := filepath.Join(m.jobDirectory(job.ID), "candidate.db")
	defer func() {
		if err != nil {
			os.Remove(candidate)
			os.Remove(filepath.Join(m.jobDirectory(job.ID), "candidate.key"))
			m.failed(job, err)
		}
	}()
	if err = m.audit(ctx, "import.inspect", job.ID, "admitted"); err != nil {
		return job, err
	}
	if err = repository.RequireBackupSpace(m.directory, 32<<20); err != nil {
		return job, err
	}
	job.State = "validating"
	if err = m.save(job); err != nil {
		return job, err
	}
	manifest, recoveredCipher, err := m.codec.unpack(ctx, input, candidate, passphrase)
	if err != nil {
		return job, err
	}
	if err = repository.RequireBackupSpace(m.directory, uint64(manifest.SizeBytes)*3+(16<<20)); err != nil {
		return job, err
	}
	if _, err = repositoryValidation(ctx, candidate, recoveredCipher, manifest.SchemaVersion); err != nil {
		return job, err
	}
	if err = writeRecoveryCipher(filepath.Join(m.jobDirectory(job.ID), "candidate.key"), recoveredCipher, m.options.WrappingCipher); err != nil {
		return job, err
	}
	job.Manifest = manifest
	job.Digest, job.SizeBytes, err = fileDigest(ctx, candidate)
	if err != nil {
		return job, err
	}
	if err = m.audit(ctx, "import.inspect.completed", job.ID, "success"); err != nil {
		return job, err
	}
	job.State = "ready"
	err = m.save(job)
	return job, err
}

func (m *Manager) Apply(ctx context.Context, id, digest string) error {
	m.mutex.Lock()
	defer m.mutex.Unlock()
	job, ok := m.jobs[id]
	if m.isBusy || m.isClosed {
		return ErrBusy
	}
	if !ok || job.Kind != "import" || job.State != "ready" || job.Digest != digest || job.ExpiresAtMS < time.Now().UnixMilli() {
		return ErrConfirmation
	}
	if err := m.audit(ctx, "restore", id, "admitted"); err != nil {
		return err
	}
	if err := writeJSON(filepath.Join(m.directory, "restore.json"), restoreJournal{JobID: id, State: "requested", Digest: digest}); err != nil {
		return err
	}
	job.State = "scheduled"
	m.jobs[id] = job
	m.isBusy = true
	return nil
}

func (m *Manager) Delete(ctx context.Context, id string) error {
	m.mutex.Lock()
	defer m.mutex.Unlock()
	job, ok := m.jobs[id]
	if !ok {
		return ErrNotFound
	}
	if job.State != "ready" && job.State != "failed" && job.State != "scheduled" && job.State != "completed" {
		return ErrBusy
	}
	if err := m.audit(ctx, "delete", id, "admitted"); err != nil {
		return err
	}
	if job.State == "scheduled" {
		if err := removeIfExists(filepath.Join(m.directory, "restore.json")); err != nil {
			return err
		}
		m.isBusy = false
	}
	if err := os.RemoveAll(m.jobDirectory(id)); err != nil {
		return err
	}
	delete(m.jobs, id)
	return nil
}

func repositoryValidation(ctx context.Context, path string, cipher *appcrypto.Cipher, version int) (int, error) {
	schema, err := repository.ValidateDatabaseBackup(ctx, path)
	if err != nil {
		return 0, inspectError(err)
	}
	if schema != version {
		return 0, ErrInvalidArtifact
	}
	if err := repository.PrepareDatabaseBackup(ctx, path, cipher); err != nil {
		return 0, inspectError(err)
	}
	return schema, nil
}
