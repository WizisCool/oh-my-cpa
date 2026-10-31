package management

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"

	"gopkg.in/yaml.v3"
)

var ErrPluginMutationConflict = errors.New("plugin mutation completed but conflicting configuration changes were detected; stop and inspect before retrying")

// Plugin mutations have no upstream CAS. A preflight catches a known concurrent
// writer; readback detects changes outside the named plugin. Neither is a claim
// of atomicity against external CPA panels, especially same-plugin writers.
func (c *Client) pluginMutationPreflight(ctx context.Context, reason string) (string, error) {
	if c == nil || c.configBackup == nil {
		return "", ErrConfigBackupUnavailable
	}
	before, err := c.keepStoredConfig(WithBackupReason(ctx, reason))
	if err != nil {
		return "", err
	}
	current, err := c.StoredConfigYAML(ctx)
	if err != nil {
		return "", err
	}
	if before != current {
		return "", ErrConfigChanged
	}
	// The v8 file view is normalized by layout, not by runtime defaults. The
	// native runtime configuration is the authoritative effective snapshot:
	// store saves may materialize defaults already effective before the write.
	return c.pluginRuntimeConfigSnapshot(ctx)
}
func (c *Client) pluginMutationReadback(ctx context.Context, before, id string) error {
	after, err := c.pluginRuntimeConfigSnapshot(ctx)
	if err != nil {
		return ErrPluginMutationConflict
	}
	var previous, current map[string]any
	if yaml.Unmarshal([]byte(before), &previous) != nil || yaml.Unmarshal([]byte(after), &current) != nil {
		return ErrPluginMutationConflict
	}
	removePlugin := func(config map[string]any) {
		plugins, ok := config["plugins"].(map[string]any)
		if !ok {
			return
		}
		configs, ok := plugins["configs"].(map[string]any)
		if !ok {
			return
		}
		delete(configs, id)
		if len(configs) == 0 {
			delete(plugins, "configs")
		}
	}
	removePlugin(previous)
	removePlugin(current)
	if !reflect.DeepEqual(previous, current) {
		return ErrPluginMutationConflict
	}
	return nil
}

// WithPluginExecutionGuard revalidates an automatically queued operation after
// backup/preflight and immediately before dispatch to CPA's non-CAS installer.
func (c *Client) WithPluginExecutionGuard(guard func(context.Context) error) *Client {
	c.pluginExecutionGuard = guard
	return c
}

func (c *Client) pluginRuntimeConfigSnapshot(ctx context.Context) (string, error) {
	var snapshot map[string]any
	if _, err := c.getV0JSON(ctx, "/config", &snapshot); err != nil {
		return "", err
	}
	raw, err := json.Marshal(snapshot)
	return string(raw), err
}
