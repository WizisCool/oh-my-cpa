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

func insertCapacityUsage(t *testing.T, handler *Handler, key string, timestampMS, tokens, costNanos int64) {
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
			{ID: "gpt-5-codex", Kind: "model_scoped", Scope: "model", Model: "gpt-5-codex", UsedPercent: &usedPercent,
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

	// A model-scoped window meters part of the traffic and carries neither a
	// usage figure nor a reason: the estimate does not apply to it at all.
	scoped := q.Windows[1]
	if scoped.Usage != nil || scoped.Capacity != nil || scoped.CapacityUnavailable != "" {
		t.Fatalf("model-scoped window = %+v, want it left untouched", scoped)
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
