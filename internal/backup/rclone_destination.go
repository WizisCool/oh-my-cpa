package backup

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"log/slog"
	"maps"
	"slices"
	"strings"
	"sync"
	"time"

	_ "github.com/rclone/rclone/backend/drive"
	_ "github.com/rclone/rclone/backend/ftp"
	_ "github.com/rclone/rclone/backend/onedrive"
	_ "github.com/rclone/rclone/backend/s3"
	_ "github.com/rclone/rclone/backend/sftp"
	_ "github.com/rclone/rclone/backend/smb"
	_ "github.com/rclone/rclone/backend/webdav"
	"github.com/rclone/rclone/fs"
	"github.com/rclone/rclone/fs/config/configmap"
	"github.com/rclone/rclone/fs/config/obscure"
	"github.com/rclone/rclone/fs/object"
)

var (
	ErrDestinationConfig     = errors.New("backup destination configuration is invalid")
	ErrDestinationFailed     = errors.New("backup destination operation failed")
	ErrCredentialPersistence = errors.New("backup destination credentials could not be saved")
)

// Options are secret input. Only handwritten destination summaries may leave the
// backup subsystem; rclone's configuration structs are not response DTOs.
type DestinationConfig struct {
	ID              string            `json:"id"`
	AuthorizationID string            `json:"authorization_id,omitempty"`
	Name            string            `json:"name"`
	Provider        string            `json:"provider"`
	Root            string            `json:"root"`
	Options         map[string]string `json:"options"`
}

// Keep the transport surface smaller than rclone's configurator: in particular,
// no command hooks, external ssh commands, credential files or arbitrary backends.
var destinationOptions = map[string][]string{
	"s3":       {"provider", "access_key_id", "secret_access_key", "session_token", "region", "endpoint", "force_path_style"},
	"webdav":   {"url", "vendor", "user", "pass", "bearer_token"},
	"sftp":     {"host", "user", "port", "pass", "key_pem", "key_file_pass", "host_keys"},
	"smb":      {"host", "user", "port", "pass", "domain"},
	"ftp":      {"host", "user", "port", "pass", "tls", "explicit_tls"},
	"drive":    {"client_id", "client_secret", "token", "scope", "root_folder_id", "team_drive"},
	"onedrive": {"client_id", "client_secret", "token", "drive_id", "drive_type", "region"},
}

func validateDestination(c DestinationConfig) error {
	keys, ok := destinationOptions[c.Provider]
	if !ok || !validID(c.ID) || strings.TrimSpace(c.Name) == "" || len(c.Name) > 100 || len(c.Root) > 1024 || strings.ContainsAny(c.Root, "\x00\r\n") || len(c.Options) > len(keys) {
		return ErrDestinationConfig
	}
	for key, value := range c.Options {
		if !slices.Contains(keys, key) || len(value) > 32<<10 {
			return ErrDestinationConfig
		}
	}
	if c.Provider == "sftp" && c.Options["host_keys"] == "" {
		return ErrDestinationConfig
	}
	return nil
}

type destinationMapper struct {
	mutex   sync.Mutex
	values  configmap.Simple
	persist func(map[string]string) error
	err     error
}

func (m *destinationMapper) Get(key string) (string, bool) {
	m.mutex.Lock()
	defer m.mutex.Unlock()
	value, ok := m.values[key]
	return value, ok
}
func (m *destinationMapper) Set(key, value string) {
	m.mutex.Lock()
	defer m.mutex.Unlock()
	m.values[key] = value
	if m.persist != nil && m.persist(maps.Clone(m.values)) != nil {
		m.err = ErrCredentialPersistence
	}
}
func (m *destinationMapper) error() error { m.mutex.Lock(); defer m.mutex.Unlock(); return m.err }

type rcloneDestination struct {
	remote fs.Fs
	mapper *destinationMapper
}

var rcloneLogging sync.Once

func newRcloneDestination(ctx context.Context, c DestinationConfig, persist func(map[string]string) error) (Destination, error) {
	if err := validateDestination(c); err != nil {
		return nil, err
	}
	// Backend diagnostics can contain URLs and provider response bodies. OMC emits
	// its own operation/id/result diagnostics, never the native error or config.
	rcloneLogging.Do(func() { fs.SetLogger(slog.NewTextHandler(io.Discard, nil)) })
	info, err := fs.Find(c.Provider)
	if err != nil {
		return nil, ErrDestinationConfig
	}
	mapper := &destinationMapper{values: maps.Clone(c.Options)}
	if mapper.values == nil {
		mapper.values = configmap.Simple{}
	}
	defaults := configmap.Simple{}
	for _, option := range info.Options {
		defaults[option.Name] = option.String()
	}
	// This adapter uses byte read-back rather than remote shell/hash commands.
	if c.Provider == "sftp" {
		defaults["shell_type"] = "none"
		defaults["disable_hashcheck"] = "true"
	}
	// Password fields in OMC's encrypted record are plaintext to the backend.
	// Obscuring here is rclone's wire convention, not at-rest encryption.
	passwords := map[string]bool{}
	for _, option := range info.Options {
		if option.IsPassword {
			passwords[option.Name] = true
		}
	}
	encoded := &passwordMapper{mapper: mapper, passwords: passwords}
	cm := configmap.New().AddGetter(encoded, configmap.PriorityNormal).AddGetter(defaults, configmap.PriorityDefault).AddSetter(encoded)
	mapper.persist = persist
	remote, err := info.NewFs(ctx, "omc-"+c.ID, c.Root, cm)
	if err != nil {
		return nil, destinationError(ctx, err)
	}
	destination := &rcloneDestination{remote: remote, mapper: mapper}
	if err := mapper.error(); err != nil {
		destination.Close()
		return nil, err
	}
	return destination, nil
}

