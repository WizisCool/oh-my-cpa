package management

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
)

// PluginConfigField is one setting a plugin declares in its manifest. CPA only
// describes the field; the value lives in `plugins.configs.<id>`.
type PluginConfigField struct {
	Name        string   `json:"name"`
	Type        string   `json:"type"`
	EnumValues  []string `json:"enum_values,omitempty"`
	Description string   `json:"description,omitempty"`
}

type PluginMetadata struct {
	Name             string              `json:"name,omitempty"`
	Version          string              `json:"version,omitempty"`
	Author           string              `json:"author,omitempty"`
	GitHubRepository string              `json:"github_repository,omitempty"`
	Logo             string              `json:"logo,omitempty"`
	ConfigFields     []PluginConfigField `json:"config_fields,omitempty"`
}

// PluginItem is one entry of CPA's `GET /plugins`: a plugin file discovered on
// disk, configured in `plugins.configs`, registered with the running host, or
// any combination of the three.
type PluginItem struct {
	ID               string              `json:"id"`
	Path             string              `json:"path,omitempty"`
	Configured       bool                `json:"configured,omitempty"`
	Registered       bool                `json:"registered,omitempty"`
	Enabled          bool                `json:"enabled"`
	EffectiveEnabled bool                `json:"effective_enabled,omitempty"`
	SupportsOAuth    bool                `json:"supports_oauth,omitempty"`
	OAuthProvider    string              `json:"oauth_provider,omitempty"`
	SupportsQuota    bool                `json:"supports_quota,omitempty"`
	Logo             string              `json:"logo,omitempty"`
	ConfigFields     []PluginConfigField `json:"config_fields,omitempty"`
	Metadata         *PluginMetadata     `json:"metadata,omitempty"`
}

// DisplayName is the name the plugin registered, or its id when it registered none.
func (p PluginItem) DisplayName() string {
	if p.Metadata != nil && strings.TrimSpace(p.Metadata.Name) != "" {
		return strings.TrimSpace(p.Metadata.Name)
	}
	return p.ID
}

// DisplayVersion is the version the plugin registered; an unregistered file has none.
func (p PluginItem) DisplayVersion() string {
	if p.Metadata == nil {
		return ""
	}
	return strings.TrimSpace(p.Metadata.Version)
}

// PluginList is CPA's installed-plugin document: the global switch and plugin
// directory come with the entries because every entry's effective state
// depends on the switch.
type PluginList struct {
	PluginsEnabled bool         `json:"plugins_enabled"`
	PluginsDir     string       `json:"plugins_dir"`
	Plugins        []PluginItem `json:"plugins"`
}

type PluginStoreSource struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	URL  string `json:"url"`
}

type PluginStoreSourceError struct {
	SourceID   string `json:"source_id"`
	SourceName string `json:"source_name"`
	SourceURL  string `json:"source_url"`
	Message    string `json:"message"`
}

type PluginStorePlatform struct {
	GOOS   string `json:"goos"`
	GOARCH string `json:"goarch"`
}

// StorePluginItem is one catalog entry of CPA's `GET /plugin-store`, joined by
// CPA with the local install state of the plugin it describes.
type StorePluginItem struct {
	StoreID             string                `json:"store_id"`
	SourceID            string                `json:"source_id"`
	SourceName          string                `json:"source_name"`
	SourceURL           string                `json:"source_url"`
	ID                  string                `json:"id"`
	Name                string                `json:"name"`
	Description         string                `json:"description"`
	Author              string                `json:"author"`
	Version             string                `json:"version"`
	Repository          string                `json:"repository"`
	InstallType         string                `json:"install_type"`
	AuthRequired        bool                  `json:"auth_required"`
	AuthConfigured      bool                  `json:"auth_configured"`
	Platforms           []PluginStorePlatform `json:"platforms,omitempty"`
	Logo                string                `json:"logo,omitempty"`
	Homepage            string                `json:"homepage,omitempty"`
	License             string                `json:"license,omitempty"`
	Tags                []string              `json:"tags,omitempty"`
	Installed           bool                  `json:"installed"`
	InstalledVersion    string                `json:"installed_version"`
	InstalledSourceID   string                `json:"installed_source_id,omitempty"`
	InstallSourceStatus string                `json:"install_source_status,omitempty"`
	Configured          bool                  `json:"configured"`
	Registered          bool                  `json:"registered"`
	Enabled             bool                  `json:"enabled"`
	EffectiveEnabled    bool                  `json:"effective_enabled"`
	UpdateAvailable     bool                  `json:"update_available"`
}

type PluginStore struct {
	PluginsEnabled bool                     `json:"plugins_enabled"`
	PluginsDir     string                   `json:"plugins_dir"`
	Sources        []PluginStoreSource      `json:"sources"`
	SourceErrors   []PluginStoreSourceError `json:"source_errors"`
	Plugins        []StorePluginItem        `json:"plugins"`
}

type PluginInstallResult struct {
	Status          string `json:"status"`
	SourceID        string `json:"source_id"`
	SourceName      string `json:"source_name"`
	ID              string `json:"id"`
	Version         string `json:"version"`
	InstallType     string `json:"install_type"`
	PluginsEnabled  bool   `json:"plugins_enabled"`
	RestartRequired bool   `json:"restart_required"`
}

type PluginDeleteResult struct {
	Status            string `json:"status"`
	ID                string `json:"id"`
	FileDeleted       bool   `json:"file_deleted"`
	ConfiguredRemoved bool   `json:"configured_removed"`
	RestartRequired   bool   `json:"restart_required"`
}

