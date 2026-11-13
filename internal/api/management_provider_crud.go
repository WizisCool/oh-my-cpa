package api

import (
	"errors"
	"net/http"

	"github.com/go-chi/chi/v5"
)

// notifyPricingAfterPartialCommit keeps the pricing catalogue in step with a
// provider write that CPA accepted even though the local overlay failed. The
// normal success path notifies once after the gated write returns; this branch
// covers the partial-commit return before that point.
func (h *Handler) notifyPricingAfterPartialCommit(err error) {
	if h.pricing == nil {
		return
	}
	var partialErr *providerPartialCommitError
	if errors.As(err, &partialErr) {
		h.pricing.NotifyModelsChanged()
	}
}

// ProviderMutationResponseDTO reports the outcome of creating, updating, or deleting a provider entry.
type ProviderMutationResponseDTO struct {
	Status string   `json:"status"`
	Family string   `json:"family,omitempty"`
	ID     string   `json:"id"`
	IDs    []string `json:"ids,omitempty"`
}

// @Summary Create a provider entry
// @Description Add a new upstream AI provider entry to CPA configuration and save local display metadata.
// @Tags Providers
// @Accept json
// @Produce json
// @Security CookieAuth
// @Param body body SaveProviderRequest true "Provider configuration"
// @Success 200 {object} ProviderMutationResponseDTO
// @Failure 400 {object} ErrorResponseDTO
// @Failure 401 {object} ErrorResponseDTO
// @Failure 409 {object} ErrorResponseDTO
// @Failure 500 {object} ErrorResponseDTO
// @Failure 502 {object} ErrorResponseDTO
// @Failure 503 {object} ErrorResponseDTO
// @Router /v1/management/providers [post]
func (h *Handler) createManagementProvider(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	var req SaveProviderRequest
	if err := decodeManagementJSON(writer, request, 32*1024, &req); err != nil {
		return
	}
	client, ok := h.managementClientOrError(writer, request)
	if !ok {
		return
	}
	result, err := h.createProvider(request.Context(), client, req, func(action, targetType, targetID, result string, details map[string]any) error {
		return h.recordAudit(request, action, targetType, targetID, result, details)
	})
	if err != nil {
		writeProviderWriteError(writer, err)
		return
	}
	writeJSON(writer, 200, result)
}

// @Summary Update a provider entry
// @Description Update an existing upstream AI provider entry by positional ID.
// @Tags Providers
// @Accept json
// @Produce json
// @Security CookieAuth
// @Param id path string true "Provider ID (e.g. openai-compatibility-0 or claude-0)"
// @Param body body SaveProviderRequest true "Updated provider configuration"
// @Success 200 {object} ProviderMutationResponseDTO
// @Failure 400 {object} ErrorResponseDTO
// @Failure 401 {object} ErrorResponseDTO
// @Failure 404 {object} ErrorResponseDTO
// @Failure 409 {object} ErrorResponseDTO
// @Failure 500 {object} ErrorResponseDTO
// @Failure 502 {object} ErrorResponseDTO
// @Failure 503 {object} ErrorResponseDTO
// @Router /v1/management/providers/{id} [put]
func (h *Handler) updateManagementProvider(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	id := chi.URLParam(request, "id")
	_, index, err := parseProviderID(id)
	if err != nil || index < 0 {
		writeError(writer, 400, "invalid provider id")
		return
	}
	var req SaveProviderRequest
	if err := decodeManagementJSON(writer, request, 32*1024, &req); err != nil {
		return
	}
	client, ok := h.managementClientOrError(writer, request)
	if !ok {
		return
	}
	result, err := h.updateProvider(request.Context(), client, id, req, func(action, targetType, targetID, result string, details map[string]any) error {
		return h.recordAudit(request, action, targetType, targetID, result, details)
	})
	if err != nil {
		writeProviderWriteError(writer, err)
		return
	}
	writeJSON(writer, 200, result)
}

// @Summary Delete a provider entry
// @Description Archive provider identity metadata and delete the configured provider entry by positional ID.
// @Tags Providers
// @Produce json
// @Security CookieAuth
// @Param id path string true "Provider ID"
// @Success 200 {object} ProviderMutationResponseDTO
// @Failure 400 {object} ErrorResponseDTO
// @Failure 401 {object} ErrorResponseDTO
// @Failure 404 {object} ErrorResponseDTO
// @Failure 409 {object} ErrorResponseDTO
// @Failure 500 {object} ErrorResponseDTO
// @Failure 502 {object} ErrorResponseDTO
// @Failure 503 {object} ErrorResponseDTO
// @Router /v1/management/providers/{id} [delete]
func (h *Handler) deleteManagementProvider(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	id := chi.URLParam(request, "id")
	_, index, err := parseProviderID(id)
	if err != nil || index < 0 {
		writeError(writer, 400, "invalid provider id")
		return
	}
	client, ok := h.managementClientOrError(writer, request)
	if !ok {
		return
	}
	result, err := h.deleteProvider(request.Context(), client, id, func(action, targetType, targetID, result string, details map[string]any) error {
		return h.recordAudit(request, action, targetType, targetID, result, details)
	})
	if err != nil {
		writeProviderWriteError(writer, err)
		return
	}
	writeJSON(writer, 200, result)
}
