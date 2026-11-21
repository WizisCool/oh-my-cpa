package refresh

import (
	"context"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func waitForSignal(t *testing.T, ch <-chan struct{}, label string) {
	t.Helper()
	select {
	case <-ch:
	case <-time.After(time.Second):
		t.Fatalf("timed out waiting for %s", label)
	}
}

func TestSchedulerPeriodicPausesWhenDisabledAndResumesOnWake(t *testing.T) {
	s := New(nil)
	var interval atomic.Int64
	var runs atomic.Int64
	var policyReads atomic.Int64
	ran := make(chan struct{}, 4)
	polled := make(chan struct{}, 32)

	var clockMu sync.Mutex
	now := time.Unix(1_700_000_000, 0)
	nowFn := func() time.Time {
		clockMu.Lock()
		defer clockMu.Unlock()
		return now
	}
	advance := func(d time.Duration) {
		clockMu.Lock()
		now = now.Add(d)
		clockMu.Unlock()
	}

	// Wait until the loop has read its policy at least once more, proving `last`
	// has been recorded after any preceding callback finished.
	waitNextPolicyRead := func(label string) {
		t.Helper()
		target := policyReads.Load() + 1
		deadline := time.After(time.Second)
		for policyReads.Load() < target {
			select {
			case <-polled:
			case <-deadline:
				t.Fatalf("timed out waiting for policy read (%s)", label)
			}
		}
	}

	// Start disabled (0).
	interval.Store(0)
	s.AddPeriodic(PeriodicConfig{
		Name:       "plugin_updates",
		Tick:       5 * time.Millisecond,
		RunOnStart: true,
		Interval: func(context.Context) time.Duration {
			policyReads.Add(1)
			select {
			case polled <- struct{}{}:
			default:
			}
			return time.Duration(interval.Load())
		},
		Run: func(context.Context) {
			runs.Add(1)
			select {
			case ran <- struct{}{}:
			default:
			}
		},
		Now: nowFn,
	})

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		s.Run(ctx)
		close(done)
	}()

	// Observe multiple ticks while disabled.
	waitNextPolicyRead("startup disabled")
	waitNextPolicyRead("disabled tick")
	if got := runs.Load(); got != 0 {
		t.Fatalf("disabled task ran %d times, want 0", got)
	}

	// Enable with RunOnStart=true: Wake runs it once immediately.
	interval.Store(int64(time.Hour))
	s.Wake("plugin_updates")
	waitForSignal(t, ran, "initial run after enabling")

	// Synchronize on a subsequent policy read so we know `last = nowFn()` has
	// completed before asserting no premature rerun and before advancing the clock.
	waitNextPolicyRead("post-initial-run baseline")
	if got := runs.Load(); got != 1 {
		t.Fatalf("task ran %d times before interval elapsed, want 1", got)
	}

	// Advance clock past interval and wake: runs a second time.
	advance(time.Hour)
	s.Wake("plugin_updates")
	waitForSignal(t, ran, "scheduled run after interval elapsed")

	cancel()
	waitForSignal(t, done, "scheduler shutdown join")
}

func TestSchedulerPeriodicRespectsRunOnStartFalse(t *testing.T) {
	s := New(nil)
	var runs atomic.Int64
	var policyReads atomic.Int64
	ran := make(chan struct{}, 2)
	polled := make(chan struct{}, 32)

	var clockMu sync.Mutex
	now := time.Unix(1_700_000_000, 0)
	nowFn := func() time.Time {
		clockMu.Lock()
		defer clockMu.Unlock()
		return now
	}

	s.AddPeriodic(PeriodicConfig{
		Name:       "release_updates",
		Tick:       5 * time.Millisecond,
		RunOnStart: false,
		Interval: func(context.Context) time.Duration {
			policyReads.Add(1)
			select {
			case polled <- struct{}{}:
			default:
			}
			return 30 * time.Minute
		},
		Run: func(context.Context) {
			runs.Add(1)
			select {
			case ran <- struct{}{}:
			default:
			}
		},
		Now: nowFn,
	})

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		s.Run(ctx)
		close(done)
	}()

	// Wait for at least one tick read so `last` is guaranteed initialized before advancing.
	deadline := time.After(time.Second)
	for policyReads.Load() < 1 {
		select {
		case <-polled:
		case <-deadline:
			t.Fatal("timed out waiting for initial tick read")
		}
	}
	if got := runs.Load(); got != 0 {
		t.Fatalf("RunOnStart=false task ran %d times at startup, want 0", got)
	}

	clockMu.Lock()
	now = now.Add(30 * time.Minute)
	clockMu.Unlock()

	waitForSignal(t, ran, "periodic run after interval elapsed")

	cancel()
	waitForSignal(t, done, "scheduler shutdown join")
}
