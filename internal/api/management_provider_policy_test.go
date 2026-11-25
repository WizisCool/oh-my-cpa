package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"reflect"
	"strings"
	"testing"
)

const providersEndpoint = "/omc/api/v1/management/providers"

func listedProvider(t *testing.T, fixture providerTestFixture, id string) ProviderItemDTO {
	t.Helper()
	_, payload := getJSON(t, fixture.client, fixture.baseURL+providersEndpoint)
	var listed struct {
		Providers []ProviderItemDTO `json:"providers"`
	}
	if err := json.Unmarshal(payload, &listed); err != nil {
		t.Fatal(err)
	}
	for _, provider := range listed.Providers {
		if provider.ID == id {
			return provider
		}
	}
	t.Fatalf("provider %s is not listed", id)
	return ProviderItemDTO{}
}

func TestProviderRuntimePolicyRoundTrip(t *testing.T) {
	fixture := newProviderTestFixture(t)
	fixture.state.mu.Lock()
	fixture.state.codexProviders = []map[string]any{{
		"api-key": "sk-codex-1", "auth-index": "cx-1", "base-url": "https://codex.test/v1",
		"request-retry": float64(-1), "websockets": true,
	}}
	fixture.state.mu.Unlock()

	if got := listedProvider(t, fixture, "codex-0").Behavior; got == nil || got.Websockets == nil || !*got.Websockets {
		t.Fatalf("stored behaviour = %+v, want the stored websockets switch reported", got)
	}
	if got := listedProvider(t, fixture, "codex-0").RuntimePolicy; got == nil || got.Cooling != providerOverrideInherit || got.RequestRetry != nil || !got.SupportsErrorRules {
		t.Fatalf("stored policy = %+v, want inherited cooling, a negative retry read as inherited, error rules supported", got)
	}

	body := `{"family":"codex","name":"Codex","base_url":"https://codex.test/v1","keys":[{"api_key":""}],
		"runtime_policy":{"cooling":"enabled","request_retry":0,"error_rules":[
			{"status":429,"match":["quota"],"match_regex":["rate.?limit"],"action":" Stop-And-Cooldown "}]},
		"behavior":{"alpha_search":true,"codex_cloaking":"disabled"}}`
	if resp, payload := doJSON(t, fixture.client, http.MethodPut, fixture.baseURL+providersEndpoint+"/codex-0", body); resp.StatusCode != http.StatusOK {
		t.Fatalf("update = %d %s", resp.StatusCode, payload)
	}

	fixture.state.mu.Lock()
	stored := fixture.state.codexProviders[0]
	fixture.state.mu.Unlock()
	if stored["disable-cooling"] != false || stored["request-retry"] != float64(0) {
		t.Fatalf("stored cooling/retry = %#v/%#v, want an explicit false and an explicit 0", stored["disable-cooling"], stored["request-retry"])
	}
	rule := anyList(stored["request-scoped-errors"])[0].(map[string]any)
	if rule["status"] != float64(429) || rule["action"] != "stop-and-cooldown" || fmt.Sprint(rule["match"]) != "[quota]" || fmt.Sprint(rule["match-regexr"]) != "[rate.?limit]" {
		t.Fatalf("stored rule = %#v, want CPA's wire names and a normalized action", rule)
	}
	if stored["alpha-search"] != true || stored["disable-codex-cloaking"] != true || stored["websockets"] != true {
		t.Fatalf("stored behaviour = %#v, want both switches set and websockets kept when not submitted", stored)
	}

	listed := listedProvider(t, fixture, "codex-0")
	if listed.RuntimePolicy.Cooling != providerOverrideEnabled || listed.RuntimePolicy.RequestRetry == nil || *listed.RuntimePolicy.RequestRetry != 0 || len(listed.RuntimePolicy.ErrorRules) != 1 {
		t.Fatalf("listed policy = %+v", listed.RuntimePolicy)
	}
	if listed.Behavior == nil || listed.Behavior.AlphaSearch == nil || !*listed.Behavior.AlphaSearch || listed.Behavior.CodexCloaking != providerOverrideDisabled || listed.Behavior.RebuildMidSystemMessage != nil {
		t.Fatalf("listed behaviour = %+v, want only the switches Codex has", listed.Behavior)
	}

	// Inheriting again removes all three settings rather than writing zero values.
	body = `{"family":"codex","name":"Codex","base_url":"https://codex.test/v1","keys":[{"api_key":""}],"runtime_policy":{"cooling":"inherit"}}`
	if resp, payload := doJSON(t, fixture.client, http.MethodPut, fixture.baseURL+providersEndpoint+"/codex-0", body); resp.StatusCode != http.StatusOK {
		t.Fatalf("inherit update = %d %s", resp.StatusCode, payload)
	}
	fixture.state.mu.Lock()
	stored = fixture.state.codexProviders[0]
	fixture.state.mu.Unlock()
	for _, field := range []string{"disable-cooling", "request-retry", "request-scoped-errors"} {
		if _, isStored := stored[field]; isStored {
			t.Fatalf("%s = %#v after inheriting, want it absent", field, stored[field])
		}
	}
	if stored["alpha-search"] != true {
		t.Fatalf("alpha-search = %#v, want a request without behavior to leave it as stored", stored["alpha-search"])
	}

	// Turning websockets off removes the key rather than writing false.
	body = `{"family":"codex","name":"Codex","base_url":"https://codex.test/v1","keys":[{"api_key":""}],"behavior":{"websockets":false}}`
	if resp, payload := doJSON(t, fixture.client, http.MethodPut, fixture.baseURL+providersEndpoint+"/codex-0", body); resp.StatusCode != http.StatusOK {
		t.Fatalf("websockets update = %d %s", resp.StatusCode, payload)
	}
	fixture.state.mu.Lock()
	stored = fixture.state.codexProviders[0]
	fixture.state.mu.Unlock()
	if _, isStored := stored["websockets"]; isStored {
		t.Fatalf("websockets = %#v after turning it off, want it absent", stored["websockets"])
	}
}

