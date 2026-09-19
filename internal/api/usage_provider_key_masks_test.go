package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
	"github.com/oh-my-cpa/oh-my-cpa/internal/usage"
)

/**
 * Secret values used by this file's fixture.
 *
 * They are synthetic and deliberately distinctive: the assertions below require
 * that none of them reaches a response body, so a fixture that reused a plausible
 * string could pass while leaking something real. `assertNoProviderSecrets` checks
 * the raw response text rather than the decoded field, because a leak into any
 * other field is the failure this is guarding against.
 */
const (
	testProviderKeyA = "test-provider-key-aaaaaaaaaaaa-alpha"
	testProviderKeyB = "test-provider-key-bbbbbbbbbbbb-bravo"
	testProviderKeyC = "test-provider-key-cccccccccccc-charlie"
)

// providerKeyMaskFixture answers CPA's credential lists with a provider that has
// two keys, a renamed compatibility provider, a config family, an OAuth-only
// family and an index two entries claim.
func providerKeyMaskFixture(t *testing.T, reads *atomic.Int64, delay time.Duration) http.HandlerFunc {
	t.Helper()
	return func(writer http.ResponseWriter, request *http.Request) {
		if reads != nil {
			reads.Add(1)
		}
		if delay > 0 {
			time.Sleep(delay)
		}
		writer.Header().Set("Content-Type", "application/json")
		switch request.URL.Path {
		case "/v0/management/openai-compatibility":
			_, _ = writer.Write([]byte(`{
				"openai-compatibility": [
					{
						"name": "Renamed Relay",
						"base-url": "https://relay.example.test/v1",
						"api-key-entries": [
							{"api-key": "` + testProviderKeyA + `", "auth-index": "idx-pair-a"},
							{"api-key": "` + testProviderKeyB + `", "auth-index": "idx-pair-b"}
						]
					},
					{
						"name": "Twice Claimed",
						"base-url": "https://twice.example.test/v1",
						"api-key-entries": [
							{"api-key": "` + testProviderKeyA + `", "auth-index": "idx-clash"},
							{"api-key": "` + testProviderKeyB + `", "auth-index": "idx-clash"}
						]
					},
					{
						"name": "Legacy Relay",
						"base-url": "https://legacy.example.test/v1",
						"api-keys": ["` + testProviderKeyC + `"]
					}
				]
			}`))
		case "/v0/management/claude-api-key":
			_, _ = writer.Write([]byte(`{"claude-api-key": [{"api-key": "` + testProviderKeyC + `", "auth-index": "idx-claude"}]}`))
		default:
			_, _ = writer.Write([]byte(`{}`))
		}
	}
}

