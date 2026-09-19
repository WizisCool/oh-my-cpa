package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// TestConcurrentProviderTogglesDoNotLoseAWrite is the regression for a lost
// update between two toggles of *different* rows in the same family.
//
// The defect: CPA exposes no per-entry write, so a toggle reads the family's
// whole list, edits one element, and PUTs the whole list back. Two toggles that
// read before either wrote submit the same baseline, and the later PUT discards
// the earlier one - the earlier click is silently reverted while both requests
// report success. The frontend queue cannot help here: the two clicks are on
// different providers, and it deliberately runs those concurrently.
//
// Both halves of the property are asserted, and each catches a different way of
// getting this wrong:
//
//   - No two read-modify-write windows overlap, counted at the fake gateway. A
//     fix that merely serialised the frontend, or locked something narrower than
//     the read, still overlaps here.
//   - Both toggles' values survive. A fix that serialised the writes but dropped
//     a request on the busy path keeps the windows disjoint and still fails this.
//
// The read is deliberately slowed on the serving goroutine so the second toggle
// really arrives while the first is inside its window, rather than relying on the
// two goroutines happening to collide.
func TestConcurrentProviderTogglesDoNotLoseAWrite(t *testing.T) {
	fixture := newProviderTestFixture(t)
	client, baseURL, state := fixture.client, fixture.baseURL, fixture.state

	state.mu.Lock()
	state.codexProviders = []map[string]any{
		{"api-key": "sk-codex-first", "auth-index": "c-1", "base-url": "https://api.openai.com"},
		{"api-key": "sk-codex-second", "auth-index": "c-2", "base-url": "https://api.openai.com"},
	}
	state.mu.Unlock()

	state.setBeforeCodexRead(func() { time.Sleep(150 * time.Millisecond) })

	toggle := func(index int) (int, string) {
		body := fmt.Sprintf(`{"family":"codex","index":%d,"disabled":true}`, index)
		resp, payload := doJSON(t, client, http.MethodPatch, baseURL+"/omc/api/v1/management/providers/status", body)
		return resp.StatusCode, string(payload)
	}

	results := make(chan string, 2)
	for _, index := range []int{0, 1} {
		go func(index int) {
			status, payload := toggle(index)
			results <- fmt.Sprintf("index %d -> %d %s", index, status, payload)
		}(index)
	}
	first := <-results
	second := <-results
	t.Logf("toggle results: %s | %s", first, second)

	if peak := state.codexSectionPeak(); peak > 1 {
		t.Fatalf(
			"two provider read-modify-write windows overlapped (%d at once), so a whole-list write could discard another",
			peak,
		)
	}

	state.mu.Lock()
	firstDisabled := isExcludedAll(state.codexProviders[0])
	secondDisabled := isExcludedAll(state.codexProviders[1])
	state.mu.Unlock()
	if !firstDisabled || !secondDisabled {
		t.Fatalf(
			"a toggle was silently reverted: index 0 disabled=%t, index 1 disabled=%t (both clicks asked for disabled)",
			firstDisabled, secondDisabled,
		)
	}
}

