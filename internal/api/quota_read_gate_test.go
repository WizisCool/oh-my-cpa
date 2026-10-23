package api

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/management"
	"github.com/oh-my-cpa/oh-my-cpa/internal/crypto"
	"github.com/oh-my-cpa/oh-my-cpa/internal/domain"
	"github.com/oh-my-cpa/oh-my-cpa/internal/quota"
)

// claudeRateLimitFixture is a gateway with four Claude credentials and two Codex ones whose
// Anthropic upstream can be switched to answer every read with 429.
type claudeRateLimitFixture struct {
	mu               sync.Mutex
	claudeRequests   map[string]int
	claudeURLs       map[string]int
	codexReads       map[string]int
	isRateLimited    bool
	retryAfterSecond int
}

func (f *claudeRateLimitFixture) setRateLimited(isRateLimited bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.isRateLimited = isRateLimited
}

func (f *claudeRateLimitFixture) totalClaudeRequests() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	total := 0
	for _, count := range f.claudeRequests {
		total += count
	}
	return total
}

func (f *claudeRateLimitFixture) requestsOf(authIndex string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.claudeRequests[authIndex]
}

func newClaudeRateLimitHandler(t *testing.T, fixture *claudeRateLimitFixture) *Handler {
	t.Helper()
	const managementKey = "management-secret"
	resetsAt := time.Now().Add(4 * time.Hour).UTC().Format(time.RFC3339)
	cpaServer := newFakeCPA(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Header.Get("Authorization") != "Bearer "+managementKey {
			writer.WriteHeader(http.StatusUnauthorized)
			return
		}
		writer.Header().Set("Content-Type", "application/json")
		switch request.URL.Path {
		case "/v8/management/credentials":
			_, _ = writer.Write([]byte(`{"files": [
				{"id": "c1", "name": "claude-1.json", "auth_index": "claude-1", "type": "claude", "provider": "claude"},
				{"id": "c2", "name": "claude-2.json", "auth_index": "claude-2", "type": "claude", "provider": "claude"},
				{"id": "c3", "name": "claude-3.json", "auth_index": "claude-3", "type": "claude", "provider": "claude"},
				{"id": "c4", "name": "claude-4.json", "auth_index": "claude-4", "type": "claude", "provider": "claude"},
				{"id": "x1", "name": "codex-1.json", "auth_index": "codex-1", "type": "codex", "provider": "codex"},
				{"id": "x2", "name": "codex-2.json", "auth_index": "codex-2", "type": "codex", "provider": "codex"}
			]}`))
		case "/v8/management/requests/api-call":
			var payload struct {
				AuthIndex string `json:"auth_index"`
				URL       string `json:"url"`
			}
			_ = json.NewDecoder(request.Body).Decode(&payload)
			switch {
			case strings.HasPrefix(payload.URL, quota.ClaudeUsageURL) || payload.URL == quota.ClaudeProfileURL:
				fixture.mu.Lock()
				fixture.claudeRequests[payload.AuthIndex]++
				if fixture.claudeURLs != nil {
					fixture.claudeURLs[payload.URL]++
				}
				isRateLimited, retryAfter := fixture.isRateLimited, fixture.retryAfterSecond
				fixture.mu.Unlock()
				switch {
				case isRateLimited:
					_, _ = fmt.Fprintf(writer, `{"status_code": 429, "header": {"retry-after": ["%d"]}, "body": {"type": "error", "error": {"type": "rate_limit_error", "message": "Rate limited"}}}`, retryAfter)
				case payload.URL == quota.ClaudeProfileURL:
					_, _ = writer.Write([]byte(`{"status_code": 200, "body": {"account": {"has_claude_max": true}}}`))
				case strings.Contains(payload.URL, "cedar_ember"):
					_, _ = writer.Write([]byte(`{"status_code": 200, "body": {"cedar_ember": {"eligible": true, "grants": [{"id": "grant-1", "resets_total": 2, "resets_left": 1, "clears": ["five_hour"]}]}}}`))
				default:
					_, _ = fmt.Fprintf(writer, `{"status_code": 200, "body": {"five_hour": {"utilization": 10, "resets_at": %q}}}`, resetsAt)
				}
			case strings.Contains(payload.URL, "backend-api/wham/usage"):
				fixture.mu.Lock()
				fixture.codexReads[payload.AuthIndex]++
				fixture.mu.Unlock()
				_, _ = writer.Write([]byte(`{"status_code": 200, "body": {
					"plan_type": "pro",
					"rate_limit": {"primary_window": {"used_percent": 3, "limit_window_seconds": 18000, "reset_after_seconds": 18000}}
				}}`))
			default:
				_, _ = writer.Write([]byte(`{"status_code": 404, "body": {}}`))
			}
		default:
			writer.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(cpaServer.Close)

	handler := testHandler(t, "")
	cipher, err := crypto.New("01234567890123456789012345678901")
	if err != nil {
		t.Fatal(err)
	}
	ciphertext, nonce, err := cipher.Encrypt([]byte(managementKey))
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	if err := handler.repo.UpsertInstance(context.Background(), domain.CPAInstance{
		ID: "default", Name: "Default", BaseURL: cpaServer.URL,
		UsageAddr:               strings.TrimPrefix(cpaServer.URL, "http://"),
		ManagementKeyCiphertext: ciphertext, ManagementKeyNonce: nonce,
		CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}
	return handler
}

var claudeRateLimitCredentials = []string{"claude-1", "claude-2", "claude-3", "claude-4"}

func TestQuotaAutoRefreshPacesClaudeAfterRateLimits(t *testing.T) {
	ctx := context.Background()
	fixture := &claudeRateLimitFixture{claudeRequests: map[string]int{}, codexReads: map[string]int{}, isRateLimited: true, retryAfterSecond: 120}
	handler := newClaudeRateLimitHandler(t, fixture)
	base := time.Now()
	var clockMu sync.Mutex
	offset := time.Duration(0)
	handler.nowFn = func() time.Time {
		clockMu.Lock()
		defer clockMu.Unlock()
		return base.Add(offset)
	}
	advanceTo := func(next time.Duration) {
		clockMu.Lock()
		offset = next
		clockMu.Unlock()
	}

	// Every credential's five-hour window reset two minutes ago, so all six are due at once:
	// the burst that drew a 429 for every Claude credential in production.
	observedAtMS := base.UnixMilli() - 5*time.Hour.Milliseconds()
	for _, authIndex := range append(append([]string(nil), claudeRateLimitCredentials...), "codex-1", "codex-2") {
		provider := strings.SplitN(authIndex, "-", 2)[0]
		saveAutoRefreshSnapshot(t, handler, authIndex, provider, observedAtMS, base.UnixMilli()-2*time.Minute.Milliseconds())
	}
	setAutoRefreshPolicy(t, handler, `{"interval_minutes":0,"refresh_on_reset":true}`)

	round, err := handler.runQuotaAutoRefreshRound(ctx)
	if err != nil {
		t.Fatal(err)
	}
	// One Claude read is sent and refused at its first request; the other three wait for the
	// pause instead of drawing three more 429s, and Codex is read as before.
	if got := fixture.totalClaudeRequests(); got != 1 {
		t.Fatalf("Claude upstream requests = %d, want 1 (refused profile read, no usage read, no others)", got)
	}
	if round.Due != 6 || round.Refreshed != 2 || round.Failed != 1 || round.Deferred != 3 {
		t.Fatalf("first round = %+v, want 6 due, 2 Codex refreshed, 1 refused, 3 deferred", round)
	}
	refused := ""
	for _, authIndex := range claudeRateLimitCredentials {
		if fixture.requestsOf(authIndex) == 1 {
			refused = authIndex
		}
	}
	snapshots, err := handler.repo.GetLatestQuotaSnapshots(ctx, claudeRateLimitCredentials)
	if err != nil {
		t.Fatal(err)
	}
	for _, authIndex := range claudeRateLimitCredentials {
		if snapshots[authIndex].ObservedAtMS != observedAtMS {
			t.Fatalf("%s lost its last good reading: %+v", authIndex, snapshots[authIndex])
		}
	}

	// The Retry-After (120s) outlasts the one-minute floor, and nothing is due until it passes.
	fixture.setRateLimited(false)
	for _, at := range []time.Duration{0, 61 * time.Second} {
		advanceTo(at)
		if round, err := handler.runQuotaAutoRefreshRound(ctx); err != nil || round.Due != 0 {
			t.Fatalf("round at +%s = %+v err=%v, want nothing due inside Retry-After", at, round, err)
		}
	}
	if got := fixture.totalClaudeRequests(); got != 1 {
		t.Fatalf("Claude upstream requests inside Retry-After = %d, want 1", got)
	}

	// After it, the three deferred reads go out; the refused credential is still
	// inside its own backoff.
	advanceTo(121 * time.Second)
	round, err = handler.runQuotaAutoRefreshRound(ctx)
	if err != nil || round.Due != 3 || round.Refreshed != 3 {
		t.Fatalf("round after Retry-After = %+v err=%v, want the 3 deferred credentials read", round, err)
	}
	if fixture.requestsOf(refused) != 1 {
		t.Fatalf("%s was read again inside its backoff", refused)
	}

	// Past its backoff and the reset retry's own backoff, the refused credential recovers.
	advanceTo(11 * time.Minute)
	round, err = handler.runQuotaAutoRefreshRound(ctx)
	if err != nil || round.Due != 1 || round.Refreshed != 1 {
		t.Fatalf("recovery round = %+v err=%v, want %s read once", round, err, refused)
	}
	snapshots, err = handler.repo.GetLatestQuotaSnapshots(ctx, []string{refused})
	if err != nil {
		t.Fatal(err)
	}
	if snapshots[refused].ObservedAtMS == observedAtMS {
		t.Fatalf("%s recovered but kept the old reading", refused)
	}
	if at := handler.quotaReadGates.claudeGate().scheduledReadAt(refused); at > handler.now().UnixMilli() {
		t.Fatalf("%s still backed off after a successful read", refused)
	}
}

func TestQuotaBatchRefreshHonorsClaudeRateLimit(t *testing.T) {
	fixture := &claudeRateLimitFixture{claudeRequests: map[string]int{}, codexReads: map[string]int{}, isRateLimited: true, retryAfterSecond: 30}
	handler := newClaudeRateLimitHandler(t, fixture)
	nowMS := time.Now().UnixMilli()
	for _, authIndex := range claudeRateLimitCredentials {
		saveAutoRefreshSnapshot(t, handler, authIndex, "claude", nowMS-time.Hour.Milliseconds(), nowMS+time.Hour.Milliseconds())
	}

	refresh := func() []quota.NormalizedQuota {
		t.Helper()
		body := `{"auth_indexes":["claude-1","claude-2","claude-3","claude-4","codex-1","codex-2"]}`
		recorder := httptest.NewRecorder()
		handler.refreshCredentialQuota(recorder, httptest.NewRequest(http.MethodPost, "/api/v1/management/quota/refresh", bytes.NewBufferString(body)))
		if recorder.Code != http.StatusOK {
			t.Fatalf("batch refresh status = %d: %s", recorder.Code, recorder.Body.String())
		}
		var response struct {
			Quotas []quota.NormalizedQuota `json:"quotas"`
		}
		if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
			t.Fatal(err)
		}
		return response.Quotas
	}

	for attempt := range 2 {
		quotas := refresh()
		// The first click sends one Claude request; the second falls inside the Retry-After and
		// sends none. Codex is read on both.
		if got := fixture.totalClaudeRequests(); got != 1 {
			t.Fatalf("click %d: Claude upstream requests = %d, want 1", attempt+1, got)
		}
		if len(quotas) != 6 {
			t.Fatalf("click %d: %d quotas in the response, want 6", attempt+1, len(quotas))
		}
		for _, q := range quotas {
			if q.Provider == "claude" && (q.Status != "stale" || len(q.Windows) != 1 || !strings.Contains(q.Error, "429")) {
				t.Fatalf("click %d: %s = status %q windows %d error %q, want the last reading marked stale with the 429", attempt+1, q.AuthIndex, q.Status, len(q.Windows), q.Error)
			}
		}
	}
	fixture.mu.Lock()
	defer fixture.mu.Unlock()
	if fixture.codexReads["codex-1"] != 2 || fixture.codexReads["codex-2"] != 2 {
		t.Fatalf("Codex reads = %v, want each credential read on both clicks", fixture.codexReads)
	}
}

func TestQuotaRateLimitBackoffDoublesToItsCap(t *testing.T) {
	for consecutive, want := range map[int]time.Duration{
		1: 5 * time.Minute, 2: 10 * time.Minute, 3: 20 * time.Minute, 4: 30 * time.Minute, 12: 30 * time.Minute,
	} {
		if got := quotaRateLimitBackoff(consecutive); got != want {
			t.Errorf("backoff after %d consecutive 429s = %s, want %s", consecutive, got, want)
		}
	}
}

func TestClaudeQuotaRereadSendsOnlyTheUsageRequest(t *testing.T) {
	ctx := context.Background()
	fixture := &claudeRateLimitFixture{claudeRequests: map[string]int{}, claudeURLs: map[string]int{}, codexReads: map[string]int{}}
	handler := newClaudeRateLimitHandler(t, fixture)
	instance, err := handler.repo.GetInstance(ctx, defaultInstanceID())
	if err != nil {
		t.Fatal(err)
	}
	client, err := handler.clientForInstance(ctx, instance)
	if err != nil {
		t.Fatal(err)
	}
	file := management.AuthFile{AuthIndex: "claude-1", Name: "claude-1.json", Type: "claude", Provider: "claude"}
	read := func() *quota.NormalizedQuota {
		t.Helper()
		reading, err := handler.refreshQuotaReading(ctx, quota.NewService(client), file, handler.loadPriorNormalizedQuota(ctx, "claude-1"))
		if err != nil {
			t.Fatal(err)
		}
		if err := handler.persistNormalizedQuotaSnapshot(ctx, reading); err != nil {
			t.Fatal(err)
		}
		return reading
	}

	first := read()
	second := read()
	fixture.mu.Lock()
	urls := fixture.claudeURLs
	fixture.mu.Unlock()
	grantsURL := quota.ClaudeUsageURL + "?cedar_ember=1&skip_spend=1"
	if urls[quota.ClaudeProfileURL] != 1 || urls[grantsURL] != 1 || urls[quota.ClaudeUsageURL] != 2 {
		t.Fatalf("Claude requests by URL = %v, want profile and grants once and usage on both reads", urls)
	}
	if second.Plan == nil || second.Plan.PlanType != first.Plan.PlanType || len(second.ResetGrants) != 1 {
		t.Fatalf("second read plan %+v grants %+v, want the first read's plan and grants carried", second.Plan, second.ResetGrants)
	}

	// Past the grants' age the grants are listed again; the plan is still recent.
	handler.nowFn = func() time.Time { return time.Now().Add(QUOTA_CLAUDE_RESET_GRANTS_MAX_AGE + time.Minute) }
	read()
	fixture.mu.Lock()
	defer fixture.mu.Unlock()
	if urls[quota.ClaudeProfileURL] != 1 || urls[grantsURL] != 2 || urls[quota.ClaudeUsageURL] != 3 {
		t.Fatalf("Claude requests by URL after an hour = %v, want the grants listed again and the profile not", urls)
	}
}
