package backup

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"maps"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"

	appcrypto "github.com/oh-my-cpa/oh-my-cpa/internal/crypto"
	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
)

var ErrAutomationConfig = errors.New("automatic backup settings are invalid")

type Automation struct {
	ID              string              `json:"id"`
	Enabled         bool                `json:"enabled"`
	IntervalHours   int                 `json:"interval_hours"`
	KeepLocal       int                 `json:"keep_local"`
	KeepRemote      int                 `json:"keep_remote"`
	Passphrase      string              `json:"passphrase"`
	Destinations    []DestinationConfig `json:"destinations"`
	NextRunAtMS     int64               `json:"next_run_at_ms"`
	LastRunAtMS     int64               `json:"last_run_at_ms"`
	LastSuccessAtMS int64               `json:"last_success_at_ms"`
	LastError       string              `json:"last_error"`
}

func (m *Manager) archiveDirectory() string { return m.options.DatabasePath + ".backups" }

// The whole record is encrypted, including OAuth refresh state. None of this
// storage type is ever used as an HTTP response.
func (m *Manager) loadAutomation(ctx context.Context) (Automation, error) {
	return readAutomation(ctx, m.options.Database, m.options.Cipher)
}
func (m *Manager) saveAutomation(ctx context.Context, value Automation) error {
	return writeAutomation(ctx, m.options.Database, m.options.Cipher, value)
}
func readAutomation(ctx context.Context, database *repository.DB, cipher *appcrypto.Cipher) (Automation, error) {
	value := Automation{IntervalHours: 24, KeepLocal: 7, KeepRemote: 30, Destinations: []DestinationConfig{}}
	var ciphertext, nonce []byte
	err := database.SQL.QueryRowContext(ctx, `SELECT ciphertext,nonce FROM database_backup_automation WHERE id=1`).Scan(&ciphertext, &nonce)
	if errors.Is(err, sql.ErrNoRows) {
		return value, nil
	}
	if err != nil {
		return value, err
	}
	plain, err := cipher.Decrypt(ciphertext, nonce)
	if err != nil {
		return value, err
	}
	if err := json.Unmarshal(plain, &value); err != nil {
		return value, err
	}
	return value, nil
}
func writeAutomation(ctx context.Context, database *repository.DB, cipher *appcrypto.Cipher, value Automation) error {
	value.Destinations = slices.Clone(value.Destinations)
	for index := range value.Destinations {
		value.Destinations[index].AuthorizationID = ""
	}
	plain, err := json.Marshal(value)
	if err != nil {
		return err
	}
	if len(plain) > maxAutomationBytes {
		return ErrAutomationConfig
	}
	ciphertext, nonce, err := cipher.Encrypt(plain)
	if err != nil {
		return err
	}
	_, err = database.SQL.ExecContext(ctx, `INSERT INTO database_backup_automation(id,ciphertext,nonce) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET ciphertext=excluded.ciphertext,nonce=excluded.nonce`, ciphertext, nonce)
	return err
}
func (m *Manager) Automation(ctx context.Context) (Automation, error) {
	m.automationMu.Lock()
	defer m.automationMu.Unlock()
	return m.loadAutomation(ctx)
}
func (m *Manager) ConfigureAutomation(ctx context.Context, input Automation) error {
	m.automationMu.Lock()
	defer m.automationMu.Unlock()
	m.mutex.Lock()
	busy := m.isBusy || m.isClosed
	m.mutex.Unlock()
	if busy {
		return ErrBusy
	}
	previous, err := m.loadAutomation(ctx)
	if err != nil {
		return err
	}
	if input.IntervalHours < 1 || input.IntervalHours > 720 || input.KeepLocal < 1 || input.KeepLocal > 100 || input.KeepRemote < 1 || input.KeepRemote > 100 || len(input.Destinations) > 8 {
		return ErrAutomationConfig
	}
	if input.Passphrase == "" {
		input.Passphrase = previous.Passphrase
	}
	if input.Enabled || input.Passphrase != "" {
		if err := validatePassphrase(input.Passphrase); err != nil {
			return err
		}
	}
	ids := map[string]bool{}
	for index := range input.Destinations {
		d := &input.Destinations[index]
		if d.ID == "" {
			d.ID = newID()
		}
		options := map[string]string{}
		for _, old := range previous.Destinations {
			if old.ID == d.ID && old.Provider == d.Provider {
				options = maps.Clone(old.Options)
				break
			}
		}
		if options == nil {
			options = map[string]string{}
		}
		for key, value := range d.Options {
			if value != "" {
				options[key] = value
			}
		}
		if d.AuthorizationID != "" {
			authorized, err := m.oauthOptions(d.AuthorizationID, d.Provider)
			if err != nil {
				return err
			}
			for key, value := range authorized {
				options[key] = value
			}
		}
		d.Options = options

		if ids[d.ID] {
			return ErrDestinationConfig
		}
		ids[d.ID] = true
		if err := validateDestination(*d); err != nil {
			return err
		}
	}
	input.ID = previous.ID
	if input.ID == "" {
		input.ID = newID()
	}
	input.LastRunAtMS, input.LastSuccessAtMS, input.LastError = previous.LastRunAtMS, previous.LastSuccessAtMS, previous.LastError
	input.NextRunAtMS = previous.NextRunAtMS
	if input.Enabled && (!previous.Enabled || previous.IntervalHours != input.IntervalHours) {
		input.NextRunAtMS = time.Now().Add(time.Duration(input.IntervalHours) * time.Hour).UnixMilli()
	}
	if !input.Enabled {
		input.NextRunAtMS = 0
	}
	if err := m.audit(ctx, "automation.configure", input.ID, "admitted"); err != nil {
		return err
	}
	if err := m.saveAutomation(ctx, input); err != nil {
		return err
	}
	for _, destination := range input.Destinations {
		if destination.AuthorizationID != "" {
			m.CancelOAuth(destination.AuthorizationID)
		}
	}
	return nil
}

