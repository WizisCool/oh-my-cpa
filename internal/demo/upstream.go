package demo

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"gopkg.in/yaml.v3"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
)

// managementPrefix and legacyManagementPrefix are the CPA management API prefixes
// the client builds its URLs from, kept identical so the fixture exercises the real
// request path. The fixture is a v8 gateway: it answers the v8 tree, and on v0 only
// the reads the client still makes there (internal/cpa/management/client_v0.go).
const (
	managementPrefix       = "/v8/management"
	legacyManagementPrefix = "/v0/management"
)

// demoRefusal names what the upstream answers when something is not part of the
// demonstration. It is a second layer behind internal/api's route policy: a
// request that reached a credential endpoint should be refused here too, so the
// demo holds even if a route were ever misclassified.
const demoRefusal = "demo mode: this operation is not available in the public demo"

// fixtureListenAddr is the address a CLIProxyAPI instance is normally reached at.
// The fixture prefers it so the address the console prints for its gateway reads
// like a deployment rather than like whatever port was free.
const fixtureListenAddr = "127.0.0.1:8317"

// subscriptionUnavailable names the demonstration credentials whose live
// subscription read the fixture refuses, so the quota card's
// unverified-snapshot rendering has browser coverage even though a real
// deployment only reaches that branch when a provider read fails.
var subscriptionUnavailable = map[string]bool{
	"auth-codex-02": true,
}

