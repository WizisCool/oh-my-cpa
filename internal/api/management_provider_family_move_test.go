package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"reflect"
	"strings"
	"testing"

	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/management"
	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
)

func TestProviderProtocolChange(t *testing.T) {
	families := []string{openAICompatibilityFamily}
	for _, spec := range providerConfigFamilies {
		families = append(families, string(spec.Family))
	}
	for _, source := range families {
		for _, target := range families {
			if source == target {
				continue
			}
			t.Run(source+"_to_"+target, func(t *testing.T) {
				fixture := newProviderTestFixture(t)
				state := fixture.state
				state.mu.Lock()
				if len(*state.providerList(source)) == 0 {
					*state.providerList(source) = []map[string]any{{"api-key": "move-fixture-key", "auth-index": "move-fixture-index", "base-url": "https://relay.example.test/v1"}}
				}
				beforeTarget := len(*state.providerList(target))
				var originalKey any
				if source == openAICompatibilityFamily {
					originalKey = "sk-provider-secret-key-1234"
				} else {
					originalKey = (*state.providerList(source))[0]["api-key"]
				}
				state.mu.Unlock()
				id := idPrefixForFamily(source) + "0"
				body := fmt.Sprintf(`{"family":%q,"name":"Moved provider","base_url":"https://relay.example.test/v1","disabled":true,"prefix":"team","priority":3,"headers":{"x-team":"one"},"runtime_policy":{"cooling":"disabled","request_retry":2},"model_entries":[{"name":"model-one","alias":"alias-one","thinking":{"levels":["high"]}}]}`, target)
				resp, payload := doJSON(t, fixture.client, http.MethodPut, fixture.baseURL+"/omc/api/v1/management/providers/"+id, body)
				if resp.StatusCode != http.StatusOK {
					t.Fatalf("status %d: %s", resp.StatusCode, payload)
				}
				var result struct {
					ID  string   `json:"id"`
					IDs []string `json:"ids"`
				}
				if err := json.Unmarshal(payload, &result); err != nil {
					t.Fatal(err)
				}
				wantID := fmt.Sprintf("%s%d", idPrefixForFamily(target), beforeTarget)
				if result.ID != wantID || !reflect.DeepEqual(result.IDs, []string{wantID}) {
					t.Fatalf("destination = %s", payload)
				}
				if strings.Contains(string(payload), fmt.Sprint(originalKey)) {
					t.Fatal("write response exposed a credential")
				}
				state.mu.Lock()
				defer state.mu.Unlock()
				if len(*state.providerList(source)) != 0 || len(*state.providerList(target)) != beforeTarget+1 {
					t.Fatal("provider was not moved between families")
				}
				moved := (*state.providerList(target))[beforeTarget]
				if target == openAICompatibilityFamily {
					keys := anyList(moved["api-key-entries"])
					if len(keys) != 1 || keys[0].(map[string]any)["api-key"] != originalKey || moved["disabled"] != true {
						t.Fatal("compatibility credential or disabled state lost")
					}
				} else if moved["api-key"] != originalKey || !reflect.DeepEqual(moved["excluded-models"], []any{"*"}) {
					t.Fatal("config credential or disabled state lost")
				}
				if moved["base-url"] != "https://relay.example.test/v1" || moved["prefix"] != "team" || moved["priority"] != float64(3) || moved["disable-cooling"] != true || moved["request-retry"] != float64(2) {
					t.Fatal("shared provider settings lost")
				}
				models := anyList(moved["models"])
				if len(models) != 1 || models[0].(map[string]any)["alias"] != "alias-one" || !reflect.DeepEqual(models[0].(map[string]any)["thinking"], map[string]any{"levels": []any{"high"}}) {
					t.Fatal("model alias or thinking settings lost")
				}
				if !reflect.DeepEqual(moved["headers"], map[string]any{"x-team": "one"}) {
					t.Fatal("provider headers lost")
				}
			})
		}
	}
}

