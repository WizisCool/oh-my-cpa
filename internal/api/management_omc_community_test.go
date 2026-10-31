package api

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/oh-my-cpa/oh-my-cpa/internal/pluginregistry"
)

func TestOMCCommunityCatalogReadsOnlyFixedSourceWithoutRegisteringIt(t *testing.T) {
	const raw = `config-version: 8
plugins:
  enabled: true
  store-sources:
    - https://unrelated.example/registry.json
  configs:
    omcpa-codex-candy-eval:
      enabled: false
      store:
        id: omcpa-codex-candy-eval
        version: 0.4.0-omc.4
        source-id: source-a72c6723a965
        source-url: https://raw.githubusercontent.com/WizisCool/oh-my-cpa/main/plugins/registry.json
`
	var registryReads, mutations, aggregateReads atomic.Int32
	client, baseURL, _ := startDashboardTestServerStoring(t, raw, func(writer http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodGet && request.Method != http.MethodHead {
			mutations.Add(1)
		}
		switch request.URL.Path {
		case "/v8/management/config.yaml":
			_, _ = io.WriteString(writer, raw)
		case "/v8/management/plugins":
			_, _ = io.WriteString(writer, `{"plugins_enabled":true,"plugins":[{"id":"omcpa-codex-candy-eval","path":"plugins/candy.so","enabled":false,"registered":true,"effective_enabled":false,"metadata":{"version":"0.4.0-omc.4","description":"Native community description"}}]}`)
		case "/v8/management/plugins/store":
			aggregateReads.Add(1)
			http.Error(writer, "aggregate forbidden", 500)
		default:
			http.NotFound(writer, request)
		}
	}, func(handler *Handler) {
		handler.pluginLogos.client.Transport = roundTripFunc(func(request *http.Request) (*http.Response, error) {
			t.Errorf("community catalog must not fetch remote artwork: %s", request.URL)
			return &http.Response{StatusCode: 404, Header: http.Header{}, Body: io.NopCloser(strings.NewReader("")), Request: request}, nil
		})
		handler.pluginDescriptions.client = &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
			if request.URL.String() != pluginregistry.OMCSourceURL || request.Method != http.MethodGet || request.Header.Get("Authorization") != "" || request.Header.Get("Cookie") != "" {
				t.Errorf("unexpected catalog request %s headers=%v", request.URL, request.Header)
			}
			registryReads.Add(1)
			return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(`{"schema_version":2,"plugins":[{"id":"omcpa-codex-candy-eval","name":"Candy","version":"0.4.0-omc.4","tags":["OMC"],"description":"Community evaluation","logo":"https://unrelated.example/logo.png"}]}`)), Request: request}, nil
		})}
	})
	response, body := getJSON(t, client, baseURL+"/omc/api/v1/management/omc-community-plugins")
	var dto struct {
		SourceEnabled  bool                        `json:"source_enabled"`
		SourceID       string                      `json:"source_id"`
		PluginsEnabled *bool                       `json:"plugins_enabled"`
		Sources        []PluginStoreSourceDTO      `json:"sources"`
		SourceErrors   []PluginStoreSourceErrorDTO `json:"source_errors"`
		Plugins        []StorePluginItemDTO        `json:"plugins"`
	}
	if err := json.Unmarshal(body, &dto); err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != 200 || !dto.SourceEnabled || dto.SourceID != "source-a72c6723a965" || dto.PluginsEnabled == nil || !*dto.PluginsEnabled || len(dto.Sources) != 1 || dto.Sources[0].SourceKind != "omc_community" || dto.Sources[0].IsOfficial || len(dto.SourceErrors) != 0 || len(dto.Plugins) != 1 {
		t.Fatalf("community response %d %s", response.StatusCode, body)
	}
	plugin := dto.Plugins[0]
	if plugin.SourceKind != "omc_community" || plugin.IsOfficial || !plugin.Installed || plugin.InstalledVersion != "0.4.0-omc.4" || plugin.EffectiveEnabled {
		t.Fatalf("community install identity changed: %+v", plugin)
	}
	if registryReads.Load() != 1 || aggregateReads.Load() != 0 || mutations.Load() != 0 {
		t.Fatalf("registry=%d aggregate=%d mutations=%d", registryReads.Load(), aggregateReads.Load(), mutations.Load())
	}
	response, body = getJSON(t, client, baseURL+"/omc/api/v1/management/plugins")
	var installed struct {
		Plugins []PluginItemDTO `json:"plugins"`
	}
	if err := json.Unmarshal(body, &installed); err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != 200 || len(installed.Plugins) != 1 || installed.Plugins[0].SourceKind != "omc_community" || installed.Plugins[0].SourceID != "source-a72c6723a965" || installed.Plugins[0].InstalledVersion != "0.4.0-omc.4" || installed.Plugins[0].Description != "Native community description" {
		t.Fatalf("installed community provenance/description %d %s", response.StatusCode, body)
	}
	response, body = getJSON(t, client, baseURL+"/omc/api/v1/management/plugin-descriptions?source_id=source-a72c6723a965&plugin_id=omcpa-codex-candy-eval&version=0.4.0-omc.4")
	// The installed list uses the native registration text above; this dedicated
	// request reads the selected catalog and is not warmed by that list.
	if response.StatusCode != 200 || !strings.Contains(string(body), `"description":"Community evaluation"`) || mutations.Load() != 0 || aggregateReads.Load() != 0 {
		t.Fatalf("fixed-source description %d %s writes=%d aggregate=%d", response.StatusCode, body, mutations.Load(), aggregateReads.Load())
	}
}

