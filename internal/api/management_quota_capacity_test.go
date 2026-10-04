package api

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/domain"
	"github.com/oh-my-cpa/oh-my-cpa/internal/quota"
	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
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

func capacityTestQuota(nowMS, observedAtMS int64, usedPercent float64) *quota.NormalizedQuota {
	resetAtMS := nowMS + 2*3600*1000
	periodHours := 5.0
	return &quota.NormalizedQuota{
		AuthIndex:    "codex-1",
		Provider:     "codex",
		Status:       "healthy",
		ObservedAtMS: observedAtMS,
		Windows: []quota.QuotaWindow{
			{ID: "five_hour", Kind: "five_hour", Scope: "standard", UsedPercent: &usedPercent,
				ResetAtMS: &resetAtMS, PeriodHours: &periodHours, ResetAccuracy: "exact"},
			{ID: "code_review", Kind: "custom", Scope: "code_review", UsedPercent: &usedPercent,
				ResetAtMS: &resetAtMS, PeriodHours: &periodHours, ResetAccuracy: "exact"},
		},
	}
}

func TestAttachWindowCapacity(t *testing.T) {
	handler := capacityTestHandler(t)
	ctx := context.Background()
	nowMS := time.Now().UnixMilli()
	cycleStartMS := nowMS - 3*3600*1000
	observedAtMS := nowMS - 60_000

	insertCapacityUsage(t, handler, "previous-cycle", cycleStartMS-1, 9_000_000, 9_000_000_000)
	insertCapacityUsage(t, handler, "in-cycle-1", cycleStartMS, 300_000, 400_000_000)
	insertCapacityUsage(t, handler, "in-cycle-2", observedAtMS-1, 200_000, 600_000_000)
	insertCapacityUsage(t, handler, "after-observation", observedAtMS, 5_000_000, 5_000_000_000)

	q := capacityTestQuota(nowMS, observedAtMS, 20)
	shared := q.Windows
	handler.attachWindowCapacity(ctx, q, nowMS)

	window := q.Windows[0]
	if window.Usage == nil || window.Usage.Requests != 2 || window.Usage.Tokens != 500_000 || window.Usage.CostNanos != 1_000_000_000 {
		t.Fatalf("usage = %+v, want the two requests between the cycle start and the observation", window.Usage)
	}
	if window.Usage.FromMS != cycleStartMS || window.Usage.ToMS != observedAtMS {
		t.Fatalf("usage range = [%d, %d), want [%d, %d)", window.Usage.FromMS, window.Usage.ToMS, cycleStartMS, observedAtMS)
	}
	if window.Capacity == nil || window.Capacity.Tokens != 2_500_000 || window.Capacity.CostNanos == nil || *window.Capacity.CostNanos != 5_000_000_000 {
		t.Fatalf("capacity = %+v, want usage scaled by 100/20", window.Capacity)
	}
	if window.CapacityUnavailable != "" {
		t.Fatalf("capacity_unavailable = %q, want none", window.CapacityUnavailable)
	}

	// A feature-scoped window has no metered model mapping and carries neither a
	// usage figure nor a reason: the estimate does not apply to it at all.
	scoped := q.Windows[1]
	if scoped.Usage != nil || scoped.Capacity != nil || scoped.CapacityUnavailable != "" {
		t.Fatalf("feature-scoped window = %+v, want it left untouched", scoped)
	}

	// A failed refresh shares its windows with the prior observation, and a
	// snapshot is marshalled from that slice.
	if shared[0].Usage != nil || shared[0].Capacity != nil {
		t.Fatal("the caller's window slice was edited in place")
	}
}

