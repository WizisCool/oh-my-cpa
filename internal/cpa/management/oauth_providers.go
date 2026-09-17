package management

import "strings"

// OAuthFlow names the shape of an authorization the console has to render.
type OAuthFlow string

const (
	// OAuthFlowRedirect completes through a browser redirect whose final URL
	// carries the authorization code, so a remote operator can paste it back.
	OAuthFlowRedirect OAuthFlow = "redirect"
	// OAuthFlowDevice completes through RFC 8628: the operator confirms a
	// short code on the vendor's page and this process polls for the grant.
	OAuthFlowDevice OAuthFlow = "device"
)

// OAuthProvider is one built-in authorization the CPA Management API exposes as
// `GET /{id}-auth-url`.
type OAuthProvider struct {
	ID   string
	Name string
	// Description is shown to the operator in the provider list.
	Description string
	Flow        OAuthFlow
	// UsesLoopbackCallback marks a redirect flow whose landing page is a local
	// callback listener rather than a vendor-hosted URL. CPA's `is_webui` flag
	// makes it start the forwarder that serves that listener, which is what
	// lets a browser on the CPA host finish without pasting anything.
	UsesLoopbackCallback bool
}

// OAuthProviders is the registry of built-ins the console offers.
//
// It is the single place that answers three questions for each provider: which
// management path carries it, which flow shape the console must render, and
// whether CPA should be asked to open its loopback callback. Adding a provider
// is a row here plus its console-side presentation; nothing branches on the
// provider id.
//
// It is deliberately not a closed allowlist. CPA plugins register their own
// `{provider}-auth-url` routes at runtime, and the console discovers them from
// the plugin list, so an id that is absent here is still forwarded to CPA - it
// simply gets no per-provider flags.
var OAuthProviders = []OAuthProvider{
	{
		ID:          "kimi",
		Name:        "Kimi",
		Description: "Moonshot Kimi device code / OAuth flow",
		Flow:        OAuthFlowDevice,
	},
	{
		ID:                   "codex",
		Name:                 "OpenAI Codex / ChatGPT Plus",
		Description:          "Official OpenAI OAuth authorization flow",
		Flow:                 OAuthFlowRedirect,
		UsesLoopbackCallback: true,
	},
	{
		ID:                   "anthropic",
		Name:                 "Anthropic Claude",
		Description:          "Anthropic Claude OAuth authentication flow",
		Flow:                 OAuthFlowRedirect,
		UsesLoopbackCallback: true,
	},
	{
		ID:                   "antigravity",
		Name:                 "Antigravity",
		Description:          "Antigravity Google account OAuth flow",
		Flow:                 OAuthFlowRedirect,
		UsesLoopbackCallback: true,
	},
	{
		ID:                   "xai",
		Name:                 "xAI Grok",
		Description:          "xAI Grok OAuth authentication flow",
		Flow:                 OAuthFlowRedirect,
		UsesLoopbackCallback: true,
	},
	{
		ID:   "devin",
		Name: "Devin / Cognition",
		// Devin's authorize page only accepts a `http://127.0.0.1:<port>/callback`
		// redirect, which CPA serves on its own port. The flow is still a redirect
		// flow - an operator on a remote host reads the code out of the address bar
		// the browser could not reach and pastes the URL back.
		Description:          "Devin OAuth flow; the redirect lands on CPA's own loopback callback and is submitted manually when the browser is remote",
		Flow:                 OAuthFlowRedirect,
		UsesLoopbackCallback: true,
	},
	{
		ID:          "meta",
		Name:        "Meta Muse",
		Description: "Meta Muse (api.meta.ai) device code / OAuth flow",
		Flow:        OAuthFlowDevice,
	},
}

// LookupOAuthProvider resolves a built-in provider id, case-insensitively.
// Plugin-registered providers are absent by design; callers must keep working
// when the lookup fails.
func LookupOAuthProvider(id string) (OAuthProvider, bool) {
	normalized := strings.ToLower(strings.TrimSpace(id))
	for _, provider := range OAuthProviders {
		if provider.ID == normalized {
			return provider, true
		}
	}
	return OAuthProvider{}, false
}
