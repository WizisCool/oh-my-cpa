package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"strings"
	"sync"
	"testing"
)

const oauthExcludedModelsUpstreamPath = "/v8/management/config/oauth/excluded-models"

// oauthExcludedModelsUpstream answers the three requests the facade makes with
// the way CPA stores the map: a provider PATCH replaces its list, a DELETE
// removes it.
func oauthExcludedModelsUpstream(t *testing.T, state map[string][]string) http.HandlerFunc {
	t.Helper()
	return func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		switch {
		case request.Method == http.MethodGet && request.URL.Path == oauthExcludedModelsUpstreamPath:
			_ = json.NewEncoder(writer).Encode(state)
		case request.Method == http.MethodPatch && request.URL.Path == "/v8/management/config":
			var payload struct {
				OAuth struct {
					ExcludedModels map[string][]string `json:"excluded-models"`
				} `json:"oauth"`
			}
			if err := json.NewDecoder(request.Body).Decode(&payload); err != nil {
				t.Fatalf("decode excluded models patch: %v", err)
			}
			for provider, rules := range payload.OAuth.ExcludedModels {
				state[provider] = rules
			}
			_, _ = writer.Write([]byte(`{"status":"ok"}`))
		case request.Method == http.MethodDelete && strings.HasPrefix(request.URL.Path, oauthExcludedModelsUpstreamPath+"/"):
			delete(state, strings.TrimPrefix(request.URL.Path, oauthExcludedModelsUpstreamPath+"/"))
			_, _ = writer.Write([]byte(`{"status":"ok"}`))
		default:
			_, _ = writer.Write([]byte(`{}`))
		}
	}
}

func recordedCPARequests(recorder *cpaRecorder) []recordedCPARequest {
	recorder.mu.Lock()
	defer recorder.mu.Unlock()
	return append([]recordedCPARequest(nil), recorder.requests...)
}

func TestManagementOAuthExcludedModelsRoundTrip(t *testing.T) {
	state := map[string][]string{
		"Codex":          {" GPT-5-Mini ", "gpt-5-mini", "gpt-4*"},
		"claude":         {"claude-3-5-sonnet"},
		"legacy:channel": {"legacy-model"},
		"empty":          {" "},
	}
	client, baseURL, recorder := startAuthFilesTestServer(t, "management-secret-value", oauthExcludedModelsUpstream(t, state))
	base := baseURL + "/omc/api/v1/management/auth-files/excluded-models"

	response, raw := doJSON(t, client, http.MethodGet, base, "")
	if response.StatusCode != http.StatusOK {
		t.Fatalf("list excluded models = %d body = %s", response.StatusCode, raw)
	}
	var listed struct {
		ExcludedModels map[string][]string `json:"excluded_models"`
	}
	if err := json.Unmarshal(raw, &listed); err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(listed.ExcludedModels["codex"], ","); got != "gpt-5-mini,gpt-4*" {
		t.Fatalf("codex rules = %q, want the rules as CPA applies them", got)
	}
	for _, provider := range []string{"legacy:channel", "empty", "Codex"} {
		if _, exists := listed.ExcludedModels[provider]; exists {
			t.Fatalf("%q leaked into the projection: %#v", provider, listed.ExcludedModels)
		}
	}

	response, raw = doJSON(t, client, http.MethodPatch, base, `{"provider":"CODEX","models":["GPT-5-Codex","gpt-5-codex"," o3-* "]}`)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("patch excluded models = %d body = %s", response.StatusCode, raw)
	}
	var mutation struct {
		Status   string   `json:"status"`
		Provider string   `json:"provider"`
		Models   []string `json:"models"`
	}
	if err := json.Unmarshal(raw, &mutation); err != nil {
		t.Fatal(err)
	}
	if mutation.Status != "ok" || mutation.Provider != "codex" || strings.Join(mutation.Models, ",") != "gpt-5-codex,o3-*" {
		t.Fatalf("excluded models mutation = %s", raw)
	}
	forwarded := recorder.last(t, http.MethodPatch, "/v8/management/config")
	if !strings.Contains(forwarded.Body, `"excluded-models":{"codex":["gpt-5-codex","o3-*"]}`) {
		t.Fatalf("forwarded excluded models patch = %s", forwarded.Body)
	}
	// The other spelling of the provider would be read as the same one, so it goes.
	recorder.last(t, http.MethodDelete, oauthExcludedModelsUpstreamPath+"/Codex")
	if _, exists := state["Codex"]; exists {
		t.Fatalf("the stored spelling Codex survived the replacement: %#v", state)
	}
	if got := strings.Join(state["claude"], ","); got != "claude-3-5-sonnet" {
		t.Fatalf("another provider was touched: %q", got)
	}

	response, raw = doJSON(t, client, http.MethodPatch, base, `{"provider":"codex","models":[]}`)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("delete excluded models = %d body = %s", response.StatusCode, raw)
	}
	var deletion struct {
		Models json.RawMessage `json:"models"`
	}
	if err := json.Unmarshal(raw, &deletion); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(bytes.TrimSpace(deletion.Models), []byte("[]")) {
		t.Fatalf("deleted excluded models must be a JSON array, got %s", deletion.Models)
	}
	if _, exists := state["codex"]; exists {
		t.Fatalf("codex rules were not deleted: %#v", state)
	}
}

