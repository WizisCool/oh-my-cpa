package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"time"
)

func (h *Handler) listAuditEvents(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	if h.repo == nil {
		writeError(writer, http.StatusServiceUnavailable, "database is not initialized")
		return
	}

	limit := 50
	if limitParam := request.URL.Query().Get("limit"); limitParam != "" {
		if n, err := strconv.Atoi(limitParam); err == nil && n > 0 {
			limit = n
		}
	}

	events, err := h.repo.ListAuditEvents(request.Context(), limit)
	if err != nil {
		writeInternalError(writer, err)
		return
	}

	writeJSON(writer, http.StatusOK, map[string]any{
		"events": events,
		"total":  len(events),
	})
}

func (h *Handler) exportAuditEvents(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	writer.Header().Set("Content-Type", "application/json; charset=utf-8")
	writer.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="omc-audit-%d.json"`, time.Now().Unix()))

	if h.repo == nil {
		writeError(writer, http.StatusServiceUnavailable, "database is not initialized")
		return
	}

	events, err := h.repo.ListAuditEvents(request.Context(), 500)
	if err != nil {
		writeInternalError(writer, err)
		return
	}

	_ = h.recordAudit(request, "audit.export", "audit_events", "export", "success", map[string]any{"count": len(events)})

	exportPayload := map[string]any{
		"exported_at": time.Now().UTC().Format(time.RFC3339),
		"count":       len(events),
		"events":      events,
	}

	_ = json.NewEncoder(writer).Encode(exportPayload)
}
