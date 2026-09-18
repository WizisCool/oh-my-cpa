package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"
)

// Disabling a claude/codex/gemini API-key provider used to write a local
// preference only, so the gateway kept routing to it and fallback still picked
// the "disabled" credential. The toggle must reach CPA itself, and CPA's own
// mechanism is the excluded-all marker in excluded-models.
func TestProviderStatusToggleReachesCPA(t *testing.T) {
	client, baseURL, state := startProviderTestServer(t)

	patch := func(body string) *http.Response {
		resp, payload := doJSON(t, client, http.MethodPatch, baseURL+"/omc/api/v1/management/providers/status", body)
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("patch status = %d body %s", resp.StatusCode, payload)
		}
		return resp
	}
	providerByID := func(id string) *ProviderItemDTO {
		resp, payload := getJSON(t, client, baseURL+"/omc/api/v1/management/providers")
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("providers status = %d body %s", resp.StatusCode, payload)
		}
		var res struct {
			Providers []ProviderItemDTO `json:"providers"`
		}
		if err := json.Unmarshal(payload, &res); err != nil {
			t.Fatal(err)
		}
		for i := range res.Providers {
			if res.Providers[i].ID == id {
				return &res.Providers[i]
			}
		}
		return nil
	}

	// The codex family is the reported case: DeepSeek official sits behind it,
	// and a request that failed on another provider used to fall back into it.
	patch(`{"family":"codex","index":0,"disabled":true}`)
	state.mu.Lock()
	codexExcluded := state.codexProviders[0]["excluded-models"]
	state.mu.Unlock()
	if codexExcluded == nil || !strings.Contains(fmt.Sprintf("%v", codexExcluded), "*") {
		t.Fatalf("codex disable must reach CPA excluded-models, got %#v", codexExcluded)
	}
	if provider := providerByID("codex-0"); provider == nil || !provider.Disabled {
		t.Fatalf("codex-0 must be reported disabled, got %#v", provider)
	}

	// Operator-defined exclusions must survive the toggle untouched.
	state.mu.Lock()
	state.codexProviders[0]["excluded-models"] = []any{"custom-model-*", "*"}
	state.mu.Unlock()
	patch(`{"family":"codex","index":0,"disabled":false}`)
	state.mu.Lock()
	codexAfterEnable := state.codexProviders[0]["excluded-models"]
	state.mu.Unlock()
	if fmt.Sprintf("%v", codexAfterEnable) != "[custom-model-*]" {
		t.Fatalf("enable must drop only the marker, got %#v", codexAfterEnable)
	}
	if provider := providerByID("codex-0"); provider == nil || provider.Disabled {
		t.Fatalf("codex-0 must be enabled again, got %#v", provider)
	}

	// Same contract for claude and gemini.
	patch(`{"family":"claude","index":0,"disabled":true}`)
	state.mu.Lock()
	claudeExcluded := state.claudeProviders[0]["excluded-models"]
	state.mu.Unlock()
	if claudeExcluded == nil || !strings.Contains(fmt.Sprintf("%v", claudeExcluded), "*") {
		t.Fatalf("claude disable must reach CPA excluded-models, got %#v", claudeExcluded)
	}
	patch(`{"family":"gemini","index":0,"disabled":true}`)
	state.mu.Lock()
	geminiExcluded := state.geminiProviders[0]["excluded-models"]
	state.mu.Unlock()
	if geminiExcluded == nil || !strings.Contains(fmt.Sprintf("%v", geminiExcluded), "*") {
		t.Fatalf("gemini disable must reach CPA excluded-models, got %#v", geminiExcluded)
	}
}

