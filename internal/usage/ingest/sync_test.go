package ingest

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"sync"
	"testing"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
)

// startRunner runs a collector until the test ends.
func startRunner(t *testing.T, runner *Runner) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- runner.Run(ctx) }()
	t.Cleanup(func() {
		cancel()
		select {
		case err := <-done:
			if err != nil {
				t.Errorf("runner returned %v", err)
			}
		case <-time.After(5 * time.Second):
			t.Error("runner did not stop")
		}
	})
}

func waitForMode(t *testing.T, runner *Runner, mode Mode) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if runner.Status().Mode == mode {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("collector never reached mode %q, is %q", mode, runner.Status().Mode)
}

// syncConfig keeps the collector idle long enough that a manual sync is the only
// thing that can explain records arriving inside the test's own window: with the
// idle interval at an hour, the periodic poll cannot have done it.
func syncConfig(mode Mode) Config {
	config := fastConfig(mode)
	config.IdleInterval = time.Hour
	config.MaxIdleInterval = time.Hour
	return config
}

func eventsFor(t *testing.T, store *repository.Repository, keys ...string) int {
	t.Helper()
	count := 0
	for _, key := range keys {
		var found int
		if err := store.SQL().QueryRow(`SELECT COUNT(1) FROM usage_events WHERE event_key = ?`, key).Scan(&found); err != nil {
			t.Fatal(err)
		}
		count += found
	}
	return count
}

func TestCaptureNowPullsFromCPABeforeItReturns(t *testing.T) {
	store := newStore(t)
	upstream := newFakeUpstream()
	// The first poll runs before the collector signals readiness, so the upstream
	// is barred until this test has put its records in place. Waiting on the mode
	// alone would race that initial pop and prove nothing.
	upstream.holdPops()
	runner, err := NewRunner("default", upstream, store, nil, nil, syncConfig(ModeHTTPPull))
	if err != nil {
		t.Fatal(err)
	}
	startRunner(t, runner)
	waitForMode(t, runner, ModeHTTPPull)

	// The blocked background poll is released with an empty batch, so the records
	// below can only be fetched by the manual pass this test is about.
	upstream.releasePops([][]string{{}, {usagePayload("manual-1"), usagePayload("manual-2")}})

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	outcome, err := runner.CaptureNow(ctx)
	if err != nil {
		t.Fatalf("CaptureNow: %v", err)
	}
	if outcome.Captured != 2 {
		t.Fatalf("captured = %d, want 2", outcome.Captured)
	}
	if !outcome.Drained {
		t.Fatal("an empty queue after the batch must count as drained")
	}
	if pending := inboxCount(t, store, repository.InboxPending); pending != 2 {
		t.Fatalf("records were not persisted before CaptureNow returned: %d pending", pending)
	}
}

