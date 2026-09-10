package ingest

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/management"
	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
)

var ingestDSNCounter atomic.Uint64

// newStore opens a migrated database with the instance row the foreign keys
// require, so the pipeline is exercised against real SQL rather than a mock.
func newStore(t *testing.T) *repository.Repository {
	t.Helper()
	name := fmt.Sprintf("file:memdb_ingest_%d?mode=memory&cache=shared", ingestDSNCounter.Add(1))
	db, err := repository.Open(context.Background(), name)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	store := repository.New(db)
	if _, err := db.SQL.Exec(`
		INSERT INTO cpa_instances (id, name, base_url, usage_addr,
			management_key_ciphertext, management_key_nonce, status, created_at, updated_at)
		VALUES ('default', 'Default', 'http://127.0.0.1:8317', '127.0.0.1:8317',
			x'00', x'00', 'unknown', 0, 0)`); err != nil {
		t.Fatal(err)
	}
	return store
}

type fakeStream struct {
	channel   string
	messages  chan string
	closeOnce sync.Once
	closed    atomic.Bool
}

func (f *fakeStream) Messages() <-chan string { return f.messages }
func (f *fakeStream) Channel() string         { return f.channel }
func (f *fakeStream) Close() error {
	f.closeOnce.Do(func() {
		f.closed.Store(true)
		close(f.messages)
	})
	return nil
}

type fakeUpstream struct {
	mu sync.Mutex

	probeErr  error
	streamErr error
	opened    []string
	streams   map[string]*fakeStream

	popBatches [][]string
	popErr     error
	popCalls   int

	httpBatches [][]string
	httpErr     error
	httpCalls   int
}

func newFakeUpstream() *fakeUpstream {
	return &fakeUpstream{streams: map[string]*fakeStream{}}
}

func (f *fakeUpstream) ProbeUsageChannel(context.Context) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.probeErr
}

func (f *fakeUpstream) OpenUsageStream(_ context.Context, channel string) (Stream, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.streamErr != nil {
		return nil, f.streamErr
	}
	if existing, ok := f.streams[channel]; ok {
		return existing, nil
	}
	stream := &fakeStream{channel: channel, messages: make(chan string, 16)}
	f.streams[channel] = stream
	f.opened = append(f.opened, channel)
	return stream, nil
}

func (f *fakeUpstream) PopUsageQueue(context.Context, int) ([]string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.popCalls++
	if f.popErr != nil {
		return nil, f.popErr
	}
	if len(f.popBatches) == 0 {
		return nil, nil
	}
	batch := f.popBatches[0]
	f.popBatches = f.popBatches[1:]
	return batch, nil
}

func (f *fakeUpstream) UsageQueueJSON(context.Context, int) ([]string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.httpCalls++
	if f.httpErr != nil {
		return nil, f.httpErr
	}
	if len(f.httpBatches) == 0 {
		return nil, nil
	}
	batch := f.httpBatches[0]
	f.httpBatches = f.httpBatches[1:]
	return batch, nil
}

func (f *fakeUpstream) push(channel, payload string) {
	f.mu.Lock()
	stream := f.streams[channel]
	f.mu.Unlock()
	if stream == nil {
		return
	}
	select {
	case stream.messages <- payload:
	case <-time.After(2 * time.Second):
	}
}

func fastConfig(mode Mode) Config {
	return Config{
		Mode:             mode,
		IdleInterval:     10 * time.Millisecond,
		BatchSize:        10,
		BackoffInitial:   10 * time.Millisecond,
		BackoffMax:       50 * time.Millisecond,
		AllFailedInitial: 10 * time.Millisecond,
		AllFailedMax:     50 * time.Millisecond,
		BackfillInterval: 20 * time.Millisecond,
	}
}

func runFor(t *testing.T, runner *Runner, delay time.Duration) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), delay)
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- runner.Run(ctx) }()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("runner returned %v", err)
		}
	case <-time.After(delay + 5*time.Second):
		t.Fatal("runner did not stop on context cancellation")
	}
}