// TestProviderUpdateHoldsOverlayInsideAdmission is the regression for the
// ordering gap between CPA's accepted list write and the console's local name
// overlay.
//
// The first request is held inside the provider metadata transaction after CPA
// has accepted its list write. A second update is then issued. With the overlay outside the write
// window, that second request can finish first and be overwritten by the paused
// first request's overlay; with the overlay inside the window, the second request
// cannot pass the gate until the first overlay is stored. The final name must be
// the last admitted request's name, Second.
func TestProviderUpdateHoldsOverlayInsideAdmission(t *testing.T) {
	fixture := newProviderTestFixture(t)

	firstOverlayEntered := make(chan struct{})
	releaseFirstOverlay := make(chan struct{})
	var releaseOnce sync.Once
	releaseFirst := func() {
		releaseOnce.Do(func() { close(releaseFirstOverlay) })
	}
	t.Cleanup(releaseFirst)

	var saveCalls atomic.Int32
	fixture.handler.beforeProviderNamesSave = func() {
		if saveCalls.Add(1) != 1 {
			return
		}
		close(firstOverlayEntered)
		<-releaseFirstOverlay
	}

	type updateResult struct {
		name   string
		status int
		body   string
	}
	results := make(chan updateResult, 2)
	update := func(name string) {
		body := fmt.Sprintf(`{"family":"codex","name":%q,"base_url":"https://api.openai.com"}`, name)
		resp, payload := doJSON(t, fixture.client, http.MethodPut,
			fixture.baseURL+"/omc/api/v1/management/providers/codex-0", body)
		results <- updateResult{name: name, status: resp.StatusCode, body: string(payload)}
	}

	go update("First")
	select {
	case <-firstOverlayEntered:
	case <-time.After(2 * time.Second):
		t.Fatal("first provider update never reached its overlay write")
	}

	secondAcquireReached := make(chan struct{})
	var acquireOnce sync.Once
	fixture.handler.providerWrites.beforeAcquire = func() {
		acquireOnce.Do(func() { close(secondAcquireReached) })
	}
	go update("Second")
	select {
	case <-secondAcquireReached:
	case <-time.After(2 * time.Second):
		t.Fatal("second provider update never reached the provider write gate")
	}
	select {
	case result := <-results:
		releaseFirst()
		t.Fatalf("second provider update completed while the first overlay write was held: %s -> %d %s",
			result.name, result.status, result.body)
	case <-time.After(500 * time.Millisecond):
	}

	releaseFirst()
	first := <-results
	second := <-results
	for _, result := range []updateResult{first, second} {
		if result.status != http.StatusOK {
			t.Fatalf("%s provider update status = %d body %s", result.name, result.status, result.body)
		}
	}

	resp, payload := getJSON(t, fixture.client, fixture.baseURL+"/omc/api/v1/management/providers?include_keys=true")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("provider list status = %d body %s", resp.StatusCode, payload)
	}
	var providers struct {
		Providers []ProviderItemDTO `json:"providers"`
	}
	if err := json.Unmarshal(payload, &providers); err != nil {
		t.Fatalf("provider list is not JSON: %v (%s)", err, payload)
	}
	for _, provider := range providers.Providers {
		if provider.ID == "codex-0" {
			if provider.Name != "Second" {
				t.Fatalf("provider codex-0 name = %q after the last admitted update, want Second", provider.Name)
			}
			return
		}
	}
	t.Fatal("provider codex-0 was not present in the provider list")
}

func isExcludedAll(entry map[string]any) bool {
	raw, ok := entry["excluded-models"]
	if !ok {
		return false
	}
	models, ok := raw.([]any)
	if !ok {
		return false
	}
	for _, model := range models {
		if text, ok := model.(string); ok && text == "*" {
			return true
		}
	}
	return false
}

// TestProviderStatusToggleRejectsNegativeIndex pins the lower end of the bounds
// check. The upper-end comparison is against a list length, which a negative
// index passes, so without an explicit rejection a negative index would be
// treated as a valid selection.
func TestProviderStatusToggleRejectsNegativeIndex(t *testing.T) {
	client, baseURL, _ := startProviderTestServer(t)
	resp, payload := doJSON(t, client, http.MethodPatch, baseURL+"/omc/api/v1/management/providers/status",
		`{"family":"codex","index":-1,"disabled":true}`)
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("negative index must be refused, got %d body %s", resp.StatusCode, payload)
	}
}

