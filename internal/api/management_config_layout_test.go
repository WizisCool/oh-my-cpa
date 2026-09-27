package api

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/configyaml"
)

// A document in the shape CPA v8.0.2 writes after migrating a v7 file.
const layoutFixtureV8 = `config-version: 8
server:
  port: 8317
access:
  api-keys:
    - "client-key"
routing:
  retry:
    request-retry: 3
observability:
  logs:
    debug: false
api-keys:
  codex:
    - name: codex-1
      base-url: "https://codex.example.com/v1"
      keys:
        - api-key: "sk-upstream"
`

const layoutFixtureLegacy = "port: 8317\napi-keys:\n  - \"client-key\"\nrequest-retry: 3\ndebug: false\n"

// generationFixtureCPA serves the configuration fixture as either generation.
func generationFixtureCPA(fixture *configFixtureCPA, hasV8 bool) http.HandlerFunc {
	return func(writer http.ResponseWriter, request *http.Request) {
		if strings.HasPrefix(request.URL.Path, "/v8/") {
			if hasV8 && request.URL.Path == "/v8/management/config/config-version" {
				_, _ = writer.Write([]byte("8"))
				return
			}
			http.NotFound(writer, request)
			return
		}
		fixture.serve(writer, request)
	}
}

type configLayoutResponse struct {
	Revision string `json:"revision"`
	Layout   struct {
		ManagementAPI     string                  `json:"management_api"`
		Layout            string                  `json:"layout"`
		HasProviderGroups bool                    `json:"has_provider_groups"`
		Rules             []configyaml.LayoutRule `json:"rules"`
	} `json:"layout"`
}

func TestConfigLayoutReportsGenerationAndLayout(t *testing.T) {
	cases := []struct {
		name          string
		hasV8         bool
		document      string
		wantAPI       string
		wantLayout    string
		wantProviders bool
	}{
		{"v7 gateway, v7 file", false, layoutFixtureLegacy, "v0", "legacy", false},
		{"v8 gateway, file not yet migrated", true, layoutFixtureLegacy, "v8", "legacy", false},
		{"v8 gateway, migrated file", true, layoutFixtureV8, "v8", "v8", true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			fixture := &configFixtureCPA{yamlData: tc.document}
			client, baseURL, _ := startDashboardTestServer(t, generationFixtureCPA(fixture, tc.hasV8))
			resp, payload := getJSON(t, client, baseURL+"/omc/api/v1/management/config")
			if resp.StatusCode != http.StatusOK {
				t.Fatalf("status %d body %s", resp.StatusCode, payload)
			}
			var body configLayoutResponse
			if err := json.Unmarshal(payload, &body); err != nil {
				t.Fatal(err)
			}
			if body.Layout.ManagementAPI != tc.wantAPI || body.Layout.Layout != tc.wantLayout || body.Layout.HasProviderGroups != tc.wantProviders {
				t.Fatalf("layout = %+v", body.Layout)
			}
			if len(body.Layout.Rules) != len(configyaml.LayoutRules()) {
				t.Fatalf("the console must receive the full rule table, got %d rules", len(body.Layout.Rules))
			}
		})
	}
}

func putConfigSource(t *testing.T, client *http.Client, baseURL, document, revision string) (int, map[string]any) {
	t.Helper()
	body, _ := json.Marshal(map[string]string{"yaml": document, "revision": revision})
	resp, payload := doJSON(t, client, http.MethodPut, baseURL+"/omc/api/v1/management/config/source", string(body))
	var decoded map[string]any
	_ = json.Unmarshal(payload, &decoded)
	return resp.StatusCode, decoded
}

