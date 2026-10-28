package api

import (
	"errors"
	"net/http"

	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
)

// putManagementAuthFileDisplayName names or clears one credential.
//
// The name is Oh My CPA's own metadata, so this never writes to CPA: naming a
// credential must not rewrite its auth file. The credential must be one CPA
// currently reports, so a name cannot be parked against a file that does not
// exist. Like a caller-key rename it is audited fail-closed, and the name itself
// stays out of the audit details because the file name already identifies it.
func (h *Handler) putManagementAuthFileDisplayName(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	if h.repo == nil {
		writeError(writer, http.StatusServiceUnavailable, "database is unavailable")
		return
	}
	var payload struct {
		Name        string `json:"name"`
		DisplayName string `json:"display_name"`
		Version     int64  `json:"version"`
	}
	if err := decodeManagementJSON(writer, request, 8*1024, &payload); err != nil {
		return
	}
	name, selectorErr := validateAuthSelector(payload.Name)
	if selectorErr != nil {
		writeError(writer, http.StatusBadRequest, selectorErr.Error())
		return
	}
	normalized, err := repository.NormalizeCredentialDisplayName(payload.DisplayName)
	if err != nil {
		writeError(writer, http.StatusBadRequest, err.Error())
		return
	}
	client, ok := h.managementClientOrError(writer, request)
	if !ok {
		return
	}
	files, err := client.AuthFiles(request.Context())
	if err != nil {
		writeCPAFacadeError(writer, err)
		return
	}
	matches := 0
	for _, file := range files.Files {
		if firstNonEmpty(file.Name, file.ID) == name {
			matches++
		}
	}
	if matches == 0 {
		writeError(writer, http.StatusNotFound, errManagementAuthFileNotFound.Error())
		return
	}

	if matches != 1 {
		writeError(writer, http.StatusConflict, "auth file name is ambiguous")
		return
	}
	if payload.Version < 0 {
		writeError(writer, http.StatusBadRequest, "version must be non-negative")
		return
	}

	action := "auth_file.display_name_set"
	if normalized == "" {
		action = "auth_file.display_name_clear"
	}
	if auditErr := h.recordAudit(request, action, "auth_file", name, "attempt", nil); auditErr != nil {
		writeError(writer, http.StatusInternalServerError, "audit log failure; rename aborted")
		return
	}
	stored, err := h.repo.SetCredentialDisplayName(request.Context(), defaultInstanceID(), name, normalized, payload.Version)
	if err != nil {
		_ = h.recordAudit(request, action, "auth_file", name, "failure", map[string]any{"error": err.Error()})
		switch {
		case errors.Is(err, repository.ErrCredentialDisplayNameVersionConflict):
			writeJSON(writer, http.StatusConflict, map[string]any{
				"error": "the name was changed by another session; reload and try again",
				"code":  "display_name_version_conflict",
			})
		case errors.Is(err, repository.ErrCredentialDisplayNameInvalid):
			writeError(writer, http.StatusBadRequest, err.Error())
		default:
			writeError(writer, http.StatusInternalServerError, "failed to store the name")
		}
		return
	}
	_ = h.recordAudit(request, action, "auth_file", name, "success", nil)
	writeJSON(writer, http.StatusOK, map[string]any{
		"status":               "ok",
		"display_name":         stored.DisplayName,
		"display_name_version": stored.Version,
	})
}
