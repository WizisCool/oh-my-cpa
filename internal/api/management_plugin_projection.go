package api

import (
	"net/url"
	"regexp"
	"strings"

	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/management"
)

/**
 * The console's own plugin shapes, projected field by field from the CPA facade model.
 *
 * `internal/api` declares the response contract for every management surface rather
 * than forwarding a model that also describes what CPA sent: the facade model exists to
 * decode CPA's document, and a field added there for decoding must not become a field
 * this console serves without somebody deciding it should. The projection is also where
 * a caller-visible value is bounded - plugin text arrives from a plugin manifest or a
 * store registry, not from this process.
 *
 * Two values are derived here rather than in the browser, so every surface reads the
 * same answer: the repository link (a registry usually names a GitHub `owner/repo` slug,
 * not a URL) and whether an entry is first-party. The configuration document is not
 * part of the list; it is read per plugin when the editor opens.
 */
const (
	// pluginTextLimit bounds one free-text manifest field. Descriptions legitimately run
	// to a paragraph, so the ceiling is generous; it exists so a manifest cannot decide
	// how large this response becomes.
	pluginTextLimit = 4096
	// pluginListLimit bounds every list a manifest declares (tags, fields, enum values,
	// platforms), for the same reason.
	pluginListLimit = 64
	// officialPluginSourceID is the id CPA assigns its built-in registry.
	officialPluginSourceID = "official"
	// officialPluginRepositoryPrefix is the whole URL prefix first-party repositories
	// live under. Matching the full prefix rather than the owner keeps a look-alike host
	// such as `github.com.example.net/router-for-me/` from passing.
	officialPluginRepositoryPrefix = "https://github.com/router-for-me/"
)

var githubRepositorySlug = regexp.MustCompile(`^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})/[A-Za-z0-9._-]{1,100}$`)

type PluginConfigFieldDTO struct {
	Name        string   `json:"name"`
	Type        string   `json:"type"`
	EnumValues  []string `json:"enum_values,omitempty"`
	Description string   `json:"description,omitempty"`
}

type PluginMetadataDTO struct {
	Name    string `json:"name,omitempty"`
	Version string `json:"version,omitempty"`
	Author  string `json:"author,omitempty"`
	Logo    string `json:"logo,omitempty"`
}

type PluginItemDTO struct {
	ID               string                 `json:"id"`
	Path             string                 `json:"path,omitempty"`
	Configured       bool                   `json:"configured"`
	Registered       bool                   `json:"registered"`
	Enabled          bool                   `json:"enabled"`
	EffectiveEnabled bool                   `json:"effective_enabled"`
	SupportsOAuth    bool                   `json:"supports_oauth,omitempty"`
	OAuthProvider    string                 `json:"oauth_provider,omitempty"`
	SupportsQuota    bool                   `json:"supports_quota,omitempty"`
	QuotaProvider    string                 `json:"quota_provider,omitempty"`
	Pages            []PluginPageDTO        `json:"pages"`
	Logo             string                 `json:"logo,omitempty"`
	RepositoryURL    string                 `json:"repository_url,omitempty"`
	ConfigFields     []PluginConfigFieldDTO `json:"config_fields"`
	Metadata         *PluginMetadataDTO     `json:"metadata,omitempty"`
}

// PluginPageDTO is one page a running plugin registers. `path` is the plugin resource
// path the plugin host serves it from, never a URL of the gateway's.
type PluginPageDTO struct {
	Path        string `json:"path"`
	Label       string `json:"label"`
	Description string `json:"description,omitempty"`
}

type PluginStoreSourceDTO struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	URL        string `json:"url"`
	IsOfficial bool   `json:"is_official"`
}

type PluginStoreSourceErrorDTO struct {
	SourceID   string `json:"source_id"`
	SourceName string `json:"source_name"`
	SourceURL  string `json:"source_url"`
	Message    string `json:"message"`
}

