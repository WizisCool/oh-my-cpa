package api

import (
	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/management"
)

/**
 * The console's own plugin shape, projected field by field from the CPA facade model.
 *
 * `internal/api` declares the response contract for every management surface rather
 * than forwarding a model that also describes what CPA sent: the facade model exists to
 * decode CPA's document, and a field added there for decoding must not become a field
 * this console serves without somebody deciding it should. The projection is also where
 * a caller-visible value is bounded - plugin text arrives from an installed plugin's
 * manifest, not from this process.
 *
 * The plugin configuration document passes through unbounded on purpose. It is the
 * plugin's own settings document, its shape belongs to the plugin rather than to this
 * contract, and the console's plugin editor reads and writes exactly this field - so
 * omitting it here would remove the plugin configuration capability rather than protect
 * anything. It is not a place this project keeps a secret: nothing OMC or CPA holds is
 * ever written into it, and the endpoint that serves it is management-authenticated.
 */
const (
	// pluginTextLimit bounds one free-text manifest field. Descriptions legitimately run
	// to a paragraph, so the ceiling is generous; it exists so a manifest cannot decide
	// how large this response becomes.
	pluginTextLimit = 4096
	// pluginPermissionLimit bounds the declared permission list, for the same reason.
	pluginPermissionLimit = 64
)

type PluginMetadataDTO struct {
	Name    string `json:"name,omitempty"`
	Version string `json:"version,omitempty"`
	Author  string `json:"author,omitempty"`
	Logo    string `json:"logo,omitempty"`
}

type PluginItemDTO struct {
	ID               string             `json:"id"`
	Name             string             `json:"name"`
	Path             string             `json:"path,omitempty"`
	Description      string             `json:"description,omitempty"`
	Version          string             `json:"version,omitempty"`
	Author           string             `json:"author,omitempty"`
	Enabled          bool               `json:"enabled"`
	EffectiveEnabled *bool              `json:"effective_enabled,omitempty"`
	Configured       bool               `json:"configured,omitempty"`
	Registered       bool               `json:"registered,omitempty"`
	SupportsOAuth    bool               `json:"supports_oauth,omitempty"`
	OAuthProvider    string             `json:"oauth_provider,omitempty"`
	Logo             string             `json:"logo,omitempty"`
	Permissions      []string           `json:"permissions,omitempty"`
	Config           map[string]any     `json:"config,omitempty"`
	Metadata         *PluginMetadataDTO `json:"metadata,omitempty"`
}

type StorePluginItemDTO struct {
	ID          string   `json:"id"`
	Name        string   `json:"name"`
	Description string   `json:"description,omitempty"`
	Version     string   `json:"version,omitempty"`
	Author      string   `json:"author,omitempty"`
	Permissions []string `json:"permissions,omitempty"`
	Installed   bool     `json:"installed"`
}

// projectPluginItems projects the installed plugin list, preserving CPA's order.
func projectPluginItems(plugins []management.PluginItem) []PluginItemDTO {
	result := make([]PluginItemDTO, 0, len(plugins))
	for _, plugin := range plugins {
		result = append(result, projectPluginItem(plugin))
	}
	return result
}

func projectPluginItem(plugin management.PluginItem) PluginItemDTO {
	return PluginItemDTO{
		ID:               boundedText(plugin.ID, pluginTextLimit),
		Name:             boundedText(plugin.Name, pluginTextLimit),
		Path:             boundedText(plugin.Path, pluginTextLimit),
		Description:      boundedText(plugin.Description, pluginTextLimit),
		Version:          boundedText(plugin.Version, pluginTextLimit),
		Author:           boundedText(plugin.Author, pluginTextLimit),
		Enabled:          plugin.Enabled,
		EffectiveEnabled: plugin.EffectiveEnabled,
		Configured:       plugin.Configured,
		Registered:       plugin.Registered,
		SupportsOAuth:    plugin.SupportsOAuth,
		OAuthProvider:    boundedText(plugin.OAuthProvider, pluginTextLimit),
		Logo:             plugin.Logo,
		Permissions:      boundedPluginPermissions(plugin.Permissions),
		Config:           plugin.Config,
		Metadata:         projectPluginMetadata(plugin.Metadata),
	}
}

func projectPluginMetadata(metadata *management.PluginMetadata) *PluginMetadataDTO {
	if metadata == nil {
		return nil
	}
	return &PluginMetadataDTO{
		Name:    boundedText(metadata.Name, pluginTextLimit),
		Version: boundedText(metadata.Version, pluginTextLimit),
		Author:  boundedText(metadata.Author, pluginTextLimit),
		Logo:    metadata.Logo,
	}
}

// projectStorePlugins projects the plugin-store list, preserving the store's order.
func projectStorePlugins(plugins []management.StorePluginItem) []StorePluginItemDTO {
	result := make([]StorePluginItemDTO, 0, len(plugins))
	for _, plugin := range plugins {
		result = append(result, StorePluginItemDTO{
			ID:          boundedText(plugin.ID, pluginTextLimit),
			Name:        boundedText(plugin.Name, pluginTextLimit),
			Description: boundedText(plugin.Description, pluginTextLimit),
			Version:     boundedText(plugin.Version, pluginTextLimit),
			Author:      boundedText(plugin.Author, pluginTextLimit),
			Permissions: boundedPluginPermissions(plugin.Permissions),
			Installed:   plugin.Installed,
		})
	}
	return result
}

func boundedPluginPermissions(permissions []string) []string {
	if len(permissions) == 0 {
		return nil
	}
	limit := len(permissions)
	if limit > pluginPermissionLimit {
		limit = pluginPermissionLimit
	}
	result := make([]string, 0, limit)
	for _, permission := range permissions[:limit] {
		result = append(result, boundedText(permission, pluginTextLimit))
	}
	return result
}
