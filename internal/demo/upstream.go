package demo

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

// managementPrefix is the CPA management API prefix the client builds its URLs
// from, kept identical so the fixture exercises the real request path.
const managementPrefix = "/v0/management"

// demoRefusal names what the upstream answers when something is not part of the
// demonstration. It is a second layer behind internal/api's route policy: a
// request that reached a credential endpoint should be refused here too, so the
// demo holds even if a route were ever misclassified.
const demoRefusal = "demo mode: this operation is not available in the public demo"

// fixtureListenAddr is the address a CLIProxyAPI instance is normally reached at.
// The fixture prefers it so the address the console prints for its gateway reads
// like a deployment rather than like whatever port was free.
const fixtureListenAddr = "127.0.0.1:8317"

// Upstream is an in-process stand-in for a CLIProxyAPI management endpoint.
//
// It exists so the demo can reuse every existing read path - the console talks
// to it through the ordinary management client, over a loopback socket - without
// a real gateway, a real management key or a real provider credential. It never
// dials anything: the only traffic it can produce is the answer it writes back.
type Upstream struct {
	logger        *slog.Logger
	managementKey string
	listener      net.Listener
	server        *http.Server
	now           time.Time

	mu      sync.Mutex
	fixture *upstreamState
}

// upstreamState is the mutable half of the fixture: the console can toggle a
// credential or edit its metadata, and a fixture that acknowledged a write
// without storing it could not tell a working write from a lost one.
type upstreamState struct {
	files       []map[string]any
	aliases     map[string]any
	excluded    map[string]any
	config      map[string]any
	configYAML  string
	plugins     []map[string]any
	pluginStore []map[string]any
	logLines    []string
	logLatest   int64
	quota       map[string]any
}

// StartUpstream binds the fixture to a loopback port and serves it.
//
// The port is ephemeral and stays on 127.0.0.1, so nothing outside the process
// can reach it and nothing inside it can reach outside.
func StartUpstream(logger *slog.Logger) (*Upstream, error) {
	if logger == nil {
		logger = slog.Default()
	}
	key, err := randomKey()
	if err != nil {
		return nil, err
	}
	listener, err := net.Listen("tcp", fixtureListenAddr)
	if err != nil {
		// The port a gateway normally uses may be taken on a development machine.
		// Any free loopback port serves the fixture just as well, and only the
		// address the console displays changes.
		listener, err = net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			return nil, fmt.Errorf("bind demo upstream: %w", err)
		}
	}
	now := time.Now().UTC()
	upstream := &Upstream{
		logger:        logger,
		managementKey: key,
		listener:      listener,
		now:           now,
		fixture:       newUpstreamState(now),
	}
	upstream.server = &http.Server{
		Handler:           http.HandlerFunc(upstream.serve),
		ReadHeaderTimeout: 5 * time.Second,
	}
	go func() {
		if serveErr := upstream.server.Serve(listener); serveErr != nil && !errors.Is(serveErr, http.ErrServerClosed) {
			logger.Error("demo upstream stopped", "error", serveErr)
		}
	}()
	return upstream, nil
}

// BaseURL is the address the application should treat as its CPA instance.
func (u *Upstream) BaseURL() string {
	return "http://" + u.listener.Addr().String()
}

// ManagementKey is the bearer token the fixture accepts. It is minted per
// process and never written anywhere, so a demo deployment holds no credential
// that outlives it.
func (u *Upstream) ManagementKey() string { return u.managementKey }

