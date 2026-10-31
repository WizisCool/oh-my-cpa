package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/configyaml"
	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/management"
	"github.com/oh-my-cpa/oh-my-cpa/internal/domain"
	"github.com/oh-my-cpa/oh-my-cpa/internal/pluginregistry"
	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
)

var errPluginSourceNotConfigured = errors.New("plugin source is not configured")

const officialRegistryURL = pluginregistry.OfficialSourceURL

type pluginDescriptionCache struct {
	mu      sync.Mutex
	entries map[string]descriptionCacheEntry
	client  *http.Client
}
type descriptionCacheEntry struct {
	Value     PluginDescriptionDTO
	ExpiresAt time.Time
}
type PluginDescriptionDTO struct {
	PluginID        string                      `json:"plugin_id"`
	PluginVersion   string                      `json:"plugin_version"`
	Description     string                      `json:"description"`
	DescriptionI18n pluginregistry.Descriptions `json:"description_i18n,omitempty"`
	Origin          string                      `json:"origin"`
}

func newPluginDescriptionCache() *pluginDescriptionCache {
	fetcher := newPluginLogoFetcher()
	fetcher.client.CheckRedirect = func(request *http.Request, via []*http.Request) error {
		if len(via) > 3 || request.URL.Scheme != "https" || request.URL.User != nil {
			return http.ErrUseLastResponse
		}
		switch request.URL.Hostname() {
		case "github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com":
			return nil
		}
		return http.ErrUseLastResponse
	}
	return &pluginDescriptionCache{entries: map[string]descriptionCacheEntry{}, client: fetcher.client}
}
func isOMCCommunitySource(sourceID, sourceURL string) bool {
	return sourceURL == pluginregistry.OMCSourceURL && sourceID == pluginregistry.SourceID(pluginregistry.OMCSourceURL)
}

func sourceKind(source management.PluginStoreSource, builtinURL string) string {
	if builtinURL != "" && source.URL == builtinURL && source.ID == pluginregistry.SourceID(builtinURL) {
		return "builtin"
	}
	if isOMCCommunitySource(source.ID, source.URL) {
		return "omc_community"
	}
	if source.ID == officialPluginSourceID && source.URL == officialRegistryURL {
		return "official"
	}
	return "community"
}
func (h *Handler) configuredPluginSources(ctx context.Context, client *management.Client) ([]management.PluginStoreSource, configyaml.PluginSettings, error) {
	raw, err := client.ConfigYAML(ctx)
	if err != nil {
		return nil, configyaml.PluginSettings{}, err
	}
	settings, err := configyaml.ReadPluginSettings(raw)
	if err != nil {
		return nil, settings, err
	}
	sources := []management.PluginStoreSource{{ID: officialPluginSourceID, Name: "Official", URL: officialRegistryURL}}
	seen := map[string]bool{officialRegistryURL: true}
	for _, address := range settings.StoreSources {
		address = strings.TrimSpace(address)
		if seen[address] || address == "" {
			continue
		}
		seen[address] = true
		name := "Community"
		if parsed, err := url.Parse(address); err == nil {
			name = parsed.Hostname()
		}
		if isOMCPluginStoreURL(address) {
			name = pluginregistry.OMCSourceName
		}
		sources = append(sources, management.PluginStoreSource{ID: pluginregistry.SourceID(address), Name: name, URL: address})
	}
	return sources, settings, nil
}

// readPluginCatalog requests one configured source directly. CPA's native Store
// list eagerly fetches every source and ignores a source query on current v8;
// filtering that response would still couple every community tab to every source.
func (h *Handler) readPluginCatalog(ctx context.Context, client *management.Client, sourceID string) (management.PluginStore, error) {
	sources, settings, err := h.configuredPluginSources(ctx, client)
	if err != nil {
		return management.PluginStore{}, err
	}
	if sourceID == "" {
		sourceID = officialPluginSourceID
	}
	if sourceID == pluginregistry.SourceID(pluginregistry.OMCSourceURL) {
		enabled, err := h.pluginSourceEnabled(ctx)
		if err != nil {
			return management.PluginStore{}, err
		}
		if !enabled {
			return management.PluginStore{}, errPluginSourceNotConfigured
		}
		found := false
		for _, source := range sources {
			found = found || isOMCCommunitySource(source.ID, source.URL)
		}
		if !found {
			sources = append(sources, omcCommunitySource())
		}
	}
	var source management.PluginStoreSource
	found := false
	for _, candidate := range sources {
		if candidate.ID == sourceID {
			source = candidate
			found = true
			break
		}
	}
	if !found {
		return management.PluginStore{}, errPluginSourceNotConfigured
	}
	return h.readPluginCatalogSource(ctx, client, source, sources, settings)
}