// seedProviderKeyMaskEvents stores one record per credential shape the resolver
// has to tell apart.
func seedProviderKeyMaskEvents(t *testing.T, repo *repository.Repository) {
	t.Helper()
	now := time.Now().UnixMilli()
	specs := []usage.Event{
		// Two keys under one provider: the pair must resolve to different masks.
		{InstanceID: "default", EventKey: "evt-relay-a", Provider: "openai-compatible-renamed relay", AuthType: "apikey", AuthIndex: "idx-pair-a", Model: "m", TimestampMS: now},
		{InstanceID: "default", EventKey: "evt-relay-b", Provider: "openai-compatible-renamed relay", AuthType: "apikey", AuthIndex: "idx-pair-b", Model: "m", TimestampMS: now - 1},
		// The same index under the provider's previous name: the console's labels
		// for a compatibility provider used to be the family, and renaming it in CPA
		// must not orphan the requests recorded before the rename.
		{InstanceID: "default", EventKey: "evt-relay-old-name", Provider: "openai-compatible-relay", AuthType: "apikey", AuthIndex: "idx-pair-a", Model: "m", TimestampMS: now - 2},
		// A config family's index, resolvable through its own list only.
		{InstanceID: "default", EventKey: "evt-claude", Provider: "claude", AuthType: "apikey", AuthIndex: "idx-claude", Model: "m", TimestampMS: now - 3},
		// A config family's index that no entry claims, and one a compatibility list
		// does claim: neither may borrow the other list's answer.
		{InstanceID: "default", EventKey: "evt-deleted", Provider: "claude", AuthType: "apikey", AuthIndex: "idx-pair-a", Model: "m", TimestampMS: now - 4},
		// An index two entries claim, with masks that are hard to tell apart.
		{InstanceID: "default", EventKey: "evt-clash", Provider: "openai-compatible-twice claimed", AuthType: "apikey", AuthIndex: "idx-clash", Model: "m", TimestampMS: now - 5},
		// A compatibility key CPA reports with no index at all.
		{InstanceID: "default", EventKey: "evt-legacy", Provider: "openai-compatible-legacy relay", AuthType: "apikey", AuthIndex: "idx-legacy-unknown", Model: "m", TimestampMS: now - 6},
		// An OAuth credential: its auth file index is not a provider key index.
		{InstanceID: "default", EventKey: "evt-oauth", Provider: "codex", AuthType: "oauth", AuthIndex: "idx-claude", Model: "m", TimestampMS: now - 7},
		// No auth index at all.
		{InstanceID: "default", EventKey: "evt-no-index", Provider: "openai-compatible-renamed relay", AuthType: "apikey", AuthIndex: "", Model: "m", TimestampMS: now - 8},
	}
	events := make([]usage.Event, 0, len(specs))
	for _, spec := range specs {
		// A realistic caller key: the two masks on one record must stay distinct.
		spec.APIGroupKey = "hmac:caller:" + spec.EventKey
		spec.APIGroupLabel = "api_key"
		spec.APIKeyMask = "sk-caller••••••••er"
		events = append(events, spec)
	}
	if _, err := repo.InsertUsageEvents(context.Background(), events); err != nil {
		t.Fatal(err)
	}
}

// providerKeyMaskIDsByEventKey reads the seeded ids back from the list response,
// which is the same view the detail requests are compared against.
func providerKeyMaskIDsByEventKey(t *testing.T, page providerKeyMaskPage) map[string]int64 {
	t.Helper()
	ids := make(map[string]int64, len(page.Items))
	for _, item := range page.Items {
		ids[item.EventKey] = item.ID
	}
	return ids
}

type providerKeyMaskPage struct {
	Items []struct {
		ID              int64  `json:"id"`
		EventKey        string `json:"event_key"`
		APIKeyMask      string `json:"api_key_mask"`
		ProviderKeyMask string `json:"provider_key_mask"`
	} `json:"items"`
}

func fetchProviderKeyMaskPage(t *testing.T, client *http.Client, baseURL string) providerKeyMaskPage {
	t.Helper()
	response, payload := getJSON(t, client, baseURL+"/omc/api/v1/usage/events?limit=50")
	if response.StatusCode != http.StatusOK {
		t.Fatalf("usage events status = %d, body = %s", response.StatusCode, payload)
	}
	var page providerKeyMaskPage
	if err := json.Unmarshal(payload, &page); err != nil {
		t.Fatal(err)
	}
	return page
}

// assertNoProviderSecrets fails if any fixture credential appears in the body.
//
// It reads the raw text rather than the decoded field on purpose: the failure it
// guards against is a key reaching the browser through any field, any tooltip in
// the payload, or any future addition to this response.
func assertNoProviderSecrets(t *testing.T, label, body string) {
	t.Helper()
	for _, secret := range []string{testProviderKeyA, testProviderKeyB, testProviderKeyC} {
		if strings.Contains(body, secret) {
			t.Fatalf("%s exposed a provider key in the response body: %s", label, body)
		}
	}
}

