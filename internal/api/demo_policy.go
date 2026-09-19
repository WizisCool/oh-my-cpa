package api

import (
	"net/http"
	"strings"
)

// The public demonstration is a deployment of the ordinary server with a fixture
// behind it, which means every route exists and is reachable. Hiding a button in
// the browser therefore cannot be the boundary: the route has to answer for
// itself. This file is that boundary.
//
// The classification is total and the test suite proves it: every route the
// router registers must appear in the table below, so adding an endpoint forces a
// decision instead of inheriting one. At runtime an unclassified route is
// refused, so the failure mode of a gap is a blocked feature rather than an
// exposed one.
const (
	// demoHeader marks every response the demo serves, so a caller that never saw
	// the injected page configuration can still tell what it is talking to.
	demoHeader = "X-OMCPA-Demo"
	// demoBlockedHeader marks a refusal specifically, for a caller that never reads the
	// body: the browser turns it into "not available in the demo" rather than a generic
	// permission error.
	demoBlockedHeader = "X-OMCPA-Demo-Blocked"
	// demoRefusedCode is the machine-readable half of a refusal, in the shaped this
	// facade already uses elsewhere (`{"error": ..., "code": ...}`). A caller must be
	// able to tell "the demo does not do this" from "you may not" and from "it failed"
	// without matching on English prose.
	demoRefusedCode = "demo_operation_refused"
	// demoPersistenceHeader marks a request that would have changed durable state
	// in a self-hosted deployment. A demo holds its writes in memory, so the
	// answer is one the caller has to be told not to trust as permanent.
	demoPersistenceHeader = "X-OMCPA-Demo-Persistence"
)

const (
	demoValue         = "active"
	demoNotPersisted  = "none"
	demoBlockedReason = "demo mode"
)

// demoVerdict is what the server does with one route while demo mode is on.
type demoVerdict int

const (
	// demoAllow serves the request. Reads answer from fixtures; a write answers
	// from the fixture's in-memory state, so a visitor sees the feature work while
	// nothing durable and nothing real changes.
	demoAllow demoVerdict = iota
	// demoRefuse answers 403 and never reaches the handler.
	demoRefuse
)

// demoPolicyRule classifies one route. pattern is a chi route pattern, with
// `{param}` segments standing for exactly one path segment.
type demoPolicyRule struct {
	method  string
	pattern string
	verdict demoVerdict
	// reason is why the route is refused, phrased for an operator reading the API
	// response rather than for a developer reading this file.
	reason string
}

// demoMatch is how a request met the classification.
type demoMatch int

const (
	// demoMatchNone means nothing in either list describes the request. The caller
	// treats it as a refusal; see demoGuard.
	demoMatchNone demoMatch = iota
	// demoMatchVerdict means somebody decided on this route.
	demoMatchVerdict
	// demoMatchFallback means the request was answered by a rule that exists so an
	// unlisted path is refused rather than served. The request is refused, but nobody
	// decided on the route: the coverage test fails on a fallback match, which is what
	// forces an explicit verdict for a route that has just been added.
	demoMatchFallback
)

