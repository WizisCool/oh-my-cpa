package ingest

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
	"github.com/oh-my-cpa/oh-my-cpa/internal/security"
	"github.com/oh-my-cpa/oh-my-cpa/internal/usage"
)

// Processor turns captured payloads into typed usage events.
//
// It is deliberately separate from the collector: CPA's queue is destructive,
// so capture must be as fast and as reliable as possible, while decoding can
// take its time and retry without ever losing the original payload.
type Processor struct {
	store         *repository.Repository
	logger        *slog.Logger
	fingerprinter security.Fingerprinter

	// batchLimit caps how many inbox rows one pass decodes.
	batchLimit int
	// idleInterval pauses the loop when the inbox is empty.
	idleInterval time.Duration

	// drain is held for the whole of a decode pass. Two decoders on the same
	// pending rows would both insert their decoded events, because
	// ClaimUsageInboxBatch only selects and usage_events has no unique key to
	// collapse the duplicate. It is a channel rather than a mutex so a manual
	// sync waiting for the background loop can give up on its own deadline
	// instead of blocking past it.
	drain chan struct{}

	mu     sync.RWMutex
	status ProcessorStatus
}

// ProcessorStatus reports decode progress.
type ProcessorStatus struct {
	Running     bool       `json:"running"`
	Decoded     int64      `json:"decoded"`
	Discarded   int64      `json:"discarded"`
	LastError   string     `json:"last_error,omitempty"`
	LastErrorAt *time.Time `json:"last_error_at,omitempty"`
}

// NewProcessor wires a decoder against the inbox store.
func NewProcessor(store *repository.Repository, logger *slog.Logger, batchLimit int, idleInterval time.Duration) (*Processor, error) {
	return NewProcessorWithFingerprinter(store, logger, batchLimit, idleInterval, nil)
}

// NewProcessorWithFingerprinter shares the application's keyed identity service
// with usage decoding. The optional argument keeps small integrations and tests
// that do not configure a master key source-compatible; those paths fail closed
// to redacted markers.
func NewProcessorWithFingerprinter(store *repository.Repository, logger *slog.Logger, batchLimit int, idleInterval time.Duration, fingerprinter security.Fingerprinter) (*Processor, error) {
	if store == nil {
		return nil, errors.New("usage inbox store is required")
	}
	if batchLimit <= 0 {
		batchLimit = 200
	}
	if idleInterval <= 0 {
		idleInterval = time.Second
	}
	if logger == nil {
		logger = slog.Default()
	}
	return &Processor{store: store, logger: logger, fingerprinter: fingerprinter, batchLimit: batchLimit, idleInterval: idleInterval, drain: make(chan struct{}, 1)}, nil
}

// Status copies the current decoder state.
func (p *Processor) Status() ProcessorStatus {
	p.mu.RLock()
	defer p.mu.RUnlock()
	return p.status
}

// Run decodes until the context is cancelled.
func (p *Processor) Run(ctx context.Context) error {
	p.mu.Lock()
	p.status.Running = true
	p.mu.Unlock()
	defer func() {
		p.mu.Lock()
		p.status.Running = false
		p.mu.Unlock()
	}()

	for {
		if ctx.Err() != nil {
			return nil
		}
		processed, err := p.ProcessOnce(ctx)
		if err != nil {
			p.recordError(err)
			if !sleepContext(ctx, p.idleInterval*2) {
				return nil
			}
			continue
		}
		if processed == 0 {
			if !sleepContext(ctx, p.idleInterval) {
				return nil
			}
		}
	}
}

// ProcessOnce decodes one inbox batch and returns how many rows it handled.
//
// The count is rows moved out of pending: it includes payloads that failed to
// decode and were parked, so it is progress through the inbox rather than a
// count of committed events.
func (p *Processor) ProcessOnce(ctx context.Context) (int, error) {
	if err := p.acquire(ctx); err != nil {
		return 0, err
	}
	defer p.release()
	return p.processOnce(ctx)
}

