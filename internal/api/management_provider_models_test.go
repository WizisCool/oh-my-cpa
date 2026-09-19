package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

func TestPullProviderModels(t *testing.T) {
	// Fake upstream AI provider endpoint serving /v1/models
	fakeUpstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer sk-test-upstream-key" {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"data": []map[string]any{
				{"id": "DeepSeek-V4-Flash"},
				{"id": "DeepSeek-V4-Flash-Vision-Exp"},
				{"id": "MiniCPM5-1B"},
				{"id": "Qwen3.8-Flash-Next"},
			},
		})
	}))
	defer fakeUpstream.Close()

	client, baseURL, _ := startProviderTestServer(t)

	// 1. Successful pull from endpoint
	pullReq := fmt.Sprintf(`{"base_url":"%s/v1","api_key":"sk-test-upstream-key"}`, fakeUpstream.URL)
	resp, payload := doJSON(t, client, http.MethodPost, baseURL+"/omc/api/v1/management/providers/pull-models", pullReq)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("pull models status = %d body %s", resp.StatusCode, payload)
	}

	var pullResp struct {
		Models []string `json:"models"`
		Total  int      `json:"total"`
	}
	if err := json.Unmarshal(payload, &pullResp); err != nil {
		t.Fatal(err)
	}
	if len(pullResp.Models) != 4 || pullResp.Models[0] != "DeepSeek-V4-Flash" {
		t.Fatalf("unexpected models list: %#v", pullResp)
	}

	// 2. Reject missing base_url
	resp, _ = doJSON(t, client, http.MethodPost, baseURL+"/omc/api/v1/management/providers/pull-models", `{"api_key":"sk-xxx"}`)
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("expected 400 for missing base_url, got %d", resp.StatusCode)
	}

	// 3. Upstream 401 returns bad gateway
	badKeyReq := fmt.Sprintf(`{"base_url":"%s/v1","api_key":"wrong-key"}`, fakeUpstream.URL)
	resp, _ = doJSON(t, client, http.MethodPost, baseURL+"/omc/api/v1/management/providers/pull-models", badKeyReq)
	if resp.StatusCode != http.StatusBadGateway {
		t.Fatalf("expected 502 for upstream unauthorized, got %d", resp.StatusCode)
	}
}

func TestModelPullBaseURLPolicy(t *testing.T) {
	tests := []struct {
		name      string
		rawURL    string
		isAllowed bool
	}{
		{name: "public https", rawURL: "https://api.example.com/v1", isAllowed: true},
		{name: "public http", rawURL: "http://api.example.com/v1", isAllowed: false},
		{name: "localhost", rawURL: "http://localhost:8080/v1", isAllowed: true},
		{name: "loopback ipv4", rawURL: "http://127.0.0.1:8080/v1", isAllowed: true},
		{name: "loopback ipv6", rawURL: "http://[::1]:8080/v1", isAllowed: true},
		{name: "private ipv4", rawURL: "http://10.20.30.40:8080/v1", isAllowed: true},
		{name: "private ipv6", rawURL: "http://[fd00::1]:8080/v1", isAllowed: true},
		{name: "link-local ipv4", rawURL: "http://169.254.10.20:8080/v1", isAllowed: false},
		{name: "cloud metadata", rawURL: "http://169.254.169.254/latest/meta-data", isAllowed: false},
		{name: "other scheme", rawURL: "ftp://localhost/v1", isAllowed: false},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			parsed, err := url.Parse(test.rawURL)
			if err != nil {
				t.Fatal(err)
			}
			if got := isModelPullURLAllowed(parsed); got != test.isAllowed {
				t.Fatalf("isModelPullURLAllowed(%q) = %v, want %v", test.rawURL, got, test.isAllowed)
			}
		})
	}
}

func TestFetchEndpointModelsRejectsPublicHTTP(t *testing.T) {
	_, err := fetchEndpointModels(context.Background(), "http://example.com/v1", "sk-provider-secret-1234", "", "openai", nil)
	if err == nil || !strings.Contains(err.Error(), "HTTPS") {
		t.Fatalf("expected HTTPS policy error, got %v", err)
	}
}