func TestAttachWindowCapacityDetectsMidCycleReset(t *testing.T) {
	handler := capacityTestHandler(t)
	ctx := context.Background()
	nowMS := time.Now().UnixMilli()
	observedAtMS := nowMS - 60_000
	insertCapacityUsage(t, handler, "in-cycle", observedAtMS-1000, 100_000, 100_000_000)

	saveSnapshot := func(atMS int64, usedPercent float64) {
		t.Helper()
		windows, _ := json.Marshal([]quota.QuotaWindow{{ID: "five_hour", Scope: "standard", UsedPercent: &usedPercent}})
		if err := handler.repo.SaveQuotaSnapshot(ctx, repository.QuotaSnapshotRecord{
			AuthIndex: "codex-1", Provider: "codex", Status: "healthy", WindowsJSON: string(windows), ObservedAtMS: atMS,
		}); err != nil {
			t.Fatal(err)
		}
	}
	// A high reading from the previous cycle is not evidence of a reset, and
	// neither is the snapshot of the very observation being estimated.
	saveSnapshot(nowMS-4*3600*1000, 90)
	saveSnapshot(observedAtMS, 20)

	q := capacityTestQuota(nowMS, observedAtMS, 20)
	handler.attachWindowCapacity(ctx, q, nowMS)
	if q.Windows[0].Capacity == nil {
		t.Fatalf("capacity withheld with %q, want an estimate", q.Windows[0].CapacityUnavailable)
	}

	saveSnapshot(nowMS-3600*1000, 70)
	q = capacityTestQuota(nowMS, observedAtMS, 20)
	handler.attachWindowCapacity(ctx, q, nowMS)
	if q.Windows[0].Capacity != nil || q.Windows[0].CapacityUnavailable != quota.CapacityReasonResetMidCycle {
		t.Fatalf("capacity = %+v reason %q, want none with reset_mid_cycle", q.Windows[0].Capacity, q.Windows[0].CapacityUnavailable)
	}
	if q.Windows[0].Usage == nil {
		t.Fatal("recorded usage dropped along with the estimate")
	}
}

func TestAttachWindowCapacityWithholdsForUnknownObservationTime(t *testing.T) {
	handler := capacityTestHandler(t)
	ctx := context.Background()
	nowMS := time.Now().UnixMilli()
	insertCapacityUsage(t, handler, "in-cycle", nowMS-120_000, 100_000, 100_000_000)

	stale := capacityTestQuota(nowMS, nowMS, 20)
	stale.Status = "stale"
	handler.attachWindowCapacity(ctx, stale, nowMS)
	if stale.Windows[0].Usage != nil || stale.Windows[0].CapacityUnavailable != quota.CapacityReasonStale {
		t.Fatalf("stale window = %+v, want no usage and the stale reason", stale.Windows[0])
	}

	disabled := capacityTestQuota(nowMS, nowMS, 20)
	disabled.Disabled = true
	handler.attachWindowCapacity(ctx, disabled, nowMS)
	if disabled.Windows[0].Usage != nil || disabled.Windows[0].CapacityUnavailable != quota.CapacityReasonStale {
		t.Fatalf("disabled window = %+v, want no usage and the stale reason", disabled.Windows[0])
	}
}

func TestWindowCapacityResetAfterCounterRecovers(t *testing.T) {
	handler := capacityTestHandler(t)
	nowMS := time.Now().UnixMilli()
	observedAtMS := nowMS - 60000
	insertCapacityUsage(t, handler, "recorded-before-and-after-reset", observedAtMS-1000, 100000, 100000000)
	for i, percent := range []float64{20, 5} {
		windows, err := json.Marshal(capacityTestQuota(nowMS, nowMS-120000+int64(i)*1000, percent).Windows)
		if err != nil {
			t.Fatal(err)
		}
		if err := handler.repo.SaveQuotaSnapshot(context.Background(), repository.QuotaSnapshotRecord{AuthIndex: "codex-1", Provider: "codex", Status: "healthy", WindowsJSON: string(windows), ObservedAtMS: nowMS - 120000 + int64(i)*1000}); err != nil {
			t.Fatal(err)
		}
	}
	current := capacityTestQuota(nowMS, observedAtMS, 25)
	handler.attachWindowCapacity(context.Background(), current, nowMS)
	if current.Windows[0].Capacity != nil {
		t.Fatalf("reset 20%% -> 5%% -> 25%% was forgotten: capacity=%+v reason=%q", current.Windows[0].Capacity, current.Windows[0].CapacityUnavailable)
	}
}