func TestProviderProtocolChangePreservesEveryKeyAndMovesMetadata(t *testing.T) {
	fixture := newProviderTestFixture(t)
	ctx := context.Background()
	state := fixture.state
	state.mu.Lock()
	state.oaiProviders[0]["api-keys"] = []string{"first-move-key", "second-move-key"}
	state.oaiProviders = append(state.oaiProviders, map[string]any{"name": "next", "base-url": "https://next.example.test", "api-keys": []string{"next-key"}})
	state.mu.Unlock()
	for _, key := range []string{repository.PreferenceProviderNames, repository.PreferenceProviderWebsites, repository.PreferenceProviderIcons} {
		if err := fixture.handler.repo.PutPreference(ctx, key, `{"openai-compat-0":"original","openai-compat-1":"neighbour","codex-0":"untouched"}`); err != nil {
			t.Fatal(err)
		}
	}
	resp, payload := doJSON(t, fixture.client, http.MethodPut, fixture.baseURL+"/omc/api/v1/management/providers/openai-compat-0", `{"family":"codex","name":"Moved","base_url":"https://relay.example.test","website":"https://site.example.test","keys":[{"api_key":"","proxy_url":"http://proxy.example.test","weight":4},{"api_key":"","weight":7}]}`)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status %d: %s", resp.StatusCode, payload)
	}
	for _, key := range []string{repository.PreferenceProviderNames, repository.PreferenceProviderWebsites, repository.PreferenceProviderIcons} {
		raw, _, err := fixture.handler.repo.GetPreference(ctx, key)
		if err != nil {
			t.Fatal(err)
		}
		values := map[string]string{}
		if err := json.Unmarshal([]byte(raw), &values); err != nil {
			t.Fatal(err)
		}
		want := "original"
		if key == repository.PreferenceProviderNames {
			want = "Moved"
		}
		if key == repository.PreferenceProviderWebsites {
			want = "https://site.example.test"
		}
		if values["codex-1"] != want || values["codex-2"] != want || values["openai-compat-0"] != "neighbour" || values["codex-0"] != "untouched" || len(values) != 4 {
			t.Fatalf("wrong metadata after move: %s", raw)
		}
	}
	state.mu.Lock()
	defer state.mu.Unlock()
	if len(state.codexProviders) != 3 || state.codexProviders[1]["api-key"] != "first-move-key" || state.codexProviders[2]["api-key"] != "second-move-key" || state.codexProviders[1]["weight"] != float64(4) || state.codexProviders[2]["weight"] != float64(7) || state.codexProviders[1]["proxy-url"] != "http://proxy.example.test" {
		t.Fatal("multi-key move lost credentials or key settings")
	}
}

func TestProviderProtocolChangeRefusesInvalidTargetsAndStaleIdentity(t *testing.T) {
	for _, test := range []struct {
		body     string
		status   int
		wantCode string
	}{
		{`{"family":"unknown"}`, 400, ""},
		{`{"family":"codex","base_url":""}`, 400, ""},
		{`{"family":"claude","expected_name":"stale"}`, 409, providerStaleIdentityCode},
		{`{"family":"claude","website":"javascript:bad"}`, 400, ""},
		{`{"family":"codex","base_url":"https://relay.test","keys":[{"api_key":"fixture-one"},{"api_key":"fixture-one"}]}`, 400, providerDuplicateKeyCode},
		{`{"family":"codex","base_url":"https://relay.test","keys":[{"api_key":"fixture-one"},{"api_key":" "}]}`, 400, providerKeyRequiredCode},
	} {
		t.Run(test.body, func(t *testing.T) {
			fixture := newProviderTestFixture(t)
			resp, payload := doJSON(t, fixture.client, http.MethodPut, fixture.baseURL+"/omc/api/v1/management/providers/openai-compat-0", test.body)
			if resp.StatusCode != test.status {
				t.Fatalf("status %d: %s", resp.StatusCode, payload)
			}
			var refusal struct {
				Code string `json:"code"`
			}
			if err := json.Unmarshal(payload, &refusal); err != nil {
				t.Fatalf("decode refusal: %v", err)
			}
			if refusal.Code != test.wantCode {
				t.Errorf("code=%q, want %q", refusal.Code, test.wantCode)
			}
			fixture.state.mu.Lock()
			defer fixture.state.mu.Unlock()
			if fixture.state.putCount != 0 {
				t.Fatal("refused migration wrote to CPA")
			}
		})
	}
}

