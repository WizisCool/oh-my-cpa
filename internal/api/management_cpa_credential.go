package api

import (
	"database/sql"
	"errors"
	"net/http"
	"strings"
)

// The console mirrors CPA's management credential into the browser storage CPAMC keeps
// its connection state in, so a plugin page written for CPAMC finds the credential it
// expects where it expects it (issue #536). This endpoint is that mirror's only source:
// ordinary responses, logs and preferences keep the key out, and the plugin host still
// judges a page's own credential before CPA is called.
//
// The read is a credential reveal and is audited as one; a read whose audit cannot be
// written answers nothing. A browser that cannot store the value simply leaves the
// plugin to ask for its own sign-in.
func (h *Handler) getCPACredential(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	instance, err := h.repo.GetInstance(request.Context(), defaultInstanceID())
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) || strings.Contains(err.Error(), sql.ErrNoRows.Error()) {
			writeError(writer, http.StatusServiceUnavailable, "default CPA instance is not configured")
			return
		}
		writeInternalError(writer, err)
		return
	}
	key, err := h.cipher.Decrypt(instance.ManagementKeyCiphertext, instance.ManagementKeyNonce)
	if err != nil {
		writeInternalError(writer, err)
		return
	}
	defer clearBytes(key)
	if auditErr := h.recordAudit(request, "cpa_credential.reveal", "cpa_instance", defaultInstanceID(), "success", nil); auditErr != nil {
		writeAuditFailure(writer, "audit log failure; credential read aborted")
		return
	}
	writeJSON(writer, http.StatusOK, map[string]string{"management_key": string(key)})
}
