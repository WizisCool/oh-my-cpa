package api

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/auth"
	"github.com/oh-my-cpa/oh-my-cpa/internal/config"
	"github.com/oh-my-cpa/oh-my-cpa/internal/crypto"
	"github.com/oh-my-cpa/oh-my-cpa/internal/domain"
	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
)

type providerFakeServerState struct {
	mu              sync.Mutex
	clientKeys      []string
	oaiProviders    []map[string]any
	codexProviders  []map[string]any
	claudeProviders []map[string]any
	geminiProviders []map[string]any
}

func startProviderTestServer(t *testing.T) (*http.Client, string, *providerFakeServerState) {
	t.Helper()
	state := &providerFakeServerState{
		clientKeys: []string{"sk-original-key-1", "sk-original-key-2"},
		oaiProviders: []map[string]any{
			{
				"name":     "relay-station",
				"base-url": "https://user:pass@relay.example.test/v1?token=secret",
				"disabled": false,
				"api-keys": []string{"sk-provider-secret-key-1234"},
				"models":   []map[string]string{{"name": "gpt-4o"}},
			},
		},
		codexProviders: []map[string]any{
			{
				"prefix":     "codex-line",
				"auth-index": "c-1",
				"base-url":   "https://api.openai.com",
				"api-key":    "sk-codex-secret-key-9999",
			},
		},
		claudeProviders: []map[string]any{
			{
				"api-key":    "sk-ant-secret-1234",
				"auth-index": "ant-1",
				"base-url":   "https://api.anthropic.com",
			},
		},
		geminiProviders: []map[string]any{
			{
				"api-key":    "gemini-test-token-1234",
				"auth-index": "gem-1",
			},
		},
	}

	cpaServer := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		state.mu.Lock()
		defer state.mu.Unlock()
		writer.Header().Set("Content-Type", "application/json")
		path := request.URL.Path

		switch {
		case path == "/v0/management/api-keys" && request.Method == http.MethodGet:
			_ = json.NewEncoder(writer).Encode(map[string]any{"api-keys": state.clientKeys})
		case path == "/v0/management/api-keys" && request.Method == http.MethodPut:
			var arr []string
			if err := json.NewDecoder(request.Body).Decode(&arr); err == nil {
				state.clientKeys = arr
			} else {
				var req map[string][]string
				_ = json.NewDecoder(request.Body).Decode(&req)
				state.clientKeys = req["api-keys"]
			}
			_, _ = writer.Write([]byte(`{"status":"ok"}`))
		case path == "/v0/management/codex-api-key" && request.Method == http.MethodGet:
			_ = json.NewEncoder(writer).Encode(map[string]any{"codex-api-key": state.codexProviders})
		case path == "/v0/management/codex-api-key" && request.Method == http.MethodPut:
			var arr []map[string]any
			_ = json.NewDecoder(request.Body).Decode(&arr)
			state.codexProviders = arr
			_, _ = writer.Write([]byte(`{"status":"ok"}`))
		case path == "/v0/management/openai-compatibility" && request.Method == http.MethodGet:
			_ = json.NewEncoder(writer).Encode(map[string]any{"openai-compatibility": state.oaiProviders})
		case path == "/v0/management/openai-compatibility" && request.Method == http.MethodPut:
			var arr []map[string]any
			if err := json.NewDecoder(request.Body).Decode(&arr); err == nil {
				state.oaiProviders = arr
			} else {
				var req map[string][]map[string]any
				_ = json.NewDecoder(request.Body).Decode(&req)
				state.oaiProviders = req["openai-compatibility"]
			}
			_, _ = writer.Write([]byte(`{"status":"ok"}`))
		case path == "/v0/management/claude-api-key" && request.Method == http.MethodGet:
			_ = json.NewEncoder(writer).Encode(map[string]any{"claude-api-key": state.claudeProviders})
		case path == "/v0/management/claude-api-key" && request.Method == http.MethodPut:
			var arr []map[string]any
			_ = json.NewDecoder(request.Body).Decode(&arr)
			state.claudeProviders = arr
			_, _ = writer.Write([]byte(`{"status":"ok"}`))
		case path == "/v0/management/gemini-api-key" && request.Method == http.MethodGet:
			_ = json.NewEncoder(writer).Encode(map[string]any{"gemini-api-key": state.geminiProviders})
		case path == "/v0/management/gemini-api-key" && request.Method == http.MethodPut:
			var arr []map[string]any
			_ = json.NewDecoder(request.Body).Decode(&arr)
			state.geminiProviders = arr
			_, _ = writer.Write([]byte(`{"status":"ok"}`))
		default:
			writer.WriteHeader(http.StatusOK)
			_, _ = writer.Write([]byte(`{}`))
		}
	}))
	t.Cleanup(cpaServer.Close)

	db, err := repository.Open(context.Background(), fmt.Sprintf("file:mem_providers_%d?mode=memory&cache=shared", time.Now().UnixNano()))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	repo := repository.New(db)
	cipher, err := crypto.New("01234567890123456789012345678901")
	if err != nil {
		t.Fatal(err)
	}

	ciphertext, nonce, err := cipher.Encrypt([]byte("cpa-management-key"))
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	if err := repo.UpsertInstance(context.Background(), domain.CPAInstance{
		ID:                      "default",
		Name:                    "Default",
		BaseURL:                 cpaServer.URL,
		ManagementKeyCiphertext: ciphertext,
		ManagementKeyNonce:      nonce,
		CreatedAt:               now,
		UpdatedAt:               now,
	}); err != nil {
		t.Fatal(err)
	}

	authManager, err := auth.New("management-secret-value", "/omc", "")
	if err != nil {
		t.Fatal(err)
	}
	handler := NewHandler(config.Config{BasePath: "/omc", Version: "test"}, repo, cipher, nil, authManager)
	appServer := httptest.NewServer(handler.Router())
	t.Cleanup(appServer.Close)

	jar, err := cookiejar.New(nil)
	if err != nil {
		t.Fatal(err)
	}
	client := &http.Client{Jar: jar}
	loginResp, err := client.Post(appServer.URL+"/omc/api/auth/login", "application/json", bytes.NewBufferString(`{"password":"management-secret-value"}`))
	if err != nil || loginResp.StatusCode != http.StatusOK {
		t.Fatalf("login failed: %v", err)
	}

	return client, appServer.URL, state
}

