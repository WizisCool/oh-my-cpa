package api

import (
	"context"
	"sync/atomic"
	"testing"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/warmup"
)

// Codex reports an unused window with a reset that slides with every read.
// After a warmup the reset freezes at the send time, which trails the first
// read by however long admission and the upstream call took.
func TestWarmupActivationTellsSlidingFromFrozenCodexWindow(t *testing.T) {
	const firstReadMS int64 = 1_770_000_000_000
	window := func(state string, resetMS, period int64) warmup.Window {
		zero := float64(0)
		return warmup.Window{State: state, UsedPercent: &zero, ResetAtMS: &resetMS, PeriodMS: period}
	}
	observation := func(observedMS int64, five, week warmup.Window) *warmup.Observation {
		return &warmup.Observation{Provider: "codex", ObservedAtMS: observedMS, PaidFallback: "disabled", FiveHour: five, Weekly: week}
	}
	before := observation(firstReadMS,
		window("idle", firstReadMS+warmup.FIVE_HOUR_MS, warmup.FIVE_HOUR_MS),
		window("active", firstReadMS+3*24*60*60*1000, warmup.WEEK_MS))
	for _, scenario := range []struct {
		name        string
		sendDelayMS int64
		laterMS     int64
		isActivated bool
	}{
		{"frozen after a slow send", 4_000, 60_000, true},
		{"frozen after an instant send", 0, 60_000, true},
		{"still sliding", 60_000, 60_000, false},
		{"read too soon to tell", 2_000, 10_000, false},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			afterMS := firstReadMS + scenario.laterMS
			after := observation(afterMS,
				window("active", firstReadMS+scenario.sendDelayMS+warmup.FIVE_HOUR_MS, warmup.FIVE_HOUR_MS),
				before.Weekly)
			if got := isWarmupActivated(before, after); got != scenario.isActivated {
				t.Fatalf("activated=%v, want %v", got, scenario.isActivated)
			}
		})
	}
}

// A second manual click while the first run is still confirming must not send
// again, and must not cut the first run's confirmation short.
func TestWarmupSecondClickLeavesPendingRunConfirming(t *testing.T) {
	fixture := &warmupFixture{isActivationDelayed: true}
	handler := newWarmupHandler(t, fixture)
	ctx := context.Background()
	revision := credentialWarmupRevision(t, handler)
	var clock atomic.Int64
	clock.Store(handler.now().UnixMilli())
	handler.nowFn = func() time.Time { return time.UnixMilli(clock.Load()) }
	first, err := handler.executeWarmup(ctx, "exact-claude", "manual-first-click", revision, true)
	if err != nil || first.Status != "pending" {
		t.Fatalf("first: %+v %v", first, err)
	}
	clock.Add(1)
	second, err := handler.executeWarmup(ctx, "exact-claude", "manual-second-click", revision, true)
	if err != nil || second.Status != "skipped" || second.Reason != "activation_pending" {
		t.Fatalf("second: %+v %v", second, err)
	}
	state, err := handler.repo.ReadWarmupState(ctx, "default", "exact-claude")
	if err != nil || state.LastResult == nil || state.LastResult.Status != "pending" || state.LastResult.RequestID != "manual-first-click" {
		t.Fatalf("pending run was rewritten: %+v %v", state.LastResult, err)
	}
	fixture.mu.Lock()
	defer fixture.mu.Unlock()
	if fixture.sends != 1 {
		t.Fatalf("sent %d", fixture.sends)
	}
}
