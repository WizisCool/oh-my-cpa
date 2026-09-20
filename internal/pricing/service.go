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

var ErrModelNotInCatalog = errors.New("model is not in the current CPA catalog")

// SyncState is the durable outcome of the last models.dev sync.
type SyncState struct {
	Source                string `json:"source"`
	LastError             string `json:"last_error"`
	LastMatched           int64  `json:"last_matched"`
	LastUnmatched         int64  `json:"last_unmatched"`
	LastSuccessAtMS       *int64 `json:"last_success_at_ms"`
	UpdatedAtMS           int64  `json:"updated_at_ms"`
	AutoSyncIntervalHours int64  `json:"auto_sync_interval_hours"`
	CatalogUpdatedAtMS    int64  `json:"catalog_updated_at_ms"`
	NextSyncAtMS          *int64 `json:"next_sync_at_ms,omitempty"`
}

// Store is the persistence boundary; repository implements it.
type Store interface {
	ListModelPrices(context.Context) ([]ModelPrice, error)
	UpsertModelPrices(context.Context, []ModelPrice) error
	DeleteModelPrice(context.Context, string) (bool, error)
	ListPricingModels(context.Context) (map[string]string, error)
	ReplacePricingModels(context.Context, map[string]string) (int64, error)
	GetPricingSyncState(context.Context, string) (SyncState, error)
	SavePricingSyncState(context.Context, SyncState) error
	UpdatePricingSyncSchedule(context.Context, string, int64) error
}

// Fetcher decodes the fixed models.dev catalog.
type Fetcher interface {
	Fetch(context.Context) (Catalog, error)
}

// SyncResult summarizes one sync run for logs, API and audit. Pruned counts
// auto rows retired because their model left the current CPA catalog; manual rows
// are never pruned.
type SyncResult struct {
	Matched   int64
	Unmatched int64
	Updated   int64
	Pruned    int64
}

