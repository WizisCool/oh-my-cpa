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
