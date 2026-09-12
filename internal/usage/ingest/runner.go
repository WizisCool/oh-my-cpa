// Package ingest captures CPA usage records into a durable inbox.
//
// CPA's usage queue is destructive and short-lived, so the only safe pattern is
// to persist every payload the moment it is popped and decode it afterwards.
package ingest

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/management"
	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
	"github.com/oh-my-cpa/oh-my-cpa/internal/security"
	"github.com/oh-my-cpa/oh-my-cpa/internal/usage"
)

// captureDrainRounds bounds one manual pass. A suppressed queue or an outage
// backlog both drain to empty well inside this bound; it only bites when CPA
// produces faster than we can pop, and stopping there is reported as an
// incomplete pass rather than as an empty queue.
const captureDrainRounds = 20

// captureStreamDrain caps how many already-received subscription messages one
// pass moves into the batch. It matches the reader's own buffer, so one pass
// empties what has arrived without letting a firehose stream run forever.
const captureStreamDrain = 256

// Errors a manual sync reports instead of a silent zero-record success. Each one
// describes something the caller cannot fix by refreshing again.
var (
	// ErrCollectorNotRunning means the collector goroutine is not serving
	// requests, so nothing would pop CPA's queue.
	ErrCollectorNotRunning = errors.New("usage collector is not running")
	// ErrCollectorDisabled means this deployment runs no collector at all.
	ErrCollectorDisabled = errors.New("usage collection is disabled")
)

// Mode selects which CPA collection path is used.
type Mode string

const (
	// ModeAuto probes subscription, then RESP pull, then HTTP pull.
	ModeAuto Mode = "auto"
	// ModeSubscribe keeps a live RESP subscription.
	ModeSubscribe Mode = "subscribe"
	// ModeRESPPull batches RESP LPOP.
	ModeRESPPull Mode = "resp_pull"
	// ModeHTTPPull batches the HTTP usage queue.
	ModeHTTPPull Mode = "http_pull"
	// ModeOff disables collection.
	ModeOff Mode = "off"
)

// Valid reports whether the mode is one this runner understands.
func (m Mode) Valid() bool {
	switch m {
	case ModeAuto, ModeSubscribe, ModeRESPPull, ModeHTTPPull, ModeOff:
		return true
	default:
		return false
	}
}

// Stream is a live CPA pub/sub subscription. *management.UsageStream satisfies
// it; tests can supply a fake without owning a socket.
type Stream interface {
	Messages() <-chan string
	Channel() string
	Close() error
}

// Upstream is the CPA surface the collector needs. The management key stays
// inside the management client; this interface never exposes it.
type Upstream interface {
	ProbeUsageChannel(ctx context.Context) error
	OpenUsageStream(ctx context.Context, channel string) (Stream, error)
	PopUsageQueue(ctx context.Context, count int) ([]string, error)
	UsageQueueJSON(ctx context.Context, count int) ([]string, error)
}

// ErrorSink stores decoded CPA error notifications. It is optional: errors are
// push-only on CPA's side, so collection is best-effort.
type ErrorSink interface {
	CaptureErrorEvent(ctx context.Context, instanceID, raw string, observedAt time.Time) error
}

// Sink stores freshly popped payloads. Implementations must persist atomically:
// a payload that is not stored here is gone forever.
type Sink interface {
	AppendUsageInbox(ctx context.Context, instanceID, sourceMode string, payloads []string, poppedAt time.Time) (int, error)
}

// GapRecorder is implemented by persistent sinks that track coverage loss
// when a destructive pop fails to commit locally.
type GapRecorder interface {
	RecordIngestGap(ctx context.Context, gap repository.IngestGap) (int64, error)
}

