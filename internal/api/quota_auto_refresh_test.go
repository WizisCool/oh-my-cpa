package api

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/crypto"
	"github.com/oh-my-cpa/oh-my-cpa/internal/domain"
	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
)

// quotaAutoRefreshFixture is a gateway listing one credential per scheduling case and
// counting the usage reads and cooldown resets it is asked to make, per credential.
type quotaAutoRefreshFixture struct {
	mu               sync.Mutex
	reads            map[string]int
	resets           map[string]int
	isUsageFailed    bool
	isUsageExhausted bool
}

func (f *quotaAutoRefreshFixture) usageReads(authIndex string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.reads[authIndex]
}

func (f *quotaAutoRefreshFixture) cooldownResets(authIndex string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.resets[authIndex]
}

func newQuotaAutoRefreshHandler(t *testing.T, fixture *quotaAutoRefreshFixture) *Handler {
	t.Helper()
	const managementKey = "management-secret"
	cpaServer := newFakeCPA(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Header.Get("Authorization") != "Bearer "+managementKey {
			writer.WriteHeader(http.StatusUnauthorized)
			return
		}
		writer.Header().Set("Content-Type", "application/json")
		switch request.URL.Path {
		case "/v8/management/credentials":
			_, _ = writer.Write([]byte(`{"files": [
				{"id": "f-reset", "name": "codex-reset.json", "auth_index": "codex-reset", "type": "codex", "provider": "codex"},
				{"id": "f-fresh", "name": "codex-fresh.json", "auth_index": "codex-fresh", "type": "codex", "provider": "codex"},
				{"id": "f-unread", "name": "codex-unread.json", "auth_index": "codex-unread", "type": "codex", "provider": "codex"},
				{"id": "f-off", "name": "codex-off.json", "auth_index": "codex-off", "type": "codex", "provider": "codex", "disabled": true},
				{"id": "f-meta", "name": "meta.json", "auth_index": "meta-reset", "type": "meta", "provider": "meta"},
				{"id": "f-dup-1", "name": "dup-1.json", "auth_index": "codex-dup", "type": "codex", "provider": "codex"},
				{"id": "f-dup-2", "name": "dup-2.json", "auth_index": "codex-dup", "type": "codex", "provider": "codex"}
			]}`))
		case "/v8/management/requests/api-call":
			var payload struct {
				AuthIndex string `json:"auth_index"`
				URL       string `json:"url"`
			}
			_ = json.NewDecoder(request.Body).Decode(&payload)
			if !strings.Contains(payload.URL, "backend-api/wham/usage") {
				_, _ = writer.Write([]byte(`{"status_code": 404, "body": {}}`))
				return
			}
			fixture.mu.Lock()
			fixture.reads[payload.AuthIndex]++
			isFailed := fixture.isUsageFailed
			usedPercent := 3
			if fixture.isUsageExhausted {
				usedPercent = 100
			}
			fixture.mu.Unlock()
			if isFailed {
				_, _ = writer.Write([]byte(`{"status_code": 500, "body": {"message": "upstream unavailable"}}`))
				return
			}
			_, _ = fmt.Fprintf(writer, `{"status_code": 200, "body": {
				"plan_type": "pro",
				"rate_limit": {"primary_window": {"used_percent": %d, "limit_window_seconds": 18000, "reset_after_seconds": 18000}}
			}}`, usedPercent)
		case "/v8/management/routing/cooldown/reset":
			var payload struct {
				AuthIndex string `json:"auth_index"`
			}
			_ = json.NewDecoder(request.Body).Decode(&payload)
			fixture.mu.Lock()
			if fixture.resets == nil {
				fixture.resets = map[string]int{}
			}
			fixture.resets[payload.AuthIndex]++
			fixture.mu.Unlock()
			_, _ = writer.Write([]byte(`{}`))
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

func saveAutoRefreshSnapshot(t *testing.T, handler *Handler, authIndex, provider string, observedAtMS, resetAtMS int64) {
	t.Helper()
	windows := fmt.Sprintf(`[{"id":"five_hour","label":"5h","scope":"standard","used_percent":100,"reset_at_ms":%d}]`, resetAtMS)
	if err := handler.repo.SaveQuotaSnapshot(context.Background(), repository.QuotaSnapshotRecord{
		AuthIndex: authIndex, Provider: provider, Status: "exhausted", WindowsJSON: windows, ObservedAtMS: observedAtMS,
	}); err != nil {
		t.Fatal(err)
	}
}

func setAutoRefreshPolicy(t *testing.T, handler *Handler, policy string) {
	t.Helper()
	if err := handler.repo.PutPreference(context.Background(), repository.PreferenceQuotaAutoRefresh, policy); err != nil {
		t.Fatal(err)
	}
}

func TestQuotaAutoRefreshDefaultsReadResetsAndASixHourSchedule(t *testing.T) {
	ctx := context.Background()
	fixture := &quotaAutoRefreshFixture{reads: map[string]int{}}
	handler := newQuotaAutoRefreshHandler(t, fixture)
	nowMS := time.Now().UnixMilli()
	hour := time.Hour.Milliseconds()
	saveAutoRefreshSnapshot(t, handler, "codex-reset", "codex", nowMS-2*hour, nowMS-2*time.Minute.Milliseconds())
	saveAutoRefreshSnapshot(t, handler, "codex-fresh", "codex", nowMS-5*hour, nowMS+4*hour)

	// No stored policy: the reset credential is read after its reset, the one nobody has
	// read is read on schedule, and a five-hour-old reading is not yet six hours old.
	round, err := handler.runQuotaAutoRefreshRound(ctx)
	if err != nil || round.Due != 2 || round.Refreshed != 2 || round.ByReset != 1 {
		t.Fatalf("default round = %+v err=%v", round, err)
	}
	for authIndex, want := range map[string]int{"codex-reset": 1, "codex-unread": 1, "codex-fresh": 0, "codex-off": 0, "meta-reset": 0, "codex-dup": 0} {
		if got := fixture.usageReads(authIndex); got != want {
			t.Errorf("%s read %d times, want %d", authIndex, got, want)
		}
	}
}

func TestQuotaAutoRefreshReadsOnceAfterAReset(t *testing.T) {
	ctx := context.Background()
	fixture := &quotaAutoRefreshFixture{reads: map[string]int{}}
	handler := newQuotaAutoRefreshHandler(t, fixture)
	nowMS := time.Now().UnixMilli()
	hour := time.Hour.Milliseconds()
	saveAutoRefreshSnapshot(t, handler, "codex-reset", "codex", nowMS-5*hour, nowMS-2*time.Minute.Milliseconds())
	saveAutoRefreshSnapshot(t, handler, "codex-fresh", "codex", nowMS-hour, nowMS+4*hour)
	saveAutoRefreshSnapshot(t, handler, "codex-off", "codex", nowMS-5*hour, nowMS-2*time.Minute.Milliseconds())
	saveAutoRefreshSnapshot(t, handler, "meta-reset", "meta", nowMS-5*hour, nowMS-2*time.Minute.Milliseconds())
	saveAutoRefreshSnapshot(t, handler, "codex-dup", "codex", nowMS-5*hour, nowMS-2*time.Minute.Milliseconds())

	setAutoRefreshPolicy(t, handler, `{"interval_minutes":0,"refresh_on_reset":true}`)
	round, err := handler.runQuotaAutoRefreshRound(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if round.Due != 1 || round.Refreshed != 1 || round.ByReset != 1 || round.Failed != 0 {
		t.Fatalf("round = %+v, want exactly the reset credential read", round)
	}
	for authIndex, want := range map[string]int{"codex-reset": 1, "codex-fresh": 0, "codex-unread": 0, "codex-off": 0, "meta-reset": 0, "codex-dup": 0} {
		if got := fixture.usageReads(authIndex); got != want {
			t.Errorf("%s read %d times, want %d", authIndex, got, want)
		}
	}
	snapshots, err := handler.repo.GetLatestQuotaSnapshots(ctx, []string{"codex-reset"})
	if err != nil {
		t.Fatal(err)
	}
	if snapshot := snapshots["codex-reset"]; snapshot.ObservedAtMS < nowMS || snapshot.Status != "healthy" {
		t.Fatalf("stored reading = %+v, want a fresh healthy observation", snapshot)
	}

	// The fresh reading's reset is hours away, so the next tick has nothing to do.
	if round, err := handler.runQuotaAutoRefreshRound(ctx); err != nil || round.Due != 0 {
		t.Fatalf("second round = %+v err=%v, want nothing due", round, err)
	}
	if got := fixture.usageReads("codex-reset"); got != 1 {
		t.Fatalf("codex-reset read %d times, want 1", got)
	}
}

func TestQuotaAutoRefreshDoesNotRepeatAFailedRead(t *testing.T) {
	ctx := context.Background()
	fixture := &quotaAutoRefreshFixture{reads: map[string]int{}, isUsageFailed: true}
	handler := newQuotaAutoRefreshHandler(t, fixture)
	nowMS := time.Now().UnixMilli()
	observedAtMS := nowMS - 5*time.Hour.Milliseconds()
	saveAutoRefreshSnapshot(t, handler, "codex-reset", "codex", observedAtMS, nowMS-2*time.Minute.Milliseconds())
	setAutoRefreshPolicy(t, handler, `{"interval_minutes":0,"refresh_on_reset":true}`)

	round, err := handler.runQuotaAutoRefreshRound(ctx)
	if err != nil || round.Due != 1 || round.Failed != 1 || round.Refreshed != 0 {
		t.Fatalf("round = %+v err=%v, want one failed read", round, err)
	}
	snapshots, err := handler.repo.GetLatestQuotaSnapshots(ctx, []string{"codex-reset"})
	if err != nil {
		t.Fatal(err)
	}
	if snapshots["codex-reset"].ObservedAtMS != observedAtMS {
		t.Fatalf("a failed read replaced the stored observation: %+v", snapshots["codex-reset"])
	}
	if round, err := handler.runQuotaAutoRefreshRound(ctx); err != nil || round.Due != 0 {
		t.Fatalf("second round = %+v err=%v, want the failed read not repeated", round, err)
	}
	if got := fixture.usageReads("codex-reset"); got != 1 {
		t.Fatalf("codex-reset read %d times, want 1", got)
	}
}

func TestQuotaAutoRefreshFollowsTheStoredPolicy(t *testing.T) {
	ctx := context.Background()
	fixture := &quotaAutoRefreshFixture{reads: map[string]int{}}
	handler := newQuotaAutoRefreshHandler(t, fixture)
	nowMS := time.Now().UnixMilli()
	saveAutoRefreshSnapshot(t, handler, "codex-reset", "codex", nowMS-5*time.Hour.Milliseconds(), nowMS-2*time.Minute.Milliseconds())
	saveAutoRefreshSnapshot(t, handler, "codex-fresh", "codex", nowMS-10*time.Minute.Milliseconds(), nowMS+4*time.Hour.Milliseconds())

	if err := handler.repo.PutPreference(ctx, repository.PreferenceQuotaAutoRefresh, `{"interval_minutes":0,"refresh_on_reset":false}`); err != nil {
		t.Fatal(err)
	}
	if round, err := handler.runQuotaAutoRefreshRound(ctx); err != nil || round.Due != 0 || fixture.usageReads("codex-reset") != 0 {
		t.Fatalf("disabled policy round = %+v err=%v reads=%d", round, err, fixture.usageReads("codex-reset"))
	}

	// A schedule reads every enabled credential whose reading is older than the interval,
	// including one nobody has read yet.
	if err := handler.repo.PutPreference(ctx, repository.PreferenceQuotaAutoRefresh, `{"interval_minutes":60,"refresh_on_reset":false}`); err != nil {
		t.Fatal(err)
	}
	round, err := handler.runQuotaAutoRefreshRound(ctx)
	if err != nil || round.Due != 2 || round.Refreshed != 2 || round.ByReset != 0 {
		t.Fatalf("scheduled round = %+v err=%v", round, err)
	}
	for authIndex, want := range map[string]int{"codex-reset": 1, "codex-unread": 1, "codex-fresh": 0, "codex-off": 0, "meta-reset": 0, "codex-dup": 0} {
		if got := fixture.usageReads(authIndex); got != want {
			t.Errorf("%s read %d times, want %d", authIndex, got, want)
		}
	}
}

func TestQuotaAutoRefreshPreferenceIsValidatedOnWrite(t *testing.T) {
	handler := testHandler(t, "")
	server := httptest.NewServer(handler.Router())
	defer server.Close()
	jar, err := cookiejar.New(nil)
	if err != nil {
		t.Fatal(err)
	}
	client := &http.Client{Jar: jar}
	login, err := client.Post(server.URL+"/api/auth/login", "application/json", bytes.NewBufferString(`{"password":"management-secret"}`))
	if err != nil {
		t.Fatal(err)
	}
	login.Body.Close()

	put := func(body string) (int, string) {
		t.Helper()
		request, err := http.NewRequest(http.MethodPut, server.URL+"/api/v1/preferences/"+repository.PreferenceQuotaAutoRefresh, strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		request.Header.Set("Content-Type", "application/json")
		response, err := client.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		var decoded map[string]any
		_ = json.NewDecoder(response.Body).Decode(&decoded)
		message, _ := decoded["error"].(string)
		return response.StatusCode, message
	}
	for _, body := range []string{`{}`, `{"interval_minutes":1,"refresh_on_reset":true}`, `{"interval_minutes":30}`, `true`} {
		if status, message := put(body); status != http.StatusBadRequest || message != "invalid_quota_auto_refresh" {
			t.Fatalf("%s: status=%d error=%q, want 400 invalid_quota_auto_refresh", body, status, message)
		}
	}
	if status, _ := put(`{"interval_minutes":30,"refresh_on_reset":false}`); status != http.StatusOK {
		t.Fatalf("valid policy status = %d", status)
	}
	stored, isStored, err := handler.repo.GetPreference(context.Background(), repository.PreferenceQuotaAutoRefresh)
	if err != nil || !isStored || stored != `{"interval_minutes":30,"refresh_on_reset":false}` {
		t.Fatalf("stored=%q found=%t err=%v", stored, isStored, err)
	}
}

func TestQuotaAutoRefreshClearsOnlyRecoveredCooldowns(t *testing.T) {
	ctx := context.Background()
	fixture := &quotaAutoRefreshFixture{reads: map[string]int{}}
	handler := newQuotaAutoRefreshHandler(t, fixture)
	nowMS := time.Now().UnixMilli()
	hour := time.Hour.Milliseconds()
	insertCooldown := func(eventKey, authIndex string, recoverAtMS int64) {
		t.Helper()
		insertAutoRefreshCooldown(t, handler, eventKey, authIndex, recoverAtMS, nowMS-24*hour)
	}
	// Recovered seven hours ago, outside the 6-hour lookback of the cooldown display.
	insertCooldown("fresh-expired", "codex-fresh", nowMS-7*hour)
	insertCooldown("unread-future", "codex-unread", nowMS+hour)
	// An older cooldown has passed, but a newer one still blocks the credential.
	insertCooldown("reset-past", "codex-reset", nowMS-7*hour)
	insertCooldown("reset-future", "codex-reset", nowMS+hour)
	// No stored readings and no schedule, so a cooldown is the only thing that can be due.
	setAutoRefreshPolicy(t, handler, `{"interval_minutes":0,"refresh_on_reset":true}`)

	round, err := handler.runQuotaAutoRefreshRound(ctx)
	if err != nil || round.Due != 1 || round.CooldownsCleared != 1 || round.Failed != 0 || round.Refreshed != 0 {
		t.Fatalf("round = %+v err=%v, want only the recovered cooldown cleared", round, err)
	}
	for authIndex, want := range map[string]int{"codex-fresh": 1, "codex-unread": 0, "codex-reset": 0} {
		if got := fixture.cooldownResets(authIndex); got != want {
			t.Errorf("%s reset %d times, want %d", authIndex, got, want)
		}
	}
	var remaining int
	if err := handler.repo.SQL().QueryRowContext(ctx, `SELECT COUNT(*) FROM error_events WHERE quota_exceeded = 1 AND auth_index = 'codex-fresh'`).Scan(&remaining); err != nil {
		t.Fatal(err)
	}
	if remaining != 0 {
		t.Fatalf("codex-fresh keeps %d rows of cooldown evidence, want 0", remaining)
	}
	if err := handler.repo.SQL().QueryRowContext(ctx, `SELECT COUNT(*) FROM error_events WHERE quota_exceeded = 1 AND auth_index IN ('codex-unread', 'codex-reset')`).Scan(&remaining); err != nil {
		t.Fatal(err)
	}
	if remaining != 3 {
		t.Fatalf("still-blocked credentials keep %d rows of cooldown evidence, want 3", remaining)
	}
	if clears := automaticCooldownClears(t, handler); len(clears) != 1 || clears["codex-fresh"] != "recovery_time_passed" {
		t.Fatalf("audited automatic clears = %v, want only codex-fresh after its recovery time", clears)
	}

	if round, err := handler.runQuotaAutoRefreshRound(ctx); err != nil || round.Due != 0 {
		t.Fatalf("second round = %+v err=%v, want nothing due", round, err)
	}
}

// insertAutoRefreshCooldown stores the quota_exceeded evidence CPA leaves after a usage-limit 429.
func insertAutoRefreshCooldown(t *testing.T, handler *Handler, eventKey, authIndex string, recoverAtMS, timestampMS int64) {
	t.Helper()
	if _, err := handler.repo.SQL().ExecContext(context.Background(), `
		INSERT INTO error_events (
			instance_id, event_key, provider, model, auth_index, status_code, body,
			retryable, auth_status, auth_disabled, auth_unavailable, quota_exceeded,
			quota_reason, next_recover_at_ms, timestamp_ms, created_at_ms
		) VALUES (
			'default', ?, 'codex', 'gpt-5', ?, 429, 'usage limit reached',
			1, 'active', 0, 0, 1, 'usage_limit_reached', ?, ?, ?
		)
	`, eventKey, authIndex, recoverAtMS, timestampMS, timestampMS); err != nil {
		t.Fatalf("insert %s failed: %v", eventKey, err)
	}
}

func cooldownEvidenceRows(t *testing.T, handler *Handler, authIndex string) int {
	t.Helper()
	var rows int
	if err := handler.repo.SQL().QueryRowContext(context.Background(), `SELECT COUNT(*) FROM error_events WHERE quota_exceeded = 1 AND auth_index = ?`, authIndex).Scan(&rows); err != nil {
		t.Fatal(err)
	}
	return rows
}

func TestQuotaReadReleasesACooldownOnceCapacityIsBack(t *testing.T) {
	ctx := context.Background()
	fixture := &quotaAutoRefreshFixture{reads: map[string]int{}}
	handler := newQuotaAutoRefreshHandler(t, fixture)
	nowMS := time.Now().UnixMilli()
	hour := time.Hour.Milliseconds()
	// The provider reset the quota early: CPA still holds a recovery time days away.
	insertAutoRefreshCooldown(t, handler, "unread-reset-early", "codex-unread", nowMS+96*hour, nowMS-hour)
	setAutoRefreshPolicy(t, handler, `{"interval_minutes":60,"refresh_on_reset":false}`)

	round, err := handler.runQuotaAutoRefreshRound(ctx)
	if err != nil || round.Refreshed != 3 || round.Failed != 0 {
		t.Fatalf("round = %+v err=%v, want the three unread credentials read", round, err)
	}
	for authIndex, want := range map[string]int{"codex-unread": 1, "codex-reset": 0, "codex-fresh": 0} {
		if got := fixture.cooldownResets(authIndex); got != want {
			t.Errorf("%s reset %d times, want %d", authIndex, got, want)
		}
	}
	if rows := cooldownEvidenceRows(t, handler, "codex-unread"); rows != 0 {
		t.Fatalf("codex-unread keeps %d rows of cooldown evidence, want 0", rows)
	}
	snapshots, err := handler.repo.GetLatestQuotaSnapshots(ctx, []string{"codex-unread"})
	if err != nil {
		t.Fatal(err)
	}
	if status := snapshots["codex-unread"].Status; status != "healthy" {
		t.Fatalf("stored reading status = %q, want healthy", status)
	}
	if clears := automaticCooldownClears(t, handler); len(clears) != 1 || clears["codex-unread"] != "capacity_restored" {
		t.Fatalf("audited automatic clears = %v, want only codex-unread after its read", clears)
	}
}

func TestQuotaReadKeepsTheCooldownWhileAWindowIsUsedUp(t *testing.T) {
	ctx := context.Background()
	fixture := &quotaAutoRefreshFixture{reads: map[string]int{}, isUsageExhausted: true}
	handler := newQuotaAutoRefreshHandler(t, fixture)
	nowMS := time.Now().UnixMilli()
	hour := time.Hour.Milliseconds()
	insertAutoRefreshCooldown(t, handler, "unread-exhausted", "codex-unread", nowMS+hour, nowMS-hour)
	setAutoRefreshPolicy(t, handler, `{"interval_minutes":60,"refresh_on_reset":false}`)

	if round, err := handler.runQuotaAutoRefreshRound(ctx); err != nil || round.Refreshed != 3 {
		t.Fatalf("round = %+v err=%v, want the three unread credentials read", round, err)
	}
	if got := fixture.cooldownResets("codex-unread"); got != 0 {
		t.Fatalf("codex-unread reset %d times, want 0", got)
	}
	if rows := cooldownEvidenceRows(t, handler, "codex-unread"); rows != 1 {
		t.Fatalf("codex-unread keeps %d rows of cooldown evidence, want 1", rows)
	}
	if clears := automaticCooldownClears(t, handler); len(clears) != 0 {
		t.Fatalf("audited automatic clears = %v, want none", clears)
	}
}

// automaticCooldownClears lists the audited automatic releases as auth_index -> reason.
func automaticCooldownClears(t *testing.T, handler *Handler) map[string]string {
	t.Helper()
	events, err := handler.repo.ListAuditEvents(context.Background(), 100)
	if err != nil {
		t.Fatal(err)
	}
	clears := map[string]string{}
	for _, event := range events {
		if event.Action == "quota.clear_cooldown.automatic" && event.Result == "success" {
			clears[event.TargetID], _ = event.Details["reason"].(string)
		}
	}
	return clears
}
