package management

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"sort"
	"strings"
)

type OAuthAuthURLResponse struct {
	URL   string `json:"url"`
	State string `json:"state,omitempty"`
	// Flow is CPA's own label for the authorization shape: "device" for the
	// RFC 8628 device-code providers (Kimi, Meta Muse), absent for flows the
	// browser completes through a redirect. The console uses it to decide
	// whether a pasted callback belongs on the card at all.
	Flow string `json:"flow,omitempty"`
	// UserCode is the short code the operator types on the vendor's device
	// page. It is presented to the operator only, never persisted.
	UserCode string `json:"user_code,omitempty"`
	// ExpiresIn is the device grant's lifetime in seconds; zero when CPA did
	// not report one.
	ExpiresIn int `json:"expires_in,omitempty"`
}

// usesLoopbackCallback answers whether CPA should be asked to open its loopback
// callback forwarder for this provider: the registry rows whose redirect targets a
// local listener. The device-code providers answer no, because they have no redirect
// for a forwarder to receive, and a plugin provider answers no because only a
// built-in can declare the flag - its route belongs to the plugin.
func usesLoopbackCallback(provider string) bool {
	registered, ok := LookupOAuthProvider(provider)
	return ok && registered.UsesLoopbackCallback
}

func (c *Client) OAuthAuthURL(ctx context.Context, provider string) (OAuthAuthURLResponse, error) {
	provider = strings.ToLower(strings.TrimSpace(provider))
	var response OAuthAuthURLResponse
	query := url.Values{"provider": []string{loginProviderFor(provider)}}
	if usesLoopbackCallback(provider) {
		query.Set("is_webui", "true")
	}
	endpoint := "/oauth/auth-url?" + query.Encode()
	if err := c.DoJSON(ctx, http.MethodGet, endpoint, &response); err != nil {
		return OAuthAuthURLResponse{}, err
	}
	return response, nil
}

type OAuthStatusResponse struct {
	Status  string `json:"status"`
	Message string `json:"message,omitempty"`
	Error   string `json:"error,omitempty"`
}

func (c *Client) OAuthStatus(ctx context.Context, sessionID string) (OAuthStatusResponse, error) {
	var response OAuthStatusResponse
	endpoint := "/oauth/status"
	token := strings.TrimSpace(sessionID)
	if token != "" {
		endpoint += "?state=" + url.QueryEscape(token) + "&session_id=" + url.QueryEscape(token)
	}
	if err := c.DoJSON(ctx, http.MethodGet, endpoint, &response); err != nil {
		return OAuthStatusResponse{}, err
	}
	return response, nil
}

// OAuthCancelResult reports whether CPA actually dropped the pending session.
//
// A session that already completed or expired cannot be cancelled, and CPA
// answers those with `cancelled:false` while the credential may already be
// saved. Reporting plain success there would tell the operator a sign-in was
// abandoned that in fact produced a credential.
type OAuthCancelResult struct {
	Cancelled bool `json:"cancelled"`
}

func (c *Client) CancelOAuthSession(ctx context.Context, sessionID string) (OAuthCancelResult, error) {
	endpoint := "/oauth/session"
	token := strings.TrimSpace(sessionID)
	if token != "" {
		endpoint += "?state=" + url.QueryEscape(token) + "&session_id=" + url.QueryEscape(token)
	}
	var response OAuthCancelResult
	if err := c.DoJSON(ctx, http.MethodDelete, endpoint, &response); err != nil {
		return OAuthCancelResult{}, err
	}
	return response, nil
}

type OAuthCallbackResult struct {
	Completed bool `json:"completed"`
}

func (c *Client) OAuthCallbackRedirect(ctx context.Context, provider, redirectURL string) (OAuthCallbackResult, error) {
	body := map[string]string{
		"provider":     strings.TrimSpace(provider),
		"redirect_url": strings.TrimSpace(redirectURL),
	}
	if err := c.doJSONBody(ctx, http.MethodPost, "/oauth/callback", body, nil); err != nil {
		// CPA auto-callback (browser redirect to :8317/<provider>/callback) may
		// have completed the flow before this manual submission arrives. In
		// that case CPA answers 409 "already completed" while the credential
		// is already saved. Re-read the session status so the facade can
		// report idempotent success instead of a misleading failure.
		var httpErr *HTTPError
		if errors.As(err, &httpErr) && httpErr.StatusCode == http.StatusConflict {
			if state := oauthCallbackState(redirectURL); state != "" {
				if status, statusErr := c.OAuthStatus(ctx, state); statusErr == nil && isOAuthCompletedStatus(status.Status) {
					return OAuthCallbackResult{Completed: true}, nil
				}
			}
		}
		return OAuthCallbackResult{}, err
	}
	return OAuthCallbackResult{}, nil
}