// Config tunes the collector.
type Config struct {
	// Mode pins the collection path; ModeAuto probes.
	Mode Mode
	// IdleInterval is the polling delay after a non-full batch.
	IdleInterval time.Duration
	// MaxIdleInterval caps exponential backoff after consecutive empty pulls.
	MaxIdleInterval time.Duration
	// BatchSize caps one pop.
	BatchSize int
	// BackoffInitial/Max bound retries after a single path fails.
	BackoffInitial time.Duration
	BackoffMax     time.Duration
	// AllFailedInitial/Max back off harder when CPA answers nothing at all, so
	// a stopped gateway is not hammered by three probes per cycle.
	AllFailedInitial time.Duration
	AllFailedMax     time.Duration
	// BackfillInterval drains queue entries that accumulated during a
	// subscription gap. Zero disables backfill.
	BackfillInterval time.Duration
	// CollectErrors also subscribes to CPA's errors channel.
	CollectErrors bool
	// AuthCooldown pauses collection after CPA rejects the management key.
	// CPA bans a client IP for 30 minutes after five failed attempts, so
	// retrying at the idle interval with a wrong key would lock the operator
	// out of their own gateway.
	AuthCooldown time.Duration
}

func (c Config) withDefaults() Config {
	if c.Mode == "" {
		c.Mode = ModeAuto
	}
	if c.IdleInterval <= 0 {
		c.IdleInterval = time.Second
	}
	if c.MaxIdleInterval <= 0 {
		c.MaxIdleInterval = 10 * time.Second
	}
	c.MaxIdleInterval = max(c.IdleInterval, c.MaxIdleInterval)
	if c.BatchSize <= 0 {
		c.BatchSize = 1000
	}
	if c.BackoffInitial <= 0 {
		c.BackoffInitial = time.Second
	}
	if c.BackoffMax <= 0 {
		c.BackoffMax = 30 * time.Second
	}
	if c.AllFailedInitial <= 0 {
		c.AllFailedInitial = 10 * time.Second
	}
	if c.AllFailedMax <= 0 {
		c.AllFailedMax = time.Minute
	}
	if c.BackfillInterval <= 0 {
		c.BackfillInterval = 30 * time.Second
	}
	if c.AuthCooldown <= 0 {
		c.AuthCooldown = 5 * time.Minute
	}
	return c
}

// Status is a snapshot for the ingest status endpoint.
type Status struct {
	Mode          Mode   `json:"mode"`
	Running       bool   `json:"running"`
	Captured      int64  `json:"captured"`
	ControlFrames int64  `json:"control_frames"`
	CoverageGaps  int64  `json:"coverage_gaps"`
	LastError     string `json:"last_error,omitempty"`
	// AuthRejected marks that the last failure was CPA refusing the key, which
	// the UI should surface as an actionable configuration error.
	AuthRejected  bool       `json:"auth_rejected,omitempty"`
	LastCaptureAt *time.Time `json:"last_capture_at,omitempty"`
	LastErrorAt   *time.Time `json:"last_error_at,omitempty"`
	RefreshSignal *time.Time `json:"refresh_signal_at,omitempty"`
}

// Runner owns the collection loop for one CPA instance.
type Runner struct {
	instanceID string
	upstream   Upstream
	sink       Sink
	errorSink  ErrorSink
	logger     *slog.Logger
	config     Config

	// onRefresh is invoked when CPA signals that its configuration changed.
	onRefresh func()

	// syncRequests carries manual sync requests to the collector goroutine, which
	// is the only consumer allowed to touch CPA's destructive queue. The buffer is
	// one deep: a caller blocks only while an earlier request is still queued, and
	// the pass serving that one also covers what a second would have asked for.
	syncRequests chan *CaptureRequest

	mu                sync.RWMutex
	status            Status
	subscribeFailures int
}

// CaptureRequest is one manual "drain CPA now" request. It is served by the
// collector goroutine rather than by the caller: a second concurrent consumer
// would divert records from a live subscription or race the poll loop for the
// same destructive queue entries.
type CaptureRequest struct {
	// ctx is the caller's work context. It bounds how long the pass may keep
	// asking CPA for more, but never the act of persisting what a pop already
	// returned: those payloads are gone from CPA's queue the moment they arrive.
	ctx context.Context
	// result takes exactly one outcome for the caller. The collector also reads
	// the pass error from it, so a manual failure follows the same backoff and
	// authentication-cooldown policy as a background cycle.
	result chan CaptureOutcome
}