func (h *Handler) readPluginCatalogSource(ctx context.Context, client *management.Client, source management.PluginStoreSource, sources []management.PluginStoreSource, settings configyaml.PluginSettings) (management.PluginStore, error) {
	result := management.PluginStore{PluginsEnabled: settings.Enabled, PluginsDir: settings.Dir, Sources: sources, SourceErrors: []management.PluginStoreSourceError{}, Plugins: []management.StorePluginItem{}}
	builtinURL, _ := h.builtinRegistryURL()
	if sourceKind(source, builtinURL) == "builtin" {
		return result, errors.New("builtin plugins use their approved catalog")
	}
	var raw []byte
	if h.cfg.IsDemoMode {
		// The demo is an in-process fixture, never a network catalog fetch.
		fixture, readErr := client.PluginStore(ctx)
		if readErr != nil {
			return result, readErr
		}
		for _, plugin := range fixture.Plugins {
			if plugin.SourceID == source.ID && plugin.SourceURL == source.URL {
				result.Plugins = append(result.Plugins, plugin)
			}
		}
		return result, nil
	}
	// CPA owns store-auth environment variables. OMC must not read them or forward
	// management credentials to registries; authentication-required sources fail
	// visibly rather than falling back to CPA's aggregate endpoint.
	for _, rule := range settings.StoreAuth {
		if rule.Type != "" && rule.Type != "none" && (strings.Contains(source.URL, strings.TrimSpace(rule.Match)) || rule.Match == "*") {
			return result, errors.New("source authentication is available only in CPA")
		}
	}
	parsedSource, parseErr := url.Parse(source.URL)
	if parseErr != nil || !isPluginLogoURLAllowed(parsedSource) || parsedSource.RawQuery != "" || parsedSource.Fragment != "" {
		return result, errors.New("plugin source address is not allowed")
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, source.URL, nil)
	if err != nil {
		return result, err
	}
	catalogClient := *h.pluginDescriptions.client
	catalogClient.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	response, err := catalogClient.Do(request)
	if err != nil {
		return result, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return result, fmt.Errorf("plugin source HTTP %d", response.StatusCode)
	}
	raw, err = io.ReadAll(io.LimitReader(response.Body, pluginregistry.MaxManifestBytes+1))
	if err != nil {
		return result, err
	}
	if len(raw) > pluginregistry.MaxManifestBytes {
		return result, errors.New("plugin source is too large")
	}
	var document struct {
		SchemaVersion int `json:"schema_version"`
		Plugins       []struct {
			ID              string                      `json:"id"`
			Name            string                      `json:"name"`
			Description     string                      `json:"description"`
			DescriptionI18n pluginregistry.Descriptions `json:"description_i18n"`
			Author          string                      `json:"author"`
			Version         string                      `json:"version"`
			Repository      string                      `json:"repository"`
			Logo            string                      `json:"logo"`
			Homepage        string                      `json:"homepage"`
			License         string                      `json:"license"`
			Tags            []string                    `json:"tags"`
			AuthRequired    bool                        `json:"auth_required"`
			Install         struct {
				Type      string                           `json:"type"`
				Artifacts []management.PluginStorePlatform `json:"artifacts"`
			} `json:"install"`
		} `json:"plugins"`
	}
	if err := json.Unmarshal(raw, &document); err != nil || (document.SchemaVersion != 1 && document.SchemaVersion != 2) {
		return result, errors.New("invalid plugin catalog")
	}
	native, err := client.PluginList(ctx)
	if err != nil {
		return result, err
	}
	records, err := readPluginInstallRecords(ctx, client)
	if err != nil {
		return result, err
	}
	for _, entry := range document.Plugins {
		if len(result.Plugins) >= 256 {
			break
		}
		kind := entry.Install.Type
		if kind == "" {
			kind = "github-release"
		}
		item := management.StorePluginItem{StoreID: source.ID + ":" + entry.ID, SourceID: source.ID, SourceName: source.Name, SourceURL: source.URL, ID: entry.ID, Name: entry.Name, Description: entry.Description, DescriptionI18n: entry.DescriptionI18n, Author: entry.Author, Version: entry.Version, Repository: entry.Repository, Logo: entry.Logo, Homepage: entry.Homepage, License: entry.License, Tags: entry.Tags, AuthRequired: entry.AuthRequired, InstallType: kind, Platforms: entry.Install.Artifacts}
		if pluginregistry.ValidateDescriptions(item.DescriptionI18n) != nil {
			item.DescriptionI18n = nil
		}
		record, hasRecord := records[entry.ID]
		if hasRecord {
			item.Installed = true
			item.InstalledVersion = record.Version
			item.InstalledSourceID = record.SourceID
			if record.SourceID == source.ID && record.SourceURL == source.URL {
				item.InstallSourceStatus = "matched"
			} else {
				item.InstallSourceStatus = "different"
			}
		}
		for _, plugin := range native.Plugins {
			if plugin.ID == entry.ID {
				item.Configured = plugin.Configured
				item.Registered = plugin.Registered
				item.Enabled = plugin.Enabled
				item.EffectiveEnabled = plugin.EffectiveEnabled
				if plugin.Path != "" {
					item.Installed = true
				}
			}
		}
		if item.Installed {
			comparison, comparable := pluginregistry.CompareVersions(item.InstalledVersion, item.Version)
			item.UpdateAvailable = comparable && comparison < 0
		}
		result.Plugins = append(result.Plugins, item)
	}
	return result, nil
}
func (h *Handler) getPluginDescription(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	query := request.URL.Query()
	for key := range query {
		if key != "source_id" && key != "plugin_id" && key != "version" {
			writeError(writer, http.StatusBadRequest, "unsupported plugin description query")
			return
		}
	}
	id, version, sourceID := strings.TrimSpace(query.Get("plugin_id")), strings.TrimSpace(query.Get("version")), strings.TrimSpace(query.Get("source_id"))
	if id == "" || version == "" || strings.ContainsAny(id+version, "/\\<>\x00") || len(id) > 128 || len(version) > 128 {
		writeError(writer, http.StatusBadRequest, "plugin_id and version are required")
		return
	}
	instance, err := h.repo.GetInstance(request.Context(), defaultInstanceID())
	if err != nil {
		writeInternalError(writer, err)
		return
	}
	key := fmt.Sprint(instance.BindingGeneration) + "\x00" + repository.BuiltinGatewayID(instance) + "\x00" + sourceID + "\x00" + id + "\x00" + version
	cache := h.pluginDescriptions
	cache.mu.Lock()
	cached, ok := cache.entries[key]
	cache.mu.Unlock()
	if ok && time.Now().Before(cached.ExpiresAt) {
		writeJSON(writer, http.StatusOK, cached.Value)
		return
	}
	client, ok := h.managementClientOrError(writer, request)
	if !ok {
		return
	}
	dto := PluginDescriptionDTO{PluginID: id, PluginVersion: version, Origin: "none"}
	var repositoryURL string
	builtinURL, _ := h.builtinRegistryURL()
	if sourceID == pluginregistry.SourceID(builtinURL) && builtinURL != "" {
		state := h.builtinCatalog().State()
		for _, plugin := range state.Manifest.Plugins {
			if plugin.ID == id && plugin.Version == version {
				repositoryURL = plugin.Repository
				dto.Description = plugin.Description
				dto.DescriptionI18n = plugin.DescriptionI18n
				dto.Origin = "native"
			}
		}
	} else {
		catalog, err := h.readPluginCatalog(request.Context(), client, sourceID)
		if err != nil {
			writeJSON(writer, http.StatusBadGateway, map[string]any{"error": "plugin description source is unavailable", "code": "plugin_source_unavailable"})
			return
		}
		for _, plugin := range catalog.Plugins {
			if plugin.ID == id {
				repositoryURL = pluginRepositoryURL(plugin.Repository)
				if plugin.Version == version {
					dto.Description = plugin.Description
					dto.DescriptionI18n = plugin.DescriptionI18n
					dto.Origin = "native"
				}
				break
			}
		}
	}
	if h.cfg.IsDemoMode {
		writeJSON(writer, http.StatusOK, dto)
		return
	}
	if repositoryURL == "" && dto.Origin == "none" {
		writeError(writer, http.StatusNotFound, "plugin is not in the selected source")
		return
	}
	// Runtime is only evidence for this exact source and version, never the
	// requested target release while another version is still loaded.
	records, recordsErr := readPluginInstallRecords(request.Context(), client)
	native, nativeErr := client.PluginList(request.Context())
	if recordsErr == nil && nativeErr == nil {
		record := records[id]
		if record.SourceID == sourceID && record.Version == version {
			for _, plugin := range native.Plugins {
				if plugin.ID == id && plugin.Registered && plugin.DisplayVersion() == version {
					if raw, err := client.PluginDescription(request.Context(), id); err == nil {
						if descriptions, err := pluginregistry.ParseDescription(raw, id, version); err == nil {
							dto.DescriptionI18n = descriptions
							dto.Origin = "runtime"
						}
					}
				}
			}
		}
	}
	if dto.Origin != "runtime" && pluginregistry.IsGitHubRepository(repositoryURL) {
		for _, tag := range []string{"v" + version, version} {
			// All address components came from the selected registered source and the
			// validated id/version. No endpoint accepts an arbitrary metadata URL.
			address := strings.TrimRight(repositoryURL, "/") + "/releases/download/" + url.PathEscape(tag) + "/" + url.PathEscape(id) + ".omc.json"
			fetchCtx, cancel := context.WithTimeout(request.Context(), 5*time.Second)
			fetch, err := http.NewRequestWithContext(fetchCtx, http.MethodGet, address, nil)
			if err == nil {
				response, fetchErr := cache.client.Do(fetch)
				if fetchErr == nil {
					if response.StatusCode == http.StatusOK {
						raw, readErr := io.ReadAll(io.LimitReader(response.Body, pluginregistry.MaxDescriptionBytes+1))
						if readErr == nil {
							if descriptions, parseErr := pluginregistry.ParseDescription(raw, id, version); parseErr == nil {
								dto.DescriptionI18n = descriptions
								dto.Origin = "release"
							}
						}
					}
					response.Body.Close()
				}
			}
			cancel()
			if dto.Origin == "release" {
				break
			}
		}
	}
	if !pluginregistry.IsPlainText(dto.Description, 8192) {
		dto.Description = ""
	}
	cache.mu.Lock()
	if len(cache.entries) >= 512 {
		cache.entries = map[string]descriptionCacheEntry{}
	}
	cache.entries[key] = descriptionCacheEntry{Value: dto, ExpiresAt: time.Now().Add(5 * time.Minute)}
	cache.mu.Unlock()
	writeJSON(writer, http.StatusOK, dto)
}

