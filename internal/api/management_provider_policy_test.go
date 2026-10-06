package api

import (
	"encoding/json"
	"fmt"
	"net/http"
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
		t.Fatalf("stored behaviour = %#v, want both switches set and the unmodelled setting kept", stored)
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
		{"rules on a family without them", "vertex-0", `{"family":"vertex","name":"Vertex","keys":[{"api_key":""}],"runtime_policy":{"cooling":"inherit","error_rules":[{"status":500,"match":["x"],"action":"stop"}]}}`, "does not support"},
	}
	for _, tc := range cases {
		resp, payload := doJSON(t, fixture.client, http.MethodPut, fixture.baseURL+providersEndpoint+"/"+tc.id, tc.body)
		if resp.StatusCode != http.StatusBadRequest || !strings.Contains(string(payload), tc.wantReason) {
			t.Errorf("%s: got %d %s, want 400 naming %q", tc.name, resp.StatusCode, payload, tc.wantReason)
		}
	}

	fixture.state.mu.Lock()
	defer fixture.state.mu.Unlock()
	if len(fixture.state.codexProviders[0]) != 3 {
		t.Fatalf("codex entry = %#v, want no refused request to have written anything", fixture.state.codexProviders[0])
	}
	if _, isStored := (*fixture.state.providerList("vertex"))[0]["request-scoped-errors"]; isStored {
		t.Fatal("vertex entry gained error rules")
	}
}
