package api

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
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
	mu                 sync.Mutex
	claudeRequests     map[string]int
	claudeURLs         map[string]int
	codexReads         map[string]int
	isRateLimited      bool
	isGrantsRefused    bool
	retryAfterSecond   int
	grantsResponseBody string
	onGrantsRequest    func()
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
				isRateLimited = isRateLimited || (fixture.isGrantsRefused && strings.Contains(payload.URL, "cedar_ember"))
				grantsBody := fixture.grantsResponseBody
				onGrantsRequest := fixture.onGrantsRequest
				fixture.mu.Unlock()
				if strings.Contains(payload.URL, "cedar_ember") && onGrantsRequest != nil {
					onGrantsRequest()
				}
				switch {
				case isRateLimited:
					_, _ = fmt.Fprintf(writer, `{"status_code": 429, "header": {"retry-after": ["%d"]}, "body": {"type": "error", "error": {"type": "rate_limit_error", "message": "Rate limited"}}}`, retryAfter)
				case payload.URL == quota.ClaudeProfileURL:
					_, _ = writer.Write([]byte(`{"status_code": 200, "body": {"account": {"has_claude_max": true}}}`))
				case strings.Contains(payload.URL, "cedar_ember"):
					if grantsBody == "" {
						grantsBody = `{"status_code": 200, "body": {"cedar_ember": {"eligible": true, "grants": [{"id": "grant-1", "resets_total": 2, "resets_left": 1, "clears": ["five_hour"]}]}}}`
					}
					_, _ = writer.Write([]byte(grantsBody))
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

// readQuotaRefreshStream reads a batch refresh's event stream: one `quota` frame per reading, then
// `done` with the count. A stream without `done` fails the test, since the console treats it as cut.
func readQuotaRefreshStream(t *testing.T, body io.Reader) ([]quota.NormalizedQuota, int) {
	t.Helper()
	var quotas []quota.NormalizedQuota
	total := -1
	for _, frame := range strings.Split(strings.TrimSpace(readAll(t, body)), "\n\n") {
		event, data, _ := strings.Cut(frame, "\n")
		data = strings.TrimPrefix(data, "data: ")
		switch event {
		case "event: quota":
			var reading quota.NormalizedQuota
			if err := json.Unmarshal([]byte(data), &reading); err != nil {
				t.Fatalf("quota frame %q: %v", data, err)
			}
			quotas = append(quotas, reading)
		case "event: done":
			var done struct {
				Total int `json:"total"`
			}
			if err := json.Unmarshal([]byte(data), &done); err != nil {
				t.Fatalf("done frame %q: %v", data, err)
			}
			total = done.Total
		default:
			t.Fatalf("unexpected frame %q", frame)
		}
	}
	if total < 0 {
		t.Fatal("batch refresh stream ended without its done frame")
	}
	return quotas, total
}

func readAll(t *testing.T, body io.Reader) string {
	t.Helper()
	raw, err := io.ReadAll(body)
	if err != nil {
		t.Fatal(err)
	}
	return string(raw)
}

func TestQuotaAutoRefreshPacesClaudeAfterRateLimits(t *testing.T) {
	ctx := context.Background()
	fixture := &claudeRateLimitFixture{claudeRequests: map[string]int{}, codexReads: map[string]int{}, isRateLimited: true, retryAfterSecond: 180}
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

	// The Retry-After (180s) outlasts the two-minute floor, and nothing is due until it passes.
	fixture.setRateLimited(false)
	for _, at := range []time.Duration{0, 121 * time.Second} {
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
	advanceTo(181 * time.Second)
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

	// The console asks for the event stream; this batch is read through it.
	refresh := func() []quota.NormalizedQuota {
		t.Helper()
		body := `{"auth_indexes":["claude-1","claude-2","claude-3","claude-4","codex-1","codex-2"]}`
		recorder := httptest.NewRecorder()
		request := httptest.NewRequest(http.MethodPost, "/api/v1/management/quota/refresh", bytes.NewBufferString(body))
		request.Header.Set("Accept", "text/event-stream")
		handler.refreshCredentialQuota(recorder, request)
		if recorder.Code != http.StatusOK || !strings.HasPrefix(recorder.Header().Get("Content-Type"), "text/event-stream") {
			t.Fatalf("batch refresh status = %d type = %q: %s", recorder.Code, recorder.Header().Get("Content-Type"), recorder.Body.String())
		}
		quotas, total := readQuotaRefreshStream(t, recorder.Body)
		if total != len(quotas) {
			t.Fatalf("done total = %d, streamed %d readings", total, len(quotas))
		}
		return quotas
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
		reading, err := handler.refreshQuotaReading(ctx, handler.newQuotaService(client), file, handler.loadPriorNormalizedQuota(ctx, "claude-1"))
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

// The grants endpoint refuses more readily than usage. A refused listing is display-only: it must
// not pause the other credentials' reads, nor be retried on every read of its own credential.
func TestClaudeRefusedGrantsListingNeitherPausesNorRepeats(t *testing.T) {
	ctx := context.Background()
	fixture := &claudeRateLimitFixture{claudeRequests: map[string]int{}, claudeURLs: map[string]int{}, codexReads: map[string]int{}, isGrantsRefused: true, retryAfterSecond: 60}
	handler := newClaudeRateLimitHandler(t, fixture)
	instance, err := handler.repo.GetInstance(ctx, defaultInstanceID())
	if err != nil {
		t.Fatal(err)
	}
	client, err := handler.clientForInstance(ctx, instance)
	if err != nil {
		t.Fatal(err)
	}
	read := func(authIndex string) *quota.NormalizedQuota {
		t.Helper()
		file := management.AuthFile{AuthIndex: authIndex, Name: authIndex + ".json", Type: "claude", Provider: "claude"}
		reading, err := handler.refreshQuotaReading(ctx, handler.newQuotaService(client), file, handler.loadPriorNormalizedQuota(ctx, authIndex))
		if err != nil {
			t.Fatal(err)
		}
		if err := handler.persistNormalizedQuotaSnapshot(ctx, reading); err != nil {
			t.Fatal(err)
		}
		return reading
	}

	for _, authIndex := range []string{"claude-1", "claude-2", "claude-1"} {
		if reading := read(authIndex); reading.IsDeferred || reading.Status != "healthy" {
			t.Fatalf("%s read = status %q deferred %v error %q, want a healthy reading", authIndex, reading.Status, reading.IsDeferred, reading.Error)
		}
	}
	fixture.mu.Lock()
	grantsCalls := fixture.claudeURLs[quota.ClaudeUsageURL+"?cedar_ember=1&skip_spend=1"]
	fixture.mu.Unlock()
	if grantsCalls != 2 {
		t.Fatalf("grants listed %d times, want once per credential", grantsCalls)
	}

	// Overview projects the transient grants error while the failure cooldown holds.
	overview, err := handler.buildQuotaOverview(ctx, client)
	if err != nil {
		t.Fatal(err)
	}
	foundError := false
	for _, item := range overview.Quotas {
		if item.AuthIndex == "claude-1" {
			foundError = item.ResetGrantsError == quota.ClaudeResetGrantsErrorRateLimited
			if item.ResetGrantsObserved {
				t.Fatalf("claude-1 ResetGrantsObserved = true after failed initial grants read, want false")
			}
		}
	}
	if !foundError {
		t.Fatalf("overview did not project reset_grants_error=%q for claude-1", quota.ClaudeResetGrantsErrorRateLimited)
	}

	// Past the short failure cooldown (well before the 1-hour success TTL), the next refresh
	// retries grants, recovers them, and clears reset_grants_error.
	fixture.mu.Lock()
	fixture.isGrantsRefused = false
	fixture.mu.Unlock()
	handler.nowFn = func() time.Time { return time.Now().Add(QUOTA_CLAUDE_RESET_GRANTS_FAILURE_COOLDOWN + time.Second) }
	recovered := read("claude-1")
	if recovered.ResetGrantsError != "" || !recovered.ResetGrantsObserved || len(recovered.ResetGrants) != 1 {
		t.Fatalf("recovered claude-1 = observed:%v grants:%+v err:%q, want observed 1 grant and empty error", recovered.ResetGrantsObserved, recovered.ResetGrants, recovered.ResetGrantsError)
	}
	// A refresh carrying a stale prior.ResetGrantsError inside the fresh window still reflects
	// the gate's cleared error state once it enters the provider slot.
	stalePrior := handler.loadPriorNormalizedQuota(ctx, "claude-1")
	stalePrior.ResetGrantsError = quota.ClaudeResetGrantsErrorRateLimited
	rechecked, err := handler.refreshQuotaReading(ctx, handler.newQuotaService(client), management.AuthFile{AuthIndex: "claude-1", Name: "claude-1.json", Type: "claude", Provider: "claude"}, stalePrior)
	if err != nil {
		t.Fatal(err)
	}
	if rechecked.ResetGrantsError != "" {
		t.Fatalf("fresh-window refresh carried stale ResetGrantsError=%q, want empty from gate", rechecked.ResetGrantsError)
	}

	// Persisting a confirmed empty grants read retains ResetGrantsObserved across snapshot restore.
	if err := handler.persistNormalizedQuotaSnapshot(ctx, &quota.NormalizedQuota{
		AuthIndex:           "claude-2",
		Provider:            "claude",
		Status:              "healthy",
		ObservedAtMS:        handler.now().UnixMilli(),
		Windows:             recovered.Windows,
		ResetGrants:         []quota.ClaudeResetGrant{},
		ResetGrantsObserved: true,
	}); err != nil {
		t.Fatal(err)
	}
	restoredEmpty := handler.loadPriorNormalizedQuota(ctx, "claude-2")
	if restoredEmpty == nil || !restoredEmpty.ResetGrantsObserved || len(restoredEmpty.ResetGrants) != 0 {
		t.Fatalf("restored empty grants snapshot = %+v, want ResetGrantsObserved=true with 0 grants", restoredEmpty)
	}

	overviewAfter, err := handler.buildQuotaOverview(ctx, client)
	if err != nil {
		t.Fatal(err)
	}
	for _, item := range overviewAfter.Quotas {
		if item.AuthIndex == "claude-1" && (item.ResetGrantsError != "" || !item.ResetGrantsObserved) {
			t.Fatalf("overview after recovery = observed:%v err:%q, want observed=true and empty error", item.ResetGrantsObserved, item.ResetGrantsError)
		}
	}
}

func TestClaudeQueuedRefreshPreservesNewestResetGrants(t *testing.T) {
	const authIndex = "claude-1"
	grantsURL := quota.ClaudeUsageURL + "?cedar_ember=1&skip_spend=1"
	file := management.AuthFile{AuthIndex: authIndex, Name: "claude-1.json", Type: "claude", Provider: "claude"}

	seedOldGrant := func(t *testing.T, handler *Handler, observedAtMS int64) {
		t.Helper()
		rem := 90.0
		resetAtMS := observedAtMS + 4*time.Hour.Milliseconds()
		if err := handler.persistNormalizedQuotaSnapshot(context.Background(), &quota.NormalizedQuota{
			AuthIndex:    authIndex,
			Provider:     "claude",
			Status:       "healthy",
			ObservedAtMS: observedAtMS,
			Plan:         &quota.QuotaPlan{PlanType: "max", Tier: "max"},
			Windows: []quota.QuotaWindow{{
				ID:               "five_hour",
				RemainingPercent: &rem,
				ResetAtMS:        &resetAtMS,
			}},
			ResetGrants: []quota.ClaudeResetGrant{{
				ID:          "old-grant",
				ResetsTotal: 2,
				ResetsLeft:  1,
				Clears:      []string{"five_hour"},
			}},
			ResetGrantsObserved: true,
		}); err != nil {
			t.Fatal(err)
		}
	}

	setup := func(t *testing.T, fixture *claudeRateLimitFixture) (*Handler, *management.Client, *time.Time, *sync.Mutex) {
		t.Helper()
		handler := newClaudeRateLimitHandler(t, fixture)
		var clockMu sync.Mutex
		now := time.Now().UTC().Truncate(time.Second)
		handler.nowFn = func() time.Time {
			clockMu.Lock()
			defer clockMu.Unlock()
			return now
		}
		seedOldGrant(t, handler, now.Add(-10*time.Minute).UnixMilli())
		instance, err := handler.repo.GetInstance(context.Background(), defaultInstanceID())
		if err != nil {
			t.Fatal(err)
		}
		client, err := handler.clientForInstance(context.Background(), instance)
		if err != nil {
			t.Fatal(err)
		}
		return handler, client, &now, &clockMu
	}

	t.Run("replaces old grant with new grant across queued refresh", func(t *testing.T) {
		ctx := context.Background()
		fixture := &claudeRateLimitFixture{claudeRequests: map[string]int{}, claudeURLs: map[string]int{}, codexReads: map[string]int{}}
		handler, client, now, clockMu := setup(t, fixture)

		priorFirst := handler.loadPriorNormalizedQuota(ctx, authIndex)
		priorQueued := handler.loadPriorNormalizedQuota(ctx, authIndex)

		first, err := handler.refreshQuotaReading(ctx, handler.newQuotaService(client), file, priorFirst)
		if err != nil {
			t.Fatal(err)
		}
		if err := handler.persistNormalizedQuotaSnapshot(ctx, first); err != nil {
			t.Fatal(err)
		}
		if len(first.ResetGrants) != 1 || first.ResetGrants[0].ID != "grant-1" || !first.ResetGrantsObserved || first.ResetGrantsError != "" {
			t.Fatalf("first read grants = %+v observed=%v err=%q, want grant-1", first.ResetGrants, first.ResetGrantsObserved, first.ResetGrantsError)
		}

		clockMu.Lock()
		*now = now.Add(time.Second)
		clockMu.Unlock()

		queued, err := handler.refreshQuotaReading(ctx, handler.newQuotaService(client), file, priorQueued)
		if err != nil {
			t.Fatal(err)
		}
		if err := handler.persistNormalizedQuotaSnapshot(ctx, queued); err != nil {
			t.Fatal(err)
		}
		if len(queued.ResetGrants) != 1 || queued.ResetGrants[0].ID != "grant-1" || !queued.ResetGrantsObserved || queued.ResetGrantsError != "" {
			t.Fatalf("queued read grants = %+v observed=%v err=%q, want grant-1", queued.ResetGrants, queued.ResetGrantsObserved, queued.ResetGrantsError)
		}

		persisted := handler.loadPriorNormalizedQuota(ctx, authIndex)
		if persisted == nil || len(persisted.ResetGrants) != 1 || persisted.ResetGrants[0].ID != "grant-1" || !persisted.ResetGrantsObserved || persisted.ObservedAtMS != queued.ObservedAtMS {
			t.Fatalf("persisted latest snapshot = %+v, want grant-1 at observed_at_ms=%d", persisted, queued.ObservedAtMS)
		}
		fixture.mu.Lock()
		grantsCalls := fixture.claudeURLs[grantsURL]
		fixture.mu.Unlock()
		if grantsCalls != 1 {
			t.Fatalf("supplementary grant requests = %d, want 1", grantsCalls)
		}
	})

	for _, tc := range []struct {
		name         string
		responseBody string
	}{
		{
			name:         "preserves confirmed empty grants list over old nonempty grant",
			responseBody: `{"status_code": 200, "body": {"cedar_ember": {"eligible": true, "grants": []}}}`,
		},
		{
			name:         "preserves zero grants when cedar_ember is absent over old nonempty grant",
			responseBody: `{"status_code": 200, "body": {}}`,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ctx := context.Background()
			fixture := &claudeRateLimitFixture{
				claudeRequests:     map[string]int{},
				claudeURLs:         map[string]int{},
				codexReads:         map[string]int{},
				grantsResponseBody: tc.responseBody,
			}
			handler, client, now, clockMu := setup(t, fixture)

			priorFirst := handler.loadPriorNormalizedQuota(ctx, authIndex)
			priorQueued := handler.loadPriorNormalizedQuota(ctx, authIndex)

			first, err := handler.refreshQuotaReading(ctx, handler.newQuotaService(client), file, priorFirst)
			if err != nil {
				t.Fatal(err)
			}
			if err := handler.persistNormalizedQuotaSnapshot(ctx, first); err != nil {
				t.Fatal(err)
			}
			if len(first.ResetGrants) != 0 || !first.ResetGrantsObserved || first.ResetGrantsError != "" {
				t.Fatalf("first read grants = %+v observed=%v err=%q, want observed empty list", first.ResetGrants, first.ResetGrantsObserved, first.ResetGrantsError)
			}

			clockMu.Lock()
			*now = now.Add(time.Second)
			clockMu.Unlock()

			queued, err := handler.refreshQuotaReading(ctx, handler.newQuotaService(client), file, priorQueued)
			if err != nil {
				t.Fatal(err)
			}
			if err := handler.persistNormalizedQuotaSnapshot(ctx, queued); err != nil {
				t.Fatal(err)
			}
			if len(queued.ResetGrants) != 0 || !queued.ResetGrantsObserved || queued.ResetGrantsError != "" {
				t.Fatalf("queued read grants = %+v observed=%v err=%q, want observed empty list", queued.ResetGrants, queued.ResetGrantsObserved, queued.ResetGrantsError)
			}

			persisted := handler.loadPriorNormalizedQuota(ctx, authIndex)
			if persisted == nil || len(persisted.ResetGrants) != 0 || !persisted.ResetGrantsObserved {
				t.Fatalf("persisted latest snapshot = %+v, want observed empty grants list", persisted)
			}
			snapshots, err := handler.repo.GetLatestQuotaSnapshots(ctx, []string{authIndex})
			if err != nil {
				t.Fatal(err)
			}
			if snapshots[authIndex].ResetGrantsJSON != "[]" {
				t.Fatalf("persisted reset_grants_json = %q, want \"[]\"", snapshots[authIndex].ResetGrantsJSON)
			}
			fixture.mu.Lock()
			grantsCalls := fixture.claudeURLs[grantsURL]
			fixture.mu.Unlock()
			if grantsCalls != 1 {
				t.Fatalf("supplementary grant requests = %d, want 1", grantsCalls)
			}
		})
	}

	t.Run("supplemental failure retains last successful grants and exposes error", func(t *testing.T) {
		ctx := context.Background()
		fixture := &claudeRateLimitFixture{
			claudeRequests:   map[string]int{},
			claudeURLs:       map[string]int{},
			codexReads:       map[string]int{},
			isGrantsRefused:  true,
			retryAfterSecond: 60,
		}
		handler, client, now, clockMu := setup(t, fixture)

		priorInitial := handler.loadPriorNormalizedQuota(ctx, authIndex)
		priorQueued := handler.loadPriorNormalizedQuota(ctx, authIndex)

		// Initial failure before any in-gate success preserves persisted old-grant and exposes error.
		failed, err := handler.refreshQuotaReading(ctx, handler.newQuotaService(client), file, priorInitial)
		if err != nil {
			t.Fatal(err)
		}
		if err := handler.persistNormalizedQuotaSnapshot(ctx, failed); err != nil {
			t.Fatal(err)
		}
		if len(failed.ResetGrants) != 1 || failed.ResetGrants[0].ID != "old-grant" || !failed.ResetGrantsObserved || failed.ResetGrantsError != quota.ClaudeResetGrantsErrorRateLimited {
			t.Fatalf("failed read = grants:%+v observed:%v err:%q, want old-grant with rate_limited", failed.ResetGrants, failed.ResetGrantsObserved, failed.ResetGrantsError)
		}

		// A queued refresh inside the failure cooldown retains old-grant, exposes the error, and skips upstream.
		clockMu.Lock()
		*now = now.Add(time.Second)
		clockMu.Unlock()
		queuedFailed, err := handler.refreshQuotaReading(ctx, handler.newQuotaService(client), file, priorQueued)
		if err != nil {
			t.Fatal(err)
		}
		if len(queuedFailed.ResetGrants) != 1 || queuedFailed.ResetGrants[0].ID != "old-grant" || !queuedFailed.ResetGrantsObserved || queuedFailed.ResetGrantsError != quota.ClaudeResetGrantsErrorRateLimited {
			t.Fatalf("queued failed read = grants:%+v observed:%v err:%q, want old-grant with rate_limited", queuedFailed.ResetGrants, queuedFailed.ResetGrantsObserved, queuedFailed.ResetGrantsError)
		}
		fixture.mu.Lock()
		if got := fixture.claudeURLs[grantsURL]; got != 1 {
			fixture.mu.Unlock()
			t.Fatalf("supplementary grant requests during failure cooldown = %d, want 1", got)
		}
		fixture.isGrantsRefused = false
		fixture.mu.Unlock()

		// Recover past failure cooldown with grant-1.
		clockMu.Lock()
		*now = now.Add(QUOTA_CLAUDE_RESET_GRANTS_FAILURE_COOLDOWN + time.Second)
		clockMu.Unlock()
		recovered, err := handler.refreshQuotaReading(ctx, handler.newQuotaService(client), file, priorQueued)
		if err != nil {
			t.Fatal(err)
		}
		if err := handler.persistNormalizedQuotaSnapshot(ctx, recovered); err != nil {
			t.Fatal(err)
		}
		if len(recovered.ResetGrants) != 1 || recovered.ResetGrants[0].ID != "grant-1" || !recovered.ResetGrantsObserved || recovered.ResetGrantsError != "" {
			t.Fatalf("recovered read = grants:%+v observed:%v err:%q, want grant-1 with empty error", recovered.ResetGrants, recovered.ResetGrantsObserved, recovered.ResetGrantsError)
		}

		// After the 1-hour success TTL expires, a supplemental failure still retains grant-1
		// (even if the caller holds an older prior snapshot with old-grant) and exposes the error.
		fixture.mu.Lock()
		fixture.isGrantsRefused = true
		fixture.mu.Unlock()
		clockMu.Lock()
		*now = now.Add(QUOTA_CLAUDE_RESET_GRANTS_MAX_AGE + time.Second)
		clockMu.Unlock()
		staleRetryFailed, err := handler.refreshQuotaReading(ctx, handler.newQuotaService(client), file, priorQueued)
		if err != nil {
			t.Fatal(err)
		}
		if err := handler.persistNormalizedQuotaSnapshot(ctx, staleRetryFailed); err != nil {
			t.Fatal(err)
		}
		if len(staleRetryFailed.ResetGrants) != 1 || staleRetryFailed.ResetGrants[0].ID != "grant-1" || !staleRetryFailed.ResetGrantsObserved || staleRetryFailed.ResetGrantsError != quota.ClaudeResetGrantsErrorRateLimited {
			t.Fatalf("post-TTL failed read = grants:%+v observed:%v err:%q, want grant-1 with rate_limited", staleRetryFailed.ResetGrants, staleRetryFailed.ResetGrantsObserved, staleRetryFailed.ResetGrantsError)
		}

		// A queued refresh inside the new failure cooldown also retains grant-1 and exposes the error
		// without issuing another supplementary grant request.
		clockMu.Lock()
		*now = now.Add(time.Second)
		clockMu.Unlock()
		queuedAfterPostTTLFail, err := handler.refreshQuotaReading(ctx, handler.newQuotaService(client), file, priorQueued)
		if err != nil {
			t.Fatal(err)
		}
		if len(queuedAfterPostTTLFail.ResetGrants) != 1 || queuedAfterPostTTLFail.ResetGrants[0].ID != "grant-1" || !queuedAfterPostTTLFail.ResetGrantsObserved || queuedAfterPostTTLFail.ResetGrantsError != quota.ClaudeResetGrantsErrorRateLimited {
			t.Fatalf("queued post-TTL failed read = grants:%+v observed:%v err:%q, want grant-1 with rate_limited", queuedAfterPostTTLFail.ResetGrants, queuedAfterPostTTLFail.ResetGrantsObserved, queuedAfterPostTTLFail.ResetGrantsError)
		}
		fixture.mu.Lock()
		grantsCalls := fixture.claudeURLs[grantsURL]
		fixture.mu.Unlock()
		if grantsCalls != 3 {
			t.Fatalf("supplementary grant requests = %d, want 3 (initial fail, recovery, post-TTL fail)", grantsCalls)
		}
	})

	t.Run("concurrent queued refresh before first persistence preserves newest grants", func(t *testing.T) {
		ctx := context.Background()
		inFirstGrants := make(chan struct{})
		releaseFirstGrants := make(chan struct{})
		var once, releaseOnce sync.Once
		releaseFirst := func() { releaseOnce.Do(func() { close(releaseFirstGrants) }) }
		fixture := &claudeRateLimitFixture{
			claudeRequests: map[string]int{},
			claudeURLs:     map[string]int{},
			codexReads:     map[string]int{},
			onGrantsRequest: func() {
				once.Do(func() {
					close(inFirstGrants)
					<-releaseFirstGrants
				})
			},
		}
		handler, client, now, clockMu := setup(t, fixture)
		// Registered after setup so LIFO cleanup unblocks the fake CPA handler before closing the server.
		t.Cleanup(releaseFirst)

		priorFirst := handler.loadPriorNormalizedQuota(ctx, authIndex)
		priorQueued := handler.loadPriorNormalizedQuota(ctx, authIndex)

		firstDone := make(chan *quota.NormalizedQuota, 1)
		firstErr := make(chan error, 1)
		go func() {
			reading, err := handler.refreshQuotaReading(ctx, handler.newQuotaService(client), file, priorFirst)
			firstErr <- err
			firstDone <- reading
		}()

		// Wait until the first refresh holds the Claude gate slot in its grants request.
		waitTimer := time.NewTimer(5 * time.Second)
		defer waitTimer.Stop()
		select {
		case <-inFirstGrants:
		case err := <-firstErr:
			t.Fatalf("first refresh finished before grants request: err=%v reading=%+v", err, <-firstDone)
		case <-waitTimer.C:
			t.Fatal("timed out waiting for first refresh to reach grants request")
		}

		queuedDone := make(chan *quota.NormalizedQuota, 1)
		queuedErr := make(chan error, 1)
		go func() {
			reading, err := handler.refreshQuotaReading(ctx, handler.newQuotaService(client), file, priorQueued)
			queuedErr <- err
			queuedDone <- reading
		}()

		// Advance clock and release the first refresh; the queued refresh enters the gate before
		// the first refresh persists its snapshot to SQLite.
		clockMu.Lock()
		*now = now.Add(time.Second)
		clockMu.Unlock()
		releaseFirst()

		firstReading := <-firstDone
		if err := <-firstErr; err != nil {
			t.Fatal(err)
		}
		queuedReading := <-queuedDone
		if err := <-queuedErr; err != nil {
			t.Fatal(err)
		}
		// Persist in either order — even persisting queued before first keeps grant-1.
		if err := handler.persistNormalizedQuotaSnapshot(ctx, queuedReading); err != nil {
			t.Fatal(err)
		}
		if err := handler.persistNormalizedQuotaSnapshot(ctx, firstReading); err != nil {
			t.Fatal(err)
		}

		if queuedReading.ObservedAtMS <= firstReading.ObservedAtMS {
			t.Fatalf("queued ObservedAtMS = %d, want > first ObservedAtMS %d", queuedReading.ObservedAtMS, firstReading.ObservedAtMS)
		}
		if len(queuedReading.ResetGrants) != 1 || queuedReading.ResetGrants[0].ID != "grant-1" {
			t.Fatalf("queued concurrent read grants = %+v, want grant-1", queuedReading.ResetGrants)
		}
		persisted := handler.loadPriorNormalizedQuota(ctx, authIndex)
		if persisted == nil || len(persisted.ResetGrants) != 1 || persisted.ResetGrants[0].ID != "grant-1" || persisted.ObservedAtMS != queuedReading.ObservedAtMS {
			t.Fatalf("persisted snapshot after concurrent refresh = %+v, want grant-1 at observed_at_ms=%d", persisted, queuedReading.ObservedAtMS)
		}
		fixture.mu.Lock()
		grantsCalls := fixture.claudeURLs[grantsURL]
		fixture.mu.Unlock()
		if grantsCalls != 1 {
			t.Fatalf("supplementary grant requests = %d, want 1", grantsCalls)
		}
	})

	for _, tc := range []struct {
		name            string
		responseBody    string
		isGrantsRefused bool
		wantGrantIDs    []string
		wantGrantsErr   string
	}{
		{
			name:         "HTTP refresh wire response preserves new grant across queued requests",
			responseBody: "",
			wantGrantIDs: []string{"grant-1"},
		},
		{
			name:         "HTTP refresh wire response preserves observed empty grants across queued requests",
			responseBody: `{"status_code": 200, "body": {"cedar_ember": {"eligible": true, "grants": []}}}`,
			wantGrantIDs: nil,
		},
		{
			name:            "HTTP refresh wire response retains prior grant and exposes rate_limited across queued requests",
			isGrantsRefused: true,
			wantGrantIDs:    []string{"old-grant"},
			wantGrantsErr:   quota.ClaudeResetGrantsErrorRateLimited,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			inFirstGrants := make(chan struct{})
			releaseFirstGrants := make(chan struct{})
			secondLoadedPrior := make(chan struct{})
			var firstInGrants atomic.Bool
			var grantsOnce, secondOnce, releaseOnce sync.Once
			releaseFirst := func() { releaseOnce.Do(func() { close(releaseFirstGrants) }) }
			fixture := &claudeRateLimitFixture{
				claudeRequests:     map[string]int{},
				claudeURLs:         map[string]int{},
				codexReads:         map[string]int{},
				isGrantsRefused:    tc.isGrantsRefused,
				retryAfterSecond:   60,
				grantsResponseBody: tc.responseBody,
				onGrantsRequest: func() {
					grantsOnce.Do(func() {
						firstInGrants.Store(true)
						close(inFirstGrants)
						<-releaseFirstGrants
					})
				},
			}
			handler, _, now, clockMu := setup(t, fixture)
			// Registered after setup so LIFO cleanup unblocks the fake CPA handler before closing the server.
			t.Cleanup(releaseFirst)
			baseNowFn := handler.nowFn
			handler.nowFn = func() time.Time {
				if firstInGrants.Load() {
					secondOnce.Do(func() { close(secondLoadedPrior) })
				}
				return baseNowFn()
			}

			postRefresh := func() *httptest.ResponseRecorder {
				rec := httptest.NewRecorder()
				req := httptest.NewRequest(http.MethodPost, "/api/v1/management/quota/refresh", bytes.NewBufferString(`{"auth_index":"claude-1"}`))
				handler.refreshCredentialQuota(rec, req)
				return rec
			}

			assertWireQuota := func(t *testing.T, label string, rawQuota map[string]any) {
				t.Helper()
				observed, ok := rawQuota["reset_grants_observed"].(bool)
				if !ok || !observed {
					t.Fatalf("%s: wire reset_grants_observed = %#v, want explicit true", label, rawQuota["reset_grants_observed"])
				}
				gotErr, _ := rawQuota["reset_grants_error"].(string)
				if gotErr != tc.wantGrantsErr {
					t.Fatalf("%s: wire reset_grants_error = %#v, want %q", label, rawQuota["reset_grants_error"], tc.wantGrantsErr)
				}
				if tc.wantGrantsErr == "" {
					if rawErr, hasErr := rawQuota["reset_grants_error"]; hasErr && rawErr != "" {
						t.Fatalf("%s: wire reset_grants_error = %#v, want absent/empty", label, rawErr)
					}
				}
				var gotIDs []string
				if rawGrants, hasGrants := rawQuota["reset_grants"]; hasGrants && rawGrants != nil {
					list, ok := rawGrants.([]any)
					if !ok {
						t.Fatalf("%s: wire reset_grants = %T, want array", label, rawGrants)
					}
					for _, item := range list {
						entry, ok := item.(map[string]any)
						if !ok {
							t.Fatalf("%s: wire grant entry = %T, want object", label, item)
						}
						id, _ := entry["id"].(string)
						gotIDs = append(gotIDs, id)
					}
				}
				if len(gotIDs) != len(tc.wantGrantIDs) {
					t.Fatalf("%s: wire reset_grants IDs = %v, want %v", label, gotIDs, tc.wantGrantIDs)
				}
				for i := range tc.wantGrantIDs {
					if gotIDs[i] != tc.wantGrantIDs[i] {
						t.Fatalf("%s: wire reset_grants IDs = %v, want %v", label, gotIDs, tc.wantGrantIDs)
					}
				}
			}

			firstRecCh := make(chan *httptest.ResponseRecorder, 1)
			go func() { firstRecCh <- postRefresh() }()

			firstTimer := time.NewTimer(5 * time.Second)
			defer firstTimer.Stop()
			select {
			case <-inFirstGrants:
			case rec := <-firstRecCh:
				t.Fatalf("first HTTP refresh finished before grants request: status=%d body=%s", rec.Code, rec.Body.String())
			case <-firstTimer.C:
				t.Fatal("timed out waiting for first HTTP refresh to reach grants request")
			}

			queuedRecCh := make(chan *httptest.ResponseRecorder, 1)
			go func() { queuedRecCh <- postRefresh() }()

			// Wait until the queued HTTP request has loaded old-grant from SQLite and entered
			// refreshQuotaReading before advancing the clock and releasing the first request.
			secondTimer := time.NewTimer(5 * time.Second)
			defer secondTimer.Stop()
			select {
			case <-secondLoadedPrior:
			case rec := <-queuedRecCh:
				t.Fatalf("queued HTTP refresh finished before reaching provider gate: status=%d body=%s", rec.Code, rec.Body.String())
			case <-secondTimer.C:
				t.Fatal("timed out waiting for queued HTTP refresh to load prior and enter gate")
			}
			clockMu.Lock()
			*now = now.Add(time.Second)
			clockMu.Unlock()
			releaseFirst()

			firstRec := <-firstRecCh
			queuedRec := <-queuedRecCh

			for label, rec := range map[string]*httptest.ResponseRecorder{"first HTTP refresh": firstRec, "queued HTTP refresh": queuedRec} {
				if rec.Code != http.StatusOK {
					t.Fatalf("%s status = %d, want 200: %s", label, rec.Code, rec.Body.String())
				}
				var body struct {
					Status string         `json:"status"`
					Quota  map[string]any `json:"quota"`
				}
				if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
					t.Fatalf("%s decode error: %v", label, err)
				}
				if body.Status != "ok" {
					t.Fatalf("%s body.status = %q, want ok", label, body.Status)
				}
				assertWireQuota(t, label, body.Quota)
			}

			// Verify the persisted wire representation returned by GET /api/v1/management/quota.
			overviewRec := httptest.NewRecorder()
			overviewReq := httptest.NewRequest(http.MethodGet, "/api/v1/management/quota", nil)
			handler.getQuotaOverview(overviewRec, overviewReq)
			if overviewRec.Code != http.StatusOK {
				t.Fatalf("overview status = %d, want 200: %s", overviewRec.Code, overviewRec.Body.String())
			}
			var overviewBody struct {
				Quotas []map[string]any `json:"quotas"`
			}
			if err := json.Unmarshal(overviewRec.Body.Bytes(), &overviewBody); err != nil {
				t.Fatalf("overview decode error: %v", err)
			}
			foundClaude := false
			for _, item := range overviewBody.Quotas {
				if item["auth_index"] == authIndex {
					foundClaude = true
					assertWireQuota(t, "overview HTTP wire response", item)
				}
			}
			if !foundClaude {
				t.Fatalf("overview response missing %s", authIndex)
			}

			fixture.mu.Lock()
			grantsCalls := fixture.claudeURLs[grantsURL]
			fixture.mu.Unlock()
			if grantsCalls != 1 {
				t.Fatalf("supplementary grant requests = %d, want 1", grantsCalls)
			}
		})
	}
}
