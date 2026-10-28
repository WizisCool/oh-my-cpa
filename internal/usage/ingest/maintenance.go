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
// retention runs hourly because deleting is not on any read path. Neither depends
// on capture: a deployment that collects usage elsewhere and turned capture off
// still holds the records it captured before, and they still have to roll.
type Maintenance struct {
	store  *repository.Repository
	logger *slog.Logger

	// aggregateInterval bounds how many unfolded records a read has to add.
	aggregateInterval time.Duration
	// retentionInterval is how often a retention pass is started.
	retentionInterval time.Duration
	// followUpDelay separates the pass that publishes a moved horizon from the one
	// that deletes below it, after a retention change. It is the time a read
	// planned against the old horizon has to finish; see RunLifecycle.
	followUpDelay time.Duration
	// defaults is the environment's retention, in force until the console saves one.
	defaults repository.UsageRetention
	// aggregateBatch caps records folded per transaction.
	aggregateBatch int
	// retentionBatches caps delete transactions per pass, so a retention that was
	// just shortened is worked off between folds rather than in one long hold.
	retentionBatches int
	now              func() time.Time
	// wake asks the loop for a retention pass now: the console changed retention.
	wake chan struct{}

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
	// LastRetentionAt and NextRetentionAt bracket the retention schedule, so the
	// console can say when expired rows go rather than only that they will.
	LastRetentionAt *time.Time `json:"last_retention_at,omitempty"`
	NextRetentionAt *time.Time `json:"next_retention_at,omitempty"`
	// ReleasedPages counts database pages handed back to the filesystem.
	ReleasedPages int64 `json:"released_pages"`
}

// NewMaintenance builds the maintenance loop. defaults is the retention in force
// until the console stores one.
func NewMaintenance(store *repository.Repository, logger *slog.Logger,
	aggregateInterval time.Duration, defaults repository.UsageRetention) (*Maintenance, error) {
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
		store:             store,
		logger:            logger,
		aggregateInterval: aggregateInterval,
		retentionInterval: time.Hour,
		followUpDelay:     time.Minute,
		defaults:          defaults,
		aggregateBatch:    20000,
		retentionBatches:  25,
		now:               time.Now,
		wake:              make(chan struct{}, 1),
	}, nil
}

// Defaults is the environment's retention.
func (m *Maintenance) Defaults() repository.UsageRetention { return m.defaults }

// ApplyRetentionNow asks the running loop for a retention pass, so a changed
// setting is acted on in seconds instead of at the next hourly pass.
func (m *Maintenance) ApplyRetentionNow() {
	if m == nil {
		return
	}
	select {
	case m.wake <- struct{}{}:
	default:
	}
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
	retention := time.NewTimer(0)
	defer retention.Stop()

	// Fold whatever the previous process left behind before waiting a tick. After
	// an upgrade that is the whole stored history. The first retention pass follows
	// at once rather than an hour into the process's life.
	m.aggregateOnce(ctx)

	// isRetentionUnfinished carries a pass that stopped at its batch budget over to
	// the next fold tick, so a backlog drains in minutes instead of one batch
	// budget per hour.
	isRetentionUnfinished := false
	// followUpAt is when the deleting half of a retention change is due, and
	// scheduledAt when the next hourly pass is.
	var followUpAt, scheduledAt time.Time
	var followUpTimer *time.Timer
	var followUp <-chan time.Time
	defer func() {
		if followUpTimer != nil {
			followUpTimer.Stop()
		}
	}()
	isChangePending := false
	startFollowUp := func() {
		if followUpTimer == nil {
			followUpTimer = time.NewTimer(m.followUpDelay)
		} else {
			if !followUpTimer.Stop() {
				select {
				case <-followUpTimer.C:
				default:
				}
			}
			followUpTimer.Reset(m.followUpDelay)
		}
		followUp = followUpTimer.C
		followUpAt = m.now().Add(m.followUpDelay)
	}
	publishNext := func() {
		next := scheduledAt
		if !followUpAt.IsZero() && (next.IsZero() || followUpAt.Before(next)) {
			next = followUpAt
		}
		m.mu.Lock()
		defer m.mu.Unlock()
		if next.IsZero() {
			m.status.NextRetentionAt = nil
			return
		}
		next = next.UTC()
		m.status.NextRetentionAt = &next
	}
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-aggregate.C:
			m.aggregateOnce(ctx)
			if isRetentionUnfinished && followUp == nil {
				isRetentionUnfinished = !m.purgeOnce(ctx)
			}
		case <-m.wake:
			if followUp != nil {
				isChangePending = true
			} else {
				isRetentionUnfinished = !m.purgeOnce(ctx)
				startFollowUp()
			}
			publishNext()
		case <-followUp:
			followUp = nil
			followUpAt = time.Time{}
			isRetentionUnfinished = !m.purgeOnce(ctx)
			if isChangePending {
				isChangePending = false
				startFollowUp()
			}
			publishNext()
		case <-retention.C:
			if followUp == nil {
				isRetentionUnfinished = !m.purgeOnce(ctx)
			}
			retention.Reset(m.retentionInterval)
			scheduledAt = m.now().Add(m.retentionInterval)
			publishNext()
		}
	}
}

