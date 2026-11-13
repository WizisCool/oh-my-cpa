package api

import (
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
)

// clientKeyAliasRequest is the wire body for naming or clearing one key.
//
// The identity travels as the canonical usage fingerprint rather than an array
// index, so a request that arrives after CPA's `api-keys` list was reordered
// still names the key the operator selected. `version` is the version the client
// read; it is what turns a concurrent rename into a 409 instead of a silent
// overwrite.
type clientKeyAliasRequest struct {
	KeyFingerprint string `json:"key_fingerprint"`
	Alias          string `json:"alias"`
	Version        int64  `json:"version"`
}

// ClientKeyAliasesResponseDTO maps usage key fingerprints to operator-assigned aliases.
type ClientKeyAliasesResponseDTO struct {
	Aliases map[string]repository.ClientKeyAlias `json:"aliases"`
}

// ClientKeyAliasPutResponseDTO returns the persisted client key alias record.
type ClientKeyAliasPutResponseDTO struct {
	Status string                    `json:"status"`
	Alias  repository.ClientKeyAlias `json:"alias"`
}

// ClientKeyUsageResponseDTO returns per-key usage aggregates for a dashboard time window.
type ClientKeyUsageResponseDTO struct {
	Window dashboardWindow             `json:"window"`
	Usage  []repository.ClientKeyUsage `json:"usage"`
}

// listClientKeyAliases returns every stored alias for the instance.
//
// This is management metadata only: it carries no key material, so it is an
// ordinary authenticated read. The console joins it to the key list from CPA by
// fingerprint.
//
// @Summary List client key aliases
// @Description Return all local operator-assigned aliases keyed by usage fingerprint.
// @Tags ClientKeys
// @Produce json
// @Security CookieAuth
// @Success 200 {object} ClientKeyAliasesResponseDTO
// @Failure 401 {object} ErrorResponseDTO
// @Failure 500 {object} ErrorResponseDTO
// @Failure 503 {object} ErrorResponseDTO
// @Router /v1/management/client-key-aliases [get]
func (h *Handler) listClientKeyAliases(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	if h.repo == nil {
		writeError(writer, http.StatusServiceUnavailable, "database is unavailable")
		return
	}
	aliases, err := h.repo.ListClientKeyAliases(request.Context(), defaultInstanceID())
	if err != nil {
		writeError(writer, http.StatusInternalServerError, "failed to read client key aliases")
		return
	}
	writeJSON(writer, http.StatusOK, ClientKeyAliasesResponseDTO{Aliases: aliases})
}

// putClientKeyAlias names or clears one key.
//
// This is deliberately separate from the configuration write path. Naming a key
// changes only Oh My CPA's own metadata, so it must not rewrite CPA's
// `api-keys` list: doing so would rotate the revision, invalidate every other
// editor's baseline, and rewrite a secret the operator did not touch.
//
// The write is audited fail-closed, like the other identity operations. The alias
// text itself is not copied into the audit details - it is operator-supplied
// prose, and the fingerprint already identifies the row.
//
// @Summary Set or clear a client key alias
// @Description Assign or clear a local display alias for a caller key fingerprint with optimistic version locking.
// @Tags ClientKeys
// @Accept json
// @Produce json
// @Security CookieAuth
// @Param body body clientKeyAliasRequest true "Client key alias payload"
// @Success 200 {object} ClientKeyAliasPutResponseDTO
// @Failure 400 {object} ErrorResponseDTO
// @Failure 401 {object} ErrorResponseDTO
// @Failure 409 {object} ErrorResponseDTO
// @Failure 500 {object} ErrorResponseDTO
// @Failure 503 {object} ErrorResponseDTO
// @Router /v1/management/client-key-aliases [put]
func (h *Handler) putClientKeyAlias(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	if h.repo == nil {
		writeError(writer, http.StatusServiceUnavailable, "database is unavailable")
		return
	}
	var req clientKeyAliasRequest
	if err := decodeManagementJSON(writer, request, 8*1024, &req); err != nil {
		return
	}
	fingerprint := strings.TrimSpace(req.KeyFingerprint)
	if fingerprint == "" {
		writeError(writer, http.StatusBadRequest, "key_fingerprint is required")
		return
	}
	// Validate before auditing so a rejected alias never leaves an audit record
	// for a write that could not have happened.
	normalized, err := repository.NormalizeClientKeyAlias(req.Alias)
	if err != nil {
		writeError(writer, http.StatusBadRequest, err.Error())
		return
	}

	target := "client_key_alias:" + fingerprint
	action := "client_key.alias_set"
	if normalized == "" {
		action = "client_key.alias_clear"
	}
	if auditErr := h.recordAudit(request, action, "client_key", target, "attempt", nil); auditErr != nil {
		writeError(writer, http.StatusInternalServerError, "audit log failure; alias change aborted")
		return
	}

	stored, err := h.repo.SetClientKeyAlias(request.Context(), defaultInstanceID(), fingerprint, normalized, req.Version)
	if err != nil {
		_ = h.recordAudit(request, action, "client_key", target, "failure", map[string]any{"error": err.Error()})
		switch {
		case errors.Is(err, repository.ErrClientKeyAliasVersionConflict):
			// 409 with the stored version so the console can reload and retry
			// against the current state instead of guessing.
			writeJSON(writer, http.StatusConflict, map[string]any{
				"error":  "the alias was changed by another session; reload and try again",
				"code":   "alias_version_conflict",
				"alias":  stored,
				"detail": err.Error(),
			})
		case errors.Is(err, repository.ErrClientKeyAliasInvalid):
			writeError(writer, http.StatusBadRequest, err.Error())
		default:
			writeError(writer, http.StatusInternalServerError, "failed to store the alias")
		}
		return
	}

	_ = h.recordAudit(request, action, "client_key", target, "success", map[string]any{"cleared": normalized == ""})
	writeJSON(writer, http.StatusOK, ClientKeyAliasPutResponseDTO{Status: "ok", Alias: stored})
}

