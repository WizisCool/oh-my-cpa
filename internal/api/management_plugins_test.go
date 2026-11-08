package api

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/auth"
	"github.com/oh-my-cpa/oh-my-cpa/internal/config"
	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/configyaml"
	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/management"
	"github.com/oh-my-cpa/oh-my-cpa/internal/crypto"
	"github.com/oh-my-cpa/oh-my-cpa/internal/domain"
	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
)

type pluginMockState struct {
	mu           sync.Mutex
	enabledCalls map[string]bool
	deleted      string
	installed    string
	installQuery string
	installBody  map[string]any
	configs      map[string]map[string]any
	configYAML   string
	// rejectedManagementCalls counts what CPA would charge to its ban budget.
	rejectedManagementCalls int
	configPuts              int
	configWrites            []string
	deleteBlocked           bool
	// routeCalls records what reached the plugin's own management routes.
	routeCalls []pluginRouteCall
	// resourceAuthorization is the Authorization header the last resource read carried.
	resourceAuthorization string
	nativeWrites          int
	nativeReads           int
	handler               *Handler
	// hasBareInstall lists a second plugin that is installed but has no settings.
	hasBareInstall     bool
	storeResponse      string
	pluginsResponse    string
	storeReads         int
	storeQueries       []string
	storeUnavailable   bool
	storeFailureBody   string
	storeFailureStatus int
}

type pluginRouteCall struct {
	method, path, query, authorization, cookie, managementKey, contentType, body string
}