type passwordMapper struct {
	mapper    *destinationMapper
	passwords map[string]bool
}

func (m *passwordMapper) Get(key string) (string, bool) {
	value, ok := m.mapper.Get(key)
	if ok && value != "" && m.passwords[key] {
		value = obscure.MustObscure(value)
	}
	return value, ok
}
func (m *passwordMapper) Set(key, value string) {
	if value != "" && m.passwords[key] {
		plain, err := obscure.Reveal(value)
		if err != nil {
			m.mapper.mutex.Lock()
			m.mapper.err = ErrCredentialPersistence
			m.mapper.mutex.Unlock()
			return
		}
		value = plain
	}
	m.mapper.Set(key, value)
}
func destinationError(ctx context.Context, err error) error {
	if err == nil {
		return nil
	}
	if ctx.Err() != nil {
		return ctx.Err()
	}
	return ErrDestinationFailed
}
func (d *rcloneDestination) Probe(ctx context.Context) error {
	_, err := d.remote.List(ctx, "")
	if errors.Is(err, fs.ErrorDirNotFound) {
		return d.mapper.error()
	}
	return errors.Join(destinationError(ctx, err), d.mapper.error())
}
func (d *rcloneDestination) Put(ctx context.Context, ref ObjectRef, source ArtifactSource) (Receipt, error) {
	if !validArchiveKey(ref.Key) {
		return Receipt{}, ErrDestinationConfig
	}
	input, err := source.Open(ctx, 0)
	if err != nil {
		return Receipt{}, err
	}
	defer input.Close()
	_, err = d.remote.Put(ctx, contextReader{ctx, input}, object.NewStaticObjectInfo(ref.Key, time.Now(), source.Size(), true, nil, d.remote))
	if err != nil {
		return Receipt{}, destinationError(ctx, err)
	}
	if err := d.mapper.error(); err != nil {
		return Receipt{}, err
	}
	// A full read-back is portable across backends without comparable hashes.
	// Retention only runs after the encrypted bytes match the local artifact.
	readback, err := d.Open(ctx, ref)
	if err != nil {
		return Receipt{}, err
	}
	hash := sha256.New()
	size, readErr := io.Copy(hash, io.LimitReader(contextReader{ctx, readback}, source.Size()+1))
	err = errors.Join(readErr, readback.Close())
	if err != nil {
		return Receipt{}, destinationError(ctx, err)
	}
	checksum := hex.EncodeToString(hash.Sum(nil))
	if size != source.Size() || checksum != source.SHA256() {
		return Receipt{}, ErrInvalidArtifact
	}
	return Receipt{Object: ref, Size: size, Checksum: checksum, Verification: "sha256-readback"}, d.mapper.error()
}
func (d *rcloneDestination) Open(ctx context.Context, ref ObjectRef) (io.ReadCloser, error) {
	if !validArchiveKey(ref.Key) {
		return nil, ErrNotFound
	}
	obj, err := d.remote.NewObject(ctx, ref.Key)
	if errors.Is(err, fs.ErrorObjectNotFound) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, destinationError(ctx, err)
	}
	if obj.Size() > MaxUploadBytes {
		return nil, ErrInvalidArtifact
	}
	reader, err := obj.Open(ctx)
	if err != nil {
		return nil, destinationError(ctx, err)
	}
	if err := d.mapper.error(); err != nil {
		reader.Close()
		return nil, err
	}
	return reader, nil
}
func (d *rcloneDestination) List(ctx context.Context, cursor string) (ObjectPage, error) {
	if cursor != "" {
		return ObjectPage{}, ErrDestinationConfig
	}
	entries, err := d.remote.List(ctx, "")
	if errors.Is(err, fs.ErrorDirNotFound) {
		return ObjectPage{Items: []ObjectRef{}}, d.mapper.error()
	}
	if err != nil {
		return ObjectPage{}, destinationError(ctx, err)
	}
	items := []ObjectRef{}
	for _, entry := range entries {
		if _, ok := entry.(fs.Object); ok && validArchiveKey(entry.Remote()) {
			items = append(items, ObjectRef{Key: entry.Remote(), SizeBytes: entry.Size()})
		}
	}
	return ObjectPage{Items: items}, d.mapper.error()
}
func (d *rcloneDestination) Delete(ctx context.Context, ref ObjectRef) error {
	if !validArchiveKey(ref.Key) {
		return ErrNotFound
	}
	obj, err := d.remote.NewObject(ctx, ref.Key)
	if err != nil {
		return destinationError(ctx, err)
	}
	return errors.Join(destinationError(ctx, obj.Remove(ctx)), d.mapper.error())
}
func (d *rcloneDestination) Capabilities() Capabilities { return Capabilities{} }
func (d *rcloneDestination) Close() error {
	if shutdown := d.remote.Features().Shutdown; shutdown != nil {
		return destinationError(context.Background(), shutdown(context.Background()))
	}
	return nil
}