// A client that never carried the policy must not erase one.
func TestProviderUpdateWithoutPolicyKeepsStoredPolicy(t *testing.T) {
	fixture := newProviderTestFixture(t)
	fixture.state.mu.Lock()
	fixture.state.oaiProviders = []map[string]any{{
		"name": "relay", "base-url": "https://relay.test/v1", "request-retry": float64(3),
		"support-prompt-cache-key": true,
		"request-scoped-errors":    []any{map[string]any{"status": float64(500), "match": []any{"boom"}, "action": "continue", "future-field": "kept"}},
		"api-key-entries":          []any{map[string]any{"api-key": "sk-relay-1", "auth-index": "r-1"}},
	}}
	fixture.state.mu.Unlock()

	body := `{"family":"openai-compatibility","name":"relay","base_url":"https://relay.test/v1","keys":[{"api_key":""}]}`
	if resp, payload := doJSON(t, fixture.client, http.MethodPut, fixture.baseURL+providersEndpoint+"/openai-compat-0", body); resp.StatusCode != http.StatusOK {
		t.Fatalf("update = %d %s", resp.StatusCode, payload)
	}
	// Resubmitting the listed rule unchanged keeps the setting the console does not edit.
	body = `{"family":"openai-compatibility","name":"relay","base_url":"https://relay.test/v1","keys":[{"api_key":""}],
		"runtime_policy":{"cooling":"inherit","request_retry":3,"error_rules":[{"status":500,"match":["boom"],"action":"continue"}]}}`
	if resp, payload := doJSON(t, fixture.client, http.MethodPut, fixture.baseURL+providersEndpoint+"/openai-compat-0", body); resp.StatusCode != http.StatusOK {
		t.Fatalf("policy update = %d %s", resp.StatusCode, payload)
	}

	fixture.state.mu.Lock()
	defer fixture.state.mu.Unlock()
	relay := fixture.state.oaiProviders[0]
	rule := anyList(relay["request-scoped-errors"])[0].(map[string]any)
	if relay["request-retry"] != float64(3) || relay["support-prompt-cache-key"] != true || rule["future-field"] != "kept" {
		t.Fatalf("relay = %#v, want retry, prompt-cache-key and the rule's unmodelled field kept", relay)
	}
}

