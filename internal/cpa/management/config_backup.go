package management

import (
	"context"
	"errors"
	"fmt"

	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/configyaml"
)

// ConfigBackup keeps the stored configuration file before the first v8
// configuration write rewrites it.
//
// That write is not reversible from CPA: it reformats the whole file, moves every
// setting, adds defaults and turns sections CPA does not know into comments. The
// file as it was is only readable before the write, so the copy has to be taken
// then, and a write that cannot be preceded by one is refused.
type ConfigBackup interface {
	KeepLegacyConfig(ctx context.Context, baseURL, storedYAML string) error
}

// ErrConfigBackupUnavailable refuses a v8 configuration write to a legacy file
// when no backup could be kept first.
var ErrConfigBackupUnavailable = errors.New("the CPA configuration file is in the pre-v8 layout and no backup store is available; refusing to convert it")

// WithConfigBackup sets where a legacy file is kept before it is migrated.
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
		// not yet migrated: keeping a copy costs nothing.
		return false, stored, nil
	}
	return isV8, stored, nil
}

// keepLegacyConfig reads the stored file before every v8 write rather than
// remembering that it was v8: an operator can put a legacy file back at any
// time, and converting that one without a copy is the loss this guards against.
// A converted file costs one read per write.
func (c *Client) keepLegacyConfig(ctx context.Context) error {
	isV8, stored, err := c.IsStoredConfigV8(ctx)
	if err != nil {
		return fmt.Errorf("read the stored configuration before converting it: %w", err)
	}
	if isV8 {
		return nil
	}
	if c.configBackup == nil {
		return ErrConfigBackupUnavailable
	}
	if err := c.configBackup.KeepLegacyConfig(ctx, c.baseURL, stored); err != nil {
		return fmt.Errorf("%w: %v", ErrConfigBackupUnavailable, err)
	}
	return nil
}
