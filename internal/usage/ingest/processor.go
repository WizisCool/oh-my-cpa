package ingest

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
	"github.com/oh-my-cpa/oh-my-cpa/internal/usage"
)

// Processor turns captured payloads into typed usage events.
//
// It is deliberately separate from the collector: CPA's queue is destructive,
// so capture must be as fast and as reliable as possible, while decoding can
// take its time and retry without ever losing the original payload.
type Processor struct {
	store  *repository.Repository
	logger *slog.Logger

	// batchLimit caps how many inbox rows one pass decodes.
	batchLimit int
	// idleInterval pauses the loop when the inbox is empty.
	idleInterval time.Duration

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
	return &Processor{store: store, logger: logger, batchLimit: batchLimit, idleInterval: idleInterval}, nil
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
func (p *Processor) ProcessOnce(ctx context.Context) (int, error) {
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
		event, errDecode := usage.DecodeEvent(row.RawMessage, row.InstanceID, observed)
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