// demoPolicy is the classification table.
//
// The refusals are grouped by what makes them dangerous:
//
//   - Sign-in flows that would start a real OAuth exchange (oauth start, callback,
//     session cancel).
//   - Credential movement in either direction (upload, download, delete, and the
//     raw request and error log bodies that quote request content).
//   - Anything that leaves the process or reaches a real upstream: provider model
//     reads, the pricing catalogue sync, a forced usage pull, and the diagnostic
//     bundle that packages deployment internals.
//   - Plugin installation, enablement and configuration, which execute third-party
//     code inside the gateway.
//   - Writes that are credential state rather than presentation: gateway key
//     material, provider definitions, the raw configuration document, and quota
//     resets and credit redemption.
//
// Everything else is allowed, and keeps working exactly as it does when
// self-hosted: dashboard reads, request records, pricing rows, caller-key aliases,
// preferences, credential metadata, configuration reads, quota reads and the
// in-process discovery sweep.
var demoPolicy = []demoPolicyRule{
	// The public surface of the API: the health probe and the session endpoints the
	// sign-in card uses. They are verdicts on API paths, so they resolve before the
	// `/api/*` fallback refuses an unclassified one.
	{http.MethodGet, "/api/healthz", demoAllow, ""},
	{http.MethodPost, "/api/auth/login", demoAllow, ""},
	{http.MethodGet, "/api/auth/session", demoAllow, ""},
	{http.MethodPost, "/api/auth/logout", demoAllow, ""},
	// Discovery runs against the in-process fixture, so it is a read of the demo's
	// own data even though it is a POST.
	{http.MethodPost, "/api/v1/instances/default/discover", demoAllow, ""},

	// Oh My CPA's own metadata. None of these reaches CPA or the network.
	{http.MethodGet, "/api/v1/resources", demoAllow, ""},
	{http.MethodPatch, "/api/v1/resources/{id}/override", demoAllow, ""},
	{http.MethodGet, "/api/v1/preferences", demoAllow, ""},
	{http.MethodPut, "/api/v1/preferences/{key}", demoAllow, ""},
	{http.MethodGet, "/api/v1/management/client-key-aliases", demoAllow, ""},
	{http.MethodPut, "/api/v1/management/client-key-aliases", demoAllow, ""},
	{http.MethodDelete, "/api/v1/management/client-key-aliases/{fingerprint}", demoAllow, ""},
	{http.MethodGet, "/api/v1/management/client-key-usage", demoAllow, ""},
	{http.MethodGet, "/api/v1/pricing", demoAllow, ""},
	{http.MethodPut, "/api/v1/pricing/models", demoAllow, ""},
	{http.MethodDelete, "/api/v1/pricing/models/{model}", demoAllow, ""},
	{http.MethodPut, "/api/v1/pricing/sync-schedule", demoAllow, ""},

	// Observation of the fixture: the dashboard, the request records and the log
	// tail all read data the fixture published.
	{http.MethodGet, "/api/v1/management/overview", demoAllow, ""},
	{http.MethodGet, "/api/v1/management/dashboard", demoAllow, ""},
	{http.MethodGet, "/api/v1/management/dashboard/tail", demoAllow, ""},
	{http.MethodGet, "/api/v1/management/dashboard/token-heatmap", demoAllow, ""},
	{http.MethodGet, "/api/v1/management/dashboard/models", demoAllow, ""},
	{http.MethodGet, "/api/v1/management/dashboard/providers", demoAllow, ""},
	{http.MethodGet, "/api/v1/management/logs", demoAllow, ""},
	{http.MethodGet, "/api/v1/management/logs/status", demoAllow, ""},
	// The error-log file list. Its download is refused below; naming the file is not.
	{http.MethodGet, "/api/v1/management/request-error-logs", demoAllow, ""},
	// The gateway key list. Creating and deleting keys are refused below; reading them is
	// what the key page is.
	{http.MethodGet, "/api/v1/management/api-keys", demoAllow, ""},
	{http.MethodGet, "/api/v1/usage/ingest-status", demoAllow, ""},
	{http.MethodGet, "/api/v1/usage/events", demoAllow, ""},
	{http.MethodGet, "/api/v1/usage/events/{id}", demoAllow, ""},
	{http.MethodGet, "/api/v1/usage/facets", demoAllow, ""},
	{http.MethodGet, "/api/v1/management/audit/events", demoAllow, ""},
	{http.MethodGet, "/api/v1/management/audit/export", demoAllow, ""},
	{http.MethodGet, "/api/v1/management/system", demoAllow, ""},

	// Configuration and capability reads. The console renders them; nothing here
	// writes to the gateway.
	{http.MethodGet, "/api/v1/management/config", demoAllow, ""},
	{http.MethodGet, "/api/v1/management/config/source", demoAllow, ""},
	{http.MethodGet, "/api/v1/management/capabilities/{key}", demoAllow, ""},
	{http.MethodGet, "/api/v1/management/providers", demoAllow, ""},

	// Credential metadata: the list, the per-credential model list and the fields a
	// visitor can safely exercise. Editing a label, a priority or a note changes the
	// fixture and nothing else.
	{http.MethodGet, "/api/v1/management/auth-files", demoAllow, ""},
	{http.MethodGet, "/api/v1/management/auth-files/safe-fields", demoAllow, ""},
	{http.MethodGet, "/api/v1/management/auth-files/model-aliases", demoAllow, ""},
	{http.MethodGet, "/api/v1/management/auth-files/models", demoAllow, ""},
	{http.MethodPatch, "/api/v1/management/auth-files/status", demoAllow, ""},
	{http.MethodPatch, "/api/v1/management/auth-files/fields", demoAllow, ""},

	// Quota reads. The refresh is answered by the fixture's own provider payloads,
	// so it performs no upstream request.
	{http.MethodGet, "/api/v1/management/oauth/providers", demoAllow, ""},
	{http.MethodGet, "/api/v1/management/oauth/status", demoAllow, ""},
	{http.MethodGet, "/api/v1/management/quota", demoAllow, ""},
	{http.MethodGet, "/api/v1/management/quota/{authIndex}", demoAllow, ""},
	{http.MethodPost, "/api/v1/management/quota/refresh", demoAllow, ""},

	// A manual capture pass is answered locally: it reports a pass that found an
	// empty queue, so the request list's own refresh button works without a queue
	// to pop.
	{http.MethodPost, "/api/v1/usage/ingest/refresh", demoAllow, ""},

	// Plugin and store reads: the lists are fixture data, and a plugin's declared
	// logo is never fetched because no fixture plugin publishes one.
	{http.MethodGet, "/api/v1/management/plugins", demoAllow, ""},
	{http.MethodGet, "/api/v1/management/plugin-store", demoAllow, ""},

	// Sign-in: starting a real OAuth exchange is the one thing a public demo must
	// never do, because it would mint a credential against a real provider account.
	{http.MethodPost, "/api/v1/management/oauth/start", demoRefuse, "sign-in is disabled: the demo holds no provider account to authorize"},
	{http.MethodPost, "/api/v1/management/oauth/callback", demoRefuse, "sign-in is disabled: the demo holds no provider account to authorize"},
	{http.MethodDelete, "/api/v1/management/oauth/session", demoRefuse, "sign-in is disabled: the demo holds no provider account to authorize"},

	// Credential movement.
	{http.MethodPost, "/api/v1/management/auth-files", demoRefuse, "uploading a credential is disabled"},
	{http.MethodDelete, "/api/v1/management/auth-files", demoRefuse, "deleting a credential is disabled"},
	{http.MethodGet, "/api/v1/management/auth-files/download", demoRefuse, "downloading credential material is disabled"},

	// Raw request and error content.
	{http.MethodGet, "/api/v1/management/request-error-logs/{name}", demoRefuse, "downloading a request log is disabled: it quotes request content"},
	{http.MethodGet, "/api/v1/usage/events/{id}/request-log", demoRefuse, "downloading a request log is disabled: it quotes request content"},
	{http.MethodDelete, "/api/v1/management/logs", demoRefuse, "clearing the gateway log is disabled"},

	// Anything that would reach outside this process.
	{http.MethodPost, "/api/v1/management/providers/pull-models", demoRefuse, "reading models from a provider is disabled: it would call the provider"},
	{http.MethodPost, "/api/v1/pricing/sync", demoRefuse, "syncing the price catalogue is disabled: it would call models.dev"},
	{http.MethodGet, "/api/v1/management/system/diagnostics", demoRefuse, "generating a diagnostic bundle is disabled"},

	// Plugin execution.
	{http.MethodPost, "/api/v1/management/plugin-store/{id}/install", demoRefuse, "installing a plugin is disabled: plugins execute inside the gateway"},
	{http.MethodPatch, "/api/v1/management/plugins/{id}/status", demoRefuse, "changing a plugin's status is disabled: plugins execute inside the gateway"},
	{http.MethodDelete, "/api/v1/management/plugins/{id}", demoRefuse, "removing a plugin is disabled"},
	{http.MethodPut, "/api/v1/management/plugins/{id}/config", demoRefuse, "editing a plugin's configuration is disabled"},

	// Gateway configuration and credential state.
	{http.MethodPut, "/api/v1/management/config/source", demoRefuse, "writing the gateway configuration is disabled"},
	{http.MethodPut, "/api/v1/management/config/{key}", demoRefuse, "writing the gateway configuration is disabled"},
	{http.MethodPost, "/api/v1/management/api-keys", demoRefuse, "changing gateway key material is disabled"},
	{http.MethodDelete, "/api/v1/management/api-keys/{index}", demoRefuse, "changing gateway key material is disabled"},
	{http.MethodPost, "/api/v1/management/providers", demoRefuse, "changing provider configuration is disabled"},
	{http.MethodPut, "/api/v1/management/providers/{id}", demoRefuse, "changing provider configuration is disabled"},
	{http.MethodDelete, "/api/v1/management/providers/{id}", demoRefuse, "changing provider configuration is disabled"},
	{http.MethodPatch, "/api/v1/management/providers/status", demoRefuse, "changing provider configuration is disabled"},
	{http.MethodPatch, "/api/v1/management/auth-files/model-aliases", demoRefuse, "changing a credential's model aliases is disabled"},
	{http.MethodPost, "/api/v1/management/quota/reset", demoRefuse, "resetting a credential's quota is disabled"},
	{http.MethodPost, "/api/v1/management/quota/clear-cooldown", demoRefuse, "changing a credential's cooldown is disabled"},
	{http.MethodPost, "/api/v1/management/quota/redeem-credit", demoRefuse, "redeeming a reset credit is disabled: it spends a real entitlement"},
}

