package api

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/management"
	"github.com/oh-my-cpa/oh-my-cpa/internal/security"
)

/**
 * The plugin management facade: the installed list, each plugin's switch and
 * settings document, removal, the store catalog and installation.
 *
 * Every route maps to one fixed CPA plugin route. Responses are projected into this
 * package's DTOs, and the one value rewritten on the way out is a logo, because the
 * browser must not be sent to a plugin's or a registry's host.
 */

// pluginConfigBodyLimit bounds one plugin settings document.
const pluginConfigBodyLimit = 64 * 1024

// pluginIDFromRequest reads the `{id}` segment. CPA validates the id's shape itself;
// this only refuses what cannot be one path segment.
func pluginIDFromRequest(writer http.ResponseWriter, request *http.Request) (string, bool) {
	pluginID := strings.TrimSpace(chi.URLParam(request, "id"))
	if pluginID == "" || len(pluginID) > 256 || strings.ContainsAny(pluginID, "/\\") {
		writeError(writer, http.StatusBadRequest, "plugin id is required")
		return "", false
	}
	return pluginID, true
}

// writePluginFacadeError keeps the outcome CPA's plugin routes report. Those routes
// answer with a stable `error` code (a plugin that is not installed, an update that
// needs a restart, a rate-limited registry), and the console has something specific
// to say for each; folding them into the generic facade error would turn "not found"
// into "CPA does not support this operation". The message is CPA's own (the client
// has already scrubbed the management key from it) and bounded, because an install failure's reason (no artifact
// for this platform, a checksum mismatch) is what the operator needs to act on.
func writePluginFacadeError(writer http.ResponseWriter, err error) {
	var httpErr *management.HTTPError
	if !errors.As(err, &httpErr) {
		writeCPAFacadeError(writer, err)
		return
	}
	var body struct {
		Error      string `json:"error"`
		Message    string `json:"message"`
		RetryAfter int64  `json:"retry_after"`
	}
	if json.Unmarshal([]byte(httpErr.Body), &body) != nil || !isPluginErrorCode(body.Error) {
		writeCPAFacadeError(writer, err)
		return
	}
	status := http.StatusBadGateway
	switch httpErr.StatusCode {
	case http.StatusNotFound, http.StatusConflict, http.StatusTooManyRequests:
		status = httpErr.StatusCode
	case http.StatusBadRequest:
		status = http.StatusUnprocessableEntity
	}
	payload := map[string]any{
		"error": boundedText(security.RedactText(body.Message), 1024),
		"code":  body.Error,
	}
	if payload["error"] == "" {
		payload["error"] = "CPA rejected the plugin operation"
	}
	if status == http.StatusTooManyRequests && body.RetryAfter > 0 {
		writer.Header().Set("Retry-After", strconv.FormatInt(body.RetryAfter, 10))
		payload["retry_after"] = body.RetryAfter
	}
	writeJSON(writer, status, payload)
}

func isPluginErrorCode(code string) bool {
	switch code {
	case "invalid_plugin_id", "invalid_config", "invalid_body", "invalid_request":
		return true
	}
	return strings.HasPrefix(code, "plugin_")
}

// listPlugins is the installed list with the global plugin switch it depends on.
func (h *Handler) listPlugins(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	client, ok := h.managementClientOrError(writer, request)
	if !ok {
		return
	}

	list, err := client.PluginList(request.Context())
	if err != nil {
		writePluginFacadeError(writer, err)
		return
	}

	// An installed plugin the host has not loaded reports no name or logo of its own;
	// the store's listing of it supplies them, before the logos are inlined below.
	h.pluginIdentities.fill(request.Context(), client, list.Plugins)

	// A plugin's logo is its own to declare, but the browser that draws it must not
	// depend on the plugin's host: the mark is inlined here instead. A logo that
	// cannot be inlined is reported as absent, which is what makes the console fall
	// back to its own catalog mark.
	h.pluginLogos.inline(request.Context(), list.Plugins)

	projected := projectPluginItems(list.Plugins)
	writeJSON(writer, http.StatusOK, map[string]any{
		"plugins_enabled": list.PluginsEnabled,
		"plugins_dir":     boundedText(list.PluginsDir, pluginTextLimit),
		"plugins":         projected,
		"total":           len(projected),
	})
}

