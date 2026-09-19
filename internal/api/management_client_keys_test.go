package api

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/oh-my-cpa/oh-my-cpa/internal/security"
)

// The caller keys leave the process masked unless the caller asks for the values,
// which is the same `include_keys=true` opt-in the provider list uses.
//
// The key page is the only reader that asks: it joins this list against the
// configuration document it edits, by the key text, because neither substitute
// identity works - a mask is not unique (it keeps a short head and tail, so two
// keys can share one) and an index moves when CPA's `api-keys` list is edited. Every
// other reader renders the mask and has no use for the value.
func TestManagementClientAPIKeysEndpoints(t *testing.T) {
	client, baseURL, state := startProviderTestServer(t)

	// 1. GET client API keys: the list reports the keys as masks by default. Asserted
	// on the raw body as well as the decoded field, because "no plaintext key in the
	// response" is a property of the whole payload, not of one field of it.
	resp, payload := getJSON(t, client, baseURL+"/omc/api/v1/management/api-keys")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("get keys status = %d body %s", resp.StatusCode, payload)
	}
	if payloadStr := string(payload); strings.Contains(payloadStr, "sk-original-key-1") {
		t.Fatalf("the default key list must not carry a plaintext key: %s", payloadStr)
	}

	var res struct {
		Keys []ClientAPIKeyItemDTO `json:"keys"`
	}
	if err := json.Unmarshal(payload, &res); err != nil || len(res.Keys) != 2 {
		t.Fatalf("unexpected keys response: %s", payload)
	}
	if want := security.MaskSecret("sk-original-key-1"); res.Keys[0].Key != want {
		t.Fatalf("default key = %q, want the display mask %q", res.Keys[0].Key, want)
	}
	// The identity fields are computed from the value, not from what is displayed,
	// so masking the field must not change them.
	if res.Keys[0].Length != len("sk-original-key-1") || res.Keys[0].Fingerprint == "" {
		t.Fatalf("masking the display value must keep the identity: %#v", res.Keys[0])
	}

	// 2. GET with the opt-in: the page that edits the keys joins on the value.
	resp, payload = getJSON(t, client, baseURL+"/omc/api/v1/management/api-keys?include_keys=true")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("get keys status = %d body %s", resp.StatusCode, payload)
	}
	if err := json.Unmarshal(payload, &res); err != nil {
		t.Fatalf("unexpected keys response: %s", payload)
	}
	if res.Keys[0].Key != "sk-original-key-1" {
		t.Fatalf("an opted-in key list must carry the value, got %q", res.Keys[0].Key)
	}

	// 3. POST client API key: the response names the row it added - the index the new
	// key occupies - and does not echo back a secret the requester just sent.
	createBody := `{"key":"sk-new-client-key-3333"}`
	resp, payload = doJSON(t, client, http.MethodPost, baseURL+"/omc/api/v1/management/api-keys", createBody)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("create key status = %d body %s", resp.StatusCode, payload)
	}
	if payloadStr := string(payload); strings.Contains(payloadStr, "sk-new-client-key-3333") {
		t.Fatalf("the create response must not echo the key: %s", payloadStr)
	}
	// Decoded as well as scanned: the assertion above pins the absence of the secret,
	// this one pins what the response actually says, so a body that quietly dropped
	// the fields would not pass as "no echo".
	var created struct {
		Status string `json:"status"`
		Index  int    `json:"index"`
		Key    string `json:"key"`
	}
	if err := json.Unmarshal(payload, &created); err != nil {
		t.Fatalf("create response is not JSON: %s", payload)
	}
	wantKey := security.MaskSecret("sk-new-client-key-3333")
	if created.Index != 2 || created.Key != wantKey || created.Status != "ok" {
		t.Fatalf("create response = %+v, want status ok, index 2, key %q", created, wantKey)
	}

	state.mu.Lock()
	keyCount := len(state.clientKeys)
	lastInserted := state.clientKeys[keyCount-1]
	state.mu.Unlock()
	if keyCount != 3 || lastInserted != "sk-new-client-key-3333" {
		t.Fatalf("CPA clientKeys not updated properly: %#v", state.clientKeys)
	}

	// 4. DELETE client API key
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
