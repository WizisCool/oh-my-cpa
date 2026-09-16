package api

import (
	"bytes"
	"encoding/json"
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
		"legacy:channel": {
			{Name: "legacy-model", Alias: "legacy-alias"},
		},
		"invalid-entry": {
			{Name: "same-model", Alias: "same-model"},
		},
	}
	handler := func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		if request.URL.Path != "/v0/management/oauth-model-alias" {
			_, _ = writer.Write([]byte(`{}`))
			return
		}
		switch request.Method {
		case http.MethodGet:
			_ = json.NewEncoder(writer).Encode(map[string]any{"oauth-model-alias": state})
		case http.MethodPatch:
			var payload struct {
				Channel string                       `json:"channel"`
				Aliases []management.OAuthModelAlias `json:"aliases"`
			}
			if err := json.NewDecoder(request.Body).Decode(&payload); err != nil {
				t.Fatalf("decode model alias patch: %v", err)
			}
			if len(payload.Aliases) == 0 {
				delete(state, payload.Channel)
			} else {
				state[payload.Channel] = payload.Aliases
			}
			_, _ = writer.Write([]byte(`{"status":"ok"}`))
		default:
			writer.WriteHeader(http.StatusMethodNotAllowed)
		}
	}
	client, baseURL, recorder := startAuthFilesTestServer(t, "management-secret-value", handler)
	base := baseURL + "/omc/api/v1/management/auth-files/model-aliases"

	response, raw := doJSON(t, client, http.MethodGet, base, "")
	if response.StatusCode != http.StatusOK {
		t.Fatalf("list model aliases = %d body = %s", response.StatusCode, raw)
	}
	forwarded := recorder.last(t, http.MethodGet, "/v0/management/oauth-model-alias")
	if forwarded.Path != "/v0/management/oauth-model-alias" {
		t.Fatalf("model alias list path = %q", forwarded.Path)
	}
	var listed struct {
		Aliases map[string][]managementOAuthModelAlias `json:"aliases"`
	}
	if err := json.Unmarshal(raw, &listed); err != nil {
		t.Fatal(err)
	}
	if entry := listed.Aliases["codex"][0]; entry.Name != "gpt-5" || entry.Alias != "gpt-5-fast" || !entry.Fork || !entry.ForceMapping || entry.DisplayName != "GPT-5 Fast" {
		t.Fatalf("projected codex alias = %#v", entry)
	}
	if _, exists := listed.Aliases["legacy:channel"]; exists {
		t.Fatalf("invalid legacy provider leaked into the projection: %#v", listed.Aliases)
	}
	if _, exists := listed.Aliases["invalid-entry"]; exists {
		t.Fatalf("invalid provider entries leaked into the projection: %#v", listed.Aliases)
	}

	patch := `{"provider":"codex","aliases":[{"name":"gpt-5.1","alias":"gpt-5.1-fast","fork":true,"force_mapping":true,"display_name":"GPT-5.1 Fast"}]}`
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
	if mutation.Status != "ok" || mutation.Provider != "codex" || len(mutation.Aliases) != 1 || mutation.Aliases[0].Alias != "gpt-5.1-fast" {
		t.Fatalf("model alias mutation = %s", raw)
	}
	forwardedPatch := recorder.last(t, http.MethodPatch, "/v0/management/oauth-model-alias")
	if !strings.Contains(forwardedPatch.Body, `"channel":"codex"`) || !strings.Contains(forwardedPatch.Body, `"force-mapping":true`) {
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
		_, _ = writer.Write([]byte(`{"oauth-model-alias":{"codex":[{"name":"gpt-5","alias":"old-alias"}]}}`))
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
		_, _ = writer.Write([]byte(`{"oauth-model-alias":{"codex":[{"name":"gpt-5","alias":"fast"}]}}`))
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