func (m *Manager) destination(ctx context.Context, c DestinationConfig) (Destination, error) {
	factory := m.options.DestinationFactory
	if factory == nil {
		factory = newRcloneDestination
	}
	return factory(ctx, c, func(values map[string]string) error {
		m.automationMu.Lock()
		defer m.automationMu.Unlock()
		current, err := m.loadAutomation(ctx)
		if err != nil {
			return err
		}
		for index := range current.Destinations {
			if current.Destinations[index].ID == c.ID {
				current.Destinations[index].Options = maps.Clone(values)
				return m.saveAutomation(ctx, current)
			}
		}
		return ErrNotFound
	})
}
func (m *Manager) configuredDestination(ctx context.Context, id string) (Destination, error) {
	value, err := m.Automation(ctx)
	if err != nil {
		return nil, err
	}
	for _, c := range value.Destinations {
		if c.ID == id {
			return m.destination(ctx, c)
		}
	}
	return nil, ErrNotFound
}
func (m *Manager) ProbeDestination(ctx context.Context, id string) error {
	if err := m.audit(ctx, "destination.probe", id, "admitted"); err != nil {
		return err
	}
	destination, err := m.configuredDestination(ctx, id)
	if err != nil {
		return err
	}
	defer destination.Close()
	return destination.Probe(ctx)
}

