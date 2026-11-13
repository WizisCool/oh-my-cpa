package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/oh-my-cpa/oh-my-cpa/internal/crypto"
	"github.com/oh-my-cpa/oh-my-cpa/internal/domain"
	"github.com/oh-my-cpa/oh-my-cpa/internal/quota"
	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
)

func capacityTestHandler(t *testing.T) *Handler {
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
			_, _ = writer.Write([]byte(`{"files":[{"id":"f-1","name":"codex-1.json","auth_index":"codex-1","type":"codex","provider":"codex"}]}`))
		case "/v8/management/config/oauth/model-alias":
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
		ID: "default", Name: "Default", BaseURL: cpaServer.URL, UsageAddr: "127.0.0.1:8317",
		ManagementKeyCiphertext: ciphertext, ManagementKeyNonce: nonce, CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}
	return handler
}

func insertCapacityUsage(t *testing.T, handler *Handler, key string, timestampMS, tokens int64, costNanos any) {
	t.Helper()
	if _, err := handler.repo.SQL().ExecContext(context.Background(),
		`INSERT INTO usage_events (instance_id, event_key, api_group_key, auth_index, timestamp_ms, created_at_ms, total_tokens, cost_nanos)
		 VALUES ('default', ?, 'group', 'codex-1', ?, ?, ?, ?)`,
		key, timestampMS, timestampMS, tokens, costNanos,
	); err != nil {
		t.Fatal(err)
	}
}

func capacityReading(observedAtMS, resetAtMS int64, periodHours, usedPercent float64) *quota.NormalizedQuota {
	window := func(id, kind, scope string) quota.QuotaWindow {
		used, reset, period := usedPercent, resetAtMS, periodHours
		return quota.QuotaWindow{ID: id, Kind: kind, Scope: scope, UsedPercent: &used, ResetAtMS: &reset, PeriodHours: &period, ResetAccuracy: "exact"}
	}
	return &quota.NormalizedQuota{
		AuthIndex: "codex-1", Provider: "codex", Status: "healthy", ObservedAtMS: observedAtMS,
		Windows: []quota.QuotaWindow{window("five_hour", "five_hour", "standard"), window("code_review", "custom", "code_review")},
	}
}

func observeCapacity(t *testing.T, handler *Handler, reading *quota.NormalizedQuota, nowMS int64) quota.QuotaWindow {
	t.Helper()
	if err := handler.persistNormalizedQuotaSnapshot(context.Background(), reading); err != nil {
		t.Fatal(err)
	}
	handler.attachQuotaCapacity(context.Background(), reading, nowMS)
	return reading.Windows[0]
}

func TestWindowCapacityScopedUsagePrefersServedModel(t *testing.T) {
	handler := capacityTestHandler(t)
	ctx := context.Background()
	nowMS := time.Now().UnixMilli()
	for _, row := range []struct {
		key, requested, served string
		tokens                 int64
	}{
		{"sonnet", "fast", "claude-sonnet-4-5-20250929", 100},
		{"opus", "claude-sonnet-4-5", "claude-opus-4-1", 900},
		{"unknown-alias", "fast", "", 200},
	} {
		insertCapacityUsage(t, handler, row.key, nowMS-120_000, row.tokens, row.tokens*1000)
		if _, err := handler.repo.SQL().ExecContext(ctx, `UPDATE usage_events SET model=?,response_model=? WHERE event_key=?`, row.requested, row.served, row.key); err != nil {
			t.Fatal(err)
		}
	}
	reading := capacityReading(nowMS-60_000, nowMS+2*3600*1000, 5, 20)
	reading.Provider = "claude"
	reading.Windows = reading.Windows[:1]
	reading.Windows[0].Scope = "model"
	reading.Windows[0].Model = "claude-sonnet-4-5"
	window := observeCapacity(t, handler, reading, nowMS)
	if window.Usage == nil || window.Usage.Requests != 1 || window.Usage.Tokens != 100 {
		t.Fatalf("scoped window = %+v, want only the served Sonnet request", window)
	}
	if window.Capacity == nil || window.Capacity.Requests != 5 || window.Capacity.Tokens != 500 || window.Capacity.CostNanos == nil || *window.Capacity.CostNanos != 500_000 {
		t.Fatalf("scoped capacity = %+v, want 5 requests / 500 tokens / 500k nanos", window.Capacity)
	}
}

