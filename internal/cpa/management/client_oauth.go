package management

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/url"
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
	endpoint := fmt.Sprintf("/%s-auth-url", url.PathEscape(provider))
	if usesLoopbackCallback(provider) {
		endpoint += "?is_webui=true"
	}
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
	endpoint := "/get-auth-status"
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
	endpoint := "/oauth-session"
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
	if err := c.doJSONBody(ctx, http.MethodPost, "/oauth-callback", body, nil); err != nil {
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

// OAuthModelAliases reads CPA's global OAuth model alias map.
func (c *Client) OAuthModelAliases(ctx context.Context) (map[string][]OAuthModelAlias, error) {
	var response struct {
		Aliases map[string][]OAuthModelAlias `json:"oauth-model-alias"`
	}
	if err := c.DoJSON(ctx, http.MethodGet, "/oauth-model-alias", &response); err != nil {
		return nil, err
	}
	return response.Aliases, nil
}

// PatchOAuthModelAliases replaces one provider's alias list. CPA deletes the
// provider when the replacement list is empty.
func (c *Client) PatchOAuthModelAliases(ctx context.Context, provider string, aliases []OAuthModelAlias) error {
	if aliases == nil {
		aliases = []OAuthModelAlias{}
	}
	return c.doJSONBody(ctx, http.MethodPatch, "/oauth-model-alias", map[string]any{
		"channel": strings.TrimSpace(provider),
		"aliases": aliases,
	}, nil)
}
