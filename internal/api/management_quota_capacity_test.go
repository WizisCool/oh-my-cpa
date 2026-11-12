package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/oh-my-cpa/oh-my-cpa/internal/domain"
	"github.com/oh-my-cpa/oh-my-cpa/internal/quota"
)

func capacityTestHandler(t *testing.T) *Handler {
	t.Helper()
	handler := testHandler(t, "")
	now := time.Now().UTC()
	if err := handler.repo.UpsertInstance(context.Background(), domain.CPAInstance{
		ID: "default", Name: "Default", BaseURL: "http://127.0.0.1:8317", UsageAddr: "127.0.0.1:8317",
		ManagementKeyCiphertext: []byte{0}, ManagementKeyNonce: []byte{0}, CreatedAt: now, UpdatedAt: now,
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

// capacityReading is a Codex reading of one window, plus a feature-scoped
// window the estimate does not apply to.
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

// observeCapacity saves a reading the way a refresh does and reads it back.
func observeCapacity(t *testing.T, handler *Handler, reading *quota.NormalizedQuota, nowMS int64) quota.QuotaWindow {
	t.Helper()
	if err := handler.persistNormalizedQuotaSnapshot(context.Background(), reading); err != nil {
		t.Fatal(err)
	}
	handler.attachWindowCapacity(context.Background(), reading, nowMS)
	return reading.Windows[0]
}

func TestAttachWindowCapacity(t *testing.T) {
	handler := capacityTestHandler(t)
	ctx := context.Background()
	nowMS := time.Now().UnixMilli()
	resetAtMS := nowMS + 2*3600*1000
	cycleStartMS := resetAtMS - 5*3600*1000
	observedAtMS := nowMS - 60_000

	insertCapacityUsage(t, handler, "previous-cycle", cycleStartMS-1, 9_000_000, 9_000_000_000)
	insertCapacityUsage(t, handler, "in-cycle-1", cycleStartMS, 300_000, 400_000_000)
	insertCapacityUsage(t, handler, "in-cycle-2", observedAtMS-1, 200_000, 600_000_000)
	insertCapacityUsage(t, handler, "failed", observedAtMS-1, 0, nil)
	insertCapacityUsage(t, handler, "after-observation", observedAtMS, 5_000_000, 5_000_000_000)
	// Started before the reading but finished after it: upstream meters it later.
	insertCapacityUsage(t, handler, "in-flight", observedAtMS-2000, 1_000_000, 1_000_000_000)
	if _, err := handler.repo.SQL().ExecContext(ctx, `UPDATE usage_events SET latency_ms = 5000 WHERE event_key = 'in-flight'`); err != nil {
		t.Fatal(err)
	}

	reading := capacityReading(observedAtMS, resetAtMS, 5, 20)
	shared := reading.Windows
	window := observeCapacity(t, handler, reading, nowMS)
	if window.Usage == nil || window.Usage.Requests != 2 || window.Usage.Tokens != 500_000 || window.Usage.CostNanos != 1_000_000_000 {
		t.Fatalf("usage = %+v, want the two finished requests between the cycle start and the reading", window.Usage)
	}
	if window.Usage.FromMS != cycleStartMS || window.Usage.ToMS != observedAtMS {
		t.Fatalf("usage range = [%d, %d), want [%d, %d)", window.Usage.FromMS, window.Usage.ToMS, cycleStartMS, observedAtMS)
	}
	capacity := window.Capacity
	if capacity == nil || capacity.Basis != "current_cycle" || capacity.Tokens != 2_500_000 || capacity.CostNanos == nil || *capacity.CostNanos != 5_000_000_000 {
		t.Fatalf("capacity = %+v, want the cycle's usage scaled by 100/20", capacity)
	}
	if capacity.RemainingTokens == nil || *capacity.RemainingTokens != 2_000_000 || capacity.ErrorPercent != 2.6 {
		t.Fatalf("capacity = %+v, want 80%% remaining and the rounding of one reading", capacity)
	}

	// A feature-scoped window has no metered model mapping and carries neither a
	// usage figure nor a reason: the estimate does not apply to it at all.
	if scoped := reading.Windows[1]; scoped.Usage != nil || scoped.Capacity != nil || scoped.CapacityUnavailable != "" {
		t.Fatalf("feature-scoped window = %+v, want it left untouched", scoped)
	}
	// A failed refresh shares its windows with the prior observation, and a
	// snapshot is marshalled from that slice.
	if shared[0].Usage != nil || shared[0].Capacity != nil {
		t.Fatal("the caller's window slice was edited in place")
	}
	latest, err := handler.repo.GetLatestQuotaSnapshots(ctx, []string{"codex-1"})
	if err != nil {
		t.Fatal(err)
	}
	var stored []quota.QuotaWindow
	if err := json.Unmarshal([]byte(latest["codex-1"].WindowsJSON), &stored); err != nil {
		t.Fatal(err)
	}
	if stored[0].Usage != nil || stored[0].Capacity != nil || stored[0].CapacityUnavailable != "" {
		t.Fatalf("a read-time join was stored: %+v", stored[0])
	}

	// A refresh that failed keeps the dated estimate but states nothing as left.
	stale := capacityReading(observedAtMS, resetAtMS, 5, 20)
	stale.Status = "stale"
	handler.attachWindowCapacity(ctx, stale, nowMS)
	if capacity := stale.Windows[0].Capacity; capacity == nil || capacity.Tokens != 2_500_000 || capacity.RemainingTokens != nil {
		t.Fatalf("stale window = %+v, want the dated capacity without a remaining amount", stale.Windows[0])
	}
}

// The reported symptom: a credential that was exhausted and then served nothing
// must keep one estimate for days - through idle refreshes, snapshot and request
// record retention, and the reset into an unused cycle.
func TestWindowCapacityIdleEstimateIsStable(t *testing.T) {
	handler := capacityTestHandler(t)
	ctx := context.Background()
	const hour = int64(3600 * 1000)
	cycleStart := time.Now().UnixMilli() - 6*24*hour
	resetAtMS := cycleStart + 168*hour

	for step, percent := range []float64{10, 40, 100} {
		observedAtMS := cycleStart + int64(step+1)*2*hour
		insertCapacityUsage(t, handler, fmt.Sprintf("burst-%d", step), observedAtMS-hour, 1_000_000, 7_000_000_000)
		observeCapacity(t, handler, capacityReading(observedAtMS, resetAtMS, 168, percent), observedAtMS)
	}
	exhaustedAt := cycleStart + 7*hour
	first := observeCapacity(t, handler, capacityReading(exhaustedAt, resetAtMS, 168, 100), exhaustedAt).Capacity
	if first == nil || first.CostNanos == nil || *first.CostNanos != 21_000_000_000 || first.Tokens != 3_000_000 {
		t.Fatalf("estimate at exhaustion = %+v, want the cycle's 3M tokens and $21", first)
	}
	for step := 1; step <= 96; step++ {
		observedAtMS := exhaustedAt + int64(step)*hour/2
		got := observeCapacity(t, handler, capacityReading(observedAtMS, resetAtMS, 168, 100), observedAtMS).Capacity
		if got == nil || got.Tokens != first.Tokens || *got.CostNanos != *first.CostNanos {
			t.Fatalf("idle refresh %d moved the estimate: %+v, want %+v", step, got, first)
		}
	}
	// Request records aged out and snapshots trimmed leave the evidence intact.
	if _, err := handler.repo.SQL().ExecContext(ctx, `DELETE FROM usage_events; DELETE FROM quota_snapshots`); err != nil {
		t.Fatal(err)
	}

	// The window resets and stays unused; an unused Codex window's reset instant
	// rolls forward with every refresh.
	for step := range 5 {
		observedAtMS := resetAtMS + int64(step+1)*hour
		got := observeCapacity(t, handler, capacityReading(observedAtMS, observedAtMS+168*hour, 168, 0), observedAtMS).Capacity
		if got == nil || got.Basis != "previous_cycle" || got.Tokens != first.Tokens || *got.CostNanos != *first.CostNanos {
			t.Fatalf("idle refresh %d after the reset = %+v, want the previous cycle's size", step, got)
		}
		if got.RemainingCostNanos == nil || *got.RemainingCostNanos != *first.CostNanos || got.ErrorPercent != 5 {
			t.Fatalf("idle refresh %d after the reset = %+v, want the whole window left", step, got)
		}
	}
}

// A credential first seen part-way through a cycle, partly used elsewhere: only
// the changes this gateway recorded traffic for are measured.
func TestWindowCapacityMeasuresOnlyRecordedChanges(t *testing.T) {
	handler := capacityTestHandler(t)
	nowMS := time.Now().UnixMilli()
	resetAtMS := nowMS + 3600*1000
	at := func(minutes int64) int64 { return nowMS - 120*60*1000 + minutes*60*1000 }

	// 60% was spent before this gateway saw the credential.
	window := observeCapacity(t, handler, capacityReading(at(0), resetAtMS, 5, 60), nowMS)
	if window.Capacity != nil || window.CapacityUnavailable != quota.CapacityReasonNoTraffic {
		t.Fatalf("first reading = %+v, want no estimate from traffic the gateway never saw", window)
	}
	insertCapacityUsage(t, handler, "first", at(5), 100_000, 100_000_000)
	observeCapacity(t, handler, capacityReading(at(10), resetAtMS, 5, 70), nowMS)
	// Ten points spent elsewhere while the gateway was idle.
	observeCapacity(t, handler, capacityReading(at(20), resetAtMS, 5, 80), nowMS)
	insertCapacityUsage(t, handler, "second", at(25), 100_000, 100_000_000)
	window = observeCapacity(t, handler, capacityReading(at(30), resetAtMS, 5, 90), nowMS)
	if capacity := window.Capacity; capacity == nil || capacity.Basis != "observed_delta" || capacity.Tokens != 1_000_000 {
		t.Fatalf("capacity = %+v, want 200k recorded over the 20 points it moved", capacity)
	}
}

func TestWindowCapacityReferencesFollowThePlan(t *testing.T) {
	handler := capacityTestHandler(t)
	nowMS := time.Now().UnixMilli()
	previousReset := nowMS - 3600*1000
	insertCapacityUsage(t, handler, "previous", previousReset-2*3600*1000, 100_000, 100_000_000)
	observeCapacity(t, handler, capacityReading(previousReset-3600*1000, previousReset, 5, 25), previousReset-3600*1000)

	// A small current climb leans on the previous cycle by precision.
	insertCapacityUsage(t, handler, "current", nowMS-120_000, 2_000, 2_000_000)
	window := observeCapacity(t, handler, capacityReading(nowMS-60_000, nowMS+4*3600*1000, 5, 1), nowMS)
	if capacity := window.Capacity; capacity == nil || capacity.Basis != "blended" || capacity.Tokens < 390_000 || capacity.Tokens >= 400_000 {
		t.Fatalf("capacity = %+v, want the 400k previous cycle nudged toward the 200k sample", capacity)
	}
	if window.Usage == nil || window.Usage.Tokens != 2_000 {
		t.Fatalf("usage = %+v, want the current cycle's own traffic", window.Usage)
	}

	// Another plan's size is no reference.
	changed := capacityReading(nowMS-60_000, nowMS+4*3600*1000, 5, 1)
	changed.Plan = &quota.QuotaPlan{PlanType: "pro", Tier: "elite"}
	handler.attachWindowCapacity(context.Background(), changed, nowMS)
	if window := changed.Windows[0]; window.Capacity != nil || window.CapacityUnavailable != quota.CapacityReasonLowUsage {
		t.Fatalf("window = %+v, want no estimate from another plan's size", window)
	}
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
	if window.Usage == nil || window.Usage.Requests != 1 || window.Usage.Tokens != 100 || window.Capacity == nil || window.Capacity.Tokens != 500 {
		t.Fatalf("scoped window = %+v, want only the served Sonnet request", window)
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
	// Retention removed the previous cycle's records; its frozen evidence still counts them.
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
	handler.attachWindowCapacity(context.Background(), reading, nowMS)
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

func TestWindowCapacityMultiModelCacheAndProjection(t *testing.T) {
	handler := capacityTestHandler(t)
	ctx := context.Background()
	const hour = int64(3600 * 1000)
	nowMS := time.Now().UnixMilli()
	prevReset := nowMS - hour
	prevStart := prevReset - 5*hour

	insertDetailed := func(key, model string, atMS, input, cached, output, total int64, costNanos any) {
		t.Helper()
		if _, err := handler.repo.SQL().ExecContext(ctx, `
			INSERT INTO usage_events (
				instance_id, event_key, api_group_key, auth_index, model,
				timestamp_ms, created_at_ms, input_tokens, cache_read_tokens, output_tokens, total_tokens, cost_nanos
			) VALUES ('default', ?, 'group', 'codex-1', ?, ?, ?, ?, ?, ?, ?, ?)`,
			key, model, atMS, atMS, input, cached, output, total, costNanos,
		); err != nil {
			t.Fatal(err)
		}
	}

	// Previous cycle: 6 requests of gpt-5.4 (dominant, $0.50/req, 100k tok/req, 80% cache rate = $3.00)
	// plus 2 requests of gpt-5.4-pro ($3.50/req = $7.00), burning 20% ($10 -> $50 window).
	for idx := range 6 {
		insertDetailed(fmt.Sprintf("prev-main-%d", idx), "gpt-5.4", prevStart+int64(idx+1)*60_000, 90_000, 72_000, 10_000, 100_000, int64(500_000_000))
	}
	for idx := range 2 {
		insertDetailed(fmt.Sprintf("prev-pro-%d", idx), "gpt-5.4-pro", prevStart+10*60_000+int64(idx)*60_000, 50_000, 0, 10_000, 60_000, int64(3_500_000_000))
	}
	prevWindow := observeCapacity(t, handler, capacityReading(prevReset-60_000, prevReset, 5, 20), prevReset-60_000)
	if prevWindow.Usage == nil || prevWindow.Usage.CacheRate == nil || *prevWindow.Usage.CacheRate != 67.5 {
		t.Fatalf("previous usage cache rate = %+v, want 432k / 640k = 67.5%%", prevWindow.Usage)
	}
	if prevWindow.Capacity == nil || prevWindow.Capacity.Projection == nil || prevWindow.Capacity.Projection.Model != "gpt-5.4" {
		t.Fatalf("previous projection = %+v, want gpt-5.4", prevWindow.Capacity)
	}
	// $50 window converted onto gpt-5.4 ($0.50/req): 100 total requests.
	if prevWindow.Capacity.Projection.Requests != 100 {
		t.Fatalf("projected total requests = %d, want 100", prevWindow.Capacity.Projection.Requests)
	}

	// Freshly reset current cycle (0% used, 0 requests in cycle): lookback still
	// projects total window requests onto the recent dominant model gpt-5.4 (100 requests).
	fresh := observeCapacity(t, handler, capacityReading(nowMS-30_000, nowMS+4*hour, 5, 0), nowMS)
	if fresh.Capacity == nil || fresh.Capacity.Projection == nil || fresh.Capacity.Projection.Model != "gpt-5.4" {
		t.Fatalf("fresh cycle projection = %+v, want lookback dominant model gpt-5.4", fresh.Capacity)
	}
	if fresh.Capacity.Projection.Requests != 100 {
		t.Fatalf("fresh projected requests = %d, want full 100 gpt-5.4 requests", fresh.Capacity.Projection.Requests)
	}

	// Even after usage_events are pruned, the capacity history endpoint retains
	// the previous cycle's frozen cache rate.
	if _, err := handler.repo.SQL().ExecContext(ctx, `DELETE FROM usage_events`); err != nil {
		t.Fatal(err)
	}
	status, body := getCapacityHistory(t, handler, "?window=five_hour")
	if status != http.StatusOK {
		t.Fatalf("history status = %d (%v)", status, body)
	}
	previous, _ := body["previous"].(map[string]any)
	prevUsage, _ := previous["usage"].(map[string]any)
	if prevUsage["cache_rate"] != 67.5 || prevUsage["prompt_tokens"] != float64(640_000) || prevUsage["cached_tokens"] != float64(432_000) {
		t.Fatalf("frozen previous usage = %v, want cache_rate=67.5 prompt_tokens=640000 cached_tokens=432000", prevUsage)
	}
	// Without runtime-cache or provider-catalog membership, loadCapacityCandidateModels
	// returns empty even for Antigravity rather than reading the global price book.
	if got := handler.loadCapacityCandidateModels(ctx, "antigravity"); len(got) != 0 {
		t.Fatalf("antigravity candidate models without provider membership = %v, want empty", got)
	}
}

func TestQuotaCapacityHistorySkipsOverlappingSupersededCycle(t *testing.T) {
	handler := capacityTestHandler(t)
	const day = int64(24 * 3600 * 1000)
	nowMS := time.Now().UnixMilli()

	// Pre-subscription weekly cycle (ends in the future at nowMS + 1d, started nowMS - 6d)
	supersededReset := nowMS + day
	supersededStart := supersededReset - 7*day
	insertCapacityUsage(t, handler, "pre-sub", supersededStart+day, 61_400_000, 10_650_000_000)
	observeCapacity(t, handler, capacityReading(nowMS-2*day, supersededReset, 168, 7), nowMS-2*day)

	// User subscribes yesterday (nowMS - 1d): upstream starts a fresh 7-day cycle [nowMS - 1d, nowMS + 6d).
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
