package api

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
)

func (h *Handler) deleteManagementAuthFiles(writer http.ResponseWriter, request *http.Request) {
	request.Body = http.MaxBytesReader(writer, request.Body, managementAuthFileRequestLimit)
	names := make([]string, 0)
	if queryNames := request.URL.Query()["name"]; len(queryNames) > 0 {
		names = append(names, queryNames...)
	} else {
		var payload struct {
			Name  string   `json:"name"`
			Names []string `json:"names"`
		}
		decoder := json.NewDecoder(request.Body)
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&payload); err != nil && !errors.Is(err, io.EOF) {
			writeError(writer, http.StatusBadRequest, "invalid request body")
			return
		}
		if strings.TrimSpace(payload.Name) != "" {
			names = append(names, payload.Name)
		}
		names = append(names, payload.Names...)
	}
	if len(names) == 0 || len(names) > 100 {
		writeError(writer, http.StatusBadRequest, "one to one hundred names are required")
		return
	}
	unique := make([]string, 0, len(names))
	seen := make(map[string]struct{}, len(names))
	for _, rawName := range names {
		name, selectorErr := validateAuthSelector(rawName)
		if selectorErr != nil {
			writeError(writer, http.StatusBadRequest, selectorErr.Error())
			return
		}
		if _, exists := seen[name]; exists {
			continue
		}
		seen[name] = struct{}{}
		unique = append(unique, name)
	}
	if auditErr := h.recordAudit(request, "auth_file.delete", "auth_file", strings.Join(unique, ","), "attempt", map[string]any{"count": len(unique)}); auditErr != nil {
		writeError(writer, http.StatusInternalServerError, "audit log failure; deletion aborted")
		return
	}
	client, ok := h.managementClientOrError(writer, request)
	if !ok {
		return
	}
	cpaResp, err := client.DeleteAuthFiles(request.Context(), unique)
	if err != nil {
		_ = h.recordAudit(request, "auth_file.delete", "auth_file", strings.Join(unique, ","), "failure", map[string]any{"error": err.Error()})
		writeCPAFacadeError(writer, err)
		return
	}

	confirmedDeleted, normalizedFailures, outcomeStatus := normalizeDeleteResponse(unique, cpaResp)

	auditOutcome := "success"
	if outcomeStatus == "partial" {
		auditOutcome = "partial"
	} else if outcomeStatus == "failure" {
		auditOutcome = "failure"
	}

	if auditErr := h.recordAudit(request, "auth_file.delete", "auth_file", strings.Join(unique, ","), auditOutcome, map[string]any{"deleted": len(confirmedDeleted), "failed_count": len(normalizedFailures)}); auditErr != nil {
		writeError(writer, http.StatusInternalServerError, "audit log failure after deletion")
		return
	}

	if len(confirmedDeleted) > 0 && h.pricing != nil {
		h.pricing.NotifyModelsChanged()
	}

	if outcomeStatus != "ok" {
		writeJSON(writer, http.StatusMultiStatus, map[string]any{
			"status":  outcomeStatus,
			"deleted": len(confirmedDeleted),
			"files":   confirmedDeleted,
			"failed":  normalizedFailures,
		})
		return
	}
	writeJSON(writer, http.StatusOK, map[string]any{"status": "ok", "deleted": len(confirmedDeleted), "files": confirmedDeleted})
}

type authFileDeleteFailureItem struct {
	Name  string `json:"name"`
	Error string `json:"error"`
}

func sanitizeDeleteError(raw string) string {
	lower := strings.ToLower(raw)
	switch {
	case strings.Contains(lower, "not found") || strings.Contains(lower, "no such"):
		return "file not found"
	case strings.Contains(lower, "permission") || strings.Contains(lower, "denied"):
		return "permission denied"
	case strings.Contains(lower, "in use") || strings.Contains(lower, "busy"):
		return "file in use"
	default:
		return "deletion failed"
	}
}

