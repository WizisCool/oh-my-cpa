package api

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"

	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/management"
)

func TestManagementOAuthModelAliasesRoundTrip(t *testing.T) {
	state := map[string][]management.OAuthModelAlias{
		"codex": {
			{Name: "gpt-5", Alias: "gpt-5-fast", Fork: true, ForceMapping: true, DisplayName: "GPT-5 Fast"},
		},
		"claude": {
			{Name: "claude-sonnet-4", Alias: "sonnet-latest"},
		},
		"zai": {
			{Name: "glm-5", Alias: "GLM-5"},
		},
		"legacy:channel": {
			{Name: "legacy-model", Alias: "legacy-alias"},
		},
		"invalid-entry": {
			{Name: "same-model", Alias: "same-model"},
		},
	}
	const aliasPath = "/v8/management/config/oauth/model-alias"
	handler := func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		switch {
		case request.Method == http.MethodGet && request.URL.Path == aliasPath:
			_ = json.NewEncoder(writer).Encode(state)
		case request.Method == http.MethodPatch && request.URL.Path == "/v8/management/config":
			var payload struct {
				OAuth struct {
					ModelAlias map[string][]management.OAuthModelAlias `json:"model-alias"`
				} `json:"oauth"`
			}
			if err := json.NewDecoder(request.Body).Decode(&payload); err != nil {
				t.Fatalf("decode model alias patch: %v", err)
			}
			for channel, aliases := range payload.OAuth.ModelAlias {
				state[channel] = aliases
			}
			_, _ = writer.Write([]byte(`{"status":"ok"}`))
		case request.Method == http.MethodDelete && strings.HasPrefix(request.URL.Path, aliasPath+"/"):
			delete(state, strings.TrimPrefix(request.URL.Path, aliasPath+"/"))
			_, _ = writer.Write([]byte(`{"status":"ok"}`))
		default:
			_, _ = writer.Write([]byte(`{}`))
		}
	}
	client, baseURL, recorder := startAuthFilesTestServer(t, "management-secret-value", handler)
	base := baseURL + "/omc/api/v1/management/auth-files/model-aliases"

	response, raw := doJSON(t, client, http.MethodGet, base, "")
	if response.StatusCode != http.StatusOK {
		t.Fatalf("list model aliases = %d body = %s", response.StatusCode, raw)
	}
	recorder.last(t, http.MethodGet, aliasPath)
	var listed struct {
		Aliases map[string][]managementOAuthModelAlias `json:"aliases"`
	}
	if err := json.Unmarshal(raw, &listed); err != nil {
		t.Fatal(err)
	}
	if entry := listed.Aliases["codex"][0]; entry.Name != "gpt-5" || entry.Alias != "gpt-5-fast" || !entry.Fork || !entry.ForceMapping || entry.DisplayName != "GPT-5 Fast" {
		t.Fatalf("projected codex alias = %#v", entry)
	}
	if entry := listed.Aliases["zai"][0]; entry.Name != "glm-5" || entry.Alias != "GLM-5" {
		t.Fatalf("projected case-only alias = %#v", entry)
	}
	if _, exists := listed.Aliases["legacy:channel"]; exists {
		t.Fatalf("invalid legacy provider leaked into the projection: %#v", listed.Aliases)
	}
	if _, exists := listed.Aliases["invalid-entry"]; exists {
		t.Fatalf("invalid provider entries leaked into the projection: %#v", listed.Aliases)
	}

	patch := `{"provider":"codex","aliases":[{"name":"gpt-5.1","alias":"gpt-5.1-fast","fork":true,"force_mapping":true,"display_name":"GPT-5.1 Fast"},{"name":"glm-5","alias":"GLM-5","fork":true}]}`
	response, raw = doJSON(t, client, http.MethodPatch, base, patch)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("patch model aliases = %d body = %s", response.StatusCode, raw)
	}
	var mutation struct {
		Status   string                      `json:"status"`
		Provider string                      `json:"provider"`
		Aliases  []managementOAuthModelAlias `json:"aliases"`
	}
	if err := json.Unmarshal(raw, &mutation); err != nil {
		t.Fatal(err)
	}
	if mutation.Status != "ok" || mutation.Provider != "codex" || len(mutation.Aliases) != 2 || mutation.Aliases[0].Alias != "gpt-5.1-fast" || mutation.Aliases[1].Alias != "GLM-5" {
		t.Fatalf("model alias mutation = %s", raw)
	}
	forwardedPatch := recorder.last(t, http.MethodPatch, "/v8/management/config")
	if !strings.Contains(forwardedPatch.Body, `"model-alias":{"codex":[`) || !strings.Contains(forwardedPatch.Body, `"force-mapping":true`) {
		t.Fatalf("forwarded model alias patch = %s", forwardedPatch.Body)
	}

	response, raw = doJSON(t, client, http.MethodPatch, base, `{"provider":"codex","aliases":[]}`)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("delete model aliases = %d body = %s", response.StatusCode, raw)
	}
	var deletion struct {
		Aliases json.RawMessage `json:"aliases"`
	}
	if err := json.Unmarshal(raw, &deletion); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(bytes.TrimSpace(deletion.Aliases), []byte("[]")) {
		t.Fatalf("deleted model aliases must be a JSON array, got %s", deletion.Aliases)
	}
	if _, exists := state["codex"]; exists {
		t.Fatalf("codex aliases were not deleted: %#v", state)
	}
}