// Meta Muse is managed through the same credential-list family as claude,
// codex and gemini. It is covered end to end here because it is the family
// added last, and because a family that is only partly wired (say, create but
// not delete) reads as a silent gap on the page rather than a loud failure.
func TestManagementMetaProviderFamily(t *testing.T) {
	client, baseURL, state := startProviderTestServer(t)

	providersByID := func(query string) map[string]ProviderItemDTO {
		resp, payload := getJSON(t, client, baseURL+"/omc/api/v1/management/providers"+query)
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("providers status = %d body %s", resp.StatusCode, payload)
		}
		var res struct {
			Providers []ProviderItemDTO `json:"providers"`
		}
		if err := json.Unmarshal(payload, &res); err != nil {
			t.Fatal(err)
		}
		byID := make(map[string]ProviderItemDTO, len(res.Providers))
		for _, provider := range res.Providers {
			byID[provider.ID] = provider
		}
		return byID
	}

	// 1. The fixture's credential is listed with its family and protocol.
	meta, ok := providersByID("?include_keys=true")["meta-0"]
	if !ok {
		t.Fatal("meta-0 is missing from the provider list")
	}
	if meta.Family != "meta" || meta.Protocol != "Meta Muse" || meta.Name != "Meta Muse" {
		t.Fatalf("unexpected meta row: %#v", meta)
	}
	if meta.APIKey != "meta-test-token-1234" || meta.AuthIndex != "meta-1" {
		t.Fatalf("meta row lost its credential: %#v", meta)
	}

	// 2. The sanitized projection keeps the configured signal and drops the key.
	sanitized := providersByID("")["meta-0"]
	if sanitized.APIKey != "" || len(sanitized.KeyEntries) != 0 {
		t.Fatalf("sanitized projection leaked meta key material: %#v", sanitized)
	}
	if !sanitized.KeyConfigured {
		t.Fatal("sanitized projection must still report that a key is configured")
	}

	// 3. Create appends to CPA's list under the meta family.
	create := `{"family":"meta","name":"Meta Muse Team","base_url":"https://api.meta.ai/v1","keys":[{"api_key":"meta-created-key-4321"}],"prefix":"team"}`
	resp, payload := doJSON(t, client, http.MethodPost, baseURL+"/omc/api/v1/management/providers", create)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("create meta provider status = %d body %s", resp.StatusCode, payload)
	}
	state.mu.Lock()
	createdCount := len(state.metaProviders)
	state.mu.Unlock()
	if createdCount != 2 {
		t.Fatalf("CPA meta list length = %d, want 2", createdCount)
	}
	created, ok := providersByID("?include_keys=true")["meta-1"]
	if !ok || created.Name != "Meta Muse Team" || created.Prefix != "team" {
		t.Fatalf("created meta provider not readable: %#v", created)
	}

	// 4. A credential CPA stores without an operator name falls back to the
	// family and its configured prefix.
	state.mu.Lock()
	state.metaProviders[0]["prefix"] = "squad-b"
	state.mu.Unlock()
	if renamed := providersByID("")["meta-0"]; renamed.Name != "Meta (squad-b)" {
		t.Fatalf("prefix-derived name = %q, want %q", renamed.Name, "Meta (squad-b)")
	}

	// 5. Update rewrites the entry in place.
	update := `{"family":"meta","name":"Meta Muse East","base_url":"https://api.meta.ai/v1","keys":[{"api_key":"meta-rotated-key-8765"}],"prefix":"east"}`
	resp, payload = doJSON(t, client, http.MethodPut, baseURL+"/omc/api/v1/management/providers/meta-1", update)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("update meta provider status = %d body %s", resp.StatusCode, payload)
	}
	updated := providersByID("?include_keys=true")["meta-1"]
	if updated.Name != "Meta Muse East" || updated.Prefix != "east" || updated.APIKey != "meta-rotated-key-8765" {
		t.Fatalf("meta update did not persist: %#v", updated)
	}

	// 6. The enable toggle reaches CPA as the excluded-all marker, like every
	// other config API-key family.
	resp, payload = doJSON(t, client, http.MethodPatch, baseURL+"/omc/api/v1/management/providers/status", `{"family":"meta","index":0,"disabled":true}`)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("patch meta status = %d body %s", resp.StatusCode, payload)
	}
	state.mu.Lock()
	metaExcluded := state.metaProviders[0]["excluded-models"]
	state.mu.Unlock()
	if metaExcluded == nil || !strings.Contains(fmt.Sprintf("%v", metaExcluded), "*") {
		t.Fatalf("meta disable must reach CPA excluded-models, got %#v", metaExcluded)
	}
	if disabled := providersByID("")["meta-0"]; !disabled.Disabled {
		t.Fatalf("meta-0 must be reported disabled, got %#v", disabled)
	}

	// 7. Delete removes exactly the addressed entry. Ids are positional, so the
	// survivor of a delete occupies the freed index: what must hold is that the
	// deleted credential is gone and the other one is intact.
	resp, payload = doJSON(t, client, http.MethodDelete, baseURL+"/omc/api/v1/management/providers/meta-0", "")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("delete meta provider status = %d body %s", resp.StatusCode, payload)
	}
	state.mu.Lock()
	remainingCount := len(state.metaProviders)
	state.mu.Unlock()
	if remainingCount != 1 {
		t.Fatalf("CPA meta list length = %d after delete, want 1", remainingCount)
	}
	remaining := providersByID("?include_keys=true")
	if survivor, present := remaining["meta-0"]; !present || survivor.Name != "Meta Muse East" || survivor.APIKey != "meta-rotated-key-8765" {
		t.Fatalf("delete removed the wrong meta entry: %#v", remaining)
	}
	if _, present := remaining["meta-1"]; present {
		t.Fatalf("delete left the list untouched: %#v", remaining)
	}
}