// PluginList reads the installed-plugin document. A bare array is still
// accepted, since it carries the same entries without the global state.
func (c *Client) PluginList(ctx context.Context) (PluginList, error) {
	var raw json.RawMessage
	if err := c.DoJSON(ctx, http.MethodGet, "/plugins", &raw); err != nil {
		return PluginList{}, err
	}
	result := PluginList{Plugins: []PluginItem{}}
	if len(raw) == 0 {
		return result, nil
	}
	var list []PluginItem
	if err := json.Unmarshal(raw, &list); err == nil {
		result.Plugins = list
		return result, nil
	}
	if err := json.Unmarshal(raw, &result); err != nil {
		return PluginList{}, fmt.Errorf("decode CPA plugin list: %w", err)
	}
	if result.Plugins == nil {
		result.Plugins = []PluginItem{}
	}
	return result, nil
}

// Plugins returns only the installed entries.
func (c *Client) Plugins(ctx context.Context) ([]PluginItem, error) {
	list, err := c.PluginList(ctx)
	if err != nil {
		return nil, err
	}
	return list.Plugins, nil
}

func pluginEndpoint(id, suffix string) (string, error) {
	id = strings.TrimSpace(id)
	if id == "" {
		return "", errors.New("plugin id is required")
	}
	return "/plugins/" + url.PathEscape(id) + suffix, nil
}

// SetPluginEnabled writes `plugins.configs.<id>.enabled`; it never touches the
// global `plugins.enabled` switch.
func (c *Client) SetPluginEnabled(ctx context.Context, id string, enabled bool) error {
	endpoint, err := pluginEndpoint(id, "/enabled")
	if err != nil {
		return err
	}
	_, err = c.doV0JSON(ctx, http.MethodPatch, endpoint, map[string]any{"enabled": enabled}, nil)
	return err
}

// PluginConfig reads `plugins.configs.<id>` as a JSON object. A plugin that is
// discovered or registered but not yet configured answers with an empty object.
func (c *Client) PluginConfig(ctx context.Context, id string) (map[string]any, error) {
	endpoint, err := pluginEndpoint(id, "/config")
	if err != nil {
		return nil, err
	}
	var config map[string]any
	if _, err := c.doV0JSON(ctx, http.MethodGet, endpoint, nil, &config); err != nil {
		return nil, err
	}
	if config == nil {
		config = map[string]any{}
	}
	return config, nil
}

// SetPluginConfig replaces `plugins.configs.<id>` with the given object.
func (c *Client) SetPluginConfig(ctx context.Context, id string, config map[string]any) error {
	endpoint, err := pluginEndpoint(id, "/config")
	if err != nil {
		return err
	}
	_, err = c.doV0JSON(ctx, http.MethodPut, endpoint, config, nil)
	return err
}

// DeletePlugin removes a plugin. CPA saves the configuration file in the v8
// layout when the plugin had settings there, so a legacy file is kept first.
func (c *Client) DeletePlugin(ctx context.Context, id string) (PluginDeleteResult, error) {
	endpoint, err := pluginEndpoint(id, "")
	if err != nil {
		return PluginDeleteResult{}, err
	}
	if err := c.keepLegacyConfig(ctx); err != nil {
		return PluginDeleteResult{}, err
	}
	var result PluginDeleteResult
	if err := c.DoJSON(ctx, http.MethodDelete, endpoint, &result); err != nil {
		return PluginDeleteResult{}, err
	}
	return result, nil
}

func (c *Client) PluginStore(ctx context.Context) (PluginStore, error) {
	var raw json.RawMessage
	if err := c.DoJSON(ctx, http.MethodGet, "/plugins/store", &raw); err != nil {
		return PluginStore{}, err
	}
	result := PluginStore{}
	if len(raw) > 0 {
		var list []StorePluginItem
		if err := json.Unmarshal(raw, &list); err == nil {
			result.Plugins = list
		} else if err := json.Unmarshal(raw, &result); err != nil {
			return PluginStore{}, fmt.Errorf("decode CPA plugin store: %w", err)
		}
	}
	if result.Plugins == nil {
		result.Plugins = []StorePluginItem{}
	}
	return result, nil
}

// InstallPlugin installs or updates a store plugin. The source pins which
// registry supplies it when several list the same id; an empty version asks
// for the newest release. CPA records the installed plugin by saving the
// configuration file in the v8 layout, so a legacy file is kept first.
func (c *Client) InstallPlugin(ctx context.Context, id, sourceID, version string) (PluginInstallResult, error) {
	id = strings.TrimSpace(id)
	if id == "" {
		return PluginInstallResult{}, errors.New("plugin id is required")
	}
	endpoint := "/plugins/store/" + url.PathEscape(id) + "/install"
	if sourceID = strings.TrimSpace(sourceID); sourceID != "" {
		endpoint += "?" + url.Values{"source": []string{sourceID}}.Encode()
	}
	payload := map[string]any{}
	if version = strings.TrimSpace(version); version != "" {
		payload["version"] = version
	}
	if err := c.keepLegacyConfig(ctx); err != nil {
		return PluginInstallResult{}, err
	}
	var result PluginInstallResult
	if err := c.doJSONBody(ctx, http.MethodPost, endpoint, payload, &result); err != nil {
		return PluginInstallResult{}, err
	}
	return result, nil
}