func getCapacityHistory(t *testing.T, handler *Handler, query string) (int, map[string]any) {
	t.Helper()
	request := httptest.NewRequest(http.MethodGet, "/api/v1/management/quota/codex-1/capacity"+query, nil)
	routeContext := chi.NewRouteContext()
	routeContext.URLParams.Add("authIndex", "codex-1")
	request = request.WithContext(context.WithValue(request.Context(), chi.RouteCtxKey, routeContext))
	recorder := httptest.NewRecorder()
	handler.getQuotaCapacityHistory(recorder, request)
	var body map[string]any
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatalf("body %q: %v", recorder.Body.String(), err)
	}
	return recorder.Code, body
}

func TestQuotaCapacityHistoryRoute(t *testing.T) {
	handler := capacityTestHandler(t)
	const hour = int64(3600 * 1000)
	nowMS := time.Now().UnixMilli()
	previousReset := nowMS - 2*hour
	previousStart := previousReset - 5*hour
	for step, percent := range []float64{20, 40} {
		observedAtMS := previousStart + int64(step+1)*hour
		insertCapacityUsage(t, handler, fmt.Sprintf("previous-%d", step), observedAtMS-hour/2, 1_000_000, 1_000_000_000)
		observeCapacity(t, handler, capacityReading(observedAtMS, previousReset, 5, percent), observedAtMS)
	}
	currentReset := nowMS + 3*hour
	currentStart := currentReset - 5*hour
	insertCapacityUsage(t, handler, "current", currentStart+hour/2, 500_000, 500_000_000)
	observeCapacity(t, handler, capacityReading(nowMS-60_000, currentReset, 5, 10), nowMS)
	if _, err := handler.repo.SQL().ExecContext(context.Background(), `DELETE FROM usage_events WHERE timestamp_ms < ?`, currentStart); err != nil {
		t.Fatal(err)
	}

	status, body := getCapacityHistory(t, handler, "?window=five_hour")
	if status != http.StatusOK {
		t.Fatalf("status = %d (%v), want 200", status, body)
	}
	previous, _ := body["previous"].(map[string]any)
	previousUsage, _ := previous["usage"].(map[string]any)
	if previous["from_ms"] != float64(previousStart) || previous["used_percent"] != float64(40) || previousUsage["requests"] != float64(2) || previousUsage["tokens"] != float64(2_000_000) {
		t.Fatalf("previous = %v, want the frozen cycle from %d with 2 requests", previous, previousStart)
	}
	current, _ := body["current"].(map[string]any)
	currentUsage, _ := current["usage"].(map[string]any)
	if current["from_ms"] != float64(currentStart) || current["reset_at_ms"] != float64(currentReset) || currentUsage["requests"] != float64(1) {
		t.Fatalf("current = %v, want the live cycle from %d with 1 request", current, currentStart)
	}
	capMap, ok := body["capacity"].(map[string]any)
	if !ok || capMap["basis"] != quota.CapacityBasisCurrentWindow || capMap["tokens"] != float64(5_000_000) || capMap["cost_nanos"] != float64(5_000_000_000) {
		t.Fatalf("capacity = %v, want 5M tokens and $5.00 full capacity", body["capacity"])
	}

	for _, probe := range []struct {
		query  string
		status int
	}{
		{"", http.StatusBadRequest},
		{"?window=missing", http.StatusNotFound},
		{"?window=code_review", http.StatusNotFound},
	} {
		if status, body := getCapacityHistory(t, handler, probe.query); status != probe.status {
			t.Errorf("%q: status = %d (%v), want %d", probe.query, status, body, probe.status)
		}
	}
	if _, err := handler.repo.SQL().ExecContext(context.Background(), "DROP TABLE quota_capacity_cycles"); err != nil {
		t.Fatal(err)
	}
	if status, body := getCapacityHistory(t, handler, "?window=five_hour"); status != http.StatusInternalServerError {
		t.Fatalf("unreadable evidence: status = %d (%v), want 500", status, body)
	}
}

func TestWindowCapacityUnreadableEvidence(t *testing.T) {
	handler := capacityTestHandler(t)
	nowMS := time.Now().UnixMilli()
	if _, err := handler.repo.SQL().ExecContext(context.Background(), "DROP TABLE quota_capacity_cycles"); err != nil {
		t.Fatal(err)
	}
	reading := capacityReading(nowMS-60_000, nowMS+3600*1000, 5, 20)
	handler.attachQuotaCapacity(context.Background(), reading, nowMS)
	if window := reading.Windows[0]; window.Capacity != nil || window.CapacityUnavailable != quota.CapacityReasonHistoryUnavailable {
		t.Fatalf("window = %+v, want history_unavailable", window)
	}
}