// CaptureOutcome reports what one requested pass achieved.
type CaptureOutcome struct {
	// Mode is the transport that served the pass.
	Mode Mode
	// Captured counts the records this pass persisted to the inbox.
	Captured int
	// Drained is false when the pass stopped at its bound with records still
	// arriving, so the caller must not present the result as a complete sync.
	Drained bool
	// Err is the transport failure that ended the pass. A pass can only end
	// early with an error; "nothing new arrived" is Drained with an empty Err.
	Err error
}

func (r *CaptureRequest) complete(outcome CaptureOutcome) {
	select {
	case r.result <- outcome:
	default:
	}
}

// outcome reads the answer without consuming the chance to answer again: the
// collector both reports it to the caller and uses it for its own retry policy.
func (r *CaptureRequest) outcome() CaptureOutcome {
	select {
	case outcome := <-r.result:
		r.result <- outcome
		return outcome
	default:
		return CaptureOutcome{}
	}
}

// hasOutcome reports whether the pass already answered this request.
func (r *CaptureRequest) hasOutcome() bool {
	select {
	case <-r.result:
		return true
	default:
		return false
	}
}

// maxSubscribeFailures bounds repeated subscription attempts before auto mode
// degrades to batch pulling.
const maxSubscribeFailures = 3

// NewRunner builds a collector. upstream and sink are required; errorSink may be
// nil when CPA error collection is not wanted.
func NewRunner(instanceID string, upstream Upstream, sink Sink, errorSink ErrorSink, logger *slog.Logger, config Config) (*Runner, error) {
	if upstream == nil {
		return nil, errors.New("usage upstream is required")
	}
	if sink == nil {
		return nil, errors.New("usage inbox sink is required")
	}
	if !config.Mode.Valid() {
		return nil, fmt.Errorf("invalid usage ingest mode %q", config.Mode)
	}
	if logger == nil {
		logger = slog.Default()
	}
	return &Runner{
		instanceID:   instanceID,
		upstream:     upstream,
		sink:         sink,
		errorSink:    errorSink,
		logger:       logger,
		config:       config.withDefaults(),
		syncRequests: make(chan *CaptureRequest, 1),
	}, nil
}

// captureReadinessGrace is how long a request waits for a collector that has not
// started yet. The HTTP server and the pipeline start in parallel, so a refresh
// arriving in that window is legitimate; a collector still absent after this long
// is a stopped one, and the caller deserves an answer rather than a timeout.
const captureReadinessGrace = 2 * time.Second

// CaptureNow asks the collector to drain CPA immediately and waits for the pass
// to finish.
//
// A zero-record outcome is a real answer (CPA had nothing queued); every reason
// the request could not be served is an error instead, so a caller can never
// present "the collector is parked" as "nothing new happened".
func (r *Runner) CaptureNow(ctx context.Context) (CaptureOutcome, error) {
	var outcome CaptureOutcome
	if ctx.Err() != nil {
		return outcome, ctx.Err()
	}
	if r.config.Mode == ModeOff {
		return outcome, ErrCollectorDisabled
	}

	request := &CaptureRequest{ctx: ctx, result: make(chan CaptureOutcome, 1)}
	select {
	case r.syncRequests <- request:
	case <-ctx.Done():
		return outcome, ctx.Err()
	}

	// A missing collector is reported rather than waited out, but only after the
	// start-up window has passed: the request stays queued meanwhile, so a
	// pipeline that is still coming up serves it on its first pass.
	readiness := time.NewTimer(captureReadinessGrace)
	defer readiness.Stop()
	for {
		select {
		case outcome = <-request.result:
			return outcome, outcome.Err
		case <-ctx.Done():
			// The collector still finishes the pass and persists what it popped -
			// payloads already taken from CPA cannot be recovered, so they are written
			// under the collector's own context. Only this caller stops waiting.
			return CaptureOutcome{Mode: r.Status().Mode, Drained: false, Err: ctx.Err()}, ctx.Err()
		case <-readiness.C:
			if !r.Status().Running {
				return CaptureOutcome{}, ErrCollectorNotRunning
			}
			readiness.Reset(captureReadinessGrace)
		}
	}
}

