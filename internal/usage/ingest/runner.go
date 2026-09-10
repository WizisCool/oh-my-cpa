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

	mu                sync.RWMutex
	status            Status
	subscribeFailures int
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
		instanceID: instanceID,
		upstream:   upstream,
		sink:       sink,
		errorSink:  errorSink,
		logger:     logger,
		config:     config.withDefaults(),
	}, nil
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
		}
	}
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
		if delay := idle.nextDelay(len(items), r.config.BatchSize); delay > 0 {
			if !sleepContext(ctx, delay) {
				return nil
			}
		}
	}
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
	if delay <= 0 {
		return ctx.Err() == nil
	}
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}

// pullPacer saves empty-queue work without throttling backlog drainage. A full
// batch is drained immediately; any activity resets the next idle wait. The
// cap must stay comfortably below the upstream's queue retention horizon.
type pullPacer struct {
	base, maximum, current time.Duration
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