// subscriptionNotRenewing names the demonstration credentials upstream reports as
// not auto-renewing. Like subscriptionUnavailable it is here to keep a rendering
// branch reachable: an end-of-term seat is otherwise only observable by waiting for
// a real subscription to lapse.
var subscriptionNotRenewing = map[string]bool{
	"auth-codex-01": true,
}

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
	config      map[string]any
	configYAML  string
	plugins     map[string]any
	pluginStore map[string]any
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
			"status":          statusFor(item.isDisabled, false),
			"disabled":        item.isDisabled,
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
			"path":              "plugins/" + plugin.id + ".so",
			"configured":        plugin.isConfigured,
			"registered":        plugin.isRegistered,
			"enabled":           plugin.isEnabled,
			"effective_enabled": plugin.isEnabled && plugin.isRegistered,
			"supports_oauth":    false,
			"oauth_provider":    "",
			"supports_quota":    false,
			"logo":              plugin.logo,
			"config_fields":     plugin.configFields,
			"menus":             []any{},
			"metadata": map[string]any{
				"name": plugin.name, "version": plugin.version, "author": plugin.author,
				"github_repository": plugin.repository, "logo": plugin.logo, "config_fields": plugin.configFields,
			},
		})
	}
	installed := make(map[string]pluginEntry, len(pluginCatalog()))
	for _, plugin := range pluginCatalog() {
		installed[plugin.id] = plugin
	}
	sourceNames := map[string]string{}
	for _, source := range pluginStoreSources() {
		sourceNames[source["id"].(string)] = source["name"].(string)
	}
	storePlugins := make([]map[string]any, 0, len(pluginStoreCatalog()))
	for _, plugin := range pluginStoreCatalog() {
		local, isInstalled := installed[plugin.id]
		storePlugins = append(storePlugins, map[string]any{
			"store_id":          plugin.sourceID + "/" + plugin.id,
			"source_id":         plugin.sourceID,
			"source_name":       sourceNames[plugin.sourceID],
			"id":                plugin.id,
			"name":              plugin.name,
			"description":       plugin.description,
			"author":            plugin.author,
			"version":           plugin.version,
			"repository":        plugin.repository,
			"homepage":          "",
			"license":           plugin.license,
			"tags":              plugin.tags,
			"logo":              plugin.logo,
			"install_type":      "github_release",
			"platforms":         []map[string]any{{"goos": "linux", "goarch": "amd64"}, {"goos": "linux", "goarch": "arm64"}},
			"auth_required":     plugin.sourceID != "official",
			"auth_configured":   plugin.sourceID != "official",
			"installed":         isInstalled,
			"installed_version": plugin.installedVersion,
			"effective_enabled": isInstalled && local.isEnabled,
			"update_available":  isInstalled && plugin.installedVersion != plugin.version,
		})
	}
	store := map[string]any{
		"plugins_enabled": true,
		"plugins_dir":     "plugins",
		"sources":         pluginStoreSources(),
		"source_errors":   []any{},
		"plugins":         storePlugins,
	}
	pluginList := map[string]any{"plugins_enabled": true, "plugins_dir": "plugins", "plugins": plugins}
	return &upstreamState{
		files:       files,
		config:      document,
		configYAML:  renderConfigYAML(document),
		plugins:     pluginList,
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
	// The read-only client catalogue exercises the same path as a real gateway.
	if request.Method == http.MethodGet && request.URL.Path == "/v1/models" {
		for _, key := range gatewayKeyValues() {
			if request.Header.Get("Authorization") == "Bearer "+key {
				models := []map[string]string{}
				seen := map[string]bool{}
				for _, credential := range credentialCatalog() {
					for _, model := range credential.models {
						if !seen[model] {
							seen[model] = true
							models = append(models, map[string]string{"id": model})
						}
					}
				}
				writeFixtureJSON(writer, http.StatusOK, map[string]any{"data": models})
				return
			}
		}
		writeFixtureJSON(writer, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}

	if request.Header.Get("Authorization") != "Bearer "+u.managementKey {
		writeFixtureJSON(writer, http.StatusUnauthorized, map[string]any{"error": "unauthorized"})
		return
	}
	if path, isLegacy := strings.CutPrefix(request.URL.Path, legacyManagementPrefix); isLegacy {
		// Everything the public demo must never perform is refused here as well as in
		// internal/api, so the boundary does not depend on a single classification.
		if u.refuseLegacy(writer, request, path) {
			return
		}
		u.mu.Lock()
		defer u.mu.Unlock()
		u.serveLegacy(writer, request, path)
		return
	}
	path, found := strings.CutPrefix(request.URL.Path, managementPrefix)
	if !found {
		writeFixtureJSON(writer, http.StatusNotFound, map[string]any{"error": "unknown endpoint"})
		return
	}
	if u.refuse(writer, request, path) {
		return
	}

	u.mu.Lock()
	defer u.mu.Unlock()
	switch {
	case request.Method == http.MethodGet && path == "/config/config-version":
		writeFixtureJSON(writer, http.StatusOK, 8)
	case request.Method == http.MethodGet && path == "/config":
		writeFixtureJSON(writer, http.StatusOK, u.fixture.config)
	case request.Method == http.MethodGet && path == "/config.yaml":
		writer.Header().Set("Content-Type", "application/yaml")
		writer.WriteHeader(http.StatusOK)
		_, _ = writer.Write([]byte(u.fixture.configYAML))
	case request.Method == http.MethodGet && strings.HasPrefix(path, "/config/"):
		u.serveConfigPath(writer, strings.TrimPrefix(path, "/config/"))
	case request.Method == http.MethodGet && path == "/credentials":
		writeFixtureJSON(writer, http.StatusOK, map[string]any{"files": u.fixture.files})
	case request.Method == http.MethodGet && path == "/credentials/models":
		name := request.URL.Query().Get("name")
		writeFixtureJSON(writer, http.StatusOK, map[string]any{"models": authFileModels(name)})
	case request.Method == http.MethodPatch && path == "/credentials/status":
		u.patchAuthFileStatus(writer, request)
	case request.Method == http.MethodPatch && path == "/credentials/fields":
		u.patchAuthFileFields(writer, request)
	case request.Method == http.MethodGet && path == "/observability/usage/api-keys":
		writeFixtureJSON(writer, http.StatusOK, u.fixture.quota)
	case request.Method == http.MethodGet && path == "/plugins":
		writeFixtureJSON(writer, http.StatusOK, u.fixture.plugins)
	case request.Method == http.MethodGet && path == "/plugins/store":
		writeFixtureJSON(writer, http.StatusOK, u.fixture.pluginStore)
	case request.Method == http.MethodGet && path == "/observability/logs":
		u.serveLogs(writer, request)
	case request.Method == http.MethodGet && path == "/observability/logs/errors":
		writeFixtureJSON(writer, http.StatusOK, map[string]any{"files": errorLogFiles(u.now)})
	case request.Method == http.MethodGet && path == "/server/latest-version":
		writeFixtureJSON(writer, http.StatusOK, map[string]any{"latest-version": fixtureCPALatestVersion})
	case request.Method == http.MethodGet && path == "/oauth/status":
		writeFixtureJSON(writer, http.StatusOK, map[string]any{"status": "wait", "message": "no sign-in is in progress"})
	case request.Method == http.MethodPost && path == "/requests/api-call":
		u.serveAPICall(writer, request)
	default:
		writeFixtureJSON(writer, http.StatusNotFound, map[string]any{"error": "unknown endpoint"})
	}
}

// serveConfigPath answers one path of the v8 configuration view from the same
// document the whole view is, the way CPA answers `GET /config/<path>`.
func (u *Upstream) serveConfigPath(writer http.ResponseWriter, path string) {
	var value any = u.fixture.config
	for _, segment := range strings.Split(path, "/") {
		key, err := url.PathUnescape(segment)
		object, isObject := value.(map[string]any)
		if err != nil || !isObject {
			value = nil
			break
		}
		value = object[key]
	}
	if value == nil {
		writeFixtureJSON(writer, http.StatusNotFound, map[string]any{"error": "not_found"})
		return
	}
	writeFixtureJSON(writer, http.StatusOK, value)
}

// serveLegacy answers the /v0/management reads the client still makes.
func (u *Upstream) serveLegacy(writer http.ResponseWriter, request *http.Request, path string) {
	switch {
	case request.Method == http.MethodGet && path == "/config.yaml":
		// The stored file, which the demo keeps in the v8 layout already.
		writer.Header().Set("Content-Type", "application/yaml")
		writer.WriteHeader(http.StatusOK)
		_, _ = writer.Write([]byte(u.fixture.configYAML))
	case request.Method == http.MethodGet && path == "/openai-compatibility":
		writeFixtureJSON(writer, http.StatusOK, map[string]any{"openai-compatibility": compatibilitySection()})
	case request.Method == http.MethodGet && isFamilyEndpoint(path):
		family := strings.TrimSuffix(strings.TrimPrefix(path, "/"), "-api-key")
		writeFixtureJSON(writer, http.StatusOK, map[string]any{family + "-api-key": familySection(family)})
	default:
		writeFixtureJSON(writer, http.StatusNotFound, map[string]any{"error": "unknown endpoint"})
	}
}

// refuse answers the /v8/management requests the public demo must never carry out.
// It covers credential movement, sign-in, plugin execution, raw log bodies,
// configuration writes and anything that would make the process reach a real
// provider.
func (u *Upstream) refuse(writer http.ResponseWriter, request *http.Request, path string) bool {
	if request.Method == http.MethodGet || request.Method == http.MethodHead {
		// Reads that hand back raw credential or log bytes, and the sign-in endpoint a
		// caller reaches with a GET even though it starts an OAuth exchange.
		if path == "/credentials/download" || strings.HasPrefix(path, "/observability/logs/errors/") || path == "/oauth/auth-url" {
			return refuseDemo(writer)
		}
		return false
	}
	// The credential collection itself is upload and delete. Its two metadata sub-paths
	// are deliberately not refused: editing a credential's note or its enabled state is
	// a write the demonstration performs against the fixture, and refusing it here
	// would answer a permitted call with a failure. The authenticated upstream call is
	// answered from fixtures (serveAPICall) and never leaves the process.
	if path == "/credentials/status" || path == "/credentials/fields" || path == "/requests/api-call" {
		return false
	}
	// Every other v8 write reaches CPA's configuration, credential store, plugin host
	// or an upstream provider.
	return refuseDemo(writer)
}

// refuseLegacy answers the /v0/management writes; the reads the client still makes
// there are all permitted.
func (u *Upstream) refuseLegacy(writer http.ResponseWriter, request *http.Request, _ string) bool {
	if request.Method == http.MethodGet || request.Method == http.MethodHead {
		return false
	}
	return refuseDemo(writer)
}

func refuseDemo(writer http.ResponseWriter) bool {
	writeFixtureJSON(writer, http.StatusForbidden, map[string]any{"error": demoRefusal})
	return true
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
		URL       string `json:"url"`
		AuthIndex string `json:"auth_index"`
	}
	if err := decodeFixtureJSON(request, &payload); err != nil {
		writeFixtureJSON(writer, http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}
	target := strings.TrimSpace(payload.URL)
	// The catalogue is keyed by endpoint, so a read carrying a scoping query (the
	// Codex subscription probe sends account_id) still resolves to that endpoint's
	// fixture body. Stripping the query cannot widen what is answered: the request
	// is resolved against the catalogue and never dialled either way.
	if index := strings.IndexAny(target, "?#"); index >= 0 {
		target = target[:index]
	}
	// One demonstration credential has no live subscription read. It exists so the
	// quota card's unverified-snapshot rendering is exercised by browser acceptance,
	// instead of that branch being reachable only when a real provider read fails.
	if target == codexSubscriptionURL && subscriptionUnavailable[payload.AuthIndex] {
		// CPA reports an upstream failure inside a 200 envelope, so the fixture has to
		// fail the same way rather than through the HTTP status.
		writeFixtureJSON(writer, http.StatusOK, map[string]any{
			"status_code": http.StatusServiceUnavailable,
			"header":      map[string][]string{"Content-Type": {"application/json"}},
			"body":        `{"error":"subscription read unavailable"}`,
		})
		return
	}
	body, ok := u.fixture.quota[target]
	if !ok {
		writeFixtureJSON(writer, http.StatusForbidden, map[string]any{
			"error": "demo mode: no upstream request is performed",
		})
		return
	}
	// The renewal answer is per credential, so one page shows both the seat that
	// renews and the seat that ends at its term.
	if target == codexSubscriptionURL {
		if row, isRow := body.(map[string]any); isRow {
			marked := make(map[string]any, len(row)+1)
			for key, value := range row {
				marked[key] = value
			}
			marked["will_renew"] = !subscriptionNotRenewing[payload.AuthIndex]
			body = marked
		}
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
	for _, family := range []string{"claude", "codex", "gemini", "meta", "xai", "vertex", "interactions"} {
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
const fixtureCPAVersion = "8.0.1"

// fixtureCPALatestVersion is what the gateway reports as its newest release, two
// above the running one so the system page has an update to show.
const fixtureCPALatestVersion = "8.0.3"

func randomKey() (string, error) {
	material := make([]byte, 24)
	if _, err := rand.Read(material); err != nil {
		return "", fmt.Errorf("generate demo management key: %w", err)
	}
	return hex.EncodeToString(material), nil
}

// renderConfigYAML serialises the configuration document the way CPA's v8
// view renders it, and the demo stores it the same way.
func renderConfigYAML(document map[string]any) string {
	encoded, err := yaml.Marshal(document)
	if err != nil {
		return "# CLIProxyAPI configuration\n"
	}
	return "# CLIProxyAPI configuration\n" + string(encoded)
}