// takeCaptureRequest returns a queued request without waiting, or nil.
func (r *Runner) takeCaptureRequest() *CaptureRequest {
	select {
	case request := <-r.syncRequests:
		return r.normalizeCapture(request)
	default:
		return nil
	}
}

// normalizeCapture drops a request whose caller has already given up, so no pass
// starts for an answer nobody is waiting for.
func (r *Runner) normalizeCapture(request *CaptureRequest) *CaptureRequest {
	if request == nil {
		return nil
	}
	if request.ctx.Err() != nil {
		request.complete(CaptureOutcome{Err: request.ctx.Err()})
		return nil
	}
	return request
}

// completeCapture answers a manual request, if there is one.
//
// No successful-sync timestamp is recorded here. Capture is only half of what a
// manual refresh promises: the captured rows still have to decode into events,
// and the pipeline's decode barrier is the only place that knows whether they
// did.
func (r *Runner) completeCapture(request *CaptureRequest, outcome CaptureOutcome) {
	if request == nil {
		return
	}
	request.complete(outcome)
}

func (r *Runner) capturedCount() int64 {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.status.Captured
}

// capturedSince reports how many records were persisted since a snapshot.
func (r *Runner) capturedSince(before int64) int {
	delta := r.capturedCount() - before
	if delta <= 0 {
		return 0
	}
	return int(delta)
}

// SetRefreshHandler installs the CPA configuration-change callback.
func (r *Runner) SetRefreshHandler(handler func()) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.onRefresh = handler
}

// Status copies the current collector state.
func (r *Runner) Status() Status {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.status
}

// Run collects until the context is cancelled. Returning nil means the caller
// asked to stop.
func (r *Runner) Run(ctx context.Context) error {
	if r.config.Mode == ModeOff {
		r.setMode(ModeOff, "")
		r.logger.Info("usage ingest disabled", "instance", r.instanceID)
		<-ctx.Done()
		return nil
	}
	r.setRunning(true)
	defer r.setRunning(false)

	backoff := r.config.BackoffInitial
	allFailed := r.config.AllFailedInitial
	for {
		if ctx.Err() != nil {
			return nil
		}
		mode, err := r.collect(ctx)
		switch {
		case ctx.Err() != nil:
			return nil
		case mode == "":
			// Nothing answered the probe: CPA is likely down.
			r.recordError(err)
			if !sleepContext(ctx, allFailed) {
				return nil
			}
			allFailed = min(allFailed*2, r.config.AllFailedMax)
			continue
		default:
			allFailed = r.config.AllFailedInitial
			if err != nil {
				delay := backoff
				if isAuthRejection(err) {
					// Back off hard: further attempts only deepen CPA's ban.
					delay = r.config.AuthCooldown
					r.setMode(r.config.Mode, "CPA rejected the management key; pausing collection to avoid an IP ban")
					r.logger.Error("usage ingest authentication rejected, cooling down",
						"instance", r.instanceID, "cooldown", delay.String(), "error", err.Error())
				} else {
					r.logger.Warn("usage ingest failed", "instance", r.instanceID, "error", err.Error())
				}
				r.recordErrorAt(err, delay != backoff)
				if !sleepContext(ctx, delay) {
					return nil
				}
				backoff = min(backoff*2, r.config.BackoffMax)
				continue
			}
			backoff = r.config.BackoffInitial
		}
	}
}

