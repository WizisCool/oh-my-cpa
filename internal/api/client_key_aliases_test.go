package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"testing"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
	"github.com/oh-my-cpa/oh-my-cpa/internal/security"
	"github.com/oh-my-cpa/oh-my-cpa/internal/usage"
)

// aliasFor reads one key's alias out of the sanitized key list the console
// actually renders.
func aliasFor(t *testing.T, client *http.Client, baseURL, rawKey string) ClientAPIKeyItemDTO {
	t.Helper()
	resp, payload := getJSON(t, client, baseURL+"/omc/api/v1/management/api-keys")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("api-keys status = %d body %s", resp.StatusCode, payload)
	}
	var res struct {
		Keys []ClientAPIKeyItemDTO `json:"keys"`
	}
	if err := json.Unmarshal(payload, &res); err != nil {
		t.Fatal(err)
	}
	for _, item := range res.Keys {
		if item.Key == rawKey {
			return item
		}
	}
	t.Fatalf("key %q not found in list", rawKey)
	return ClientAPIKeyItemDTO{}
}

// The key list must expose the identity a request record actually carries, and
// it must differ from the legacy page fingerprint. Without both facts an alias
// cannot be attached to anything.
func TestClientKeyListExposesUsageIdentity(t *testing.T) {
	client, baseURL, _ := startProviderTestServer(t)

	item := aliasFor(t, client, baseURL, "sk-original-key-1")
	if item.UsageFingerprint == "" {
		t.Fatalf("usage fingerprint is missing: %+v", item)
	}
	if item.Fingerprint == "" {
		t.Fatalf("legacy fingerprint is missing: %+v", item)
	}
	// The two purposes must not collide; if they did, this test could not tell
	// whether the join is real.
	if item.UsageFingerprint == item.Fingerprint {
		t.Fatalf("usage and legacy fingerprints are identical (%q); the purposes must stay distinct", item.Fingerprint)
	}
	if item.Alias != "" || item.AliasVersion != 0 {
		t.Fatalf("a fresh key must start unnamed: %+v", item)
	}
}

// An alias is Oh My CPA metadata. Naming a key must not write CPA's
// configuration document, which would rotate the revision for every other editor
// and rewrite a secret the operator never touched.
func TestClientKeyAliasDoesNotTouchCPAConfig(t *testing.T) {
	client, baseURL, state := startProviderTestServer(t)

	item := aliasFor(t, client, baseURL, "sk-original-key-1")
	body := fmt.Sprintf(`{"key_fingerprint":%q,"alias":"Production CI","version":0}`, item.UsageFingerprint)
	resp, payload := doJSON(t, client, http.MethodPut, baseURL+"/omc/api/v1/management/client-key-aliases", body)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("set alias status = %d body %s", resp.StatusCode, payload)
	}

	state.mu.Lock()
	keys := append([]string{}, state.clientKeys...)
	state.mu.Unlock()
	if len(keys) != 2 || keys[0] != "sk-original-key-1" || keys[1] != "sk-original-key-2" {
		t.Fatalf("naming a key rewrote CPA's api-keys list: %v", keys)
	}

	// And the name is readable back through the list the console renders.
	updated := aliasFor(t, client, baseURL, "sk-original-key-1")
	if updated.Alias != "Production CI" || updated.AliasVersion != 1 {
		t.Fatalf("alias did not round trip: %+v", updated)
	}
}

