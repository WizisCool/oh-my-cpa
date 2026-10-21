package api

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/oh-my-cpa/oh-my-cpa/internal/capability"
	"github.com/oh-my-cpa/oh-my-cpa/internal/operations"
)

func TestAgentVertexProviderPolicyConfirmedEdit(t *testing.T) {
	fixture := newProviderTestFixture(t)
	fixture.state.mu.Lock()
	*fixture.state.providerList("vertex") = []map[string]any{{"api-key": "SYNTHETIC-KEY", "auth-index": "vx-1", "openapi": true, "openapi-location": "global", "models": []any{map[string]any{"name": "partner/model", "alias": "one", "openapi": false, "display-name": "Preserved"}}}}
	fixture.state.mu.Unlock()
	service := fixture.handler.operationsService()
	registry := capability.NewRegistry()
	if err := service.Register(registry); err != nil {
		t.Fatal(err)
	}
	definition, err := registry.Lookup("providers_update", capability.Principal{Adapter: "mcp", IsAdmin: true})
	if err != nil || definition.Prepare == nil || definition.Permission != "write" || definition.Risk != "high" {
		t.Fatalf("confirmed capability: %+v %v", definition, err)
	}
	arguments := json.RawMessage(`{"id":"vertex-0","openapi":"disabled","openapi_location":"us-central1","models":[{"name":"partner/model","alias":"one","openapi":"inherit"}]}`)
	preview, err := definition.Prepare(context.Background(), arguments)
	if err != nil || preview.Revision == "" {
		t.Fatalf("preview: %+v %v", preview, err)
	}
	if _, err = definition.Execute(context.Background(), arguments, "stale", ""); err == nil {
		t.Fatal("stale revision accepted")
	}
	if _, err = definition.Execute(context.Background(), arguments, preview.Revision, ""); err != nil {
		t.Fatal(err)
	}
	provider, err := service.FindProvider(context.Background(), "vertex-0")
	if err != nil || provider.OpenAPI != "disabled" || provider.OpenAPILocation == nil || *provider.OpenAPILocation != "us-central1" || len(provider.ModelEntries) != 1 || provider.ModelEntries[0].OpenAPI != "inherit" {
		t.Fatalf("safe read: %+v %v", provider, err)
	}
	fixture.state.mu.Lock()
	stored := (*fixture.state.providerList("vertex"))[0]
	model := anyList(stored["models"])[0].(map[string]any)
	if _, exists := model["openapi"]; exists || model["display-name"] != "Preserved" || stored["api-key"] != "SYNTHETIC-KEY" {
		t.Errorf("model policy patch changed siblings: %#v", stored)
	}
	fixture.state.mu.Unlock()
	if _, err = definition.Prepare(context.Background(), json.RawMessage(`{"id":"codex-0","openapi":"enabled"}`)); err == nil {
		t.Fatal("non-Vertex preview accepted")
	}
}

func TestAgentVertexAliasNormalizationCarriesExplicitFalse(t *testing.T) {
	fixture := newProviderTestFixture(t)
	service := fixture.handler.operationsService()
	isOpenAPI := false
	aliases := []operations.OAuthModelAlias{{Name: "partner/model", Alias: "one", OpenAPI: &isOpenAPI}}
	provider, normalized, err := service.NormalizeOAuthModelAliases(" Vertex ", aliases)
	if err != nil || provider != "vertex" || len(normalized) != 1 || normalized[0].OpenAPI == nil || *normalized[0].OpenAPI {
		t.Fatalf("normalization lost override: %s %+v %v", provider, normalized, err)
	}
	if _, _, err = service.NormalizeOAuthModelAliases("codex", aliases); err == nil {
		t.Fatal("non-Vertex alias override accepted")
	}
}

