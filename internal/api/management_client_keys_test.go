package api

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

func TestManagementClientAPIKeysEndpoints(t *testing.T) {
	client, baseURL, state := startProviderTestServer(t)

	// 1. GET client API keys: assert plaintext keys are returned unmasked
	resp, payload := getJSON(t, client, baseURL+"/omc/api/v1/management/api-keys")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("get keys status = %d body %s", resp.StatusCode, payload)
	}
	payloadStr := string(payload)
	if !strings.Contains(payloadStr, "sk-original-key-1") {
		t.Fatalf("client key missing from response, keys must be returned in plaintext: %s", payloadStr)
	}

	var res struct {
		Keys []ClientAPIKeyItemDTO `json:"keys"`
	}
	if err := json.Unmarshal(payload, &res); err != nil || len(res.Keys) != 2 {
		t.Fatalf("unexpected keys response: %s", payload)
	}
	if res.Keys[0].Key != "sk-original-key-1" {
		t.Fatalf("expected plaintext client key, got %q", res.Keys[0].Key)
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