// A write prepared against a stale read must be refused so two sessions cannot
// silently overwrite each other.
func TestClientKeyAliasRejectsStaleVersionOverHTTP(t *testing.T) {
	client, baseURL, _ := startProviderTestServer(t)
	item := aliasFor(t, client, baseURL, "sk-original-key-1")

	body := fmt.Sprintf(`{"key_fingerprint":%q,"alias":"First","version":0}`, item.UsageFingerprint)
	if resp, payload := doJSON(t, client, http.MethodPut, baseURL+"/omc/api/v1/management/client-key-aliases", body); resp.StatusCode != http.StatusOK {
		t.Fatalf("first write status = %d body %s", resp.StatusCode, payload)
	}

	// Still citing version 0 while version 1 exists.
	stale := fmt.Sprintf(`{"key_fingerprint":%q,"alias":"Racing","version":0}`, item.UsageFingerprint)
	resp, payload := doJSON(t, client, http.MethodPut, baseURL+"/omc/api/v1/management/client-key-aliases", stale)
	if resp.StatusCode != http.StatusConflict {
		t.Fatalf("stale write status = %d, want 409: %s", resp.StatusCode, payload)
	}
	var conflict struct {
		Code string `json:"code"`
	}
	if err := json.Unmarshal(payload, &conflict); err != nil {
		t.Fatal(err)
	}
	if conflict.Code != "alias_version_conflict" {
		t.Fatalf("conflict code = %q, want alias_version_conflict", conflict.Code)
	}
	// The stored name must be unchanged by the refused write.
	if got := aliasFor(t, client, baseURL, "sk-original-key-1").Alias; got != "First" {
		t.Fatalf("a refused write changed the alias to %q", got)
	}
}

// A rejected alias must not leave an audit record for a write that never
// happened, and must not reach storage.
func TestClientKeyAliasRejectsInvalidInput(t *testing.T) {
	client, baseURL, _ := startProviderTestServer(t)
	item := aliasFor(t, client, baseURL, "sk-original-key-1")

	for _, invalid := range []string{"line\nbreak", "\u202Eoverride"} {
		body := fmt.Sprintf(`{"key_fingerprint":%q,"alias":%q,"version":0}`, item.UsageFingerprint, invalid)
		resp, payload := doJSON(t, client, http.MethodPut, baseURL+"/omc/api/v1/management/client-key-aliases", body)
		if resp.StatusCode != http.StatusBadRequest {
			t.Fatalf("alias %q status = %d, want 400: %s", invalid, resp.StatusCode, payload)
		}
	}
	// Missing identity is refused too, rather than stored under an empty key.
	resp, _ := doJSON(t, client, http.MethodPut, baseURL+"/omc/api/v1/management/client-key-aliases", `{"alias":"No identity","version":0}`)
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("missing fingerprint status = %d, want 400", resp.StatusCode)
	}
	if got := aliasFor(t, client, baseURL, "sk-original-key-1").Alias; got != "" {
		t.Fatalf("an invalid write stored an alias: %q", got)
	}
}

// Clearing returns the key to an unnamed state, which the console renders as the
// mask rather than an empty cell.
func TestClientKeyAliasClearRestoresUnnamed(t *testing.T) {
	client, baseURL, _ := startProviderTestServer(t)
	item := aliasFor(t, client, baseURL, "sk-original-key-1")

	body := fmt.Sprintf(`{"key_fingerprint":%q,"alias":"Temporary","version":0}`, item.UsageFingerprint)
	if resp, payload := doJSON(t, client, http.MethodPut, baseURL+"/omc/api/v1/management/client-key-aliases", body); resp.StatusCode != http.StatusOK {
		t.Fatalf("set status = %d body %s", resp.StatusCode, payload)
	}
	clear := fmt.Sprintf(`{"key_fingerprint":%q,"alias":"","version":1}`, item.UsageFingerprint)
	if resp, payload := doJSON(t, client, http.MethodPut, baseURL+"/omc/api/v1/management/client-key-aliases", clear); resp.StatusCode != http.StatusOK {
		t.Fatalf("clear status = %d body %s", resp.StatusCode, payload)
	}
	if got := aliasFor(t, client, baseURL, "sk-original-key-1"); got.Alias != "" || got.AliasVersion != 0 {
		t.Fatalf("clear did not restore the unnamed state: %+v", got)
	}
}