type StorePluginItemDTO struct {
	StoreID             string   `json:"store_id"`
	SourceID            string   `json:"source_id"`
	SourceName          string   `json:"source_name"`
	ID                  string   `json:"id"`
	Name                string   `json:"name"`
	Description         string   `json:"description,omitempty"`
	Author              string   `json:"author,omitempty"`
	Version             string   `json:"version,omitempty"`
	RepositoryURL       string   `json:"repository_url,omitempty"`
	Homepage            string   `json:"homepage,omitempty"`
	License             string   `json:"license,omitempty"`
	Tags                []string `json:"tags"`
	Logo                string   `json:"logo,omitempty"`
	InstallType         string   `json:"install_type,omitempty"`
	Platforms           []string `json:"platforms"`
	IsOfficial          bool     `json:"is_official"`
	AuthRequired        bool     `json:"auth_required"`
	AuthConfigured      bool     `json:"auth_configured"`
	Installed           bool     `json:"installed"`
	InstalledVersion    string   `json:"installed_version,omitempty"`
	InstallSourceStatus string   `json:"install_source_status,omitempty"`
	EffectiveEnabled    bool     `json:"effective_enabled"`
	UpdateAvailable     bool     `json:"update_available"`
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
	fields := plugin.ConfigFields
	repository := ""
	if plugin.Metadata != nil {
		if len(fields) == 0 {
			fields = plugin.Metadata.ConfigFields
		}
		repository = plugin.Metadata.GitHubRepository
	}
	return PluginItemDTO{
		ID:               boundedText(plugin.ID, pluginTextLimit),
		Path:             boundedText(plugin.Path, pluginTextLimit),
		Configured:       plugin.Configured,
		Registered:       plugin.Registered,
		Enabled:          plugin.Enabled,
		EffectiveEnabled: plugin.EffectiveEnabled,
		SupportsOAuth:    plugin.SupportsOAuth,
		OAuthProvider:    boundedText(plugin.OAuthProvider, pluginTextLimit),
		SupportsQuota:    plugin.SupportsQuota,
		QuotaProvider:    boundedText(plugin.QuotaProvider, pluginTextLimit),
		Pages:            projectPluginPages(plugin),
		Logo:             plugin.Logo,
		RepositoryURL:    pluginRepositoryURL(repository),
		ConfigFields:     projectPluginConfigFields(fields),
		Metadata:         projectPluginMetadata(plugin.Metadata),
	}
}

