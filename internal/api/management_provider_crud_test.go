package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"
)

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

	_, payload = getJSON(t, client, baseURL+"/omc/api/v1/management/providers?include_keys=true")
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

	_, payload = getJSON(t, client, baseURL+"/omc/api/v1/management/providers?include_keys=true")
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

func TestManagementProviderLargeKeyPoolAndBodyLimit(t *testing.T) {
	client, baseURL, state := startProviderTestServer(t)

	// Issue #740: a provider with 700 keys (~75 KiB JSON) must create and update
	// cleanly instead of tripping the old 32 KiB body cap.
	keys := make([]SaveProviderKeyEntry, 700)
	for i := range keys {
		keys[i] = SaveProviderKeyEntry{
			APIKey:   fmt.Sprintf("sk-large-pool-key-%04d-%s", i, strings.Repeat("a", 48)),
			ProxyURL: "http://127.0.0.1:7890",
		}
	}
	createPayload, err := json.Marshal(SaveProviderRequest{
		Family:  openAICompatibilityFamily,
		Name:    "Kenari Cloud",
		BaseURL: "https://api.kenari.example/v1",
		Keys:    keys,
		Models:  []string{"gpt-4o"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(createPayload) <= 64*1024 {
		t.Fatalf("expected regression payload > 64 KiB, got %d bytes", len(createPayload))
	}

	resp, body := doJSON(t, client, http.MethodPost, baseURL+"/omc/api/v1/management/providers", string(createPayload))
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("create large-pool provider status = %d body %s", resp.StatusCode, body)
	}
	var created struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(body, &created); err != nil || created.ID == "" {
		t.Fatalf("unexpected create response: %s", body)
	}

	updatePayload, err := json.Marshal(SaveProviderRequest{
		Family:       openAICompatibilityFamily,
		ExpectedName: "Kenari Cloud",
		Name:         "Kenari Cloud Updated",
		BaseURL:      "https://api.kenari.example/v2",
		Keys:         keys,
		Models:       []string{"gpt-4o", "gpt-4.1"},
	})
	if err != nil {
		t.Fatal(err)
	}
	resp, body = doJSON(t, client, http.MethodPut, baseURL+"/omc/api/v1/management/providers/"+created.ID, string(updatePayload))
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("update large-pool provider status = %d body %s", resp.StatusCode, body)
	}

	state.mu.Lock()
	saved := state.oaiProviders[len(state.oaiProviders)-1]
	state.mu.Unlock()
	if saved["name"] != "Kenari Cloud Updated" {
		t.Fatalf("saved provider name = %v, want Kenari Cloud Updated", saved["name"])
	}
	savedKeys, _ := saved["api-key-entries"].([]any)
	if len(savedKeys) != len(keys) {
		t.Fatalf("saved key count = %d, want %d", len(savedKeys), len(keys))
	}

	// Exceeding managementProviderBodyLimit must return 413 request_too_large
	// rather than 400 "invalid request body".
	oversized := `{"family":"openai-compatibility","name":"` + strings.Repeat("x", managementProviderBodyLimit+64) + `"}`
	for _, tc := range []struct {
		method string
		path   string
	}{
		{http.MethodPost, "/omc/api/v1/management/providers"},
		{http.MethodPut, "/omc/api/v1/management/providers/" + created.ID},
	} {
		resp, body = doJSON(t, client, tc.method, baseURL+tc.path, oversized)
		if resp.StatusCode != http.StatusRequestEntityTooLarge {
			t.Fatalf("%s %s oversized status = %d body %s, want 413", tc.method, tc.path, resp.StatusCode, body)
		}
		var errBody ErrorResponseDTO
		if err := json.Unmarshal(body, &errBody); err != nil {
			t.Fatalf("unmarshal 413 body: %v (%s)", err, body)
		}
		if errBody.Code != requestTooLargeCode || !strings.Contains(errBody.Error, fmt.Sprintf("%d", managementProviderBodyLimit)) {
			t.Fatalf("%s %s 413 payload = %+v", tc.method, tc.path, errBody)
		}
	}
}