// TestProviderWritesAreBusyRefusedWhenGateIsHeld documents the refusal the
// client retries: while another write holds the gate, a request that cannot be
// admitted answers 503 with a machine-readable code, and no CPA write is
// attempted on its behalf.
func TestProviderWritesAreBusyRefusedWhenGateIsHeld(t *testing.T) {
	fixture := newProviderTestFixture(t)

	fixture.handler.providerWrites.permits <- struct{}{}
	previousTimeout := fixture.handler.providerWrites.acquireTimeout
	fixture.handler.providerWrites.acquireTimeout = 50 * time.Millisecond
	t.Cleanup(func() {
		fixture.handler.providerWrites.acquireTimeout = previousTimeout
		<-fixture.handler.providerWrites.permits
	})

	before := countProviderWrites(fixture.state)
	resp, payload := doJSON(t, fixture.client, http.MethodPatch, fixture.baseURL+"/omc/api/v1/management/providers/status",
		`{"family":"codex","index":0,"disabled":true}`)
	if resp.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("a refused admission must answer 503, got %d body %s", resp.StatusCode, payload)
	}
	var body struct {
		Code string `json:"code"`
	}
	_ = json.Unmarshal(payload, &body)
	if body.Code != providerWriteBusyCode {
		t.Fatalf("refusal must carry code %q, got %q (%s)", providerWriteBusyCode, body.Code, payload)
	}
	if after := countProviderWrites(fixture.state); after != before {
		t.Fatalf("a refused write must not reach CPA: writes before=%d after=%d", before, after)
	}
}

func countProviderWrites(state *providerFakeServerState) int {
	state.mu.Lock()
	defer state.mu.Unlock()
	return state.putCount
}

// TestProviderStatusToggleChecksIdentityBeforeWriting pins the precondition that
// makes retrying an index-addressed write safe.
//
// A provider is addressed by its position, and a retry repeats that position. If
// another session deletes a provider while the console is waiting to retry, every
// later position shifts and the repeated index now names a different provider: the
// retry would toggle the wrong credential while reporting success. Sending the
// identity the operator actually saw turns that into a refusal.
func TestProviderStatusToggleChecksIdentityBeforeWriting(t *testing.T) {
	fixture := newProviderTestFixture(t)
	state := fixture.state

	state.mu.Lock()
	state.codexProviders = []map[string]any{
		{"api-key": "sk-codex-first", "auth-index": "c-1"},
		{"api-key": "sk-codex-second", "auth-index": "c-2"},
	}
	state.mu.Unlock()

	// The click was on position 1, which was c-2 when the operator saw it.
	// Position 1 is now c-1, because a provider ahead of it was removed.
	state.mu.Lock()
	state.codexProviders = []map[string]any{{"api-key": "sk-codex-first", "auth-index": "c-1"}}
	state.mu.Unlock()
	state.mu.Lock()
	state.codexProviders = append(state.codexProviders, map[string]any{"api-key": "sk-codex-third", "auth-index": "c-3"})
	state.mu.Unlock()

	before := countProviderWrites(state)
	resp, payload := doJSON(t, fixture.client, http.MethodPatch,
		fixture.baseURL+"/omc/api/v1/management/providers/status",
		`{"family":"codex","index":0,"disabled":true,"expected_auth_index":"c-9"}`)
	if resp.StatusCode != http.StatusConflict {
		t.Fatalf("a stale identity must be refused with 409, got %d body %s", resp.StatusCode, payload)
	}
	if after := countProviderWrites(state); after != before {
		t.Fatalf("a refused identity check must not reach CPA: before=%d after=%d", before, after)
	}

	// The same request with the identity that is actually there succeeds, so the
	// precondition refuses only the mismatch rather than the whole path.
	resp, payload = doJSON(t, fixture.client, http.MethodPatch,
		fixture.baseURL+"/omc/api/v1/management/providers/status",
		`{"family":"codex","index":0,"disabled":true,"expected_auth_index":"c-1"}`)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("a matching identity must be accepted, got %d body %s", resp.StatusCode, payload)
	}

	// Omitting the precondition keeps the endpoint working for a caller that has
	// no identity to send.
	resp, payload = doJSON(t, fixture.client, http.MethodPatch,
		fixture.baseURL+"/omc/api/v1/management/providers/status",
		`{"family":"codex","index":0,"disabled":false}`)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("an omitted precondition must not be treated as a mismatch, got %d body %s", resp.StatusCode, payload)
	}
}