// demoPolicyConsole is the console itself and the assets it loads.
//
// It is a third list because it resolves last of all: a trailing wildcard matches every
// path below it, so these rules have to be reached only after the endpoint verdicts and
// the fallbacks have had their chance. Placed first - which is where a wildcard reads
// most naturally - the SPA wildcard classified every `GET` in the application as public,
// including the credential download and the request log that must never be served.
//
// Every rule here is still a verdict: `/api/*` is refused by the fallback list rather
// than by the wildcard, so the wildcard only ever answers for the console and its own
// assets. `/api-keys` is a page and stays public, because the API is mounted at
// `/api/` and not at every path beginning with those four letters.
var demoPolicyConsole = []demoPolicyRule{
	{http.MethodGet, "/assets/*", demoAllow, ""},
	{http.MethodHead, "/assets/*", demoAllow, ""},
	{http.MethodGet, "/lobe-icons/*", demoAllow, ""},
	{http.MethodHead, "/lobe-icons/*", demoAllow, ""},
	{http.MethodGet, "/favicon.svg", demoAllow, ""},
	{http.MethodHead, "/favicon.svg", demoAllow, ""},
	{http.MethodGet, "/*", demoAllow, ""},
	{http.MethodHead, "/*", demoAllow, ""},
}

// demoPolicyFallbacks answer a request no verdict describes.
//
// They are a separate list because they are not verdicts on a route: the coverage test
// requires a non-fallback match for every route the router registers, and the runtime
// uses these to fail closed. Putting them in the table above with a marker would say
// the same thing twice; keeping them here says it once, in the place that means it.
var demoPolicyFallbacks = []demoPolicyRule{
	// An API path nobody classified is a gap, and a gap must not be answered by the SPA
	// wildcard at the end of the table above - which is what a trailing wildcard does to
	// every unlisted `GET`. This sits between the table and the wildcard, so the wildcard
	// covers the console and its assets only: `/api-keys` is a page and stays public,
	// `/api/v1/...` is an API and is refused.
	{"*", "/api/*", demoRefuse, "this endpoint is not part of the demo"},
}