func TestProviderPolicyRefusesWhatCPAWouldSkipOrReject(t *testing.T) {
	fixture := newProviderTestFixture(t)
	fixture.state.mu.Lock()
	fixture.state.codexProviders = []map[string]any{{"api-key": "sk-codex-1", "auth-index": "cx-1", "base-url": "https://codex.test/v1"}}
	*fixture.state.providerList("vertex") = []map[string]any{{"api-key": "sk-vertex-1", "auth-index": "vx-1"}}
	fixture.state.mu.Unlock()

	codex := func(extra string) string {
		return `{"family":"codex","name":"Codex","base_url":"https://codex.test/v1","keys":[{"api_key":""}],` + extra + `}`
	}
	cases := []struct {
		name, id, body, wantReason string
	}{
		{"unknown cooling", "codex-0", codex(`"runtime_policy":{"cooling":"off"}`), "cooling must be"},
		{"negative retry", "codex-0", codex(`"runtime_policy":{"cooling":"inherit","request_retry":-1}`), "zero or greater"},
		{"status out of range", "codex-0", codex(`"runtime_policy":{"cooling":"inherit","error_rules":[{"status":0,"match":["x"],"action":"stop"}]}`), "HTTP status code"},
		{"unknown action", "codex-0", codex(`"runtime_policy":{"cooling":"inherit","error_rules":[{"status":500,"match":["x"],"action":"retry"}]}`), "action must be"},
		{"no match", "codex-0", codex(`"runtime_policy":{"cooling":"inherit","error_rules":[{"status":500,"action":"stop"}]}`), "at least one"},
		{"empty match", "codex-0", codex(`"runtime_policy":{"cooling":"inherit","error_rules":[{"status":500,"match":[""],"action":"stop"}]}`), "must not be empty"},
		{"uncompilable regex", "codex-0", codex(`"runtime_policy":{"cooling":"inherit","error_rules":[{"status":500,"match_regex":["("],"action":"stop"}]}`), "invalid regular expression"},
		{"switch of another family", "codex-0", codex(`"behavior":{"rebuild_mid_system_message":true}`), "does not have"},
		{"native tool search outside Claude", "codex-0", codex(`"behavior":{"native_tool_search":true}`), "does not have"},
		{"websockets outside Codex and xAI", "vertex-0", `{"family":"vertex","name":"Vertex","keys":[{"api_key":""}],"behavior":{"websockets":true}}`, "does not have"},
		{"invalid error rule on Vertex", "vertex-0", `{"family":"vertex","name":"Vertex","keys":[{"api_key":""}],"runtime_policy":{"cooling":"inherit","error_rules":[{"status":500,"match_regex":["("],"action":"stop"}]}}`, "invalid regular expression"},
	}
	for _, tc := range cases {
		resp, payload := doJSON(t, fixture.client, http.MethodPut, fixture.baseURL+providersEndpoint+"/"+tc.id, tc.body)
		if resp.StatusCode != http.StatusBadRequest || !strings.Contains(string(payload), tc.wantReason) {
			t.Errorf("%s: got %d %s, want 400 naming %q", tc.name, resp.StatusCode, payload, tc.wantReason)
		}
	}

	// Strict-decode boundary: a family CPA does not declare request-scoped error rules on is still refused.
	if resp, payload := doJSON(t, fixture.client, http.MethodPost, fixture.baseURL+providersEndpoint,
		`{"family":"undeclared-family","name":"Future","api_key":"sk-future-1","runtime_policy":{"cooling":"inherit","error_rules":[{"status":500,"match":["x"],"action":"stop"}]}}`); resp.StatusCode != http.StatusBadRequest || !strings.Contains(string(payload), "does not support") {
		t.Errorf("rules on undeclared family: got %d %s, want 400 naming %q", resp.StatusCode, payload, "does not support")
	}

	fixture.state.mu.Lock()
	defer fixture.state.mu.Unlock()
	if fixture.state.putCount != 0 {
		t.Fatalf("putCount = %d, want no refused request to reach CPA", fixture.state.putCount)
	}
	if len(fixture.state.codexProviders[0]) != 3 {
		t.Fatalf("codex entry = %#v, want no refused request to have written anything", fixture.state.codexProviders[0])
	}
	if _, isStored := (*fixture.state.providerList("vertex"))[0]["request-scoped-errors"]; isStored {
		t.Fatal("vertex entry gained error rules")
	}
}