func TestManagementClientAPIKeysEndpoints(t *testing.T) {
	client, baseURL, state := startProviderTestServer(t)

	// 1. GET client API keys: assert masked output
	resp, payload := getJSON(t, client, baseURL+"/omc/api/v1/management/api-keys")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("get keys status = %d body %s", resp.StatusCode, payload)
	}
	payloadStr := string(payload)
	if strings.Contains(payloadStr, "sk-original-key-1") {
		t.Fatalf("leaked plaintext client key in response: %s", payloadStr)
	}

	var res struct {
		Keys []ClientAPIKeyItemDTO `json:"keys"`
	}
	if err := json.Unmarshal(payload, &res); err != nil || len(res.Keys) != 2 {
		t.Fatalf("unexpected keys response: %s", payload)
	}
	if !strings.Contains(res.Keys[0].Masked, "••••") {
		t.Fatalf("key was not masked: %q", res.Keys[0].Masked)
	}

	// 2. POST client API key
	createBody := `{"key":"sk-new-client-key-3333"}`
	resp, payload = doJSON(t, client, http.MethodPost, baseURL+"/omc/api/v1/management/api-keys", createBody)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("create key status = %d body %s", resp.StatusCode, payload)
	}

	state.mu.Lock()
	keyCount := len(state.clientKeys)
	lastInserted := state.clientKeys[keyCount-1]
	state.mu.Unlock()
	if keyCount != 3 || lastInserted != "sk-new-client-key-3333" {
		t.Fatalf("CPA clientKeys not updated properly: %#v", state.clientKeys)
	}

	// 3. DELETE client API key
	delResp, _ := doJSON(t, client, http.MethodDelete, baseURL+"/omc/api/v1/management/api-keys/0", "")
	if delResp.StatusCode != http.StatusOK {
		t.Fatalf("delete key status = %d", delResp.StatusCode)
	}

	state.mu.Lock()
	keyCountAfterDel := len(state.clientKeys)
	state.mu.Unlock()
	if keyCountAfterDel != 2 {
		t.Fatalf("expected 2 keys after delete, got %d", keyCountAfterDel)
	}
}

func TestManagementProvidersEndpoints(t *testing.T) {
	client, baseURL, state := startProviderTestServer(t)

	// 1. GET providers: assert masked keys and stripped URLs
	resp, payload := getJSON(t, client, baseURL+"/omc/api/v1/management/providers")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("get providers status = %d body %s", resp.StatusCode, payload)
	}
	payloadStr := string(payload)
	for _, secret := range []string{"user:pass@", "?token=secret", "sk-provider-secret-key-1234", "sk-codex-secret-key-9999", "sk-ant-secret-1234"} {
		if strings.Contains(payloadStr, secret) {
			t.Fatalf("providers list leaked secret %q: %s", secret, payloadStr)
		}
	}

	var res struct {
		Providers []ProviderItemDTO `json:"providers"`
	}
	if err := json.Unmarshal(payload, &res); err != nil || len(res.Providers) < 4 {
		t.Fatalf("unexpected providers count: %s", payload)
	}

	// 2. PATCH provider status
	patchBody := `{"family":"openai-compatibility","index":0,"disabled":true}`
	resp, payload = doJSON(t, client, http.MethodPatch, baseURL+"/omc/api/v1/management/providers/status", patchBody)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("patch provider status = %d body %s", resp.StatusCode, payload)
	}

	state.mu.Lock()
	disabledVal := state.oaiProviders[0]["disabled"]
	state.mu.Unlock()
	if disabledVal != true {
		t.Fatalf("expected provider disabled true on CPA, got %v", disabledVal)
	}
}