func TestManagementOAuthModelAliasesRequireReadback(t *testing.T) {
	handler := func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		if request.Method == http.MethodPatch {
			_, _ = writer.Write([]byte(`{"status":"ok"}`))
			return
		}
		_, _ = writer.Write([]byte(`{"codex":[{"name":"gpt-5","alias":"old-alias"}]}`))
	}
	client, baseURL, _ := startAuthFilesTestServer(t, "management-secret-value", handler)
	response, raw := doJSON(t, client, http.MethodPatch,
		baseURL+"/omc/api/v1/management/auth-files/model-aliases",
		`{"provider":"codex","aliases":[{"name":"gpt-5","alias":"new-alias"}]}`)
	if response.StatusCode != http.StatusBadGateway {
		t.Fatalf("unverified model alias patch = %d body = %s", response.StatusCode, raw)
	}
	if !strings.Contains(string(raw), "did not persist") {
		t.Fatalf("unverified model alias patch did not explain readback: %s", raw)
	}
}

func TestManagementOAuthModelAliasesGuardrails(t *testing.T) {
	client, baseURL, _ := startAuthFilesTestServer(t, "management-secret-value", func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write([]byte(`{"codex":[{"name":"gpt-5","alias":"fast"}]}`))
	})
	base := baseURL + "/omc/api/v1/management/auth-files/model-aliases"
	for _, probe := range []struct {
		body string
		want int
	}{
		{`{"provider":"","aliases":[]}`, http.StatusBadRequest},
		{`{"provider":"../codex","aliases":[]}`, http.StatusBadRequest},
		{`{"provider":"codex"}`, http.StatusBadRequest},
		{`{"provider":"codex","aliases":null}`, http.StatusBadRequest},
		{`{"provider":"codex","aliases":[{"name":"gpt-5","alias":"gpt-5"}]}`, http.StatusBadRequest},
		{`{"provider":"codex","aliases":[{"name":"gpt-5","alias":"fast"},{"name":"gpt-5.1","alias":"FAST"}]}`, http.StatusBadRequest},
		{`{"provider":"codex","aliases":[{"name":"glm-5","alias":"GLM-5"},{"name":"gpt-5","alias":"glm-5"}]}`, http.StatusBadRequest},
		{`{"provider":"codex","aliases":[{"name":"gpt-5","alias":"fast","api_key":"secret"}]}`, http.StatusBadRequest},
	} {
		response, raw := doJSON(t, client, http.MethodPatch, base, probe.body)
		if response.StatusCode != probe.want {
			t.Fatalf("model alias probe %s status = %d want %d body = %s", probe.body, response.StatusCode, probe.want, raw)
		}
	}

	missingClient, missingBase, _ := startAuthFilesTestServer(t, "management-secret-value", func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		writer.WriteHeader(http.StatusNotFound)
		_, _ = writer.Write([]byte(`{"error":"not found"}`))
	})
	response, raw := doJSON(t, missingClient, http.MethodGet, missingBase+"/omc/api/v1/management/auth-files/model-aliases", "")
	if response.StatusCode != http.StatusNotImplemented || !strings.Contains(string(raw), "capability_missing") {
		t.Fatalf("missing model alias capability = %d body = %s", response.StatusCode, raw)
	}
}