func (h *Handler) mustBuiltinRegistryURL() string {
	address, _ := h.builtinRegistryURL()
	return address
}

func (h *Handler) enrichInstalledPluginDTOs(ctx context.Context, client *management.Client, native []management.PluginItem, items []PluginItemDTO) {
	records, err := readPluginInstallRecords(ctx, client)
	if err != nil {
		return
	}
	sources, _, err := h.configuredPluginSources(ctx, client)
	if err != nil {
		return
	}
	builtinURL := h.mustBuiltinRegistryURL()
	instance, err := h.repo.GetInstance(ctx, defaultInstanceID())
	if err != nil {
		return
	}
	for index := range items {
		item := &items[index]
		record, found := records[item.ID]
		if !found {
			for _, plugin := range native {
				if plugin.ID == item.ID {
					record.Version = plugin.DisplayVersion()
					if plugin.Metadata != nil {
						record.Repository = pluginRepositoryURL(plugin.Metadata.GitHubRepository)
						record.Description = plugin.Metadata.Description
					}
					break
				}
			}
		}
		item.SourceID = boundedText(record.SourceID, 128)
		item.InstalledVersion = boundedText(record.Version, 128)
		if isOMCCommunitySource(record.SourceID, record.SourceURL) {
			item.SourceKind = "omc_community"
		}
		for _, source := range sources {
			if source.ID == record.SourceID && source.URL == record.SourceURL {
				item.SourceKind = sourceKind(source, builtinURL)
				break
			}
		}
		if record.SourceID == pluginregistry.SourceID(builtinURL) && record.SourceURL == builtinURL && builtinURL != "" {
			item.SourceKind = "builtin"
		}
		if item.Metadata == nil && (record.Name != "" || record.Author != "") {
			item.Metadata = &PluginMetadataDTO{Name: boundedText(record.Name, pluginTextLimit), Author: boundedText(record.Author, pluginTextLimit)}
		}
		fallback := record.Description
		for _, plugin := range native {
			if plugin.ID == item.ID {
				if plugin.Metadata != nil && plugin.Metadata.Description != "" && plugin.DisplayVersion() == record.Version {
					fallback = plugin.Metadata.Description
				}
				break
			}
		}
		description := h.readInstalledDescription(instance, record, item.ID, fallback)
		item.Description = description.Description
		item.DescriptionI18n = description.DescriptionI18n
	}
}

// Installed lists depend only on CPA observations and metadata already cached by
// the dedicated description endpoint. Optional release reads must not delay them.
func (h *Handler) readInstalledDescription(instance domain.CPAInstance, record pluginInstallRecord, id, fallback string) PluginDescriptionDTO {
	key := fmt.Sprint(instance.BindingGeneration) + "\x00" + repository.BuiltinGatewayID(instance) + "\x00" + record.SourceID + "\x00" + id + "\x00" + record.Version
	cache := h.pluginDescriptions
	cache.mu.Lock()
	cached, ok := cache.entries[key]
	cache.mu.Unlock()
	if ok && time.Now().Before(cached.ExpiresAt) {
		return cached.Value
	}
	dto := PluginDescriptionDTO{PluginID: id, PluginVersion: record.Version, Origin: "none"}
	if pluginregistry.IsPlainText(fallback, 8192) && fallback != "" {
		dto.Description = fallback
		dto.Origin = "native"
	}
	return dto
}