// The request list must print the name for the key that served each record, while
// the filter identity stays the fingerprint so a rename cannot change what a
// saved filter or a drill-down link selects.
func TestUsageEventsCarryResolvedAlias(t *testing.T) {
	client, baseURL, repo := startDashboardTestServer(t, nil)
	now := time.Now().UTC()

	const rawKey = "sk-request-alias-key"
	fingerprint, err := repo.UsageClientKeyFingerprint(rawKey)
	if err != nil {
		t.Fatal(err)
	}
	event := eventFor("alias-evt", now.Add(-time.Minute), usage.TokenStats{TotalTokens: 4}, false)
	event.APIGroupKey = fingerprint
	event.APIGroupLabel = "api_key"
	event.APIKeyMask = security.MaskSecret(rawKey)
	seedEvents(t, repo, now, []repository.UsageDecoded{{Event: event}})

	if _, err := repo.SetClientKeyAlias(t.Context(), "default", fingerprint, "Production CI", 0); err != nil {
		t.Fatal(err)
	}

	resp, payload := getJSON(t, client, baseURL+"/omc/api/v1/usage/events?preset=24h")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("list status = %d body %s", resp.StatusCode, payload)
	}
	var page struct {
		Items []usageEventResponse `json:"items"`
	}
	if err := json.Unmarshal(payload, &page); err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != 1 {
		t.Fatalf("items = %d, want 1", len(page.Items))
	}
	if page.Items[0].APIKeyAlias != "Production CI" {
		t.Fatalf("api_key_alias = %q, want the resolved name", page.Items[0].APIKeyAlias)
	}
	// The identity the filter uses must be untouched by the rename.
	if page.Items[0].APIGroupKey != fingerprint {
		t.Fatalf("api_group_key = %q, want the unchanged fingerprint", page.Items[0].APIGroupKey)
	}
	// The mask is retained as fallback metadata for anything that does not resolve.
	if page.Items[0].APIKeyMask == "" {
		t.Fatal("api_key_mask must be retained as the fallback label")
	}

	// The caller-key facet offers the same name, so the dropdown and the rows it
	// filters cannot disagree.
	facetResp, facetPayload := getJSON(t, client, baseURL+"/omc/api/v1/usage/facets?preset=24h")
	if facetResp.StatusCode != http.StatusOK {
		t.Fatalf("facets status = %d body %s", facetResp.StatusCode, facetPayload)
	}
	var facets struct {
		Facets struct {
			APIGroupKey []repository.UsageFacetValue `json:"api_group_keys"`
		} `json:"facets"`
	}
	if err := json.Unmarshal(facetPayload, &facets); err != nil {
		t.Fatal(err)
	}
	if len(facets.Facets.APIGroupKey) != 1 {
		t.Fatalf("caller-key facet = %+v, want one option", facets.Facets.APIGroupKey)
	}
	option := facets.Facets.APIGroupKey[0]
	if option.Alias != "Production CI" {
		t.Fatalf("facet alias = %q, want the resolved name", option.Alias)
	}
	if option.Value != fingerprint {
		t.Fatalf("facet value = %q, want the unchanged fingerprint", option.Value)
	}
}

// An unnamed key keeps the mask, which is the backward-compatible behaviour the
// console falls back to.
func TestUsageEventsFallBackToMaskWithoutAlias(t *testing.T) {
	client, baseURL, repo := startDashboardTestServer(t, nil)
	now := time.Now().UTC()

	fingerprint, err := repo.UsageClientKeyFingerprint("sk-unnamed-request-key")
	if err != nil {
		t.Fatal(err)
	}
	event := eventFor("unnamed-evt", now.Add(-time.Minute), usage.TokenStats{TotalTokens: 4}, false)
	event.APIGroupKey = fingerprint
	event.APIGroupLabel = "api_key"
	event.APIKeyMask = "sk-unna••••••••••key"
	seedEvents(t, repo, now, []repository.UsageDecoded{{Event: event}})

	_, payload := getJSON(t, client, baseURL+"/omc/api/v1/usage/events?preset=24h")
	var page struct {
		Items []usageEventResponse `json:"items"`
	}
	if err := json.Unmarshal(payload, &page); err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != 1 {
		t.Fatalf("items = %d, want 1", len(page.Items))
	}
	if page.Items[0].APIKeyAlias != "" {
		t.Fatalf("an unnamed key must not carry an alias: %q", page.Items[0].APIKeyAlias)
	}
	if page.Items[0].APIKeyMask != "sk-unna••••••••••key" {
		t.Fatalf("mask = %q, want the stored fallback", page.Items[0].APIKeyMask)
	}
}