func TestConfigSaveGuardOnV8Gateway(t *testing.T) {
	revision := configyaml.ComputeRevision(layoutFixtureV8)
	withClientList := strings.Replace(layoutFixtureV8, "api-keys:\n  codex:\n    - name: codex-1\n      base-url: \"https://codex.example.com/v1\"\n      keys:\n        - api-key: \"sk-upstream\"\n", "api-keys:\n  - \"new-client-key\"\n", 1)
	cases := []struct {
		name         string
		document     string
		wantStatus   int
		wantCode     string
		wantShadowed []string
	}{
		{"legacy keys added to a v8 file", layoutFixtureV8 + "debug: true\nrequest-retry: 9\n", http.StatusUnprocessableEntity, "config_legacy_keys_shadowed", []string{"debug", "request-retry"}},
		{"client-key list over the provider groups", withClientList, http.StatusUnprocessableEntity, "config_provider_groups_replaced", nil},
		{"edit at the v8 location", strings.Replace(layoutFixtureV8, "    debug: false", "    debug: true", 1), http.StatusOK, "", nil},
		{"legacy-only setting with no v8 twin", layoutFixtureV8 + "quota-exceeded:\n  switch-project: false\n", http.StatusOK, "", nil},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			fixture := &configFixtureCPA{yamlData: layoutFixtureV8}
			client, baseURL, _ := startDashboardTestServer(t, generationFixtureCPA(fixture, true))
			status, body := putConfigSource(t, client, baseURL, tc.document, revision)
			if status != tc.wantStatus {
				t.Fatalf("status %d body %v", status, body)
			}
			fixture.mu.Lock()
			forwarded := len(fixture.putPaths)
			fixture.mu.Unlock()
			if tc.wantCode == "" {
				if forwarded != 1 {
					t.Fatalf("an accepted document must reach CPA once, got %d writes", forwarded)
				}
				return
			}
			if forwarded != 0 {
				t.Fatal("a refused document must never reach CPA")
			}
			if body["code"] != tc.wantCode {
				t.Fatalf("code = %v", body["code"])
			}
			var shadowed []string
			for _, entry := range body["shadowed"].([]any) {
				shadowed = append(shadowed, entry.(map[string]any)["legacy"].(string))
			}
			if strings.Join(shadowed, ",") != strings.Join(tc.wantShadowed, ",") {
				t.Fatalf("shadowed = %v, want %v", shadowed, tc.wantShadowed)
			}
		})
	}
}

// A v7 gateway reads only legacy spellings, so the guard stays out of the way
// and a save behaves exactly as it did before v8 existed.
func TestConfigSaveOnV7GatewayIsUnchanged(t *testing.T) {
	fixture := &configFixtureCPA{yamlData: layoutFixtureLegacy}
	client, baseURL, _ := startDashboardTestServer(t, generationFixtureCPA(fixture, false))
	document := layoutFixtureLegacy + "observability:\n  logs:\n    debug: true\n"
	status, body := putConfigSource(t, client, baseURL, strings.Replace(document, "debug: false", "debug: true", 1), configyaml.ComputeRevision(layoutFixtureLegacy))
	if status != http.StatusOK {
		t.Fatalf("status %d body %v", status, body)
	}
}

func TestManagementV8CapabilityProbe(t *testing.T) {
	for _, hasV8 := range []bool{true, false} {
		fixture := &configFixtureCPA{yamlData: layoutFixtureLegacy}
		client, baseURL, _ := startDashboardTestServer(t, generationFixtureCPA(fixture, hasV8))
		resp, payload := getJSON(t, client, baseURL+"/omc/api/v1/management/capabilities/management-v8")
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("status %d body %s", resp.StatusCode, payload)
		}
		var report CapabilityProbeReport
		if err := json.Unmarshal(payload, &report); err != nil {
			t.Fatal(err)
		}
		want := map[bool]string{true: "supported", false: "missing"}[hasV8]
		if report.Status != want || len(report.Checks) != 1 || report.Checks[0].Endpoint != "/v8/management/config/config-version" {
			t.Fatalf("hasV8=%v report = %+v", hasV8, report)
		}
	}
}
