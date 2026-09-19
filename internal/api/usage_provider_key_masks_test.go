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
	"github.com/oh-my-cpa/oh-my-cpa/internal/security"
	"github.com/oh-my-cpa/oh-my-cpa/internal/usage"
)

/**
 * Secret values used by this file's fixture.
 *
 * They are synthetic and deliberately distinctive, and the two `testProviderKeyA`
 * / `testProviderKeyB` keys are chosen so their masks are **different**: the
 * duplicate-claim case below has to show that an ambiguous index resolves to nothing
 * even when a reader could not tell the two apart by their mask, so a third pair is
 * built whose masks are deliberately identical.
 *
 * The assertions require that none of these reaches a response body, so a fixture
 * that reused a plausible string could pass while leaking something real.
 * `assertNoProviderSecrets` checks the raw response text rather than the decoded
 * field, because a leak into any other field is the failure this is guarding against.
 */
const (
	testProviderKeyA = "test-provider-key-aaaaaaaaaaaa-alpha"
	testProviderKeyB = "test-provider-key-bbbbbbbbbbbb-bravo"
	testProviderKeyC = "test-provider-key-cccccccccccc-charlie"
	// Two distinct secrets whose masks are identical: same head, same tail, so
	// `security.MaskSecret` cannot tell them apart. Only 20+ rune keys take this
	// branch, hence the padding.
	testProviderKeyTwinA = "test-twin-key-1111111111111111-shared"
	testProviderKeyTwinB = "test-twin-key-2222222222222222-shared"
)

// testProviderKeyMask is the expected mask of a fixture key. It mirrors
// `security.MaskSecret` rather than hard-coding the rendered string, so a change to
// the one mask shape updates the fixture with it.
func testProviderKeyMask(key string) string {
	return security.MaskSecret(key)
}

