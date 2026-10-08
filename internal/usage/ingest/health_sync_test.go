package ingest

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"testing"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/management"
	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
)

// The fixtures below hold the collector at each queue read, so a test decides what a
// manual sync or a health read observes without waiting on timers.
const HEALTH_SYNC_TIMEOUT = 10 * time.Second

const HEALTH_SYNC_POISON = `{"model":"fixture-poison`

type healthSyncPopReply struct {
	payloads []string
	err      error
}

type healthSyncPopRequest struct {
	count int
	reply chan healthSyncPopReply
}

// No management client or socket is constructed: every destructive pop is held
// on a request/reply channel so the test owns the interleaving.
type healthSyncUpstream struct {
	calls chan healthSyncPopRequest
}

func (*healthSyncUpstream) ProbeUsageChannel(context.Context) error {
	return errors.New("fixture forbids transport probing")
}

func (*healthSyncUpstream) OpenUsageStream(context.Context, string) (Stream, error) {
	return nil, errors.New("fixture forbids subscriptions")
}

func (*healthSyncUpstream) PopUsageQueue(context.Context, int) ([]string, error) {
	return nil, errors.New("fixture forbids RESP pops")
}

func (upstream *healthSyncUpstream) UsageQueueJSON(ctx context.Context, count int) ([]string, error) {
	request := healthSyncPopRequest{count: count, reply: make(chan healthSyncPopReply, 1)}
	select {
	case upstream.calls <- request:
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	select {
	case reply := <-request.reply:
		return reply.payloads, reply.err
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func healthSyncConfig() Config {
	// Timers are outside the experiment budget; channels, not a polling tick,
	// establish readiness and each capture boundary.
	return Config{
		Mode:            ModeHTTPPull,
		BatchSize:       1,
		IdleInterval:    time.Hour,
		MaxIdleInterval: time.Hour,
		BackoffInitial:  time.Hour,
		BackoffMax:      time.Hour,
		AuthCooldown:    2 * time.Hour,
		ReadinessGrace:  time.Hour,
	}
}

func healthSyncNewRunner(t *testing.T, store *repository.Repository, upstream *healthSyncUpstream) *Runner {
	t.Helper()
	runner, err := NewRunner("default", upstream, store, nil,
		slog.New(slog.NewTextHandler(io.Discard, nil)), healthSyncConfig())
	if err != nil {
		t.Fatal(err)
	}
	return runner
}

type healthSyncRefreshReply struct {
	result RefreshNowResult
	err    error
}

type healthSyncHarness struct {
	ctx       context.Context
	cancel    context.CancelFunc
	store     *repository.Repository
	upstream  *healthSyncUpstream
	runner    *Runner
	processor *Processor
	pipeline  *Pipeline
	firstPop  healthSyncPopRequest
}

func healthSyncNewHarness(t *testing.T) *healthSyncHarness {
	t.Helper()
	store := newStore(t)
	upstream := &healthSyncUpstream{calls: make(chan healthSyncPopRequest)}
	runner := healthSyncNewRunner(t, store, upstream)
	processor, err := NewProcessor(store, slog.New(slog.NewTextHandler(io.Discard, nil)), 1, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	pipeline, err := NewPipeline(runner, processor, nil, store)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), HEALTH_SYNC_TIMEOUT)
	finished := make(chan error, 1)
	go func() { finished <- runner.Run(ctx) }()
	t.Cleanup(func() {
		cancel()
		cleanupCtx, finishCleanup := context.WithTimeout(context.Background(), 5*time.Second)
		defer finishCleanup()
		select {
		case runErr := <-finished:
			if runErr != nil {
				t.Errorf("collector teardown: %v", runErr)
			}
		case <-cleanupCtx.Done():
			t.Error("collector did not join after cancellation")
		}
	})
	harness := &healthSyncHarness{
		ctx: ctx, cancel: cancel, store: store, upstream: upstream, runner: runner,
		processor: processor, pipeline: pipeline,
	}
	harness.firstPop = harness.nextPop(t, "initial background pop")
	return harness
}

func (harness *healthSyncHarness) nextPop(t *testing.T, phase string) healthSyncPopRequest {
	t.Helper()
	select {
	case request := <-harness.upstream.calls:
		t.Logf("capture barrier: phase=%q requested_batch_size=%d", phase, request.count)
		if request.count != 1 {
			t.Fatalf("fixture requires batch size 1, got %d", request.count)
		}
		return request
	case <-harness.ctx.Done():
		t.Fatalf("capture barrier %q: %v", phase, harness.ctx.Err())
		return healthSyncPopRequest{}
	}
}

func (harness *healthSyncHarness) beginRefresh(t *testing.T) <-chan healthSyncRefreshReply {
	t.Helper()
	finished := make(chan healthSyncRefreshReply, 1)
	settled := make(chan struct{})
	go func() {
		defer close(settled)
		result, err := harness.pipeline.RefreshNow(harness.ctx)
		finished <- healthSyncRefreshReply{result: result, err: err}
	}()
	t.Cleanup(func() {
		harness.cancel()
		cleanupCtx, finishCleanup := context.WithTimeout(context.Background(), 5*time.Second)
		defer finishCleanup()
		select {
		case <-settled:
		case <-cleanupCtx.Done():
			t.Error("manual refresh did not join after cancellation")
		}
	})

	// The initial pop is still held. Observe then restore this exact queued
	// request before releasing an empty initial batch: only the manual pass can
	// receive the payload supplied by the test. No second collector is introduced.
	select {
	case request := <-harness.runner.syncRequests:
		select {
		case harness.runner.syncRequests <- request:
		case <-harness.ctx.Done():
			t.Fatalf("restore admitted manual request: %v", harness.ctx.Err())
		}
	case <-harness.ctx.Done():
		t.Fatalf("manual request was not admitted: %v", harness.ctx.Err())
	}
	harness.firstPop.reply <- healthSyncPopReply{}
	return finished
}

func (harness *healthSyncHarness) awaitRefresh(t *testing.T, finished <-chan healthSyncRefreshReply) healthSyncRefreshReply {
	t.Helper()
	select {
	case reply := <-finished:
		t.Logf("RefreshNow: result=%+v error=%v", reply.result, reply.err)
		return reply
	case <-harness.ctx.Done():
		t.Fatalf("manual refresh did not finish: %v", harness.ctx.Err())
		return healthSyncRefreshReply{}
	}
}

func healthSyncParkPoison(t *testing.T, harness *healthSyncHarness, inboxID int64) {
	t.Helper()
	// Twelve bounded production ProcessOnce passes represent a possible schedule
	// of the same background processor while the manual capture is still held.
	for pass := 0; pass < 12; pass++ {
		if _, err := harness.processor.ProcessOnce(harness.ctx); err != nil {
			t.Fatalf("poison decode pass %d: %v", pass+1, err)
		}
	}
	var status string
	var attempts int
	if err := harness.store.SQL().QueryRowContext(harness.ctx,
		`SELECT status, attempt_count FROM usage_inboxes WHERE id = ?`, inboxID).Scan(&status, &attempts); err != nil {
		t.Fatal(err)
	}
	t.Logf("before Drain: inbox_id=%d status=%q decode_attempts=%d", inboxID, status, attempts)
	if status != repository.InboxDiscarded || attempts != 12 {
		t.Fatalf("fixture failed to park poison: status=%q attempts=%d", status, attempts)
	}
}

func TestManualSyncAccountsForCapturedPoison(t *testing.T) {
	cases := []struct {
		name                 string
		hasPriorDiscard      bool
		shouldDiscardCurrent bool
	}{
		{name: "poison_discarded_before_drain", shouldDiscardCurrent: true},
		{name: "old_discard_does_not_poison_clean_pass", hasPriorDiscard: true},
	}
	for _, scenario := range cases {
		t.Run(scenario.name, func(t *testing.T) {
			harness := healthSyncNewHarness(t)
			if scenario.hasPriorDiscard {
				if _, err := harness.store.AppendUsageInbox(harness.ctx, "default", string(ModeHTTPPull),
					[]string{HEALTH_SYNC_POISON}, time.Now()); err != nil {
					t.Fatal(err)
				}
				priorID, err := harness.store.LatestUsageInboxID(harness.ctx)
				if err != nil {
					t.Fatal(err)
				}
				healthSyncParkPoison(t, harness, priorID)
			}

			finished := harness.beginRefresh(t)
			manualPop := harness.nextPop(t, "manual payload pop")
			payload := usagePayload("fixture-state04-clean")
			if scenario.shouldDiscardCurrent {
				payload = HEALTH_SYNC_POISON
			}
			manualPop.reply <- healthSyncPopReply{payloads: []string{payload}}
			// BatchSize=1 forces persistence before this next pop. Holding its empty
			// answer prevents CaptureNow from returning and Drain from starting.
			emptyPop := harness.nextPop(t, "manual empty pop held before Drain")
			inboxID, err := harness.store.LatestUsageInboxID(harness.ctx)
			if err != nil {
				t.Fatal(err)
			}
			pending, err := harness.store.CountPendingUsageInboxBefore(harness.ctx, inboxID)
			if err != nil || pending != 1 {
				t.Fatalf("fixture capture was not durable and pending: pending=%d error=%v", pending, err)
			}
			if scenario.shouldDiscardCurrent {
				healthSyncParkPoison(t, harness, inboxID)
			}
			emptyPop.reply <- healthSyncPopReply{}
			reply := harness.awaitRefresh(t, finished)
			if reply.err != nil {
				t.Fatalf("unexpected transport/barrier error: %v", reply.err)
			}
			var events int
			if err := harness.store.SQL().QueryRowContext(harness.ctx, `SELECT COUNT(1) FROM usage_events`).Scan(&events); err != nil {
				t.Fatal(err)
			}
			t.Logf("persisted events=%d captured=%d pending=%d failed=%d synced=%t",
				events, reply.result.Captured, reply.result.Pending, reply.result.Failed, reply.result.Synced)
			if reply.result.Captured != 1 || reply.result.Pending != 0 {
				t.Fatalf("fixture did not finish one captured record: %+v", reply.result)
			}
			if scenario.shouldDiscardCurrent {
				if events != 0 || reply.result.Synced || reply.result.Failed != 1 || reply.result.Error == "" {
					t.Errorf("STATE-04: desired synced=false, failed=1, nonempty error, events=0; actual result=%+v events=%d", reply.result, events)
				}
			} else if events != 1 || !reply.result.Synced || reply.result.Failed != 0 || reply.result.Error != "" {
				t.Errorf("STATE-04 control: an old discard must not spoil a clean pass; result=%+v events=%d", reply.result, events)
			}
		})
	}
}

func TestIngestHealthReflectsCollectorState(t *testing.T) {
	store := newStore(t)
	processor, err := NewProcessor(store, nil, 1, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		name            string
		mode            Mode
		isRunning       bool
		failure         error
		shouldBeHealthy bool
	}{
		{name: "authentication_cooldown", mode: ModeHTTPPull, isRunning: true,
			failure: &management.HTTPError{StatusCode: http.StatusUnauthorized, Body: "synthetic rejection"}},
		{name: "transport_unavailable", mode: ModeHTTPPull, isRunning: true, failure: errors.New("synthetic CPA outage")},
		{name: "stopped_with_selected_mode", mode: ModeHTTPPull},
		{name: "disabled", mode: ModeOff},
	}
	for _, scenario := range cases {
		t.Run(scenario.name, func(t *testing.T) {
			runner := healthSyncNewRunner(t, store, &healthSyncUpstream{calls: make(chan healthSyncPopRequest)})
			// Status projection is the seam under test; these are synthetic
			// collector snapshots, not a claim that a live cooldown was executed.
			runner.setMode(scenario.mode, "")
			runner.setRunning(scenario.isRunning)
			if scenario.failure != nil {
				runner.recordErrorAt(scenario.failure, isAuthRejection(scenario.failure))
			}
			pipeline, err := NewPipeline(runner, processor, nil, store)
			if err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithTimeout(context.Background(), HEALTH_SYNC_TIMEOUT)
			defer cancel()
			status, err := pipeline.Status(ctx)
			if err != nil {
				t.Fatal(err)
			}
			t.Logf("ingest health: healthy=%t collector=%+v", status.Healthy, status.Collector)
			if status.Healthy != scenario.shouldBeHealthy {
				t.Errorf("STATE-06: desired healthy=%t for %s; actual healthy=%t collector=%+v",
					scenario.shouldBeHealthy, scenario.name, status.Healthy, status.Collector)
			}
		})
	}
}

func TestWorkingEmptyCollectorCanBeHealthy(t *testing.T) {
	harness := healthSyncNewHarness(t)
	finished := harness.beginRefresh(t)
	manualPop := harness.nextPop(t, "successful empty manual capture")
	manualPop.reply <- healthSyncPopReply{}
	reply := harness.awaitRefresh(t, finished)
	if reply.err != nil || !reply.result.Synced || reply.result.Captured != 0 {
		t.Fatalf("fixture must complete a legitimate empty capture: result=%+v error=%v", reply.result, reply.err)
	}
	status, err := harness.pipeline.Status(harness.ctx)
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("recovered/working empty capture: healthy=%t collector=%+v", status.Healthy, status.Collector)
	if !status.Healthy || !status.Collector.Running {
		t.Errorf("STATE-06 control: a working collector with a successful empty pass should be healthy; actual=%+v", status)
	}
}

func TestAuthRejectedTracksLatestFailure(t *testing.T) {
	store := newStore(t)
	runner := healthSyncNewRunner(t, store, &healthSyncUpstream{calls: make(chan healthSyncPopRequest)})
	authFailure := &management.HTTPError{StatusCode: http.StatusUnauthorized, Body: "synthetic rejection"}
	runner.recordErrorAt(authFailure, isAuthRejection(authFailure))
	authStatus := runner.Status()
	t.Logf("first authentication failure: %+v", authStatus)
	if !authStatus.AuthRejected {
		t.Fatal("fixture failed to classify the first authentication rejection")
	}
	nonAuthFailure := &management.HTTPError{StatusCode: http.StatusServiceUnavailable, Body: "synthetic availability failure"}
	runner.recordErrorAt(nonAuthFailure, isAuthRejection(nonAuthFailure))
	latest := runner.Status()
	t.Logf("later non-authentication failure: %+v", latest)
	if latest.LastError != nonAuthFailure.Error() {
		t.Fatal("fixture failed to replace LastError with the non-authentication failure")
	}
	if latest.AuthRejected {
		t.Errorf("STATE-07: desired auth_rejected=false for the latest HTTP 503 failure; actual status=%+v", latest)
	}
}

func TestRefreshDoesNotReuseHistoricalAuthFailure(t *testing.T) {
	harness := healthSyncNewHarness(t)
	authFailure := &management.HTTPError{StatusCode: http.StatusUnauthorized, Body: "synthetic rejection"}
	nonAuthFailure := &management.HTTPError{StatusCode: http.StatusServiceUnavailable, Body: "synthetic availability failure"}
	// Establish the last-failure history before this manual pass, independently
	// of Run's asynchronous error update after completeCapture answers the caller.
	harness.runner.recordErrorAt(authFailure, isAuthRejection(authFailure))
	harness.runner.recordErrorAt(nonAuthFailure, isAuthRejection(nonAuthFailure))
	finished := harness.beginRefresh(t)
	manualPop := harness.nextPop(t, "manual HTTP 503 failure")
	manualPop.reply <- healthSyncPopReply{err: nonAuthFailure}
	reply := harness.awaitRefresh(t, finished)
	t.Logf("failed sync auth classification: auth_rejected=%t last_error=%q",
		reply.result.AuthRejected, harness.runner.Status().LastError)
	if !errors.Is(reply.err, nonAuthFailure) || reply.result.Synced || reply.result.Error == "" {
		t.Fatalf("fixture must report the manual transport failure: result=%+v error=%v", reply.result, reply.err)
	}
	if reply.result.AuthRejected {
		t.Errorf("STATE-07: a manual HTTP 503 failure must not reuse historical auth rejection; actual result=%+v", reply.result)
	}
}