func TestWindowCapacityStaleReadingWithCooldown(t *testing.T) {
	handler := capacityTestHandler(t)
	nowMS := time.Now().UnixMilli()
	insertCapacityUsage(t, handler, "in-cycle", nowMS-120000, 100000, 100000000)
	current := capacityTestQuota(nowMS, nowMS, 20)
	current.Status = "stale"
	current.Error = "upstream refresh timed out"
	recoverAtMS := nowMS + 60000
	current.ActiveCooldown = &quota.ActiveCooldown{IsActive: true, RecoverAtMS: &recoverAtMS}
	quota.EvaluateStatusAndRecommendation(current, nowMS)
	handler.attachWindowCapacity(context.Background(), current, nowMS)
	if current.Windows[0].Capacity != nil {
		t.Fatalf("failed refresh incorrectly estimated under status %q: capacity=%+v reason=%q", current.Status, current.Windows[0].Capacity, current.Windows[0].CapacityUnavailable)
	}
}

func TestWindowCapacityHistoryFailureWithholds(t *testing.T) {
	handler := capacityTestHandler(t)
	nowMS := time.Now().UnixMilli()
	insertCapacityUsage(t, handler, "in-cycle", nowMS-120000, 100000, 100000000)
	if _, err := handler.repo.SQL().ExecContext(context.Background(), "DROP TABLE quota_snapshots"); err != nil {
		t.Fatal(err)
	}
	current := capacityTestQuota(nowMS, nowMS-60000, 20)
	handler.attachWindowCapacity(context.Background(), current, nowMS)
	if current.Windows[0].Capacity != nil {
		t.Fatalf("history query failure treated as clean history: capacity=%+v reason=%q", current.Windows[0].Capacity, current.Windows[0].CapacityUnavailable)
	}
}

func TestWindowCapacityUsesPreviousCycleWithoutReplacingCurrentUsage(t *testing.T) {
	handler := capacityTestHandler(t)
	ctx := context.Background()
	nowMS := time.Now().UnixMilli()
	current := capacityTestQuota(nowMS, nowMS-60000, 2)
	previous := capacityTestQuota(nowMS, nowMS-4*3600*1000, 25)
	resetAtMS := nowMS - 3*3600*1000
	previous.Windows[0].ResetAtMS = &resetAtMS
	insertCapacityUsage(t, handler, "previous-traffic", nowMS-5*3600*1000, 100000, 100000000)
	insertCapacityUsage(t, handler, "after-previous-reading", nowMS-3*3600*1000-1000, 9000000, 9000000000)
	insertCapacityUsage(t, handler, "current-traffic", nowMS-120000, 2000, 2000000)
	if err := handler.persistNormalizedQuotaSnapshot(ctx, previous); err != nil {
		t.Fatal(err)
	}
	handler.attachWindowCapacity(ctx, current, nowMS)
	window := current.Windows[0]
	if window.Capacity == nil || window.Capacity.Basis != "previous_cycle" || window.Capacity.Tokens != 400000 || window.Capacity.ObservedAtMS != previous.ObservedAtMS || window.Capacity.ResetAtMS != resetAtMS {
		t.Fatalf("fallback=%+v", window.Capacity)
	}
	if window.Usage == nil || window.Usage.Tokens != 2000 || window.CapacityUnavailable != quota.CapacityReasonLowUsage {
		t.Fatalf("current reading lost: %+v", window)
	}
	insertCapacityUsage(t, handler, "previous-unpriced", nowMS-5*3600*1000, 100000, nil)
	handler.attachWindowCapacity(ctx, current, nowMS)
	if current.Windows[0].Capacity == nil || current.Windows[0].Capacity.CostNanos != nil {
		t.Fatal("unpriced fallback was not tokens-only")
	}
}

