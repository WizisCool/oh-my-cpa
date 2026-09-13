package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"testing"
)

// websiteOfProvider reads one provider's website out of the sanitized list the
// console actually renders.
func websiteOfProvider(t *testing.T, client *http.Client, baseURL, id string) ProviderItemDTO {
	t.Helper()
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
	for _, provider := range res.Providers {
		if provider.ID == id {
			return provider
		}
	}
	t.Fatalf("provider %s not found in list", id)
	return ProviderItemDTO{}
}

// The website is Oh My CPA management metadata, not a CPA configuration field.
// It must round trip through the provider document, survive a save that does not
// mention it, and never reach CPA's own config.
func TestProviderWebsiteRoundTrip(t *testing.T) {
	client, baseURL, state := startProviderTestServer(t)

	createBody := `{"family":"openai-compatibility","name":"Relay With Site","base_url":"https://relay.example.test/v1","api_key":"sk-website-1234","website":"https://relay.example.test"}`
	resp, payload := doJSON(t, client, http.MethodPost, baseURL+"/omc/api/v1/management/providers", createBody)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("create status = %d body %s", resp.StatusCode, payload)
	}
	createdID := fmt.Sprintf("openai-compat-%d", len(state.oaiProviders)-1)

	if got := websiteOfProvider(t, client, baseURL, createdID).Website; got != "https://relay.example.test" {
		t.Fatalf("create must persist the website, got %q", got)
	}

	// A rename from a client that does not carry the field must not erase it:
	// the field is optional, and absent is not the same statement as empty.
	renameBody := `{"family":"openai-compatibility","name":"Relay Renamed","base_url":"https://relay.example.test/v1"}`
	resp, payload = doJSON(t, client, http.MethodPut, baseURL+"/omc/api/v1/management/providers/"+createdID, renameBody)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("rename status = %d body %s", resp.StatusCode, payload)
	}
	if got := websiteOfProvider(t, client, baseURL, createdID).Website; got != "https://relay.example.test" {
		t.Fatalf("a save without the field must keep the stored website, got %q", got)
	}

	// An explicitly empty value clears it.
	clearBody := `{"family":"openai-compatibility","name":"Relay Renamed","base_url":"https://relay.example.test/v1","website":""}`
	resp, payload = doJSON(t, client, http.MethodPut, baseURL+"/omc/api/v1/management/providers/"+createdID, clearBody)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("clear status = %d body %s", resp.StatusCode, payload)
	}
	if got := websiteOfProvider(t, client, baseURL, createdID).Website; got != "" {
		t.Fatalf("an explicit empty website must clear the entry, got %q", got)
	}

	// The website lives in Oh My CPA's own storage, never in CPA's config: a
	// `website` key appearing on the CPA entry would mean the field had been
	// smuggled into the gateway's document, which CPA cannot read back.
	state.mu.Lock()
	stored := state.oaiProviders[len(state.oaiProviders)-1]
	state.mu.Unlock()
	if _, present := stored["website"]; present {
		t.Fatalf("website must not be written into CPA's provider config: %#v", stored)
	}
}

// Only a URL this console may render as a link is accepted. A scheme that can
// execute script with the session's authority must be refused outright rather
// than quietly repaired into something else.
func TestProviderWebsiteRejectsUnsafeURLs(t *testing.T) {
	client, baseURL, _ := startProviderTestServer(t)

	for _, unsafe := range []string{
		"javascript:alert(1)",
		"JavaScript:alert(1)",
		"data:text/html,<script>alert(1)</script>",
		"file:///etc/passwd",
		"//relay.example.test",
		"/relative/path",
		"relay.example.test",
		"ftp://relay.example.test",
	} {
		body := fmt.Sprintf(`{"family":"openai-compatibility","name":"Unsafe %s","base_url":"https://relay.example.test/v1","website":%q}`, unsafe, unsafe)
		resp, payload := doJSON(t, client, http.MethodPost, baseURL+"/omc/api/v1/management/providers", body)
		if resp.StatusCode != http.StatusBadRequest {
			t.Fatalf("website %q must be refused, got status %d body %s", unsafe, resp.StatusCode, payload)
		}
	}
}

// A safe URL is accepted in either scheme, and trailing whitespace is trimmed
// rather than stored into the href.
func TestProviderWebsiteAcceptsHTTPAndHTTPS(t *testing.T) {
	client, baseURL, _ := startProviderTestServer(t)

	for _, valid := range []string{
		"http://relay.example.test",
		"https://relay.example.test/path?q=1",
		"  https://relay.example.test  ",
	} {
		body := fmt.Sprintf(`{"family":"openai-compatibility","name":"Safe","base_url":"https://relay.example.test/v1","website":%q}`, valid)
		resp, payload := doJSON(t, client, http.MethodPost, baseURL+"/omc/api/v1/management/providers", body)
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("website %q must be accepted, got status %d body %s", valid, resp.StatusCode, payload)
		}
	}
}

// Deleting a provider must not leave its website behind under the id a later
// provider will reuse: positional ids shift, so a stale entry would attach one
// provider's homepage to another.
func TestProviderWebsiteRemovedWithProvider(t *testing.T) {
	client, baseURL, state := startProviderTestServer(t)

	createBody := `{"family":"openai-compatibility","name":"Doomed","base_url":"https://doomed.example.test/v1","website":"https://doomed.example.test"}`
	resp, payload := doJSON(t, client, http.MethodPost, baseURL+"/omc/api/v1/management/providers", createBody)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("create status = %d body %s", resp.StatusCode, payload)
	}
	id := fmt.Sprintf("openai-compat-%d", len(state.oaiProviders)-1)

	resp, payload = doJSON(t, client, http.MethodDelete, baseURL+"/omc/api/v1/management/providers/"+id, "")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("delete status = %d body %s", resp.StatusCode, payload)
	}

	resp, payload = getJSON(t, client, baseURL+"/omc/api/v1/management/providers")
	var res struct {
		Providers []ProviderItemDTO `json:"providers"`
	}
	if err := json.Unmarshal(payload, &res); err != nil {
		t.Fatal(err)
	}
	for _, provider := range res.Providers {
		if provider.Website == "https://doomed.example.test" {
			t.Fatalf("deleted provider's website survived under id %s", provider.ID)
		}
	}
}

// The provider_websites preference is part of the closed preference key set, so
// the console can persist it through the ordinary endpoint.
func TestProviderWebsitePreferenceKeyIsWritable(t *testing.T) {
	client, baseURL, _ := startProviderTestServer(t)

	resp, payload := doJSON(t, client, http.MethodPut, baseURL+"/omc/api/v1/preferences/provider_websites", `{"openai-compat-0":"https://relay.example.test"}`)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("writing provider_websites preference status = %d body %s", resp.StatusCode, payload)
	}

	resp, payload = getJSON(t, client, baseURL+"/omc/api/v1/preferences")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("read preferences status = %d body %s", resp.StatusCode, payload)
	}
	var res struct {
		Preferences map[string]json.RawMessage `json:"preferences"`
	}
	if err := json.Unmarshal(payload, &res); err != nil {
		t.Fatal(err)
	}
	if _, present := res.Preferences["provider_websites"]; !present {
		t.Fatalf("provider_websites must be readable back through the preferences API: %s", payload)
	}
}
