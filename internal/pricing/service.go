package pricing

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log/slog"
	"sort"
	"strings"
	"sync"
	"time"
)

// ModelLister returns all models currently configured in the deployment (e.g. CPA instance).
type ModelLister interface {
	ListConfiguredModels(context.Context) ([]string, error)
}

// SyncState is the durable outcome of the last models.dev sync.
type SyncState struct {
	Source                string `json:"source"`
	LastError             string `json:"last_error"`
	LastMatched           int64  `json:"last_matched"`
	LastUnmatched         int64  `json:"last_unmatched"`
	LastSuccessAtMS       *int64 `json:"last_success_at_ms"`
	UpdatedAtMS           int64  `json:"updated_at_ms"`
	AutoSyncIntervalHours int64  `json:"auto_sync_interval_hours"`
	NextSyncAtMS          *int64 `json:"next_sync_at_ms,omitempty"`
}

// Store is the persistence boundary; repository implements it.
type Store interface {
	ListModelPrices(context.Context) ([]ModelPrice, error)
	UpsertModelPrices(context.Context, []ModelPrice) error
	DeleteModelPrice(context.Context, string) (bool, error)
	ListEffectiveModels(context.Context) ([]string, error)
	GetPricingSyncState(context.Context, string) (SyncState, error)
	SavePricingSyncState(context.Context, SyncState) error
	UpdatePricingSyncSchedule(context.Context, string, int64) error
}

// Fetcher decodes the fixed models.dev catalog.
type Fetcher interface {
	Fetch(context.Context) (Catalog, error)
}

// SyncResult summarizes one sync run for logs, API and audit. Pruned counts
// auto rows dropped because their model left the traffic scope; manual rows
// are never pruned.
type SyncResult struct {
	Matched   int64
	Unmatched int64
	Updated   int64
	Pruned    int64
}

// Service keeps the price table fresh with zero operator setup: sync runs at
// startup and daily, unique strong matches apply automatically, manual rows
// always win, and a failed fetch keeps the last good prices.
type Service struct {
	store                 Store
	fetcher               Fetcher
	modelLister           ModelLister
	logger                *slog.Logger
	interval              time.Duration
	autoSyncIntervalHours int64
	clock                 func() time.Time

	mu      sync.Mutex
	running bool
	wakeCh  chan struct{}
}

func NewService(store Store, fetcher Fetcher, logger *slog.Logger) *Service {
	if logger == nil {
		logger = slog.Default()
	}
	if fetcher == nil {
		fetcher = NewMetadataClient()
	}
	return &Service{
		store:                 store,
		fetcher:               fetcher,
		logger:                logger,
		interval:              24 * time.Hour,
		autoSyncIntervalHours: 24,
		clock:                 time.Now,
		wakeCh:                make(chan struct{}, 1),
	}
}

// SetModelLister connects a source of deployment-configured models (e.g. CPA instance).
func (s *Service) SetModelLister(lister ModelLister) {
	if s == nil {
		return
	}
	s.mu.Lock()
	s.modelLister = lister
	s.mu.Unlock()
}

// effectiveModels gathers all models from CPA configuration, supplemented by historical traffic.
func (s *Service) effectiveModels(ctx context.Context) ([]string, error) {
	modelSet := make(map[string]struct{})

	// 1. All currently connected models in CPA (primary)
	s.mu.Lock()
	lister := s.modelLister
	s.mu.Unlock()

	if lister != nil {
		configured, err := lister.ListConfiguredModels(ctx)
		if err != nil {
			s.logger.Warn("list configured CPA models failed", "error", err)
		} else {
			for _, m := range configured {
				m = strings.TrimSpace(m)
				if m != "" {
					modelSet[m] = struct{}{}
				}
			}
		}
	}

	// 2. Also union with models that appeared in historical request traffic
	if s.store != nil {
		trafficModels, err := s.store.ListEffectiveModels(ctx)
		if err != nil && len(modelSet) == 0 {
			return nil, err
		}
		for _, m := range trafficModels {
			m = strings.TrimSpace(m)
			if m != "" {
				modelSet[m] = struct{}{}
			}
		}
	}

	result := make([]string, 0, len(modelSet))
	for m := range modelSet {
		result = append(result, m)
	}
	sort.Strings(result)
	return result, nil
}

// SetInterval overrides the background sync cadence (tests).
func (s *Service) SetInterval(interval time.Duration) {
	if s == nil || interval <= 0 {
		return
	}
	s.mu.Lock()
	s.interval = interval
	s.mu.Unlock()
	select {
	case s.wakeCh <- struct{}{}:
	default:
	}
}