// aggregateOnce folds every pending record, one bounded transaction at a time,
// so a large backlog never holds the database for longer than one batch.
//
// The local-day grain is rebuilt first when the operator changed the time zone,
// so the fold that follows already writes it for the new zone.
func (m *Maintenance) aggregateOnce(ctx context.Context) {
	if _, err := m.store.EnsureLocalUsageFacts(ctx); err != nil {
		// A derived rebuild failure leaves quarter-hour reads available; the primary
		// checkpoint must still advance so retention and ingestion can keep up.
		m.recordError(fmt.Errorf("rebuild local usage facts: %w", err))
	}
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

// lifecycleCutoffs turns a retention into the instant each policy deletes to.
func lifecycleCutoffs(retention repository.UsageRetention, now time.Time) map[string]int64 {
	cutoffs := map[string]int64{}
	if retention.RequestRecordDays > 0 {
		cutoff := now.Add(-time.Duration(retention.RequestRecordDays) * 24 * time.Hour).UnixMilli()
		// Whole days only: a usage read can then treat any fact bucket as either
		// entirely backed by request records or not at all.
		cutoffs[repository.LifecycleUsageDetail] = (cutoff / repository.DayBucketMS) * repository.DayBucketMS
	}
	switch {
	case retention.PayloadDays > 0:
		cutoffs[repository.LifecycleUsageInbox] = now.Add(-time.Duration(retention.PayloadDays) * 24 * time.Hour).UnixMilli()
	case retention.RequestRecordDays > 0:
		cutoffs[repository.LifecycleUsageInbox] = cutoffs[repository.LifecycleUsageDetail]
	}
	return cutoffs
}

// purgeOnce runs one retention pass and reports whether it finished. The store
// keeps a request record until the usage facts have absorbed it, so the facts are
// never asked to stand in for something they do not contain.
//
// The retention is read on every pass rather than at start-up, which is what lets
// the console change it without a restart.
func (m *Maintenance) purgeOnce(ctx context.Context) bool {
	setting, err := m.store.ResolveUsageRetention(ctx, m.defaults)
	if err != nil {
		m.recordError(fmt.Errorf("read retention: %w", err))
		return true
	}
	report, err := m.store.RunLifecycle(ctx, lifecycleCutoffs(setting.UsageRetention, m.now()), m.retentionBatches)
	if err != nil {
		m.recordError(fmt.Errorf("apply retention: %w", err))
		return true
	}
	// Deleting makes room inside the file; releasing hands that room back to the
	// filesystem, which is what a small disk actually needs.
	release, err := m.store.ReleaseFreePages(ctx, m.retentionBatches)
	if err != nil {
		m.recordError(fmt.Errorf("release free pages: %w", err))
	}
	finishedAt := m.now().UTC()
	m.mu.Lock()
	m.status.Purged += report.Total()
	m.status.ReleasedPages += release.ReleasedPages
	m.status.LastRetentionAt = &finishedAt
	m.mu.Unlock()
	if deleted := report.Total(); deleted > 0 || release.ReleasedPages > 0 {
		m.logger.Info("usage retention applied", "deleted_rows", deleted,
			"released_pages", release.ReleasedPages,
			"request_record_days", setting.RequestRecordDays, "payload_days", setting.PayloadDays,
			"retention_source", setting.Source, "complete", report.IsComplete && release.IsComplete)
	}
	return report.IsComplete && release.IsComplete
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
