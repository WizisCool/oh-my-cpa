package api

import (
	"database/sql"
	"errors"
	"net/http"
	"net/url"
	"regexp"
	"strings"

	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/management"
	"github.com/oh-my-cpa/oh-my-cpa/internal/security"
)

var (
	oauthProviderPattern = regexp.MustCompile(`^[a-z0-9-]+$`)
	// OAuth errors can contain callback parameters and account-mismatch details
	// that the general credential redactor does not recognize.
	oauthFailureSecretPattern = regexp.MustCompile(`(?i)(\b(?:code|state|session[_-]?id|account(?:[_-]?id)?|email)["']?[ \t]*[:=][ \t]*|\bwrong account[ \t]+)(?:"[^"]*"|'[^']*'|[^\s,;}&]+)`)
	oauthFailureEmailPattern  = regexp.MustCompile(`(?i)\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b`)
)

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

// OAuthProviderListResponseDTO lists built-in OAuth authorization providers.
type OAuthProviderListResponseDTO struct {
	Providers []OAuthProviderDTO `json:"providers"`
}

// StartOAuthResponseDTO returns the authorization URL, state token, and optional device-code metadata.
type StartOAuthResponseDTO struct {
	URL       string `json:"url"`
	State     string `json:"state"`
	SessionID string `json:"session_id"`
	Provider  string `json:"provider"`
	Flow      string `json:"flow,omitempty"`
	UserCode  string `json:"user_code,omitempty"`
	ExpiresIn int    `json:"expires_in,omitempty"`
}

// OAuthStatusResponseDTO reports normalized OAuth session status (`ok`, `wait`, or `error`).
type OAuthStatusResponseDTO struct {
	Status  string `json:"status"`
	Message string `json:"message,omitempty"`
}

// OAuthCallbackResponseDTO confirms OAuth callback submission.
type OAuthCallbackResponseDTO struct {
	Status    string `json:"status"`
	Completed bool   `json:"completed,omitempty"`
}

// OAuthCancelResponseDTO reports whether the OAuth session was cancelled.
type OAuthCancelResponseDTO struct {
	Status    string `json:"status"`
	Cancelled bool   `json:"cancelled"`
}

// @Summary List built-in OAuth providers
// @Description Return the catalog of built-in OAuth authorization flows supported by CPA.
// @Tags OAuth
// @Produce json
// @Security CookieAuth
// @Success 200 {object} OAuthProviderListResponseDTO
// @Failure 401 {object} ErrorResponseDTO
// @Router /v1/management/oauth/providers [get]
func (h *Handler) listOAuthProviders(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	writeJSON(writer, http.StatusOK, OAuthProviderListResponseDTO{
		Providers: supportedOAuthProviders(),
	})
}