func TestManagementProviderCreateUpdateDelete(t *testing.T) {
	client, baseURL, state := startProviderTestServer(t)

	// 1. Create a new openai-compatibility provider
	createBody := `{"family":"openai-compatibility","name":"DeepSeek Primary","base_url":"https://api.deepseek.com/v1","api_key":"sk-deepseek-1234","models":["deepseek-chat"]}`
	resp, payload := doJSON(t, client, http.MethodPost, baseURL+"/omc/api/v1/management/providers", createBody)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("create provider status = %d body %s", resp.StatusCode, payload)
	}

	state.mu.Lock()
	count := len(state.oaiProviders)
	last := state.oaiProviders[count-1]
	state.mu.Unlock()
	if count != 2 || last["name"] != "DeepSeek Primary" {
		t.Fatalf("expected 2 providers with last name DeepSeek Primary, got %#v", state.oaiProviders)
	}

	// 2. Update provider (openai-compat-1)
	updateBody := `{"family":"openai-compatibility","name":"DeepSeek Updated","base_url":"https://api.deepseek.com/v2","models":["deepseek-reasoner"]}`
	resp, payload = doJSON(t, client, http.MethodPut, baseURL+"/omc/api/v1/management/providers/openai-compat-1", updateBody)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("update provider status = %d body %s", resp.StatusCode, payload)
	}

	state.mu.Lock()
	updatedName := state.oaiProviders[1]["name"]
	state.mu.Unlock()
	if updatedName != "DeepSeek Updated" {
		t.Fatalf("expected updated name DeepSeek Updated, got %v", updatedName)
	}

	// 3. Delete provider (openai-compat-1)
	resp, payload = doJSON(t, client, http.MethodDelete, baseURL+"/omc/api/v1/management/providers/openai-compat-1", "")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("delete provider status = %d body %s", resp.StatusCode, payload)
	}

	state.mu.Lock()
	finalCount := len(state.oaiProviders)
	state.mu.Unlock()
	if finalCount != 1 {
		t.Fatalf("expected 1 provider after delete, got %d", finalCount)
	}

	// 4. Create provider with multi-key, proxy_url and weight
	multiKeyBody := `{"family":"openai-compatibility","name":"Multi Key Provider","base_url":"https://api.example.com","keys":[{"api_key":"sk-key-alpha-1234","proxy_url":"http://127.0.0.1:7890","weight":5},{"api_key":"sk-key-beta-5678","weight":10}]}`
	resp, payload = doJSON(t, client, http.MethodPost, baseURL+"/omc/api/v1/management/providers", multiKeyBody)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("create multi-key provider status = %d body %s", resp.StatusCode, payload)
	}

	resp, payload = getJSON(t, client, baseURL+"/omc/api/v1/management/providers")
	var providersResp struct {
		Providers []ProviderItemDTO `json:"providers"`
	}
	if err := json.Unmarshal(payload, &providersResp); err != nil {
		t.Fatal(err)
	}
	found := false
	for _, p := range providersResp.Providers {
		if p.Name == "Multi Key Provider" {
			found = true
			if len(p.KeyEntries) != 2 {
				t.Fatalf("expected 2 key entries, got %d", len(p.KeyEntries))
			}
			if p.KeyEntries[0].ProxyURL != "http://127.0.0.1:7890" {
				t.Fatalf("expected proxy url http://127.0.0.1:7890, got %s", p.KeyEntries[0].ProxyURL)
			}
			if p.KeyEntries[0].Weight == nil || *p.KeyEntries[0].Weight != 5 {
				t.Fatalf("expected weight 5, got %v", p.KeyEntries[0].Weight)
			}
			if p.KeyEntries[1].Weight == nil || *p.KeyEntries[1].Weight != 10 {
				t.Fatalf("expected weight 10, got %v", p.KeyEntries[1].Weight)
			}
		}
	}
	if !found {
		t.Fatalf("Multi Key Provider not found in list")
	}

	// 5. Create provider with custom models, image support and thinking levels
	thinkingBody := `{"family":"openai-compatibility","name":"Reasoning Provider","base_url":"https://api.reasoning.com/v1","model_entries":[{"name":"deepseek-r1","alias":"r1","image":true,"thinking":{"levels":["low","medium","high","xhigh"]}}]}`
	resp, payload = doJSON(t, client, http.MethodPost, baseURL+"/omc/api/v1/management/providers", thinkingBody)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("create reasoning provider status = %d body %s", resp.StatusCode, payload)
	}

	resp, payload = getJSON(t, client, baseURL+"/omc/api/v1/management/providers")
	if err := json.Unmarshal(payload, &providersResp); err != nil {
		t.Fatal(err)
	}
	foundReasoning := false
	for _, p := range providersResp.Providers {
		if p.Name == "Reasoning Provider" {
			foundReasoning = true
			if len(p.ModelEntries) != 1 {
				t.Fatalf("expected 1 model entry, got %d", len(p.ModelEntries))
			}
			m := p.ModelEntries[0]
			if m.Name != "deepseek-r1" || m.Alias != "r1" || !m.Image {
				t.Fatalf("unexpected model entry fields: %#v", m)
			}
			if m.Thinking == nil || len(m.Thinking.Levels) != 4 || m.Thinking.Levels[0] != "low" {
				t.Fatalf("unexpected thinking levels: %#v", m.Thinking)
			}
		}
	}
	if !foundReasoning {
		t.Fatalf("Reasoning Provider not found in list")
	}
}

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