func normalizeDeleteResponse(requested []string, cpaResp map[string]any) ([]string, []authFileDeleteFailureItem, string) {
	requestedSet := make(map[string]bool, len(requested))
	for _, name := range requested {
		requestedSet[name] = true
	}

	seenFailed := make(map[string]bool)
	failures := make([]authFileDeleteFailureItem, 0)

	if rawFailed, ok := cpaResp["failed"].([]any); ok {
		for _, item := range rawFailed {
			record, isMap := item.(map[string]any)
			if !isMap {
				continue
			}
			rawName, _ := record["name"].(string)
			if !requestedSet[rawName] || seenFailed[rawName] {
				continue
			}
			rawErr, _ := record["error"].(string)
			if rawErr == "" {
				rawErr, _ = record["message"].(string)
			}
			failures = append(failures, authFileDeleteFailureItem{
				Name:  rawName,
				Error: sanitizeDeleteError(rawErr),
			})
			seenFailed[rawName] = true
		}
	}

	seenSuccess := make(map[string]bool)
	confirmedDeleted := make([]string, 0, len(requested))

	_, hasFiles := cpaResp["files"]
	_, hasFailed := cpaResp["failed"]
	_, hasDeleted := cpaResp["deleted"]

	if rawFiles, ok := cpaResp["files"].([]any); ok {
		for _, item := range rawFiles {
			rawName, isStr := item.(string)
			if !isStr || !requestedSet[rawName] || seenSuccess[rawName] || seenFailed[rawName] {
				continue
			}
			confirmedDeleted = append(confirmedDeleted, rawName)
			seenSuccess[rawName] = true
		}
	} else if len(requested) == 1 && !hasFiles && !hasFailed && !hasDeleted {
		// Documented CPA single-file contract: returns {"status": "ok"} without files/failed/deleted keys
		name := requested[0]
		if status, isStr := cpaResp["status"].(string); isStr && (status == "ok" || status == "success") {
			confirmedDeleted = append(confirmedDeleted, name)
			seenSuccess[name] = true
		}
	}

	if hasDeleted {
		var upstreamDeletedCount int64 = -1
		if dFloat, ok := cpaResp["deleted"].(float64); ok && dFloat >= 0 {
			upstreamDeletedCount = int64(dFloat)
		} else if dInt, ok := cpaResp["deleted"].(int); ok && dInt >= 0 {
			upstreamDeletedCount = int64(dInt)
		} else if dInt64, ok := cpaResp["deleted"].(int64); ok && dInt64 >= 0 {
			upstreamDeletedCount = dInt64
		} else if dNum, ok := cpaResp["deleted"].(json.Number); ok {
			if parsed, err := dNum.Int64(); err == nil && parsed >= 0 {
				upstreamDeletedCount = parsed
			}
		}

		// If upstream explicitly reports deleted == 0, contradiction overrides success
		if upstreamDeletedCount == 0 && len(confirmedDeleted) > 0 {
			for _, name := range confirmedDeleted {
				failures = append(failures, authFileDeleteFailureItem{
					Name:  name,
					Error: "deletion unconfirmed by upstream",
				})
				seenFailed[name] = true
			}
			confirmedDeleted = confirmedDeleted[:0]
			seenSuccess = make(map[string]bool)
		}
	}

	// A file CPA neither confirmed deleted nor reported as failed is unconfirmed;
	// reporting it as success would let a partial upstream delete look complete.
	for _, name := range requested {
		if !seenSuccess[name] && !seenFailed[name] {
			failures = append(failures, authFileDeleteFailureItem{
				Name:  name,
				Error: "deletion unconfirmed by upstream",
			})
			seenFailed[name] = true
		}
	}

	if len(confirmedDeleted) == len(requested) && len(failures) == 0 {
		return confirmedDeleted, failures, "ok"
	}
	if len(confirmedDeleted) == 0 {
		return confirmedDeleted, failures, "failure"
	}
	return confirmedDeleted, failures, "partial"
}
