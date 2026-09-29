package api

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/auth"
	"github.com/oh-my-cpa/oh-my-cpa/internal/config"
	"github.com/oh-my-cpa/oh-my-cpa/internal/crypto"
	"github.com/oh-my-cpa/oh-my-cpa/internal/domain"
	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
)

type pluginMockState struct {
	mu            sync.Mutex
	enabledCalls  map[string]bool
	deleted       string
	installed     string
	installQuery  string
	installBody   map[string]any
	configs       map[string]map[string]any
	configYAML    string
	configPuts    int
	deleteBlocked bool
}

const pluginTestConfigYAML = `# gateway
port: 8317
plugins:
  enabled: false # flipped from the console
  dir: plugins
  configs:
    logger:
      enabled: true
      level: info
`

func startPluginTestServer(t *testing.T) (*http.Client, string, *repository.Repository, *pluginMockState) {
	t.Helper()
	state := &pluginMockState{
		enabledCalls: make(map[string]bool),
		configs:      map[string]map[string]any{"logger": {"enabled": true, "level": "info"}},
		configYAML:   pluginTestConfigYAML,
	}

	cpaServer := newFakeCPA(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		state.mu.Lock()
		defer state.mu.Unlock()
		writer.Header().Set("Content-Type", "application/json")
		path := request.URL.Path

		switch {
		case path == "/v8/management/plugins" && request.Method == http.MethodGet:
			_, _ = writer.Write([]byte(`{"plugins_enabled":true,"plugins_dir":"/srv/cpa/plugins","plugins":[{"id":"logger","path":"/srv/cpa/plugins/logger.so","configured":true,"registered":true,"enabled":true,"effective_enabled":true,"supports_oauth":true,"oauth_provider":"logger-oauth","supports_quota":false,"logo":"https://example.com/logo.png","config_fields":[{"name":"level","type":"enum","enum_values":["debug","info"],"description":"Log level"},{"name":"level","type":"string"}],"menus":[{"path":"/x","menu":"X","description":""}],"metadata":{"name":"Logger","version":"1.0.0","author":"cpa-official","github_repository":"router-for-me/logger-plugin","logo":"https://example.com/logo.png","config_fields":[]}}]}`))
		case path == "/v0/management/config.yaml" && request.Method == http.MethodGet:
			writer.Header().Set("Content-Type", "application/yaml")
			_, _ = writer.Write([]byte(state.configYAML))
		case path == "/v0/management/config.yaml" && request.Method == http.MethodPut:
			body, _ := io.ReadAll(request.Body)
			state.configYAML = string(body)
			state.configPuts++
			_, _ = writer.Write([]byte(`{"status":"ok"}`))
		case strings.HasPrefix(path, "/v0/management/plugins/") && strings.HasSuffix(path, "/enabled") && request.Method == http.MethodPatch:
			parts := strings.Split(path, "/")
			id := parts[len(parts)-2]
			var body map[string]bool
			_ = json.NewDecoder(request.Body).Decode(&body)
			state.enabledCalls[id] = body["enabled"]
			_, _ = writer.Write([]byte(`{"status":"ok"}`))
		case strings.HasPrefix(path, "/v0/management/plugins/") && strings.HasSuffix(path, "/config"):
			parts := strings.Split(path, "/")
			id := parts[len(parts)-2]
			if request.Method == http.MethodGet {
				config, ok := state.configs[id]
				if !ok {
					writer.WriteHeader(http.StatusNotFound)
					_, _ = writer.Write([]byte(`{"error":"plugin_not_found","message":"plugin not found"}`))
					return
				}
				_ = json.NewEncoder(writer).Encode(config)
				return
			}
			var body map[string]any
			_ = json.NewDecoder(request.Body).Decode(&body)
			state.configs[id] = body
			_, _ = writer.Write([]byte(`{"status":"ok"}`))
		case strings.HasPrefix(path, "/v8/management/plugins/") && request.Method == http.MethodDelete:
			parts := strings.Split(path, "/")
			id := parts[len(parts)-1]
			if state.deleteBlocked {
				writer.WriteHeader(http.StatusConflict)
				_, _ = writer.Write([]byte(`{"error":"plugin_delete_requires_restart","message":"loaded plugin cannot be deleted while the server is running","restart_required":true}`))
				return
			}
			state.deleted = id
			_, _ = writer.Write([]byte(`{"status":"deleted","id":"` + id + `","path":"/srv/cpa/plugins/logger.so","file_deleted":true,"configured_removed":true,"restart_required":false}`))
		case path == "/v8/management/plugins/store" && request.Method == http.MethodGet:
			_, _ = writer.Write([]byte(`{"plugins_enabled":true,"plugins_dir":"plugins","sources":[{"id":"official","name":"official","url":"https://registry.example/plugins.json"},{"id":"source-abc","name":"mirror.example","url":"https://mirror.example/registry.json"}],"source_errors":[{"source_id":"source-def","source_name":"down.example","source_url":"https://down.example/r.json","message":"fetch registry: 503"}],"plugins":[{"store_id":"official/limiter","source_id":"official","source_name":"official","source_url":"https://registry.example/plugins.json","id":"limiter","name":"Rate Limiter","description":"Token buckets","author":"router-for-me","version":"1.2.0","repository":"router-for-me/limiter","install_type":"github_release","auth_required":false,"auth_configured":false,"platforms":[{"goos":"linux","goarch":"amd64"}],"logo":"https://cdn.example/limiter.png","homepage":"javascript:alert(1)","license":"MIT","tags":["network","limits"],"installed":false,"installed_version":"","path":"","configured":false,"registered":false,"enabled":false,"effective_enabled":false,"update_available":false},{"store_id":"source-abc/limiter","source_id":"source-abc","source_name":"mirror.example","source_url":"https://mirror.example/registry.json","id":"limiter","name":"Rate Limiter","author":"someone","version":"1.2.0","repository":"router-for-me/limiter","homepage":"https://limiter.example","installed":false}]}`))
		case strings.HasPrefix(path, "/v8/management/plugins/store/") && strings.HasSuffix(path, "/install"):
			parts := strings.Split(path, "/")
			id := parts[len(parts)-2]
			state.installed = id
			state.installQuery = request.URL.RawQuery
			state.installBody = map[string]any{}
			_ = json.NewDecoder(request.Body).Decode(&state.installBody)
			_, _ = writer.Write([]byte(`{"status":"installed","source_id":"official","source_name":"official","id":"` + id + `","version":"1.2.0","install_type":"github_release","path":"/srv/cpa/plugins/x.so","plugins_enabled":true,"restart_required":false}`))
		default:
			_, _ = writer.Write([]byte(`{"status":"ok"}`))
		}
	}))
	t.Cleanup(cpaServer.Close)

	db, err := repository.Open(context.Background(), fmt.Sprintf("file:mem_plugin_%d?mode=memory&cache=shared", time.Now().UnixNano()))
	if err != nil {
		t.Fatalf("open memory repo: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	repo := repository.New(db)

	cipher, err := crypto.New("01234567890123456789012345678901")
	if err != nil {
		t.Fatalf("new cipher: %v", err)
	}

	ciphertext, nonce, err := cipher.Encrypt([]byte("cpa-secret-key"))
	if err != nil {
		t.Fatalf("encrypt key: %v", err)
	}
	now := time.Now().UTC()
	if err := repo.UpsertInstance(context.Background(), domain.CPAInstance{
		ID:                      "default",
		Name:                    "Default",
		BaseURL:                 cpaServer.URL,
		ManagementKeyCiphertext: ciphertext,
		ManagementKeyNonce:      nonce,
		CreatedAt:               now,
		UpdatedAt:               now,
	}); err != nil {
		t.Fatalf("upsert instance: %v", err)
	}

	authManager, err := auth.New("management-secret-value", "/omc", "")
	if err != nil {
		t.Fatalf("new auth manager: %v", err)
	}
	handler := NewHandler(config.Config{
		BasePath: "/omc",
		Version:  "v0.1.0-test",
		Usage:    config.UsageConfig{Enabled: false},
	}, repo, cipher, nil, authManager)
	// The fixture plugin publishes its logo on an external host. Stubbing the transport
	// keeps this suite offline while still exercising the inlining the console depends
	// on; the fetch itself is covered by management_plugin_logos_test.go.
	handler.pluginLogos.client = &http.Client{
		Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
			return &http.Response{
				StatusCode: http.StatusOK,
				Header:     http.Header{"Content-Type": []string{"image/png"}},
				Body:       io.NopCloser(strings.NewReader("png-bytes")),
				Request:    request,
			}, nil
		}),
		CheckRedirect: sameOriginRedirectGuard(errPluginLogoRedirectRefused, maxPluginLogoRedirects),
	}

	appServer := httptest.NewServer(handler.Router())
	t.Cleanup(appServer.Close)

	jar, err := cookiejar.New(nil)
	if err != nil {
		t.Fatalf("new cookie jar: %v", err)
	}
	client := &http.Client{Jar: jar}

	loginResp, err := client.Post(appServer.URL+"/omc/api/auth/login", "application/json", bytes.NewBufferString(`{"password":"management-secret-value"}`))
	if err != nil || loginResp.StatusCode != http.StatusOK {
		t.Fatalf("login failed: %v", err)
	}

	return client, appServer.URL, repo, state
}