func TestWindowCapacityDoesNotPersistFailedCooldownObservation(t *testing.T) {
	handler := capacityTestHandler(t)
	ctx := context.Background()
	nowMS := time.Now().UnixMilli()
	current := capacityReading(nowMS, nowMS+3600*1000, 5, 20)
	current.Status = "cooldown"
	current.Error = "upstream timed out"
	if err := handler.persistNormalizedQuotaSnapshot(ctx, current); err != nil {
		t.Fatal(err)
	}
	history, err := handler.repo.GetQuotaSnapshotHistory(ctx, "codex-1", 50)
	if err != nil || len(history) != 0 {
		t.Fatalf("failed reading stored: %+v error=%v", history, err)
	}
	cycles, err := handler.repo.LoadCapacityCycles(ctx, "codex-1")
	if err != nil || len(cycles) != 0 {
		t.Fatalf("failed reading calibrated: %+v error=%v", cycles, err)
	}
}

func TestQuotaCapacityHistorySkipsOverlappingSupersededCycle(t *testing.T) {
	handler := capacityTestHandler(t)
	const day = int64(24 * 3600 * 1000)
	nowMS := time.Now().UnixMilli()

	supersededReset := nowMS + day
	supersededStart := supersededReset - 7*day
	insertCapacityUsage(t, handler, "pre-sub", supersededStart+day, 61_400_000, 10_650_000_000)
	observeCapacity(t, handler, capacityReading(nowMS-2*day, supersededReset, 168, 7), nowMS-2*day)

	activeReset := nowMS + 6*day
	activeStart := activeReset - 7*day
	insertCapacityUsage(t, handler, "active-sub", activeStart+day/2, 455_000_000, 103_720_000_000)
	observeCapacity(t, handler, capacityReading(nowMS-60_000, activeReset, 168, 53), nowMS)

	status, body := getCapacityHistory(t, handler, "?window=five_hour")
	if status != http.StatusOK {
		t.Fatalf("status = %d (%v), want 200", status, body)
	}
	if body["previous"] != nil {
		t.Fatalf("overlapping pre-subscription cycle leaked as previous = %v, want nil", body["previous"])
	}
	current, _ := body["current"].(map[string]any)
	currentUsage, _ := current["usage"].(map[string]any)
	if current["from_ms"] != float64(activeStart) || currentUsage["cost_nanos"] != float64(103_720_000_000) {
		t.Fatalf("current = %v, want active cycle from %d with $103.72", current, activeStart)
	}
}

func insertTraffic(t *testing.T, handler *Handler, model string, count int, fromMS int64) {
	t.Helper()
	for index := range count {
		key := fmt.Sprintf("%s-%d-%d", model, fromMS, index)
		insertCapacityUsage(t, handler, key, fromMS+int64(index), 1000, 1_000_000)
		if _, err := handler.repo.SQL().ExecContext(context.Background(), `UPDATE usage_events SET model=?, input_tokens=1000 WHERE event_key=?`, model, key); err != nil {
			t.Fatal(err)
		}
	}
}