func TestUsageEventsResolveProviderKeyMask(t *testing.T) {
	reads := &atomic.Int64{}
	client, baseURL, repo := startDashboardTestServer(t, providerKeyMaskFixture(t, reads, 0))
	seedProviderKeyMaskEvents(t, repo)

	response, payload := getJSON(t, client, baseURL+"/omc/api/v1/usage/events?limit=50")
	if response.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, body = %s", response.StatusCode, payload)
	}
	assertNoProviderSecrets(t, "usage event list", string(payload))

	var page providerKeyMaskPage
	if err := json.Unmarshal(payload, &page); err != nil {
		t.Fatal(err)
	}
	masks := make(map[string]string, len(page.Items))
	for _, item := range page.Items {
		masks[item.EventKey] = item.ProviderKeyMask
	}

	// Two keys under one provider resolve to two different masks, and each is the
	// mask of the key that actually claims its index.
	if masks["evt-relay-a"] == masks["evt-relay-b"] {
		t.Fatalf("the two keys of one provider resolved to the same mask %q", masks["evt-relay-a"])
	}
	if masks["evt-relay-a"] == "" || !strings.Contains(masks["evt-relay-a"], "••••") {
		t.Fatalf("expected a mask for evt-relay-a, got %q", masks["evt-relay-a"])
	}
	// The same index recorded under the provider's previous name still resolves: a
	// rename in CPA does not orphan the requests it already served.
	if masks["evt-relay-old-name"] != masks["evt-relay-a"] {
		t.Fatalf("a compatibility provider's earlier name orphaned its index: %q vs %q",
			masks["evt-relay-old-name"], masks["evt-relay-a"])
	}
	// A config family resolves through its own list.
	if masks["evt-claude"] == "" {
		t.Fatalf("expected the claude credential's mask, got none")
	}
	// An index claimed twice is not an identity, even though both masks look alike.
	if masks["evt-clash"] != "" {
		t.Fatalf("an index two credentials claim must resolve to nothing, got %q", masks["evt-clash"])
	}
	// A compatibility index cannot be answered by a config family's entry...
	if masks["evt-deleted"] != "" {
		t.Fatalf("an unclaimed family index resolved to %q", masks["evt-deleted"])
	}
	// ...and an OAuth record's credential index is not a provider key index.
	if masks["evt-oauth"] != "" {
		t.Fatalf("an OAuth record resolved to provider key mask %q", masks["evt-oauth"])
	}
	// A key CPA reports with no index cannot be tied to a request.
	if masks["evt-legacy"] != "" {
		t.Fatalf("an unindexed legacy key resolved to %q", masks["evt-legacy"])
	}
	if masks["evt-no-index"] != "" {
		t.Fatalf("a record with no auth index resolved to %q", masks["evt-no-index"])
	}
	// The caller key's own mask is untouched by any of this.
	for _, item := range page.Items {
		if item.APIKeyMask != "sk-caller••••••••er" {
			t.Fatalf("caller mask was changed on %s: %q", item.EventKey, item.APIKeyMask)
		}
	}
}

func TestUsageEventDetailMatchesListProviderKeyMask(t *testing.T) {
	client, baseURL, repo := startDashboardTestServer(t, providerKeyMaskFixture(t, nil, 0))
	seedProviderKeyMaskEvents(t, repo)

	page := fetchProviderKeyMaskPage(t, client, baseURL)
	ids := providerKeyMaskIDsByEventKey(t, page)
	listMasks := make(map[int64]string, len(page.Items))
	for _, item := range page.Items {
		listMasks[item.ID] = item.ProviderKeyMask
	}

	for key, id := range ids {
		response, payload := getJSON(t, client, fmt.Sprintf("%s/omc/api/v1/usage/events/%d", baseURL, id))
		if response.StatusCode != http.StatusOK {
			t.Fatalf("detail %s status = %d, body = %s", key, response.StatusCode, payload)
		}
		assertNoProviderSecrets(t, "usage event detail "+key, string(payload))
		var detail struct {
			Event struct {
				ProviderKeyMask string `json:"provider_key_mask"`
			} `json:"event"`
		}
		if err := json.Unmarshal(payload, &detail); err != nil {
			t.Fatal(err)
		}
		if detail.Event.ProviderKeyMask != listMasks[id] {
			t.Fatalf("detail and list disagree for %s: %q vs %q", key, detail.Event.ProviderKeyMask, listMasks[id])
		}
	}
}