func TestPluginsLifecycle(t *testing.T) {
	client, baseURL, repo, state := startPluginTestServer(t)

	// 1. List installed plugins
	resp, err := client.Get(baseURL + "/omc/api/v1/management/plugins")
	if err != nil || resp.StatusCode != http.StatusOK {
		t.Fatalf("get plugins failed: %v, status: %d", err, resp.StatusCode)
	}
	var pluginsData struct {
		PluginsEnabled bool             `json:"plugins_enabled"`
		PluginsDir     string           `json:"plugins_dir"`
		Plugins        []map[string]any `json:"plugins"`
		Total          int              `json:"total"`
	}
	_ = json.NewDecoder(resp.Body).Decode(&pluginsData)
	resp.Body.Close()
	if len(pluginsData.Plugins) != 1 || pluginsData.Plugins[0]["id"] != "logger" {
		t.Fatalf("unexpected plugins list: %#v", pluginsData)
	}
	if !pluginsData.PluginsEnabled || pluginsData.PluginsDir != "/srv/cpa/plugins" {
		t.Fatalf("global plugin state = %v %q, want CPA's switch and directory", pluginsData.PluginsEnabled, pluginsData.PluginsDir)
	}
	plugin := pluginsData.Plugins[0]
	if plugin["supports_oauth"] != true || plugin["oauth_provider"] != "logger-oauth" {
		t.Fatalf("expected supports_oauth and oauth_provider preserved, got: %#v", plugin)
	}
	// The plugin declares its logo on an external host, and the console must not send
	// the browser there: the field carries inline artwork instead. Its absence here
	// would mean the tab, the cards and the request rows fall back to a catalog mark
	// while the plugin's own mark exists.
	logo, _ := plugin["logo"].(string)
	if !strings.HasPrefix(logo, "data:image/png;base64,") {
		t.Fatalf("plugin logo = %q, want the plugin's own mark inlined", logo)
	}
	if metadata, _ := plugin["metadata"].(map[string]any); metadata == nil || metadata["logo"] != logo {
		t.Fatalf("metadata logo = %#v, want the same inlined value", plugin["metadata"])
	}
	if plugin["repository_url"] != "https://github.com/router-for-me/logger-plugin" {
		t.Fatalf("repository_url = %#v, want the slug expanded to a GitHub link", plugin["repository_url"])
	}
	// A manifest that declares a field twice still renders one control for it.
	fields, _ := plugin["config_fields"].([]any)
	if len(fields) != 1 {
		t.Fatalf("config_fields = %#v, want one entry per declared name", plugin["config_fields"])
	}
	if field, _ := fields[0].(map[string]any); field["type"] != "enum" || len(field["enum_values"].([]any)) != 2 {
		t.Fatalf("config field = %#v, want the enum with its values", fields[0])
	}

	// The response shape is this console's own, not the facade model's: every field is
	// declared in `PluginItemDTO`, so a field added to `management.PluginItem` for
	// decoding CPA's document cannot reach a caller without a decision here. CPA's
	// `menus` are one such field: the console does not render plugin pages.
	assertDeclaredKeys(t, "plugin", plugin, []string{
		"id", "path", "configured", "registered", "enabled", "effective_enabled", "supports_oauth",
		"oauth_provider", "supports_quota", "logo", "repository_url", "config_fields", "metadata",
	})
	if metadata, ok := plugin["metadata"].(map[string]any); ok {
		assertDeclaredKeys(t, "plugin metadata", metadata, []string{"name", "version", "author", "logo"})
	} else {
		t.Fatalf("metadata = %#v, want an object", plugin["metadata"])
	}

	// 2. Disable the plugin through CPA's own route.
	patchResp, patchBody := doJSON(t, client, http.MethodPatch, baseURL+"/omc/api/v1/management/plugins/logger/enabled", `{"enabled":false}`)
	if patchResp.StatusCode != http.StatusOK {
		t.Fatalf("patch enabled: status %d body %s", patchResp.StatusCode, patchBody)
	}
	if enabled, called := state.enabledCalls["logger"]; !called || enabled {
		t.Errorf("expected logger plugin to be disabled, calls=%v", state.enabledCalls)
	}

	// 3. Read, then replace, the plugin's settings document.
	configResp, configBody := doJSON(t, client, http.MethodGet, baseURL+"/omc/api/v1/management/plugins/logger/config", "")
	if configResp.StatusCode != http.StatusOK || !strings.Contains(string(configBody), `"level":"info"`) {
		t.Fatalf("get config: status %d body %s", configResp.StatusCode, configBody)
	}
	putResp, putBody := doJSON(t, client, http.MethodPut, baseURL+"/omc/api/v1/management/plugins/logger/config", `{"config":{"enabled":true,"level":"debug"}}`)
	if putResp.StatusCode != http.StatusOK {
		t.Fatalf("put config: status %d body %s", putResp.StatusCode, putBody)
	}
	if state.configs["logger"]["level"] != "debug" {
		t.Errorf("expected logger config level debug, got %#v", state.configs["logger"])
	}

	// A plugin CPA does not know is reported as such, not as a missing capability.
	missingResp, missingBody := doJSON(t, client, http.MethodGet, baseURL+"/omc/api/v1/management/plugins/ghost/config", "")
	if missingResp.StatusCode != http.StatusNotFound || !strings.Contains(string(missingBody), `"code":"plugin_not_found"`) {
		t.Fatalf("missing plugin config: status %d body %s", missingResp.StatusCode, missingBody)
	}

	// 4. Delete plugin
	delResp, delBody := doJSON(t, client, http.MethodDelete, baseURL+"/omc/api/v1/management/plugins/logger", "")
	if delResp.StatusCode != http.StatusOK || !strings.Contains(string(delBody), `"file_deleted":true`) {
		t.Fatalf("delete plugin: status %d body %s", delResp.StatusCode, delBody)
	}
	if state.deleted != "logger" {
		t.Errorf("expected deleted logger, got %s", state.deleted)
	}

	// 5. List store plugins
	storeResp, err := client.Get(baseURL + "/omc/api/v1/management/plugin-store")
	if err != nil || storeResp.StatusCode != http.StatusOK {
		t.Fatalf("get store failed: %v, status: %d", err, storeResp.StatusCode)
	}
	var storeData struct {
		Sources      []map[string]any `json:"sources"`
		SourceErrors []map[string]any `json:"source_errors"`
		Plugins      []map[string]any `json:"plugins"`
		Total        int              `json:"total"`
	}
	_ = json.NewDecoder(storeResp.Body).Decode(&storeData)
	storeResp.Body.Close()
	if len(storeData.Plugins) != 2 || storeData.Plugins[0]["id"] != "limiter" {
		t.Fatalf("unexpected store plugins: %#v", storeData)
	}
	if storeData.Total != len(storeData.Plugins) {
		t.Fatalf("store total = %d, want the projected count %d", storeData.Total, len(storeData.Plugins))
	}
	if len(storeData.Sources) != 2 || storeData.Sources[0]["is_official"] != true || storeData.Sources[1]["is_official"] != false {
		t.Fatalf("sources = %#v, want the official registry marked", storeData.Sources)
	}
	if len(storeData.SourceErrors) != 1 || storeData.SourceErrors[0]["source_name"] != "down.example" {
		t.Fatalf("source_errors = %#v, want the failing registry reported", storeData.SourceErrors)
	}
	official, mirror := storeData.Plugins[0], storeData.Plugins[1]
	assertDeclaredKeys(t, "store plugin", official, []string{
		"store_id", "source_id", "source_name", "id", "name", "description", "author", "version",
		"repository_url", "homepage", "license", "tags", "logo", "install_type", "platforms",
		"is_official", "auth_required", "auth_configured", "installed", "installed_version",
		"install_source_status", "effective_enabled", "update_available",
	})
	if storeLogo, _ := official["logo"].(string); !strings.HasPrefix(storeLogo, "data:image/png;base64,") {
		t.Fatalf("store logo = %q, want the registry's mark inlined", storeLogo)
	}
	if _, hasHomepage := official["homepage"]; hasHomepage {
		t.Fatalf("homepage = %#v, want a non-http link dropped", official["homepage"])
	}
	if official["is_official"] != true || official["repository_url"] != "https://github.com/router-for-me/limiter" {
		t.Fatalf("official entry = %#v", official)
	}
	// A third-party registry that copies a first-party repository is still third-party.
	if mirror["is_official"] != false || mirror["homepage"] != "https://limiter.example" {
		t.Fatalf("mirror entry = %#v, want it untrusted with its homepage kept", mirror)
	}
	if platforms, _ := official["platforms"].([]any); len(platforms) != 1 || platforms[0] != "linux/amd64" {
		t.Fatalf("platforms = %#v", official["platforms"])
	}

	// 6. Install plugin from a named registry at a named version.
	installResp, installBody := doJSON(t, client, http.MethodPost, baseURL+"/omc/api/v1/management/plugin-store/limiter/install", `{"source_id":"source-abc","version":"1.2.0"}`)
	if installResp.StatusCode != http.StatusOK || !strings.Contains(string(installBody), `"version":"1.2.0"`) {
		t.Fatalf("install plugin: status %d body %s", installResp.StatusCode, installBody)
	}
	if state.installed != "limiter" || state.installQuery != "source=source-abc" || state.installBody["version"] != "1.2.0" {
		t.Errorf("install reached CPA as id=%s query=%q body=%#v", state.installed, state.installQuery, state.installBody)
	}
	// The body is optional.
	bareResp, bareBody := doJSON(t, client, http.MethodPost, baseURL+"/omc/api/v1/management/plugin-store/limiter/install", "")
	if bareResp.StatusCode != http.StatusOK || state.installQuery != "" {
		t.Fatalf("bare install: status %d body %s query %q", bareResp.StatusCode, bareBody, state.installQuery)
	}

	// 7. Check audit events
	events, err := repo.ListAuditEvents(context.Background(), 20)
	if err != nil || len(events) < 4 {
		t.Fatalf("expected at least 4 audit events recorded, got %d, err: %v", len(events), err)
	}
}