func TestWindowCapacityScopedUsagePrefersServedModelAndFailsClosed(t *testing.T) {
	handler := capacityTestHandler(t)
	ctx := context.Background()
	nowMS := time.Now().UnixMilli()
	current := capacityTestQuota(nowMS, nowMS-60000, 20)
	current.Windows = current.Windows[:1]
	current.Windows[0].Scope = "model"
	current.Windows[0].Model = "claude-sonnet-4-5"
	for _, row := range []struct {
		key, requested, served string
		tokens                 int64
	}{
		{"sonnet", "fast", "claude-sonnet-4-5-20250929", 100},
		{"opus", "claude-sonnet-4-5", "claude-opus-4-1", 900},
	} {
		insertCapacityUsage(t, handler, row.key, nowMS-120000, row.tokens, row.tokens*1000)
		if _, err := handler.repo.SQL().ExecContext(ctx, `UPDATE usage_events SET model=?,response_model=? WHERE event_key=?`, row.requested, row.served, row.key); err != nil {
			t.Fatal(err)
		}
	}
	handler.attachWindowCapacity(ctx, current, nowMS)
	if window := current.Windows[0]; window.Usage == nil || window.Usage.Requests != 1 || window.Usage.Tokens != 100 || window.Capacity == nil || window.Capacity.Tokens != 500 {
		t.Fatalf("scoped reading=%+v", window)
	}
	insertCapacityUsage(t, handler, "unknown-alias", nowMS-120000, 200, 200000)
	if _, err := handler.repo.SQL().ExecContext(ctx, `UPDATE usage_events SET model='fast' WHERE event_key='unknown-alias'`); err != nil {
		t.Fatal(err)
	}
	handler.attachWindowCapacity(ctx, current, nowMS)
	if window := current.Windows[0]; window.Usage != nil || window.Capacity != nil || window.CapacityUnavailable != quota.CapacityReasonScopeUnknown {
		t.Fatalf("partial scope accepted: %+v", window)
	}
}

func TestWindowCapacityResetEvidenceSurvivesSnapshotRetention(t *testing.T) {
	handler := capacityTestHandler(t)
	ctx := context.Background()
	nowMS := time.Now().UnixMilli()
	for i := range 54 {
		percent := 25.0 + float64(i)
		if i == 0 {
			percent = 20
		}
		if i == 1 {
			percent = 5
		}
		current := capacityTestQuota(nowMS, nowMS-120000+int64(i)*1000, percent)
		if err := handler.persistNormalizedQuotaSnapshot(ctx, current); err != nil {
			t.Fatal(err)
		}
	}
	history, err := handler.repo.GetQuotaSnapshotHistory(ctx, "codex-1", 100)
	if err != nil {
		t.Fatal(err)
	}
	if len(history) != 50 {
		t.Fatalf("retained=%d", len(history))
	}
	current := capacityTestQuota(nowMS, nowMS-60000, 80)
	insertCapacityUsage(t, handler, "traffic", nowMS-70000, 100, 1000)
	handler.attachWindowCapacity(ctx, current, nowMS)
	if current.Windows[0].CapacityUnavailable != quota.CapacityReasonResetMidCycle {
		t.Fatalf("reset evidence lost: %+v", current.Windows[0])
	}
	// Read-time joins must never freeze into the stored observation.
	if err := handler.persistNormalizedQuotaSnapshot(ctx, current); err != nil {
		t.Fatal(err)
	}
	latest, err := handler.repo.GetLatestQuotaSnapshots(ctx, []string{"codex-1"})
	if err != nil {
		t.Fatal(err)
	}
	var windows []quota.QuotaWindow
	if err := json.Unmarshal([]byte(latest["codex-1"].WindowsJSON), &windows); err != nil {
		t.Fatal(err)
	}
	if !windows[0].HasMidCycleReset || windows[0].Usage != nil || windows[0].Capacity != nil || windows[0].CapacityUnavailable != "" {
		t.Fatalf("snapshot join or evidence wrong: %+v", windows[0])
	}
}

