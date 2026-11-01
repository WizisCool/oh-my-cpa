package api

import (
	"errors"
	"net/http"
	"strings"

	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/management"
	"github.com/oh-my-cpa/oh-my-cpa/internal/operations"
)

func (h *Handler) verifyManagementAuthFile(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	var input struct {
		Name      string `json:"name"`
		AuthIndex string `json:"auth_index"`
		Model     string `json:"model,omitempty"`
	}
	if err := decodeManagementJSON(writer, request, managementAuthFileRequestLimit, &input); err != nil {
		return
	}
	if input.Name != "" {
		name, err := validateAuthSelector(input.Name)
		if err != nil {
			writeError(writer, http.StatusBadRequest, "invalid credential target")
			return
		}
		input.Name = name
	}
	input.AuthIndex, input.Model = strings.TrimSpace(input.AuthIndex), strings.TrimSpace(input.Model)
	if (input.Name == "" && input.AuthIndex == "") || len([]rune(input.AuthIndex)) > managementAuthFileNameLimit || len([]rune(input.Model)) > managementAuthFileNameLimit {
		writeError(writer, http.StatusBadRequest, "invalid credential target or model")
		return
	}
	if err := h.recordAudit(request, "auth_file.verify", "auth_file", firstNonEmpty(input.Name, input.AuthIndex), "attempt", nil); err != nil {
		writeError(writer, http.StatusInternalServerError, "audit log failure; verification aborted")
		return
	}
	verified, err := h.operationsService().VerifyCredential(request.Context(), operations.CredentialTarget{Name: input.Name, AuthIndex: input.AuthIndex}, input.Model, "")
	target := firstNonEmpty(input.Name, input.AuthIndex)
	if err != nil {
		detail := map[string]any{}
		var upstream *management.HTTPError
		if errors.As(err, &upstream) {
			detail["cpa_status"] = upstream.StatusCode
		}
		_ = h.recordAudit(request, "auth_file.verify", "auth_file", target, "failure", detail)
		switch err.Error() {
		case "resource_conflict":
			writeError(writer, http.StatusNotFound, "auth file not found")
		case "write_busy":
			writeProviderWriteError(writer, errProviderWriteBusy)
		default:
			writeCPAFacadeError(writer, err)
		}
		return
	}
	// The inference has already run; an outcome-audit failure must not invite
	// a retry that consumes tokens again.
	_ = h.recordAudit(request, "auth_file.verify", "auth_file", target, "success", map[string]any{"verified": verified})
	writeJSON(writer, http.StatusOK, map[string]any{"status": "ok", "verified": verified})
}