// projectPluginPages keeps the menus that are pages of this plugin: a resource path
// under the plugin's own prefix. A menu naming anything else - another plugin's
// resources, a management route, a foreign URL - is not something the host serves
// and is dropped rather than listed as a page that cannot open. A plugin that is
// not running lists none, since CPA serves its resources only while it is loaded.
func projectPluginPages(plugin management.PluginItem) []PluginPageDTO {
	pages := []PluginPageDTO{}
	if !plugin.EffectiveEnabled {
		return pages
	}
	seen := make(map[string]bool, len(plugin.Menus))
	for _, menu := range plugin.Menus {
		if len(pages) >= pluginListLimit {
			break
		}
		resourcePath, owner, ok := management.PluginResourcePath(strings.TrimSpace(menu.Path))
		if !ok || owner != strings.TrimSpace(plugin.ID) || seen[resourcePath] {
			continue
		}
		seen[resourcePath] = true
		label := boundedText(menu.Menu, 128)
		if label == "" {
			label = boundedText(plugin.DisplayName(), 128)
		}
		pages = append(pages, PluginPageDTO{
			Path:        resourcePath,
			Label:       label,
			Description: boundedText(menu.Description, pluginTextLimit),
		})
	}
	return pages
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

// projectPluginConfigFields keeps each declared field once, by name: the editor
// renders one control per name, so a manifest that declares a name twice would
// otherwise produce two controls writing the same key.
func projectPluginConfigFields(fields []management.PluginConfigField) []PluginConfigFieldDTO {
	result := make([]PluginConfigFieldDTO, 0, len(fields))
	seen := make(map[string]bool, len(fields))
	for _, field := range fields {
		if len(result) >= pluginListLimit {
			break
		}
		name := boundedText(field.Name, pluginTextLimit)
		if name == "" || seen[name] {
			continue
		}
		seen[name] = true
		result = append(result, PluginConfigFieldDTO{
			Name:        name,
			Type:        strings.ToLower(boundedText(field.Type, 32)),
			EnumValues:  boundedPluginList(field.EnumValues),
			Description: boundedText(field.Description, pluginTextLimit),
		})
	}
	return result
}

func projectPluginStoreSources(sources []management.PluginStoreSource) []PluginStoreSourceDTO {
	result := make([]PluginStoreSourceDTO, 0, len(sources))
	for _, source := range sources {
		result = append(result, PluginStoreSourceDTO{
			ID:         boundedText(source.ID, pluginTextLimit),
			Name:       boundedText(source.Name, pluginTextLimit),
			URL:        boundedText(source.URL, pluginTextLimit),
			IsOfficial: strings.EqualFold(strings.TrimSpace(source.ID), officialPluginSourceID),
		})
	}
	return result
}

func projectPluginStoreSourceErrors(sourceErrors []management.PluginStoreSourceError) []PluginStoreSourceErrorDTO {
	result := make([]PluginStoreSourceErrorDTO, 0, len(sourceErrors))
	for _, sourceError := range sourceErrors {
		result = append(result, PluginStoreSourceErrorDTO{
			SourceID:   boundedText(sourceError.SourceID, pluginTextLimit),
			SourceName: boundedText(sourceError.SourceName, pluginTextLimit),
			SourceURL:  boundedText(sourceError.SourceURL, pluginTextLimit),
			Message:    boundedText(sourceError.Message, pluginTextLimit),
		})
	}
	return result
}

// projectStorePlugins projects the plugin-store list, preserving the store's order.
func projectStorePlugins(plugins []management.StorePluginItem) []StorePluginItemDTO {
	result := make([]StorePluginItemDTO, 0, len(plugins))
	for _, plugin := range plugins {
		repositoryURL := pluginRepositoryURL(plugin.Repository)
		platforms := make([]string, 0, len(plugin.Platforms))
		for _, platform := range plugin.Platforms {
			if len(platforms) >= pluginListLimit {
				break
			}
			goos, goarch := boundedText(platform.GOOS, 32), boundedText(platform.GOARCH, 32)
			if goos != "" && goarch != "" {
				platforms = append(platforms, goos+"/"+goarch)
			}
		}
		result = append(result, StorePluginItemDTO{
			StoreID:             boundedText(plugin.StoreID, pluginTextLimit),
			SourceID:            boundedText(plugin.SourceID, pluginTextLimit),
			SourceName:          boundedText(plugin.SourceName, pluginTextLimit),
			ID:                  boundedText(plugin.ID, pluginTextLimit),
			Name:                boundedText(plugin.Name, pluginTextLimit),
			Description:         boundedText(plugin.Description, pluginTextLimit),
			Author:              boundedText(plugin.Author, pluginTextLimit),
			Version:             boundedText(plugin.Version, pluginTextLimit),
			RepositoryURL:       repositoryURL,
			Homepage:            httpURLOrEmpty(plugin.Homepage),
			License:             boundedText(plugin.License, pluginTextLimit),
			Tags:                boundedPluginList(plugin.Tags),
			Logo:                plugin.Logo,
			InstallType:         boundedText(plugin.InstallType, 64),
			Platforms:           platforms,
			IsOfficial:          isOfficialStorePlugin(plugin.SourceID, repositoryURL),
			AuthRequired:        plugin.AuthRequired,
			AuthConfigured:      plugin.AuthConfigured,
			Installed:           plugin.Installed,
			InstalledVersion:    boundedText(plugin.InstalledVersion, pluginTextLimit),
			InstallSourceStatus: boundedText(plugin.InstallSourceStatus, 64),
			EffectiveEnabled:    plugin.EffectiveEnabled,
			UpdateAvailable:     plugin.UpdateAvailable,
		})
	}
	return result
}

// isOfficialStorePlugin requires both the registry CPA assigned and the repository to
// be first-party. A third-party registry can copy a first-party repository name into
// its own entry, so the repository alone is not evidence of where the artifact comes
// from.
func isOfficialStorePlugin(sourceID, repositoryURL string) bool {
	return strings.EqualFold(strings.TrimSpace(sourceID), officialPluginSourceID) &&
		strings.HasPrefix(strings.ToLower(repositoryURL), officialPluginRepositoryPrefix)
}

// pluginRepositoryURL turns a registry's repository reference into a link: an
// http(s) URL is kept, a GitHub `owner/repo` slug is expanded, and anything else is
// dropped rather than guessed at.
func pluginRepositoryURL(repository string) string {
	repository = strings.TrimSpace(repository)
	if repository == "" {
		return ""
	}
	if link := httpURLOrEmpty(repository); link != "" {
		return link
	}
	slug := strings.TrimSuffix(strings.Trim(repository, "/"), ".git")
	if githubRepositorySlug.MatchString(slug) {
		return "https://github.com/" + slug
	}
	return ""
}

// httpURLOrEmpty keeps a value only when it is an absolute http(s) URL with a host,
// so a registry cannot hand the console a `javascript:` link.
func httpURLOrEmpty(raw string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" || len(raw) > pluginTextLimit {
		return ""
	}
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Host == "" {
		return ""
	}
	if scheme := strings.ToLower(parsed.Scheme); scheme != "http" && scheme != "https" {
		return ""
	}
	return raw
}

func boundedPluginList(values []string) []string {
	result := make([]string, 0, len(values))
	for _, value := range values {
		if len(result) >= pluginListLimit {
			break
		}
		if bounded := boundedText(value, pluginTextLimit); bounded != "" {
			result = append(result, bounded)
		}
	}
	return result
}