func TestManagementOAuthExcludedModelsRequireReadback(t *testing.T) {
	handler := func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		if request.Method == http.MethodGet && request.URL.Path == oauthExcludedModelsUpstreamPath {
			_, _ = writer.Write([]byte(`{"codex":["something-else"]}`))
			return
		}
		_, _ = writer.Write([]byte(`{"status":"ok"}`))
	}
	client, baseURL, _ := startAuthFilesTestServer(t, "management-secret-value", handler)
	response, raw := doJSON(t, client, http.MethodPatch, baseURL+"/omc/api/v1/management/auth-files/excluded-models", `{"provider":"codex","models":["gpt-5"]}`)
	if response.StatusCode != http.StatusBadGateway {
		t.Fatalf("unverified write = %d body = %s, want 502", response.StatusCode, raw)
	}
}

func TestManagementOAuthExcludedModelsGuardrails(t *testing.T) {
	client, baseURL, recorder := startAuthFilesTestServer(t, "management-secret-value", oauthExcludedModelsUpstream(t, map[string][]string{}))
	base := baseURL + "/omc/api/v1/management/auth-files/excluded-models"
	tooMany := make([]string, 0, managementOAuthExcludedModelRuleLimit+1)
	for index := 0; index <= managementOAuthExcludedModelRuleLimit; index++ {
		tooMany = append(tooMany, "model-"+strings.Repeat("x", index%7)+string(rune('a'+index%26))+strings.Repeat("y", index/26))
	}
	encodedTooMany, _ := json.Marshal(map[string]any{"provider": "codex", "models": tooMany})
	for name, body := range map[string]string{
		"missing models":     `{"provider":"codex"}`,
		"invalid provider":   `{"provider":"../codex","models":["gpt-5"]}`,
		"unicode whitespace": `{"provider":"codex","models":["gpt\u00a05"]}`,
		"inner whitespace":   `{"provider":"codex","models":["gpt 5"]}`,
		"control char":       `{"provider":"codex","models":["gpt\u0000-5"]}`,
		"too long":           `{"provider":"codex","models":["` + strings.Repeat("m", managementOAuthExcludedModelFieldLimit+1) + `"]}`,
		"too many":           string(encodedTooMany),
	} {
		response, raw := doJSON(t, client, http.MethodPatch, base, body)
		if response.StatusCode != http.StatusBadRequest {
			t.Errorf("%s = %d body = %s, want 400", name, response.StatusCode, raw)
		}
	}
	for _, request := range recordedCPARequests(recorder) {
		if request.Method != http.MethodGet {
			t.Fatalf("a refused write reached CPA: %s %s", request.Method, request.Path)
		}
	}
}