// oauthCallbackState extracts the OAuth session state from a provider
// redirect URL. CPA binds the session to `state`, so only it can identify
// the session for the completion re-check.
func oauthCallbackState(redirectURL string) string {
	parsed, err := url.Parse(strings.TrimSpace(redirectURL))
	if err != nil || parsed == nil {
		return ""
	}
	return strings.TrimSpace(parsed.Query().Get("state"))
}

// isOAuthCompletedStatus reports whether a CPA get-auth-status response
// means the credential exchange already finished. CPA variants use either
// "ok" (official) or "success" (historical alias); "wait"/"pending" mean
// the flow is still in flight.
func isOAuthCompletedStatus(status string) bool {
	switch strings.ToLower(strings.TrimSpace(status)) {
	case "ok", "success":
		return true
	default:
		return false
	}
}

// OAuthModelAlias is the non-secret global model mapping CPA applies to
// OAuth/file-backed credentials.
type OAuthModelAlias struct {
	Name         string `json:"name"`
	Alias        string `json:"alias"`
	Fork         bool   `json:"fork,omitempty"`
	DisplayName  string `json:"display-name,omitempty"`
	ForceMapping bool   `json:"force-mapping,omitempty"`
}

// OAUTH_MODEL_ALIAS_PATH is where v8 keeps the OAuth model aliases, one list
// per provider.
var OAUTH_MODEL_ALIAS_PATH = []string{"oauth", "model-alias"}

// OAuthModelAliases reads CPA's global OAuth model alias map as CPA applies
// it: the stored lists pass through the same cleanup CPA runs when it loads
// them (see sanitizeOAuthModelAliases).
func (c *Client) OAuthModelAliases(ctx context.Context) (map[string][]OAuthModelAlias, error) {
	var stored map[string][]OAuthModelAlias
	if _, err := c.configValueAt(ctx, OAUTH_MODEL_ALIAS_PATH, &stored); err != nil {
		return nil, err
	}
	return sanitizeOAuthModelAliases(stored), nil
}

// sanitizeOAuthModelAliases mirrors CPA's SanitizeOAuthModelAlias: providers
// are lower-cased, and an alias without a name, equal to its model or repeated
// within a provider is ignored. The stored document is what the operator
// wrote; this is what the gateway uses.
func sanitizeOAuthModelAliases(stored map[string][]OAuthModelAlias) map[string][]OAuthModelAlias {
	providers := make([]string, 0, len(stored))
	for provider := range stored {
		providers = append(providers, provider)
	}
	sort.Strings(providers)
	out := map[string][]OAuthModelAlias{}
	for _, rawProvider := range providers {
		provider := strings.ToLower(strings.TrimSpace(rawProvider))
		if provider == "" || out[provider] != nil {
			continue
		}
		seen := map[string]bool{}
		var clean []OAuthModelAlias
		for _, entry := range stored[rawProvider] {
			name, alias := strings.TrimSpace(entry.Name), strings.TrimSpace(entry.Alias)
			if name == "" || alias == "" || strings.EqualFold(name, alias) || seen[strings.ToLower(alias)] {
				continue
			}
			seen[strings.ToLower(alias)] = true
			clean = append(clean, OAuthModelAlias{
				Name:         name,
				Alias:        alias,
				Fork:         entry.Fork,
				DisplayName:  strings.TrimSpace(entry.DisplayName),
				ForceMapping: entry.ForceMapping,
			})
		}
		if len(clean) > 0 {
			out[provider] = clean
		}
	}
	return out
}

// PatchOAuthModelAliases replaces one provider's alias list, and removes the
// provider when the list is empty. A stored spelling of the same provider in
// another case is removed with it, because CPA would read both as one provider
// and keep either.
func (c *Client) PatchOAuthModelAliases(ctx context.Context, provider string, aliases []OAuthModelAlias) error {
	provider = strings.ToLower(strings.TrimSpace(provider))
	var stored map[string]any
	if _, err := c.configValueAt(ctx, OAUTH_MODEL_ALIAS_PATH, &stored); err != nil {
		return err
	}
	path := append(append([]string{}, OAUTH_MODEL_ALIAS_PATH...), provider)
	var changes []ConfigChange
	for storedProvider := range stored {
		if storedProvider != provider && strings.ToLower(strings.TrimSpace(storedProvider)) == provider {
			changes = append(changes, ConfigChange{Path: append(append([]string{}, OAUTH_MODEL_ALIAS_PATH...), storedProvider), Remove: true})
		}
	}
	if len(aliases) == 0 {
		changes = append(changes, ConfigChange{Path: path, Remove: true})
	} else {
		changes = append(changes, ConfigChange{Path: path, Value: aliases})
	}
	return c.ApplyConfigChanges(ctx, changes)
}
