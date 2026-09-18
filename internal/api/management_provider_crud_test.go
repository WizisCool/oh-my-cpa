package api

import (
	"encoding/json"
	"net/http"
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

	resp, payload = getJSON(t, client, baseURL+"/omc/api/v1/management/providers?include_keys=true")
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

	resp, payload = getJSON(t, client, baseURL+"/omc/api/v1/management/providers?include_keys=true")
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