type startOAuthRequest struct {
	Provider  string `json:"provider"`
	ProxyURL  string `json:"proxy_url,omitempty"`
	Name      string `json:"name,omitempty"`
	AuthIndex string `json:"auth_index,omitempty"`
	Verify    bool   `json:"verify,omitempty"`
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

// @Summary Start an OAuth credential flow
// @Description Initiate a built-in or plugin OAuth sign-in or token-refresh flow via CPA.
// @Tags OAuth
// @Accept json
// @Produce json
// @Security CookieAuth
// @Param body body startOAuthRequest true "OAuth start parameters"
// @Success 200 {object} StartOAuthResponseDTO
// @Failure 400 {object} ErrorResponseDTO
// @Failure 401 {object} ErrorResponseDTO
// @Failure 409 {object} ErrorResponseDTO
// @Failure 500 {object} ErrorResponseDTO
// @Failure 502 {object} ErrorResponseDTO
// @Failure 503 {object} ErrorResponseDTO
// @Router /v1/management/oauth/start [post]
func (h *Handler) startOAuthFlow(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	if query := request.URL.Query(); query.Has("proxy_url") || query.Has("proxy-url") {
		writeError(writer, http.StatusBadRequest, "proxy_url must be provided in the request body")
		return
	}
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

	proxyURL, err := management.NormalizeOAuthProxyURL(req.ProxyURL)
	if err != nil {
		writeCPAFacadeError(writer, err)
		return
	}

	options := management.OAuthStartOptions{ProxyURL: proxyURL, Name: req.Name, AuthIndex: req.AuthIndex, Verify: req.Verify}
	if options.Name != "" {
		name, err := validateAuthSelector(options.Name)
		if err != nil {
			writeError(writer, http.StatusBadRequest, "invalid credential target")
			return
		}
		options.Name = name
	}
	options.AuthIndex = strings.TrimSpace(options.AuthIndex)
	if len([]rune(options.AuthIndex)) > managementAuthFileNameLimit {
		writeError(writer, http.StatusBadRequest, "invalid credential target")
		return
	}
	auditType, auditTarget := "oauth_provider", provider
	auditDetail := map[string]any{}
	if options.Name != "" || options.AuthIndex != "" {
		auditType, auditTarget = "auth_file", firstNonEmpty(options.Name, options.AuthIndex)
		auditDetail["provider"], auditDetail["verify"] = provider, options.Verify
	}
	if err := h.recordAudit(request, "oauth.start", auditType, auditTarget, "attempt", auditDetail); err != nil {
		writeError(writer, http.StatusInternalServerError, "audit failure; authorization aborted")
		return
	}
	authRes, err := h.operationsService().StartOAuth(request.Context(), provider, options)
	if err != nil {
		_ = h.recordAudit(request, "oauth.start", auditType, auditTarget, "failure", nil)
		if errors.Is(err, sql.ErrNoRows) {
			writeError(writer, http.StatusServiceUnavailable, "default CPA instance is not configured")
			return
		}
		if err.Error() == "resource_conflict" {
			writeJSON(writer, http.StatusConflict, map[string]string{"code": "resource_conflict", "error": "credential identity changed"})
			return
		}
		writeCPAFacadeError(writer, err)
		return
	}

	sessionID := strings.TrimSpace(authRes.State)
	_ = h.recordAudit(request, "oauth.start", auditType, auditTarget, "success", nil)

	response := StartOAuthResponseDTO{
		URL:       authRes.URL,
		State:     authRes.State,
		SessionID: sessionID,
		Provider:  provider,
		Flow:      strings.TrimSpace(authRes.Flow),
		UserCode:  strings.TrimSpace(authRes.UserCode),
	}
	if authRes.ExpiresIn > 0 {
		response.ExpiresIn = authRes.ExpiresIn
	}

	writeJSON(writer, http.StatusOK, response)
}

// @Summary Poll OAuth session status
// @Description Check the current status of an in-flight OAuth authorization session.
// @Tags OAuth
// @Produce json
// @Security CookieAuth
// @Param state query string false "OAuth state token"
// @Param session_id query string false "Legacy alias for OAuth state token"
// @Success 200 {object} OAuthStatusResponseDTO
// @Failure 400 {object} ErrorResponseDTO
// @Failure 401 {object} ErrorResponseDTO
// @Failure 502 {object} ErrorResponseDTO
// @Router /v1/management/oauth/status [get]
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
	if h.isSIWCBindingState(token) {
		writeError(writer, http.StatusBadRequest, "use the credential-scoped SIWC status endpoint")
		return
	}
	resp, err := client.OAuthStatus(request.Context(), token)
	if err != nil {
		writeCPAFacadeError(writer, err)
		return
	}

	status := normalizeOAuthStatus(resp.Status)
	if status == "ok" {
		if h.pricing != nil {
			h.pricing.NotifyModelsChanged()
		}
		h.invalidateCoordinator("management-auth-files", "management-routing", "management-quota")
	}
	payload := OAuthStatusResponseDTO{Status: status}
	if status == "error" {
		if message := sanitizeOAuthFailureMessage(firstNonEmpty(resp.Message, resp.Error), token); message != "" {
			payload.Message = message
		}
	}
	writeJSON(writer, http.StatusOK, payload)
}

