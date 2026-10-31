package api

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/management"
	"github.com/oh-my-cpa/oh-my-cpa/internal/pluginregistry"
)

func TestCommunityCatalogReadsOnlySelectedConfiguredSourceAndReportsItsFailure(t *testing.T) {
	var selectedReads, otherReads, aggregateReads, configWrites atomic.Int32
	raw := `config-version: 8
plugins:
  enabled: true
  store-sources:
    - https://one.example/registry.json
    - https://two.example/registry.json
`
	var handler *Handler
	client, baseURL, _ := startDashboardTestServerStoring(t, raw, func(writer http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/v8/management/config.yaml":
			_, _ = writer.Write([]byte(raw))
		case "/v8/management/plugins":
			_, _ = writer.Write([]byte(`{"plugins_enabled":true,"plugins":[]}`))
		case "/v8/management/plugins/store":
			aggregateReads.Add(1)
			http.Error(writer, "aggregate must not be used", 500)
		default:
			if request.Method != http.MethodGet {
				configWrites.Add(1)
			}
			http.NotFound(writer, request)
		}
	}, func(current *Handler) {
		handler = current
		current.pluginDescriptions.client = &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
			if request.Header.Get("Authorization") != "" || request.Header.Get("Cookie") != "" {
				t.Error("management credentials sent to a registry")
			}
			status, body := http.StatusOK, `{"schema_version":2,"plugins":[{"id":"example","name":"Example","author":"community","description":"A plugin","version":"1.0.0","description_i18n":{"en":"Localized description"},"repository":"https://github.com/example/plugin"}]}`
			switch request.URL.Hostname() {
			case "one.example":
				selectedReads.Add(1)
			case "two.example":
				otherReads.Add(1)
				status = 503
				body = "synthetic failure"
			default:
				t.Errorf("unselected source %s was read", request.URL.Hostname())
			}
			return &http.Response{StatusCode: status, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(body)), Request: request}, nil
		})}
	})
	response, body := getJSON(t, client, baseURL+"/omc/api/v1/management/plugin-store?source_id="+pluginregistry.SourceID("https://one.example/registry.json"))
	if response.StatusCode != 200 || !strings.Contains(string(body), `"description_i18n":{"en":"Localized description"}`) {
		t.Fatalf("selected source = %d %s", response.StatusCode, body)
	}
	if selectedReads.Load() != 1 || otherReads.Load() != 0 || aggregateReads.Load() != 0 || configWrites.Load() != 0 {
		t.Fatalf("source independence selected=%d other=%d aggregate=%d writes=%d", selectedReads.Load(), otherReads.Load(), aggregateReads.Load(), configWrites.Load())
	}
	response, body = getJSON(t, client, baseURL+"/omc/api/v1/management/plugin-store?source_id="+pluginregistry.SourceID("https://two.example/registry.json"))
	var dto struct {
		Sources      []PluginStoreSourceDTO      `json:"sources"`
		SourceErrors []PluginStoreSourceErrorDTO `json:"source_errors"`
		Plugins      []StorePluginItemDTO        `json:"plugins"`
	}
	if err := json.Unmarshal(body, &dto); err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != 200 || len(dto.Sources) != 3 || len(dto.SourceErrors) != 1 || dto.SourceErrors[0].SourceID != pluginregistry.SourceID("https://two.example/registry.json") || len(dto.Plugins) != 0 {
		t.Fatalf("failed selected source = %d %s", response.StatusCode, body)
	}
	before := selectedReads.Load() + otherReads.Load()
	response, body = getJSON(t, client, baseURL+"/omc/api/v1/management/plugin-store?source_id=not-configured")
	if response.StatusCode != 404 || selectedReads.Load()+otherReads.Load() != before {
		t.Fatalf("unknown source read = %d %s", response.StatusCode, body)
	}
	_ = handler
}
func TestInstalledPluginProjectionUsesStoredProvenanceNotStoreRuntimeIdentity(t *testing.T) {
	raw := `config-version: 8
plugins:
 enabled: true
 store-sources:
  - https://community.example/registry.json
 configs:
  omc-zcode-oauth:
   enabled: true
   store:
    id: omc-zcode-oauth
    name: ZCode OAuth
    version: 0.1.4
    source-id: REPLACE_BUILTIN_ID
    source-url: REPLACE_BUILTIN_URL
    description: Native store text
  example:
   enabled: false
   store:
    id: example
    name: Example
    version: 1.0.0
    source-id: REPLACE_COMMUNITY_ID
    source-url: https://community.example/registry.json
    repository: https://github.com/example/plugin
    description: Community text
`
	var handler *Handler
	var aggregateReads, descriptionReads atomic.Int32
	client, baseURL, _ := startDashboardTestServerStoring(t, raw, func(writer http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/v8/management/config.yaml":
			_, _ = writer.Write([]byte(raw))
		case "/v8/management/plugins":
			_, _ = writer.Write([]byte(`{"plugins_enabled":true,"plugins":[{"id":"omc-zcode-oauth","path":"plugins/zcode.so","registered":true,"enabled":true,"effective_enabled":true,"metadata":{"name":"ZCode OAuth","version":"0.1.3"}},{"id":"example","path":"plugins/example.so","registered":false,"enabled":false},{"id":"local","path":"plugins/local.so","registered":false}]}`))
		case "/v8/management/plugins/store":
			aggregateReads.Add(1)
			http.Error(writer, "must not read store", 500)
		default:
			http.NotFound(writer, request)
		}
	}, func(current *Handler) {
		handler = current
		current.pluginDescriptions.client = &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
			descriptionReads.Add(1)
			return &http.Response{StatusCode: http.StatusServiceUnavailable, Header: http.Header{}, Body: io.NopCloser(strings.NewReader("unavailable")), Request: request}, nil
		})}
	})
	handler.cfg.BuiltinRegistryOrigin = baseURL
	builtinURL, _ := handler.builtinRegistryURL()
	raw = strings.ReplaceAll(raw, "REPLACE_BUILTIN_URL", builtinURL)
	raw = strings.ReplaceAll(raw, "REPLACE_BUILTIN_ID", pluginregistry.SourceID(builtinURL))
	raw = strings.ReplaceAll(raw, "REPLACE_COMMUNITY_ID", pluginregistry.SourceID("https://community.example/registry.json"))
	response, body := getJSON(t, client, baseURL+"/omc/api/v1/management/plugins")
	var dto struct {
		Plugins []PluginItemDTO `json:"plugins"`
	}
	if err := json.Unmarshal(body, &dto); err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != 200 || len(dto.Plugins) != 3 {
		t.Fatalf("installed projection = %d %s", response.StatusCode, body)
	}
	builtin, community, local := dto.Plugins[0], dto.Plugins[1], dto.Plugins[2]
	if builtin.SourceKind != "builtin" || builtin.InstalledVersion != "0.1.4" || builtin.Metadata.Version != "0.1.3" || builtin.Description != "Native store text" {
		t.Fatalf("runtime provenance conflated: %+v", builtin)
	}
	if community.SourceKind != "community" || community.InstalledVersion != "1.0.0" || community.Metadata.Version != "" || community.Description != "Community text" || local.SourceKind != "unknown" || aggregateReads.Load() != 0 || descriptionReads.Load() != 0 {
		t.Fatalf("installed community/local provenance = %+v %+v aggregate=%d description fetches=%d", community, local, aggregateReads.Load(), descriptionReads.Load())
	}
	projected := projectPluginStoreSources([]management.PluginStoreSource{{ID: pluginregistry.SourceID(builtinURL), URL: builtinURL}, {ID: pluginregistry.SourceID(pluginregistry.OMCSourceURL), URL: pluginregistry.OMCSourceURL}}, builtinURL)
	if projected[0].SourceKind != "builtin" || projected[1].SourceKind != "omc_community" {
		t.Fatalf("source classifications = %+v", projected)
	}
}
func TestDescriptionRuntimeReleaseFallbackAndVersionSourceCacheIsolation(t *testing.T) {
	var runtimeVersion = "0.1.4"
	var sourceURL = "https://community.example/registry.json"
	var releaseReads atomic.Int32
	raw := `config-version: 8
plugins:
 enabled: true
 store-sources:
  - https://community.example/registry.json
 configs:
  example:
   enabled: true
   store:
    version: 0.1.4
    source-id: ` + pluginregistry.SourceID(sourceURL) + `
    source-url: ` + sourceURL + `
`
	var handler *Handler
	client, baseURL, _ := startDashboardTestServerStoring(t, raw, func(writer http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/v8/management/config.yaml":
			_, _ = writer.Write([]byte(raw))
		case "/v8/management/plugins":
			_, _ = writer.Write([]byte(`{"plugins_enabled":true,"plugins":[{"id":"example","registered":true,"enabled":true,"metadata":{"version":"` + runtimeVersion + `"}}]}`))
		default:
			http.NotFound(writer, request)
		}
	}, func(current *Handler) {
		handler = current
		current.pluginDescriptions.client = &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
			status, body := 200, `{"schema_version":2,"plugins":[{"id":"example","name":"Example","author":"community","description":"Native text","version":"0.1.4","repository":"https://github.com/example/plugin"}]}`
			if strings.Contains(request.URL.Path, "/releases/download/") {
				releaseReads.Add(1)
				body = `{"schema_version":1,"plugin_id":"example","plugin_version":"0.1.4","i18n":{"description":{"en":"Release text"}}}`
			}
			return &http.Response{StatusCode: status, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(body)), Request: request}, nil
		})}
	})
	// The shared harness rejects unauthenticated runtime resources, faithfully
	// exercising Home's common 404/fallback shape without leaking credentials.
	endpoint := baseURL + "/omc/api/v1/management/plugin-descriptions?source_id=" + pluginregistry.SourceID(sourceURL) + "&plugin_id=example&version=0.1.4"
	response, body := getJSON(t, client, endpoint)
	if response.StatusCode != 200 || !strings.Contains(string(body), `"origin":"release"`) || !strings.Contains(string(body), "Release text") {
		t.Fatalf("runtime fallback = %d %s", response.StatusCode, body)
	}
	if releaseReads.Load() != 1 {
		t.Fatalf("release reads = %d", releaseReads.Load())
	}
	_, _ = getJSON(t, client, endpoint)
	if releaseReads.Load() != 1 {
		t.Fatal("same-source version cache was not used")
	}
	for _, unsafe := range []string{"&url=https://private.example", "&target_url=https://private.example"} {
		response, _ = getJSON(t, client, endpoint+unsafe)
		if response.StatusCode != 400 {
			t.Fatal("arbitrary metadata URL accepted")
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	instance, err := handler.repo.GetInstance(ctx, defaultInstanceID())
	if err != nil {
		t.Fatal(err)
	}
	instance.BaseURL = "http://another.invalid"
	if err := handler.repo.UpsertInstance(ctx, instance); err != nil {
		t.Fatal(err)
	}
	response, body = getJSON(t, client, endpoint)
	if response.StatusCode == 200 {
		t.Fatalf("cache leaked across gateway generation: %s", body)
	}
}

func TestOMCCommunitySourceProjectionRequiresExactProvenance(t *testing.T) {
	for _, entry := range []struct {
		name, sourceID, sourceURL, wantKind string
	}{
		{"fixed community identity", "source-a72c6723a965", pluginregistry.OMCSourceURL, "omc_community"},
		{"community URL with another identity", "source-spoof", pluginregistry.OMCSourceURL, "community"},
		{"community identity with another URL", "source-a72c6723a965", "https://other.example/registry.json", "community"},
		{"query changes community identity", "source-a72c6723a965", pluginregistry.OMCSourceURL + "?source=omc", "community"},
		{"same name and OMC tag do not identify source", "source-other", "https://other.example/registry.json", "community"},
		{"official source remains separate", "official", pluginregistry.OfficialSourceURL, "official"},
	} {
		t.Run(entry.name, func(t *testing.T) {
			source := management.PluginStoreSource{ID: entry.sourceID, URL: entry.sourceURL, Name: "OMC Community"}
			projected := projectPluginStoreSources([]management.PluginStoreSource{source}, "https://omc.example/plugin-registry/v2.json")[0]
			plugin := projectStorePlugin(management.StorePluginItem{ID: "omc-anything", SourceID: entry.sourceID, SourceURL: entry.sourceURL, SourceName: source.Name, Tags: []string{"OMC"}})
			if projected.SourceKind != entry.wantKind || plugin.SourceKind != entry.wantKind || projected.IsOfficial != (entry.wantKind == "official") || plugin.IsOfficial != (entry.wantKind == "official") {
				t.Fatalf("source=%+v plugin=%+v want kind=%s", projected, plugin, entry.wantKind)
			}
			if plugin.IsOMC != (entry.wantKind == "omc_community") {
				t.Fatalf("OMC marker must use the same exact source identity: %+v", plugin)
			}
		})
	}
}

// A source whose applicable registry rule injects a credential is refused, because OMC
// cannot forward one. Which rule applies follows CPA's order and matching: the earlier
// substring guess also refused sources that need no credential, and let a differently
// cased origin that CPA would authenticate reach a credential-free request.
func TestCommunityCatalogAuthRefusalUsesCPARuleOrder(t *testing.T) {
	sourceURL := "https://community.example/registry.json"
	credential := fmt.Sprintf("  store-auth:\n    - match: %s\n      type: bearer\n      token-env: SYNTHETIC_TOKEN\n      apply-to: [registry]\n", sourceURL)
	for _, entry := range []struct {
		name      string
		storeAuth string
		wantReads int
		wantError bool
	}{
		{"credential rule refuses", credential, 0, true},
		{"blank kind list applies to the registry read", "  store-auth:\n    - match: " + sourceURL + "\n      type: bearer\n      token-env: SYNTHETIC_TOKEN\n", 0, true},
		{"differently cased origin still applies", fmt.Sprintf("  store-auth:\n    - match: %s\n      type: bearer\n      apply-to: [registry]\n", "HTTPS://Community.EXAMPLE/registry.json"), 0, true},
		{"artifact-only rule does not decide the registry read", "  store-auth:\n    - match: " + sourceURL + "\n      type: bearer\n      apply-to: [artifact]\n", 1, false},
		{"no rule reads without a credential", "", 1, false},
		{"none rule injects nothing", "  store-auth:\n    - match: " + sourceURL + "\n      type: none\n      apply-to: [registry]\n", 1, false},
		{"a later rule cannot override the first match", "  store-auth:\n    - match: https://community.example/\n      type: bearer\n      apply-to: [registry]\n    - match: " + sourceURL + "\n      type: none\n      apply-to: [registry]\n", 0, true},
	} {
		t.Run(entry.name, func(t *testing.T) {
			var reads atomic.Int32
			raw := "config-version: 8\nplugins:\n  enabled: true\n  store-sources:\n    - " + sourceURL + "\n" + entry.storeAuth
			client, baseURL, _ := startDashboardTestServerStoring(t, raw, func(writer http.ResponseWriter, request *http.Request) {
				switch request.URL.Path {
				case "/v8/management/config.yaml":
					_, _ = writer.Write([]byte(raw))
				case "/v8/management/plugins":
					_, _ = writer.Write([]byte(`{"plugins_enabled":true,"plugins":[]}`))
				default:
					http.NotFound(writer, request)
				}
			}, func(current *Handler) {
				current.pluginDescriptions.client = &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
					if request.Header.Get("Authorization") != "" || request.Header.Get("Cookie") != "" {
						t.Error("management credentials sent to a registry")
					}
					reads.Add(1)
					return &http.Response{StatusCode: http.StatusOK, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(`{"schema_version":2,"plugins":[{"id":"example","name":"Example","author":"community","description":"A plugin","version":"1.0.0"}]}`)), Request: request}, nil
				})}
			})
			response, body := getJSON(t, client, baseURL+"/omc/api/v1/management/plugin-store?source_id="+pluginregistry.SourceID(sourceURL))
			var dto struct {
				Plugins      []StorePluginItemDTO        `json:"plugins"`
				SourceErrors []PluginStoreSourceErrorDTO `json:"source_errors"`
				Total        int                         `json:"total"`
			}
			if err := json.Unmarshal(body, &dto); err != nil {
				t.Fatal(err)
			}
			// A refusing source is one failed source inside a page that still renders, so
			// the refusal is read from the per-source error, not a page-level status.
			if response.StatusCode != 200 || int(reads.Load()) != entry.wantReads {
				t.Fatalf("reads=%d want=%d status=%d body=%s", reads.Load(), entry.wantReads, response.StatusCode, body)
			}
			if entry.wantError {
				// The page reports a refusing source with one fixed sentence rather than
				// the reason, so the response cannot quote CPA's configuration back.
				if len(dto.SourceErrors) != 1 || dto.SourceErrors[0].Message != "selected plugin source is unavailable" || dto.Total != 0 || len(dto.Plugins) != 0 {
					t.Fatalf("refusal = %+v %s", dto, body)
				}
				return
			}
			if len(dto.SourceErrors) != 0 || dto.Total != 1 || len(dto.Plugins) != 1 || dto.Plugins[0].ID != "example" || dto.Plugins[0].Version != "1.0.0" {
				t.Fatalf("permitted source = %+v %s", dto, body)
			}
		})
	}
}