func TestManagementOAuthProviderModels(t *testing.T) {
	handler := func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		switch request.URL.Path {
		case "/v8/management/routing/model-definitions/codex":
			_, _ = writer.Write([]byte(`{"channel":"codex","models":[{"id":"gpt-5","display_name":"GPT-5"},{"id":"GPT-5"},{"id":""},{"id":"gpt-5-mini"}]}`))
		case "/v8/management/routing/model-definitions/kimi":
			writer.WriteHeader(http.StatusBadRequest)
			_, _ = writer.Write([]byte(`{"error":"unknown channel"}`))
		case "/v8/management/routing/model-definitions/candy-plugin":
			// CPA serves a plugin channel from the plugin host's catalog. Fields
			// beyond the model's identity stay on the gateway.
			_, _ = writer.Write([]byte(`{"channel":"candy-plugin","models":[{"id":"candy-1","display_name":"Candy One","owned_by":"plugin","upstream_url":"https://upstream.invalid"},{"id":"candy-2"}]}`))
		case "/v8/management/routing/model-definitions/legacy-plugin":
			// A gateway that predates plugin catalogs has no such route.
			writer.WriteHeader(http.StatusNotFound)
		default:
			_, _ = writer.Write([]byte(`{}`))
		}
	}
	client, baseURL, recorder := startAuthFilesTestServer(t, "management-secret-value", handler)
	base := baseURL + "/omc/api/v1/management/auth-files/provider-models?provider="
	type catalog struct {
		Provider  string `json:"provider"`
		Available bool   `json:"available"`
		Models    []struct {
			ID          string `json:"id"`
			DisplayName string `json:"display_name"`
		} `json:"models"`
	}
	read := func(provider string) catalog {
		t.Helper()
		response, raw := doJSON(t, client, http.MethodGet, base+provider, "")
		if response.StatusCode != http.StatusOK {
			t.Fatalf("provider models %s = %d body = %s", provider, response.StatusCode, raw)
		}
		var result catalog
		if err := json.Unmarshal(raw, &result); err != nil {
			t.Fatal(err)
		}
		return result
	}
	codex := read("Codex")
	if !codex.Available || codex.Provider != "codex" || len(codex.Models) != 2 || codex.Models[0].DisplayName != "GPT-5" || codex.Models[1].ID != "gpt-5-mini" {
		t.Fatalf("codex catalog = %#v", codex)
	}
	// A channel the gateway does not know is "no catalog", not a failure.
	if kimi := read("kimi"); kimi.Available || len(kimi.Models) != 0 {
		t.Fatalf("kimi catalog = %#v", kimi)
	}
	plugin := read("candy-plugin")
	if !plugin.Available || plugin.Provider != "candy-plugin" || len(plugin.Models) != 2 || plugin.Models[0].ID != "candy-1" || plugin.Models[0].DisplayName != "Candy One" || plugin.Models[1].ID != "candy-2" {
		t.Fatalf("plugin catalog = %#v", plugin)
	}
	if _, raw := doJSON(t, client, http.MethodGet, base+"candy-plugin", ""); strings.Contains(string(raw), "upstream_url") || strings.Contains(string(raw), "owned_by") {
		t.Fatalf("plugin catalog leaked unlisted fields: %s", raw)
	}
	if legacy := read("legacy-plugin"); legacy.Available || legacy.Models == nil || len(legacy.Models) != 0 {
		t.Fatalf("older gateway catalog = %#v", legacy)
	}
	paths := map[string]bool{}
	for _, request := range recordedCPARequests(recorder) {
		if strings.Contains(request.Path, "model-definitions") {
			paths[request.Path] = true
		}
	}
	for _, want := range []string{"/v8/management/routing/model-definitions/candy-plugin", "/v8/management/routing/model-definitions/legacy-plugin"} {
		if !paths[want] {
			t.Fatalf("plugin channel did not reach %s; requested %v", want, paths)
		}
	}
	before := len(recordedCPARequests(recorder))
	response, _ := doJSON(t, client, http.MethodGet, base+"..%2Fconfig", "")
	if response.StatusCode != http.StatusBadRequest {
		t.Fatalf("invalid provider = %d, want 400", response.StatusCode)
	}
	// A refused provider key never becomes part of an upstream path.
	if after := recordedCPARequests(recorder)[before:]; len(after) != 0 {
		t.Fatalf("a refused provider reached CPA: %#v", after)
	}
}