// collect picks a working path and runs it until it fails or is cancelled.
func (r *Runner) collect(ctx context.Context) (string, error) {
	switch r.config.Mode {
	case ModeSubscribe:
		return string(ModeSubscribe), r.runSubscribe(ctx)
	case ModeRESPPull:
		return string(ModeRESPPull), r.runPull(ctx, ModeRESPPull)
	case ModeHTTPPull:
		return string(ModeHTTPPull), r.runPull(ctx, ModeHTTPPull)
	}

	// Auto. Availability is probed with AUTH, never by popping: CPA's queue is
	// destructive, so a probe that consumed a record would silently lose it.
	// Subscription is preferred because it is the only path guaranteed to see
	// every record; it is skipped only after repeated failure.
	if err := r.upstream.ProbeUsageChannel(ctx); err != nil {
		r.logger.Debug("CPA RESP channel unavailable, using the HTTP usage queue",
			"instance", r.instanceID, "error", err.Error())
		return string(ModeHTTPPull), r.runPull(ctx, ModeHTTPPull)
	}
	if r.subscribeDisabled() {
		return string(ModeRESPPull), r.runPull(ctx, ModeRESPPull)
	}
	err := r.runSubscribe(ctx)
	r.noteSubscribeAttempt(err)
	return string(ModeSubscribe), err
}

// subscribeDisabled reports repeated subscription failures since the last
// success, so an instance that rejects SUBSCRIBE degrades to batch pulling
// instead of looping on a path that can never capture anything.
func (r *Runner) subscribeDisabled() bool {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.subscribeFailures >= maxSubscribeFailures
}

func (r *Runner) noteSubscribeAttempt(err error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if err == nil {
		r.subscribeFailures = 0
		return
	}
	r.subscribeFailures++
	if r.subscribeFailures == maxSubscribeFailures {
		r.logger.Warn("usage subscription keeps failing, degrading to RESP pull",
			"instance", r.instanceID, "failures", r.subscribeFailures)
	}
}

// runSubscribe keeps a live subscription and periodically drains anything that
// queued up while the connection was down.
func (r *Runner) runSubscribe(ctx context.Context) error {
	stream, err := r.upstream.OpenUsageStream(ctx, management.UsageChannel)
	if err != nil {
		return fmt.Errorf("open usage subscription: %w", err)
	}
	defer stream.Close()

	var errorStream Stream
	if r.config.CollectErrors && r.errorSink != nil {
		// Errors are push-only on CPA's side: nothing is retained while we are
		// disconnected, so this stream is best-effort observability.
		if opened, openErr := r.upstream.OpenUsageStream(ctx, management.ErrorsChannel); openErr == nil {
			errorStream = opened
			defer errorStream.Close()
		} else {
			r.logger.Debug("usage error channel unavailable", "instance", r.instanceID, "error", openErr.Error())
		}
	}

	r.setMode(ModeSubscribe, "")
	r.logger.Info("usage ingest subscribed", "instance", r.instanceID)

	backfill := time.NewTicker(r.config.BackfillInterval)
	defer backfill.Stop()
	flush := time.NewTicker(r.config.IdleInterval)
	defer flush.Stop()

	batch := make([]string, 0, r.config.BatchSize)
	captureErrors := func() error {
		if errorStream == nil {
			return nil
		}
		for {
			select {
			case payload, ok := <-errorStream.Messages():
				if !ok {
					return nil
				}
				if err := r.errorSink.CaptureErrorEvent(ctx, r.instanceID, payload, time.Now()); err != nil {
					// A malformed notification must not kill the usage stream.
					r.recordError(fmt.Errorf("capture error event: %w", err))
					continue
				}
			default:
				return nil
			}
		}
	}

	for {
		select {
		case <-ctx.Done():
			shutdownCtx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			_ = r.flush(shutdownCtx, ModeSubscribe, &batch)
			_ = captureErrors()
			cancel()
			return nil
		case payload, ok := <-stream.Messages():
			if !ok {
				return errors.New("usage subscription closed by CPA")
			}
			if err := r.capture(ctx, ModeSubscribe, payload, &batch); err != nil {
				return err
			}
		case <-flush.C:
			if err := r.flush(ctx, ModeSubscribe, &batch); err != nil {
				return err
			}
			if err := captureErrors(); err != nil {
				return err
			}
		case <-backfill.C:
			// A subscriber suppresses enqueue, so anything in the queue arrived
			// during a reconnect gap and must not be lost.
			items, err := r.pop(ctx, ModeRESPPull, r.config.BatchSize)
			if err != nil {
				r.recordError(fmt.Errorf("usage backfill pull: %w", err))
				continue
			}
			for _, payload := range items {
				if err := r.capture(ctx, ModeRESPPull, payload, &batch); err != nil {
					return err
				}
			}
			if err := r.flush(ctx, ModeSubscribe, &batch); err != nil {
				return err
			}
		case request := <-r.syncRequests:
			if request = r.normalizeCapture(request); request != nil {
				outcome := r.syncSubscribe(ctx, request.ctx, stream.Messages(), &batch, captureErrors)
				r.completeCapture(request, outcome)
				// A manual pass that failed is a collector failure like any other, so
				// the retry and authentication-cooldown policy stays in Run's hands
				// rather than being bypassed by the operator path.
				if outcome.Err != nil {
					return outcome.Err
				}
			}
		}
	}
}