func TestWindowCapacityHandlesMixedModelsRetentionAndHealthGates(t *testing.T) {
	handler := capacityTestHandler(t)
	now := time.Now().UnixMilli()
	reset := now + 2*3600*1000

	// Single snapshot with mixed models immediately sizes full 100% window capacity.
	insertTraffic(t, handler, "gemini-4-hydrogen", 10, now-25_000)
	insertTraffic(t, handler, "gemini-4-carbon", 10, now-15_000)
	reading := capacityReading(now-10_000, reset, 5, 25)
	shared := reading.Windows
	window := observeCapacity(t, handler, reading, now)
	if window.Usage == nil || window.Usage.Requests != 20 || window.Usage.CostNanos != 20_000_000 {
		t.Fatalf("recorded usage = %+v", window.Usage)
	}
	if window.Capacity == nil || window.Capacity.Basis != quota.CapacityBasisCurrentWindow ||
		window.Capacity.Requests != 80 || window.Capacity.Tokens != 80_000 ||
		window.Capacity.CostNanos == nil || *window.Capacity.CostNanos != 80_000_000 {
		t.Fatalf("mixed-model capacity = %+v", window.Capacity)
	}
	if shared[0].Usage != nil || shared[0].Capacity != nil {
		t.Fatal("mutated caller's slice")
	}
	if scoped := reading.Windows[1]; scoped.Usage != nil || scoped.Capacity != nil || scoped.CapacityUnavailable != "" {
		t.Fatalf("feature window changed: %+v", scoped)
	}
	stored, err := handler.repo.GetLatestQuotaSnapshots(context.Background(), []string{"codex-1"})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(stored["codex-1"].WindowsJSON, "capacity") {
		t.Fatal("capacity was persisted into upstream snapshot")
	}

	// Retention pruning and idle refreshes keep both recorded usage and capacity stable.
	if _, err := handler.repo.SQL().ExecContext(context.Background(), `DELETE FROM usage_events`); err != nil {
		t.Fatal(err)
	}
	idle := observeCapacity(t, handler, capacityReading(now-5000, reset, 5, 25), now)
	if !reflect.DeepEqual(idle.Capacity, window.Capacity) || idle.Usage == nil || idle.Usage.Requests != 20 {
		t.Fatalf("idle refresh after retention drifted: usage=%+v capacity=%+v", idle.Usage, idle.Capacity)
	}

	// Hitting 100% freezes capacity at the exhaustion cutoff while still picking up pre-100% late arrivals before the next snapshot.
	observeCapacity(t, handler, capacityReading(now-4000, reset, 5, 100), now)
	insertCapacityUsage(t, handler, "late-pre-full", now-4500, 5000, 5_000_000)
	insertCapacityUsage(t, handler, "paid-overflow", now-3000, 99_000, 99_000_000)
	overflowing := capacityReading(now-2000, reset, 5, 100)
	handler.attachQuotaCapacity(context.Background(), overflowing, now)
	if got := overflowing.Windows[0]; got.Capacity == nil || got.Capacity.Tokens != 25_000 || got.Usage == nil || got.Usage.Tokens != 124_000 {
		t.Fatalf("attachQuotaCapacity before snapshot heal = usage:%+v capacity:%+v", got.Usage, got.Capacity)
	}

	// Persisting the post-100% snapshot preserves full 124k cycle usage across retention while keeping capacity at 25k.
	savedOverflow := observeCapacity(t, handler, overflowing, now)
	if _, err := handler.repo.SQL().ExecContext(context.Background(), `DELETE FROM usage_events`); err != nil {
		t.Fatal(err)
	}
	afterPrune := capacityReading(now-2000, reset, 5, 100)
	handler.attachQuotaCapacity(context.Background(), afterPrune, now)
	if got := afterPrune.Windows[0]; got.Usage == nil || got.Usage.Tokens != 124_000 || got.Capacity == nil || got.Capacity.Tokens != 25_000 || savedOverflow.Capacity == nil || savedOverflow.Capacity.Tokens != 25_000 {
		t.Fatalf("post-100%% retention lost total usage or inflated capacity: %+v", got)
	}

	// Fresh next cycle with 0% used falls back to the previous completed cycle's 100% capacity.
	nextCycle := observeCapacity(t, handler, capacityReading(reset+1000, reset+5*3600*1000, 5, 0), reset+1000)
	if nextCycle.Capacity == nil || nextCycle.Capacity.Basis != quota.CapacityBasisPreviousWindow || nextCycle.Capacity.Tokens != 25_000 {
		t.Fatalf("fresh cycle fallback = %+v, want previous_window 25k tokens", nextCycle.Capacity)
	}

	// Failed refresh during cooldown withholds live capacity estimates.
	if err := handler.repo.SaveQuotaRefreshAttempt(context.Background(), repository.QuotaRefreshAttemptRecord{
		AuthIndex: "codex-1", AttemptedAtMS: reset + 2000, Outcome: repository.QuotaRefreshAttemptFailed, Error: "temporary gateway failure",
	}); err != nil {
		t.Fatal(err)
	}
	status, body := getCapacityHistory(t, handler, "?window=five_hour")
	if status != http.StatusOK || body["capacity"] != nil || body["capacity_unavailable"] != quota.CapacityReasonNoReading {
		t.Fatalf("failed refresh reused capacity: %d %v", status, body)
	}

	if _, err := handler.repo.SQL().ExecContext(context.Background(), `INSERT INTO error_events (
		instance_id, event_key, provider, model, auth_index, status_code, body,
		retryable, auth_status, auth_disabled, auth_unavailable, quota_exceeded,
		quota_reason, next_recover_at_ms, timestamp_ms, created_at_ms
	) VALUES ('default', 'cooldown-1', 'codex', 'gpt-6.1-sol', 'codex-1', 429, 'Rate limit', 1, 'active', 0, 0, 1, 'rate limited', ?, ?, ?)`,
		reset+60_000, reset+1500, reset+1500,
	); err != nil {
		t.Fatal(err)
	}
	client, err := handler.capabilityClient(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	overview, err := handler.buildQuotaOverview(context.Background(), client)
	if err != nil || len(overview.Quotas) != 1 {
		t.Fatalf("overview = %+v, %v", overview, err)
	}
	if item := overview.Quotas[0]; item.Status != "cooldown" || item.Windows[0].Capacity != nil || item.Windows[0].CapacityUnavailable != quota.CapacityReasonNoReading {
		t.Fatalf("overview failed refresh during cooldown = %+v", item)
	}

	for _, st := range []string{"stale", "error"} {
		failed := capacityReading(now-5000, reset, 5, 25)
		failed.Status = st
		handler.attachQuotaCapacity(context.Background(), failed, now)
		if failed.Windows[0].Capacity != nil {
			t.Fatalf("%s observation estimated capacity: %+v", st, failed)
		}
	}
	expired := capacityReading(now-5000, reset, 5, 25)
	handler.attachQuotaCapacity(context.Background(), expired, reset)
	if expired.Windows[0].Capacity != nil || expired.Windows[0].CapacityUnavailable != quota.CapacityReasonExpired {
		t.Fatalf("expired = %+v", expired.Windows[0])
	}
}

func TestAttachQuotaCapacityReconcilesPreResetLateUsageAndLongRunningTail(t *testing.T) {
	handler := capacityTestHandler(t)
	ctx := context.Background()
	const hour = int64(3600 * 1000)
	now := time.Now().UnixMilli()
	reset := now + hour
	cycleStart := reset - 5*hour

	// Pre-reset 50% -> mid-cycle 0% reset (with 10 recorded requests) -> post-reset 10% (with 2 new requests = 12 total -> capacity 20).
	insertTraffic(t, handler, "gemini-4-hydrogen", 10, cycleStart+hour)
	observeCapacity(t, handler, capacityReading(cycleStart+2*hour, reset, 5, 50), now)
	observeCapacity(t, handler, capacityReading(cycleStart+3*hour, reset, 5, 0), now)
	insertTraffic(t, handler, "gemini-4-hydrogen", 2, cycleStart+3*hour+10_000)
	observeCapacity(t, handler, capacityReading(cycleStart+3*hour+60_000, reset, 5, 10), now)

	// Prune 9 of the 10 pre-reset rows so reconstruction via checkpoint wins over raw live scan.
	if _, err := handler.repo.SQL().ExecContext(ctx, `DELETE FROM usage_events WHERE id IN (SELECT id FROM usage_events ORDER BY id ASC LIMIT 9)`); err != nil {
		t.Fatal(err)
	}
	// A delayed pre-reset request arrives after the 10% checkpoint, plus a long-running request that started 20m before the checkpoint and finished after it.
	insertCapacityUsage(t, handler, "delayed-pre-reset", cycleStart+2*hour+30_000, 1000, 1_000_000)
	if _, err := handler.repo.SQL().ExecContext(ctx, `INSERT INTO usage_events (
		instance_id, event_key, api_group_key, auth_index, model, timestamp_ms, latency_ms, created_at_ms, input_tokens, total_tokens, cost_nanos
	) VALUES ('default', 'long-tail-post-checkpoint', 'group', 'codex-1', 'gemini-4-hydrogen', ?, ?, ?, 1000, 1000, 1000000)`,
		cycleStart+3*hour+60_000-20*60*1000, 25*60*1000, now,
	); err != nil {
		t.Fatal(err)
	}

	readBack := capacityReading(cycleStart+4*hour, reset, 5, 10)
	handler.attachQuotaCapacity(ctx, readBack, now)
	got := readBack.Windows[0]
	// Total usage = 10 original + 2 post-reset + 1 delayed pre-reset + 1 long-running post-checkpoint = 14 requests.
	// Post-reset segment = 14 total - 11 reconciled reset baseline = 3 requests at 10% => 30 estimated requests (not 40 from stale baseline 10, nor 20 from dropped long-tail).
	if got.Usage == nil || got.Usage.Requests != 14 {
		t.Fatalf("reconstructed usage = %+v, want 14 requests (including delayed pre-reset and >15m long-running tail)", got.Usage)
	}
	if got.Capacity == nil || got.Capacity.Requests != 30 {
		t.Fatalf("post-reset capacity = %+v, want 30 requests after reconciling reset baseline", got.Capacity)
	}
}
