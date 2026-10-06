package ingest

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
)

// Maintenance folds request records into the permanent usage facts and rolls the
// records, and the payloads they were decoded from, out of retention.
//
// Folding runs on a short cadence so reads find almost everything in the facts;
// retention runs hourly because deleting is not on any read path.
type Maintenance struct {
	store  *repository.Repository
	logger *slog.Logger

	// aggregateInterval bounds how many unfolded records a read has to add.
	aggregateInterval time.Duration
	// retentionInterval is how often a retention pass is started.
	retentionInterval time.Duration
	// retentionDays rolls request records older than this. Zero keeps everything.
	retentionDays int
	// inboxRetentionDays rolls decoded payloads older than this. Zero keeps them
	// as long as request records.
	inboxRetentionDays int
	// aggregateBatch caps records folded per transaction.
	aggregateBatch int
	// retentionBatches caps delete transactions per pass, so a retention that was
	// just shortened is worked off between folds rather than in one long hold.
	retentionBatches int
	now              func() time.Time

	mu     sync.RWMutex
	status MaintenanceStatus
}

// MaintenanceStatus reports background maintenance progress.
type MaintenanceStatus struct {
	Running bool `json:"running"`
	// Folded counts request records absorbed into the usage facts.
	Folded      int64      `json:"folded"`
	Purged      int64      `json:"purged"`
	LastError   string     `json:"last_error,omitempty"`
	LastErrorAt *time.Time `json:"last_error_at,omitempty"`
	LastRunAt   *time.Time `json:"last_run_at,omitempty"`
}

// NewMaintenance builds the maintenance loop. retentionDays <= 0 keeps every
// request record.
func NewMaintenance(store *repository.Repository, logger *slog.Logger,
	aggregateInterval time.Duration, retentionDays, inboxRetentionDays int) (*Maintenance, error) {
	if store == nil {
		return nil, errors.New("usage store is required")
	}
	if logger == nil {
		logger = slog.Default()
	}
	if aggregateInterval <= 0 {
		aggregateInterval = 15 * time.Second
	}
	return &Maintenance{
		store:              store,
		logger:             logger,
		aggregateInterval:  aggregateInterval,
		retentionInterval:  time.Hour,
		retentionDays:      retentionDays,
		inboxRetentionDays: inboxRetentionDays,
		aggregateBatch:     20000,
		retentionBatches:   25,
		now:                time.Now,
	}, nil
}

// Status copies the current maintenance state.
func (m *Maintenance) Status() MaintenanceStatus {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.status
}

// Run maintains the usage facts and retention until the context is cancelled.
func (m *Maintenance) Run(ctx context.Context) error {
	m.mu.Lock()
	m.status.Running = true
	m.mu.Unlock()
	defer func() {
		m.mu.Lock()
		m.status.Running = false
		m.mu.Unlock()
	}()

	aggregate := time.NewTicker(m.aggregateInterval)
	defer aggregate.Stop()
	retention := time.NewTicker(m.retentionInterval)
	defer retention.Stop()

	// Fold whatever the previous process left behind before waiting a tick. After
	// an upgrade that is the whole stored history.
	m.aggregateOnce(ctx)

	// isRetentionUnfinished carries a pass that stopped at its batch budget over to
	// the next fold tick, so a backlog drains in minutes instead of one batch
	// budget per hour.
	isRetentionUnfinished := false
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-aggregate.C:
			m.aggregateOnce(ctx)
			if isRetentionUnfinished {
				isRetentionUnfinished = !m.purgeOnce(ctx)
			}
		case <-retention.C:
			isRetentionUnfinished = !m.purgeOnce(ctx)
		}
	}
}

// aggregateOnce folds every pending record, one bounded transaction at a time,
// so a large backlog never holds the database for longer than one batch.
func (m *Maintenance) aggregateOnce(ctx context.Context) {
	for ctx.Err() == nil {
		folded, err := m.store.AggregateUsageFacts(ctx, m.aggregateBatch)
		if err != nil {
			m.recordError(fmt.Errorf("fold usage facts: %w", err))
			return
		}
		now := time.Now().UTC()
		m.mu.Lock()
		m.status.Folded += int64(folded)
		m.status.LastRunAt = &now
		m.mu.Unlock()
		if folded < m.aggregateBatch {
			return
		}
	}
}

// lifecycleCutoffs turns the configured retention into the instant each policy
// deletes to.
func (m *Maintenance) lifecycleCutoffs() map[string]int64 {
	cutoffs := map[string]int64{}
	now := m.now()
	if m.retentionDays > 0 {
		cutoff := now.Add(-time.Duration(m.retentionDays) * 24 * time.Hour).UnixMilli()
		// Whole days only: a usage read can then treat any fact bucket as either
		// entirely backed by request records or not at all.
		cutoffs[repository.LifecycleUsageDetail] = (cutoff / repository.DayBucketMS) * repository.DayBucketMS
	}
	switch {
	case m.inboxRetentionDays > 0:
		cutoffs[repository.LifecycleUsageInbox] = now.Add(-time.Duration(m.inboxRetentionDays) * 24 * time.Hour).UnixMilli()
	case m.retentionDays > 0:
		cutoffs[repository.LifecycleUsageInbox] = cutoffs[repository.LifecycleUsageDetail]
	}
	return cutoffs
}

// purgeOnce runs one retention pass and reports whether it finished. The store
// keeps a request record until the usage facts have absorbed it, so the facts are
// never asked to stand in for something they do not contain.
func (m *Maintenance) purgeOnce(ctx context.Context) bool {
	report, err := m.store.RunLifecycle(ctx, m.lifecycleCutoffs(), m.retentionBatches)
	if err != nil {
		m.recordError(fmt.Errorf("apply retention: %w", err))
		return true
	}
	if deleted := report.Total(); deleted > 0 {
		m.mu.Lock()
		m.status.Purged += deleted
		m.mu.Unlock()
		m.logger.Info("usage retention applied", "deleted_rows", deleted,
			"retention_days", m.retentionDays, "inbox_retention_days", m.inboxRetentionDays,
			"complete", report.IsComplete)
	}
	return report.IsComplete
}

func (m *Maintenance) recordError(err error) {
	if err == nil {
		return
	}
	now := time.Now().UTC()
	m.mu.Lock()
	m.status.LastError = err.Error()
	m.status.LastErrorAt = &now
	m.mu.Unlock()
	m.logger.Warn("usage maintenance failed", "error", err.Error())
}