func TestPluginDeleteThatNeedsARestartIsReportedAsSuch(t *testing.T) {
	client, baseURL, _, state := startPluginTestServer(t)
	state.mu.Lock()
	state.deleteBlocked = true
	state.mu.Unlock()

	resp, body := doJSON(t, client, http.MethodDelete, baseURL+"/omc/api/v1/management/plugins/logger", "")
	if resp.StatusCode != http.StatusConflict || !strings.Contains(string(body), `"code":"plugin_delete_requires_restart"`) {
		t.Fatalf("status %d body %s, want CPA's restart refusal kept", resp.StatusCode, body)
	}
}

func TestPluginSettingsRoundTrip(t *testing.T) {
	client, baseURL, _, state := startPluginTestServer(t)

	resp, body := doJSON(t, client, http.MethodGet, baseURL+"/omc/api/v1/management/plugins/settings", "")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("get settings: status %d body %s", resp.StatusCode, body)
	}
	var settings PluginSettingsDTO
	if err := json.Unmarshal(body, &settings); err != nil {
		t.Fatal(err)
	}
	if settings.Enabled || settings.Dir != "plugins" || len(settings.StoreSources) != 0 || settings.Revision == "" {
		t.Fatalf("settings = %#v", settings)
	}

	payload := `{"revision":"` + settings.Revision + `","enabled":true,` +
		`"store_sources":["https://plugins.example/registry.json"," ","https://plugins.example/registry.json"],` +
		`"store_auth":[{"match":"https://plugins.example/","apply_to":["registry","ARTIFACT"],"type":"bearer","token_env":"PLUGIN_TOKEN","username_env":"STALE","allow_insecure":false}]}`
	putResp, putBody := doJSON(t, client, http.MethodPut, baseURL+"/omc/api/v1/management/plugins/settings", payload)
	if putResp.StatusCode != http.StatusOK {
		t.Fatalf("put settings: status %d body %s", putResp.StatusCode, putBody)
	}

	state.mu.Lock()
	written := state.configYAML
	state.mu.Unlock()
	for _, want := range []string{
		"enabled: true # flipped from the console",
		"- https://plugins.example/registry.json",
		"token-env: PLUGIN_TOKEN",
		"- artifact",
		"level: info",
		"# gateway",
	} {
		if !strings.Contains(written, want) {
			t.Errorf("written config lacks %q:\n%s", want, written)
		}
	}
	// Only the variable the rule's type reads is written.
	if strings.Contains(written, "STALE") || strings.Count(written, "registry.json") != 1 {
		t.Errorf("written config kept a stale or duplicate value:\n%s", written)
	}

	// The stale revision is now refused rather than overwriting the save above.
	conflictResp, conflictBody := doJSON(t, client, http.MethodPut, baseURL+"/omc/api/v1/management/plugins/settings", payload)
	if conflictResp.StatusCode != http.StatusConflict || !strings.Contains(string(conflictBody), "config_conflict") {
		t.Fatalf("stale save: status %d body %s", conflictResp.StatusCode, conflictBody)
	}
}

