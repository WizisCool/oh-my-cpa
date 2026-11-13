package management

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"
)

// groupsGateway serves one family's stored groups on the v8 configuration
// route and CPA's runtime list for it on the v0 route, and records what a
// write sends back.
type groupsGateway struct {
	mu      sync.Mutex
	family  string
	stored  string
	runtime string
	written []map[string]any
	removed bool
}

func (g *groupsGateway) handler() http.Handler {
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		g.mu.Lock()
		defer g.mu.Unlock()
		writer.Header().Set("Content-Type", "application/json")
		switch {
		case request.Method == http.MethodGet && request.URL.Path == "/v0/management/config.yaml":
			_, _ = writer.Write([]byte("config-version: 8\n"))
		case request.Method == http.MethodGet && request.URL.Path == "/v0/management/"+g.runtimeEndpoint():
			_, _ = writer.Write([]byte(g.runtime))
		case request.Method == http.MethodGet && request.URL.Path == "/v8/management/config/api-keys/"+g.family:
			if g.stored == "" {
				writer.WriteHeader(http.StatusNotFound)
				_, _ = writer.Write([]byte(`{"error":"not_found"}`))
				return
			}
			_, _ = writer.Write([]byte(g.stored))
		case request.Method == http.MethodPatch && request.URL.Path == "/v8/management/config":
			body, _ := io.ReadAll(request.Body)
			var merge struct {
				APIKeys map[string][]map[string]any `json:"api-keys"`
			}
			_ = json.Unmarshal(body, &merge)
			g.written = merge.APIKeys[g.family]
			_, _ = writer.Write([]byte(`{"status":"ok"}`))
		case request.Method == http.MethodDelete && request.URL.Path == "/v8/management/config/api-keys/"+g.family:
			g.removed = true
			_, _ = writer.Write([]byte(`{"status":"ok"}`))
		default:
			writer.WriteHeader(http.StatusNotFound)
			_, _ = writer.Write([]byte(`{"error":"unexpected ` + request.Method + " " + request.URL.Path + `"}`))
		}
	})
}

func (g *groupsGateway) runtimeEndpoint() string {
	if g.family == "openai-compatibility" {
		return g.family
	}
	return g.family + "-api-key"
}

func newGroupsClient(t *testing.T, gateway *groupsGateway) *Client {
	t.Helper()
	server := newV8Server(gateway.handler())
	t.Cleanup(server.Close)
	client, err := NewClient(server.URL, "management-secret", time.Second, false)
	if err != nil {
		t.Fatal(err)
	}
	return client
}

func decodeGroups(t *testing.T, document string) []map[string]any {
	t.Helper()
	var groups []map[string]any
	if err := json.Unmarshal([]byte(document), &groups); err != nil {
		t.Fatal(err)
	}
	return groups
}

func groupNames(groups []map[string]any) []string {
	names := make([]string, len(groups))
	for i, group := range groups {
		names[i], _ = group["name"].(string)
	}
	return names
}

func groupKeys(group map[string]any) []map[string]any {
	var keys []map[string]any
	for _, key := range group["keys"].([]any) {
		keys = append(keys, key.(map[string]any))
	}
	return keys
}

func TestUpdateConfigAPIKeysRemovesAnEmptiedFamily(t *testing.T) {
	gateway := &groupsGateway{family: "meta"}
	if err := newGroupsClient(t, gateway).UpdateConfigAPIKeys(context.Background(), ConfigFamilyMeta, nil); err != nil {
		t.Fatal(err)
	}
	if !gateway.removed {
		t.Fatal("an emptied family must be removed, not written as a list")
	}
}