func TestProviderVertexErrorRulesRoundTripAndGroupSemantics(t *testing.T) {
	t.Run("standalone", func(t *testing.T) {
		fixture := newProviderTestFixture(t)
		fixture.state.mu.Lock()
		*fixture.state.providerList("vertex") = []map[string]any{{
			"api-key": "sk-vertex-1", "auth-index": "vx-1", "base-url": "https://vertex.test/v1",
			"request-scoped-errors": []any{
				map[string]any{"status": float64(400), "match": []any{"INVALID_ARGUMENT"}, "action": "stop", "future-field": "kept"},
			},
		}}
		fixture.state.mu.Unlock()

		listed := listedProvider(t, fixture, "vertex-0")
		if listed.RuntimePolicy == nil || !listed.RuntimePolicy.SupportsErrorRules || len(listed.RuntimePolicy.ErrorRules) != 1 {
			t.Fatalf("listed policy = %+v, want supports_error_rules=true and the stored rule", listed.RuntimePolicy)
		}

		body := `{"family":"vertex","name":"Vertex","base_url":"https://vertex.test/v1","keys":[{"api_key":""}],
			"runtime_policy":{"cooling":"inherit","error_rules":[
				{"status":400,"match":["INVALID_ARGUMENT"],"action":"stop"},
				{"status":429,"match":["RESOURCE_EXHAUSTED"],"match_regex":["quota.?exceeded"],"action":" Stop-And-Cooldown "}
			]}}`
		if resp, payload := doJSON(t, fixture.client, http.MethodPut, fixture.baseURL+providersEndpoint+"/vertex-0", body); resp.StatusCode != http.StatusOK {
			t.Fatalf("update = %d %s", resp.StatusCode, payload)
		}

		fixture.state.mu.Lock()
		stored := (*fixture.state.providerList("vertex"))[0]
		fixture.state.mu.Unlock()
		storedRules := anyList(stored["request-scoped-errors"])
		if len(storedRules) != 2 {
			t.Fatalf("stored rules = %#v, want 2 entries", storedRules)
		}
		first := storedRules[0].(map[string]any)
		if first["future-field"] != "kept" {
			t.Fatalf("first stored rule = %#v, want unmodelled field preserved on unchanged rule", first)
		}
		second := storedRules[1].(map[string]any)
		if second["status"] != float64(429) || second["action"] != "stop-and-cooldown" || fmt.Sprint(second["match"]) != "[RESOURCE_EXHAUSTED]" || fmt.Sprint(second["match-regexr"]) != "[quota.?exceeded]" {
			t.Fatalf("second stored rule = %#v, want CPA wire keys and normalized action", second)
		}

		listed = listedProvider(t, fixture, "vertex-0")
		if listed.RuntimePolicy == nil || !listed.RuntimePolicy.SupportsErrorRules || len(listed.RuntimePolicy.ErrorRules) != 2 {
			t.Fatalf("listed policy after save = %+v", listed.RuntimePolicy)
		}

		// Clearing all rules on a standalone Vertex key removes request-scoped-errors cleanly.
		body = `{"family":"vertex","name":"Vertex","base_url":"https://vertex.test/v1","keys":[{"api_key":""}],"runtime_policy":{"cooling":"inherit"}}`
		if resp, payload := doJSON(t, fixture.client, http.MethodPut, fixture.baseURL+providersEndpoint+"/vertex-0", body); resp.StatusCode != http.StatusOK {
			t.Fatalf("clear update = %d %s", resp.StatusCode, payload)
		}
		fixture.state.mu.Lock()
		stored = (*fixture.state.providerList("vertex"))[0]
		fixture.state.mu.Unlock()
		if _, isStored := stored["request-scoped-errors"]; isStored {
			t.Fatalf("request-scoped-errors = %#v after clearing, want it absent", stored["request-scoped-errors"])
		}
	})

	t.Run("v8_group_inherit_override_and_clear", func(t *testing.T) {
		fixture := newProviderTestFixture(t)
		var groups []map[string]any
		if err := json.Unmarshal([]byte(`[{
			"name": "vertex-team",
			"base-url": "https://vertex.test/v1",
			"request-scoped-errors": [{"status": 429, "match": ["quota"], "action": "stop-and-cooldown"}],
			"keys": [
				{"api-key": "sk-vx-1"},
				{"api-key": "sk-vx-2"},
				{"api-key": "sk-vx-3"}
			]
		}]`), &groups); err != nil {
			t.Fatal(err)
		}
		fixture.state.mu.Lock()
		fixture.state.storedGroups = map[string][]map[string]any{"vertex": groups}
		*fixture.state.providerList("vertex") = flattenGroups("vertex", groups, []map[string]any{
			{"api-key": "sk-vx-1", "auth-index": "vx-1"},
			{"api-key": "sk-vx-2", "auth-index": "vx-2"},
			{"api-key": "sk-vx-3", "auth-index": "vx-3"},
		})
		fixture.state.mu.Unlock()

		for _, id := range []string{"vertex-0", "vertex-1", "vertex-2"} {
			listed := listedProvider(t, fixture, id)
			if listed.RuntimePolicy == nil || !listed.RuntimePolicy.SupportsErrorRules || len(listed.RuntimePolicy.ErrorRules) != 1 || listed.RuntimePolicy.ErrorRules[0].Status != 429 {
				t.Fatalf("%s initial policy = %+v, want inherited group rule", id, listed.RuntimePolicy)
			}
		}

		// Key 1 overrides the group's error rules and must stay in vertex-team.
		overrideBody := `{"family":"vertex","name":"Vertex","base_url":"https://vertex.test/v1","keys":[{"api_key":""}],
			"runtime_policy":{"cooling":"inherit","error_rules":[{"status":400,"match":["safety"],"action":"stop"}]}}`
		if resp, payload := doJSON(t, fixture.client, http.MethodPut, fixture.baseURL+providersEndpoint+"/vertex-1", overrideBody); resp.StatusCode != http.StatusOK {
			t.Fatalf("override update = %d %s", resp.StatusCode, payload)
		}

		// Key 2 explicitly clears error rules and must stay in vertex-team with [].
		clearBody := `{"family":"vertex","name":"Vertex","base_url":"https://vertex.test/v1","keys":[{"api_key":""}],
			"runtime_policy":{"cooling":"inherit"}}`
		if resp, payload := doJSON(t, fixture.client, http.MethodPut, fixture.baseURL+providersEndpoint+"/vertex-2", clearBody); resp.StatusCode != http.StatusOK {
			t.Fatalf("clear update = %d %s", resp.StatusCode, payload)
		}

		// An unrelated edit on key 0 must keep inheritance, override, and [] clear intact inside one group.
		unrelatedBody := `{"family":"vertex","name":"Vertex","base_url":"https://vertex.test/v1","keys":[{"api_key":""}],
			"behavior":{"interactions":true}}`
		if resp, payload := doJSON(t, fixture.client, http.MethodPut, fixture.baseURL+providersEndpoint+"/vertex-0", unrelatedBody); resp.StatusCode != http.StatusOK {
			t.Fatalf("unrelated update = %d %s", resp.StatusCode, payload)
		}

		fixture.state.mu.Lock()
		gotGroups := fixture.state.storedGroups["vertex"]
		fixture.state.mu.Unlock()
		if len(gotGroups) != 1 || gotGroups[0]["name"] != "vertex-team" {
			t.Fatalf("stored groups = %#v, want all three keys kept in vertex-team", gotGroups)
		}
		groupRules := anyList(gotGroups[0]["request-scoped-errors"])
		if len(groupRules) != 1 || groupRules[0].(map[string]any)["status"] != float64(429) {
			t.Fatalf("group request-scoped-errors = %#v, want original 429 rule kept on group", groupRules)
		}
		keys := anyList(gotGroups[0]["keys"])
		if len(keys) != 3 {
			t.Fatalf("group keys = %#v, want 3 keys", keys)
		}
		key0 := keys[0].(map[string]any)
		key1 := keys[1].(map[string]any)
		key2 := keys[2].(map[string]any)
		if _, has := key0["request-scoped-errors"]; has || key0["interactions"] != true {
			t.Fatalf("key 0 = %#v, want inherited error rules and interactions=true", key0)
		}
		if key1Rules := anyList(key1["request-scoped-errors"]); len(key1Rules) != 1 || key1Rules[0].(map[string]any)["status"] != float64(400) {
			t.Fatalf("key 1 = %#v, want 400 override", key1)
		}
		if key2Rules, has := key2["request-scoped-errors"]; !has || !reflect.DeepEqual(key2Rules, []any{}) {
			t.Fatalf("key 2 = %#v, want explicit empty [] override", key2)
		}

		if got := listedProvider(t, fixture, "vertex-0").RuntimePolicy.ErrorRules; len(got) != 1 || got[0].Status != 429 {
			t.Fatalf("vertex-0 listed rules = %+v, want inherited 429 rule", got)
		}
		if got := listedProvider(t, fixture, "vertex-1").RuntimePolicy.ErrorRules; len(got) != 1 || got[0].Status != 400 {
			t.Fatalf("vertex-1 listed rules = %+v, want 400 override", got)
		}
		if got := listedProvider(t, fixture, "vertex-2").RuntimePolicy.ErrorRules; len(got) != 0 {
			t.Fatalf("vertex-2 listed rules = %+v, want no rules after [] clear", got)
		}
	})
}

