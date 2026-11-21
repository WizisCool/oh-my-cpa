package api

import (
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"unicode"

	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/configyaml"
	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/management"
	"github.com/oh-my-cpa/oh-my-cpa/internal/release"
	"github.com/oh-my-cpa/oh-my-cpa/internal/security"
	"gopkg.in/yaml.v3"
)

const maxGitHubTokenBytes = 512

// GitHubTokenStatusDTO reports whether CPA's server.github-token is configured
// without ever returning the raw secret.
type GitHubTokenStatusDTO struct {
	Configured  bool   `json:"configured"`
	MaskedToken string `json:"masked_token,omitempty"`
	CPARevision string `json:"cpa_revision"`
}

type gitHubTokenInput struct {
	Token       string `json:"token"`
	CPARevision string `json:"cpa_revision"`
}

type gitHubTokenTestInput struct {
	Token string `json:"token,omitempty"`
}

// GitHubTokenTestResponseDTO returns the live GitHub /rate_limit probe result.
type GitHubTokenTestResponseDTO struct {
	Status        string `json:"status"`
	Authenticated bool   `json:"authenticated"`
	Limit         int    `json:"limit,omitempty"`
	Remaining     int    `json:"remaining,omitempty"`
	Used          int    `json:"used,omitempty"`
	ResetAtMS     *int64 `json:"reset_at_ms,omitempty"`
	Message       string `json:"message,omitempty"`
}

func validateGitHubToken(token string) error {
	if token == "" {
		return nil
	}
	if len(token) > maxGitHubTokenBytes {
		return errors.New("GitHub token is too long")
	}
	for _, r := range token {
		if unicode.IsSpace(r) || unicode.IsControl(r) {
			return errors.New("GitHub token must not contain whitespace or control characters")
		}
	}
	return nil
}

func extractGitHubTokenFromYAML(rawYAML string) (string, error) {
	var document map[string]any
	if err := yaml.Unmarshal([]byte(rawYAML), &document); err != nil {
		return "", err
	}
	raw, _ := management.ValueAt(document, []string{"server", "github-token"})
	value, _ := raw.(string)
	return strings.TrimSpace(value), nil
}

func projectGitHubTokenStatus(token, cpaRevision string) GitHubTokenStatusDTO {
	trimmed := strings.TrimSpace(token)
	return GitHubTokenStatusDTO{
		Configured:  trimmed != "",
		MaskedToken: security.MaskSecret(trimmed),
		CPARevision: cpaRevision,
	}
}

// @Summary Get GitHub token configuration status
// @Description Return whether CPA's server.github-token is configured, its redacted mask, and the current CPA configuration revision.
// @Tags Config
// @Produce json
// @Security CookieAuth
// @Success 200 {object} GitHubTokenStatusDTO
// @Failure 401 {object} ErrorResponseDTO
// @Failure 502 {object} ErrorResponseDTO
// @Router /v1/management/github-token [get]
func (h *Handler) getGitHubToken(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	client, ok := h.managementClientOrError(writer, request)
	if !ok {
		return
	}
	rawYAML, err := client.ConfigYAML(request.Context())
	if err != nil {
		writeCPAFacadeError(writer, err)
		return
	}
	token, err := extractGitHubTokenFromYAML(rawYAML)
	if err != nil {
		writeError(writer, http.StatusBadGateway, "could not parse CPA configuration")
		return
	}
	writeJSON(writer, http.StatusOK, projectGitHubTokenStatus(token, configyaml.ComputeRevision(rawYAML)))
}