func TestProviderProtocolChangeRequiresAuditAndReportsPartialMetadataCommit(t *testing.T) {
	t.Run("audit", func(t *testing.T) {
		h := &Handler{}
		_, err := h.moveProviderFamily(context.Background(), nil, "claude-0", "claude", "codex", 0,
			SaveProviderRequest{Family: "codex", BaseURL: "https://relay.test"},
			func(string, string, string, string, map[string]any) error { return errors.New("audit unavailable") })
		var refusal *providerWriteError
		if !errors.As(err, &refusal) || refusal.status != http.StatusInternalServerError {
			t.Fatalf("audit did not abort before contacting CPA: %v", err)
		}
	})
	t.Run("metadata", func(t *testing.T) {
		fixture := newProviderTestFixture(t)
		if err := fixture.handler.repo.PutPreference(context.Background(), repository.PreferenceProviderNames, "invalid JSON"); err != nil {
			t.Fatal(err)
		}
		resp, payload := doJSON(t, fixture.client, http.MethodPut, fixture.baseURL+"/omc/api/v1/management/providers/claude-0", `{"family":"codex","name":"Moved","base_url":"https://relay.test"}`)
		if resp.StatusCode != http.StatusInternalServerError || !strings.Contains(string(payload), providerPartialCommitCode) {
			t.Fatalf("partial commit = %d %s", resp.StatusCode, payload)
		}
		fixture.state.mu.Lock()
		defer fixture.state.mu.Unlock()
		if len(fixture.state.claudeProviders) != 0 || len(fixture.state.codexProviders) != 2 {
			t.Fatal("partial-commit response did not describe an accepted migration")
		}
	})
}

func TestProviderProtocolChangeRefusesDestinationCollision(t *testing.T) {
	fixture := newProviderTestFixture(t)
	resp, payload := doJSON(t, fixture.client, http.MethodPut, fixture.baseURL+"/omc/api/v1/management/providers/claude-0", `{"family":"codex","base_url":"https://api.openai.com","api_key":"sk-codex-secret-key-9999"}`)
	if resp.StatusCode != http.StatusConflict {
		t.Fatalf("collision = %d %s", resp.StatusCode, payload)
	}
	fixture.state.mu.Lock()
	defer fixture.state.mu.Unlock()
	if fixture.state.putCount != 0 || len(fixture.state.claudeProviders) != 1 || len(fixture.state.codexProviders) != 1 {
		t.Fatal("collision changed either provider family")
	}
}

func TestProviderProtocolChangePreservesKeyOverrides(t *testing.T) {
	var source management.OpenAICompatibility
	if err := json.Unmarshal([]byte(`{"name":"relay","base-url":"https://relay.test","api-key-entries":[{"api-key":"move-key","headers":{"x-key":"local"},"excluded-models":["*"],"models":[{"name":"key-model","image":true,"use-max-completion-tokens":true}]}]}`), &source); err != nil {
		t.Fatal(err)
	}
	request := SaveProviderRequest{Family: "codex", Name: "Moved", BaseURL: "https://relay.test", Headers: map[string]string{"x-shared": "new"}}
	policy, err := resolveProviderPolicyEdit("codex", request)
	if err != nil {
		t.Fatal(err)
	}
	result, err := convertProviderFamily(management.ProviderFamilyEntry{Compatibility: &source}, "codex", request, nil, policy)
	if err != nil {
		t.Fatal(err)
	}
	key := result.Keys[0]
	if key.Headers["x-key"] != "local" || !management.IsExcludedAll(key.ExcludedModels) || len(key.Models) != 1 || key.Models[0].Name != "key-model" || key.Models[0].Image || key.Models[0].UseMaxCompletionTokens {
		t.Fatal("key-level common overrides or target model capabilities lost")
	}
}

func TestProviderProtocolChangePreservesKeyRuntimePolicy(t *testing.T) {
	fixture := newProviderTestFixture(t)
	fixture.state.mu.Lock()
	fixture.state.oaiProviders = []map[string]any{{
		"name": "policy-relay", "base-url": "https://relay.test/v1", "request-retry": float64(2),
		"api-key-entries": []any{
			map[string]any{"api-key": "explicit-policy-key", "disable-cooling": false, "request-retry": float64(7), "request-scoped-errors": []any{map[string]any{"status": float64(429), "match": []any{"quota"}, "action": "continue"}}},
			map[string]any{"api-key": "inherited-policy-key"},
		},
	}}
	fixture.state.mu.Unlock()
	resp, payload := doJSON(t, fixture.client, http.MethodPut, fixture.baseURL+providersEndpoint+"/openai-compat-0", `{"family":"codex","name":"Policy Relay","base_url":"https://relay.test/v1","runtime_policy":{"cooling":"disabled","request_retry":3},"behavior":{"alpha_search":true}}`)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("migration = %d %s", resp.StatusCode, payload)
	}
	fixture.state.mu.Lock()
	defer fixture.state.mu.Unlock()
	explicit := fixture.state.codexProviders[1]
	inherited := fixture.state.codexProviders[2]
	if explicit["request-retry"] != float64(7) || explicit["disable-cooling"] != false || len(anyList(explicit["request-scoped-errors"])) != 1 {
		t.Fatal("the provider-level edit overwrote the key's explicit runtime policy")
	}
	if inherited["request-retry"] != float64(3) || inherited["disable-cooling"] != true {
		t.Fatal("a key without overrides did not receive the edited provider policy")
	}
	if explicit["alpha-search"] != true || inherited["alpha-search"] != true {
		t.Fatal("the target protocol's behavior was lost while applying key overrides")
	}
}