func TestProviderVertexInteractionsRoundTrip(t *testing.T) {
	fixture := newProviderTestFixture(t)
	vertexList := []map[string]any{{
		"api-key": "sk-vertex-1", "auth-index": "vx-1", "base-url": "https://vertex.test/v1",
	}}
	fixture.state.mu.Lock()
	if fixture.state.familyLists == nil {
		fixture.state.familyLists = map[string]*[]map[string]any{}
	}
	fixture.state.familyLists["vertex"] = &vertexList
	fixture.state.mu.Unlock()

	body := `{"family":"vertex","name":"Vertex","base_url":"https://vertex.test/v1","keys":[{"api_key":""}],
		"behavior":{"interactions":true}}`
	if resp, payload := doJSON(t, fixture.client, http.MethodPut, fixture.baseURL+providersEndpoint+"/vertex-0", body); resp.StatusCode != http.StatusOK {
		t.Fatalf("update = %d %s", resp.StatusCode, payload)
	}
	fixture.state.mu.Lock()
	stored := vertexList[0]
	fixture.state.mu.Unlock()
	if stored["interactions"] != true {
		t.Fatalf("stored interactions = %#v, want true", stored["interactions"])
	}
	listed := listedProvider(t, fixture, "vertex-0")
	if listed.Behavior == nil || listed.Behavior.Interactions == nil || !*listed.Behavior.Interactions {
		t.Fatalf("listed behaviour = %+v, want the vertex interactions switch", listed.Behavior)
	}

	// The switch belongs to vertex alone: codex must refuse it the way CPA would
	// refuse the whole configuration.
	body = `{"family":"codex","name":"Codex","base_url":"https://codex.test/v1","keys":[{"api_key":""}],
		"behavior":{"interactions":true}}`
	if resp, _ := doJSON(t, fixture.client, http.MethodPut, fixture.baseURL+providersEndpoint+"/codex-0", body); resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("codex update = %d, want a refusal for a switch its family lacks", resp.StatusCode)
	}
}