// TestProviderKeyMaskCacheCoalescesAndCaches pins the two properties that keep
// this feature from multiplying into credential reads: a page reads a list once,
// and concurrent pages share one read rather than starting their own.
func TestProviderKeyMaskCacheCoalescesAndCaches(t *testing.T) {
	var reads atomic.Int64
	client, baseURL, repo := startDashboardTestServer(t, providerKeyMaskFixture(t, &reads, 50*time.Millisecond))
	seedProviderKeyMaskEvents(t, repo)

	const concurrent = 6
	var wait sync.WaitGroup
	wait.Add(concurrent)
	for i := 0; i < concurrent; i++ {
		go func() {
			defer wait.Done()
			fetchProviderKeyMaskPage(t, client, baseURL)
		}()
	}
	wait.Wait()

	// Two lists are needed (compatibility and claude). The first burst of concurrent
	// pages must not produce one read per page.
	if got := reads.Load(); got > 2 {
		t.Fatalf("expected the credential lists to be read once each, got %d reads", got)
	}

	// A later page inside the TTL is served from the cache and reads nothing.
	before := reads.Load()
	page := fetchProviderKeyMaskPage(t, client, baseURL)
	if reads.Load() != before {
		t.Fatalf("a cached page read CPA again: %d -> %d", before, reads.Load())
	}
	for _, item := range page.Items {
		if item.EventKey == "evt-relay-a" && item.ProviderKeyMask == "" {
			t.Fatal("a cached page returned no mask")
		}
	}
}

// TestProviderKeyMasksSurviveAnUnreadableGateway pins the failure mode: a CPA that
// cannot be read leaves the masks empty and the request list intact. A display
// label must never be able to fail the page that shows request history.
func TestProviderKeyMasksSurviveAnUnreadableGateway(t *testing.T) {
	client, baseURL, repo := startDashboardTestServer(t, func(writer http.ResponseWriter, request *http.Request) {
		// Every credential list answers 500, which is what a gateway that is up but
		// broken looks like.
		writer.Header().Set("Content-Type", "application/json")
		writer.WriteHeader(http.StatusInternalServerError)
		_, _ = writer.Write([]byte(`{"error":"gateway unavailable"}`))
	})
	seedProviderKeyMaskEvents(t, repo)

	started := time.Now()
	response, payload := getJSON(t, client, baseURL+"/omc/api/v1/usage/events?limit=50")
	if response.StatusCode != http.StatusOK {
		t.Fatalf("an unreadable gateway failed the request list: status %d, body %s", response.StatusCode, payload)
	}
	if elapsed := time.Since(started); elapsed > providerKeyMaskReadTimeout {
		t.Fatalf("an unreadable gateway held the request list for %s", elapsed)
	}
	var page providerKeyMaskPage
	if err := json.Unmarshal(payload, &page); err != nil {
		t.Fatal(err)
	}
	if len(page.Items) == 0 {
		t.Fatal("expected the stored records to be returned without masks")
	}
	for _, item := range page.Items {
		if item.ProviderKeyMask != "" {
			t.Fatalf("a mask was resolved from an unreadable gateway: %q", item.ProviderKeyMask)
		}
	}
}