// A provider-attributed record is not a client key, so it must never pick up an
// alias even when an alias exists for the very same stored value.
func TestUsageEventsDoNotAliasNonKeyCallers(t *testing.T) {
	client, baseURL, repo := startDashboardTestServer(t, nil)
	now := time.Now().UTC()

	// A real key's alias is stored, and the provider record is made to carry that
	// exact fingerprint as its group key. The category, not missing data, is what
	// must keep the label off the row.
	fingerprint, err := repo.UsageClientKeyFingerprint("sk-non-key-caller-probe")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := repo.SetClientKeyAlias(t.Context(), "default", fingerprint, "Should not appear", 0); err != nil {
		t.Fatal(err)
	}

	event := eventFor("provider-evt", now.Add(-time.Minute), usage.TokenStats{TotalTokens: 4}, false)
	event.APIGroupKey = fingerprint
	event.APIGroupLabel = "provider"
	seedEvents(t, repo, now, []repository.UsageDecoded{{Event: event}})

	_, payload := getJSON(t, client, baseURL+"/omc/api/v1/usage/events?preset=24h")
	var page struct {
		Items []usageEventResponse `json:"items"`
	}
	if err := json.Unmarshal(payload, &page); err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != 1 {
		t.Fatalf("items = %d, want 1", len(page.Items))
	}
	if page.Items[0].APIKeyAlias != "" {
		t.Fatalf("a provider record picked up a key alias: %q", page.Items[0].APIKeyAlias)
	}
}

// Per-key usage describes only the records that key served, in the requested
// window, so the management table cannot overstate traffic.
func TestClientKeyUsageEndpointScopesToKeyCallers(t *testing.T) {
	client, baseURL, repo := startDashboardTestServer(t, nil)
	now := time.Now().UTC()

	fingerprint, err := repo.UsageClientKeyFingerprint("sk-usage-endpoint-key")
	if err != nil {
		t.Fatal(err)
	}
	keyed := eventFor("usage-keyed", now.Add(-2*time.Minute), usage.TokenStats{TotalTokens: 7}, false)
	keyed.APIGroupKey = fingerprint
	keyed.APIGroupLabel = "api_key"
	byProvider := eventFor("usage-provider", now.Add(-time.Minute), usage.TokenStats{TotalTokens: 999}, false)
	byProvider.APIGroupKey = "unrelated-provider"
	byProvider.APIGroupLabel = "provider"
	seedEvents(t, repo, now, []repository.UsageDecoded{{Event: keyed}, {Event: byProvider}})

	resp, payload := getJSON(t, client, baseURL+"/omc/api/v1/management/client-key-usage?preset=24h")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("usage status = %d body %s", resp.StatusCode, payload)
	}
	var res struct {
		Usage []repository.ClientKeyUsage `json:"usage"`
	}
	if err := json.Unmarshal(payload, &res); err != nil {
		t.Fatal(err)
	}
	if len(res.Usage) != 1 {
		t.Fatalf("usage rows = %+v, want only the key-attributed record", res.Usage)
	}
	if res.Usage[0].KeyFingerprint != fingerprint || res.Usage[0].Requests != 1 || res.Usage[0].TotalTokens != 7 {
		t.Fatalf("usage = %+v, want one request and 7 tokens against the key", res.Usage[0])
	}

	// A malformed window is refused rather than silently ignored, which would
	// report an empty result as if it were the truth.
	badResp, _ := getJSON(t, client, baseURL+"/omc/api/v1/management/client-key-usage?preset=nonsense")
	if badResp.StatusCode != http.StatusBadRequest {
		t.Fatalf("bad preset status = %d, want 400", badResp.StatusCode)
	}
}