type setPluginEnabledRequest struct {
	Enabled *bool `json:"enabled"`
}

func (h *Handler) setPluginEnabled(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	pluginID, ok := pluginIDFromRequest(writer, request)
	if !ok {
		return
	}

	var req setPluginEnabledRequest
	if err := decodeManagementJSON(writer, request, 4*1024, &req); err != nil {
		return
	}
	if req.Enabled == nil {
		writeError(writer, http.StatusBadRequest, "enabled is required")
		return
	}

	client, ok := h.managementClientOrError(writer, request)
	if !ok {
		return
	}

	action := "plugin.enable"
	if !*req.Enabled {
		action = "plugin.disable"
	}
	target := security.RedactText(pluginID)
	if auditErr := h.recordAudit(request, action, "plugin", target, "attempt", nil); auditErr != nil {
		writeError(writer, http.StatusInternalServerError, "audit failure; plugin operation aborted")
		return
	}

	if err := client.SetPluginEnabled(request.Context(), pluginID, *req.Enabled); err != nil {
		_ = h.recordAudit(request, action, "plugin", target, "failure", map[string]any{"error": err.Error()})
		writePluginFacadeError(writer, err)
		return
	}

	_ = h.recordAudit(request, action, "plugin", target, "success", nil)

	writeJSON(writer, http.StatusOK, map[string]any{
		"status":  "ok",
		"id":      pluginID,
		"enabled": *req.Enabled,
	})
}

