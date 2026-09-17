package api

import (
	"net/http"
	"regexp"
	"strings"

	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/management"
	"github.com/oh-my-cpa/oh-my-cpa/internal/security"
)

var oauthProviderPattern = regexp.MustCompile(`^[a-z0-9-]+$`)

// OAuthProviderDTO is the facade's view of a built-in authorization. It is a
// projection of the CPA contract registry: the provider table lives next to the
// client that calls it, so the list the browser reads and the requests the
// facade sends cannot disagree about which providers exist.
type OAuthProviderDTO struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description"`
	// Flow is "redirect" or "device", the shape the card has to render. CPA
	// reports the same value when a flow starts; this one lets the console
	// describe it before anything is started.
	Flow string `json:"flow"`
}

// supportedOAuthProviders projects the built-in registry.
//
// It is not the set of accepted provider ids: CPA plugins register their own
// `{provider}-auth-url` routes, and the console forwards those ids through
// unchanged. This list is what the facade advertises as built in.
func supportedOAuthProviders() []OAuthProviderDTO {
	providers := make([]OAuthProviderDTO, 0, len(management.OAuthProviders))
	for _, provider := range management.OAuthProviders {
		providers = append(providers, OAuthProviderDTO{
			ID:          provider.ID,
			Name:        provider.Name,
			Description: provider.Description,
			Flow:        string(provider.Flow),
		})
	}
	return providers
}

func (h *Handler) listOAuthProviders(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	writeJSON(writer, http.StatusOK, map[string]any{
		"providers": supportedOAuthProviders(),
	})
}

type startOAuthRequest struct {
	Provider string `json:"provider"`
}

// normalizeOAuthStatus maps CPA get-auth-status variants to one facade
// contract: "ok" (completed), "wait" (in flight), "error" (failed).
// CPA answers "ok"/"wait" officially; older fixtures and forks use the
// "success"/"pending" aliases, which must not be treated as failures.
func normalizeOAuthStatus(status string) string {
	switch strings.ToLower(strings.TrimSpace(status)) {
	case "ok", "success":
		return "ok"
	case "error", "failed", "failure":
		return "error"
	default:
		return "wait"
	}
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
	if !oauthProviderPattern.MatchString(provider) {
		writeError(writer, http.StatusBadRequest, "invalid provider format")
		return
	}

	client, ok := h.managementClientOrError(writer, request)
	if !ok {
		return
	}

	authRes, err := client.OAuthAuthURL(request.Context(), provider)
	if err != nil {
		_ = h.recordAudit(request, "oauth.start", "oauth_provider", provider, "failure", map[string]any{"error": err.Error()})
		writeCPAFacadeError(writer, err)
		return
	}

	sessionID := strings.TrimSpace(authRes.State)
	auditSessionID := sessionID
	if auditSessionID == "" {
		auditSessionID = provider
	}
	_ = h.recordAudit(request, "oauth.start", "oauth_provider", provider, "success", map[string]any{"session_id": security.RedactText(auditSessionID)})

	response := map[string]any{
		"url":        authRes.URL,
		"state":      authRes.State,
		"session_id": sessionID,
		"provider":   provider,
	}
	// Device-code providers answer with the flow label and the code the
	// operator types on the vendor page. Passing them through keeps the
	// console from having to infer the flow from the provider id.
	if flow := strings.TrimSpace(authRes.Flow); flow != "" {
		response["flow"] = flow
	}
	if userCode := strings.TrimSpace(authRes.UserCode); userCode != "" {
		response["user_code"] = userCode
	}
	if authRes.ExpiresIn > 0 {
		response["expires_in"] = authRes.ExpiresIn
	}

	writeJSON(writer, http.StatusOK, response)
}