// SetAutoSyncInterval persists and applies the auto-sync interval in hours.
// 0 disables background auto-sync.
func (s *Service) SetAutoSyncInterval(ctx context.Context, hours int64) error {
	if s == nil || s.store == nil {
		return errors.New("pricing service is not initialized")
	}
	if hours < 0 || hours > 168 {
		return fmt.Errorf("invalid auto sync interval: %d hours (must be 0-168)", hours)
	}
	if err := s.store.UpdatePricingSyncSchedule(ctx, SourceModelsDev, hours); err != nil {
		return err
	}
	s.mu.Lock()
	s.autoSyncIntervalHours = hours
	if hours > 0 {
		s.interval = time.Duration(hours) * time.Hour
	}
	s.mu.Unlock()
	select {
	case s.wakeCh <- struct{}{}:
	default:
	}
	return nil
}

// IsRunning reports whether a sync is in flight right now.
func (s *Service) IsRunning() bool {
	if s == nil {
		return false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.running
}

// TriggerSync starts one sync in the background. It returns false when a sync
// is already running; the HTTP layer surfaces that as 409 instead of stacking
// concurrent fetches.
func (s *Service) TriggerSync() bool {
	if s == nil || s.store == nil {
		return false
	}
	s.mu.Lock()
	if s.running {
		s.mu.Unlock()
		return false
	}
	s.running = true
	s.mu.Unlock()
	go func() {
		defer func() {
			s.mu.Lock()
			s.running = false
			s.mu.Unlock()
		}()
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
		defer cancel()
		if _, err := s.SyncOnce(ctx); err != nil {
			s.logger.Warn("pricing sync failed", "error", err)
		}
	}()
	return true
}

// Run keeps prices fresh without any operator setup. Errors never stop the
// loop: the next tick retries and the last good prices stay in effect.
func (s *Service) Run(ctx context.Context) error {
	if s == nil || s.store == nil {
		return errors.New("pricing service is not initialized")
	}
	if state, err := s.store.GetPricingSyncState(ctx, SourceModelsDev); err == nil {
		s.mu.Lock()
		s.autoSyncIntervalHours = state.AutoSyncIntervalHours
		if state.AutoSyncIntervalHours > 0 {
			s.interval = time.Duration(state.AutoSyncIntervalHours) * time.Hour
		}
		s.mu.Unlock()
	}
	if err := s.syncLogged(ctx); err != nil && errors.Is(err, context.Canceled) {
		return nil
	}

	s.mu.Lock()
	interval := s.interval
	enabled := s.autoSyncIntervalHours > 0
	s.mu.Unlock()

	var ticker *time.Ticker
	var tickerC <-chan time.Time
	if enabled && interval > 0 {
		ticker = time.NewTicker(interval)
		tickerC = ticker.C
		defer ticker.Stop()
	}

	for {
		select {
		case <-ctx.Done():
			return nil
		case <-s.wakeCh:
			s.mu.Lock()
			newInterval := s.interval
			newEnabled := s.autoSyncIntervalHours > 0
			s.mu.Unlock()
			if ticker != nil {
				ticker.Stop()
				ticker = nil
				tickerC = nil
			}
			if newEnabled && newInterval > 0 {
				ticker = time.NewTicker(newInterval)
				tickerC = ticker.C
			}
		case <-tickerC:
			if err := s.syncLogged(ctx); err != nil && errors.Is(err, context.Canceled) {
				return nil
			}
		}
	}
}

func (s *Service) syncLogged(ctx context.Context) error {
	if _, err := s.SyncOnce(ctx); err != nil {
		if errors.Is(err, context.Canceled) {
			return err
		}
		s.logger.Warn("pricing sync failed", "error", err)
	}
	return nil
}

// SyncOnce fetches models.dev and applies unique strong matches. Manual rows
// and existing multipliers are preserved; failures keep the last good prices.
func (s *Service) SyncOnce(ctx context.Context) (SyncResult, error) {
	if s == nil || s.store == nil {
		return SyncResult{}, errors.New("pricing service is not initialized")
	}
	catalog, err := s.fetcher.Fetch(ctx)
	if err != nil {
		s.recordFailure(ctx, err)
		return SyncResult{}, err
	}
	models, err := s.effectiveModels(ctx)
	if err != nil {
		return SyncResult{}, err
	}
	existing, err := s.store.ListModelPrices(ctx)
	if err != nil {
		return SyncResult{}, err
	}
	multipliers := make(map[string]float64, len(existing))
	for _, row := range existing {
		if row.Source == SourceManual {
			continue
		}
		multipliers[row.Model] = row.PriceMultiplier
	}
	now := s.clock().UnixMilli()
	rows := make([]ModelPrice, 0, 256)
	var matched, unmatched, updated int64
	matchedModels := make(map[string]struct{}, len(models))
	for _, model := range models {
		entry := catalog.MatchModel(model)
		if entry == nil {
			unmatched++
			continue
		}
		matchedModels[model] = struct{}{}
		price := ModelPrice{
			Model:            model,
			PromptPricePer1M: derefOrZero(entry.Model.Cost.Input),
			CompletionPer1M:  derefOrZero(entry.Model.Cost.Output),
			CacheReadPer1M:   derefOrZero(entry.Model.Cost.CacheRead),
			CacheWritePer1M:  derefOrZero(entry.Model.Cost.CacheWrite),
			PriceMultiplier:  1,
			Source:           SourceModelsDev,
			SyncedAtMS:       now,
		}
		if multiplier, ok := multipliers[model]; ok && multiplier > 0 {
			price.PriceMultiplier = multiplier
		}
		rows = append(rows, price)
		matched++
	}
	if err := s.store.UpsertModelPrices(ctx, rows); err != nil {
		return SyncResult{}, err
	}
	updated = int64(len(rows))
	// Auto rows for models that left the traffic scope are dropped so the
	// table stays as small as the traffic it serves. Manual rows survive.
	var pruned int64
	for _, row := range existing {
		if row.Source != SourceModelsDev {
			continue
		}
		if _, stillUsed := matchedModels[row.Model]; stillUsed {
			continue
		}
		if _, err := s.store.DeleteModelPrice(ctx, row.Model); err != nil {
			return SyncResult{}, err
		}
		pruned++
	}
	state := SyncState{
		Source: SourceModelsDev, LastMatched: matched, LastUnmatched: unmatched,
	}
	success := now
	state.LastSuccessAtMS = &success
	if err := s.store.SavePricingSyncState(ctx, state); err != nil {
		return SyncResult{Matched: matched, Unmatched: unmatched, Updated: updated, Pruned: pruned}, err
	}
	return SyncResult{Matched: matched, Unmatched: unmatched, Updated: updated, Pruned: pruned}, nil
}

func (s *Service) recordFailure(ctx context.Context, syncErr error) {
	state, err := s.store.GetPricingSyncState(ctx, SourceModelsDev)
	if err != nil && !errors.Is(err, sql.ErrNoRows) && !errors.Is(err, context.Canceled) {
		return
	}
	state.Source = SourceModelsDev
	state.LastError = syncErr.Error()
	_ = s.store.SavePricingSyncState(ctx, state)
}

func derefOrZero(value *float64) float64 {
	if value == nil {
		return 0
	}
	if *value < 0 {
		return 0
	}
	return *value
}

// ListPrices exposes the price table for the management API.
func (s *Service) ListPrices(ctx context.Context) ([]ModelPrice, error) {
	return s.store.ListModelPrices(ctx)
}

// UsedUnpricedModels lists models that appear in real usage traffic
// but have no price row, capped for the UI.
func (s *Service) UsedUnpricedModels(ctx context.Context, limit int) ([]string, error) {
	if limit <= 0 || limit > 500 {
		limit = 200
	}
	models, err := s.effectiveModels(ctx)
	if err != nil {
		return nil, err
	}
	prices, err := s.store.ListModelPrices(ctx)
	if err != nil {
		return nil, err
	}
	priced := make(map[string]struct{}, len(prices))
	for _, row := range prices {
		priced[row.Model] = struct{}{}
	}
	result := make([]string, 0, len(models))
	for _, model := range models {
		if _, ok := priced[model]; ok {
			continue
		}
		result = append(result, model)
		if len(result) >= limit {
			break
		}
	}
	return result, nil
}

// SyncStateView returns the durable sync state for the API; sql.ErrNoRows from
// the store means "never synced" and surfaces as zero values.
func (s *Service) SyncStateView(ctx context.Context) (SyncState, bool, error) {
	s.mu.Lock()
	cachedHours := s.autoSyncIntervalHours
	s.mu.Unlock()

	state, err := s.store.GetPricingSyncState(ctx, SourceModelsDev)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			hours := cachedHours
			if hours <= 0 && cachedHours == 0 {
				hours = 24
			}
			return SyncState{Source: SourceModelsDev, AutoSyncIntervalHours: hours}, false, nil
		}
		return SyncState{}, false, err
	}
	if state.AutoSyncIntervalHours <= 0 && cachedHours > 0 {
		state.AutoSyncIntervalHours = cachedHours
	}
	if state.AutoSyncIntervalHours > 0 && state.LastSuccessAtMS != nil {
		next := *state.LastSuccessAtMS + (state.AutoSyncIntervalHours * 3600 * 1000)
		state.NextSyncAtMS = &next
	}
	return state, true, nil
}

// SaveManualPrices validates operator-edited rows and persists them as manual
// source. Manual rows are never touched by later models.dev syncs.
func (s *Service) SaveManualPrices(ctx context.Context, rows []ModelPrice) error {
	if s == nil || s.store == nil {
		return errors.New("pricing service is not initialized")
	}
	if len(rows) == 0 {
		return nil
	}
	for i := range rows {
		rows[i].Source = SourceManual
		rows[i].SyncedAtMS = 0
		if err := rows[i].Validate(); err != nil {
			return fmt.Errorf("model %q: %w", rows[i].Model, err)
		}
	}
	return s.store.UpsertModelPrices(ctx, rows)
}

// DeletePrice removes one operator-managed row; the next sync may recreate it
// as an auto row when models.dev still matches the model.
func (s *Service) DeletePrice(ctx context.Context, model string) (bool, error) {
	if s == nil || s.store == nil {
		return false, errors.New("pricing service is not initialized")
	}
	return s.store.DeleteModelPrice(ctx, model)
}