// demoVerdictFor classifies one request. The three lists are consulted in order - the
// endpoint verdicts, then the fallbacks, then the console itself - and the first match
// wins, so each list is only reached when nothing before it applies.
func demoVerdictFor(method, path string) (demoPolicyRule, demoMatch) {
	method = strings.ToUpper(strings.TrimSpace(method))
	for _, rule := range demoPolicy {
		if rule.method != method && rule.method != "*" {
			continue
		}
		if routePatternMatches(rule.pattern, path) {
			return rule, demoMatchVerdict
		}
	}
	for _, rule := range demoPolicyFallbacks {
		if rule.method != method && rule.method != "*" {
			continue
		}
		if routePatternMatches(rule.pattern, path) {
			return rule, demoMatchFallback
		}
	}
	for _, rule := range demoPolicyConsole {
		if rule.method != method && rule.method != "*" {
			continue
		}
		if routePatternMatches(rule.pattern, path) {
			return rule, demoMatchVerdict
		}
	}
	return demoPolicyRule{}, demoMatchNone
}

// routePatternMatches reports whether a request path matches one chi route
// pattern. `*` is a trailing wildcard, and a `{name}` segment matches exactly one
// non-empty segment, which is how chi's own matcher behaves for the routes the
// table covers.
func routePatternMatches(pattern, path string) bool {
	if pattern == "" {
		return false
	}
	patternSegments := splitPath(pattern)
	pathSegments := splitPath(path)
	wildcard := false
	if len(patternSegments) > 0 && patternSegments[len(patternSegments)-1] == "*" {
		wildcard = true
		patternSegments = patternSegments[:len(patternSegments)-1]
	}
	// `/favicon.svg` has one segment and `/assets/*` has one fixed segment, so the
	// wildcard has to be able to match zero remaining segments as well.
	if len(pathSegments) < len(patternSegments) {
		return false
	}
	if !wildcard && len(pathSegments) != len(patternSegments) {
		return false
	}
	for index, segment := range patternSegments {
		if strings.HasPrefix(segment, "{") && strings.HasSuffix(segment, "}") {
			if pathSegments[index] == "" {
				return false
			}
			continue
		}
		if segment != pathSegments[index] {
			return false
		}
	}
	return true
}