func TestUnifiedProviderArchitectureClaudeCodexGemini(t *testing.T) {
	client, baseURL, _ := startProviderTestServer(t)

	// 1. Verify Claude provider displays key entries and can be updated with custom name & new key
	updateClaude := `{"family":"claude","name":"Claude 3.5 专线","base_url":"https://api.anthropic.com","keys":[{"api_key":"sk-ant-new-secret-5678","proxy_url":"http://127.0.0.1:7890","weight":3}],"prefix":"fast"}`
	resp, payload := doJSON(t, client, http.MethodPut, baseURL+"/omc/api/v1/management/providers/claude-0", updateClaude)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("update claude provider status = %d body %s", resp.StatusCode, payload)
	}

	// Read providers list and verify custom name and masked key in list
	resp, payload = getJSON(t, client, baseURL+"/omc/api/v1/management/providers")
	var providersResp struct {
		Providers []ProviderItemDTO `json:"providers"`
	}
	if err := json.Unmarshal(payload, &providersResp); err != nil {
		t.Fatal(err)
	}

	var foundClaude *ProviderItemDTO
	for i := range providersResp.Providers {
		p := &providersResp.Providers[i]
		if p.ID == "claude-0" {
			foundClaude = p
			break
		}
	}
	if foundClaude == nil {
		t.Fatalf("claude-0 provider not found in list")
	}
	if foundClaude.Name != "Claude 3.5 专线" {
		t.Fatalf("expected custom name Claude 3.5 专线, got %q", foundClaude.Name)
	}
	if len(foundClaude.KeyEntries) != 1 {
		t.Fatalf("expected 1 key entry for claude, got %d", len(foundClaude.KeyEntries))
	}
	if foundClaude.KeyEntries[0].ProxyURL != "http://127.0.0.1:7890" {
		t.Fatalf("expected proxy url on claude key entry, got %q", foundClaude.KeyEntries[0].ProxyURL)
	}

	// 2. Toggle status on Claude provider and verify it reflects in list
	patchClaude := `{"family":"claude","index":0,"disabled":true}`
	resp, payload = doJSON(t, client, http.MethodPatch, baseURL+"/omc/api/v1/management/providers/status", patchClaude)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("patch claude status = %d body %s", resp.StatusCode, payload)
	}

	resp, payload = getJSON(t, client, baseURL+"/omc/api/v1/management/providers")
	_ = json.Unmarshal(payload, &providersResp)
	for i := range providersResp.Providers {
		if providersResp.Providers[i].ID == "claude-0" {
			if !providersResp.Providers[i].Disabled {
				t.Fatalf("expected claude-0 to be disabled after toggle")
			}
		}
	}

	// 3. Create Gemini provider with custom name and verify it persists
	createGemini := `{"family":"gemini","name":"Gemini Pro Line","base_url":"https://generativelanguage.googleapis.com","keys":[{"api_key":"gemini-secret-9999"}],"prefix":"gem-pro"}`
	resp, payload = doJSON(t, client, http.MethodPost, baseURL+"/omc/api/v1/management/providers", createGemini)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("create gemini provider status = %d body %s", resp.StatusCode, payload)
	}

	resp, payload = getJSON(t, client, baseURL+"/omc/api/v1/management/providers")
	_ = json.Unmarshal(payload, &providersResp)
	foundGemini := false
	for _, p := range providersResp.Providers {
		if p.Name == "Gemini Pro Line" {
			foundGemini = true
			if len(p.KeyEntries) != 1 {
				t.Fatalf("expected 1 key entry on gemini, got %d", len(p.KeyEntries))
			}
		}
	}
	if !foundGemini {
		t.Fatalf("newly created Gemini Pro Line not found in providers list")
	}
}
