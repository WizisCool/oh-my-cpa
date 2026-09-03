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

// Maintenance folds detail rows into the rollups and applies retention.
//
// Aggregation runs on a short cadence so the dashboard's rollup-assisted path
// stops being a lagging approximation; retention runs hourly because deleting
// is not on any read path.
type Maintenance struct {
	store  *repository.Repository
	logger *slog.Logger

	// aggregateInterval bounds how stale rollup-assisted queries can get.
	aggregateInterval time.Duration
	// retentionInterval is how often the purge is attempted.
	retentionInterval time.Duration
	// retentionDays removes detail rows older than this. Zero keeps everything.
	retentionDays int
	// aggregateBatch caps events folded per pass.
	aggregateBatch int

	mu     sync.RWMutex
	status MaintenanceStatus
}

// MaintenanceStatus reports background maintenance progress.
type MaintenanceStatus struct {
	Running          bool       `json:"running"`
	HourlyAggregated int64      `json:"hourly_aggregated"`
	DailyAggregated  int64      `json:"daily_aggregated"`
	Purged           int64      `json:"purged"`
	LastError        string     `json:"last_error,omitempty"`
	LastErrorAt      *time.Time `json:"last_error_at,omitempty"`
	LastRunAt        *time.Time `json:"last_run_at,omitempty"`
}

// NewMaintenance builds the maintenance loop. retentionDays <= 0 disables purge.
func NewMaintenance(store *repository.Repository, logger *slog.Logger,
	aggregateInterval time.Duration, retentionDays int) (*Maintenance, error) {
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
		retentionDays:     retentionDays,
		aggregateBatch:    20000,
	}, nil
}

// Status copies the current maintenance state.
func (m *Maintenance) Status() MaintenanceStatus {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.status
}

// Run maintains rollups and retention until the context is cancelled.
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

	// Fold whatever the previous process left behind before waiting a tick.
	m.aggregateOnce(ctx)

	for {
		select {
		case <-ctx.Done():
			return nil
		case <-aggregate.C:
			m.aggregateOnce(ctx)
		case <-retention.C:
			m.purgeOnce(ctx)
		}
	}
}

// aggregateOnce folds pending events into both grains. Each grain keeps its own
// checkpoint, so a slow daily pass cannot stall hourly freshness.
func (m *Maintenance) aggregateOnce(ctx context.Context) {
	hourly, err := m.store.AggregateUsageGrain(ctx, repository.CheckpointHourly, repository.HourBucketMS, m.aggregateBatch)
	if err != nil {
		m.recordError(fmt.Errorf("aggregate hourly rollup: %w", err))
		return
	}
	daily, err := m.store.AggregateUsageGrain(ctx, repository.CheckpointDaily, repository.DayBucketMS, m.aggregateBatch)
	if err != nil {
		m.recordError(fmt.Errorf("aggregate daily rollup: %w", err))
		return
	}
	now := time.Now().UTC()
	m.mu.Lock()
	m.status.HourlyAggregated += int64(hourly)
	m.status.DailyAggregated += int64(daily)
	m.status.LastRunAt = &now
	m.mu.Unlock()
}

// purgeOnce applies the retention horizon. Aggregation checkpoints gate the
// cutoff inside the store, so rollups are never asked to cover deleted details.
func (m *Maintenance) purgeOnce(ctx context.Context) {
	if m.retentionDays <= 0 {
		return
	}
	cutoff := time.Now().Add(-time.Duration(m.retentionDays) * 24 * time.Hour).UnixMilli()
	deleted, err := m.store.PurgeUsageOlderThan(ctx, cutoff)
	if err != nil {
		m.recordError(fmt.Errorf("purge usage history: %w", err))
		return
	}
	if deleted == 0 {
		return
	}
	m.mu.Lock()
	m.status.Purged += deleted
	m.mu.Unlock()
	m.logger.Info("usage retention applied", "deleted_events", deleted, "retention_days", m.retentionDays)
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