func TestAgentVertexAliasRenamePreservesOpenAPI(t *testing.T) {
	fixture := newProviderTestFixture(t)
	fixture.state.mu.Lock()
	*fixture.state.providerList("vertex") = []map[string]any{{
		"api-key": "SYNTHETIC-KEY", "auth-index": "vx-1",
		"models": []any{
			map[string]any{"name": "partner/model", "alias": "one", "openapi": false},
			map[string]any{"name": "partner/model", "alias": "two", "openapi": true},
		},
	}}
	fixture.state.mu.Unlock()
	service := fixture.handler.operationsService()
	registry := capability.NewRegistry()
	if err := service.Register(registry); err != nil {
		t.Fatal(err)
	}
	definition, err := registry.Lookup("providers_update", capability.Principal{Adapter: "mcp", IsAdmin: true})
	if err != nil {
		t.Fatal(err)
	}
	arguments := json.RawMessage(`{"id":"vertex-0","models":[{"name":"partner/model","alias":"one-renamed"},{"name":"partner/model","alias":"two"}]}`)
	preview, err := definition.Prepare(context.Background(), arguments)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = definition.Execute(context.Background(), arguments, preview.Revision, ""); err != nil {
		t.Fatal(err)
	}
	fixture.state.mu.Lock()
	defer fixture.state.mu.Unlock()
	rows := anyList((*fixture.state.providerList("vertex"))[0]["models"])
	if value, exists := rows[0].(map[string]any)["openapi"]; !exists || value != false {
		t.Fatalf("renaming one alias silently removed its explicit false policy: first=%#v second=%#v", rows[0], rows[1])
	}
}

func TestAgentProviderOpenAPIExecutionRejectsOtherFamilies(t *testing.T) {
	fixture := newProviderTestFixture(t)
	service := fixture.handler.operationsService()
	current, err := service.FindProvider(context.Background(), "codex-0")
	if err != nil {
		t.Fatal(err)
	}
	registry := capability.NewRegistry()
	if err := service.Register(registry); err != nil {
		t.Fatal(err)
	}
	definition, err := registry.Lookup("providers_update", capability.Principal{Adapter: "mcp", IsAdmin: true})
	if err != nil {
		t.Fatal(err)
	}
	for _, argument := range []string{
		`{"id":"codex-0","openapi":"enabled"}`,
		`{"id":"codex-0","openapi_location":"global"}`,
	} {
		_, err = definition.Execute(context.Background(), json.RawMessage(argument), current.Revision, "")
		if err == nil || err.Error() != "invalid_parameters" {
			t.Fatalf("non-Vertex override classification = %v, want invalid_parameters", err)
		}
	}
}

func TestAgentVertexAmbiguousAliasRenamesRefuseBeforeWriting(t *testing.T) {
	fixture := newProviderTestFixture(t)
	fixture.state.mu.Lock()
	*fixture.state.providerList("vertex") = []map[string]any{{
		"api-key": "SYNTHETIC-KEY", "auth-index": "vx-1",
		"models": []any{
			map[string]any{"name": "partner/model", "alias": "one", "openapi": false},
			map[string]any{"name": "partner/model", "alias": "two", "openapi": true},
		},
	}}
	before := fixture.state.putCount
	fixture.state.mu.Unlock()
	service := fixture.handler.operationsService()
	current, err := service.FindProvider(context.Background(), "vertex-0")
	if err != nil {
		t.Fatal(err)
	}
	registry := capability.NewRegistry()
	if err := service.Register(registry); err != nil {
		t.Fatal(err)
	}
	definition, err := registry.Lookup("providers_update", capability.Principal{Adapter: "mcp", IsAdmin: true})
	if err != nil {
		t.Fatal(err)
	}
	arguments := json.RawMessage(`{"id":"vertex-0","models":[{"name":"partner/model","alias":"first-renamed"},{"name":"partner/model","alias":"second-renamed"}]}`)
	_, err = definition.Execute(context.Background(), arguments, current.Revision, "")
	if err == nil || err.Error() != "invalid_parameters" {
		t.Fatalf("ambiguous aliases: %v", err)
	}
	fixture.state.mu.Lock()
	defer fixture.state.mu.Unlock()
	if fixture.state.putCount != before {
		t.Fatal("ambiguous aliases reached the gateway write")
	}
	rows := anyList((*fixture.state.providerList("vertex"))[0]["models"])
	if rows[0].(map[string]any)["openapi"] != false || rows[1].(map[string]any)["openapi"] != true {
		t.Fatalf("ambiguous rename changed policy: %#v", rows)
	}
}