// syncSubscribe serves one manual pass. A live subscription suppresses CPA's
// enqueue, so a pop alone would find an empty queue while freshly pushed records
// sat in the subscription buffer: the pass moves what has already arrived into
// the batch, flushes it, and only then drains the queue's reconnect-gap residue
// through the same bounded multi-batch drain the poll path uses - a single batch
// would report a clean sync while older records were still queued.
//
// work bounds how long CPA is asked for more; collect bounds the writes. Already
// popped payloads are persisted under the collector's context because CPA's queue
// is destructive and a caller that stopped waiting must not abort the write.
//
// The subscription buffer is deliberately not drained to empty beyond the same
// bound: a steady push stream must not turn one refresh into an unbounded loop.
func (r *Runner) syncSubscribe(collect, work context.Context, messages <-chan string, batch *[]string, captureErrors func() error) CaptureOutcome {
	outcome := CaptureOutcome{Mode: ModeSubscribe, Drained: true}
	before := r.capturedCount()

	bufferDrained := false
	for buffered := 0; buffered < captureStreamDrain; buffered++ {
		select {
		case payload, ok := <-messages:
			if !ok {
				outcome.Drained = false
				outcome.Err = errors.New("usage subscription closed by CPA")
				return r.finishCapture(outcome, before)
			}
			if err := r.capture(collect, ModeSubscribe, payload, batch); err != nil {
				outcome.Drained = false
				outcome.Err = err
				return r.finishCapture(outcome, before)
			}
		default:
			bufferDrained = true
			buffered = captureStreamDrain
		}
	}
	// Hitting the cap without ever seeing the buffer empty means records are
	// still arriving, so this pass cannot claim it drained them.
	if !bufferDrained {
		outcome.Drained = false
	}

	if err := r.flush(collect, ModeSubscribe, batch); err != nil {
		outcome.Drained = false
		outcome.Err = err
		return r.finishCapture(outcome, before)
	}
	if err := captureErrors(); err != nil {
		outcome.Drained = false
		outcome.Err = err
		return r.finishCapture(outcome, before)
	}

	queued := r.syncPull(collect, work, ModeRESPPull, batch)
	outcome.Drained = outcome.Drained && queued.Drained
	outcome.Err = queued.Err
	return r.finishCapture(outcome, before)
}

// finishCapture fills in the persisted-record delta for a pass.
func (r *Runner) finishCapture(outcome CaptureOutcome, before int64) CaptureOutcome {
	outcome.Captured = r.capturedSince(before)
	return outcome
}

