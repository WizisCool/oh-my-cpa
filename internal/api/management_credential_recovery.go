package api

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/management"
	"github.com/oh-my-cpa/oh-my-cpa/internal/operations"
	"github.com/oh-my-cpa/oh-my-cpa/internal/quota"
)

// verifyPostRefreshTimeout caps the best-effort quota refresh after a confirmed
// verify so a slow upstream read or provider gate cannot stall the response,
// while verifyPostRefreshBudget keeps a margin below http.Server.WriteTimeout (30s).
const (
	verifyPostRefreshTimeout      = 3 * time.Second
	verifyPostRefreshAuditTimeout = time.Second
	verifyPostRefreshBudget       = 23 * time.Second
)

// AuthFileVerifyRequestDTO selects a credential and optional model to verify via live inference.
type AuthFileVerifyRequestDTO struct {
	Name      string `json:"name,omitempty"`
	AuthIndex string `json:"auth_index,omitempty"`
	Model     string `json:"model,omitempty"`
}

// AuthFileVerifyResponseDTO reports whether credential inference verification succeeded.
type AuthFileVerifyResponseDTO struct {
	Status   string `json:"status"`
	Verified bool   `json:"verified"`
}

// @Summary Verify a credential via live inference
// @Description Run a minimal verification request against the target credential and optional model.
// @Tags AuthFiles
// @Accept json
// @Produce json
// @Security CookieAuth
// @Param body body AuthFileVerifyRequestDTO true "Credential verification target"
// @Success 200 {object} AuthFileVerifyResponseDTO
// @Failure 400 {object} ErrorResponseDTO
// @Failure 401 {object} ErrorResponseDTO
// @Failure 404 {object} ErrorResponseDTO
// @Failure 409 {object} ErrorResponseDTO
// @Failure 413 {object} ErrorResponseDTO
// @Failure 500 {object} ErrorResponseDTO
// @Failure 502 {object} ErrorResponseDTO
// @Failure 503 {object} ErrorResponseDTO
// @Router /v1/management/auth-files/verify [post]
func (h *Handler) verifyManagementAuthFile(writer http.ResponseWriter, request *http.Request) {
	startedAt := time.Now()
	writer.Header().Set("Cache-Control", "no-store")
	var input AuthFileVerifyRequestDTO
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
	result, err := h.operationsService().VerifyCredential(request.Context(), operations.CredentialTarget{Name: input.Name, AuthIndex: input.AuthIndex}, input.Model, "")
	target := firstNonEmpty(input.Name, input.AuthIndex)
	if err != nil {
		detail := map[string]any{}
		if errors.Is(err, management.ErrVerificationNotApplied) {
			detail["cpa_status"] = http.StatusConflict
			detail["code"] = "verification_not_applied"
		} else {
			var upstream *management.HTTPError
			if errors.As(err, &upstream) {
				detail["cpa_status"] = upstream.StatusCode
			}
		}
		_ = h.recordAudit(request, "auth_file.verify", "auth_file", target, "failure", detail)
		if errors.Is(err, management.ErrVerificationNotApplied) {
			// CPA may have observed a racing cooldown or disabled state during verify;
			// invalidate cached views so the console reloads CPA's current state.
			h.invalidateCoordinator("management-auth-files", "management-quota")
			writeCPAFacadeError(writer, err)
			return
		}
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
	_ = h.recordAudit(request, "auth_file.verify", "auth_file", target, "success", map[string]any{"verified": result.Verified})
	if result.Verified {
		if remaining := verifyPostRefreshBudget - time.Since(startedAt); remaining > 0 {
			h.refreshQuotaAfterVerify(request, result.AuthFile, min(verifyPostRefreshTimeout, remaining))
		}
	}
	h.invalidateCoordinator("management-auth-files", "management-quota")
	writeJSON(writer, http.StatusOK, AuthFileVerifyResponseDTO{Status: "ok", Verified: result.Verified})
}

// refreshQuotaAfterVerify re-reads the credential's quota reading after a
// confirmed operator verify so the stored snapshot and subsequent renders
// reflect the post-verify state CPA now reports. Bounded with its own deadline
// derived from context.WithoutCancel so it neither inherits an early client
// disconnect nor starves http.Server.WriteTimeout on the completed 200 response.
func (h *Handler) refreshQuotaAfterVerify(request *http.Request, file management.AuthFile, timeout time.Duration) {
	authIndex := strings.TrimSpace(file.AuthIndex)
	if authIndex == "" || file.Disabled || timeout <= 0 || !quota.CapabilitiesForFile(file).RefreshSupported {
		return
	}
	refreshCtx, cancel := context.WithTimeout(context.WithoutCancel(request.Context()), timeout)
	defer cancel()
	auditReq := request.WithContext(refreshCtx)
	client, err := h.capabilityClient(refreshCtx)
	if err != nil || client == nil {
		return
	}
	isMeta := quota.DetectProvider(file.Type, file.Provider) == "meta"
	if isMeta {
		// Meta's quota read can mint a key; keep its fail-closed audit gate.
		if err := h.recordAudit(auditReq, "quota.refresh", "quota", authIndex, "attempt", map[string]any{
			"provider":        "meta",
			"upstream_action": "key_exchange",
		}); err != nil {
			return
		}
	}
	prior := h.loadPriorNormalizedQuota(refreshCtx, authIndex)
	refreshed, err := h.refreshQuotaReadingWithoutCooldownRelease(refreshCtx, h.newQuotaService(client), file, prior)
	if err == nil && refreshed != nil && !refreshed.IsDeferred {
		_ = h.persistNormalizedQuotaSnapshot(refreshCtx, refreshed)
	}
	if isMeta {
		outcome := "success"
		details := map[string]any{}
		if err != nil || refreshed == nil || refreshed.Error != "" {
			outcome = "failure"
		}
		if refreshed != nil {
			details["status"] = refreshed.Status
		}
		outcomeCtx, outcomeCancel := context.WithTimeout(context.WithoutCancel(request.Context()), verifyPostRefreshAuditTimeout)
		defer outcomeCancel()
		_ = h.recordAudit(request.WithContext(outcomeCtx), "quota.refresh", "quota", authIndex, outcome, details)
	}
}