func TestNormalizeManagementOAuthModelAliasProvider(t *testing.T) {
	for input, want := range map[string]string{
		" Codex ":      "codex",
		"anti-gravity": "antigravity",
		"grok":         "xai",
		"x-ai":         "xai",
		"x.ai":         "xai",
		"my_provider":  "my-provider",
	} {
		got, err := normalizeManagementOAuthModelAliasProvider(input)
		if err != nil || got != want {
			t.Fatalf("normalize provider %q = %q, %v; want %q", input, got, err, want)
		}
	}
	if _, err := normalizeManagementOAuthModelAliasProvider("a" + strings.Repeat("b", 64)); err == nil || !strings.Contains(err.Error(), "at most 64") {
		t.Fatalf("oversized provider error = %v", err)
	}
}

func TestManagementOAuthModelAliasesAcceptsFullEntryBudget(t *testing.T) {
	state := map[string][]management.OAuthModelAlias{}
	const aliasPath = "/v8/management/config/oauth/model-alias"
	handler := func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		switch {
		case request.Method == http.MethodGet && request.URL.Path == aliasPath:
			_ = json.NewEncoder(writer).Encode(state)
		case request.Method == http.MethodPatch && request.URL.Path == "/v8/management/config":
			var payload struct {
				OAuth struct {
					ModelAlias map[string][]management.OAuthModelAlias `json:"model-alias"`
				} `json:"oauth"`
			}
			if err := json.NewDecoder(request.Body).Decode(&payload); err != nil {
				t.Fatalf("decode model alias patch: %v", err)
			}
			for channel, aliases := range payload.OAuth.ModelAlias {
				state[channel] = aliases
			}
			_, _ = writer.Write([]byte(`{"status":"ok"}`))
		default:
			_, _ = writer.Write([]byte(`{}`))
		}
	}
	client, baseURL, _ := startAuthFilesTestServer(t, "management-secret-value", handler)
	base := baseURL + "/omc/api/v1/management/auth-files/model-aliases"

	// 512 aliases with ~300-byte names+aliases exceed the old 256 KiB request limit.
	aliases := make([]managementOAuthModelAlias, managementOAuthModelAliasEntryLimit)
	for i := range aliases {
		aliases[i] = managementOAuthModelAlias{
			Name:  fmt.Sprintf("model-%03d-%s", i, strings.Repeat("m", 250)),
			Alias: fmt.Sprintf("alias-%03d-%s", i, strings.Repeat("a", 250)),
		}
	}
	body, err := json.Marshal(map[string]any{"provider": "codex", "aliases": aliases})
	if err != nil {
		t.Fatal(err)
	}
	if len(body) <= 256*1024 {
		t.Fatalf("expected payload > 256 KiB, got %d", len(body))
	}
	resp, raw := doJSON(t, client, http.MethodPatch, base, string(body))
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("full-budget model aliases status = %d body = %s, want 200", resp.StatusCode, raw)
	}
}