func TestWindowCapacityDoesNotPersistFailedCooldownObservation(t *testing.T) {
	handler := capacityTestHandler(t)
	ctx := context.Background()
	nowMS := time.Now().UnixMilli()
	current := capacityTestQuota(nowMS, nowMS, 20)
	current.Status = "cooldown"
	current.Error = "upstream timed out"
	if err := handler.persistNormalizedQuotaSnapshot(ctx, current); err != nil {
		t.Fatal(err)
	}
	history, err := handler.repo.GetQuotaSnapshotHistory(ctx, "codex-1", 50)
	if err != nil || len(history) != 0 {
		t.Fatalf("failed reading stored: %+v error=%v", history, err)
	}
}

func TestWindowCapacityMalformedHistoryFailsClosed(t *testing.T) {
	handler := capacityTestHandler(t)
	ctx := context.Background()
	nowMS := time.Now().UnixMilli()
	if err := handler.repo.SaveQuotaSnapshot(ctx, repository.QuotaSnapshotRecord{AuthIndex: "codex-1", Provider: "codex", Status: "healthy", WindowsJSON: "invalid", ObservedAtMS: nowMS - 120000}); err != nil {
		t.Fatal(err)
	}
	current := capacityTestQuota(nowMS, nowMS-60000, 20)
	handler.attachWindowCapacity(ctx, current, nowMS)
	if current.Windows[0].CapacityUnavailable != quota.CapacityReasonHistoryUnavailable {
		t.Fatalf("malformed history accepted: %+v", current.Windows[0])
	}
}

func TestWindowCapacityCorruptHistoryDoesNotBlockFreshObservations(t *testing.T) {
	handler := capacityTestHandler(t)
	ctx := context.Background()
	nowMS := time.Now().UnixMilli()
	if err := handler.repo.SaveQuotaSnapshot(ctx, repository.QuotaSnapshotRecord{AuthIndex: "codex-1", Provider: "codex", Status: "healthy", WindowsJSON: "invalid", ObservedAtMS: nowMS - 120000}); err != nil {
		t.Fatal(err)
	}
	current := capacityTestQuota(nowMS, nowMS-60000, 20)
	if err := handler.persistNormalizedQuotaSnapshot(ctx, current); err != nil {
		t.Fatalf("fresh observation blocked by corrupt history: %v", err)
	}
	latest, err := handler.repo.GetLatestQuotaSnapshots(ctx, []string{"codex-1"})
	if err != nil || latest["codex-1"].ObservedAtMS != current.ObservedAtMS {
		t.Fatalf("latest observation was not saved: %v %v", latest, err)
	}
	var stored []quota.QuotaWindow
	if err := json.Unmarshal([]byte(latest["codex-1"].WindowsJSON), &stored); err != nil || !stored[0].HasIncompleteHistory {
		t.Fatalf("missing incomplete-history evidence: %+v %v", stored, err)
	}
	// Model retention evicting the corrupt row: later clean reads cannot erase
	// that this cycle lost the evidence needed to rule out a prior reset.
	if _, err := handler.repo.SQL().ExecContext(ctx, `DELETE FROM quota_snapshots WHERE windows_json='invalid'`); err != nil {
		t.Fatal(err)
	}
	insertCapacityUsage(t, handler, "traffic", nowMS-70000, 100, 1000)
	current = capacityTestQuota(nowMS, nowMS-30000, 25)
	if err := handler.persistNormalizedQuotaSnapshot(ctx, current); err != nil {
		t.Fatal(err)
	}
	handler.attachWindowCapacity(ctx, current, nowMS)
	if current.Windows[0].Capacity != nil || current.Windows[0].CapacityUnavailable != quota.CapacityReasonHistoryUnavailable {
		t.Fatalf("lost history became trusted after retention: %+v", current.Windows[0])
	}
	current = capacityTestQuota(nowMS+5*3600000, nowMS+5*3600000, 25)
	if err := handler.persistNormalizedQuotaSnapshot(ctx, current); err != nil {
		t.Fatal(err)
	}
	if current.Windows[0].HasIncompleteHistory {
		t.Fatal("incomplete-history flag survived a scheduled reset")
	}
}
