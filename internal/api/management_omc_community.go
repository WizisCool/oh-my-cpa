package api

import (
	"net/http"
	"strings"

	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/management"
	"github.com/oh-my-cpa/oh-my-cpa/internal/pluginregistry"
)

// OMCCommunityPluginsDTO reports source availability separately from CPA's global
// execution switch. The latter stays absent when no gateway read was performed.
type OMCCommunityPluginsDTO struct {
	SourceEnabled  bool                        `json:"source_enabled"`
	SourceID       string                      `json:"source_id"`
	PluginsEnabled *bool                       `json:"plugins_enabled,omitempty"`
	PluginsDir     string                      `json:"plugins_dir"`
	Sources        []PluginStoreSourceDTO      `json:"sources"`
	SourceErrors   []PluginStoreSourceErrorDTO `json:"source_errors"`
	Plugins        []StorePluginItemDTO        `json:"plugins"`
	Total          int                         `json:"total"`
}

func omcCommunitySource() management.PluginStoreSource {
	return management.PluginStoreSource{ID: pluginregistry.SourceID(pluginregistry.OMCSourceURL), Name: pluginregistry.OMCSourceName, URL: pluginregistry.OMCSourceURL}
}

func (h *Handler) listOMCCommunityPlugins(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	if request.URL.RawQuery != "" {
		writeError(writer, http.StatusBadRequest, "the OMC community catalog does not accept source queries")
		return
	}
	enabled, err := h.pluginSourceEnabled(request.Context())
	if err != nil {
		h.pluginSourceReadError(writer, err)
		return
	}
	source := omcCommunitySource()
	dto := OMCCommunityPluginsDTO{
		SourceEnabled: enabled, SourceID: source.ID,
		Sources:      projectPluginStoreSources([]management.PluginStoreSource{source}),
		SourceErrors: []PluginStoreSourceErrorDTO{}, Plugins: []StorePluginItemDTO{},
	}
	if !enabled {
		// Reading a disabled catalog must not contact CPA or any registry, repair
		// configuration, or interpret this preference as builtin lifecycle authority.
		writeJSON(writer, http.StatusOK, dto)
		return
	}
	unavailable := func() {
		dto.SourceErrors = projectPluginStoreSourceErrors([]management.PluginStoreSourceError{{SourceID: source.ID, SourceName: source.Name, SourceURL: source.URL, Message: "OMC community plugin source is unavailable"}})
		writeJSON(writer, http.StatusOK, dto)
	}
	instance, err := h.repo.GetInstance(request.Context(), defaultInstanceID())
	if err != nil {
		unavailable()
		return
	}
	client, err := h.clientForInstance(request.Context(), instance)
	if err != nil {
		unavailable()
		return
	}
	_, settings, err := h.configuredPluginSources(request.Context(), client)
	if err != nil {
		unavailable()
		return
	}
	dto.PluginsEnabled = &settings.Enabled
	dto.PluginsDir = boundedText(settings.Dir, pluginTextLimit)
	// CPA learns this source on a manual write through the shared gate. Discovery
	// uses only its fixed public address and must not perform that reconciliation.
	store, err := h.readPluginCatalogSource(request.Context(), client, source, []management.PluginStoreSource{source}, settings)
	if err != nil {
		unavailable()
		return
	}
	// This catalog read has one outbound source. Remote artwork is optional;
	// accepting an entry must not add publisher-selected network dependencies.
	for index := range store.Plugins {
		if !strings.HasPrefix(store.Plugins[index].Logo, "data:") {
			store.Plugins[index].Logo = ""
		}
	}
	h.pluginLogos.inlineStore(request.Context(), store.Plugins)
	dto.Plugins = projectStorePlugins(store.Plugins)
	dto.Total = len(dto.Plugins)
	writeJSON(writer, http.StatusOK, dto)
}