func usagePayload(id string) string {
	return fmt.Sprintf(`{"request_id":%q,"model":"gemini-2.5-pro","timestamp":"2026-08-31T10:00:00Z","tokens":{"total_tokens":5}}`, id)
}

func inboxCount(t *testing.T, store *repository.Repository, status string) int {
	t.Helper()
	var count int
	query := `SELECT COUNT(1) FROM usage_inboxes`
	args := []any{}
	if status != "" {
		query += ` WHERE status = ?`
		args = append(args, status)
	}
	if err := store.SQL().QueryRow(query, args...).Scan(&count); err != nil {
		t.Fatal(err)
	}
	return count
}

func TestRunnerCapturesHTTPPullAndFiltersControlFrames(t *testing.T) {
	store := newStore(t)
	upstream := newFakeUpstream()
	upstream.httpBatches = [][]string{
		{usagePayload("a"), `{"support_refresh":true}`, usagePayload("b")},
	}
	refreshes := atomic.Int32{}
	runner, err := NewRunner("default", upstream, store, nil, nil, fastConfig(ModeHTTPPull))
	if err != nil {
		t.Fatal(err)
	}
	runner.SetRefreshHandler(func() { refreshes.Add(1) })

	runFor(t, runner, 150*time.Millisecond)

	if inboxCount(t, store, repository.InboxPending) != 2 {
		t.Fatalf("control frame must not occupy the inbox: %d pending", inboxCount(t, store, repository.InboxPending))
	}
	status := runner.Status()
	if status.Captured != 2 {
		t.Fatalf("captured = %d, want 2", status.Captured)
	}
	if status.ControlFrames != 1 {
		t.Fatalf("control frames = %d, want 1", status.ControlFrames)
	}
	if status.Mode != ModeHTTPPull {
		t.Fatalf("mode = %q", status.Mode)
	}
	if upstream.httpCalls == 0 {
		t.Fatal("HTTP pull path never used")
	}
}

func TestRunnerRefreshSignalInvokesHandler(t *testing.T) {
	store := newStore(t)
	upstream := newFakeUpstream()
	upstream.httpBatches = [][]string{{`{"refresh":true}`}}
	called := make(chan struct{}, 1)
	runner, err := NewRunner("default", upstream, store, nil, nil, fastConfig(ModeHTTPPull))
	if err != nil {
		t.Fatal(err)
	}
	runner.SetRefreshHandler(func() {
		select {
		case called <- struct{}{}:
		default:
		}
	})

	runFor(t, runner, 120*time.Millisecond)

	select {
	case <-called:
	default:
		t.Fatal("CPA refresh notification did not reach the handler")
	}
	if inboxCount(t, store, "") != 0 {
		t.Fatal("refresh notification must not be stored as usage")
	}
}