// native-tool-search is a Claude key's own setting: the console lists it as a
// Claude switch and stores it under CPA's wire name on that key.
func TestClaudeKeyStoresNativeToolSearch(t *testing.T) {
	fixture := newProviderTestFixture(t)
	fixture.state.mu.Lock()
	*fixture.state.providerList("claude") = []map[string]any{{"api-key": "sk-claude-1", "auth-index": "cl-1", "base-url": "https://claude.test"}}
	fixture.state.mu.Unlock()

	if listed := listedProvider(t, fixture, "claude-0"); listed.Behavior == nil || listed.Behavior.NativeToolSearch == nil || *listed.Behavior.NativeToolSearch {
		t.Fatalf("listed behaviour = %+v, want native tool search reported off", listed.Behavior)
	}
	body := `{"family":"claude","name":"Claude","base_url":"https://claude.test","keys":[{"api_key":""}],"behavior":{"native_tool_search":true}}`
	if resp, payload := doJSON(t, fixture.client, http.MethodPut, fixture.baseURL+providersEndpoint+"/claude-0", body); resp.StatusCode != http.StatusOK {
		t.Fatalf("update = %d %s", resp.StatusCode, payload)
	}
	fixture.state.mu.Lock()
	stored := (*fixture.state.providerList("claude"))[0]
	fixture.state.mu.Unlock()
	if stored["native-tool-search"] != true {
		t.Fatalf("stored = %#v, want native-tool-search set", stored)
	}
	if listed := listedProvider(t, fixture, "claude-0"); listed.Behavior == nil || listed.Behavior.NativeToolSearch == nil || !*listed.Behavior.NativeToolSearch {
		t.Fatalf("listed behaviour = %+v, want native tool search on", listed.Behavior)
	}
}