func TestDisabledOMCCommunityCatalogHasNoNetworkOrBuiltinPolicyEffect(t *testing.T) {
	var requests atomic.Int32
	var handler *Handler
	client, baseURL, repo := startDashboardTestServerStoring(t, managedSourceStoredYAML, func(writer http.ResponseWriter, request *http.Request) {
		requests.Add(1)
		t.Errorf("disabled catalog reached CPA: %s %s", request.Method, request.URL.Path)
		http.NotFound(writer, request)
	}, func(current *Handler) { handler = current })
	handler.pluginDescriptions.client.Transport = roundTripFunc(func(request *http.Request) (*http.Response, error) {
		requests.Add(1)
		t.Errorf("disabled catalog reached a registry: %s", request.URL)
		return nil, context.Canceled
	})
	ctx := context.Background()
	instance, err := repo.GetInstance(ctx, "default")
	if err != nil {
		t.Fatal(err)
	}
	before, err := repo.BuiltinPolicy(ctx, instance)
	if err != nil {
		t.Fatal(err)
	}
	setManagedSourcePreference(t, repo, false)
	response, body := getJSON(t, client, baseURL+"/omc/api/v1/management/omc-community-plugins")
	var dto OMCCommunityPluginsDTO
	if err := json.Unmarshal(body, &dto); err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != 200 || dto.SourceEnabled || dto.SourceID != "source-a72c6723a965" || dto.PluginsEnabled != nil || dto.Total != 0 || dto.Plugins == nil || len(dto.Plugins) != 0 || len(dto.SourceErrors) != 0 || len(dto.Sources) != 1 || dto.Sources[0].SourceKind != "omc_community" || dto.Sources[0].Name != "OMC Community" {
		t.Fatalf("disabled catalog %d %s", response.StatusCode, body)
	}
	after, err := repo.BuiltinPolicy(ctx, instance)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(before, after) || requests.Load() != 0 {
		t.Fatalf("policy changed: before=%+v after=%+v requests=%d", before, after, requests.Load())
	}
	for _, query := range []string{"?url=https://other.example/registry.json", "?source_id=official", "?version=1"} {
		response, body = getJSON(t, client, baseURL+"/omc/api/v1/management/omc-community-plugins"+query)
		if response.StatusCode != 400 || requests.Load() != 0 {
			t.Fatalf("unexpected source query %d %s requests=%d", response.StatusCode, body, requests.Load())
		}
	}
}

func TestOMCCommunityCatalogReportsSourceFailuresWithoutLeakingOrFetchingOthers(t *testing.T) {
	for _, entry := range []struct {
		name              string
		registryStatus    int
		registryBody      string
		configUnavailable bool
	}{
		{name: "registry unavailable", registryStatus: 503, registryBody: "private-upstream-detail"},
		{name: "registry redirect refused", registryStatus: 302},
		{name: "invalid registry", registryStatus: 200, registryBody: "private-upstream-detail"},
		{name: "CPA configuration unavailable", configUnavailable: true},
	} {
		t.Run(entry.name, func(t *testing.T) {
			var registryReads, writes, aggregateReads atomic.Int32
			client, baseURL, _ := startDashboardTestServerStoring(t, managedSourceStoredYAML, func(writer http.ResponseWriter, request *http.Request) {
				if request.Method != http.MethodGet && request.Method != http.MethodHead {
					writes.Add(1)
				}
				switch request.URL.Path {
				case "/v8/management/config.yaml":
					if entry.configUnavailable {
						http.Error(writer, "private-upstream-detail", 503)
						return
					}
					_, _ = io.WriteString(writer, "config-version: 8\nplugins:\n  enabled: false\n  store-sources:\n    - https://other.example/registry.json\n")
				case "/v8/management/plugins/store":
					aggregateReads.Add(1)
					http.Error(writer, "aggregate forbidden", 500)
				default:
					http.NotFound(writer, request)
				}
			}, func(handler *Handler) {
				handler.pluginDescriptions.client.Transport = roundTripFunc(func(request *http.Request) (*http.Response, error) {
					registryReads.Add(1)
					if request.URL.String() != pluginregistry.OMCSourceURL || len(request.Header.Values("Authorization")) != 0 {
						t.Errorf("unexpected request %s %v", request.URL, request.Header)
					}
					return &http.Response{StatusCode: entry.registryStatus, Header: http.Header{"Location": []string{"https://other.example/registry.json"}}, Body: io.NopCloser(strings.NewReader(entry.registryBody)), Request: request}, nil
				})
			})
			response, body := getJSON(t, client, baseURL+"/omc/api/v1/management/omc-community-plugins")
			var dto OMCCommunityPluginsDTO
			if err := json.Unmarshal(body, &dto); err != nil {
				t.Fatal(err)
			}
			wantReads := int32(1)
			if entry.configUnavailable {
				wantReads = 0
			}
			if response.StatusCode != 200 || !dto.SourceEnabled || len(dto.Sources) != 1 || len(dto.SourceErrors) != 1 || dto.SourceErrors[0].SourceID != "source-a72c6723a965" || len(dto.Plugins) != 0 || dto.Total != 0 || strings.Contains(string(body), "private-upstream-detail") || writes.Load() != 0 || aggregateReads.Load() != 0 || registryReads.Load() != wantReads {
				t.Fatalf("source failure %d %s reads=%d writes=%d aggregate=%d", response.StatusCode, body, registryReads.Load(), writes.Load(), aggregateReads.Load())
			}
			if (dto.PluginsEnabled == nil) != entry.configUnavailable || (dto.PluginsEnabled != nil && *dto.PluginsEnabled) {
				t.Fatalf("unknown/global-disabled state conflated: %s", body)
			}
		})
	}
}
