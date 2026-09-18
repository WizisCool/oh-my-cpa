package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"testing"

	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
)

// A provider's operator metadata is keyed by its position in the family, so a
// delete has to move every later entry's metadata down with it. The icon overlay
// is written by the console through the preferences API rather than by a provider
// save, which is exactly why it is easy to leave out: without it the deleted
// provider's brand mark stays behind on the id and reappears on whichever
// credential inherits that index.
func TestProviderDeleteShiftsEveryPositionalOverlay(t *testing.T) {
	fixture := newProviderTestFixture(t)
	client, baseURL := fixture.client, fixture.baseURL
	ctx := context.Background()

	// Two more codex credentials, so the delete has entries below it to move.
	// The create response names the row it added; without that id a client can
	// only key an override by display name, which the row's own id key shadows.
	for index, name := range []string{"Codex Two", "Codex Three"} {
		body := fmt.Sprintf(`{"family":"codex","name":%q,"base_url":"https://api.openai.com","api_key":"sk-codex-extra"}`, name)
		resp, payload := doJSON(t, client, http.MethodPost, baseURL+"/omc/api/v1/management/providers", body)
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("create codex provider status = %d body %s", resp.StatusCode, payload)
		}
		var created struct {
			ID string `json:"id"`
		}
		if err := json.Unmarshal(payload, &created); err != nil {
			t.Fatalf("create response is not JSON: %s", payload)
		}
		wantID := fmt.Sprintf("codex-%d", index+1)
		if created.ID != wantID {
			t.Fatalf("create response id = %q, want %q (body %s)", created.ID, wantID, payload)
		}
	}

	// One entry per family beyond the one being deleted, so the shift is shown to
	// touch only the deleted entry's own family.
	seeded := map[string]string{
		"codex-0": "Zero",
		"codex-1": "One",
		"codex-2": "Two",
		"meta-0":  "Untouched",
	}
	encoded, err := json.Marshal(seeded)
	if err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{
		repository.PreferenceProviderNames,
		repository.PreferenceProviderWebsites,
		repository.PreferenceProviderIcons,
	} {
		if err := fixture.handler.repo.PutPreference(ctx, key, string(encoded)); err != nil {
			t.Fatalf("seed %s: %v", key, err)
		}
	}

	resp, payload := doJSON(t, client, http.MethodDelete, baseURL+"/omc/api/v1/management/providers/codex-0", "")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("delete codex provider status = %d body %s", resp.StatusCode, payload)
	}

	want := map[string]string{
		"codex-0": "One",
		"codex-1": "Two",
		"meta-0":  "Untouched",
	}
	for _, key := range []string{
		repository.PreferenceProviderNames,
		repository.PreferenceProviderWebsites,
		repository.PreferenceProviderIcons,
	} {
		raw, found, err := fixture.handler.repo.GetPreference(ctx, key)
		if err != nil || !found {
			t.Fatalf("%s not persisted: found=%v err=%v", key, found, err)
		}
		var stored map[string]string
		if err := json.Unmarshal([]byte(raw), &stored); err != nil {
			t.Fatalf("%s is not a string map: %s", key, raw)
		}
		if len(stored) != len(want) {
			t.Fatalf("%s = %v after delete, want exactly %v", key, stored, want)
		}
		for id, value := range want {
			if stored[id] != value {
				t.Fatalf("%s[%s] = %q after delete, want %q (whole map %v)", key, id, stored[id], value, stored)
			}
		}
	}
}