// runPull batches pops until the path fails.
func (r *Runner) runPull(ctx context.Context, mode Mode) error {
	r.setMode(mode, "")
	r.logger.Info("usage ingest polling", "instance", r.instanceID, "mode", string(mode))

	batch := make([]string, 0, r.config.BatchSize)
	idle := pullPacer{base: r.config.IdleInterval, maximum: r.config.MaxIdleInterval}
	for {
		if ctx.Err() != nil {
			return nil
		}
		if request := r.takeCaptureRequest(); request != nil {
			outcome := r.syncPull(ctx, request.ctx, mode, &batch)
			r.completeCapture(request, outcome)
			if outcome.Err != nil {
				return outcome.Err
			}
			idle.reset()
			continue
		}
		// The pop comes before the wait, as it always has: a collector that spent
		// its first idle interval waiting would never read CPA at all when the
		// configured interval is long.
		items, err := r.pop(ctx, mode, r.config.BatchSize)
		if err != nil {
			return err
		}
		for _, payload := range items {
			if errCapture := r.capture(ctx, mode, payload, &batch); errCapture != nil {
				return errCapture
			}
		}
		if errFlush := r.flush(ctx, mode, &batch); errFlush != nil {
			return errFlush
		}
		delay := idle.nextDelay(len(items), r.config.BatchSize)
		if delay <= 0 {
			continue
		}
		// The wait is interruptible, so a manual request never has to outlast the
		// pacer's delay to be served.
		timer := time.NewTimer(delay)
		select {
		case <-ctx.Done():
			timer.Stop()
			return nil
		case request := <-r.syncRequests:
			timer.Stop()
			if request = r.normalizeCapture(request); request != nil {
				outcome := r.syncPull(ctx, request.ctx, mode, &batch)
				r.completeCapture(request, outcome)
				// A manual pass that failed is a collector failure like any other, so
				// Run keeps owning the backoff and the authentication cooldown instead
				// of the operator path bypassing them and hammering a rejecting CPA.
				if outcome.Err != nil {
					return outcome.Err
				}
			}
			idle.reset()
		case <-timer.C:
		}
	}
}

// syncPull serves one manual pass by draining full batches back to back with no
// pacer delay. A backlog is therefore actually cleared instead of being answered
// with a single batch while older records wait for the next idle tick.
//
// work bounds the asking: once the caller's request is gone there is no point
// popping more. Persistence uses the collector's context instead, because a
// payload that has already left CPA's destructive queue must be written down
// even if the operator closed the tab.
func (r *Runner) syncPull(collect, work context.Context, mode Mode, batch *[]string) CaptureOutcome {
	outcome := CaptureOutcome{Mode: mode, Drained: true, Err: work.Err()}
	before := r.capturedCount()
	for round := 0; round < captureDrainRounds; round++ {
		if err := work.Err(); err != nil {
			outcome.Drained = false
			outcome.Err = err
			return r.finishCapture(outcome, before)
		}
		items, err := r.pop(work, mode, r.config.BatchSize)
		if err != nil {
			outcome.Drained = false
			outcome.Err = err
			return r.finishCapture(outcome, before)
		}
		for _, payload := range items {
			if errCapture := r.capture(collect, mode, payload, batch); errCapture != nil {
				outcome.Drained = false
				outcome.Err = errCapture
				return r.finishCapture(outcome, before)
			}
		}
		if errFlush := r.flush(collect, mode, batch); errFlush != nil {
			outcome.Drained = false
			outcome.Err = errFlush
			return r.finishCapture(outcome, before)
		}
		if len(items) < r.config.BatchSize {
			break
		}
		if round == captureDrainRounds-1 {
			// Still full at the last round: CPA is producing at least as fast as we
			// pop, so the queue was not observed empty.
			outcome.Drained = false
		}
	}
	return r.finishCapture(outcome, before)
}

// capture buffers one payload, filtering CPA control frames so they never
// occupy inbox space or produce phantom events.
func (r *Runner) capture(ctx context.Context, mode Mode, payload string, batch *[]string) error {
	control := usage.Classify(payload)
	if control.IsControl {
		r.mu.Lock()
		r.status.ControlFrames++
		if control.Refresh {
			now := time.Now().UTC()
			r.status.RefreshSignal = &now
		}
		handler := r.onRefresh
		r.mu.Unlock()
		if control.Refresh && handler != nil {
			handler()
		}
		return nil
	}
	*batch = append(*batch, payload)
	if len(*batch) >= r.config.BatchSize {
		return r.flush(ctx, mode, batch)
	}
	return nil
}