// TestProviderKeyMaskCacheNegativeCachesFailures pins the cache's own contract:
// a failed read answers with nothing, is not retried per call, and never serves a
// previous read's masks after the list went unreadable.
func TestProviderKeyMaskCacheNegativeCachesFailures(t *testing.T) {
	cache := newProviderKeyMaskCache()
	loads := 0
	fail := func(context.Context) (map[string]string, error) {
		loads++
		return nil, fmt.Errorf("gateway unavailable")
	}

	if masks := cache.masks(context.Background(), "default|http://cpa|openai-compatibility", fail); masks != nil {
		t.Fatalf("a failed read returned masks: %v", masks)
	}
	if masks := cache.masks(context.Background(), "default|http://cpa|openai-compatibility", fail); masks != nil {
		t.Fatalf("a negatively cached read returned masks: %v", masks)
	}
	if loads != 1 {
		t.Fatalf("expected one read inside the failure window, got %d", loads)
	}

	// A successful read replaces the failure, and stays served without a new read.
	good := map[string]string{"idx-a": "test-pro••••••••lpha"}
	load := func(context.Context) (map[string]string, error) { loads++; return good, nil }
	cache.invalidate()
	if masks := cache.masks(context.Background(), "default|http://cpa|openai-compatibility", load); masks["idx-a"] == "" {
		t.Fatalf("expected the successful read's mask, got %v", masks)
	}
	if masks := cache.masks(context.Background(), "default|http://cpa|openai-compatibility", load); masks["idx-a"] == "" {
		t.Fatalf("a cached read returned no mask: %v", masks)
	}
	if loads != 2 {
		t.Fatalf("expected the successful read to be cached, got %d reads", loads)
	}

	// Invalidation drops it, which is what a provider write relies on.
	cache.invalidate()
	if masks := cache.masks(context.Background(), "default|http://cpa|openai-compatibility", load); masks["idx-a"] == "" {
		t.Fatalf("expected a re-read after invalidation, got %v", masks)
	}
	if loads != 3 {
		t.Fatalf("expected a re-read after invalidation, got %d reads", loads)
	}
}

// TestProviderKeyMaskCacheIsPerInstance pins that re-pointing the console cannot
// serve masks resolved from the previous gateway.
func TestProviderKeyMaskCacheIsPerInstance(t *testing.T) {
	cache := newProviderKeyMaskCache()
	first := func(context.Context) (map[string]string, error) {
		return map[string]string{"idx-a": "first-key••••••••aaaa"}, nil
	}
	second := func(context.Context) (map[string]string, error) {
		return map[string]string{"idx-a": "second-k••••••••bbbb"}, nil
	}
	if masks := cache.masks(context.Background(), "default|http://cpa-one|openai-compatibility", first); masks["idx-a"] == "" {
		t.Fatal("expected the first instance's mask")
	}
	masks := cache.masks(context.Background(), "default|http://cpa-two|openai-compatibility", second)
	if masks["idx-a"] == "" || masks["idx-a"] == "first-key••••••••aaaa" {
		t.Fatalf("the second instance was served the first instance's mask: %v", masks)
	}
}

func TestProviderKeyMaskIndexReadsOnlyTheListsThePageNeeds(t *testing.T) {
	var reads atomic.Int64
	client, baseURL, repo := startDashboardTestServer(t, providerKeyMaskFixture(t, &reads, 0))
	now := time.Now().UnixMilli()
	// An OAuth-only window: nothing here has a provider key to name.
	if _, err := repo.InsertUsageEvents(context.Background(), []usage.Event{{
		InstanceID: "default", EventKey: "evt-oauth-only", Provider: "codex",
		AuthType: "oauth", AuthIndex: "idx-oauth", Model: "m", TimestampMS: now,
	}}); err != nil {
		t.Fatal(err)
	}
	response, payload := getJSON(t, client, baseURL+"/omc/api/v1/usage/events?limit=50")
	if response.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, body = %s", response.StatusCode, payload)
	}
	if got := reads.Load(); got != 0 {
		t.Fatalf("an OAuth-only window read %d credential lists", got)
	}
}