// pluginConfigsPath is where the fake serves `plugins.configs.<id>`.
const pluginConfigsPath = "/v8/management/config/plugins/configs/"

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

	cpaServer := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		state.mu.Lock()
		defer state.mu.Unlock()
		writer.Header().Set("Content-Type", "application/json")
		path := request.URL.Path
		credential := request.Header.Get("Authorization")
		if parts := strings.SplitN(credential, " ", 2); len(parts) == 2 && strings.EqualFold(parts[0], "bearer") {
			credential = parts[1]
		}
		if credential == "" {
			credential = request.Header.Get("X-Management-Key")
		}
		if (strings.HasPrefix(path, "/v0/management/") || strings.HasPrefix(path, "/v8/management/")) && credential != "cpa-secret-key" {
			state.rejectedManagementCalls++
			writer.WriteHeader(http.StatusUnauthorized)
			_, _ = writer.Write([]byte(`{"error":"unauthorized"}`))
			return
		}

		switch {
		case path == "/v1/models":
			if request.Header.Get("Authorization") != "Bearer synthetic-client-key" {
				writer.WriteHeader(http.StatusUnauthorized)
				_, _ = writer.Write([]byte(`{"error":"invalid client key"}`))
				return
			}
			_, _ = writer.Write([]byte(`{"data":[{"id":"gpt-plugin-synthetic"}]}`))
		case path == "/v8/management/config/config-version":
			_, _ = writer.Write([]byte(`8`))
		case path == "/v0/management/config.yaml":
			writer.Header().Set("Content-Type", "application/yaml")
			_, _ = writer.Write([]byte(state.configYAML))
		case path == "/v0/management/config":
			state.nativeReads++
			_, _ = writer.Write([]byte(`{"api-keys":["synthetic-client-key"],"codex-api-key":[{"api-key":"synthetic-provider-key"}]}`))
		case path == "/v8/management/config/api-keys":
			_, _ = writer.Write([]byte(`{"codex":[{"name":"example","keys":[{"api-key":"synthetic-provider-key"}]}]}`))
		case path == "/v0/management/auth-files/models":
			_, _ = writer.Write([]byte(`{"models":[{"id":"gpt-plugin-synthetic"}]}`))
		case path == "/v0/management/auth-files/status":
			state.nativeWrites++
			_, _ = writer.Write([]byte(`{"status":"ok"}`))
		case path == "/v0/resource/plugins/logger/console":
			state.resourceAuthorization = request.Header.Get("Authorization")
			writer.Header().Set("Content-Type", "text/html; charset=utf-8")
			writer.Header().Set("Set-Cookie", "plugin=1; Path=/")
			_, _ = writer.Write([]byte(`<!doctype html><html><head><meta name="api" content="/v0/management/logger"><link rel="stylesheet" href="/v0/resource/plugins/logger/app.css"></head><body><script>const API='/v0/management/logger';const other="https://cpa.example/v0/management/logger";</script></body></html>`))
		case path == "/v0/resource/plugins/logger/broken.js":
			writer.Header().Set("Content-Type", "text/javascript; charset=utf-8")
			_, _ = writer.Write([]byte(`const path = location.pathname; function { /* private plugin source */`))
		case path == "/v0/resource/plugins/logger/app.css":
			writer.Header().Set("Content-Type", "text/css")
			_, _ = writer.Write([]byte(`body{background:url(/v0/resource/plugins/logger/bg.png)}`))
		case path == "/v0/resource/plugins/logger/bg.png":
			writer.Header().Set("Content-Type", "image/png")
			_, _ = writer.Write([]byte("/v0/management/raw-bytes"))
		case strings.HasPrefix(path, "/v0/resource/plugins/"):
			writer.WriteHeader(http.StatusNotFound)
		case strings.HasPrefix(path, "/v0/management/logger/") || strings.HasPrefix(path, "/v0/management/plugins/example/"):
			body, _ := io.ReadAll(request.Body)
			state.routeCalls = append(state.routeCalls, pluginRouteCall{
				method: request.Method, path: path, query: request.URL.RawQuery,
				authorization: request.Header.Get("Authorization"), cookie: request.Header.Get("Cookie"),
				managementKey: request.Header.Get("X-Management-Key"), contentType: request.Header.Get("Content-Type"), body: string(body),
			})
			if strings.HasSuffix(path, "/missing") {
				writer.WriteHeader(http.StatusNotFound)
				_, _ = writer.Write([]byte(`{"error":"not found"}`))
				return
			}
			_, _ = writer.Write([]byte(`{"plugin":"logger","ok":true}`))
		case strings.HasPrefix(path, "/v0/management/"):
			state.routeCalls = append(state.routeCalls, pluginRouteCall{method: request.Method, path: path})
			_, _ = writer.Write([]byte(`{"secret":"raw-core-document"}`))
		case path == "/v8/management/plugins" && request.Method == http.MethodGet:
			if state.pluginsResponse != "" {
				_, _ = writer.Write([]byte(state.pluginsResponse))
				return
			}
			list := `{"plugins_enabled":true,"plugins_dir":"/srv/cpa/plugins","plugins":[{"id":"logger","path":"/srv/cpa/plugins/logger.so","configured":true,"registered":true,"enabled":true,"effective_enabled":true,"supports_oauth":true,"oauth_provider":"logger-oauth","oauth_providers":["logger-oauth"," Logger-Secondary ","logger-oauth","bad/path"],"oauth_provider_entries":[{"identifier":" LOGGER-Oauth ","name":"Logger Portal","logo":"https://example.com/portal.png"},{"identifier":"logger-secondary"},{"identifier":"logger-oauth","name":"Duplicate","logo":"https://example.com/other.png"},{"identifier":"bad/path","name":"Bad","logo":"https://example.com/bad.png"}],"supports_quota":false,"logo":"https://example.com/logo.png","config_fields":[{"name":"level","type":"enum","enum_values":["debug","info"],"description":"Log level","default":"info"},{"name":"level","type":"string"}],"menus":[{"path":"/v0/resource/plugins/logger/console","menu":"Logger Console","description":"Live log view"},{"path":"/v0/resource/plugins/other/console","menu":"Foreign"},{"path":"/v0/management/config.yaml","menu":"Core"},{"path":"https://elsewhere.example/page","menu":"Elsewhere"}],"metadata":{"name":"Logger","version":"1.0.0","author":"cpa-official","github_repository":"router-for-me/logger-plugin","logo":"https://example.com/logo.png","config_fields":[]}}]}`
			if state.hasBareInstall {
				list = strings.Replace(list, `"plugins":[`, `"plugins":[{"id":"installed","path":"/srv/cpa/plugins/installed.so","registered":true},`, 1)
			}
			_, _ = writer.Write([]byte(list))
		case path == "/v8/management/config.yaml" && request.Method == http.MethodGet:
			writer.Header().Set("Content-Type", "application/yaml")
			_, _ = writer.Write([]byte(state.configYAML))
		case strings.HasPrefix(path, pluginConfigsPath) && request.Method == http.MethodGet:
			config, ok := state.configs[strings.TrimPrefix(path, pluginConfigsPath)]
			if !ok {
				writer.WriteHeader(http.StatusNotFound)
				_, _ = writer.Write([]byte(`{"error":"not_found"}`))
				return
			}
			_ = json.NewEncoder(writer).Encode(config)
		case strings.HasPrefix(path, pluginConfigsPath) && request.Method == http.MethodPut:
			var body map[string]any
			_ = json.NewDecoder(request.Body).Decode(&body)
			state.configs[strings.TrimPrefix(path, pluginConfigsPath)] = body
			_, _ = writer.Write([]byte(`{"status":"ok"}`))
		case strings.HasPrefix(path, "/v8/management/config") && request.Method != http.MethodGet:
			body, _ := io.ReadAll(request.Body)
			var merge struct {
				Plugins struct {
					Configs map[string]map[string]any `json:"configs"`
				} `json:"plugins"`
			}
			if request.Method == http.MethodPatch && json.Unmarshal(body, &merge) == nil && len(merge.Plugins.Configs) > 0 {
				for id, config := range merge.Plugins.Configs {
					if enabled, ok := config["enabled"].(bool); ok {
						state.enabledCalls[id] = enabled
					}
				}
				_, _ = writer.Write([]byte(`{"status":"ok"}`))
				return
			}
			state.configWrites = append(state.configWrites, request.Method+" "+path+" "+string(body))
			state.configYAML += "# written\n"
			state.configPuts++
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
			state.storeReads++
			state.storeQueries = append(state.storeQueries, request.URL.RawQuery)
			if state.storeUnavailable {
				status := state.storeFailureStatus
				if status == 0 {
					status = http.StatusBadGateway
				}
				writer.WriteHeader(status)
				_, _ = writer.Write([]byte(state.storeFailureBody))
				return
			}
			if state.storeResponse != "" {
				_, _ = writer.Write([]byte(state.storeResponse))
				return
			}
			_, _ = writer.Write([]byte(`{"plugins_enabled":true,"plugins_dir":"plugins","sources":[{"id":"official","name":"official","url":"https://registry.example/plugins.json"},{"id":"source-abc","name":"mirror.example","url":"https://mirror.example/registry.json"}],"source_errors":[{"source_id":"source-def","source_name":"down.example","source_url":"https://down.example/r.json","message":"fetch registry: 503"}],"plugins":[{"store_id":"official/limiter","source_id":"official","source_name":"official","source_url":"https://registry.example/plugins.json","id":"limiter","name":"Rate Limiter","description":"Token buckets","author":"router-for-me","version":"1.2.0","repository":"router-for-me/limiter","install_type":"github_release","auth_required":false,"auth_configured":false,"platforms":[{"goos":"linux","goarch":"amd64"}],"logo":"https://cdn.example/limiter.png","homepage":"javascript:alert(1)","license":"MIT","tags":["network","limits"],"locales":{"zh-CN":{"name":"限流器 &amp; 保护","description":"&lt;b&gt;限制请求&lt;/b&gt;","author":"发布者 &#39;名字&#39;","homepage":"https://limiter.example/zh?a=1&amp;b=2","license":"许可 &quot;MIT&quot;","tags":["网络 &amp; 限流","&amp;lt;tag&amp;gt;"],"repository":"https://evil.example/repo","source_id":"evil","auth_configured":true,"token":"must-not-leak"},"zh-Hant":{"description":"限制請求","homepage":"java&#115;cript:alert(1)"}},"installed":false,"installed_version":"","path":"","configured":false,"registered":false,"enabled":false,"effective_enabled":false,"update_available":false},{"store_id":"official/deepseek-search","source_id":"official","source_name":"official","source_url":"https://registry.example/plugins.json","id":"deepseek-search","name":"DeepSeek Search","author":"karuboniru","version":"0.1.0","repository":"karuboniru/deepseek-search","install_type":"github_release","installed":false},{"store_id":"source-abc/limiter","source_id":"source-abc","source_name":"mirror.example","source_url":"https://mirror.example/registry.json","id":"limiter","name":"Rate Limiter","author":"someone","version":"1.2.0","repository":"router-for-me/limiter","homepage":"https://limiter.example","installed":false}]}`))
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

	state.handler = handler
	appServer := httptest.NewServer(handler.Router())
	t.Cleanup(appServer.Close)

	client := signedInClient(t, appServer.URL+"/omc/api/auth/login", "management-secret-value")

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
	providers, _ := plugin["oauth_providers"].([]any)
	if len(providers) != 2 || providers[0] != "logger-oauth" || providers[1] != "logger-secondary" {
		t.Fatalf("oauth_providers = %#v, want distinct valid declared login identifiers", plugin["oauth_providers"])
	}
	// Each login portal carries the display text the plugin published for it: the
	// identifier is normalized and deduplicated the way the identifier list is, while the
	// name and logo URL are kept as declared for browser rendering.
	entries, _ := plugin["oauth_provider_entries"].([]any)
	if len(entries) != 2 {
		t.Fatalf("oauth_provider_entries = %#v, want one entry per usable declared identifier", plugin["oauth_provider_entries"])
	}
	first, _ := entries[0].(map[string]any)
	if first["identifier"] != "logger-oauth" || first["name"] != "Logger Portal" {
		t.Fatalf("entry = %#v, want the normalized identifier with the declared name", entries[0])
	}
	assertDeclaredKeys(t, "plugin oauth provider entry", first, []string{"identifier", "name", "logo"})
	if entryLogo, _ := first["logo"].(string); entryLogo != "https://example.com/portal.png" {
		t.Fatalf("entry logo = %q, want the portal's declared URL", first["logo"])
	}
	if second, _ := entries[1].(map[string]any); second["identifier"] != "logger-secondary" {
		t.Fatalf("entry = %#v, want the portal that published no text of its own kept as its identifier", entries[1])
	}
	// Installed and store logos retain the publisher's URL, independently of the
	// server's egress network.
	logo, _ := plugin["logo"].(string)
	if logo != "https://example.com/logo.png" {
		t.Fatalf("plugin logo = %q, want the plugin's declared URL", logo)
	}
	if metadata, _ := plugin["metadata"].(map[string]any); metadata == nil || metadata["logo"] != logo {
		t.Fatalf("metadata logo = %#v, want the same declared URL", plugin["metadata"])
	}
	if plugin["repository_url"] != "https://github.com/router-for-me/logger-plugin" {
		t.Fatalf("repository_url = %#v, want the slug expanded to a GitHub link", plugin["repository_url"])
	}
	// A manifest that declares a field twice still renders one control for it.
	fields, _ := plugin["config_fields"].([]any)
	if len(fields) != 1 {
		t.Fatalf("config_fields = %#v, want one entry per declared name", plugin["config_fields"])
	}
	if field, _ := fields[0].(map[string]any); field["type"] != "enum" || len(field["enum_values"].([]any)) != 2 || field["default"] != "info" {
		t.Fatalf("config field = %#v, want the enum with its values and default", fields[0])
	}

	// The response shape is this console's own, not the facade model's: every field is
	// declared in `PluginItemDTO`, so a field added to `management.PluginItem` for
	// decoding CPA's document cannot reach a caller without a decision here.
	assertDeclaredKeys(t, "plugin", plugin, []string{
		"id", "path", "configured", "registered", "enabled", "effective_enabled", "supports_oauth",
		"oauth_provider", "oauth_providers", "oauth_provider_entries", "supports_quota", "quota_provider", "pages", "logo", "repository_url", "config_fields", "metadata",
	})
	// Of the menus the plugin registers, only a resource under its own prefix is a
	// page: the host serves nothing else, so nothing else may be listed as openable.
	pages, _ := plugin["pages"].([]any)
	if len(pages) != 1 {
		t.Fatalf("pages = %#v, want only the plugin's own resource", plugin["pages"])
	}
	if page, _ := pages[0].(map[string]any); page["path"] != "/v0/resource/plugins/logger/console" || page["label"] != "Logger Console" || page["description"] != "Live log view" {
		t.Fatalf("page = %#v, want the registered resource with its label", pages[0])
	}
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
	if len(storeData.Plugins) != 3 || storeData.Plugins[0]["id"] != "limiter" {
		t.Fatalf("unexpected store plugins: %#v", storeData)
	}
	if storeData.Total != len(storeData.Plugins) {
		t.Fatalf("store total = %d, want the projected count %d", storeData.Total, len(storeData.Plugins))
	}
	if len(storeData.Sources) != 2 || storeData.Sources[0]["is_official"] != true || storeData.Sources[1]["is_official"] != false || storeData.Sources[1]["is_omc"] != false {
		t.Fatalf("sources = %#v, want the official registry marked", storeData.Sources)
	}
	if len(storeData.SourceErrors) != 1 || storeData.SourceErrors[0]["source_name"] != "down.example" {
		t.Fatalf("source_errors = %#v, want the failing registry reported", storeData.SourceErrors)
	}
	official, community, mirror := storeData.Plugins[0], storeData.Plugins[1], storeData.Plugins[2]
	assertDeclaredKeys(t, "store plugin", official, []string{
		"store_id", "source_id", "source_name", "id", "name", "description", "author", "version",
		"repository_url", "homepage", "license", "tags", "locales", "logo", "install_type", "platforms",
		"is_official", "is_official_repository", "is_omc", "is_omc_repository", "auth_required", "auth_configured", "installed", "installed_version",
		"install_source_status", "effective_enabled", "update_available",
	})
	locales, _ := official["locales"].(map[string]any)
	localized, _ := locales["zh-CN"].(map[string]any)
	assertDeclaredKeys(t, "store plugin locale", localized, []string{"name", "description", "author", "homepage", "license", "tags"})
	if localized["name"] != "限流器 & 保护" || localized["description"] != "<b>限制请求</b>" || localized["author"] != "发布者 '名字'" || localized["homepage"] != "https://limiter.example/zh?a=1&b=2" || localized["license"] != `许可 "MIT"` {
		t.Fatalf("localized metadata lost in facade: %#v", localized)
	}
	if tags, _ := localized["tags"].([]any); len(tags) != 2 || tags[0] != "网络 & 限流" || tags[1] != "&lt;tag&gt;" {
		t.Fatalf("localized tags = %#v", localized["tags"])
	}
	traditional, _ := locales["zh-Hant"].(map[string]any)
	if traditional["description"] != "限制請求" || traditional["homepage"] != nil {
		t.Fatalf("localized URL allowlist = %#v", traditional)
	}
	if _, hasLocales := community["locales"]; hasLocales {
		t.Fatal("a legacy store response must not invent locales")
	}
	// The catalog is the surface an operator picks a plugin from, so a registry's artwork is
	// drawn there too: hiding it until installation made the store a wall of placeholders.
	if storeLogo, _ := official["logo"].(string); storeLogo != "https://cdn.example/limiter.png" {
		t.Fatalf("uninstalled store logo = %q, want the registry's own artwork", storeLogo)
	}
	if _, hasHomepage := official["homepage"]; hasHomepage {
		t.Fatalf("homepage = %#v, want a non-http link dropped", official["homepage"])
	}
	if official["is_official"] != true || official["is_official_repository"] != true || official["repository_url"] != "https://github.com/router-for-me/limiter" {
		t.Fatalf("official entry = %#v", official)
	}
	// The official registry is a catalogue and lists plugins published in the author's
	// own repository, so the source and the code are reported separately.
	if community["is_official"] != true || community["is_official_repository"] != false || community["repository_url"] != "https://github.com/karuboniru/deepseek-search" {
		t.Fatalf("official-registry community entry = %#v, want the source kept and the repository not called official", community)
	}
	// A third-party registry that copies a first-party repository is still third-party.
	if mirror["is_official"] != false || mirror["is_official_repository"] != true || mirror["homepage"] != "https://limiter.example" {
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

func TestPluginStoreRefreshOnlyForwardsExplicitRefresh(t *testing.T) {
	client, baseURL, _, state := startPluginTestServer(t)
	for _, test := range []struct {
		query string
		want  string
	}{
		{"", ""},
		{"?refresh=true&ignored=value", "refresh=true"},
		{"?refresh=1", "refresh=true"},
		{"?refresh=false", ""},
	} {
		t.Run(test.query, func(t *testing.T) {
			response, body := doJSON(t, client, http.MethodGet, baseURL+"/omc/api/v1/management/plugin-store"+test.query, "")
			if response.StatusCode != http.StatusOK {
				t.Fatalf("status = %d, body = %s", response.StatusCode, body)
			}
			state.mu.Lock()
			got := state.storeQueries[len(state.storeQueries)-1]
			state.mu.Unlock()
			if got != test.want {
				t.Fatalf("CPA store query = %q, want %q", got, test.want)
			}
		})
	}
	state.handler.CheckPluginUpdates(context.Background())
	state.mu.Lock()
	defer state.mu.Unlock()
	if got := state.storeQueries[len(state.storeQueries)-1]; got != "" {
		t.Fatalf("scheduled check query = %q, want ordinary cached read", got)
	}
}

func TestPluginStoreRefreshPreservesRateLimitRetryAfter(t *testing.T) {
	client, baseURL, _, state := startPluginTestServer(t)
	state.mu.Lock()
	state.storeUnavailable = true
	state.storeFailureStatus = http.StatusTooManyRequests
	state.storeFailureBody = `{"error":"plugin_store_rate_limited","message":"GitHub quota exhausted","retry_after":60}`
	state.mu.Unlock()
	response, body := doJSON(t, client, http.MethodGet, baseURL+"/omc/api/v1/management/plugin-store?refresh=true", "")
	if response.StatusCode != http.StatusTooManyRequests || response.Header.Get("Retry-After") != "60" {
		t.Fatalf("status = %d, Retry-After = %q, body = %s", response.StatusCode, response.Header.Get("Retry-After"), body)
	}
	var result struct {
		Code       string `json:"code"`
		RetryAfter int    `json:"retry_after"`
	}
	if err := json.Unmarshal(body, &result); err != nil {
		t.Fatal(err)
	}
	if result.Code != "plugin_store_rate_limited" || result.RetryAfter != 60 {
		t.Fatalf("rate limit response = %#v", result)
	}
	state.mu.Lock()
	defer state.mu.Unlock()
	if len(state.storeQueries) != 1 || state.storeQueries[0] != "refresh=true" {
		t.Fatalf("refresh must make one attempt without retry: %v", state.storeQueries)
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
	writes := append([]string(nil), state.configWrites...)
	state.mu.Unlock()
	// After the initial read reconciles the managed source, the save uses one
	// PATCH of the three keys the page owns: `dir` and `configs` are never
	// written, only the variable the rule's type reads is sent, the source list is
	// de-duplicated, and the managed Oh My CPA registry is put back because its
	// switch is on.
	want := `PATCH /v8/management/config {"plugins":{"enabled":true,"store-auth":[{"apply-to":["registry","artifact"],"match":"https://plugins.example/","token-env":"PLUGIN_TOKEN","type":"bearer"}],"store-sources":["https://plugins.example/registry.json","https://raw.githubusercontent.com/omc-community/omc-plugins/main/registry.json"]}}`
	if len(writes) != 2 || writes[1] != want {
		t.Fatalf("writes = %q\nwant a source reconciliation followed by %q", writes, want)
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

func TestPluginSettingsRejectionDoesNotEchoStoredSecrets(t *testing.T) {
	fixture := &configFixtureCPA{rejectWrites: true, rejectMessage: `management.secret-key: "top-secret-management-key" is too short`}
	client, baseURL, _ := startDashboardTestServer(t, fixture.serve)
	body := `{"revision":"` + configyaml.ComputeRevision(configFixtureYAML) + `","enabled":true}`
	response, payload := doJSON(t, client, http.MethodPut, baseURL+"/omc/api/v1/management/plugins/settings", body)
	var refusal map[string]any
	if err := json.Unmarshal(payload, &refusal); err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != http.StatusUnprocessableEntity || refusal["code"] != "config_rejected" || strings.Contains(string(payload), "top-secret-management-key") || !strings.Contains(fmt.Sprint(refusal["reason"]), "management.secret-key") {
		t.Fatalf("status = %d body %s", response.StatusCode, payload)
	}
}

func TestPluginWritesWaitForAConfigurationSave(t *testing.T) {
	client, baseURL, _, state := startPluginTestServer(t)
	// A configuration save holds the write gate across its revision check and
	// its write; a plugin write landing inside that window would be overwritten.
	gate := &state.handler.providerWrites
	gate.acquireTimeout = 50 * time.Millisecond
	if err := gate.acquire(context.Background()); err != nil {
		t.Fatal(err)
	}
	defer gate.release()

	for _, write := range []struct{ method, path, body string }{
		{http.MethodPatch, "/omc/api/v1/management/plugins/logger/enabled", `{"enabled":false}`},
		{http.MethodPut, "/omc/api/v1/management/plugins/logger/config", `{"config":{"level":"debug"}}`},
	} {
		response, body := doJSON(t, client, write.method, baseURL+write.path, write.body)
		if response.StatusCode != http.StatusServiceUnavailable || !strings.Contains(string(body), "write_busy") {
			t.Fatalf("%s %s = %d %s, want the busy refusal", write.method, write.path, response.StatusCode, body)
		}
	}
	state.mu.Lock()
	defer state.mu.Unlock()
	if len(state.enabledCalls) != 0 || state.configs["logger"]["level"] != "info" {
		t.Fatalf("CPA was written while the gate was held: %v %v", state.enabledCalls, state.configs)
	}
}

func TestPluginWritesRefuseAnUnknownPlugin(t *testing.T) {
	client, baseURL, _, state := startPluginTestServer(t)
	for _, write := range []struct{ method, path, body string }{
		{http.MethodPatch, "/omc/api/v1/management/plugins/ghost/enabled", `{"enabled":true}`},
		{http.MethodPut, "/omc/api/v1/management/plugins/ghost/config", `{"config":{"level":"debug"}}`},
	} {
		response, body := doJSON(t, client, write.method, baseURL+write.path, write.body)
		if response.StatusCode != http.StatusNotFound || !strings.Contains(string(body), "plugin_not_found") {
			t.Fatalf("%s %s = %d %s, want plugin_not_found", write.method, write.path, response.StatusCode, body)
		}
	}
	state.mu.Lock()
	defer state.mu.Unlock()
	if _, created := state.configs["ghost"]; created || len(state.enabledCalls) != 0 {
		t.Fatalf("settings were created for an unknown plugin: %v %v", state.enabledCalls, state.configs)
	}
}

func TestPluginOAuthProviderProjectionIsBounded(t *testing.T) {
	providers := []string{"bad/path", strings.Repeat("p", pluginTextLimit+1), " portal-0 ", "PORTAL-0"}
	for index := 1; index <= pluginListLimit; index++ {
		providers = append(providers, fmt.Sprintf("portal-%d", index))
	}
	projected := projectPluginItem(management.PluginItem{
		ID: "portals", OAuthProvider: "legacy-login", OAuthProviders: providers,
	})
	if len(projected.OAuthProviders) != pluginListLimit {
		t.Fatalf("login identifiers = %d, want the bounded list", len(projected.OAuthProviders))
	}
	for index, provider := range projected.OAuthProviders {
		if want := fmt.Sprintf("portal-%d", index); provider != want {
			t.Fatalf("login identifier %d = %q, want %q", index, provider, want)
		}
	}
	if projected.OAuthProvider != "legacy-login" {
		t.Fatalf("legacy login = %q, want preserved primary", projected.OAuthProvider)
	}
	legacy := projectPluginItem(management.PluginItem{ID: "old-plugin", OAuthProvider: "legacy-login"})
	if legacy.OAuthProvider != "legacy-login" || len(legacy.OAuthProviders) != 0 {
		t.Fatalf("legacy plugin = %#v, want no inferred login identifiers", legacy)
	}
}

func TestPluginOAuthProviderEntriesKeepDisplayTextAsDeclared(t *testing.T) {
	entries := []management.PluginOAuthProviderEntry{
		{Identifier: " Bad/Path ", Name: "Dropped", Logo: "https://example.com/bad.png"},
		{Identifier: strings.Repeat("p", pluginTextLimit+1), Name: "Dropped"},
		{Identifier: " Portal-One ", Name: " Z.ai ", Logo: "data:image/svg+xml,one"},
		{Identifier: "PORTAL-ONE", Name: "Duplicate", Logo: "data:image/svg+xml,duplicate"},
		{Identifier: "portal-two", Name: strings.Repeat("n", pluginTextLimit+1), Logo: "data:image/svg+xml,two"},
		{Identifier: "portal-three", Name: "BigModel"},
	}
	projected := projectPluginItem(management.PluginItem{ID: "portals", OAuthProviderEntries: entries})
	if len(projected.OAuthProviderEntries) != 3 {
		t.Fatalf("entries = %#v, want one entry per usable distinct identifier", projected.OAuthProviderEntries)
	}
	// A name is display text, not an identity: it keeps its case and its surrounding text
	// is trimmed, and an oversized one is dropped rather than cut into a label the plugin
	// never wrote.
	first := projected.OAuthProviderEntries[0]
	if first.Identifier != "portal-one" || first.Name != "Z.ai" || first.Logo != "data:image/svg+xml,one" {
		t.Fatalf("entry = %#v, want the lowercased identifier and the declared name and logo", first)
	}
	if second := projected.OAuthProviderEntries[1]; second.Identifier != "portal-two" || second.Name != "" {
		t.Fatalf("entry = %#v, want an oversized name dropped rather than truncated", second)
	}
	if third := projected.OAuthProviderEntries[2]; third.Name != "BigModel" || third.Logo != "" {
		t.Fatalf("entry = %#v, want the name kept with no inferred logo", third)
	}
	// Relative paths and active content are not image-source declarations.
	for _, logo := range []string{
		"//cdn.example.com/portal.png",
		"/assets/portal.png",
		"javascript:alert(1)",
		"data:text/html,<script/>",
	} {
		refused := projectPluginItem(management.PluginItem{ID: "portals", OAuthProviderEntries: []management.PluginOAuthProviderEntry{
			{Identifier: "portal-one", Logo: logo},
		}})
		if entry := refused.OAuthProviderEntries[0]; entry.Logo != "" {
			t.Fatalf("entry logo = %q, want %q refused as unloadable artwork", entry.Logo, logo)
		}
	}
	for index := 0; index < pluginListLimit+2; index++ {
		entries = append(entries, management.PluginOAuthProviderEntry{Identifier: fmt.Sprintf("bulk-%d", index)})
	}
	bounded := projectPluginItem(management.PluginItem{ID: "portals", OAuthProviderEntries: entries})
	if len(bounded.OAuthProviderEntries) != pluginListLimit {
		t.Fatalf("entries = %d, want the bounded list", len(bounded.OAuthProviderEntries))
	}
}

func TestPluginConfigOfAnInstalledPluginWithoutSettingsIsEmpty(t *testing.T) {
	client, baseURL, _, state := startPluginTestServer(t)
	state.mu.Lock()
	state.hasBareInstall = true
	state.mu.Unlock()
	response, body := doJSON(t, client, http.MethodGet, baseURL+"/omc/api/v1/management/plugins/installed/config", "")
	var payload map[string]any
	if err := json.Unmarshal(body, &payload); err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != http.StatusOK || payload["id"] != "installed" || fmt.Sprint(payload["config"]) != "map[]" {
		t.Fatalf("config = %d %s, want an empty document", response.StatusCode, body)
	}
}

// A declared default reaches the editor only as one bounded JSON value; null or
// an oversized document states nothing.
func TestProjectPluginDefaultKeepsOneBoundedValue(t *testing.T) {
	for _, scenario := range []struct{ raw, want string }{
		{`{ "a" : [1, 2] }`, `{"a":[1,2]}`},
		{`false`, `false`},
		{`null`, ``},
		{``, ``},
		{`"` + strings.Repeat("x", pluginDefaultLimit) + `"`, ``},
	} {
		if got := string(projectPluginDefault(json.RawMessage(scenario.raw))); got != scenario.want {
			t.Errorf("projectPluginDefault(%.20q) = %q, want %q", scenario.raw, got, scenario.want)
		}
	}
}

// A repository is the vendor's only when the parsed URL's first path segment is the
// vendor's account: a prefix match would accept a traversal a browser resolves to
// another owner, and this answer is what waives the typed-id confirmation.
func TestOfficialPluginRepositoryIsReadFromTheParsedPath(t *testing.T) {
	for _, scenario := range []struct {
		repository string
		want       bool
	}{
		{"https://github.com/router-for-me/limiter", true},
		{"https://github.com/router-for-me/limiter/tree/main/plugin", true},
		{"https://GitHub.com/router-for-me/limiter", true},
		{"https://github.com/karuboniru/deepseek-search", false},
		{"https://github.com.example.net/router-for-me/limiter", false},
		{"http://github.com/router-for-me/limiter", false},
		{"", false},
		{"https://github.com/router-for-me", false},
		{"https://github.com/router-for-me/../other-owner/limiter", false},
		{"https://github.com/router-for-me/%2e%2e/other-owner/limiter", false},
		{`https://github.com/router-for-me/..\other-owner/limiter`, false},
		{"https://github.com/router-for-me/./limiter", false},
	} {
		if got := isOfficialPluginRepository(scenario.repository); got != scenario.want {
			t.Errorf("isOfficialPluginRepository(%q) = %v, want %v", scenario.repository, got, scenario.want)
		}
	}
	// Oh My CPA's own plugins are read by the same rule against its own organization.
	for repository, want := range map[string]bool{
		"https://github.com/omc-community/omc-zcode-oauth":          true,
		"https://github.com/Yorick-Ryu/cpa-plugin-codex-candy-eval": false,
		"https://github.com/omc-community/../Yorick-Ryu/candy-eval": false,
	} {
		if got := isGitHubRepositoryOf(repository, omcPluginOwner); got != want {
			t.Errorf("isGitHubRepositoryOf(%q, omc) = %v, want %v", repository, got, want)
		}
	}
}

func TestProjectStorePluginLocalesAreBounded(t *testing.T) {
	oversized := strings.Repeat("&amp;", pluginTextLimit+1)
	item := management.PluginStoreLocale{
		Name: oversized, Description: oversized, Author: oversized, License: oversized,
		Homepage: "https://publisher.example/" + oversized,
		Tags:     append([]string{"&#32;"}, strings.Split(strings.Repeat(oversized+",", pluginListLimit+1), ",")...),
	}
	locales := map[string]management.PluginStoreLocale{
		"zh-CN":                                item,
		"zh-Hant":                              {Homepage: "data&#58;text/html,unsafe"},
		"en":                                   {Homepage: "  https&#58;//publisher.example/en?a=1&amp;b=2  "},
		"bad key":                              item,
		strings.Repeat("a", pluginListLimit+1): item,
	}
	projected := projectStorePlugin(management.StorePluginItem{Locales: locales}).Locales
	if len(projected) != 2 || projected["en"].Homepage != "https://publisher.example/en?a=1&b=2" {
		t.Fatalf("locale tag/URL allowlist: count=%d, homepage=%q", len(projected), projected["en"].Homepage)
	}
	bounded := projected["zh-CN"]
	for _, value := range []string{bounded.Name, bounded.Description, bounded.Author, bounded.License} {
		if value != strings.Repeat("&", pluginTextLimit) {
			t.Fatalf("locale text must be decoded before bounding: length = %d", len(value))
		}
	}
	if bounded.Homepage != "" || len(bounded.Tags) != pluginListLimit {
		t.Fatalf("locale bounds: homepage=%q, tags=%d", bounded.Homepage, len(bounded.Tags))
	}
	for _, tag := range bounded.Tags {
		if tag != strings.Repeat("&", pluginTextLimit) {
			t.Fatalf("locale tag must be decoded before bounding: length = %d", len(tag))
		}
	}
	for index := 0; index < pluginListLimit+1; index++ {
		locales[fmt.Sprintf("en-x-%03d", index)] = management.PluginStoreLocale{Name: "Name"}
	}
	projected = projectStorePlugin(management.StorePluginItem{Locales: locales}).Locales
	if len(projected) != pluginListLimit || projected["en-x-000"].Name != "Name" || projected["en-x-064"].Name != "" {
		t.Fatalf("locale map is not deterministically bounded: %#v", projected)
	}
}

func TestPluginUpdateReminderUsesTheObservedStore(t *testing.T) {
	client, baseURL, _, state := startPluginTestServer(t)
	readReminder := func(want bool) {
		t.Helper()
		state.mu.Lock()
		reads := state.storeReads
		state.mu.Unlock()
		resp, body := doJSON(t, client, http.MethodGet, baseURL+"/omc/api/v1/management/system/updates", "")
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("reminder status = %d: %s", resp.StatusCode, body)
		}
		var response map[string]any
		if err := json.Unmarshal(body, &response); err != nil {
			t.Fatal(err)
		}
		if response["plugin_update_available"] != want {
			t.Fatalf("plugin update reminder = %#v, want %v", response["plugin_update_available"], want)
		}
		state.mu.Lock()
		defer state.mu.Unlock()
		if state.storeReads != reads {
			t.Fatal("reading the reminder fetched the plugin store")
		}
	}
	readReminder(false)
	state.handler.pluginIdentities.remember(management.PluginStore{Plugins: []management.StorePluginItem{
		{ID: "logger", Name: "Logger", Installed: true, UpdateAvailable: true, InstallSourceStatus: "matched"},
		{ID: "logger", Name: "Other registry", Installed: true, InstallSourceStatus: "different"},
	}})
	readReminder(true)
	state.handler.pluginIdentities.remember(management.PluginStore{Plugins: []management.StorePluginItem{
		{ID: "logger", Name: "Logger", Installed: true},
		{ID: "available", UpdateAvailable: true},
	}})
	readReminder(false)

	state.mu.Lock()
	state.storeResponse = `{"plugins":[{"id":"logger","name":"Logger","source_id":"official","installed":true,"update_available":true,"installed_version":"1.0.0","version":"1.2.0"}]}`
	writesBefore := state.configPuts
	state.mu.Unlock()
	// The reminder is derived from this observation, so an open console must re-read it.
	signals, unsubscribe, err := state.handler.updateSignals.Subscribe()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(unsubscribe)
	state.handler.CheckPluginUpdates(context.Background())
	select {
	case <-signals:
	default:
		t.Fatal("a plugin observation did not notify open consoles")
	}
	readReminder(true)
	state.mu.Lock()
	storeReads, configWrites := state.storeReads, state.configPuts
	state.storeUnavailable = true
	state.storeFailureBody = `{"error":"registry unavailable","message":"Bearer synthetic-registry-secret"}`
	state.mu.Unlock()
	if storeReads != 1 || configWrites != writesBefore {
		t.Fatalf("background check: store reads = %d, config writes = %d, want 1 and %d", storeReads, configWrites, writesBefore)
	}
	var logs bytes.Buffer
	state.handler.logger = slog.New(slog.NewJSONHandler(&logs, nil))
	state.handler.CheckPluginUpdates(context.Background())
	if !strings.Contains(logs.String(), "plugin update check failed") || !strings.Contains(logs.String(), "CPA returned HTTP 502") {
		t.Fatal("background failure log must retain the operation and upstream status")
	}
	if strings.Contains(logs.String(), "synthetic-registry-secret") {
		t.Fatal("background failure log exposed an upstream credential")
	}
	readReminder(true)
	state.mu.Lock()
	state.storeUnavailable = false
	state.storeResponse = `{"plugins":[{"id":"logger","name":"Mirror","source_id":"mirror","installed":true,"update_available":false,"install_source_status":"different"}],"source_errors":[{"source_id":"official","message":"unavailable"}]}`
	state.mu.Unlock()
	state.handler.CheckPluginUpdates(context.Background())
	readReminder(true)

	state.mu.Lock()
	state.storeResponse = `{"plugins":[{"id":"logger","name":"Replacement","source_id":"mirror","installed":true,"update_available":false,"install_source_status":"matched"}],"source_errors":[{"source_id":"official","message":"unavailable"}]}`
	state.mu.Unlock()
	state.handler.CheckPluginUpdates(context.Background())
	readReminder(false)

	state.handler.pluginIdentities.remember(management.PluginStore{Plugins: []management.StorePluginItem{
		{ID: "logger", Name: "Logger", SourceID: "official", Installed: true, UpdateAvailable: true},
	}})
	state.mu.Lock()
	state.pluginsResponse = `{"plugins":[]}`
	state.storeUnavailable = true
	state.mu.Unlock()
	state.handler.CheckPluginUpdates(context.Background())
	readReminder(false)

	state.mu.Lock()
	state.pluginsResponse = ""
	state.storeUnavailable = false
	state.storeResponse = `{"plugins":[{"id":"logger","name":"Logger","installed":true,"update_available":false}]}`
	state.mu.Unlock()
	resp, body := doJSON(t, client, http.MethodGet, baseURL+"/omc/api/v1/management/plugin-store", "")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("store read: %d %s", resp.StatusCode, body)
	}
	readReminder(false)

	for _, action := range []struct{ method, path, body string }{
		{http.MethodPost, "/management/plugin-store/logger/install", `{}`},
		{http.MethodDelete, "/management/plugins/logger", ""},
	} {
		state.handler.pluginIdentities.remember(management.PluginStore{Plugins: []management.StorePluginItem{
			{ID: "logger", Installed: true, UpdateAvailable: true},
		}})
		resp, body := doJSON(t, client, action.method, baseURL+"/omc/api/v1"+action.path, action.body)
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("%s: %d %s", action.path, resp.StatusCode, body)
		}
		readReminder(false)
	}
}