// One interval schedule and one existing backup worker do not need a cron or
// distributed-job subsystem. A persisted due time coalesces downtime into one run.
func (m *Manager) startAutomation() {
	m.workers.Add(1)
	go func() {
		defer m.workers.Done()
		m.automationTick(time.Now())
		ticker := time.NewTicker(time.Minute)
		defer ticker.Stop()
		for {
			select {
			case <-m.lifecycle.Done():
				return
			case now := <-ticker.C:
				m.automationTick(now)
			}
		}
	}()
}
func (m *Manager) automationTick(now time.Time) {
	if _, err := m.runAutomatic(now, true); err != nil && !errors.Is(err, ErrBusy) {
		m.options.Logger.Error("automatic database backup could not start", "error", publicError(err))
	}
}
func (m *Manager) RunAutomatic() (Job, error) { return m.runAutomatic(time.Now(), false) }
func (m *Manager) runAutomatic(now time.Time, onlyDue bool) (Job, error) {
	m.automationMu.Lock()
	defer m.automationMu.Unlock()
	value, err := m.loadAutomation(m.lifecycle)
	if err != nil {
		return Job{}, err
	}
	if onlyDue && (!value.Enabled || value.NextRunAtMS > now.UnixMilli()) {
		return Job{}, nil
	}
	if err := validatePassphrase(value.Passphrase); err != nil {
		return Job{}, err
	}
	job, err := m.reserve("automatic")
	if err != nil {
		return Job{}, err
	}
	if err := m.audit(m.lifecycle, "automation.run", job.ID, "admitted"); err != nil {
		m.failed(job, err)
		m.release()
		return Job{}, err
	}
	value.LastRunAtMS = now.UnixMilli()
	if value.Enabled {
		value.NextRunAtMS = now.Add(time.Duration(value.IntervalHours) * time.Hour).UnixMilli()
	}
	if err := m.saveAutomation(m.lifecycle, value); err != nil {
		m.failed(job, err)
		m.release()
		return Job{}, err
	}
	go func() {
		defer m.release()
		err := m.automaticBackup(job, value)
		if err != nil {
			m.failed(job, err)
		}
		m.automationMu.Lock()
		defer m.automationMu.Unlock()
		current, loadErr := m.loadAutomation(m.lifecycle)
		if loadErr == nil {
			current.LastError = ""
			if err != nil {
				current.LastError = publicError(err)
			} else {
				current.LastSuccessAtMS = time.Now().UnixMilli()
			}
			loadErr = m.saveAutomation(m.lifecycle, current)
		}
		if loadErr != nil {
			m.options.Logger.Error("persist automatic backup outcome", "job_id", job.ID, "error", publicError(loadErr))
		}
	}()
	return job, nil
}
func (m *Manager) automaticBackup(job Job, value Automation) error {
	if err := m.export(job, value.Passphrase); err != nil {
		return err
	}
	current, err := m.Get(job.ID)
	if err != nil {
		return err
	}
	current.State = "uploading"
	if err := m.save(current); err != nil {
		return err
	}
	key := fmt.Sprintf("omc-%s-%013d-%s.omcbackup", value.ID, job.CreatedAtMS, job.ID)
	if err := os.MkdirAll(m.archiveDirectory(), 0o700); err != nil {
		return err
	}
	path := filepath.Join(m.archiveDirectory(), key)
	if err := copyArtifact(m.lifecycle, filepath.Join(m.jobDirectory(job.ID), "backup.omcbackup"), path); err != nil {
		return err
	}
	// Automatic jobs retain metadata, not a second day's worth of export files.
	// Their download and recovery source is the independently retained archive.
	defer os.Remove(filepath.Join(m.jobDirectory(job.ID), "backup.omcbackup"))
	refs, err := m.ListArchives(m.lifecycle, "")
	if err != nil {
		return err
	}
	// A successful local snapshot bounds local disk use even during a cloud outage.
	if err := pruneArchives(refs, value.ID, value.KeepLocal, func(ref ObjectRef) error { return os.Remove(filepath.Join(m.archiveDirectory(), ref.Key)) }); err != nil {
		return err
	}
	var failures []error
	for _, config := range value.Destinations {
		destination, err := m.destination(m.lifecycle, config)
		if err == nil {
			source := artifactFile{path: path, size: current.SizeBytes, digest: current.Digest}
			_, err = destination.Put(m.lifecycle, ObjectRef{Key: key}, source)
			if err == nil {
				var page ObjectPage
				page, err = destination.List(m.lifecycle, "")
				if err == nil {
					err = pruneArchives(page.Items, value.ID, value.KeepRemote, func(ref ObjectRef) error { return destination.Delete(m.lifecycle, ref) })
				}
			}
			err = errors.Join(err, destination.Close())
		}
		if err != nil {
			failures = append(failures, err)
			m.options.Logger.Error("database backup destination failed", "job_id", job.ID, "destination_id", config.ID, "error", publicError(err))
		}
	}
	if err := errors.Join(failures...); err != nil {
		return err
	}
	current.State = "ready"
	return m.save(current)
}

type artifactFile struct {
	path   string
	size   int64
	digest string
}

func (f artifactFile) Size() int64    { return f.size }
func (f artifactFile) SHA256() string { return f.digest }
func (f artifactFile) Open(ctx context.Context, offset int64) (io.ReadCloser, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	file, err := os.Open(f.path)
	if err != nil {
		return nil, err
	}
	if _, err := file.Seek(offset, io.SeekStart); err != nil {
		file.Close()
		return nil, err
	}
	return file, nil
}

var archivePattern = regexp.MustCompile(`^omc-([a-f0-9-]{36})-([0-9]{13})-([a-f0-9-]{36})\.omcbackup$`)