// clientKeyUsage returns per-key request counts and last-use times.
//
// The numbers come from Oh My CPA's own retained usage events, never from CPA, so
// they describe what this console has actually observed. A key with no observed
// requests reports zero rather than a guessed creation date: CPA publishes no
// such date, and inventing one would be a fact the system does not have.
//
// @Summary Get per-key usage summary
// @Description Return observed request counts and last-use timestamps grouped by client key fingerprint.
// @Tags ClientKeys
// @Produce json
// @Security CookieAuth
// @Param preset query string false "Time range preset"
// @Param from query integer false "Custom window start timestamp in Unix milliseconds"
// @Param to query integer false "Custom window end timestamp in Unix milliseconds"
// @Success 200 {object} ClientKeyUsageResponseDTO
// @Failure 400 {object} ErrorResponseDTO
// @Failure 401 {object} ErrorResponseDTO
// @Failure 500 {object} ErrorResponseDTO
// @Failure 503 {object} ErrorResponseDTO
// @Router /v1/management/client-key-usage [get]
func (h *Handler) clientKeyUsage(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	if h.repo == nil {
		writeError(writer, http.StatusServiceUnavailable, "database is unavailable")
		return
	}
	// The window mirrors the request console's default so the two surfaces cannot
	// disagree about the same key.
	window, windowErr := dashboardWindowFromRequest(request, time.Now().UTC())
	if windowErr != "" {
		writeError(writer, http.StatusBadRequest, windowErr)
		return
	}
	usage, err := h.repo.ClientKeyUsage(request.Context(), defaultInstanceID(), window.FromMS, window.ToMS)
	if err != nil {
		writeError(writer, http.StatusInternalServerError, "failed to read client key usage")
		return
	}
	writeJSON(writer, http.StatusOK, ClientKeyUsageResponseDTO{
		Window: window,
		Usage:  usage,
	})
}

// deleteClientKeyAlias removes one alias by fingerprint.
//
// Provided as its own route so clearing a name from a table row does not need the
// caller to know that an empty alias string is how the same state is expressed.
//
// @Summary Delete a client key alias
// @Description Clear the local alias for a client API key fingerprint with optional optimistic version check.
// @Tags ClientKeys
// @Produce json
// @Security CookieAuth
// @Param fingerprint path string true "Usage key fingerprint"
// @Param version query integer false "Expected alias version for optimistic locking"
// @Success 200 {object} StatusOKResponseDTO
// @Failure 400 {object} ErrorResponseDTO
// @Failure 401 {object} ErrorResponseDTO
// @Failure 409 {object} ErrorResponseDTO
// @Failure 500 {object} ErrorResponseDTO
// @Failure 503 {object} ErrorResponseDTO
// @Router /v1/management/client-key-aliases/{fingerprint} [delete]
func (h *Handler) deleteClientKeyAlias(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	if h.repo == nil {
		writeError(writer, http.StatusServiceUnavailable, "database is unavailable")
		return
	}
	fingerprint := strings.TrimSpace(chi.URLParam(request, "fingerprint"))
	if fingerprint == "" {
		writeError(writer, http.StatusBadRequest, "key fingerprint is required")
		return
	}
	// Version arrives as a query parameter so a conditional clear can be issued
	// without a body, matching how the console already sends its deletes.
	expectedVersion := int64(0)
	if raw := strings.TrimSpace(request.URL.Query().Get("version")); raw != "" {
		parsed, parseErr := strconv.ParseInt(raw, 10, 64)
		if parseErr != nil || parsed < 0 {
			writeError(writer, http.StatusBadRequest, "version must be a non-negative integer")
			return
		}
		expectedVersion = parsed
	}

	target := "client_key_alias:" + fingerprint
	if auditErr := h.recordAudit(request, "client_key.alias_clear", "client_key", target, "attempt", nil); auditErr != nil {
		writeError(writer, http.StatusInternalServerError, "audit log failure; alias change aborted")
		return
	}
	if _, err := h.repo.SetClientKeyAlias(request.Context(), defaultInstanceID(), fingerprint, "", expectedVersion); err != nil {
		_ = h.recordAudit(request, "client_key.alias_clear", "client_key", target, "failure", map[string]any{"error": err.Error()})
		if errors.Is(err, repository.ErrClientKeyAliasVersionConflict) {
			writeJSON(writer, http.StatusConflict, map[string]any{
				"error": "the alias was changed by another session; reload and try again",
				"code":  "alias_version_conflict",
			})
			return
		}
		if errors.Is(err, repository.ErrClientKeyAliasInvalid) {
			writeError(writer, http.StatusBadRequest, err.Error())
			return
		}
		writeError(writer, http.StatusInternalServerError, "failed to clear the alias")
		return
	}
	_ = h.recordAudit(request, "client_key.alias_clear", "client_key", target, "success", nil)
	writeJSON(writer, http.StatusOK, StatusOKResponseDTO{Status: "ok"})
}
