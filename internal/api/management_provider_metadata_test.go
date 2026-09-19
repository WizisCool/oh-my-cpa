package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"testing"

	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
)

// The overlay maps must not record an intent the gateway refused.
//
// `provider_names` and `provider_websites` are what this console renders - the
// row, the request list's provider label and the name resolver all read them - so
// an overlay written before the CPA write leaves the console naming a credential
// a way the gateway never accepted, and nothing tells the operator. The website
// half was already written on the success path; this pins that the name half is
// too, and that a refused write moves neither.
func TestProviderUpdateWritesBothOverlaysOnlyAfterTheWrite(t *testing.T) {
	fixture := newProviderTestFixture(t)

	// The config API-key families and openai-compatibility have separate write
	// paths, so both are exercised rather than one standing in for the other. The
	// refusal is an out-of-range position: the index check runs inside the gated
	// read-modify-write, so the request never reaches CPA at all.
	for _, testCase := range []struct {
		family     string
		refusedID  string
		acceptedID string
	}{
		{family: "codex", refusedID: "codex-99", acceptedID: "codex-0"},
		{family: "openai-compatibility", refusedID: "openai-compat-99", acceptedID: "openai-compat-0"},
	} {
		body := func(name, website string) string {
			return fmt.Sprintf(`{"family":%q,"name":%q,"base_url":"https://relay.example.test/v1","website":%q}`,
				testCase.family, name, website)
		}

		resp, payload := doJSON(t, fixture.client, http.MethodPut,
			fixture.baseURL+"/omc/api/v1/management/providers/"+testCase.refusedID,
			body("Ghost Name", "https://ghost.example.test"))
		if resp.StatusCode != http.StatusNotFound {
			t.Fatalf("%s: an out-of-range index must be refused, got %d body %s", testCase.family, resp.StatusCode, payload)
		}
		assertNoProviderOverlay(t, fixture, testCase.family, testCase.refusedID)

		// The same save against a credential that does exist records both overlays,
		// asserted through the list the console renders rather than through storage,
		// so the test fails if either map stops being read back.
		resp, payload = doJSON(t, fixture.client, http.MethodPut,
			fixture.baseURL+"/omc/api/v1/management/providers/"+testCase.acceptedID,
			body("Named Provider", "https://named.example.test"))
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("%s: update status = %d body %s", testCase.family, resp.StatusCode, payload)
		}
		stored := websiteOfProvider(t, fixture.client, fixture.baseURL, testCase.acceptedID)
		if stored.Name != "Named Provider" || stored.Website != "https://named.example.test" {
			t.Fatalf("%s: an accepted write must record both overlays, got name=%q website=%q",
				testCase.family, stored.Name, stored.Website)
		}
	}
}

// assertNoProviderOverlay reads the two preference documents directly, so it can
// tell "this id was never written" from "this write was refused".
func assertNoProviderOverlay(t *testing.T, fixture providerTestFixture, family, id string) {
	t.Helper()
	ctx := context.Background()
	for _, key := range []string{repository.PreferenceProviderNames, repository.PreferenceProviderWebsites} {
		raw, found, err := fixture.handler.repo.GetPreference(ctx, key)
		if err != nil {
			t.Fatalf("%s: read %s: %v", family, key, err)
		}
		stored := map[string]string{}
		if found && raw != "" {
			if err := json.Unmarshal([]byte(raw), &stored); err != nil {
				t.Fatalf("%s: %s is not a string map: %s", family, key, raw)
			}
		}
		if value, present := stored[id]; present {
			t.Fatalf("%s: a refused write recorded %s[%s]=%q; the console would name a provider CPA never accepted",
				family, key, id, value)
		}
	}
}

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
