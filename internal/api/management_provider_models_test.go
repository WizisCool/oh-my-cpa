package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
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
