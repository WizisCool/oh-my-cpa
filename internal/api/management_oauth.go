package api

import (
	"net/http"
	"strings"

	"github.com/google/uuid"
	"github.com/oh-my-cpa/oh-my-cpa/internal/security"
)

type OAuthProviderDTO struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description"`
}

var supportedOAuthProviders = []OAuthProviderDTO{
	{ID: "codex", Name: "OpenAI Codex / ChatGPT Plus", Description: "Official OpenAI OAuth authorization flow"},
	{ID: "anthropic", Name: "Anthropic Claude", Description: "Anthropic Claude OAuth authentication flow"},
	{ID: "gemini", Name: "Google Gemini", Description: "Google Cloud Gemini OAuth flow"},
	{ID: "vertex", Name: "Google Cloud Vertex AI", Description: "Google Cloud Vertex AI credentials flow"},
}

func (h *Handler) listOAuthProviders(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	writeJSON(writer, http.StatusOK, map[string]any{
		"providers": supportedOAuthProviders,
	})
}

type startOAuthRequest struct {
	Provider string `json:"provider"`
}

func (h *Handler) startOAuthFlow(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	var req startOAuthRequest
	if err := decodeManagementJSON(writer, request, 8*1024, &req); err != nil {
		return
	}
	provider := strings.ToLower(strings.TrimSpace(req.Provider))
	if provider == "" {
		writeError(writer, http.StatusBadRequest, "provider is required")
		return
	}

	client, ok := h.managementClientOrError(writer, request)
	if !ok {
		return
	}

	authURL, err := client.OAuthAuthURL(request.Context(), provider)
	if err != nil {
		_ = h.recordAudit(request, "oauth.start", "oauth_provider", provider, "failure", map[string]any{"error": err.Error()})
		writeCPAFacadeError(writer, err)
		return
	}

	sessionID := uuid.NewString()
	_ = h.recordAudit(request, "oauth.start", "oauth_provider", provider, "success", map[string]any{"session_id": sessionID})

	writeJSON(writer, http.StatusOK, map[string]any{
		"url":        authURL,
		"session_id": sessionID,
		"provider":   provider,
	})
}

func (h *Handler) getOAuthStatus(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	client, ok := h.managementClientOrError(writer, request)
	if !ok {
		return
	}

	sessionID := strings.TrimSpace(request.URL.Query().Get("session_id"))
	resp, err := client.OAuthStatus(request.Context(), sessionID)
	if err != nil {
		writeCPAFacadeError(writer, err)
		return
	}

	writeJSON(writer, http.StatusOK, map[string]any{
		"status":  resp.Status,
		"message": resp.Message,
	})
}

type oauthCallbackRequest struct {
	Code  string `json:"code"`
	State string `json:"state"`
}

func (h *Handler) handleOAuthCallback(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	var req oauthCallbackRequest
	if err := decodeManagementJSON(writer, request, 16*1024, &req); err != nil {
		return
	}
	code := strings.TrimSpace(req.Code)
	state := strings.TrimSpace(req.State)
	if code == "" || state == "" {
		writeError(writer, http.StatusBadRequest, "code and state are required")
		return
	}

	client, ok := h.managementClientOrError(writer, request)
	if !ok {
		return
	}

	if auditErr := h.recordAudit(request, "oauth.callback", "oauth_callback", security.RedactText(state), "attempt", nil); auditErr != nil {
		writeError(writer, http.StatusInternalServerError, "audit failure; callback aborted")
		return
	}

	if err := client.OAuthCallback(request.Context(), code, state); err != nil {
		_ = h.recordAudit(request, "oauth.callback", "oauth_callback", security.RedactText(state), "failure", map[string]any{"error": err.Error()})
		writeCPAFacadeError(writer, err)
		return
	}

	_ = h.recordAudit(request, "oauth.callback", "oauth_callback", security.RedactText(state), "success", nil)

	writeJSON(writer, http.StatusOK, map[string]any{
		"status": "ok",
	})
}

func (h *Handler) cancelOAuthSession(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	sessionID := strings.TrimSpace(request.URL.Query().Get("session_id"))

	client, ok := h.managementClientOrError(writer, request)
	if !ok {
		return
	}

	_ = h.recordAudit(request, "oauth.cancel", "oauth_session", sessionID, "attempt", nil)
	if err := client.CancelOAuthSession(request.Context(), sessionID); err != nil {
		writeCPAFacadeError(writer, err)
		return
	}
	_ = h.recordAudit(request, "oauth.cancel", "oauth_session", sessionID, "success", nil)

	writeJSON(writer, http.StatusOK, map[string]any{
		"status": "ok",
	})
}