func TestCaptureNowServesRequestQueuedBeforeCollectorStarts(t *testing.T) {
	store := newStore(t)
	upstream := newFakeUpstream()
	upstream.holdPops()
	runner, err := NewRunner("default", upstream, store, nil, nil, syncConfig(ModeHTTPPull))
	if err != nil {
		t.Fatal(err)
	}

	// The operator clicks refresh while the collector is still starting up, so the
	// request legitimately arrives before Run does. It must be answered by the
	// first pass instead of being reported as "the gateway is not collecting".
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	done := make(chan CaptureOutcome, 1)
	go func() {
		outcome, errCapture := runner.CaptureNow(ctx)
		if errCapture != nil {
			outcome.Err = errCapture
		}
		done <- outcome
	}()
	time.Sleep(50 * time.Millisecond)

	startRunner(t, runner)
	upstream.releasePops([][]string{{usagePayload("startup-1")}})
	select {
	case outcome := <-done:
		if outcome.Err != nil {
			t.Fatalf("refresh during startup failed: %v", outcome.Err)
		}
		if outcome.Captured != 1 {
			t.Fatalf("captured = %d, want 1", outcome.Captured)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("refresh queued during startup was never served")
	}
}

// A refresh against a collector that never comes up must answer, not hang until
// the HTTP layer gives up on it.
func TestCaptureNowReportsACollectorThatNeverStarts(t *testing.T) {
	store := newStore(t)
	upstream := newFakeUpstream()
	runner, err := NewRunner("default", upstream, store, nil, nil, syncConfig(ModeHTTPPull))
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	started := time.Now()
	if _, err := runner.CaptureNow(ctx); !errors.Is(err, ErrCollectorNotRunning) {
		t.Fatalf("error = %v, want ErrCollectorNotRunning", err)
	}
	if elapsed := time.Since(started); elapsed > 5*time.Second {
		t.Fatalf("a stopped collector took %s to report", elapsed)
	}
}

func TestCaptureNowDrainsBacklogBeyondOneBatch(t *testing.T) {
	store := newStore(t)
	upstream := newFakeUpstream()
	config := syncConfig(ModeHTTPPull)
	config.BatchSize = 2
	upstream.holdPops()
	runner, err := NewRunner("default", upstream, store, nil, nil, config)
	if err != nil {
		t.Fatal(err)
	}
	startRunner(t, runner)
	waitForMode(t, runner, ModeHTTPPull)

	// The backlog is larger than one batch *and* larger than what one syncPull
	// round can consume, so this pins the multi-batch drain. The first entry
	// satisfies the background poll that is already blocked on the barrier, which
	// keeps the assertion about this pass alone.
	upstream.releasePops([][]string{
		{},
		{usagePayload("b1"), usagePayload("b2")},
		{usagePayload("b3"), usagePayload("b4")},
		{usagePayload("b5")},
	})

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	outcome, err := runner.CaptureNow(ctx)
	if err != nil {
		t.Fatalf("CaptureNow: %v", err)
	}
	if outcome.Captured != 5 {
		t.Fatalf("captured = %d, want the whole backlog (5)", outcome.Captured)
	}
	if pending := inboxCount(t, store, repository.InboxPending); pending != 5 {
		t.Fatalf("pending = %d, want 5", pending)
	}
}

// A subscription suppresses CPA's enqueue, so a reconnect gap is the only way
// records end up in the queue. That backlog must be drained through full batches
// too, or a manual refresh reports a clean sync while older records wait.
func TestCaptureNowDrainsSubscriptionBackfillBacklog(t *testing.T) {
	store := newStore(t)
	upstream := newFakeUpstream()
	config := syncConfig(ModeSubscribe)
	config.BatchSize = 2
	// The scheduled backfill must not race the manual pass for the gap backlog,
	// or this would pass on the background loop's work instead.
	config.BackfillInterval = time.Hour
	upstream.popBatches = [][]string{
		{usagePayload("gap-1"), usagePayload("gap-2")},
		{usagePayload("gap-3"), usagePayload("gap-4")},
		{usagePayload("gap-5")},
	}
	runner, err := NewRunner("default", upstream, store, nil, nil, config)
	if err != nil {
		t.Fatal(err)
	}
	startRunner(t, runner)
	waitForMode(t, runner, ModeSubscribe)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	outcome, err := runner.CaptureNow(ctx)
	if err != nil {
		t.Fatalf("CaptureNow: %v", err)
	}
	if outcome.Captured != 5 {
		t.Fatalf("captured = %d, want the whole reconnect-gap backlog (5)", outcome.Captured)
	}
	if !outcome.Drained {
		t.Fatal("a drained queue must report completion")
	}
}

func TestCaptureNowFlushesBufferedSubscriptionMessages(t *testing.T) {
	store := newStore(t)
	upstream := newFakeUpstream()
	runner, err := NewRunner("default", upstream, store, nil, nil, syncConfig(ModeSubscribe))
	if err != nil {
		t.Fatal(err)
	}
	startRunner(t, runner)
	waitForMode(t, runner, ModeSubscribe)

	// A live subscription suppresses CPA's enqueue, so these records exist only
	// in the reader's buffer until something flushes them. The idle interval is
	// an hour, so the flush ticker cannot be what does it.
	upstream.push("usage", usagePayload("stream-1"))
	upstream.push("usage", usagePayload("stream-2"))

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	outcome, err := runner.CaptureNow(ctx)
	if err != nil {
		t.Fatalf("CaptureNow: %v", err)
	}
	if outcome.Captured != 2 {
		t.Fatalf("captured = %d, want 2 buffered records", outcome.Captured)
	}
	if outcome.Mode != ModeSubscribe {
		t.Fatalf("mode = %q, want subscribe", outcome.Mode)
	}
}

func TestCaptureNowReportsTransportFailure(t *testing.T) {
	store := newStore(t)
	upstream := newFakeUpstream()
	upstream.httpErr = errors.New("connection refused")
	runner, err := NewRunner("default", upstream, store, nil, nil, syncConfig(ModeHTTPPull))
	if err != nil {
		t.Fatal(err)
	}
	startRunner(t, runner)
	waitForMode(t, runner, ModeHTTPPull)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if _, err := runner.CaptureNow(ctx); err == nil {
		t.Fatal("a failed pop must not be reported as a completed sync")
	}
}

func TestCaptureNowReportsUnservedReasons(t *testing.T) {
	store := newStore(t)
	upstream := newFakeUpstream()
	ctx := context.Background()

	idle, err := NewRunner("default", upstream, store, nil, nil, fastConfig(ModeHTTPPull))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := idle.CaptureNow(ctx); !errors.Is(err, ErrCollectorNotRunning) {
		t.Fatalf("idle collector error = %v, want ErrCollectorNotRunning", err)
	}

	off, err := NewRunner("default", upstream, store, nil, nil, fastConfig(ModeOff))
	if err != nil {
		t.Fatal(err)
	}
	startRunner(t, off)
	waitForMode(t, off, ModeOff)
	if _, err := off.CaptureNow(ctx); !errors.Is(err, ErrCollectorDisabled) {
		t.Fatalf("off mode error = %v, want ErrCollectorDisabled", err)
	}
}

func TestCaptureNowHonoursCallerCancellation(t *testing.T) {
	store := newStore(t)
	upstream := newFakeUpstream()
	runner, err := NewRunner("default", upstream, store, nil, nil, syncConfig(ModeHTTPPull))
	if err != nil {
		t.Fatal(err)
	}
	startRunner(t, runner)
	waitForMode(t, runner, ModeHTTPPull)

	// A cancelled caller must be dropped instead of starting a pass nobody waits
	// for; an empty queue makes that indistinguishable inside the collector, so
	// the assertion is on how the call itself returns.
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := runner.CaptureNow(ctx); !errors.Is(err, context.Canceled) {
		t.Fatalf("error = %v, want context.Canceled", err)
	}
}

func TestRefreshNowWaitsForEventsToBecomeQueryable(t *testing.T) {
	store := newStore(t)
	upstream := newFakeUpstream()
	config := syncConfig(ModeHTTPPull)
	runner, err := NewRunner("default", upstream, store, nil, nil, config)
	if err != nil {
		t.Fatal(err)
	}
	processor, err := NewProcessor(store, slog.New(slog.NewTextHandler(io.Discard, nil)), 10, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	pipeline, err := NewPipeline(runner, processor, nil, store)
	if err != nil {
		t.Fatal(err)
	}
	startRunner(t, runner)
	waitForMode(t, runner, ModeHTTPPull)

	upstream.mu.Lock()
	upstream.httpBatches = [][]string{{usagePayload("queryable-1"), usagePayload("queryable-2")}}
	upstream.mu.Unlock()

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	result, err := pipeline.RefreshNow(ctx)
	if err != nil {
		t.Fatalf("RefreshNow: %v", err)
	}
	if !result.Synced || result.Captured != 2 || result.Decoded != 2 {
		t.Fatalf("unexpected result: %+v", result)
	}
	if result.Pending != 0 {
		t.Fatalf("pending = %d after a reported sync", result.Pending)
	}
	if result.Failed != 0 {
		t.Fatalf("failed = %d after a reported sync", result.Failed)
	}
	// The point of the barrier: by the time this returns, the list query the page
	// runs next can already see the records.
	if got := eventsFor(t, store, "queryable-1", "queryable-2"); got != 2 {
		t.Fatalf("queryable events = %d, want 2", got)
	}
}

func TestRefreshNowReportsUndrainedPass(t *testing.T) {
	store := newStore(t)
	upstream := newFakeUpstream()
	config := syncConfig(ModeHTTPPull)
	config.BatchSize = 1
	runner, err := NewRunner("default", upstream, store, nil, nil, config)
	if err != nil {
		t.Fatal(err)
	}
	processor, err := NewProcessor(store, nil, 10, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	pipeline, err := NewPipeline(runner, processor, nil, store)
	if err != nil {
		t.Fatal(err)
	}
	startRunner(t, runner)
	waitForMode(t, runner, ModeHTTPPull)

	// Always-full batches: the queue is never observed empty.
	batch := make([][]string, captureDrainRounds)
	for i := range batch {
		batch[i] = []string{usagePayload(fmt.Sprintf("flood-%d", i))}
	}
	upstream.mu.Lock()
	upstream.httpBatches = batch
	upstream.mu.Unlock()

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	result, err := pipeline.RefreshNow(ctx)
	if err != nil {
		t.Fatalf("RefreshNow: %v", err)
	}
	if result.Synced {
		t.Fatalf("a queue that never drained must not be reported as synced: %+v", result)
	}
	if result.Error == "" {
		t.Fatal("an undrained pass must explain itself")
	}
}

func TestRefreshNowRefusesOverlappingRequests(t *testing.T) {
	store := newStore(t)
	upstream := newFakeUpstream()
	runner, err := NewRunner("default", upstream, store, nil, nil, syncConfig(ModeHTTPPull))
	if err != nil {
		t.Fatal(err)
	}
	processor, err := NewProcessor(store, nil, 10, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	pipeline, err := NewPipeline(runner, processor, nil, store)
	if err != nil {
		t.Fatal(err)
	}
	// The collector is not running on purpose: the first caller blocks on the
	// capture handshake, which is exactly when a second one must be refused.
	if _, err := pipeline.RefreshNow(context.Background()); err == nil {
		t.Fatal("expected the first refresh to fail without a collector")
	}
	if !pipeline.tryAcquireRefresh() {
		t.Fatal("test setup left the refresh slot held")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if _, err := pipeline.RefreshNow(ctx); !errors.Is(err, ErrRefreshBusy) {
		t.Fatalf("overlapping error = %v, want ErrRefreshBusy", err)
	}
	pipeline.releaseRefresh()
}

func TestRefreshNowReportsDisabledIngestion(t *testing.T) {
	pipeline, err := NewPipeline(nil, mustProcessor(t), nil, newStore(t))
	if err != nil {
		t.Fatal(err)
	}
	result, err := pipeline.RefreshNow(context.Background())
	if err != nil {
		t.Fatalf("a disabled pipeline is not an error: %v", err)
	}
	if result.Enabled || result.Synced {
		t.Fatalf("disabled pipeline reported a sync: %+v", result)
	}
}

// A manual refresh must obey the same authentication cooldown as the background
// loop. A key CPA already rejected may not be retried on demand, or an operator
// clicking refresh five times would trip CPA's IP ban.
func TestCaptureNowRespectsAuthenticationCooldown(t *testing.T) {
	store := newStore(t)
	upstream := newFakeUpstream()
	upstream.httpErr = fmt.Errorf("CPA returned HTTP 403: IP banned due to too many failed attempts")
	config := fastConfig(ModeHTTPPull)
	config.IdleInterval = time.Hour
	config.MaxIdleInterval = time.Hour
	config.AuthCooldown = 30 * time.Second
	runner, err := NewRunner("default", upstream, store, nil, nil, config)
	if err != nil {
		t.Fatal(err)
	}
	startRunner(t, runner)
	waitForMode(t, runner, ModeHTTPPull)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if _, err := runner.CaptureNow(ctx); err == nil {
		t.Fatal("a rejected key must surface as a failed sync")
	}
	callsAfterFirst := upstream.callCount()

	// The collector is now in its cooldown. A second refresh must not reach CPA
	// again; it should time out waiting rather than spend another attempt.
	burst, cancelBurst := context.WithTimeout(context.Background(), 500*time.Millisecond)
	defer cancelBurst()
	if _, err := runner.CaptureNow(burst); err == nil {
		t.Fatal("a refresh during cooldown must not report success")
	}
	if got := upstream.callCount(); got != callsAfterFirst {
		t.Fatalf("cooldown was bypassed: %d calls, want %d", got, callsAfterFirst)
	}
}

// A decoder that is busy must not make a manual refresh block past its own
// deadline: the gate is acquired within the caller's budget, not before it.
func TestDrainGivesUpWhenTheDecodeGateIsBusy(t *testing.T) {
	store := newStore(t)
	processor, err := NewProcessor(store, nil, 10, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	// Hold the gate the way the background loop would while it decodes.
	if err := processor.acquire(context.Background()); err != nil {
		t.Fatal(err)
	}
	defer processor.release()

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	started := time.Now()
	if _, err := processor.Drain(ctx, 1, 0); err == nil {
		t.Fatal("a busy decode gate must not report a completed barrier")
	}
	// The deadline is zero seconds, so waiting for the gate must expire with it
	// instead of blocking until the background pass finishes.
	if elapsed := time.Since(started); elapsed > time.Second {
		t.Fatalf("Drain waited %s on a held gate", elapsed)
	}
}

// A captured payload that cannot be decoded leaves no event. Reporting the sync
// as complete would promise the operator a record the list can never show.
func TestRefreshNowReportsUndecodableRecords(t *testing.T) {
	store := newStore(t)
	ctx := context.Background()
	processor, err := NewProcessor(store, nil, 10, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.AppendUsageInbox(ctx, "default", string(ModeHTTPPull),
		[]string{`{"model":"broken`}, time.Now()); err != nil {
		t.Fatal(err)
	}
	watermark, err := store.LatestUsageInboxID(ctx)
	if err != nil {
		t.Fatal(err)
	}

	// Retried past the attempt limit, the row is parked as undecodable.
	var drain DrainResult
	for pass := 0; pass < 20 && drain.Failed == 0; pass++ {
		if _, err := processor.ProcessOnce(ctx); err != nil {
			t.Fatal(err)
		}
		drain, err = processor.Drain(ctx, watermark, 1)
		if err != nil {
			t.Fatal(err)
		}
	}
	if drain.Pending != 0 {
		t.Fatalf("pending = %d, want the poison row parked", drain.Pending)
	}
	if drain.Failed == 0 {
		t.Fatal("an undecodable record must be reported, not silently dropped")
	}
}

func TestDrainLeavesRecordsCapturedAfterItsWatermark(t *testing.T) {
	store := newStore(t)
	ctx := context.Background()
	processor, err := NewProcessor(store, nil, 10, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.AppendUsageInbox(ctx, "default", string(ModeHTTPPull),
		[]string{usagePayload("inside-1"), usagePayload("inside-2")}, time.Now()); err != nil {
		t.Fatal(err)
	}
	watermark, err := store.LatestUsageInboxID(ctx)
	if err != nil {
		t.Fatal(err)
	}
	// Arrives after the pass being waited on, so it belongs to the next refresh.
	// It may or may not be picked up by this drain's own batch: the barrier is
	// scoped by the watermark alone (which is what keeps the wait bounded), not by
	// excluding later rows from decoding. What it must not do is hold the barrier
	// open, so it cannot be a record still waiting to decode.
	if _, err := store.AppendUsageInbox(ctx, "default", string(ModeHTTPPull),
		[]string{usagePayload("after-1")}, time.Now()); err != nil {
		t.Fatal(err)
	}

	remaining, err := processor.Drain(ctx, watermark, 2)
	if err != nil {
		t.Fatal(err)
	}
	if remaining.Pending != 0 {
		t.Fatalf("pending = %d, want 0 for rows at or below the watermark", remaining.Pending)
	}
	if got := eventsFor(t, store, "inside-1", "inside-2"); got != 2 {
		t.Fatalf("watermarked events = %d, want 2", got)
	}
	if pending := inboxCount(t, store, repository.InboxPending); pending != 0 {
		t.Fatalf("pending = %d after the barrier", pending)
	}
}

// The barrier must not wait for a record that keeps the pending count above zero,
// which is the whole reason the wait is scoped by a watermark instead of by
// "pending == 0" over the live table.
func TestDrainIgnoreRecordsAboveItsWatermark(t *testing.T) {
	store := newStore(t)
	ctx := context.Background()
	processor, err := NewProcessor(store, nil, 1, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.AppendUsageInbox(ctx, "default", string(ModeHTTPPull),
		[]string{usagePayload("inside-only")}, time.Now()); err != nil {
		t.Fatal(err)
	}
	watermark, err := store.LatestUsageInboxID(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.AppendUsageInbox(ctx, "default", string(ModeHTTPPull),
		[]string{usagePayload("later")}, time.Now()); err != nil {
		t.Fatal(err)
	}

	remaining, err := processor.Drain(ctx, watermark, 5)
	if err != nil {
		t.Fatal(err)
	}
	if remaining.Pending != 0 {
		t.Fatalf("pending = %d, want 0", remaining.Pending)
	}
	if got := eventsFor(t, store, "inside-only"); got != 1 {
		t.Fatalf("watermarked event = %d, want 1", got)
	}
}

func TestProcessOnceSerializesConcurrentDecoders(t *testing.T) {
	store := newStore(t)
	ctx := context.Background()
	payloads := make([]string, 0, 24)
	for i := 0; i < 24; i++ {
		payloads = append(payloads, usagePayload(fmt.Sprintf("race-%d", i)))
	}
	if _, err := store.AppendUsageInbox(ctx, "default", string(ModeHTTPPull), payloads, time.Now()); err != nil {
		t.Fatal(err)
	}
	processor, err := NewProcessor(store, nil, 4, time.Hour)
	if err != nil {
		t.Fatal(err)
	}

	// usage_events.event_key is deliberately not unique, so concurrent decoders
	// would each insert their own copy of the same inbox rows. Serialising the
	// pass is what keeps one payload to one event.
	var waitGroup sync.WaitGroup
	for worker := 0; worker < 4; worker++ {
		waitGroup.Add(1)
		go func() {
			defer waitGroup.Done()
			for pass := 0; pass < 8; pass++ {
				if _, err := processor.ProcessOnce(ctx); err != nil {
					t.Errorf("ProcessOnce: %v", err)
					return
				}
			}
		}()
	}
	waitGroup.Wait()

	var events int
	if err := store.SQL().QueryRow(`SELECT COUNT(1) FROM usage_events`).Scan(&events); err != nil {
		t.Fatal(err)
	}
	if events != len(payloads) {
		t.Fatalf("events = %d, want %d (one per captured record)", events, len(payloads))
	}
	if pending := inboxCount(t, store, repository.InboxPending); pending != 0 {
		t.Fatalf("pending = %d after concurrent decoding", pending)
	}
}

func mustProcessor(t *testing.T) *Processor {
	t.Helper()
	processor, err := NewProcessor(newStore(t), nil, 10, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	return processor
}
