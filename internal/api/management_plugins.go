package api

import (
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/oh-my-cpa/oh-my-cpa/internal/security"
)

func (h *Handler) listPlugins(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	client, ok := h.managementClientOrError(writer, request)
	if !ok {
		return
	}

	plugins, err := client.Plugins(request.Context())
	if err != nil {
		writeCPAFacadeError(writer, err)
		return
	}

	writeJSON(writer, http.StatusOK, map[string]any{
		"plugins": plugins,
		"total":   len(plugins),
	})
}

type setPluginStatusRequest struct {
	Enabled bool `json:"enabled"`
}

func (h *Handler) setPluginStatus(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	pluginID := strings.TrimSpace(chi.URLParam(request, "id"))
	if pluginID == "" {
		writeError(writer, http.StatusBadRequest, "plugin id is required")
		return
	}

	var req setPluginStatusRequest
	if err := decodeManagementJSON(writer, request, 4*1024, &req); err != nil {
		return
	}

	client, ok := h.managementClientOrError(writer, request)
	if !ok {
		return
	}

	action := "plugin.enable"
	if !req.Enabled {
		action = "plugin.disable"
	}
	if auditErr := h.recordAudit(request, action, "plugin", security.RedactText(pluginID), "attempt", nil); auditErr != nil {
		writeError(writer, http.StatusInternalServerError, "audit failure; plugin operation aborted")
		return
	}

	if err := client.SetPluginStatus(request.Context(), pluginID, req.Enabled); err != nil {
		_ = h.recordAudit(request, action, "plugin", security.RedactText(pluginID), "failure", map[string]any{"error": err.Error()})
		writeCPAFacadeError(writer, err)
		return
	}

	_ = h.recordAudit(request, action, "plugin", security.RedactText(pluginID), "success", nil)

	writeJSON(writer, http.StatusOK, map[string]any{
		"status":  "ok",
		"id":      pluginID,
		"enabled": req.Enabled,
	})
}

func (h *Handler) deletePlugin(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	pluginID := strings.TrimSpace(chi.URLParam(request, "id"))
	if pluginID == "" {
		writeError(writer, http.StatusBadRequest, "plugin id is required")
		return
	}

	client, ok := h.managementClientOrError(writer, request)
	if !ok {
		return
	}

	if auditErr := h.recordAudit(request, "plugin.delete", "plugin", security.RedactText(pluginID), "attempt", nil); auditErr != nil {
		writeError(writer, http.StatusInternalServerError, "audit failure; plugin deletion aborted")
		return
	}

	if err := client.DeletePlugin(request.Context(), pluginID); err != nil {
		_ = h.recordAudit(request, "plugin.delete", "plugin", security.RedactText(pluginID), "failure", map[string]any{"error": err.Error()})
		writeCPAFacadeError(writer, err)
		return
	}

	_ = h.recordAudit(request, "plugin.delete", "plugin", security.RedactText(pluginID), "success", nil)

	writeJSON(writer, http.StatusOK, map[string]any{
		"status": "ok",
		"id":     pluginID,
	})
}

type setPluginConfigRequest struct {
	Config map[string]any `json:"config"`
}

func (h *Handler) setPluginConfig(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	pluginID := strings.TrimSpace(chi.URLParam(request, "id"))
	if pluginID == "" {
		writeError(writer, http.StatusBadRequest, "plugin id is required")
		return
	}

	var req setPluginConfigRequest
	if err := decodeManagementJSON(writer, request, 64*1024, &req); err != nil {
		return
	}

	client, ok := h.managementClientOrError(writer, request)
	if !ok {
		return
	}

	if auditErr := h.recordAudit(request, "plugin.config", "plugin", security.RedactText(pluginID), "attempt", nil); auditErr != nil {
		writeError(writer, http.StatusInternalServerError, "audit failure; config update aborted")
		return
	}

	if err := client.SetPluginConfig(request.Context(), pluginID, req.Config); err != nil {
		_ = h.recordAudit(request, "plugin.config", "plugin", security.RedactText(pluginID), "failure", map[string]any{"error": err.Error()})
		writeCPAFacadeError(writer, err)
		return
	}

	_ = h.recordAudit(request, "plugin.config", "plugin", security.RedactText(pluginID), "success", nil)

	writeJSON(writer, http.StatusOK, map[string]any{
		"status": "ok",
		"id":     pluginID,
	})
}

func (h *Handler) listPluginStore(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	client, ok := h.managementClientOrError(writer, request)
	if !ok {
		return
	}

	storePlugins, err := client.PluginStore(request.Context())
	if err != nil {
		writeCPAFacadeError(writer, err)
		return
	}

	writeJSON(writer, http.StatusOK, map[string]any{
		"plugins": storePlugins,
		"total":   len(storePlugins),
	})
}

func (h *Handler) installPlugin(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	pluginID := strings.TrimSpace(chi.URLParam(request, "id"))
	if pluginID == "" {
		writeError(writer, http.StatusBadRequest, "plugin id is required")
		return
	}

	client, ok := h.managementClientOrError(writer, request)
	if !ok {
		return
	}

	if auditErr := h.recordAudit(request, "plugin.install", "plugin_store", security.RedactText(pluginID), "attempt", nil); auditErr != nil {
		writeError(writer, http.StatusInternalServerError, "audit failure; install aborted")
		return
	}

	if err := client.InstallPlugin(request.Context(), pluginID); err != nil {
		_ = h.recordAudit(request, "plugin.install", "plugin_store", security.RedactText(pluginID), "failure", map[string]any{"error": err.Error()})
		writeCPAFacadeError(writer, err)
		return
	}

	_ = h.recordAudit(request, "plugin.install", "plugin_store", security.RedactText(pluginID), "success", nil)

	writeJSON(writer, http.StatusOK, map[string]any{
		"status": "ok",
		"id":     pluginID,
	})
}