func TestUpdateOpenAICompatibilityKeepsUnmodelledSettings(t *testing.T) {
	gateway := &groupsGateway{
		family: "openai-compatibility",
		stored: `[{"name":"relay","base-url":"https://r.test","request-retry":0,"support-prompt-cache-key":true,"connection-pool":{"enabled":true,"idle-conn-timeout":"300s"},
		  "models":[{"name":"m","alias":"a","input-modalities":["text","image"]}],"keys":[{"api-key":"o1","connection-pool":{}},{"api-key":"o2","connection-pool":{"enabled":null,"idle-conn-timeout":null,"max-idle-conns-per-host":null}}]}]`,
		runtime: `{"openai-compatibility":[{"name":"relay","base-url":"https://r.test","request-retry":0,"support-prompt-cache-key":true,"connection-pool":{"enabled":true,"idle-conn-timeout":"300s"},
		  "models":[{"name":"m","alias":"a","input-modalities":["text","image"]}],"api-key-entries":[{"api-key":"o1","auth-index":"x1"},{"api-key":"o2","auth-index":"x2"}]}]}`,
	}
	client := newGroupsClient(t, gateway)
	entries, err := client.EditableOpenAICompatibility(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if entries[0].APIKeyEntries[0].AuthIndex != "x1" {
		t.Fatalf("key auth index = %q", entries[0].APIKeyEntries[0].AuthIndex)
	}
	entries[0].Disabled = true
	if err := client.UpdateOpenAICompatibility(context.Background(), entries); err != nil {
		t.Fatal(err)
	}
	want := decodeGroups(t, `[{"name":"relay","base-url":"https://r.test","request-retry":0,"support-prompt-cache-key":true,"connection-pool":{"enabled":true,"idle-conn-timeout":"300s"},"disabled":true,
	  "models":[{"name":"m","alias":"a","input-modalities":["text","image"]}],"keys":[{"api-key":"o1","connection-pool":{}},{"api-key":"o2","connection-pool":{"enabled":null,"idle-conn-timeout":null,"max-idle-conns-per-host":null}}]}]`)
	if !reflect.DeepEqual(gateway.written, want) {
		t.Fatalf("groups = %#v\nwant %#v", gateway.written, want)
	}
}

func TestEditableOpenAICompatibilityVerifiesIdentityOnCaseFoldFallback(t *testing.T) {
	gateway := &groupsGateway{
		family: "openai-compatibility",
		stored: `[
			{"name":"FOO","base-url":"https://right.test/Tenant","keys":[{"api-key":"right-key"}]},
			{"name":"Foo","base-url":"https://RIGHT.test/tenant/","keys":[{"api-key":"right-key"}],"request-retry":2}
		]`,
		runtime: `{"openai-compatibility":[{"name":"foo","base-url":"https://right.test/tenant","api-key-entries":[{"api-key":"right-key","auth-index":"idx-right"}]}]}`,
	}
	client := newGroupsClient(t, gateway)
	entries, err := client.EditableOpenAICompatibility(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || entries[0].RequestRetry == nil || *entries[0].RequestRetry != 2 {
		t.Fatalf("selected wrong stored group on case-fold fallback (path casing ignored): %#v", entries)
	}
	if entries[0].APIKeyEntries[0].AuthIndex != "idx-right" {
		t.Fatalf("auth index = %q, want idx-right", entries[0].APIKeyEntries[0].AuthIndex)
	}
}

func TestOAuthModelAliasesReadAsCPAAppliesThem(t *testing.T) {
	gateway := &configGateway{answer: func(method, path string) (int, string) {
		if method == http.MethodGet && path == "/v8/management/config/oauth/model-alias" {
			return http.StatusOK, `{"Codex":[{"name":" gpt-5 ","alias":"fast"},{"name":"gpt-5.1","alias":"FAST"},{"name":"same","alias":"same"}],"empty":[]}`
		}
		return 0, ""
	}}
	aliases, err := newConfigClient(t, gateway).OAuthModelAliases(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	want := map[string][]OAuthModelAlias{"codex": {{Name: "gpt-5", Alias: "fast"}}}
	if !reflect.DeepEqual(aliases, want) {
		t.Fatalf("aliases = %#v, want %#v", aliases, want)
	}
}

func TestPatchOAuthModelAliasesReplacesEverySpellingOfTheProvider(t *testing.T) {
	gateway := &configGateway{stored: "config-version: 8\n", answer: func(method, path string) (int, string) {
		if method == http.MethodGet && path == "/v8/management/config/oauth/model-alias" {
			return http.StatusOK, `{"Codex":[{"name":"a","alias":"b"}],"claude":[{"name":"c","alias":"d"}]}`
		}
		return 0, ""
	}}
	client := newConfigClient(t, gateway)
	if err := client.PatchOAuthModelAliases(context.Background(), "codex", []OAuthModelAlias{{Name: "gpt-5", Alias: "fast"}}); err != nil {
		t.Fatal(err)
	}
	sent := strings.Join(gateway.sent(), "\n")
	if !strings.Contains(sent, "PATCH /v8/management/config") || !strings.Contains(sent, "DELETE /v8/management/config/oauth/model-alias/Codex") {
		t.Fatalf("requests = %s", sent)
	}
	if strings.Contains(sent, "model-alias/claude") {
		t.Fatalf("another provider was touched: %s", sent)
	}
}

func TestPatchOAuthExcludedModelsReplacesEverySpellingOfTheProvider(t *testing.T) {
	gateway := &configGateway{stored: "config-version: 8\n", answer: func(method, path string) (int, string) {
		if method == http.MethodGet && path == "/v8/management/config/oauth/excluded-models" {
			return http.StatusOK, `{"Codex":["gpt-5-mini"],"claude":["claude-3-haiku"]}`
		}
		return 0, ""
	}}
	client := newConfigClient(t, gateway)
	if err := client.PatchOAuthExcludedModels(context.Background(), "codex", []string{"gpt-5-*"}); err != nil {
		t.Fatal(err)
	}
	sent := strings.Join(gateway.sent(), "\n")
	if !strings.Contains(sent, "PATCH /v8/management/config") || !strings.Contains(sent, "DELETE /v8/management/config/oauth/excluded-models/Codex") {
		t.Fatalf("requests = %s", sent)
	}
	if strings.Contains(sent, "excluded-models/claude") {
		t.Fatalf("another provider was touched: %s", sent)
	}
}

func TestPatchOAuthExcludedModelsWritesNothingForAProviderWithoutRules(t *testing.T) {
	gateway := &configGateway{stored: "config-version: 8\n", answer: func(method, path string) (int, string) {
		if method == http.MethodGet && path == "/v8/management/config/oauth/excluded-models" {
			return http.StatusOK, `{"claude":["claude-3-haiku"]}`
		}
		return 0, ""
	}}
	client := newConfigClient(t, gateway)
	if err := client.PatchOAuthExcludedModels(context.Background(), "codex", nil); err != nil {
		t.Fatal(err)
	}
	for _, request := range gateway.sent() {
		if !strings.HasPrefix(request, http.MethodGet) {
			t.Fatalf("clearing a provider that stores no rules wrote to CPA: %s", request)
		}
	}
}

func TestOAuthExcludedModelsAreReadAsCPAAppliesThem(t *testing.T) {
	got := sanitizeOAuthExcludedModels(map[string][]string{
		"Codex": {" GPT-5 ", "gpt-5", "", "o3-*"},
		"codex": {"ignored-second-spelling"},
		" ":     {"orphan"},
		"empty": {"  "},
	})
	if len(got) != 1 || strings.Join(got["codex"], ",") != "gpt-5,o3-*" {
		t.Fatalf("sanitized = %#v", got)
	}
}

func TestPluginConfigTellsAnUnconfiguredPluginFromAnUnknownOne(t *testing.T) {
	gateway := &configGateway{answer: func(method, path string) (int, string) {
		switch {
		case strings.HasPrefix(path, "/v8/management/config/plugins/configs/"):
			return http.StatusNotFound, `{"error":"not_found"}`
		case path == "/v8/management/plugins":
			return http.StatusOK, `{"plugins":[{"id":"installed","enabled":false}]}`
		}
		return 0, ""
	}}
	client := newConfigClient(t, gateway)
	config, err := client.PluginConfig(context.Background(), "installed")
	if err != nil || len(config) != 0 {
		t.Fatalf("installed plugin config = %#v, %v; want an empty object", config, err)
	}
	var httpErr *HTTPError
	if _, err := client.PluginConfig(context.Background(), "ghost"); err == nil || !errors.As(err, &httpErr) || !strings.Contains(httpErr.Body, "plugin_not_found") {
		t.Fatalf("unknown plugin err = %v, want plugin_not_found", err)
	}
}

func TestUpdateConfigAPIKeysKeepsAnImplicitDefaultBaseURLImplicit(t *testing.T) {
	// The file states no endpoint; the runtime reports the family default, and
	// the edit form sends back what it showed.
	gateway := &groupsGateway{
		family:  "claude",
		stored:  `[{"name":"team","priority":3,"keys":[{"api-key":"k1"},{"api-key":"k2"}]}]`,
		runtime: `{"claude-api-key":[{"api-key":"k1","base-url":"https://api.default.test","priority":3,"auth-index":"i1"},{"api-key":"k2","base-url":"https://api.default.test","priority":3,"auth-index":"i2"}]}`,
	}
	client := newGroupsClient(t, gateway)
	entries, err := client.EditableConfigAPIKeys(context.Background(), ConfigFamilyClaude)
	if err != nil {
		t.Fatal(err)
	}
	if view := entries[1].ProviderRuntimeView(); view.BaseURL != "https://api.default.test" || view.AuthIndex != "i2" {
		t.Fatalf("provider read lost runtime-normalized identity or URL: %+v", view)
	}
	weight := 5
	entries[1].BaseURL = entries[1].SubmittedBaseURL("https://api.default.test")
	entries[1].Weight = &weight
	if err := client.UpdateConfigAPIKeys(context.Background(), ConfigFamilyClaude, entries); err != nil {
		t.Fatal(err)
	}
	gateway.mu.Lock()
	defer gateway.mu.Unlock()
	if got := groupNames(gateway.written); !reflect.DeepEqual(got, []string{"team"}) {
		t.Fatalf("groups = %v, want the key to stay in its group", got)
	}
	if _, has := gateway.written[0]["base-url"]; has {
		t.Fatalf("group = %#v, want the default endpoint left implicit", gateway.written[0])
	}
	if keys := groupKeys(gateway.written[0]); keys[1]["weight"] != float64(5) {
		t.Fatalf("keys = %#v, want the edited weight", keys)
	}
	// A different endpoint is still the operator's edit.
	if got := entries[1].SubmittedBaseURL("https://other.test"); got != "https://other.test" {
		t.Fatalf("SubmittedBaseURL = %q", got)
	}
}

func TestApplyConfigChangesScrubsSecretsFromARefusal(t *testing.T) {
	server := newV8Server(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		switch {
		case request.Method == http.MethodGet && request.URL.Path == "/v0/management/config.yaml":
			_, _ = writer.Write([]byte("config-version: 8\napi-keys:\n  gemini:\n    - name: g\n      keys:\n        - api-key: stored-gemini-secret\n"))
		case request.Method == http.MethodPatch && request.URL.Path == "/v8/management/config":
			writer.WriteHeader(http.StatusUnprocessableEntity)
			_, _ = writer.Write([]byte(`{"error":"invalid_config","message":"key new-claude-secret conflicts with stored-gemini-secret"}`))
		default:
			writer.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(server.Close)
	client, err := NewClient(server.URL, "management-secret", time.Second, false)
	if err != nil {
		t.Fatal(err)
	}
	groups := []map[string]any{{"name": "c", "keys": []any{map[string]any{"api-key": "new-claude-secret"}}}}
	err = client.ApplyConfigChanges(context.Background(), []ConfigChange{{Path: ConfigFamilyClaude.GroupsPath(), Value: groups}})
	reason, rejected := IsConfigRejected(err)
	if !rejected {
		t.Fatalf("err = %v, want the refusal kept", err)
	}
	for _, secret := range []string{"new-claude-secret", "stored-gemini-secret"} {
		if strings.Contains(reason, secret) || strings.Contains(err.Error(), secret) {
			t.Fatalf("refusal %q (%v) quotes %s", reason, err, secret)
		}
	}
}

func TestUpdateConfigAPIKeysPreservesConnectionPoolInheritance(t *testing.T) {
	stored := `[{"name":"team","base-url":"https://relay.test","connection-pool":{"enabled":false,"idle-conn-timeout":"300s","max-idle-conns-per-host":2},"keys":[{"api-key":"one","connection-pool":{"idle-conn-timeout":"60s"}},{"api-key":"two","connection-pool":{}},{"api-key":"three","connection-pool":{"enabled":false,"max-idle-conns-per-host":0}},{"api-key":"four","connection-pool":{"enabled":null}},{"api-key":"five"}]}]`
	gateway := &groupsGateway{family: "codex", stored: stored, runtime: `{"codex-api-key":[{"api-key":"one","base-url":"https://relay.test"},{"api-key":"two","base-url":"https://relay.test"},{"api-key":"three","base-url":"https://relay.test"},{"api-key":"four","base-url":"https://relay.test"},{"api-key":"five","base-url":"https://relay.test"}]}`}
	client := newGroupsClient(t, gateway)
	entries, err := client.EditableConfigAPIKeys(context.Background(), ConfigFamilyCodex)
	if err != nil {
		t.Fatal(err)
	}
	for index, entry := range entries {
		fields, err := wireObject(entry)
		if err != nil {
			t.Fatal(err)
		}
		pool := fields["connection-pool"].(map[string]any)
		if pool["enabled"] != false || pool["idle-conn-timeout"] == nil || pool["max-idle-conns-per-host"] == nil {
			t.Fatalf("key %d lost inherited pool fields: %+v", index, pool)
		}
	}
	entries[0].Headers = map[string]string{"X-Route": "edited"}
	if err := client.UpdateConfigAPIKeys(context.Background(), ConfigFamilyCodex, entries); err != nil {
		t.Fatal(err)
	}
	want := decodeGroups(t, stored)
	groupKeys(want[0])[0]["headers"] = map[string]any{"X-Route": "edited"}
	if !reflect.DeepEqual(gateway.written, want) {
		t.Fatalf("unrelated edit changed pool ownership or sibling keys:\n got: %#v\nwant: %#v", gateway.written, want)
	}
}

func TestUpdateConfigAPIKeysEditsOnlyRequestedPoolLayer(t *testing.T) {
	for _, test := range []struct {
		name    string
		isGroup bool
		value   string
	}{
		{"empty-key", false, `{}`},
		{"explicit-enabled-key", false, `{"enabled":true}`},
		{"explicit-disabled-key", false, `{"enabled":false,"idle-conn-timeout":"0s","max-idle-conns-per-host":0}`},
		{"inherit-key", false, `null`},
		{"group-default", true, `{"idle-conn-timeout":"30s"}`},
		{"empty-group", true, `{}`},
		{"remove-group", true, `null`},
	} {
		for _, isSingleKey := range []bool{true, false} {
			t.Run(fmt.Sprintf("%s/single=%t", test.name, isSingleKey), func(t *testing.T) {
				stored := decodeGroups(t, `[{"name":"team","base-url":"https://relay.test","connection-pool":{"enabled":true,"idle-conn-timeout":"300s","future-limit":7},"keys":[{"api-key":"one","connection-pool":{"idle-conn-timeout":"60s"}},{"api-key":"two","connection-pool":{}},{"api-key":"three","connection-pool":{"enabled":null}}]}]`)
				if isSingleKey {
					stored[0]["keys"] = stored[0]["keys"].([]any)[:1]
				}
				var runtime []map[string]any
				for _, key := range groupKeys(stored[0]) {
					runtime = append(runtime, map[string]any{"api-key": key["api-key"], "base-url": "https://relay.test"})
				}
				storedJSON, _ := json.Marshal(stored)
				runtimeJSON, _ := json.Marshal(map[string]any{"codex-api-key": runtime})
				gateway := &groupsGateway{family: "codex", stored: string(storedJSON), runtime: string(runtimeJSON)}
				client := newGroupsClient(t, gateway)
				entries, err := client.EditableConfigAPIKeys(context.Background(), ConfigFamilyCodex)
				if err != nil {
					t.Fatal(err)
				}
				var value *ConnectionPoolConfig
				if err := json.Unmarshal([]byte(test.value), &value); err != nil {
					t.Fatal(err)
				}
				if err := entries[0].EditConnectionPool(test.isGroup, value); err != nil {
					t.Fatal(err)
				}
				if err := client.UpdateConfigAPIKeys(context.Background(), ConfigFamilyCodex, entries); err != nil {
					t.Fatal(err)
				}
				want := decodeGroups(t, string(storedJSON))
				target := groupKeys(want[0])[0]
				if test.isGroup {
					target = want[0]
				}
				if test.value == "null" {
					delete(target, "connection-pool")
				} else {
					var pool map[string]any
					if err := json.Unmarshal([]byte(test.value), &pool); err != nil {
						t.Fatal(err)
					}
					if test.isGroup {
						pool["future-limit"] = float64(7)
					}
					target["connection-pool"] = pool
				}
				if !reflect.DeepEqual(gateway.written, want) {
					t.Fatalf("pool edit changed an unowned setting:\n got: %#v\nwant: %#v", gateway.written, want)
				}
			})
		}
	}
}