func TestManagementOAuthProviderModelsPreserveUpstreamFailure(t *testing.T) {
	client, baseURL, _ := startAuthFilesTestServer(t, "management-secret-value", func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path == "/v8/management/routing/model-definitions/codex" {
			writer.WriteHeader(http.StatusServiceUnavailable)
			_, _ = writer.Write([]byte(`{"error":"catalog unavailable"}`))
			return
		}
		_, _ = writer.Write([]byte(`{}`))
	})
	response, body := doJSON(t, client, http.MethodGet, baseURL+"/omc/api/v1/management/auth-files/provider-models?provider=codex", "")
	if response.StatusCode < 500 || strings.Contains(string(body), `"available":false`) {
		t.Fatalf("failed catalog became an absent catalog: status=%d body=%s", response.StatusCode, body)
	}
}

func TestManagementOAuthExcludedModelsAuditFailure(t *testing.T) {
	for _, outcome := range []string{"attempt", "success"} {
		t.Run(outcome, func(t *testing.T) {
			state := map[string][]string{"codex": {"original-model"}, "claude": {"claude-*"}}
			var stateMutex sync.Mutex
			patchCount := 0
			upstream := oauthExcludedModelsUpstream(t, state)
			client, baseURL, repo := startDashboardTestServer(t, func(writer http.ResponseWriter, request *http.Request) {
				stateMutex.Lock()
				defer stateMutex.Unlock()
				if request.Method == http.MethodPatch && request.URL.Path == "/v8/management/config" {
					patchCount++
				}
				upstream(writer, request)
			})
			// Refuse only one audit phase to distinguish aborted writes from landed writes.
			_, err := repo.SQL().Exec(`CREATE TRIGGER reject_excluded_models_audit BEFORE INSERT ON audit_events
				WHEN NEW.action = 'oauth_excluded_models.update' AND NEW.result = '` + outcome + `'
				BEGIN SELECT RAISE(FAIL, 'audit unavailable'); END`)
			if err != nil {
				t.Fatal(err)
			}
			response, raw := doJSON(t, client, http.MethodPatch, baseURL+"/omc/api/v1/management/auth-files/excluded-models", `{"provider":"CODEX","models":[" GPT-5-Codex ","gpt-5-codex","o3-*"]}`)
			stateMutex.Lock()
			defer stateMutex.Unlock()
			if outcome == "attempt" {
				if response.StatusCode != http.StatusInternalServerError || patchCount != 0 || strings.Join(state["codex"], ",") != "original-model" {
					t.Fatalf("failed attempt audit: status %d, patches %d, state %v, body %s", response.StatusCode, patchCount, state, raw)
				}
			} else {
				if response.StatusCode != http.StatusOK || patchCount != 1 || strings.Join(state["codex"], ",") != "gpt-5-codex,o3-*" {
					t.Fatalf("failed success audit: status %d, patches %d, state %v, body %s", response.StatusCode, patchCount, state, raw)
				}
				var saved struct {
					Status   string   `json:"status"`
					Provider string   `json:"provider"`
					Models   []string `json:"models"`
				}
				if err := json.Unmarshal(raw, &saved); err != nil {
					t.Fatal(err)
				}
				if saved.Status != "ok" || saved.Provider != "codex" || strings.Join(saved.Models, ",") != strings.Join(state["codex"], ",") {
					t.Fatalf("verified baseline mismatch: %s", raw)
				}
			}
			if strings.Join(state["claude"], ",") != "claude-*" {
				t.Fatalf("unrelated provider changed: %v", state)
			}
		})
	}
}