// Close stops the fixture. It is safe to call on a nil receiver so the ordinary
// path can defer it unconditionally.
func (u *Upstream) Close() error {
	if u == nil || u.server == nil {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	return u.server.Shutdown(ctx)
}

func newUpstreamState(now time.Time) *upstreamState {
	files := make([]map[string]any, 0, len(credentialCatalog()))
	for _, item := range credentialCatalog() {
		file := map[string]any{
			"id":              "cred-" + item.authIndex,
			"auth_index":      item.authIndex,
			"name":            item.name,
			"type":            item.kind,
			"provider":        item.provider,
			"label":           item.label,
			"status":          statusFor(item.disabled, false),
			"disabled":        item.disabled,
			"unavailable":     false,
			"runtime_only":    false,
			"account_type":    item.accountType,
			"success":         item.success,
			"failed":          item.failed,
			"priority":        item.priority,
			"weight":          item.weight,
			"excluded_models": []string{},
			"recent_requests": recentRequests(now, item.success, item.failed),
		}
		if item.email != "" {
			file["email"] = item.email
		}
		if item.projectID != "" {
			file["project_id"] = item.projectID
		}
		if item.note != "" {
			file["note"] = item.note
		}
		// The identity claims a real response carries. Plan and expiry are what the
		// quota panel reads, so they have to be present for the Codex rows.
		if item.plan != "" {
			claims := map[string]any{
				"chatgpt_account_id":                "acct-" + item.authIndex,
				"plan_type":                         item.plan,
				"chatgpt_subscription_active_until": now.Add(21 * 24 * time.Hour).Unix(),
			}
			encoded, err := json.Marshal(claims)
			if err == nil {
				file["id_token"] = json.RawMessage(encoded)
			}
		}
		models := make([]map[string]any, 0, len(item.models))
		for _, model := range item.models {
			models = append(models, map[string]any{"id": model, "display_name": displayNameForModel(model)})
		}
		file["models"] = models
		files = append(files, file)
	}

	document := configDocument()
	plugins := make([]map[string]any, 0, len(pluginCatalog()))
	for _, plugin := range pluginCatalog() {
		plugins = append(plugins, map[string]any{
			"id":                plugin.id,
			"name":              plugin.name,
			"path":              "/plugins/" + plugin.id,
			"description":       plugin.description,
			"version":           plugin.version,
			"author":            plugin.author,
			"enabled":           plugin.enabled,
			"effective_enabled": plugin.enabled,
			"configured":        plugin.configured,
			"registered":        plugin.registered,
			"permissions":       plugin.permissions,
		})
	}
	store := make([]map[string]any, 0, len(pluginStoreCatalog()))
	for _, plugin := range pluginStoreCatalog() {
		store = append(store, map[string]any{
			"id":          plugin.id,
			"name":        plugin.name,
			"description": plugin.description,
			"version":     plugin.version,
			"author":      plugin.author,
			"permissions": plugin.permissions,
			"installed":   false,
		})
	}
	return &upstreamState{
		files:       files,
		aliases:     oauthModelAliases(),
		excluded:    oauthExcludedModels(),
		config:      document,
		configYAML:  renderConfigYAML(document),
		plugins:     plugins,
		pluginStore: store,
		logLines:    logTail(now),
		logLatest:   now.Unix(),
		quota:       quotaPayloads(now),
	}
}

func statusFor(disabled, unavailable bool) string {
	switch {
	case disabled:
		return "disabled"
	case unavailable:
		return "unavailable"
	default:
		return "ok"
	}
}

// recentRequests fabricates the rolling per-credential history the console
// renders as a sparkline. The numbers are derived from the credential's own
// totals so a row cannot contradict the counters beside it.
func recentRequests(now time.Time, success, failed int64) []map[string]any {
	const buckets = 12
	requests := make([]map[string]any, 0, buckets)
	successPerBucket := success / buckets
	failedPerBucket := failed / buckets
	for index := buckets - 1; index >= 0; index-- {
		requests = append(requests, map[string]any{
			"time":    now.Add(-time.Duration(index) * time.Hour).UTC().Format(time.RFC3339),
			"success": successPerBucket,
			"failed":  failedPerBucket,
		})
	}
	return requests
}

func (u *Upstream) serve(writer http.ResponseWriter, request *http.Request) {
	if request.Header.Get("Authorization") != "Bearer "+u.managementKey {
		writeFixtureJSON(writer, http.StatusUnauthorized, map[string]any{"error": "unauthorized"})
		return
	}
	path := strings.TrimPrefix(request.URL.Path, managementPrefix)
	if path == request.URL.Path {
		writeFixtureJSON(writer, http.StatusNotFound, map[string]any{"error": "unknown endpoint"})
		return
	}

	// Everything the public demo must never perform is refused here as well as in
	// internal/api, so the boundary does not depend on a single classification.
	if u.refuse(writer, request, path) {
		return
	}

	u.mu.Lock()
	defer u.mu.Unlock()
	switch {
	case request.Method == http.MethodGet && path == "/auth-files":
		writeFixtureJSON(writer, http.StatusOK, map[string]any{"files": u.fixture.files})
	case request.Method == http.MethodGet && path == "/auth-files/models":
		name := request.URL.Query().Get("name")
		writeFixtureJSON(writer, http.StatusOK, map[string]any{"models": authFileModels(name)})
	case request.Method == http.MethodPatch && path == "/auth-files/status":
		u.patchAuthFileStatus(writer, request)
	case request.Method == http.MethodPatch && path == "/auth-files/fields":
		u.patchAuthFileFields(writer, request)
	case request.Method == http.MethodGet && path == "/oauth-model-alias":
		writeFixtureJSON(writer, http.StatusOK, map[string]any{"oauth-model-alias": u.fixture.aliases})
	case request.Method == http.MethodGet && path == "/oauth-excluded-models":
		writeFixtureJSON(writer, http.StatusOK, map[string]any{"oauth-excluded-models": u.fixture.excluded})
	case request.Method == http.MethodGet && path == "/config":
		writeFixtureJSON(writer, http.StatusOK, u.fixture.config)
	case request.Method == http.MethodGet && path == "/config.yaml":
		writer.Header().Set("Content-Type", "application/yaml")
		writer.WriteHeader(http.StatusOK)
		_, _ = writer.Write([]byte(u.fixture.configYAML))
	case request.Method == http.MethodGet && path == "/api-keys":
		writeFixtureJSON(writer, http.StatusOK, map[string]any{"api-keys": gatewayKeyValues()})
	case request.Method == http.MethodGet && path == "/api-key-usage":
		writeFixtureJSON(writer, http.StatusOK, u.fixture.quota)
	case request.Method == http.MethodGet && path == "/openai-compatibility":
		writeFixtureJSON(writer, http.StatusOK, map[string]any{"openai-compatibility": compatibilitySection()})
	case request.Method == http.MethodGet && isFamilyEndpoint(path):
		family := strings.TrimSuffix(strings.TrimPrefix(path, "/"), "-api-key")
		writeFixtureJSON(writer, http.StatusOK, map[string]any{family + "-api-key": familySection(family)})
	case request.Method == http.MethodGet && path == "/plugins":
		writeFixtureJSON(writer, http.StatusOK, u.fixture.plugins)
	case request.Method == http.MethodGet && path == "/plugin-store":
		writeFixtureJSON(writer, http.StatusOK, u.fixture.pluginStore)
	case request.Method == http.MethodGet && path == "/logs":
		u.serveLogs(writer, request)
	case request.Method == http.MethodGet && path == "/request-error-logs":
		writeFixtureJSON(writer, http.StatusOK, map[string]any{"files": errorLogFiles(u.now)})
	case request.Method == http.MethodGet && path == "/latest-version":
		writeFixtureJSON(writer, http.StatusOK, map[string]any{"latest-version": "7.3.5"})
	case request.Method == http.MethodGet && path == "/get-auth-status":
		writeFixtureJSON(writer, http.StatusOK, map[string]any{"status": "wait", "message": "no sign-in is in progress"})
	case request.Method == http.MethodPost && path == "/api-call":
		u.serveAPICall(writer, request)
	default:
		writeFixtureJSON(writer, http.StatusNotFound, map[string]any{"error": "unknown endpoint"})
	}
}

// refuse answers the requests the public demo must never carry out. It covers
// credential movement, sign-in, plugin execution, raw log bodies, configuration
// writes and anything that would make the process reach a real provider.
func (u *Upstream) refuse(writer http.ResponseWriter, request *http.Request, path string) bool {
	if request.Method == http.MethodGet || request.Method == http.MethodHead {
		// The two GET endpoints that hand back raw credential or log bytes. Both are
		// blocked by the route policy as well; this is the layer that survives a
		// future route being added without a classification.
		if path == "/auth-files/download" || strings.HasPrefix(path, "/request-error-logs/") {
			writeFixtureJSON(writer, http.StatusForbidden, map[string]any{"error": demoRefusal})
			return true
		}
		return false
	}
	mutating := []string{
		"/auth-files",
		"/reset-quota",
		"/api-keys",
		"/openai-compatibility",
		"/config.yaml",
		"/plugins",
		"/plugin-store",
		"/oauth-session",
		"/oauth-callback",
	}
	for _, prefix := range mutating {
		if path == prefix || strings.HasPrefix(path, prefix+"/") {
			writeFixtureJSON(writer, http.StatusForbidden, map[string]any{"error": demoRefusal})
			return true
		}
	}
	if isFamilyEndpoint(path) || strings.HasSuffix(path, "-auth-url") || strings.HasPrefix(path, "/config/") {
		writeFixtureJSON(writer, http.StatusForbidden, map[string]any{"error": demoRefusal})
		return true
	}
	return false
}

func (u *Upstream) patchAuthFileStatus(writer http.ResponseWriter, request *http.Request) {
	var payload struct {
		Name     string `json:"name"`
		Disabled bool   `json:"disabled"`
	}
	if err := decodeFixtureJSON(request, &payload); err != nil {
		writeFixtureJSON(writer, http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}
	for _, file := range u.fixture.files {
		if file["name"] != payload.Name {
			continue
		}
		file["disabled"] = payload.Disabled
		file["status"] = statusFor(payload.Disabled, false)
	}
	writeFixtureJSON(writer, http.StatusOK, map[string]any{"status": "ok", "disabled": payload.Disabled})
}

func (u *Upstream) patchAuthFileFields(writer http.ResponseWriter, request *http.Request) {
	var payload map[string]any
	if err := decodeFixtureJSON(request, &payload); err != nil {
		writeFixtureJSON(writer, http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}
	name, _ := payload["name"].(string)
	for _, file := range u.fixture.files {
		if file["name"] != name {
			continue
		}
		for key, value := range payload {
			if key == "name" {
				continue
			}
			file[key] = value
		}
	}
	writeFixtureJSON(writer, http.StatusOK, map[string]any{"status": "ok"})
}

// serveLogs serves one snapshot of the fixture's log tail. It hands the whole
// snapshot to the first reader and nothing to later ones, which is how a real
// file log behaves once it stops growing.
func (u *Upstream) serveLogs(writer http.ResponseWriter, request *http.Request) {
	after, _ := strconv.ParseInt(request.URL.Query().Get("after"), 10, 64)
	lines := []string{}
	if after < u.fixture.logLatest {
		lines = u.fixture.logLines
	}
	writeFixtureJSON(writer, http.StatusOK, map[string]any{
		"lines":            lines,
		"latest-timestamp": u.fixture.logLatest,
		"next-cursor":      "",
		"cursor-reset":     false,
	})
}

// serveAPICall answers the quota service's provider reads. It resolves the
// request against the fixture catalogue and never dials the URL it is handed,
// which is what makes the deployed demo independent of chatgpt.com, anthropic
// and every other provider host.
func (u *Upstream) serveAPICall(writer http.ResponseWriter, request *http.Request) {
	var payload struct {
		URL string `json:"url"`
	}
	if err := decodeFixtureJSON(request, &payload); err != nil {
		writeFixtureJSON(writer, http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}
	target := strings.TrimSpace(payload.URL)
	body, ok := u.fixture.quota[target]
	if !ok {
		writeFixtureJSON(writer, http.StatusForbidden, map[string]any{
			"error": "demo mode: no upstream request is performed",
		})
		return
	}
	encoded, err := json.Marshal(body)
	if err != nil {
		writeFixtureJSON(writer, http.StatusInternalServerError, map[string]any{"error": "encode fixture body"})
		return
	}
	writeFixtureJSON(writer, http.StatusOK, map[string]any{
		"status_code": http.StatusOK,
		"header":      map[string][]string{"Content-Type": {"application/json"}},
		// CPA returns the body as a JSON string; NormalizedBody unwraps it, so the
		// fixture has to produce the same doubling the real endpoint does.
		"body": string(encoded),
	})
}

func isFamilyEndpoint(path string) bool {
	for _, family := range []string{"claude", "codex", "gemini", "meta"} {
		if path == "/"+family+"-api-key" {
			return true
		}
	}
	return false
}

func decodeFixtureJSON(request *http.Request, target any) error {
	decoder := json.NewDecoder(http.MaxBytesReader(nil, request.Body, 1<<20))
	if err := decoder.Decode(target); err != nil {
		return fmt.Errorf("decode request: %w", err)
	}
	return nil
}

func writeFixtureJSON(writer http.ResponseWriter, status int, payload any) {
	writer.Header().Set("Content-Type", "application/json")
	// The console reads CPA's own version header for its system panel.
	writer.Header().Set("X-CPA-Version", fixtureCPAVersion)
	writer.WriteHeader(status)
	_ = json.NewEncoder(writer).Encode(payload)
}

// fixtureCPAVersion is the gateway version the fixture reports. It is a fixed
// plausible release rather than a real one, so the system panel has something to
// render without claiming a specific upstream build.
const fixtureCPAVersion = "7.3.5"

func randomKey() (string, error) {
	material := make([]byte, 24)
	if _, err := rand.Read(material); err != nil {
		return "", fmt.Errorf("generate demo management key: %w", err)
	}
	return hex.EncodeToString(material), nil
}

// renderConfigYAML serialises the configuration document the way the config page
// edits it. Only the value shapes the fixture uses are supported, and an
// unsupported shape is rendered as its JSON form rather than silently dropped.
func renderConfigYAML(document map[string]any) string {
	var builder strings.Builder
	builder.WriteString("# CLIProxyAPI configuration\n")
	for _, key := range []string{
		"host", "port", "debug", "logging-to-file", "request-log", "usage-statistics-enabled",
		"request-retry", "max-retry-interval", "max-retry-credentials", "ws-auth",
		"force-model-prefix", "logs-max-total-size-mb", "error-logs-max-files",
	} {
		value, ok := document[key]
		if !ok {
			continue
		}
		builder.WriteString(fmt.Sprintf("%s: %v\n", key, value))
	}
	keys := gatewayKeyValues()
	builder.WriteString("api-keys:\n")
	for _, key := range keys {
		builder.WriteString("  - " + key + "\n")
	}
	return builder.String()
}