func splitPath(value string) []string {
	trimmed := strings.Trim(value, "/")
	if trimmed == "" {
		return nil
	}
	return strings.Split(trimmed, "/")
}

// stripBasePath removes the configured mount prefix so the classification table
// stays independent of where the console is mounted.
func stripBasePath(basePath, path string) string {
	if basePath == "" || basePath == "/" {
		return path
	}
	if path == basePath {
		return "/"
	}
	if !strings.HasPrefix(path, basePath+"/") {
		return path
	}
	return strings.TrimPrefix(path, basePath)
}

// revealKeysAllowed decides whether a list response may carry key material.
//
// The console asks for it with `include_keys=true` on the two pages whose contract
// includes editing keys. A public demonstration never answers it, because revealing a
// credential is one of the operations a demo must not perform - the fixture's keys are
// not real, and showing them would teach the wrong thing about what the deployment
// protects. The pages still render: they receive the mask the same endpoint already
// sends to every caller that does not ask.
func (h *Handler) revealKeysAllowed(request *http.Request) bool {
	if h.cfg.IsDemoMode {
		return false
	}
	return strings.EqualFold(request.URL.Query().Get("include_keys"), "true")
}

// demoGuard enforces the classification table. It is installed only in demo mode,
// so the self-hosted request path is unchanged.
func (h *Handler) demoGuard(next http.Handler) http.Handler {
	if !h.cfg.IsDemoMode {
		return next
	}
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set(demoHeader, demoValue)
		rule, match := demoVerdictFor(request.Method, stripBasePath(h.cfg.BasePath, request.URL.Path))
		if match == demoMatchNone {
			writeDemoRefusal(writer, "this endpoint is not part of the demo")
			return
		}
		if rule.verdict == demoRefuse {
			writeDemoRefusal(writer, rule.reason)
			return
		}
		if request.Method != http.MethodGet && request.Method != http.MethodHead && request.Method != http.MethodOptions {
			// The demo keeps its writes in memory. Saying so on the response is the
			// only way a caller can know the result is not durable.
			writer.Header().Set(demoPersistenceHeader, demoNotPersisted)
		}
		next.ServeHTTP(writer, request)
	})
}

func writeDemoRefusal(writer http.ResponseWriter, reason string) {
	writer.Header().Set(demoHeader, demoValue)
	writer.Header().Set(demoBlockedHeader, demoBlockedReason)
	writeJSON(writer, http.StatusForbidden, map[string]string{
		"error": "demo mode — " + reason,
		"code":  demoRefusedCode,
	})
}