func TestPluginSettingsRefuseWhatCPAWouldNotRead(t *testing.T) {
	client, baseURL, _, state := startPluginTestServer(t)
	cases := []string{
		`{"revision":"r","store_sources":[],"store_auth":[]}`,
		`{"revision":"r","enabled":true,"store_sources":["ftp://plugins.example/r.json"]}`,
		`{"revision":"r","enabled":true,"store_auth":[{"match":"","type":"bearer","token_env":"T"}]}`,
		`{"revision":"r","enabled":true,"store_auth":[{"match":"https://x/","type":"magic"}]}`,
		`{"revision":"r","enabled":true,"store_auth":[{"match":"https://x/","type":"bearer","token_env":"not a name"}]}`,
		`{"revision":"r","enabled":true,"store_auth":[{"match":"https://x/","type":"header","header_name":"bad header","header_value_env":"V"}]}`,
		`{"revision":"r","enabled":true,"store_auth":[{"match":"https://x/","apply_to":["everything"],"type":"none"}]}`,
		`{"enabled":true}`,
	}
	for _, payload := range cases {
		resp, body := doJSON(t, client, http.MethodPut, baseURL+"/omc/api/v1/management/plugins/settings", payload)
		if resp.StatusCode != http.StatusBadRequest {
			t.Errorf("payload %s: status %d body %s, want 400", payload, resp.StatusCode, body)
		}
	}
	state.mu.Lock()
	defer state.mu.Unlock()
	if state.configPuts != 0 {
		t.Fatalf("a refused settings save reached CPA %d times", state.configPuts)
	}
}

