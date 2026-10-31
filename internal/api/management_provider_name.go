package api

import (
	"context"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/management"
	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
)

// putManagementProviderName names one provider row or clears its name.
//
// The name is Oh My CPA's own overlay, so this never writes CPA's configuration:
// renaming a row from the list must not rewrite the gateway's entry, which for an
// OpenAI-compatible provider is the label CPA's usage records carry. A cleared
// name falls back to the gateway's own name or the family's default.
//
// Rows are addressed by position, so the write is admitted through the same
// window as provider saves and deletes, and the row must still be the one the
// operator saw: a delete that shifted it turns the rename into a conflict rather
// than relabelling its neighbour. Like a credential rename it is audited
// fail-closed, and the name stays out of the audit details.
func (h *Handler) putManagementProviderName(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	if h.repo == nil {
		writeError(writer, http.StatusServiceUnavailable, "database is unavailable")
		return
	}
	var payload struct {
		Name              string `json:"name"`
		ExpectedAuthIndex string `json:"expected_auth_index,omitempty"`
		ExpectedName      string `json:"expected_name,omitempty"`
	}
	if err := decodeManagementJSON(writer, request, 8*1024, &payload); err != nil {
		return
	}
	id := strings.TrimSpace(chi.URLParam(request, "id"))
	family, index, err := parseProviderID(id)
	if err != nil || index < 0 {
		writeError(writer, http.StatusBadRequest, "invalid provider id")
		return
	}
	name, err := repository.NormalizeCredentialDisplayName(payload.Name)
	if err != nil {
		writeError(writer, http.StatusBadRequest, err.Error())
		return
	}
	client, ok := h.managementClientOrError(writer, request)
	if !ok {
		return
	}

	action := "provider.name_set"
	if name == "" {
		action = "provider.name_clear"
	}
	if auditErr := h.recordAudit(request, action, "provider", id, "attempt", nil); auditErr != nil {
		writeAuditFailure(writer, "audit log failure; rename aborted")
		return
	}
	precondition := patchProviderStatusRequest{ExpectedAuthIndex: payload.ExpectedAuthIndex, ExpectedName: payload.ExpectedName}
	if err := h.writeProviderName(request.Context(), client, id, family, index, name, precondition); err != nil {
		_ = h.recordAudit(request, action, "provider", id, "failure", map[string]any{"error": err.Error()})
		writeProviderWriteError(writer, err)
		return
	}
	_ = h.recordAudit(request, action, "provider", id, "success", nil)
	writeJSON(writer, http.StatusOK, map[string]any{"status": "ok", "id": id, "name": name})
}

// writeProviderName checks the row still exists as the operator saw it and then
// replaces its entry in the name overlay, all inside the provider write window.
func (h *Handler) writeProviderName(ctx context.Context, client *management.Client, id, family string, index int, name string, precondition patchProviderStatusRequest) error {
	if err := h.providerWrites.acquire(ctx); err != nil {
		return err
	}
	defer h.providerWrites.release()

	if spec, ok := lookupProviderConfigFamily(family); ok {
		entries, err := client.ConfigAPIKeys(ctx, spec.Family)
		if err != nil {
			return err
		}
		if index >= len(entries) {
			return newProviderWriteError(http.StatusNotFound, "provider index out of bounds")
		}
		if err := precondition.verifyAuthIndex(entries[index].AuthIndex); err != nil {
			return err
		}
	} else {
		response, err := client.OpenAICompatibility(ctx)
		if err != nil {
			return err
		}
		if index >= len(response.Entries) {
			return newProviderWriteError(http.StatusNotFound, "provider index out of bounds")
		}
		if err := precondition.verifyName(response.Entries[index].Name); err != nil {
			return err
		}
	}

	// A local failure is reported as one, not through the CPA facade's translation.
	names, err := h.loadProviderNamesStrict(ctx)
	if err != nil {
		return newProviderWriteError(http.StatusInternalServerError, "failed to read provider names")
	}
	if names[id] == name {
		return nil
	}
	if name == "" {
		delete(names, id)
	} else {
		names[id] = name
	}
	if err := h.saveStringPreferences(ctx, map[string]map[string]string{repository.PreferenceProviderNames: names}); err != nil {
		return newProviderWriteError(http.StatusInternalServerError, "failed to store the name")
	}
	return nil
}