func (r *Runner) flush(ctx context.Context, mode Mode, batch *[]string) error {
	if len(*batch) == 0 {
		return nil
	}
	payloads := *batch
	poppedAt := time.Now()
	written, err := r.sink.AppendUsageInbox(ctx, r.instanceID, string(mode), payloads, poppedAt)
	*batch = payloads[:0]
	if err != nil {
		if recorder, ok := r.sink.(GapRecorder); ok {
			_, _ = recorder.RecordIngestGap(context.Background(), repository.IngestGap{
				InstanceID:     r.instanceID,
				SourceMode:     string(mode),
				StartedAtMS:    poppedAt.UnixMilli(),
				EndedAtMS:      time.Now().UnixMilli(),
				EstimatedCount: len(payloads),
				ReasonCode:     "append_failure",
				Summary:        security.RedactText(err.Error()),
			})
		}
		r.mu.Lock()
		r.status.CoverageGaps++
		r.mu.Unlock()
		return fmt.Errorf("append usage inbox: %w", err)
	}
	if written > 0 {
		now := time.Now().UTC()
		r.mu.Lock()
		r.status.Captured += int64(written)
		r.status.LastCaptureAt = &now
		r.mu.Unlock()
	}
	return nil
}

func (r *Runner) pop(ctx context.Context, mode Mode, count int) ([]string, error) {
	switch mode {
	case ModeRESPPull:
		return r.upstream.PopUsageQueue(ctx, count)
	default:
		return r.upstream.UsageQueueJSON(ctx, count)
	}
}

func (r *Runner) setMode(mode Mode, message string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.status.Mode = mode
	if message != "" {
		r.status.LastError = message
	}
}

func (r *Runner) setRunning(running bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.status.Running = running
}

func (r *Runner) recordError(err error) {
	r.recordErrorAt(err, false)
}

func (r *Runner) recordErrorAt(err error, severe bool) {
	if err == nil {
		return
	}
	now := time.Now().UTC()
	r.mu.Lock()
	r.status.LastError = err.Error()
	r.status.LastErrorAt = &now
	if severe {
		r.status.AuthRejected = true
	}
	r.mu.Unlock()
}

// isAuthRejection reports a CPA response that means "wrong or banned key".
func isAuthRejection(err error) bool {
	var httpErr *management.HTTPError
	if errors.As(err, &httpErr) {
		return httpErr.StatusCode == http.StatusUnauthorized || httpErr.StatusCode == http.StatusForbidden
	}
	message := strings.ToLower(err.Error())
	return strings.Contains(message, "invalid management key") ||
		strings.Contains(message, "ip banned") ||
		strings.Contains(message, "http 403") ||
		strings.Contains(message, "http 401")
}

func sleepContext(ctx context.Context, delay time.Duration) bool {
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}

// parseMode reads the transport name the collect pass returned back as a Mode.
// An empty name means nothing answered the probe, and the configured mode is
// then the honest label because nothing else was used.
func parseMode(name string, fallback Mode) Mode {
	if name == "" {
		return fallback
	}
	return Mode(name)
}

// pullPacer saves empty-queue work without throttling backlog drainage. A full
// batch is drained immediately; any activity resets the next idle wait. The
// cap must stay comfortably below the upstream's queue retention horizon.
type pullPacer struct {
	base, maximum, current time.Duration
}

// reset starts the backoff over: after a recorded failure or a manual pass the
// next empty pull should wait the base interval, not the grown one.
func (p *pullPacer) reset() {
	p.current = p.base
}

func (p *pullPacer) nextDelay(count, batchSize int) time.Duration {
	if count > 0 || p.current == 0 {
		p.current = p.base
	}
	if count >= batchSize {
		return 0
	}
	delay := p.current
	if count == 0 {
		// Saturating addition avoids overflowing time.Duration.
		p.current += min(p.current, p.maximum-p.current)
	}
	return delay
}