// getPluginConfig reads one plugin's settings document.
//
// The document passes through unprojected on purpose. It is the plugin's own settings,
// its shape belongs to the plugin rather than to this contract, and the editor reads
// and writes exactly this object - so projecting it would remove the capability rather
// than protect anything. It is not a place this project keeps a secret: nothing OMC or
// CPA holds is written into it, and the route is management-authenticated.
func (h *Handler) getPluginConfig(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	pluginID, ok := pluginIDFromRequest(writer, request)
	if !ok {
		return
	}
	client, ok := h.managementClientOrError(writer, request)
	if !ok {
		return
	}
	config, err := client.PluginConfig(request.Context(), pluginID)
	if err != nil {
		writePluginFacadeError(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, map[string]any{
		"id":     pluginID,
		"config": config,
	})
}

type setPluginConfigRequest struct {
	Config json.RawMessage `json:"config"`
}

func (h *Handler) setPluginConfig(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	pluginID, ok := pluginIDFromRequest(writer, request)
	if !ok {
		return
	}

	var req setPluginConfigRequest
	if err := decodeManagementJSON(writer, request, pluginConfigBodyLimit, &req); err != nil {
		return
	}
	var config map[string]any
	if len(req.Config) == 0 || string(req.Config) == "null" || json.Unmarshal(req.Config, &config) != nil || config == nil {
		writeError(writer, http.StatusBadRequest, "config must be an object")
		return
	}

	client, ok := h.managementClientOrError(writer, request)
	if !ok {
		return
	}

	target := security.RedactText(pluginID)
	if auditErr := h.recordAudit(request, "plugin.config", "plugin", target, "attempt", nil); auditErr != nil {
		writeError(writer, http.StatusInternalServerError, "audit failure; config update aborted")
		return
	}

	if err := client.SetPluginConfig(request.Context(), pluginID, config); err != nil {
		_ = h.recordAudit(request, "plugin.config", "plugin", target, "failure", map[string]any{"error": err.Error()})
		writePluginFacadeError(writer, err)
		return
	}

	_ = h.recordAudit(request, "plugin.config", "plugin", target, "success", nil)

	writeJSON(writer, http.StatusOK, map[string]any{
		"status": "ok",
		"id":     pluginID,
	})
}

func (h *Handler) deletePlugin(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	pluginID, ok := pluginIDFromRequest(writer, request)
	if !ok {
		return
	}

	client, ok := h.managementClientOrError(writer, request)
	if !ok {
		return
	}

	target := security.RedactText(pluginID)
	if auditErr := h.recordAudit(request, "plugin.delete", "plugin", target, "attempt", nil); auditErr != nil {
		writeError(writer, http.StatusInternalServerError, "audit failure; plugin deletion aborted")
		return
	}

	result, err := client.DeletePlugin(request.Context(), pluginID)
	if err != nil {
		_ = h.recordAudit(request, "plugin.delete", "plugin", target, "failure", map[string]any{"error": err.Error()})
		writePluginFacadeError(writer, err)
		return
	}

	_ = h.recordAudit(request, "plugin.delete", "plugin", target, "success", map[string]any{
		"file_deleted":       result.FileDeleted,
		"configured_removed": result.ConfiguredRemoved,
	})

	writeJSON(writer, http.StatusOK, map[string]any{
		"status":             "ok",
		"id":                 pluginID,
		"file_deleted":       result.FileDeleted,
		"configured_removed": result.ConfiguredRemoved,
		"restart_required":   result.RestartRequired,
	})
}

// listPluginStore is the catalog every configured registry offers, joined by CPA
// with what is installed. A registry that failed is reported beside the entries the
// others returned rather than failing the page.
func (h *Handler) listPluginStore(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	client, ok := h.managementClientOrError(writer, request)
	if !ok {
		return
	}

	store, err := client.PluginStore(request.Context())
	if err != nil {
		writePluginFacadeError(writer, err)
		return
	}

	h.pluginIdentities.remember(store.Plugins)
	h.pluginLogos.inlineStore(request.Context(), store.Plugins)

	projected := projectStorePlugins(store.Plugins)
	writeJSON(writer, http.StatusOK, map[string]any{
		"plugins_enabled": store.PluginsEnabled,
		"plugins_dir":     boundedText(store.PluginsDir, pluginTextLimit),
		"sources":         projectPluginStoreSources(store.Sources),
		"source_errors":   projectPluginStoreSourceErrors(store.SourceErrors),
		"plugins":         projected,
		"total":           len(projected),
	})
}

type installPluginRequest struct {
	SourceID string `json:"source_id"`
	Version  string `json:"version"`
}

// installPlugin installs a store plugin, or updates an installed one to the newest
// (or a named) release. The body is optional: without it the newest release from the
// only registry listing the id is installed.
func (h *Handler) installPlugin(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	pluginID, ok := pluginIDFromRequest(writer, request)
	if !ok {
		return
	}

	var req installPluginRequest
	if request.Body != nil && request.ContentLength != 0 {
		request.Body = http.MaxBytesReader(writer, request.Body, 4*1024)
		raw, err := io.ReadAll(request.Body)
		if err != nil {
			writeError(writer, http.StatusBadRequest, "invalid request body")
			return
		}
		if strings.TrimSpace(string(raw)) != "" {
			decoder := json.NewDecoder(strings.NewReader(string(raw)))
			decoder.DisallowUnknownFields()
			if err := decoder.Decode(&req); err != nil {
				writeError(writer, http.StatusBadRequest, "invalid request body")
				return
			}
		}
	}
	req.SourceID = strings.TrimSpace(req.SourceID)
	req.Version = strings.TrimSpace(req.Version)
	if len(req.SourceID) > 128 || len(req.Version) > 128 {
		writeError(writer, http.StatusBadRequest, "source_id and version must be at most 128 characters")
		return
	}

	client, ok := h.managementClientOrError(writer, request)
	if !ok {
		return
	}

	target := security.RedactText(pluginID)
	details := map[string]any{}
	if req.SourceID != "" {
		details["source_id"] = req.SourceID
	}
	if req.Version != "" {
		details["version"] = req.Version
	}
	if auditErr := h.recordAudit(request, "plugin.install", "plugin_store", target, "attempt", details); auditErr != nil {
		writeError(writer, http.StatusInternalServerError, "audit failure; install aborted")
		return
	}

	result, err := client.InstallPlugin(request.Context(), pluginID, req.SourceID, req.Version)
	if err != nil {
		_ = h.recordAudit(request, "plugin.install", "plugin_store", target, "failure", map[string]any{"error": err.Error()})
		writePluginFacadeError(writer, err)
		return
	}

	_ = h.recordAudit(request, "plugin.install", "plugin_store", target, "success", map[string]any{"version": boundedText(result.Version, 128)})

	writeJSON(writer, http.StatusOK, map[string]any{
		"status":           "ok",
		"id":               pluginID,
		"version":          boundedText(result.Version, pluginTextLimit),
		"source_name":      boundedText(result.SourceName, pluginTextLimit),
		"plugins_enabled":  result.PluginsEnabled,
		"restart_required": result.RestartRequired,
	})
}
