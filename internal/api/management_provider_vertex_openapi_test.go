package api

import (
	"context"
	"fmt"
	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/management"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestVertexAPIKeyAndModelOpenAPIOptionsRoundTrip(t *testing.T) {
	fixture := newProviderTestFixture(t)
	fixture.state.mu.Lock()
	*fixture.state.providerList("vertex") = []map[string]any{{
		"api-key": "SYNTHETIC-VERTEX", "auth-index": "vx-1", "openapi": false, "openapi-location": "global", "future-key-option": "kept",
		"models": []any{map[string]any{"name": "partner/model", "alias": "first", "openapi": false, "future-model-option": "one"}, map[string]any{"name": "partner/model", "alias": "second", "openapi": true, "future-model-option": "two"}},
	}}
	fixture.state.mu.Unlock()
	row := listedProvider(t, fixture, "vertex-0")
	if row.Behavior == nil || row.Behavior.OpenAPI != "disabled" || row.Behavior.OpenAPILocation == nil || *row.Behavior.OpenAPILocation != "global" || row.ModelEntries[0].Options == nil || row.ModelEntries[0].Options.OpenAPI == nil || *row.ModelEntries[0].Options.OpenAPI || !*row.ModelEntries[1].Options.OpenAPI {
		t.Fatalf("projection: %+v", row)
	}
	body := `{"family":"vertex","name":"Vertex","keys":[{"api_key":""}],"behavior":{"openapi":"enabled","openapi_location":" us-central1 "},"model_entries":[{"name":"partner/model","alias":"first","options":{"openapi":false,"display_name":"Edited"}},{"name":"partner/model","alias":"second","options":{"openapi":true}}]}`
	response, raw := doJSON(t, fixture.client, http.MethodPut, fixture.baseURL+providersEndpoint+"/vertex-0", body)
	if response.StatusCode != 200 {
		t.Fatalf("save: %d %s", response.StatusCode, raw)
	}
	fixture.state.mu.Lock()
	stored := (*fixture.state.providerList("vertex"))[0]
	models := anyList(stored["models"])
	if stored["openapi"] != true || stored["openapi-location"] != "us-central1" || stored["future-key-option"] != "kept" || models[0].(map[string]any)["openapi"] != false || models[1].(map[string]any)["openapi"] != true || models[0].(map[string]any)["future-model-option"] != "one" || models[1].(map[string]any)["future-model-option"] != "two" {
		t.Errorf("exact stored policy: %#v", stored)
	}
	fixture.state.mu.Unlock()
	body = `{"family":"vertex","name":"Vertex","keys":[{"api_key":""}],"behavior":{"openapi":"inherit","openapi_location":""},"model_entries":[{"name":"partner/model","alias":"first","options":{}},{"name":"partner/model","alias":"second","options":{"openapi":false}}]}`
	response, raw = doJSON(t, fixture.client, http.MethodPut, fixture.baseURL+providersEndpoint+"/vertex-0", body)
	if response.StatusCode != 200 {
		t.Fatalf("clear: %d %s", response.StatusCode, raw)
	}
	row = listedProvider(t, fixture, "vertex-0")
	if row.Behavior.OpenAPI != "inherit" || *row.Behavior.OpenAPILocation != "" || row.ModelEntries[0].Options != nil || row.ModelEntries[1].Options.OpenAPI == nil || *row.ModelEntries[1].Options.OpenAPI {
		t.Fatalf("inherit/false projection: %+v", row)
	}
	for _, payload := range []string{
		`{"family":"codex","name":"Bad","base_url":"https://codex.test/v1","api_key":"SYNTHETIC","behavior":{"openapi":"disabled"}}`,
		`{"family":"codex","name":"Bad","base_url":"https://codex.test/v1","api_key":"SYNTHETIC","behavior":{"openapi_location":"global"}}`,
		`{"family":"codex","name":"Bad","base_url":"https://codex.test/v1","api_key":"SYNTHETIC","model_entries":[{"name":"m","options":{"openapi":false}}]}`,
		`{"family":"vertex","name":"Bad","api_key":"SYNTHETIC","behavior":{"openapi":"sometimes"}}`,
		`{"family":"vertex","name":"Bad","api_key":"SYNTHETIC","behavior":{"openapi_location":"../global"}}`,
	} {
		response, raw = doJSON(t, fixture.client, http.MethodPost, fixture.baseURL+providersEndpoint, payload)
		if response.StatusCode != 400 {
			t.Fatalf("invalid policy accepted: %d %s", response.StatusCode, raw)
		}
	}
}

func TestProviderFamilyMoveKeepsOnlySupportedOpenAPIPolicy(t *testing.T) {
	isOpenAPI := false
	source := []management.ModelAlias{{Name: "partner/model", Alias: "one", OpenAPI: &isOpenAPI}}
	vertex := supportedProviderMoveModels(append([]management.ModelAlias{}, source...), "vertex")
	if vertex[0].OpenAPI == nil || *vertex[0].OpenAPI {
		t.Fatal("Vertex move lost explicit false")
	}
	for _, family := range []string{"codex", "claude", "openai-compatibility"} {
		converted := supportedProviderMoveModels(append([]management.ModelAlias{}, source...), family)
		if converted[0].OpenAPI != nil {
			t.Fatalf("%s move retained Vertex-only policy", family)
		}
	}
}

func TestVertexOpenAPIReadbackRefusesDroppedPolicy(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/v8/management/config/config-version":
			fmt.Fprint(w, "8")
		case r.URL.Path == "/v0/management/config.yaml":
			fmt.Fprint(w, "config-version: 8\n")
		case r.URL.Path == "/v8/management/config/api-keys/vertex":
			fmt.Fprint(w, `[{"name":"vertex","keys":[{"api-key":"SYNTHETIC-KEY","openapi":true}]}]`)
		case r.URL.Path == "/v8/management/config" && r.Method == http.MethodPatch:
			fmt.Fprint(w, `{"status":"ok"}`)
		case r.URL.Path == "/v0/management/vertex-api-key":
			fmt.Fprint(w, `{"vertex-api-key":[{"api-key":"SYNTHETIC-KEY","openapi":true}]}`)
		default:
			fmt.Fprint(w, `{}`)
		}
	}))
	defer server.Close()
	client, err := management.NewClient(server.URL, "synthetic-management", time.Second, false)
	if err != nil {
		t.Fatal(err)
	}
	isOpenAPI := false
	err = updateConfigKeysAndVerifyVertexPolicy(context.Background(), client, management.ConfigFamilyVertex, []management.ConfigAPIKey{{APIKey: "SYNTHETIC-KEY", OpenAPI: &isOpenAPI}})
	if err == nil || !strings.Contains(err.Error(), "could not be verified") {
		t.Fatalf("dropped policy was reported saved: %v", err)
	}
}