// providerKeyMaskFixture answers CPA's credential lists with a provider that has
// two keys, a renamed compatibility provider, a config family, an index two entries
// claim, an index three entries claim, an OAuth-only family and an index no list
// claims at all.
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
						"name": "Twin Claimed",
						"base-url": "https://twin.example.test/v1",
						"api-key-entries": [
							{"api-key": "` + testProviderKeyTwinA + `", "auth-index": "idx-twins"},
							{"api-key": "` + testProviderKeyTwinB + `", "auth-index": "idx-twins"},
							{"api-key": "` + testProviderKeyTwinA + `", "auth-index": "idx-twins"}
						]
					},
					{
						"name": "Legacy Relay",
						"base-url": "https://legacy.example.test/v1",
						"api-keys": ["` + testProviderKeyC + `"]
					},
					{
						"name": "One Key Only",
						"base-url": "https://one.example.test/v1",
						"api-key-entries": [
							{"api-key": "` + testProviderKeyC + `", "auth-index": "idx-single"}
						]
					},
					{
						"name": "Switched Off",
						"disabled": true,
						"base-url": "https://off.example.test/v1",
						"api-key-entries": [
							{"api-key": "` + testProviderKeyA + `", "auth-index": "idx-disabled"}
						]
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
		// An index three entries claim, two of which are distinct secrets whose masks
		// are identical.
		{InstanceID: "default", EventKey: "evt-twins", Provider: "openai-compatible-twin claimed", AuthType: "apikey", AuthIndex: "idx-twins", Model: "m", TimestampMS: now - 5},
		// A provider label that names no credential list. Its index is claimed by the
		// claude family, and it must still resolve to nothing: the label is the
		// namespace, not a hint.
		{InstanceID: "default", EventKey: "evt-unlabelled", Provider: "codebuddy", AuthType: "apikey", AuthIndex: "idx-claude", Model: "m", TimestampMS: now - 5},
		// An API-key record from a provider with a single configured key whose auth
		// index does not claim any entry. "It must be that one" is an inference, and
		// the row must stay silent rather than print it.
		{InstanceID: "default", EventKey: "evt-single-mismatch", Provider: "openai-compatible-one key only", AuthType: "apikey", AuthIndex: "idx-single-absent", Model: "m", TimestampMS: now - 5},
		// A request served by a provider that has since been switched off. The key is the
		// one that answered, and its provider's current enabled state is not part of the
		// credential's identity, so the row still names it.
		{InstanceID: "default", EventKey: "evt-disabled-provider", Provider: "openai-compatible-switched off", AuthType: "apikey", AuthIndex: "idx-disabled", Model: "m", TimestampMS: now - 5},
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
	for _, secret := range []string{
		testProviderKeyA, testProviderKeyB, testProviderKeyC,
		testProviderKeyTwinA, testProviderKeyTwinB,
	} {
		if strings.Contains(body, secret) {
			t.Fatalf("%s exposed a provider key in the response body", label)
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
	if got, want := masks["evt-relay-a"], testProviderKeyMask(testProviderKeyA); got != want {
		t.Fatalf("evt-relay-a mask = %q, want the mask of its own key %q", got, want)
	}
	if got, want := masks["evt-relay-b"], testProviderKeyMask(testProviderKeyB); got != want {
		t.Fatalf("evt-relay-b mask = %q, want the mask of its own key %q", got, want)
	}
	if masks["evt-relay-a"] == masks["evt-relay-b"] {
		t.Fatalf("the two keys of one provider resolved to the same mask %q", masks["evt-relay-a"])
	}
	// The same index recorded under the provider's previous name still resolves: a
	// rename in CPA does not orphan the requests it already served.
	if masks["evt-relay-old-name"] != masks["evt-relay-a"] {
		t.Fatalf("a compatibility provider's earlier name orphaned its index: %q vs %q",
			masks["evt-relay-old-name"], masks["evt-relay-a"])
	}
	// A config family resolves through its own list.
	if got, want := masks["evt-claude"], testProviderKeyMask(testProviderKeyC); got != want {
		t.Fatalf("evt-claude mask = %q, want %q", got, want)
	}
	// The twins' masks are identical, which is exactly why an index two of them claim
	// cannot be resolved: it must not print even though the answer "looks" right.
	if testProviderKeyMask(testProviderKeyTwinA) != testProviderKeyMask(testProviderKeyTwinB) {
		t.Fatal("the twin fixture keys must share a mask for this case to mean anything")
	}
	if masks["evt-twins"] != "" {
		t.Fatalf("an index three credentials claim must resolve to nothing, got %q", masks["evt-twins"])
	}
	// An index claimed twice is not an identity, even though both masks look alike.
	if masks["evt-clash"] != "" {
		t.Fatalf("an index two credentials claim must resolve to nothing, got %q", masks["evt-clash"])
	}
	// A compatibility index cannot be answered by a config family's entry...
	if masks["evt-deleted"] != "" {
		t.Fatalf("an unclaimed family index resolved to %q", masks["evt-deleted"])
	}
	// ...nor a family index by a label that names no credential list...
	if masks["evt-unlabelled"] != "" {
		t.Fatalf("a provider label outside every credential list resolved to %q", masks["evt-unlabelled"])
	}
	// ...nor a single-key provider's key by the request's own index...
	if masks["evt-single-mismatch"] != "" {
		t.Fatalf("an unclaimed index resolved to its provider's only key: %q", masks["evt-single-mismatch"])
	}
	// ...and an OAuth record's credential index is not a provider key index.
	if masks["evt-oauth"] != "" {
		t.Fatalf("an OAuth record resolved to provider key mask %q", masks["evt-oauth"])
	}
	// A provider that has since been switched off still names the key that answered.
	//
	// This is deliberate, and is what a review asked to change: filtering out disabled
	// providers was rejected on both evidence and semantics. On the evidence, CPA does
	// not report an auth index for a disabled compatibility provider at all, so such an
	// entry claims nothing already. On the semantics, the enabled state of the provider
	// is not part of the credential's identity: the request was served by that key, and
	// dropping the label would erase a true fact from history rather than remove a wrong
	// one. The ambiguity rule still protects the interesting case - a disabled entry and
	// a live one claiming the same index resolve to nothing.
	if got, want := masks["evt-disabled-provider"], testProviderKeyMask(testProviderKeyA); got != want {
		t.Fatalf("a request served before its provider was switched off lost its key: got %q, want %q", got, want)
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

	resolved, omitted := 0, 0
	for key, id := range ids {
		response, payload := getJSON(t, client, fmt.Sprintf("%s/omc/api/v1/usage/events/%d", baseURL, id))
		if response.StatusCode != http.StatusOK {
			t.Fatalf("detail %s status = %d, body = %s", key, response.StatusCode, payload)
		}
		assertNoProviderSecrets(t, "usage event detail "+key, string(payload))
		var detail struct {
			Event map[string]json.RawMessage `json:"event"`
		}
		if err := json.Unmarshal(payload, &detail); err != nil {
			t.Fatal(err)
		}
		raw, present := detail.Event["provider_key_mask"]
		if listMasks[id] == "" {
			// An unresolved record must omit the property, not send it empty: an
			// absent key and an empty one read differently to a consumer, and the
			// console prints no key line for a record it cannot attribute.
			if present {
				t.Fatalf("detail %s sent provider_key_mask = %s for a record the list left empty", key, raw)
			}
			omitted++
			continue
		}
		if !present {
			t.Fatalf("detail %s omitted the mask the list resolved (%q)", key, listMasks[id])
		}
		var mask string
		if err := json.Unmarshal(raw, &mask); err != nil {
			t.Fatal(err)
		}
		if mask != listMasks[id] {
			t.Fatalf("detail and list disagree for %s: %q vs %q", key, mask, listMasks[id])
		}
		resolved++
	}
	// Anchored so the loop cannot pass by only visiting the omitted case.
	if resolved == 0 || omitted == 0 {
		t.Fatalf("expected both resolved and omitted records, got resolved=%d omitted=%d", resolved, omitted)
	}
}

// TestProviderKeyMaskCacheWithholdsAnInvalidatedRead pins the race between a read
// and a write. A provider write drops every cached mask because the configuration
// the read saw has been replaced; a read already in flight would otherwise hand its
// own requester the very mapping the invalidation withdrew.
//
// The interleaving is controlled by channels rather than by sleeping, so the test
// asserts the ordering it claims instead of hoping for it.
func TestProviderKeyMaskCacheWithholdsAnInvalidatedRead(t *testing.T) {
	cache := newProviderKeyMaskCache()
	const key = "default|http://cpa|openai-compatibility"

	loadStarted := make(chan struct{})
	releaseLoad := make(chan struct{})
	stale := map[string]string{"idx-a": "stale-ke••••••••aaaa"}
	load := func(context.Context) (map[string]string, error) {
		close(loadStarted)
		<-releaseLoad
		return stale, nil
	}

	result := make(chan map[string]string, 1)
	go func() { result <- cache.masks(context.Background(), key, load) }()

	<-loadStarted
	// The write lands while the read is still in flight.
	cache.invalidate()
	close(releaseLoad)

	if masks := <-result; masks != nil {
		t.Fatalf("a read invalidated mid-flight returned its mapping: %v", masks)
	}
	// And nothing was stored, so the next caller reads again rather than being
	// served the withdrawn answer.
	loads := 0
	fresh := map[string]string{"idx-a": "fresh-ke••••••••bbbb"}
	if masks := cache.masks(context.Background(), key, func(context.Context) (map[string]string, error) {
		loads++
		return fresh, nil
	}); masks["idx-a"] != fresh["idx-a"] {
		t.Fatalf("expected a fresh read after invalidation, got %v", masks)
	}
	if loads != 1 {
		t.Fatalf("expected exactly one re-read, got %d", loads)
	}
}

// TestProviderKeyMaskCacheHonoursCancellation pins that a waiter gives up when its
// own request is over, rather than parking until a read it no longer needs finishes.
func TestProviderKeyMaskCacheHonoursCancellation(t *testing.T) {
	cache := newProviderKeyMaskCache()
	const key = "default|http://cpa|openai-compatibility"

	loadStarted := make(chan struct{})
	releaseLoad := make(chan struct{})
	go func() {
		cache.masks(context.Background(), key, func(context.Context) (map[string]string, error) {
			close(loadStarted)
			<-releaseLoad
			return map[string]string{"idx-a": "late-key••••••••aaaa"}, nil
		})
	}()
	<-loadStarted

	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	started := time.Now()
	if masks := cache.masks(ctx, key, func(context.Context) (map[string]string, error) {
		t.Fatal("a cancelled waiter started its own read")
		return nil, nil
	}); masks != nil {
		t.Fatalf("a cancelled waiter returned masks: %v", masks)
	}
	if elapsed := time.Since(started); elapsed > 2*time.Second {
		t.Fatalf("a cancelled waiter waited %s for an in-flight read", elapsed)
	}
	close(releaseLoad)
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