// Service keeps the current CPA catalog and its prices fresh with zero operator
// setup. Catalog changes are coalesced, manual rows win, and failed discovery
// keeps the last complete catalog and good prices.
type Service struct {
	store                 Store
	fetcher               Fetcher
	modelLister           ModelLister
	logger                *slog.Logger
	interval              time.Duration
	autoSyncIntervalHours int64
	clock                 func() time.Time

	mu            sync.Mutex
	running       bool
	stopped       bool
	wakeCh        chan struct{}
	pending       bool
	force         bool
	rootCtx       context.Context
	workers       sync.WaitGroup
	syncMu        sync.Mutex
	cachedCatalog *Catalog
	cachedAt      time.Time
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

// refreshModels only publishes complete authoritative snapshots. Offline CPA
// never turns a partial/empty response into destructive catalog removal.
func (s *Service) refreshModels(ctx context.Context) (map[string]string, int64, error) {
	s.mu.Lock()
	lister := s.modelLister
	s.mu.Unlock()
	if lister == nil {
		models, err := s.store.ListPricingModels(ctx)
		return models, 0, err
	}
	var models map[string]string
	var err error
	if rich, ok := lister.(interface {
		ListConfiguredModelCatalog(context.Context) (map[string]string, error)
	}); ok {
		models, err = rich.ListConfiguredModelCatalog(ctx)
	} else {
		var names []string
		names, err = lister.ListConfiguredModels(ctx)
		models = make(map[string]string, len(names))
		for _, name := range names {
			name = strings.TrimSpace(name)
			if name != "" {
				models[name] = name
			}
		}
	}
	if err != nil {
		return nil, 0, err
	}
	if len(models) == 0 {
		return nil, 0, errors.New("refusing to publish an empty pricing catalog snapshot")
	}
	pruned, err := s.store.ReplacePricingModels(ctx, models)
	return models, pruned, err
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

// TriggerSync is an explicit price refresh. Configuration notifications use
// NotifyModelsChanged: coalesced work is retained even during a running sync.
func (s *Service) TriggerSync() bool    { return s.trigger(true) }
func (s *Service) NotifyModelsChanged() { s.trigger(false) }
func (s *Service) trigger(force bool) bool {
	if s == nil || s.store == nil {
		return false
	}
	s.mu.Lock()
	s.pending = true
	s.force = s.force || force
	if s.running {
		s.mu.Unlock()
		return false
	}
	root := s.rootCtx
	if root == nil {
		root = context.Background()
	}
	if root.Err() != nil || s.stopped {
		s.mu.Unlock()
		return false
	}
	s.running = true
	s.workers.Add(1)
	s.mu.Unlock()
	go func() {
		defer s.workers.Done()
		for {
			timer := time.NewTimer(150 * time.Millisecond)
			select {
			case <-root.Done():
				timer.Stop()
			case <-timer.C:
			}
			s.mu.Lock()
			force := s.force
			s.force = false
			s.pending = false
			s.mu.Unlock()
			ctx, cancel := context.WithTimeout(root, 2*time.Minute)
			if _, err := s.syncOnce(ctx, force); err != nil && !errors.Is(err, context.Canceled) {
				s.logger.Warn("pricing sync failed", "error", err)
			}
			cancel()
			s.mu.Lock()
			if !s.pending || root.Err() != nil {
				s.running = false
				s.mu.Unlock()
				return
			}
			s.mu.Unlock()
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
	s.mu.Lock()
	s.rootCtx = ctx
	s.mu.Unlock()
	defer func() { s.mu.Lock(); s.stopped = true; s.mu.Unlock(); s.workers.Wait() }()
	if state, err := s.store.GetPricingSyncState(ctx, SourceModelsDev); err == nil {
		s.mu.Lock()
		s.autoSyncIntervalHours = state.AutoSyncIntervalHours
		if state.AutoSyncIntervalHours > 0 {
			s.interval = time.Duration(state.AutoSyncIntervalHours) * time.Hour
		}
		s.mu.Unlock()
	}
	s.TriggerSync()
	catalogTicker := time.NewTicker(5 * time.Minute)
	defer catalogTicker.Stop()

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
		case <-catalogTicker.C:
			s.NotifyModelsChanged()
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
			s.TriggerSync()
		}
	}
}

// SyncOnce refreshes prices explicitly. All sync paths serialize here.
func (s *Service) SyncOnce(ctx context.Context) (SyncResult, error) { return s.syncOnce(ctx, true) }
func (s *Service) syncOnce(ctx context.Context, refreshPrices bool) (result SyncResult, err error) {
	if s == nil || s.store == nil {
		return result, errors.New("pricing service is not initialized")
	}
	s.syncMu.Lock()
	defer s.syncMu.Unlock()
	defer func() {
		if err != nil {
			s.recordFailure(ctx, err)
		}
	}()
	models, pruned, err := s.refreshModels(ctx)
	if err != nil {
		return result, err
	}
	result.Pruned = pruned
	existing, err := s.store.ListModelPrices(ctx)
	if err != nil {
		return result, err
	}
	prices := make(map[string]ModelPrice, len(existing))
	for _, p := range existing {
		prices[p.Model] = p
	}
	needCatalog := refreshPrices
	for model := range models {
		if _, ok := prices[model]; !ok {
			needCatalog = true
		}
	}
	var catalog Catalog
	if needCatalog {
		if !refreshPrices && s.cachedCatalog != nil && s.clock().Sub(s.cachedAt) < 15*time.Minute {
			catalog = *s.cachedCatalog
		} else {
			catalog, err = s.fetcher.Fetch(ctx)
			if err != nil {
				return result, err
			}
			s.cachedCatalog = &catalog
			s.cachedAt = s.clock()
		}
	}
	rows := make([]ModelPrice, 0, len(models))
	names := make([]string, 0, len(models))
	for model := range models {
		names = append(names, model)
	}
	sort.Strings(names)
	for _, model := range names {
		previous, hasPrice := prices[model]
		if hasPrice && (previous.Source == SourceManual || !refreshPrices) {
			result.Matched++
			continue
		}
		target := models[model]
		var entry *CatalogEntry
		if target != "" {
			entry = catalog.MatchModel(target)
		}
		if entry == nil {
			// A temporary metadata omission is not a instruction to erase a known rate.
			if hasPrice {
				result.Matched++
			} else {
				result.Unmatched++
			}
			continue
		}
		price := ModelPrice{Model: model, PromptPricePer1M: derefOrZero(entry.Model.Cost.Input), CompletionPer1M: derefOrZero(entry.Model.Cost.Output),
			CacheReadPer1M: derefOrZero(entry.Model.Cost.CacheRead), CacheWritePer1M: derefOrZero(entry.Model.Cost.CacheWrite), PriceMultiplier: 1, Source: SourceModelsDev, SyncedAtMS: s.clock().UnixMilli()}
		if hasPrice && previous.PriceMultiplier > 0 {
			price.PriceMultiplier = previous.PriceMultiplier
		}
		rows = append(rows, price)
		result.Matched++
	}
	if err = s.store.UpsertModelPrices(ctx, rows); err != nil {
		return result, err
	}
	result.Updated = int64(len(rows))
	state := SyncState{Source: SourceModelsDev, LastMatched: result.Matched, LastUnmatched: result.Unmatched}
	// Catalog-only reconciliation must not postpone the displayed price refresh.
	if refreshPrices {
		now := s.clock().UnixMilli()
		state.LastSuccessAtMS = &now
	}
	err = s.store.SavePricingSyncState(ctx, state)
	return result, err
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
	rows, err := s.store.ListModelPrices(ctx)
	if err != nil {
		return nil, err
	}
	models, err := s.store.ListPricingModels(ctx)
	if err != nil {
		return nil, err
	}
	current := make([]ModelPrice, 0, len(rows))
	for _, p := range rows {
		if _, ok := models[p.Model]; ok {
			current = append(current, p)
		}
	}
	return current, nil
}

// UsedUnpricedModels lists only current CPA models without a price. Historical
// usage does not create an operator maintenance obligation.
func (s *Service) UsedUnpricedModels(ctx context.Context, limit int) ([]string, error) {

	models, err := s.store.ListPricingModels(ctx)
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
	for model := range models {
		if _, ok := priced[model]; ok {
			continue
		}
		result = append(result, model)
	}
	sort.Strings(result)
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
	models, err := s.store.ListPricingModels(ctx)
	if err != nil {
		return err
	}
	for i := range rows {
		rows[i].Model = strings.TrimSpace(rows[i].Model)
		if _, ok := models[rows[i].Model]; !ok {
			return fmt.Errorf("%w: %q", ErrModelNotInCatalog, rows[i].Model)
		}
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
	deleted, err := s.store.DeleteModelPrice(ctx, model)
	if err == nil && deleted {
		s.NotifyModelsChanged()
	}
	return deleted, err
}