func sanitizeOAuthFailureMessage(message, token string) string {
	message = security.RedactText(message, token)
	message = oauthFailureSecretPattern.ReplaceAllString(message, `${1}`+security.RedactedValue)
	message = oauthFailureEmailPattern.ReplaceAllString(message, security.RedactedValue)
	// Redact the complete text before bounding it so a cut cannot expose part
	// of a credential or split a multi-byte character.
	return boundedText(message, 300)
}

type oauthCallbackRequest struct {
	Provider    string `json:"provider"`
	RedirectURL string `json:"redirect_url"`
}

// @Summary Submit manual OAuth callback redirect URL
// @Description Forward a manually pasted OAuth callback URL to CPA to complete an OAuth flow.
// @Tags OAuth
// @Accept json
// @Produce json
// @Security CookieAuth
// @Param body body oauthCallbackRequest true "OAuth provider and redirect URL"
// @Success 200 {object} OAuthCallbackResponseDTO
// @Failure 400 {object} ErrorResponseDTO
// @Failure 401 {object} ErrorResponseDTO
// @Failure 500 {object} ErrorResponseDTO
// @Failure 502 {object} ErrorResponseDTO
// @Router /v1/management/oauth/callback [post]
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

	if parsed, err := url.Parse(req.RedirectURL); err == nil && h.isSIWCBindingState(parsed.Query().Get("state")) {
		writeError(writer, http.StatusBadRequest, "use the credential-scoped SIWC callback endpoint")
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
		h.invalidateCoordinator("management-auth-files", "management-routing", "management-quota")

		writeJSON(writer, http.StatusOK, OAuthCallbackResponseDTO{
			Status:    "ok",
			Completed: true,
		})
		return
	}

	_ = h.recordAudit(request, "oauth.callback", "oauth_callback", security.RedactText(auditIdentifier), "success", nil)
	h.invalidateCoordinator("management-auth-files", "management-routing", "management-quota")

	writeJSON(writer, http.StatusOK, OAuthCallbackResponseDTO{
		Status: "ok",
	})
}

// @Summary Cancel an OAuth session
// @Description Cancel an active OAuth authorization session by state or session ID.
// @Tags OAuth
// @Produce json
// @Security CookieAuth
// @Param state query string false "OAuth state token"
// @Param session_id query string false "Legacy alias for OAuth state token"
// @Success 200 {object} OAuthCancelResponseDTO
// @Failure 400 {object} ErrorResponseDTO
// @Failure 401 {object} ErrorResponseDTO
// @Failure 500 {object} ErrorResponseDTO
// @Failure 502 {object} ErrorResponseDTO
// @Router /v1/management/oauth/session [delete]
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

	if h.isSIWCBindingState(sessionID) {
		writeError(writer, http.StatusBadRequest, "use the credential-scoped SIWC cancellation endpoint")
		return
	}
	if err := h.recordAudit(request, "oauth.cancel", "oauth_session", "session", "attempt", nil); err != nil {
		writeError(writer, http.StatusInternalServerError, "audit failure; cancellation aborted")
		return
	}
	result, err := client.CancelOAuthSession(request.Context(), sessionID)
	if err != nil {
		_ = h.recordAudit(request, "oauth.cancel", "oauth_session", "session", "failure", map[string]any{"error": err.Error()})
		writeCPAFacadeError(writer, err)
		return
	}
	_ = h.recordAudit(request, "oauth.cancel", "oauth_session", "session", "success", map[string]any{"cancelled": result.Cancelled})

	writeJSON(writer, http.StatusOK, OAuthCancelResponseDTO{
		Status:    "ok",
		Cancelled: result.Cancelled,
	})
}
