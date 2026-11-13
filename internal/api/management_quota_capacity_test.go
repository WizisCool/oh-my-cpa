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
	handler.attachQuotaForecasts(context.Background(), reading, nowMS)
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
	handler.attachQuotaForecasts(context.Background(), reading, nowMS)
	if window := reading.Windows[0]; len(window.ModelForecasts) != 0 || window.ForecastUnavailable != quota.CapacityReasonHistoryUnavailable {
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

func insertForecastTraffic(t *testing.T, handler *Handler, model string, count int, fromMS int64) {
	t.Helper()
	for index := range count {
		key := fmt.Sprintf("%s-%d-%d", model, fromMS, index)
		insertCapacityUsage(t, handler, key, fromMS+int64(index), 1000, 1_000_000)
		if _, err := handler.repo.SQL().ExecContext(context.Background(), `UPDATE usage_events SET model=?, input_tokens=1000 WHERE event_key=?`, model, key); err != nil {
			t.Fatal(err)
		}
	}
}

func TestQuotaForecastsKeepNativeReadingsAndSeparateRecordedCosts(t *testing.T) {
	handler := capacityTestHandler(t)
	now := time.Now().UnixMilli()
	reset := now + 2*3600*1000
	baseline := capacityReading(now-30_000, reset, 5, 0)
	observeCapacity(t, handler, baseline, now)
	insertForecastTraffic(t, handler, "gemini-4-hydrogen", 10, now-25_000)
	first := observeCapacity(t, handler, capacityReading(now-20_000, reset, 5, 10), now)
	if len(first.ModelForecasts) != 1 || first.ModelForecasts[0].RemainingRequests != 90 {
		t.Fatalf("first forecast = %+v", first)
	}
	insertForecastTraffic(t, handler, "gemini-4-carbon", 10, now-15_000)
	reading := capacityReading(now-10_000, reset, 5, 30)
	shared := reading.Windows
	window := observeCapacity(t, handler, reading, now)
	if window.Usage == nil || window.Usage.Requests != 20 || window.Usage.CostNanos != 20_000_000 {
		t.Fatalf("recorded usage = %+v", window.Usage)
	}
	if *window.UsedPercent != 30 || *window.ResetAtMS != reset || len(window.ModelForecasts) != 2 {
		t.Fatalf("window = %+v", window)
	}
	if window.ModelForecasts[0].Model != "gemini-4-carbon" || window.ModelForecasts[0].RemainingRequests != 35 || window.ModelForecasts[1].RemainingRequests != 70 ||
		window.ModelForecasts[0].RemainingCostNanos == nil || *window.ModelForecasts[0].RemainingCostNanos != 35_000_000 ||
		window.ModelForecasts[1].RemainingCostNanos == nil || *window.ModelForecasts[1].RemainingCostNanos != 70_000_000 {
		t.Fatalf("model attribution = %+v", window.ModelForecasts)
	}
	if shared[0].Usage != nil || len(shared[0].ModelForecasts) != 0 {
		t.Fatal("mutated caller's slice")
	}
	if scoped := reading.Windows[1]; scoped.Usage != nil || len(scoped.ModelForecasts) != 0 || scoped.ForecastUnavailable != "" {
		t.Fatalf("feature window changed: %+v", scoped)
	}
	data, err := json.Marshal(window)
	if err != nil {
		t.Fatal(err)
	}
	for _, field := range []string{`"capacity":`, `"model_projections":`} {
		if strings.Contains(string(data), field) {
			t.Fatalf("legacy quota promise leaked: %s", data)
		}
	}
	stored, err := handler.repo.GetLatestQuotaSnapshots(context.Background(), []string{"codex-1"})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(stored["codex-1"].WindowsJSON, "model_forecasts") {
		t.Fatal("forecasts were persisted into upstream snapshot")
	}
	// Retention and idle refreshes leave frozen model samples unchanged.
	if _, err := handler.repo.SQL().ExecContext(context.Background(), `DELETE FROM usage_events`); err != nil {
		t.Fatal(err)
	}
	idle := observeCapacity(t, handler, capacityReading(now-5000, reset, 5, 30), now)
	if !reflect.DeepEqual(idle.ModelForecasts, window.ModelForecasts) {
		t.Fatalf("idle refresh changed forecasts: %+v", idle.ModelForecasts)
	}
	status, body := getCapacityHistory(t, handler, "?window=five_hour")
	if status != http.StatusOK || body["model_projections"] != nil {
		t.Fatalf("history = %d %v", status, body)
	}
	historyForecasts, ok := body["model_forecasts"].([]any)
	if !ok || len(historyForecasts) != 2 {
		t.Fatalf("history model_forecasts = %T %v", body["model_forecasts"], body["model_forecasts"])
	}
	for idx, wantCost := range []float64{35_000_000, 70_000_000} {
		f, _ := historyForecasts[idx].(map[string]any)
		if f["sample_priced_requests"] != float64(10) || f["remaining_cost_nanos"] != wantCost {
			t.Fatalf("history forecast[%d] = %v, want priced=10 cost=%v", idx, f, wantCost)
		}
	}
	if err := handler.repo.SaveQuotaRefreshAttempt(context.Background(), repository.QuotaRefreshAttemptRecord{AuthIndex: "codex-1", AttemptedAtMS: now, Outcome: repository.QuotaRefreshAttemptFailed, Error: "temporary gateway failure"}); err != nil {
		t.Fatal(err)
	}
	status, body = getCapacityHistory(t, handler, "?window=five_hour")
	if status != http.StatusOK || body["model_forecasts"] != nil || body["forecast_unavailable"] != quota.CapacityReasonNoReading {
		t.Fatalf("failed refresh reused a forecast: %d %v", status, body)
	}

	if _, err := handler.repo.SQL().ExecContext(context.Background(), `INSERT INTO error_events (
		instance_id, event_key, provider, model, auth_index, status_code, body,
		retryable, auth_status, auth_disabled, auth_unavailable, quota_exceeded,
		quota_reason, next_recover_at_ms, timestamp_ms, created_at_ms
	) VALUES ('default', 'cooldown-1', 'codex', 'gpt-6.1-sol', 'codex-1', 429, 'Rate limit', 1, 'active', 0, 0, 1, 'rate limited', ?, ?, ?)`,
		now+60_000, now-1000, now-1000,
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
	if item := overview.Quotas[0]; item.Status != "cooldown" || len(item.Windows[0].ModelForecasts) != 0 || item.Windows[0].ForecastUnavailable != quota.CapacityReasonNoReading {
		t.Fatalf("overview failed refresh during cooldown = %+v", item)
	}
	detailRouter := chi.NewRouter()
	detailRouter.Get("/quota/{authIndex}", handler.getCredentialQuotaDetail)
	detailRecorder := httptest.NewRecorder()
	detailRouter.ServeHTTP(detailRecorder, httptest.NewRequest(http.MethodGet, "/quota/codex-1", nil))
	var detail struct {
		Quota quota.NormalizedQuota `json:"quota"`
	}
	if detailRecorder.Code != http.StatusOK || json.Unmarshal(detailRecorder.Body.Bytes(), &detail) != nil {
		t.Fatalf("detail = %d %s", detailRecorder.Code, detailRecorder.Body.String())
	}
	if detail.Quota.Status != "cooldown" || len(detail.Quota.Windows[0].ModelForecasts) != 0 || detail.Quota.Windows[0].ForecastUnavailable != quota.CapacityReasonNoReading {
		t.Fatalf("detail failed refresh during cooldown = %+v", detail.Quota)
	}

	for _, status := range []string{"stale", "error"} {
		failed := capacityReading(now-5000, reset, 5, 30)
		failed.Status = status
		handler.attachQuotaForecasts(context.Background(), failed, now)
		if len(failed.Windows[0].ModelForecasts) != 0 {
			t.Fatalf("%s observation forecasted: %+v", status, failed)
		}
	}
	expired := capacityReading(now-5000, reset, 5, 30)
	handler.attachQuotaForecasts(context.Background(), expired, reset)
	if len(expired.Windows[0].ModelForecasts) != 0 || expired.Windows[0].ForecastUnavailable != quota.CapacityReasonExpired {
		t.Fatalf("expired = %+v", expired.Windows[0])
	}
}

func TestQuotaForecastHistoryWithholdsUnattributableAndOldSamples(t *testing.T) {
	handler := capacityTestHandler(t)
	now := time.Now().UnixMilli()
	reset := now + 2*3600*1000
	observeCapacity(t, handler, capacityReading(now-30_000, reset, 5, 10), now)
	insertForecastTraffic(t, handler, "gemini-4-hydrogen", 5, now-25_000)
	insertForecastTraffic(t, handler, "gemini-4-carbon", 5, now-24_000)
	window := observeCapacity(t, handler, capacityReading(now-20_000, reset, 5, 30), now)
	if len(window.ModelForecasts) != 0 || window.ForecastUnavailable != quota.CapacityReasonMixedModels {
		t.Fatalf("mixed sample = %+v", window)
	}
	insertForecastTraffic(t, handler, "gemini-4-hydrogen", 5, now-15_000)
	window = observeCapacity(t, handler, capacityReading(now-10_000, reset, 5, 40), now)
	if len(window.ModelForecasts) != 1 || window.ModelForecasts[0].SampleRequests != 5 {
		t.Fatalf("pure sample = %+v", window)
	}
	// A fresh cycle has to establish its own baseline and direct samples.
	next := observeCapacity(t, handler, capacityReading(reset+1, reset+5*3600*1000, 5, 1), reset+1)
	if len(next.ModelForecasts) != 0 {
		t.Fatalf("older cycle supplied a forecast: %+v", next)
	}
}

func TestLegacyCalibrationIntervalsBackfillForecastCost(t *testing.T) {
	handler := capacityTestHandler(t)
	now := time.Now().UnixMilli()
	reset := now + 2*3600*1000
	observeCapacity(t, handler, capacityReading(now-30_000, reset, 5, 10), now)
	insertForecastTraffic(t, handler, "gemini-4-hydrogen", 9, now-25_000)
	// Include a request that started before the interval (after cycle start) and finished inside it.
	insertCapacityUsage(t, handler, "cross-interval", now-40_000, 1000, 1_000_000)
	if _, err := handler.repo.SQL().ExecContext(context.Background(), `UPDATE usage_events SET model='gemini-4-hydrogen', latency_ms=15000 WHERE event_key='cross-interval'`); err != nil {
		t.Fatal(err)
	}
	observeCapacity(t, handler, capacityReading(now-10_000, reset, 5, 20), now)

	// Simulate calibration points persisted before per-interval cost_nanos existed.
	cycles, err := handler.repo.LoadCapacityCycles(context.Background(), "codex-1")
	if err != nil {
		t.Fatal(err)
	}
	for k, list := range cycles {
		for i := range list {
			for j := range list[i].Points {
				for m := range list[i].Points[j].IntervalModels {
					list[i].Points[j].IntervalModels[m].CostNanos = 0
					list[i].Points[j].IntervalModels[m].PricedRequests = 0
				}
			}
			raw, err := json.Marshal(list[i].Points)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := handler.repo.SQL().ExecContext(context.Background(), `UPDATE quota_capacity_cycles SET points_json = ? WHERE auth_index = 'codex-1' AND window_key = ? AND cycle_reset_at_ms = ?`, string(raw), k, list[i].CycleResetAtMS); err != nil {
				t.Fatal(err)
			}
		}
	}

	reading := capacityReading(now-10_000, reset, 5, 20)
	handler.attachQuotaForecasts(context.Background(), reading, now)
	got := reading.Windows[0].ModelForecasts
	if len(got) != 1 || got[0].SamplePricedRequests != 10 || got[0].RemainingCostNanos == nil || *got[0].RemainingCostNanos != 80_000_000 {
		t.Fatalf("backfilled forecast = %+v", got)
	}

	// A new interval merged onto that legacy interval still has SamplePricedRequests < SampleRequests
	// until backfilled from usage_events across the whole combined sample.
	insertForecastTraffic(t, handler, "gemini-4-hydrogen", 5, now-5_000)
	window := observeCapacity(t, handler, capacityReading(now-1_000, reset, 5, 25), now)
	got = window.ModelForecasts
	if len(got) != 1 || got[0].SampleRequests != 15 || got[0].SamplePricedRequests != 15 || got[0].RemainingCostNanos == nil || *got[0].RemainingCostNanos != 75_000_000 {
		t.Fatalf("mixed legacy+new forecast = %+v", got)
	}
	status, body := getCapacityHistory(t, handler, "?window=five_hour")
	if status != http.StatusOK {
		t.Fatalf("backfilled history status = %d (%v)", status, body)
	}
	historyForecasts, ok := body["model_forecasts"].([]any)
	if !ok || len(historyForecasts) != 1 {
		t.Fatalf("backfilled history model_forecasts = %T %v", body["model_forecasts"], body["model_forecasts"])
	}
	firstForecast, _ := historyForecasts[0].(map[string]any)
	if firstForecast["sample_priced_requests"] != float64(15) || firstForecast["remaining_cost_nanos"] != float64(75_000_000) {
		t.Fatalf("backfilled history forecast = %v", firstForecast)
	}
}