// acquire takes the decode gate, giving up as soon as ctx is done.
func (p *Processor) acquire(ctx context.Context) error {
	select {
	case p.drain <- struct{}{}:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (p *Processor) release() { <-p.drain }

// DrainResult reports what one decode barrier achieved.
type DrainResult struct {
	// Pending counts records at or below the watermark still awaiting decoding.
	Pending int64
	// Failed counts records at or below the watermark that were parked as
	// undecodable during this pass. They produce no event, so a barrier that
	// reported success with Failed > 0 would have promised records it cannot show.
	Failed int64
}

// Drain decodes the inbox up to watermark, the highest inbox row a capture pass
// could have produced, and reports what is still unaccounted for.
//
// The wait is scoped by the watermark, not by "the table is empty": records keep
// arriving while a sync runs, so an unscoped wait would only end during a lull.
// Rows above the mark may still be decoded incidentally, but they cannot hold the
// barrier open.
func (p *Processor) Drain(ctx context.Context, watermark int64, maxSeconds int) (DrainResult, error) {
	var result DrainResult
	deadline := time.Now().Add(time.Duration(maxSeconds) * time.Second)
	waitCtx, cancel := context.WithDeadline(ctx, deadline)
	defer cancel()
	// Acquiring the gate is part of the budget: waiting for the background loop
	// is exactly the case where a caller must still return on time.
	if err := p.acquire(waitCtx); err != nil {
		return result, err
	}
	defer p.release()

	discardedBefore, err := p.store.CountUndecodableUsageInboxBefore(ctx, watermark)
	if err != nil {
		return result, err
	}
	for {
		if err := ctx.Err(); err != nil {
			return result, err
		}
		result.Pending, err = p.store.CountPendingUsageInboxBefore(ctx, watermark)
		if err != nil {
			return result, err
		}
		if result.Pending == 0 {
			break
		}
		if !time.Now().Before(deadline) {
			break
		}
		if _, errProcess := p.processOnce(ctx); errProcess != nil {
			return result, errProcess
		}
	}
	discardedAfter, err := p.store.CountUndecodableUsageInboxBefore(ctx, watermark)
	if err != nil {
		return result, err
	}
	result.Failed = discardedAfter - discardedBefore
	return result, nil
}

// processOnce is one decode pass. Callers hold the drain gate.
func (p *Processor) processOnce(ctx context.Context) (int, error) {
	batch, err := p.store.ClaimUsageInboxBatch(ctx, p.batchLimit)
	if err != nil {
		return 0, err
	}
	if len(batch) == 0 {
		return 0, nil
	}

	decoded := make([]repository.UsageDecoded, 0, len(batch))
	failures := make([]int64, 0)
	var lastReason string
	for _, row := range batch {
		observed := time.UnixMilli(row.PoppedAtMS)
		event, errDecode := usage.DecodeEventWithFingerprinter(row.RawMessage, row.InstanceID, observed, p.fingerprinter)
		if errDecode != nil {
			failures = append(failures, row.ID)
			lastReason = errDecode.Error()
			continue
		}
		decoded = append(decoded, repository.UsageDecoded{InboxID: row.ID, Event: event})
	}

	handled := 0
	if len(decoded) > 0 {
		committed, errCommit := p.store.CommitUsageDecoded(ctx, decoded)
		if errCommit != nil {
			// Nothing was written: the rows stay pending and will be retried.
			return handled, fmt.Errorf("commit decoded usage events: %w", errCommit)
		}
		handled += committed
		p.mu.Lock()
		p.status.Decoded += int64(committed)
		p.mu.Unlock()
	}
	if len(failures) > 0 {
		marked, errMark := p.store.MarkUsageUndecodable(ctx, failures, lastReason)
		if errMark != nil {
			return handled, fmt.Errorf("mark undecodable inbox rows: %w", errMark)
		}
		p.mu.Lock()
		p.status.Discarded += int64(marked)
		p.mu.Unlock()
		handled += marked
	}
	return handled, nil
}

func (p *Processor) recordError(err error) {
	if err == nil {
		return
	}
	now := time.Now().UTC()
	p.mu.Lock()
	p.status.LastError = err.Error()
	p.status.LastErrorAt = &now
	p.mu.Unlock()
	p.logger.Warn("usage decode failed", "error", err.Error())
}
