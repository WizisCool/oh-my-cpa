package api

import (
	"net/http"
	"strings"
	"time"
)

type QuotaItemDTO struct {
	AuthIndex        string                                `json:"auth_index"`
	Name             string                                `json:"name"`
	Type             string                                `json:"type"`
	Provider         string                                `json:"provider"`
	Quota            *managementQuotaObservation           `json:"quota,omitempty"`
	ModelQuotas      map[string]managementQuotaObservation `json:"model_quotas,omitempty"`
	QuotaExceeded    bool                                  `json:"quota_exceeded"`
	QuotaReason      string                                `json:"quota_reason,omitempty"`
	NextRecoverAtMS  *int64                                `json:"next_recover_at_ms,omitempty"`
	NextRetryAfterMS *int64                                `json:"next_retry_after_ms,omitempty"`
}

func (h *Handler) getQuotaOverview(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	client, ok := h.managementClientOrError(writer, request)
	if !ok {
		return
	}

	ctx := request.Context()
	filesResp, err := client.AuthFiles(ctx)
	if err != nil {
		writeCPAFacadeError(writer, err)
		return
	}

	items := make([]QuotaItemDTO, 0)
	for _, file := range filesResp.Files {
		authIndex := strings.TrimSpace(file.AuthIndex)
		if authIndex == "" {
			continue
		}

		item := QuotaItemDTO{
			AuthIndex:   authIndex,
			Name:        file.Name,
			Type:        file.Type,
			Provider:    file.Provider,
			Quota:       projectQuota(file.Quota),
			ModelQuotas: projectModelQuotas(file.ModelQuotas),
		}

		// Check repository for correlated recent quota errors
		if h.repo != nil {
			nowMS := time.Now().UnixMilli()
			if correlated, err := h.repo.CorrelatedErrorEvents(ctx, authIndex, nowMS, 24*60*60*1000); err == nil {
				for _, errRow := range correlated {
					if errRow.QuotaExceeded {
						item.QuotaExceeded = true
						item.QuotaReason = errRow.QuotaReason
						item.NextRecoverAtMS = errRow.NextRecoverAtMS
						item.NextRetryAfterMS = errRow.NextRetryAfterMS
						break
					}
				}
			}
		}

		items = append(items, item)
	}

	writeJSON(writer, http.StatusOK, map[string]any{
		"quotas": items,
		"total":  len(items),
	})
}

type resetQuotaRequest struct {
	AuthIndex string `json:"auth_index"`
}

func (h *Handler) resetCredentialQuota(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	var req resetQuotaRequest
	if err := decodeManagementJSON(writer, request, 8*1024, &req); err != nil {
		return
	}

	authIndex := strings.TrimSpace(req.AuthIndex)
	if authIndex == "" {
		writeError(writer, http.StatusBadRequest, "auth_index is required")
		return
	}

	client, ok := h.managementClientOrError(writer, request)
	if !ok {
		return
	}

	if auditErr := h.recordAudit(request, "quota.reset", "quota", authIndex, "attempt", nil); auditErr != nil {
		writeError(writer, http.StatusInternalServerError, "audit failure; quota reset aborted")
		return
	}

	if err := client.ResetQuota(request.Context(), authIndex); err != nil {
		_ = h.recordAudit(request, "quota.reset", "quota", authIndex, "failure", map[string]any{"error": err.Error()})
		writeCPAFacadeError(writer, err)
		return
	}

	_ = h.recordAudit(request, "quota.reset", "quota", authIndex, "success", nil)

	writeJSON(writer, http.StatusOK, map[string]any{
		"status":     "ok",
		"auth_index": authIndex,
	})
}