func TestPluginMutationsRequireExplicitFields(t *testing.T) {
	client, baseURL, _, state := startPluginTestServer(t)

	cases := []struct {
		method string
		path   string
		body   string
	}{
		{http.MethodPatch, "/omc/api/v1/management/plugins/logger/enabled", `{}`},
		{http.MethodPatch, "/omc/api/v1/management/plugins/logger/enabled", `{"enabled":null}`},
		{http.MethodPut, "/omc/api/v1/management/plugins/logger/config", `{}`},
		{http.MethodPut, "/omc/api/v1/management/plugins/logger/config", `{"config":null}`},
		{http.MethodPost, "/omc/api/v1/management/plugin-store/limiter/install", `{"unknown":true}`},
	}
	for _, tc := range cases {
		resp, payload := doJSON(t, client, tc.method, baseURL+tc.path, tc.body)
		if resp.StatusCode != http.StatusBadRequest {
			t.Fatalf("%s %s: status = %d body %s", tc.method, tc.path, resp.StatusCode, payload)
		}
	}

	state.mu.Lock()
	defer state.mu.Unlock()
	if len(state.enabledCalls) != 0 || state.configs["logger"]["level"] != "info" || state.installed != "" {
		t.Fatalf("an incomplete plugin mutation reached CPA: enabled=%v configs=%v installed=%q", state.enabledCalls, state.configs, state.installed)
	}
}

// assertDeclaredKeys fails when a response object carries a field the DTO does not
// declare, which is the silent widening the projection exists to prevent.
func assertDeclaredKeys(t *testing.T, what string, object map[string]any, declared []string) {
	t.Helper()
	allowed := make(map[string]bool, len(declared))
	for _, key := range declared {
		allowed[key] = true
	}
	for key := range object {
		if !allowed[key] {
			t.Errorf("%s exposed undeclared field %q: %#v", what, key, object)
		}
	}
}