func TestPullProviderModelsReportsInvalidURL(t *testing.T) {
	client, baseURL, _ := startProviderTestServer(t)

	resp, payload := doJSON(
		t,
		client,
		http.MethodPost,
		baseURL+"/omc/api/v1/management/providers/pull-models",
		`{"base_url":"http://example.com/v1","api_key":"sk-provider-secret-1234"}`,
	)
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("invalid base URL status = %d body %s", resp.StatusCode, payload)
	}
	var response struct {
		Error string `json:"error"`
		Code  string `json:"code"`
	}
	if err := json.Unmarshal(payload, &response); err != nil {
		t.Fatal(err)
	}
	if response.Code != "invalid_model_pull_url" || !strings.Contains(response.Error, "HTTPS") {
		t.Fatalf("unexpected invalid URL response: %#v", response)
	}
}

func TestPullProviderModelsReportsRedirectRefusal(t *testing.T) {
	redirectTarget := httptest.NewServer(http.NotFoundHandler())
	defer redirectTarget.Close()

	redirectSource := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		http.Redirect(writer, request, redirectTarget.URL+"/models", http.StatusFound)
	}))
	defer redirectSource.Close()

	client, baseURL, _ := startProviderTestServer(t)
	body := fmt.Sprintf(`{"base_url":%q,"api_key":"sk-provider-secret-1234"}`, redirectSource.URL)
	resp, payload := doJSON(t, client, http.MethodPost, baseURL+"/omc/api/v1/management/providers/pull-models", body)
	if resp.StatusCode != http.StatusBadGateway {
		t.Fatalf("redirect refusal status = %d body %s", resp.StatusCode, payload)
	}
	var response struct {
		Error string `json:"error"`
		Code  string `json:"code"`
	}
	if err := json.Unmarshal(payload, &response); err != nil {
		t.Fatal(err)
	}
	if response.Code != "model_pull_redirect_refused" || !strings.Contains(response.Error, "cross-origin redirect") {
		t.Fatalf("unexpected redirect response: %#v", response)
	}
}

func TestFetchEndpointModelsRefusesCrossOriginRedirect(t *testing.T) {
	for _, protocol := range []string{"openai", "anthropic", "gemini"} {
		t.Run(protocol, func(t *testing.T) {
			redirectedHeaders := make(chan http.Header, 1)
			redirectTarget := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
				redirectedHeaders <- request.Header.Clone()
				_ = json.NewEncoder(writer).Encode(map[string]any{"data": []map[string]any{{"id": "leaked-model"}}})
			}))
			defer redirectTarget.Close()

			redirectSource := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
				http.Redirect(writer, request, redirectTarget.URL+"/models", http.StatusFound)
			}))
			defer redirectSource.Close()

			_, err := fetchEndpointModels(
				context.Background(),
				redirectSource.URL,
				"sk-provider-secret-1234",
				"",
				protocol,
				map[string]string{"X-Provider-Secret": "custom-secret"},
			)
			if err == nil {
				t.Fatal("expected cross-origin redirect to be refused")
			}
			select {
			case headers := <-redirectedHeaders:
				t.Fatalf("redirect target received credentials: %v", headers)
			default:
			}
		})
	}
}

func TestFetchEndpointModelsFollowsSameOriginRedirect(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path == "/models" {
			http.Redirect(writer, request, "/v1/models", http.StatusFound)
			return
		}
		if request.URL.Path != "/v1/models" {
			http.NotFound(writer, request)
			return
		}
		if request.Header.Get("Authorization") != "Bearer sk-provider-secret-1234" {
			http.Error(writer, "unauthorized", http.StatusUnauthorized)
			return
		}
		_ = json.NewEncoder(writer).Encode(map[string]any{"data": []map[string]any{{"id": "redirected-model"}}})
	}))
	defer upstream.Close()

	models, err := fetchEndpointModels(context.Background(), upstream.URL, "sk-provider-secret-1234", "", "openai", nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(models) != 1 || models[0] != "redirected-model" {
		t.Fatalf("unexpected models after same-origin redirect: %#v", models)
	}
}