func TestProviderProtocolChangeKeepsSharedSettingsEditable(t *testing.T) {
	fixture := newProviderTestFixture(t)
	fixture.state.mu.Lock()
	fixture.state.claudeProviders[0]["excluded-models"] = []string{"blocked-model"}
	fixture.state.mu.Unlock()
	resp, payload := doJSON(t, fixture.client, http.MethodPut, fixture.baseURL+providersEndpoint+"/claude-0", `{"family":"openai-compatibility","name":"Editable Relay","base_url":"https://relay.test/v1","prefix":"before","priority":1,"headers":{"x-team":"before"},"models":["before-model"],"runtime_policy":{"cooling":"disabled","request_retry":2}}`)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("migration = %d %s", resp.StatusCode, payload)
	}
	var moved struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(payload, &moved); err != nil {
		t.Fatal(err)
	}
	resp, payload = doJSON(t, fixture.client, http.MethodPut, fixture.baseURL+providersEndpoint+"/"+moved.ID, `{"family":"openai-compatibility","name":"Editable Relay","base_url":"https://relay.test/v1","prefix":"after","priority":3,"headers":{"x-team":"after"},"models":["after-model"],"runtime_policy":{"cooling":"inherit","request_retry":4}}`)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("subsequent edit = %d %s", resp.StatusCode, payload)
	}
	fixture.state.mu.Lock()
	defer fixture.state.mu.Unlock()
	provider := genericEntries(fixture.state.oaiProviders)[1]
	key := anyList(provider["api-key-entries"])[0].(map[string]any)
	effective := map[string]any{}
	for field, value := range provider {
		effective[field] = value
	}
	for field, value := range key {
		effective[field] = value
	}
	if effective["prefix"] != "after" || effective["priority"] != float64(3) || effective["request-retry"] != float64(4) || effective["disable-cooling"] != nil {
		t.Fatal("the migrated key still overrides edited provider settings")
	}
	if !reflect.DeepEqual(key["excluded-models"], []any{"blocked-model"}) {
		t.Fatal("the migrated key lost its model exclusions")
	}
	if !reflect.DeepEqual(effective["headers"], map[string]any{"x-team": "after"}) {
		t.Fatal("the migrated key still overrides edited provider headers")
	}
	models := anyList(effective["models"])
	if len(models) != 1 || models[0].(map[string]any)["name"] != "after-model" {
		t.Fatal("the migrated key still overrides edited provider models")
	}
}

func TestProviderMoveAdaptsModelOptionsToDestination(t *testing.T) {
	for _, family := range []string{"codex", "claude", "vertex", openAICompatibilityFamily} {
		models := supportedProviderMoveModels([]management.ModelAlias{{Name: "m", Image: true, MaxContextLength: 32000, IsCompat: true, SupportConfigurationUpdate: true, InputModalities: []string{"image"}, UseMaxCompletionTokens: true, DisplayName: "Model", ForceMapping: true}}, family)
		fields := providerModelOptionFieldsFor(family)
		m := models[0]
		if m.DisplayName != "Model" || !m.ForceMapping || m.Image != (family == openAICompatibilityFamily) || (m.MaxContextLength != 0) != fields.hasMaxContextLength || m.IsCompat != fields.hasIsCompat || m.SupportConfigurationUpdate != fields.hasConfigurationUpdate || (len(m.InputModalities) > 0) != fields.hasModalities || m.UseMaxCompletionTokens != fields.hasMaxCompletionTokens {
			t.Fatalf("wrong model conversion for %s", family)
		}
	}
}
