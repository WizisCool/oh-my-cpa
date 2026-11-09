package api

import (
	"errors"
	"net/http"
	"strings"

	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/management"
)

func (h *Handler) codexResetPolicy(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	authIndex := strings.TrimSpace(request.URL.Query().Get("auth_index"))
	if authIndex == "" {
		writeError(writer, http.StatusBadRequest, "auth_index is required")
		return
	}
	var consent *management.CodexResetConsent
	if request.Method == http.MethodPut {
		consent = &management.CodexResetConsent{}
		if err := decodeManagementJSON(writer, request, 8*1024, consent); err != nil {
			return
		}
		if !consent.Valid() {
			writeError(writer, http.StatusBadRequest, "account_key, enabled and before_expiry_seconds (60..86400) are required")
			return
		}
		if err := h.providerWrites.acquire(request.Context()); err != nil {
			writeProviderWriteError(writer, err)
			return
		}
		defer h.providerWrites.release()
		if err := h.recordAudit(request, "quota.codex_reset_policy", "quota", authIndex, "attempt", map[string]any{
			"enabled": *consent.Enabled, "before_expiry_seconds": consent.BeforeExpirySeconds,
		}); err != nil {
			writeError(writer, http.StatusInternalServerError, "audit failure; reset policy change aborted")
			return
		}
	}
	client, ok := h.managementClientOrError(writer, request)
	if !ok {
		return
	}
	state, err := client.CodexResetPolicy(request.Context(), authIndex, consent)
	if consent != nil {
		result := "success"
		if err != nil {
			result = "failure"
		}
		_ = h.recordAudit(request, "quota.codex_reset_policy", "quota", authIndex, result, nil)
	}
	if err != nil {
		// Never forward native error bodies: even rejected requests can quote secrets.
		status := http.StatusBadGateway
		code := "codex_reset_unavailable"
		var upstream *management.HTTPError
		if errors.As(err, &upstream) {
			switch upstream.StatusCode {
			case 404, 405, 501:
				status, code = http.StatusNotImplemented, "capability_missing"
			case 400, 409, 503:
				status = upstream.StatusCode
			}
		}
		writeJSON(writer, status, map[string]string{"error": "Codex reset policy unavailable; reload before changing consent", "code": code})
		return
	}
	writeJSON(writer, http.StatusOK, state)
}