func TestProviderConnectionPoolGroupAndKeyEdits(t *testing.T) {
	for _, family := range []string{"codex", openAICompatibilityFamily} {
		t.Run(family, func(t *testing.T) {
			id := idPrefixForFamily(family) + "0"
			fixture := newProviderTestFixture(t)
			var groups []map[string]any
			if err := json.Unmarshal([]byte(`[{"name":"team","base-url":"https://relay.test","connection-pool":{"enabled":false,"idle-conn-timeout":"300s","max-idle-conns-per-host":2,"future-setting":"not-for-browser"},"keys":[{"api-key":"pool-one","connection-pool":{}},{"api-key":"pool-two","connection-pool":{"enabled":false,"max-idle-conns-per-host":0}},{"api-key":"pool-three"}]}]`), &groups); err != nil {
				t.Fatal(err)
			}
			fixture.state.mu.Lock()
			fixture.state.storedGroups = map[string][]map[string]any{family: groups}
			*fixture.state.providerList(family) = flattenGroups(family, groups, []map[string]any{
				{"api-key": "pool-one", "auth-index": "pool-index-1"}, {"api-key": "pool-two", "auth-index": "pool-index-2"}, {"api-key": "pool-three", "auth-index": "pool-index-3"},
			})
			fixture.state.mu.Unlock()
			_, payload := getJSON(t, fixture.client, fixture.baseURL+providersEndpoint+"?include_keys=false")
			if strings.Contains(string(payload), "pool-one") || strings.Contains(string(payload), "not-for-browser") {
				t.Fatal("sanitized pool projection leaked a credential or an unmodelled field")
			}
			listed := listedProvider(t, fixture, id)
			if listed.ConnectionPool == nil || listed.ConnectionPool.GroupName != "team" || listed.ConnectionPool.GroupSize != 3 || listed.ConnectionPool.Defaults.Enabled == nil || *listed.ConnectionPool.Defaults.Enabled {
				t.Fatalf("wrong group context: %+v", listed.ConnectionPool)
			}
			_, payload = getJSON(t, fixture.client, fixture.baseURL+providersEndpoint+"?include_keys=true")
			var revealed struct {
				Providers []ProviderItemDTO `json:"providers"`
			}
			if err := json.Unmarshal(payload, &revealed); err != nil {
				t.Fatal(err)
			}
			for _, item := range revealed.Providers {
				if item.ID == id {
					if len(item.KeyEntries) == 0 || item.KeyEntries[0].ConnectionPool == nil || item.KeyEntries[0].ConnectionPool.Enabled != nil || item.KeyEntries[0].EffectiveConnectionPool.Enabled == nil || *item.KeyEntries[0].EffectiveConnectionPool.Enabled {
						t.Fatalf("empty override did not inherit disabled group: %+v", item.KeyEntries)
					}
				}
			}
			for _, edit := range []struct {
				pool string
				key  string
			}{
				{"", ""},
				{`"connection_pool":{"enabled":true,"idle_conn_timeout":"0s","max_idle_conns_per_host":0},`, ""},
				{"", `,"connection_pool":{"enabled":false}`},
				{"", `,"connection_pool":null`},
			} {
				keys := fmt.Sprintf(`[{"api_key":""%s}]`, edit.key)
				if family == openAICompatibilityFamily {
					keys = fmt.Sprintf(`[{"api_key":""%s},{"api_key":"pool-two"},{"api_key":"pool-three"}]`, edit.key)
				}
				body := fmt.Sprintf(`{"family":%q,"name":"team","base_url":"https://relay.test",%s"keys":%s}`, family, edit.pool, keys)
				resp, raw := doJSON(t, fixture.client, http.MethodPut, fixture.baseURL+providersEndpoint+"/"+id, body)
				if resp.StatusCode != http.StatusOK {
					t.Fatalf("pool edit failed: %d %s", resp.StatusCode, raw)
				}
				if edit.pool != "" {
					groups[0]["connection-pool"] = map[string]any{"enabled": true, "idle-conn-timeout": "0s", "max-idle-conns-per-host": float64(0), "future-setting": "not-for-browser"}
				}
				key := groups[0]["keys"].([]any)[0].(map[string]any)
				if edit.key == `,"connection_pool":{"enabled":false}` {
					key["connection-pool"] = map[string]any{"enabled": false}
				}
				if edit.key == `,"connection_pool":null` {
					delete(key, "connection-pool")
				}
				fixture.state.mu.Lock()
				got, _ := json.Marshal(fixture.state.storedGroups[family])
				fixture.state.mu.Unlock()
				want, _ := json.Marshal(groups)
				if string(got) != string(want) {
					t.Fatalf("pool edit changed group ownership or sibling: got %s want %s", got, want)
				}
			}

		})
	}
}