// @Summary Update or clear GitHub token
// @Description Set, replace, or clear CPA's server.github-token under revision check, pre-write backup, and audit logging, immediately invalidating OMC's in-memory token cache.
// @Tags Config
// @Accept json
// @Produce json
// @Security CookieAuth
// @Param If-Match header string false "Expected CPA configuration revision"
// @Param body body gitHubTokenInput true "GitHub token payload (empty token clears server.github-token)"
// @Success 200 {object} GitHubTokenStatusDTO
// @Failure 400 {object} ErrorResponseDTO
// @Failure 401 {object} ErrorResponseDTO
// @Failure 409 {object} ErrorResponseDTO
// @Failure 500 {object} ErrorResponseDTO
// @Failure 502 {object} ErrorResponseDTO
// @Failure 503 {object} ErrorResponseDTO
// @Router /v1/management/github-token [put]
func (h *Handler) putGitHubToken(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	var input gitHubTokenInput
	if err := decodeManagementJSON(writer, request, 4096, &input); err != nil {
		return
	}
	token := strings.TrimSpace(input.Token)
	if err := validateGitHubToken(token); err != nil {
		writeJSON(writer, http.StatusBadRequest, map[string]string{"error": err.Error(), "code": "invalid_github_token"})
		return
	}
	expectedRev := requestedConfigRevision(request, input.CPARevision)
	if expectedRev == "" {
		writeMissingRevision(writer)
		return
	}
	client, ok := h.managementClientOrError(writer, request)
	if !ok {
		return
	}
	if err := h.providerWrites.acquire(request.Context()); err != nil {
		writeProviderWriteError(writer, err)
		return
	}
	defer h.providerWrites.release()
	h.configMu.Lock()
	defer h.configMu.Unlock()

	currentYAML, ok := h.currentConfigAtRevision(writer, request, client, expectedRev)
	if !ok {
		return
	}
	action := "github_token.save"
	change := management.ConfigChange{Path: []string{"server", "github-token"}, Value: token}
	if token == "" {
		action = "github_token.clear"
		change = management.ConfigChange{Path: []string{"server", "github-token"}, Remove: true}
	}
	if err := h.recordAudit(request, action, "config", "github_token", "attempt", nil); err != nil {
		writeError(writer, http.StatusInternalServerError, "audit log failure; GitHub token save aborted")
		return
	}
	if err := client.ApplyConfigChanges(management.WithBackupReason(request.Context(), management.BackupReasonConfigChanges), []management.ConfigChange{change}); err != nil {
		_ = h.recordAudit(request, action, "config", "github_token", "failure", nil)
		scrubbed := scrubConfigRejection(err, currentYAML)
		if token != "" && scrubbed != nil && strings.Contains(scrubbed.Error(), token) {
			scrubbed = errors.New(strings.ReplaceAll(scrubbed.Error(), token, "[REDACTED]"))
		}
		writeCPAFacadeError(writer, scrubbed)
		return
	}
	h.afterConfigWrite()

	// Derive both readback verification and the returned revision from one YAML snapshot
	// so a concurrent change can never pair one token's mask with another token's revision.
	savedYAML, err := client.ConfigYAML(request.Context())
	if err != nil {
		_ = h.recordAudit(request, action, "config", "github_token", "failure", map[string]any{"cpa_applied": true})
		writeJSON(writer, http.StatusBadGateway, map[string]string{
			"error": "GitHub token was applied to CPA, but readback failed; reload settings",
			"code":  "github_token_cpa_unconfirmed",
		})
		return
	}
	actual, err := extractGitHubTokenFromYAML(savedYAML)
	if err != nil {
		_ = h.recordAudit(request, action, "config", "github_token", "failure", map[string]any{"cpa_applied": true})
		writeJSON(writer, http.StatusBadGateway, map[string]string{
			"error": "GitHub token was applied to CPA, but readback could not be parsed; reload settings",
			"code":  "github_token_cpa_unconfirmed",
		})
		return
	}
	if actual != token {
		_ = h.recordAudit(request, action, "config", "github_token", "failure", map[string]any{"cpa_applied": true})
		writeJSON(writer, http.StatusConflict, map[string]string{"error": "CPA did not retain the GitHub token change; reload settings", "code": "github_token_cpa_mismatch"})
		return
	}
	_ = h.recordAudit(request, action, "config", "github_token", "success", nil)

	writeJSON(writer, http.StatusOK, projectGitHubTokenStatus(actual, configyaml.ComputeRevision(savedYAML)))
}

// @Summary Test GitHub token and query API rate limit
// @Description Probe GitHub's /rate_limit endpoint using an optional candidate token or the currently configured CPA server.github-token (anonymous when unset).
// @Tags Config
// @Accept json
// @Produce json
// @Security CookieAuth
// @Param body body gitHubTokenTestInput false "Optional candidate token to test before saving"
// @Success 200 {object} GitHubTokenTestResponseDTO
// @Failure 400 {object} ErrorResponseDTO
// @Failure 401 {object} ErrorResponseDTO
// @Failure 502 {object} ErrorResponseDTO
// @Router /v1/management/github-token/test [post]
func (h *Handler) testGitHubToken(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	var input gitHubTokenTestInput
	if request.Body != nil {
		raw, err := io.ReadAll(io.LimitReader(request.Body, 4096+1))
		if err != nil {
			writeError(writer, http.StatusBadRequest, "unreadable request body")
			return
		}
		if len(raw) > 4096 {
			writeError(writer, http.StatusRequestEntityTooLarge, "request body too large")
			return
		}
		if strings.TrimSpace(string(raw)) != "" {
			if err := json.Unmarshal(raw, &input); err != nil {
				writeError(writer, http.StatusBadRequest, "invalid JSON payload")
				return
			}
		}
	}
	token := strings.TrimSpace(input.Token)
	if err := validateGitHubToken(token); err != nil {
		writeJSON(writer, http.StatusBadRequest, map[string]string{"error": err.Error(), "code": "invalid_github_token"})
		return
	}
	if token == "" {
		// Read directly from CPA rather than the 5-minute cache so tests reflect recent YAML edits immediately.
		stored, err := h.readReleaseToken(request.Context())
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			writeCPAFacadeError(writer, err)
			return
		}
		token = stored
	}

	probe := release.ProbeGitHubRateLimit(request.Context(), h.outboundTransport, h.githubRateLimitURL, token)
	message := boundedText(security.RedactText(probe.Message), 256)
	if token != "" {
		message = strings.ReplaceAll(message, token, "[REDACTED]")
	}
	writeJSON(writer, http.StatusOK, GitHubTokenTestResponseDTO{
		Status:        probe.Status,
		Authenticated: probe.Authenticated,
		Limit:         probe.Limit,
		Remaining:     probe.Remaining,
		Used:          probe.Used,
		ResetAtMS:     probe.ResetAtMS,
		Message:       message,
	})
}