func validArchiveKey(key string) bool {
	parts := archivePattern.FindStringSubmatch(key)
	return len(parts) == 4 && validID(parts[1]) && validID(parts[3])
}
func ArchiveCreatedAtMS(key string) int64 {
	parts := archivePattern.FindStringSubmatch(key)
	if len(parts) != 4 {
		return 0
	}
	value, _ := strconv.ParseInt(parts[2], 10, 64)
	return value
}
func pruneArchives(items []ObjectRef, namespace string, keep int, remove func(ObjectRef) error) error {
	owned := []ObjectRef{}
	for _, item := range items {
		if validArchiveKey(item.Key) && strings.HasPrefix(item.Key, "omc-"+namespace+"-") {
			owned = append(owned, item)
		}
	}
	slices.SortFunc(owned, func(a, b ObjectRef) int { return strings.Compare(b.Key, a.Key) })
	for _, item := range owned[min(keep, len(owned)):] {
		if err := remove(item); err != nil {
			return err
		}
	}
	return nil
}
func (m *Manager) ListArchives(ctx context.Context, destinationID string) ([]ObjectRef, error) {
	if destinationID != "" {
		destination, err := m.configuredDestination(ctx, destinationID)
		if err != nil {
			return nil, err
		}
		defer destination.Close()
		page, err := destination.List(ctx, "")
		return page.Items, err
	}
	entries, err := os.ReadDir(m.archiveDirectory())
	if errors.Is(err, os.ErrNotExist) {
		return []ObjectRef{}, nil
	}
	if err != nil {
		return nil, err
	}
	items := []ObjectRef{}
	for _, entry := range entries {
		if entry.Type().IsRegular() && validArchiveKey(entry.Name()) {
			info, err := entry.Info()
			if err != nil {
				return nil, err
			}
			items = append(items, ObjectRef{Key: entry.Name(), SizeBytes: info.Size()})
		}
	}
	return items, nil
}
func (m *Manager) OpenArchive(ctx context.Context, key string) (io.ReadCloser, error) {
	if !validArchiveKey(key) {
		return nil, ErrNotFound
	}
	if err := m.audit(ctx, "archive.download", key, "admitted"); err != nil {
		return nil, err
	}
	file, err := os.Open(filepath.Join(m.archiveDirectory(), key))
	if errors.Is(err, os.ErrNotExist) {
		return nil, ErrNotFound
	}
	return file, err
}
func (m *Manager) StageArchive(ctx context.Context, destinationID, key, passphrase string) (Job, error) {
	if !validArchiveKey(key) {
		return Job{}, ErrNotFound
	}
	if err := m.audit(ctx, "archive.inspect", key, "admitted"); err != nil {
		return Job{}, err
	}
	var input io.ReadCloser
	var err error
	if destinationID == "" {
		input, err = os.Open(filepath.Join(m.archiveDirectory(), key))
	} else {
		var destination Destination
		destination, err = m.configuredDestination(ctx, destinationID)
		if err != nil {
			return Job{}, err
		}
		defer destination.Close()
		input, err = destination.Open(ctx, ObjectRef{Key: key})
	}
	if errors.Is(err, os.ErrNotExist) {
		return Job{}, ErrNotFound
	}
	if err != nil {
		return Job{}, err
	}
	defer input.Close()
	return m.StageImport(ctx, input, passphrase)
}
func copyArtifact(ctx context.Context, source, destination string) error {
	input, err := os.Open(source)
	if err != nil {
		return err
	}
	defer input.Close()
	output, err := os.OpenFile(destination, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	_, copyErr := io.Copy(output, contextReader{ctx, input})
	err = errors.Join(copyErr, output.Sync(), output.Close())
	if err != nil {
		os.Remove(destination)
	}
	return err
}

// A recovery drill must not start a restored schedule against the source host's
// retention namespace. Keep its credentials, but require an explicit re-enable.
func resetRestoredAutomation(ctx context.Context, database *repository.DB, cipher *appcrypto.Cipher) error {
	value, err := readAutomation(ctx, database, cipher)
	if err != nil {
		return err
	}
	if value.ID == "" {
		return nil
	}
	value.ID = newID()
	value.Enabled = false
	value.NextRunAtMS = 0
	value.LastRunAtMS = 0
	value.LastSuccessAtMS = 0
	value.LastError = ""
	return writeAutomation(ctx, database, cipher, value)
}