func TestRunnerAutoPrefersSubscription(t *testing.T) {
	store := newStore(t)
	upstream := newFakeUpstream()
	runner, err := NewRunner("default", upstream, store, nil, nil, fastConfig(ModeAuto))
	if err != nil {
		t.Fatal(err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- runner.Run(ctx) }()

	// Wait for the subscription to be established before pushing.
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if runner.Status().Mode == ModeSubscribe {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	upstream.push(management.UsageChannel, usagePayload("live-1"))
	upstream.push(management.UsageChannel, usagePayload("live-2"))

	waitForInbox(t, store, 2)
	cancel()
	if err := <-done; err != nil {
		t.Fatalf("runner returned %v", err)
	}

	if got := runner.Status().Mode; got != ModeSubscribe {
		t.Fatalf("auto mode should subscribe when available, got %q", got)
	}
	if upstream.httpCalls != 0 {
		t.Fatalf("subscription must not also drain the HTTP queue (would double count): %d calls", upstream.httpCalls)
	}
}

func TestRunnerAutoDegradesToRESPullAfterSubscribeFailures(t *testing.T) {
	store := newStore(t)
	upstream := newFakeUpstream()
	// RESP answers PING but refuses SUBSCRIBE: the collector must keep working
	// by batch pulling rather than looping on a dead path.
	upstream.streamErr = fmt.Errorf("ERR unknown command 'SUBSCRIBE'")
	upstream.popBatches = [][]string{{usagePayload("p1"), usagePayload("p2")}}
	runner, err := NewRunner("default", upstream, store, nil, nil, fastConfig(ModeAuto))
	if err != nil {
		t.Fatal(err)
	}

	runFor(t, runner, 400*time.Millisecond)

	if got := runner.Status().Mode; got != ModeRESPPull {
		t.Fatalf("mode = %q, want %q after %d subscribe failures", got, ModeRESPPull, maxSubscribeFailures)
	}
	if inboxCount(t, store, repository.InboxPending) != 2 {
		t.Fatalf("RESP pull payloads not captured: %d", inboxCount(t, store, repository.InboxPending))
	}
}

func TestRunnerAutoUsesHTTPWhenRESPUnavailable(t *testing.T) {
	store := newStore(t)
	upstream := newFakeUpstream()
	upstream.probeErr = fmt.Errorf("dial tcp: connection refused")
	upstream.httpBatches = [][]string{{usagePayload("h1")}}
	runner, err := NewRunner("default", upstream, store, nil, nil, fastConfig(ModeAuto))
	if err != nil {
		t.Fatal(err)
	}

	runFor(t, runner, 150*time.Millisecond)

	if got := runner.Status().Mode; got != ModeHTTPPull {
		t.Fatalf("mode = %q, want %q", got, ModeHTTPPull)
	}
	if inboxCount(t, store, repository.InboxPending) != 1 {
		t.Fatalf("HTTP payloads not captured: %d", inboxCount(t, store, repository.InboxPending))
	}
	if upstream.popCalls != 0 {
		t.Fatal("RESP must not be used when the RESP handshake fails")
	}
}

func TestRunnerUnreachableCPASurfacesErrorAndRetries(t *testing.T) {
	store := newStore(t)
	upstream := newFakeUpstream()
	upstream.probeErr = fmt.Errorf("dial refused")
	upstream.httpErr = fmt.Errorf("connection refused")
	runner, err := NewRunner("default", upstream, store, nil, nil, fastConfig(ModeAuto))
	if err != nil {
		t.Fatal(err)
	}

	runFor(t, runner, 120*time.Millisecond)

	status := runner.Status()
	if status.LastError == "" {
		t.Fatal("unreachable CPA must be surfaced in status")
	}
	if upstream.httpCalls == 0 {
		t.Fatal("HTTP queue must still be attempted when RESP is down")
	}
	if upstream.httpCalls < 2 {
		t.Fatalf("collector must keep retrying after CPA comes back, attempts = %d", upstream.httpCalls)
	}
}

func TestRunnerCoolsDownWhenCPARejectsTheKey(t *testing.T) {
	store := newStore(t)
	upstream := newFakeUpstream()
	// CPA answers 403 for a wrong key and bans the IP after five attempts.
	upstream.httpErr = fmt.Errorf("CPA returned HTTP 403: IP banned due to too many failed attempts")
	config := fastConfig(ModeHTTPPull)
	config.AuthCooldown = 30 * time.Second

	runner, err := NewRunner("default", upstream, store, nil, nil, config)
	if err != nil {
		t.Fatal(err)
	}
	runFor(t, runner, 200*time.Millisecond)

	status := runner.Status()
	if !status.AuthRejected {
		t.Fatalf("auth rejection must be flagged for the UI: %+v", status)
	}
	// With a 10ms idle interval and no cooldown, 200ms would produce ~20 calls
	// and burn CPA's five-strike ban budget. The cooldown must dominate.
	if upstream.httpCalls > 4 {
		t.Fatalf("collector kept hammering a rejecting CPA: %d calls", upstream.httpCalls)
	}
}

func TestRunnerDisabledModeStopsCollecting(t *testing.T) {
	store := newStore(t)
	upstream := newFakeUpstream()
	upstream.httpBatches = [][]string{{usagePayload("a")}}
	runner, err := NewRunner("default", upstream, store, nil, nil, fastConfig(ModeOff))
	if err != nil {
		t.Fatal(err)
	}
	runFor(t, runner, 80*time.Millisecond)

	if upstream.httpCalls != 0 {
		t.Fatal("off mode must not touch CPA")
	}
	if runner.Status().Mode != ModeOff {
		t.Fatalf("mode = %q, want off", runner.Status().Mode)
	}
}

func TestRunnerRejectsUnknownModeAndMissingDeps(t *testing.T) {
	store := newStore(t)
	upstream := newFakeUpstream()
	if _, err := NewRunner("default", upstream, store, nil, nil, Config{Mode: Mode("telepathy")}); err == nil {
		t.Fatal("unknown mode must be rejected")
	}
	if _, err := NewRunner("default", nil, store, nil, nil, Config{}); err == nil {
		t.Fatal("missing upstream must be rejected")
	}
	if _, err := NewRunner("default", upstream, nil, nil, nil, Config{}); err == nil {
		t.Fatal("missing sink must be rejected")
	}
}

func TestProcessorCommitsEventsAndMarksInbox(t *testing.T) {
	store := newStore(t)
	ctx := context.Background()
	if _, err := store.AppendUsageInbox(ctx, "default", string(ModeHTTPPull),
		[]string{usagePayload("ok1"), usagePayload("ok2")}, time.Now()); err != nil {
		t.Fatal(err)
	}
	processor, err := NewProcessor(store, nil, 10, time.Millisecond)
	if err != nil {
		t.Fatal(err)
	}
	handled, err := processor.ProcessOnce(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if handled != 2 {
		t.Fatalf("handled = %d, want 2", handled)
	}

	var events int
	if err := store.SQL().QueryRow(`SELECT COUNT(1) FROM usage_events WHERE event_key IN ('ok1','ok2')`).Scan(&events); err != nil {
		t.Fatal(err)
	}
	if events != 2 {
		t.Fatalf("events committed = %d", events)
	}
	if pending := inboxCount(t, store, repository.InboxPending); pending != 0 {
		t.Fatalf("processed rows still pending: %d", pending)
	}
	if processed := inboxCount(t, store, repository.InboxProcessed); processed != 2 {
		t.Fatalf("processed rows = %d", processed)
	}
	// The event key must be recorded on the inbox row for traceability.
	var key string
	if err := store.SQL().QueryRow(`SELECT event_key FROM usage_inboxes WHERE status = 'processed' LIMIT 1`).Scan(&key); err != nil {
		t.Fatal(err)
	}
	if key != "ok1" && key != "ok2" {
		t.Fatalf("inbox event_key not linked: %q", key)
	}
	if processor.Status().Decoded != 2 {
		t.Fatalf("decoded counter = %d", processor.Status().Decoded)
	}
}

func TestProcessorRetriesPoisonThenDiscardsKeepingRaw(t *testing.T) {
	store := newStore(t)
	ctx := context.Background()
	poison := `{"model":"broken`
	if _, err := store.AppendUsageInbox(ctx, "default", string(ModeSubscribe), []string{poison}, time.Now()); err != nil {
		t.Fatal(err)
	}
	processor, err := NewProcessor(store, nil, 10, time.Millisecond)
	if err != nil {
		t.Fatal(err)
	}

	for pass := 0; pass < 20; pass++ {
		if _, err := processor.ProcessOnce(ctx); err != nil {
			t.Fatal(err)
		}
		var status string
		var attempts int
		var raw string
		if err := store.SQL().QueryRow(`SELECT status, attempt_count, raw_message FROM usage_inboxes`).Scan(&status, &attempts, &raw); err != nil {
			t.Fatal(err)
		}
		if status == repository.InboxDiscarded {
			if raw != poison {
				t.Fatalf("raw payload lost on discard: %q", raw)
			}
			var events int
			if err := store.SQL().QueryRow(`SELECT COUNT(1) FROM usage_events`).Scan(&events); err != nil {
				t.Fatal(err)
			}
			if events != 0 {
				t.Fatalf("poison row produced events: %d", events)
			}
			if processor.Status().Discarded == 0 {
				t.Fatal("discard counter never moved")
			}
			return
		}
		if attempts == 0 {
			t.Fatal("failed decode did not record an attempt")
		}
	}
	t.Fatal("poison payload was never discarded")
}

func TestProcessorMissingRequestIDIsRetryableNotStored(t *testing.T) {
	store := newStore(t)
	ctx := context.Background()
	if _, err := store.AppendUsageInbox(ctx, "default", string(ModeHTTPPull),
		[]string{`{"model":"no-request-id-here"}`}, time.Now()); err != nil {
		t.Fatal(err)
	}
	processor, err := NewProcessor(store, nil, 5, time.Millisecond)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := processor.ProcessOnce(ctx); err != nil {
		t.Fatal(err)
	}
	var events int
	if err := store.SQL().QueryRow(`SELECT COUNT(1) FROM usage_events`).Scan(&events); err != nil {
		t.Fatal(err)
	}
	if events != 0 {
		t.Fatalf("payload without request_id must never become an event, got %d", events)
	}
	var lastError string
	if err := store.SQL().QueryRow(`SELECT last_error FROM usage_inboxes`).Scan(&lastError); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(lastError, "request_id") {
		t.Fatalf("failure reason not recorded: %q", lastError)
	}
}

func TestProcessorErrorChannelNeverEntersUsageInbox(t *testing.T) {
	store := newStore(t)
	upstream := newFakeUpstream()
	config := fastConfig(ModeSubscribe)
	config.CollectErrors = true

	runner, err := NewRunner("default", upstream, store, store, nil, config)
	if err != nil {
		t.Fatal(err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- runner.Run(ctx) }()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if runner.Status().Mode == ModeSubscribe {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	upstream.push(management.ErrorsChannel, `{"status_code":429,"body":"exhausted","auth_index":"auth-1","timestamp":"2026-08-31T10:00:00Z"}`)

	waitForErrorEvent(t, store)
	cancel()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if inboxCount(t, store, "") != 0 {
		t.Fatal("error notification leaked into the usage inbox")
	}
	var code int
	if err := store.SQL().QueryRow(`SELECT status_code FROM error_events LIMIT 1`).Scan(&code); err != nil {
		t.Fatal(err)
	}
	if code != 429 {
		t.Fatalf("error event status_code = %d", code)
	}
}

func waitForErrorEvent(t *testing.T, store *repository.Repository) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		var count int
		if err := store.SQL().QueryRow(`SELECT COUNT(1) FROM error_events`).Scan(&count); err != nil {
			t.Fatal(err)
		}
		if count > 0 {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("error event was never captured")
}

func waitForInbox(t *testing.T, store *repository.Repository, want int) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if inboxCount(t, store, repository.InboxPending) >= want {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("inbox never reached %d rows, got %d", want, inboxCount(t, store, repository.InboxPending))
}

func TestSleepContextHonoursCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if sleepContext(ctx, time.Hour) {
		t.Fatal("cancelled context must not report a completed sleep")
	}
	started := time.Now()
	if !sleepContext(context.Background(), 5*time.Millisecond) {
		t.Fatal("live context should complete the sleep")
	}
	if time.Since(started) > time.Second {
		t.Fatal("sleep overshot")
	}
}