func TestPullProviderModelsByProviderID(t *testing.T) {
	// Upstream serves /v1/models only (like the official Anthropic API);
	// wrong or missing auth is rejected with 401 the way relays report it.
	var claudeAuthHeaders []string
	fakeUpstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path != "/v1/models" {
			http.NotFound(w, r)
			return
		}
		switch r.Header.Get("Authorization") {
		case "Bearer sk-codex-secret-key-9999":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"data": []map[string]any{{"id": "gpt-5.2-codex"}, {"id": "gpt-5.2-mini"}},
			})
		case "Bearer sk-ant-secret-1234":
			if r.Header.Get("x-api-key") == "sk-ant-secret-1234" && r.Header.Get("anthropic-version") == "2023-06-01" {
				claudeAuthHeaders = []string{r.Header.Get("x-api-key"), r.Header.Get("anthropic-version")}
				_ = json.NewEncoder(w).Encode(map[string]any{
					"data": []map[string]any{{"id": "claude-opus-4.6"}, {"id": "claude-sonnet-4.6"}},
				})
				return
			}
			http.Error(w, "missing anthropic auth headers", http.StatusUnauthorized)
		default:
			http.Error(w, `{"error":{"code":"1001","message":"Header中未收到Authorization参数，无法进行身份验证。"}}`, http.StatusUnauthorized)
		}
	}))
	defer fakeUpstream.Close()

	// Point the stored claude/codex entries at the fake upstream, then pull
	// with provider_id only (no api_key): the handler must resolve the
	// stored key itself, otherwise relays reject the request with HTTP 401.
	client, baseURL, _ := startProviderTestServer(t)

	updateClaude := fmt.Sprintf(`{"family":"claude","name":"Claude relay","base_url":"%s","keys":[{"api_key":"sk-ant-secret-1234"}]}`, fakeUpstream.URL)
	resp, payload := doJSON(t, client, http.MethodPut, baseURL+"/omc/api/v1/management/providers/claude-0", updateClaude)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("update claude provider status = %d body %s", resp.StatusCode, payload)
	}

	resp, payload = doJSON(t, client, http.MethodPost, baseURL+"/omc/api/v1/management/providers/pull-models", `{"provider_id":"claude-0","base_url":"`+fakeUpstream.URL+`"}`)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("claude pull by provider_id status = %d body %s", resp.StatusCode, payload)
	}
	var pullResp struct {
		Models []string `json:"models"`
	}
	if err := json.Unmarshal(payload, &pullResp); err != nil {
		t.Fatal(err)
	}
	if len(pullResp.Models) != 2 || pullResp.Models[0] != "claude-opus-4.6" {
		t.Fatalf("unexpected claude models list: %#v", pullResp.Models)
	}
	if len(claudeAuthHeaders) != 2 || claudeAuthHeaders[0] != "sk-ant-secret-1234" || claudeAuthHeaders[1] != "2023-06-01" {
		t.Fatalf("anthropic auth headers missing: %#v", claudeAuthHeaders)
	}
	updateCodex := fmt.Sprintf(`{"family":"codex","name":"Codex relay","base_url":"%s","keys":[{"api_key":"sk-codex-secret-key-9999"}]}`, fakeUpstream.URL)
	resp, payload = doJSON(t, client, http.MethodPut, baseURL+"/omc/api/v1/management/providers/codex-0", updateCodex)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("update codex provider status = %d body %s", resp.StatusCode, payload)
	}

	resp, payload = doJSON(t, client, http.MethodPost, baseURL+"/omc/api/v1/management/providers/pull-models", `{"provider_id":"codex-0","base_url":"`+fakeUpstream.URL+`"}`)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("codex pull by provider_id status = %d body %s", resp.StatusCode, payload)
	}
	if err := json.Unmarshal(payload, &pullResp); err != nil {
		t.Fatal(err)
	}
	if len(pullResp.Models) != 2 || pullResp.Models[0] != "gpt-5.2-codex" {
		t.Fatalf("unexpected codex models list: %#v", pullResp.Models)
	}
}
