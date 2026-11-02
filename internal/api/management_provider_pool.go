package api

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/management"
)

// ProviderConnectionPoolSettingsDTO projects only known non-secret pool fields,
// never native wire extras.
type ProviderConnectionPoolSettingsDTO struct {
	Enabled             *bool   `json:"enabled,omitempty"`
	IdleConnTimeout     *string `json:"idle_conn_timeout,omitempty"`
	MaxIdleConnsPerHost *int    `json:"max_idle_conns_per_host,omitempty"`
}

type ProviderConnectionPoolGroupDTO struct {
	GroupName string                             `json:"group_name,omitempty"`
	GroupSize int                                `json:"group_size"`
	Defaults  *ProviderConnectionPoolSettingsDTO `json:"defaults"`
}

func providerPoolSettingsDTO(pool *management.ConnectionPoolConfig) *ProviderConnectionPoolSettingsDTO {
	if pool == nil {
		return nil
	}
	return &ProviderConnectionPoolSettingsDTO{Enabled: pool.Enabled, IdleConnTimeout: pool.IdleConnTimeout, MaxIdleConnsPerHost: pool.MaxIdleConnsPerHost}
}

func providerPoolGroupDTO(name string, size int, defaults *management.ConnectionPoolConfig) *ProviderConnectionPoolGroupDTO {
	return &ProviderConnectionPoolGroupDTO{GroupName: name, GroupSize: size, Defaults: providerPoolSettingsDTO(defaults)}
}

// The outer field's absence means keep; null removes the block; {} opts in.
// Subfields describe this layer only, so omission/null inherits the group.
func parseProviderPoolEdit(raw json.RawMessage) (*management.ConnectionPoolConfig, bool, error) {
	if len(raw) == 0 {
		return nil, false, nil
	}
	if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return nil, true, nil
	}
	var settings ProviderConnectionPoolSettingsDTO
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&settings); err != nil {
		return nil, false, newProviderWriteErrorWithCode(http.StatusBadRequest, "invalid connection pool settings", "provider_connection_pool_invalid")
	}
	if timeout := settings.IdleConnTimeout; timeout != nil {
		if len(*timeout) > 128 {
			return nil, false, newProviderWriteErrorWithCode(http.StatusBadRequest, "connection pool timeout is too long", "provider_connection_pool_invalid")
		}
		value := strings.TrimSpace(*timeout)
		settings.IdleConnTimeout = &value
		if value != "" {
			if _, err := time.ParseDuration(value); err != nil {
				return nil, false, newProviderWriteErrorWithCode(http.StatusBadRequest, "connection pool timeout must be a duration", "provider_connection_pool_invalid")
			}
		}
	}
	return &management.ConnectionPoolConfig{Enabled: settings.Enabled, IdleConnTimeout: settings.IdleConnTimeout, MaxIdleConnsPerHost: settings.MaxIdleConnsPerHost}, true, nil
}

func validateProviderPoolEdits(req SaveProviderRequest) error {
	if _, _, err := parseProviderPoolEdit(req.ConnectionPool); err != nil {
		return err
	}
	for _, key := range req.Keys {
		if _, _, err := parseProviderPoolEdit(key.ConnectionPool); err != nil {
			return err
		}
	}
	return nil
}

func applyConfigKeyPoolEdits(entry *management.ConfigAPIKey, group, key json.RawMessage) error {
	for _, edit := range []struct {
		isGroup bool
		raw     json.RawMessage
	}{{true, group}, {false, key}} {
		pool, isSet, err := parseProviderPoolEdit(edit.raw)
		if err != nil {
			return err
		}
		if isSet {
			if err := entry.EditConnectionPool(edit.isGroup, pool); err != nil {
				return fmt.Errorf("edit connection pool: %w", err)
			}
		}
	}
	return nil
}

func applyProviderPoolEdit(current **management.ConnectionPoolConfig, raw json.RawMessage) error {
	pool, isSet, err := parseProviderPoolEdit(raw)
	if err == nil && isSet {
		*current = management.ReplaceConnectionPoolSettings(*current, pool)
	}
	return err
}