func TestProviderConnectionPoolTrimsIdleTimeout(t *testing.T) {
	pool, isSet, err := parseProviderPoolEdit(json.RawMessage(`{"idle_conn_timeout":" 60s "}`))
	if err != nil || !isSet || pool == nil || pool.IdleConnTimeout == nil {
		t.Fatalf("parse trimmed timeout = %#v, set=%v, err=%v", pool, isSet, err)
	}
	if *pool.IdleConnTimeout != "60s" {
		t.Fatalf("stored timeout = %q, want 60s", *pool.IdleConnTimeout)
	}
}

func TestProviderConnectionPoolRejectsInvalidEditsBeforeWriting(t *testing.T) {
	for _, raw := range []string{`false`, `[]`, `{"unknown":true}`, `{"idle_conn_timeout":"forever"}`, `{"max_idle_conns_per_host":1.5}`} {
		t.Run(raw, func(t *testing.T) {
			fixture := newProviderTestFixture(t)
			resp, payload := doJSON(t, fixture.client, http.MethodPut, fixture.baseURL+providersEndpoint+"/codex-0", `{"family":"codex","base_url":"https://relay.test","connection_pool":`+raw+`}`)
			if resp.StatusCode != http.StatusBadRequest || !strings.Contains(string(payload), "provider_connection_pool_invalid") {
				t.Fatalf("invalid pool accepted: %d %s", resp.StatusCode, payload)
			}
			fixture.state.mu.Lock()
			defer fixture.state.mu.Unlock()
			if fixture.state.putCount != 0 {
				t.Fatal("invalid pool reached CPA")
			}
		})
	}
}

func TestOpenAICompatibleKeyRotationPreservesStoredPool(t *testing.T) {
	fixture := newProviderTestFixture(t)
	var groups []map[string]any
	if err := json.Unmarshal([]byte(`[{"name":"team","base-url":"https://relay.test","connection-pool":{"enabled":true},"keys":[{"api-key":"pool-one","connection-pool":{"enabled":false}},{"api-key":"pool-two"}]}]`), &groups); err != nil {
		t.Fatal(err)
	}
	fixture.state.mu.Lock()
	fixture.state.storedGroups = map[string][]map[string]any{openAICompatibilityFamily: groups}
	fixture.state.oaiProviders = flattenGroups(openAICompatibilityFamily, groups, nil)
	fixture.state.mu.Unlock()

	body := `{"family":"openai-compatibility","name":"team","base_url":"https://relay.test","keys":[{"api_key":"pool-rotated","source_index":0},{"api_key":"pool-two","source_index":1}]}`
	resp, payload := doJSON(t, fixture.client, http.MethodPut, fixture.baseURL+providersEndpoint+"/openai-compat-0", body)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("key rotation failed: %d %s", resp.StatusCode, payload)
	}
	fixture.state.mu.Lock()
	defer fixture.state.mu.Unlock()
	group := fixture.state.storedGroups[openAICompatibilityFamily][0]
	keys := group["keys"].([]any)
	if !reflect.DeepEqual(keys[0].(map[string]any)["connection-pool"], map[string]any{"enabled": false}) {
		t.Fatalf("rotated key lost its stored override: %#v", keys[0])
	}
	if keys[1].(map[string]any)["api-key"] != "pool-two" {
		t.Fatalf("sibling key changed: %#v", keys[1])
	}
	if group["connection-pool"].(map[string]any)["enabled"] != true {
		t.Fatal("group pool default changed")
	}
}
