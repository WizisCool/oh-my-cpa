package management

import (
	"context"
	"errors"
	"fmt"

	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/configyaml"
)

// ConfigBackup keeps the stored configuration file before every write after
// which CPA saves it, so each operation can be undone.
//
// The copy is the file as stored, read just before the write: that is the only
// moment the state the operation replaces is readable, and it also captures an
// edit made outside Oh My CPA since the last write. The first v8 write to a
// pre-v8 file is not reversible from CPA at all (it reformats the whole file,
// moves every setting and turns sections CPA does not know into comments), so a
// write whose copy cannot be kept is refused.
type ConfigBackup interface {
	KeepConfig(ctx context.Context, snapshot ConfigSnapshot) error
}

// ConfigSnapshot is the stored file as it was before one write.
type ConfigSnapshot struct {
	BaseURL string
	YAML    string
	IsV8    bool
	Reason  string
}

// The kind of write a snapshot was taken before. The console names each one,
// so a new writer adds its own reason rather than reusing another's.
const (
	BackupReasonConfigChanges    = "config_changes"
	BackupReasonConfigSource     = "config_source"
	BackupReasonProviderKeys     = "provider_keys"
	BackupReasonClientKeys       = "client_keys"
	BackupReasonOAuthAliases     = "oauth_aliases"
	BackupReasonPluginSettings   = "plugin_settings"
	BackupReasonPluginInstall    = "plugin_install"
	BackupReasonPluginDelete     = "plugin_delete"
	BackupReasonCredentialStatus = "credential_status"
	BackupReasonRestore          = "restore"
	BackupReasonManual           = "manual"
)

type backupReasonKey struct{}

// WithBackupReason names the operation a write belongs to. The outermost name
// wins, so a caller composing several client methods (a restore replacing the
// whole document) labels the copy as its own operation, not as the method it
// happens to call.
func WithBackupReason(ctx context.Context, reason string) context.Context {
	if _, ok := ctx.Value(backupReasonKey{}).(string); ok {
		return ctx
	}
	return context.WithValue(ctx, backupReasonKey{}, reason)
}

func backupReason(ctx context.Context) string {
	reason, _ := ctx.Value(backupReasonKey{}).(string)
	return reason
}

// ErrConfigBackupUnavailable refuses a configuration write when the stored file
// could not be kept first.
var ErrConfigBackupUnavailable = errors.New("the CPA configuration file could not be backed up; refusing to write it")

// WithConfigBackup sets where the stored file is kept before each write.
func (c *Client) WithConfigBackup(backup ConfigBackup) *Client {
	if c != nil {
		c.configBackup = backup
	}
	return c
}

// IsStoredConfigV8 reports whether the stored file is already in the v8 layout,
// which decides whether the next configuration write converts it.
func (c *Client) IsStoredConfigV8(ctx context.Context) (bool, string, error) {
	stored, err := c.StoredConfigYAML(ctx)
	if err != nil {
		return false, "", err
	}
	isV8, err := configyaml.IsV8Document(stored)
	if err != nil {
		// CPA would not have loaded a file it cannot parse, so it is treated as
		// not yet migrated: it cannot be written back through the v8 API.
		return false, stored, nil
	}
	return isV8, stored, nil
}

// keepStoredConfig reads the stored file before every write rather than
// trusting an earlier copy: an operator can change the file at any time, and
// that version is exactly what the write is about to replace. It returns the
// document it read, so a write can scrub that document's secrets from CPA's
// refusal.
//
// Without a store a v8 file is written uncopied, since nothing CPA does to it
// is irreversible; a pre-v8 file is not, because its conversion is.
func (c *Client) keepStoredConfig(ctx context.Context) (string, error) {
	isV8, stored, err := c.IsStoredConfigV8(ctx)
	if err != nil {
		return "", fmt.Errorf("read the stored configuration before writing it: %w", err)
	}
	if c.configBackup == nil {
		if isV8 {
			return stored, nil
		}
		return "", fmt.Errorf("%w: the file is in the pre-v8 layout and no backup store is available", ErrConfigBackupUnavailable)
	}
	reason := backupReason(ctx)
	if reason == "" {
		reason = BackupReasonConfigChanges
	}
	if err := c.configBackup.KeepConfig(ctx, ConfigSnapshot{BaseURL: c.baseURL, YAML: stored, IsV8: isV8, Reason: reason}); err != nil {
		return "", fmt.Errorf("%w: %v", ErrConfigBackupUnavailable, err)
	}
	return stored, nil
}