func (h *Handler) getOAuthStatus(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	client, ok := h.managementClientOrError(writer, request)
	if !ok {
		return
	}

	token := strings.TrimSpace(request.URL.Query().Get("state"))
	if token == "" {
		token = strings.TrimSpace(request.URL.Query().Get("session_id"))
	}
	// CPA answers {status:ok} for an empty state, which would fake a
	// success badge without any session. Require the token instead.
	if token == "" {
		writeError(writer, http.StatusBadRequest, "state is required")
		return
	}
	resp, err := client.OAuthStatus(request.Context(), token)
	if err != nil {
		writeCPAFacadeError(writer, err)
		return
	}

	status := normalizeOAuthStatus(resp.Status)
	if status == "ok" && h.pricing != nil {
		h.pricing.NotifyModelsChanged()
	}
	message := strings.TrimSpace(resp.Message)
	if message == "" {
		message = strings.TrimSpace(resp.Error)
	}

	writeJSON(writer, http.StatusOK, map[string]any{
		"status":  status,
		"message": message,
	})
}

type oauthCallbackRequest struct {
	Provider    string `json:"provider"`
	RedirectURL string `json:"redirect_url"`
}

func (h *Handler) handleOAuthCallback(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	var req oauthCallbackRequest
	if err := decodeManagementJSON(writer, request, 16*1024, &req); err != nil {
		return
	}
	req.Provider = strings.ToLower(strings.TrimSpace(req.Provider))
	req.RedirectURL = strings.TrimSpace(req.RedirectURL)

	if req.Provider == "" || !oauthProviderPattern.MatchString(req.Provider) {
		writeError(writer, http.StatusBadRequest, "valid provider is required")
		return
	}
	if req.RedirectURL == "" {
		writeError(writer, http.StatusBadRequest, "redirect_url is required")
		return
	}

	client, ok := h.managementClientOrError(writer, request)
	if !ok {
		return
	}

	auditIdentifier := req.Provider
	if auditErr := h.recordAudit(request, "oauth.callback", "oauth_callback", security.RedactText(auditIdentifier), "attempt", nil); auditErr != nil {
		writeError(writer, http.StatusInternalServerError, "audit failure; callback aborted")
		return
	}

	result, err := client.OAuthCallbackRedirect(request.Context(), req.Provider, req.RedirectURL)
	if err != nil {
		_ = h.recordAudit(request, "oauth.callback", "oauth_callback", security.RedactText(auditIdentifier), "failure", map[string]any{"error": err.Error()})
		writeCPAFacadeError(writer, err)
		return
	}

	if result.Completed {
		_ = h.recordAudit(request, "oauth.callback", "oauth_callback", security.RedactText(auditIdentifier), "success", map[string]any{"already_completed": true})

		writeJSON(writer, http.StatusOK, map[string]any{
			"status":    "ok",
			"completed": true,
		})
		return
	}

	_ = h.recordAudit(request, "oauth.callback", "oauth_callback", security.RedactText(auditIdentifier), "success", nil)

	writeJSON(writer, http.StatusOK, map[string]any{
		"status": "ok",
	})
}

func (h *Handler) cancelOAuthSession(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	sessionID := strings.TrimSpace(request.URL.Query().Get("state"))
	if sessionID == "" {
		sessionID = strings.TrimSpace(request.URL.Query().Get("session_id"))
	}

	client, ok := h.managementClientOrError(writer, request)
	if !ok {
		return
	}

	_ = h.recordAudit(request, "oauth.cancel", "oauth_session", security.RedactText(sessionID), "attempt", nil)
	result, err := client.CancelOAuthSession(request.Context(), sessionID)
	if err != nil {
		_ = h.recordAudit(request, "oauth.cancel", "oauth_session", security.RedactText(sessionID), "failure", map[string]any{"error": err.Error()})
		writeCPAFacadeError(writer, err)
		return
	}
	_ = h.recordAudit(request, "oauth.cancel", "oauth_session", security.RedactText(sessionID), "success", map[string]any{"cancelled": result.Cancelled})

	writeJSON(writer, http.StatusOK, map[string]any{
		"status": "ok",
		// A session that already completed or expired cannot be cancelled.
		// Reporting plain success there would tell the operator a sign-in was
		// abandoned that in fact saved a credential, so the outcome is kept.
		"cancelled": result.Cancelled,
	})
}
