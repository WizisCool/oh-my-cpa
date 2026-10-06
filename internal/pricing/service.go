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

var (
	ErrModelNotInCatalog = errors.New("model is not in the current CPA catalog")
	// ErrUpstreamNotFound refuses a link to an id the stored OpenRouter snapshot
	// does not list, rather than leaving the model without a price.
	ErrUpstreamNotFound = errors.New("model is not in the OpenRouter price list")
	// ErrNoAutomaticMatch refuses a switch to automatic pricing when nothing
	// matches: the switch would otherwise silently unprice the model.
	ErrNoAutomaticMatch = errors.New("no OpenRouter model matches this model automatically")
	ErrInvalidMode      = errors.New("mode must be auto, linked or custom")
	ErrInvalidReview    = errors.New("a model and an OpenRouter id are required")
)

// SyncState is the durable outcome of the last OpenRouter sync.
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

// ModeChange is one operator decision about how a model is priced. Price carries
// the rates for ModeCustom; UpstreamID names the pinned model for ModeLinked.
type ModeChange struct {
	Model      string
	Mode       string
	UpstreamID string
	Price      ModelPrice
	Multiplier float64
}

// Store is the persistence boundary; repository implements it.
type Store interface {
	ListModelPrices(context.Context) ([]ModelPrice, error)
	UpsertModelPrices(context.Context, []ModelPrice) error
	DeleteModelPrice(context.Context, string) (bool, error)
	ApplyModelPrice(context.Context, ModelPrice, string) error
	ListModelLinks(context.Context) (map[string]string, error)
	ListPricingModels(context.Context) (map[string]string, error)
	ReplacePricingModels(context.Context, map[string]string, ...CatalogProvider) (int64, error)
	ReplaceUpstreamCatalog(context.Context, []UpstreamModel) error
	ListUpstreamCatalog(context.Context) ([]UpstreamModel, error)
	GetPricingSyncState(context.Context, string) (SyncState, error)
	SavePricingSyncState(context.Context, SyncState) error
	UpdatePricingSyncSchedule(context.Context, string, int64) error
	ListChannelMultipliers(context.Context) ([]ChannelMultiplier, error)
	UpsertChannelMultiplier(context.Context, ChannelMultiplier) error
	DeleteChannelMultiplier(context.Context, string) (bool, error)
	ListMatchReviews(context.Context) (map[string]string, error)
	SaveMatchReview(ctx context.Context, model, upstreamID string) error
}

// SyncResult summarizes one sync run for logs, API and audit. Pruned counts
// automatic rows retired because their model left the current CPA catalog;
// custom rows are never pruned.
type SyncResult struct {
	Matched   int64
	Unmatched int64
	Updated   int64
	Pruned    int64
}

// catalogCacheTTL lets catalog-only reconciliation reuse a recent download: a
// burst of CPA configuration changes must not become a burst of fetches.
const catalogCacheTTL = 15 * time.Minute

// Service keeps the current CPA catalog and its prices fresh with zero operator
// setup. Catalog changes are coalesced, custom rows win, links are honoured, and
// failed discovery keeps the last complete catalog and good prices.
type Service struct {
	priceWrites           sync.Mutex
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
	catalogMu     sync.Mutex
	cachedCatalog *Catalog
	cachedAt      time.Time
}

func NewService(store Store, fetcher Fetcher, logger *slog.Logger) *Service {
	if logger == nil {
		logger = slog.Default()
	}
	if fetcher == nil {
		fetcher = NewOpenRouterClient()
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
	var providers []CatalogProvider
	var err error
	if rich, ok := lister.(interface {
		ListConfiguredModelSnapshot(context.Context) (ModelCatalogSnapshot, error)
	}); ok {
		var snapshot ModelCatalogSnapshot
		snapshot, err = rich.ListConfiguredModelSnapshot(ctx)
		models, providers = snapshot.Models, snapshot.Providers
	} else if rich, ok := lister.(interface {
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
	s.priceWrites.Lock()
	pruned, err := s.store.ReplacePricingModels(ctx, models, providers...)
	s.priceWrites.Unlock()
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
	if err := s.store.UpdatePricingSyncSchedule(ctx, SourceOpenRouter, hours); err != nil {
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
	if state, err := s.store.GetPricingSyncState(ctx, SourceOpenRouter); err == nil {
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

// currentCatalog returns the freshest snapshot available without the network
// when allowed: the in-memory download, then the stored snapshot. A refresh, or
// a process that has never stored one, downloads.
func (s *Service) currentCatalog(ctx context.Context, refresh bool) (Catalog, error) {
	if !refresh {
		if catalog, ok := s.localCatalog(ctx); ok {
			return catalog, nil
		}
	}
	// The mutex guards the cache fields only and is never held across the
	// download: an operator's link must not wait for a slow sync's fetch.
	catalog, err := s.fetcher.Fetch(ctx)
	if err != nil {
		return Catalog{}, err
	}
	if catalog.index == nil {
		catalog = NewCatalog(catalog.Models, catalog.FetchedAt)
	}
	if err := s.store.ReplaceUpstreamCatalog(ctx, catalog.Models); err != nil {
		return Catalog{}, err
	}
	s.catalogMu.Lock()
	s.cachedCatalog, s.cachedAt = &catalog, s.clock()
	s.catalogMu.Unlock()
	return catalog, nil
}

// localCatalog is the in-memory download while it is fresh, else the stored
// snapshot; it never touches the network.
func (s *Service) localCatalog(ctx context.Context) (Catalog, bool) {
	s.catalogMu.Lock()
	defer s.catalogMu.Unlock()
	if s.cachedCatalog != nil && s.clock().Sub(s.cachedAt) < catalogCacheTTL {
		return *s.cachedCatalog, true
	}
	stored, err := s.store.ListUpstreamCatalog(ctx)
	if err != nil || len(stored) == 0 {
		return Catalog{}, false
	}
	catalog := NewCatalog(stored, s.clock())
	s.cachedCatalog, s.cachedAt = &catalog, s.clock()
	return catalog, true
}

// StoredCatalog is the snapshot the console's model picker reads: never the
// network, so the picker works offline and costs OpenRouter nothing.
func (s *Service) StoredCatalog(ctx context.Context) ([]UpstreamModel, error) {
	if s == nil || s.store == nil {
		return nil, errors.New("pricing service is not initialized")
	}
	return s.store.ListUpstreamCatalog(ctx)
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
	needCatalog := refreshPrices
	if !needCatalog {
		existing, err := s.store.ListModelPrices(ctx)
		if err != nil {
			return result, err
		}
		priced := make(map[string]struct{}, len(existing))
		for _, row := range existing {
			priced[row.Model] = struct{}{}
		}
		for model := range models {
			if _, ok := priced[model]; !ok {
				needCatalog = true
				break
			}
		}
	}
	var catalog Catalog
	if needCatalog {
		// The download happens outside the write lock: an operator edit must not
		// wait on the network.
		catalog, err = s.currentCatalog(ctx, refreshPrices)
		if err != nil {
			return result, err
		}
	}
	// Prices and links are re-read under the write lock, so a link an operator set
	// while the catalog was downloading is honoured rather than overwritten.
	s.priceWrites.Lock()
	result, err = s.reconcilePrices(ctx, models, catalog, refreshPrices, pruned)
	s.priceWrites.Unlock()
	if err != nil {
		return result, err
	}
	// Local reconciliation cannot confirm recovery from a failed upstream refresh.
	if refreshPrices {
		now := s.clock().UnixMilli()
		state := SyncState{Source: SourceOpenRouter, LastSuccessAtMS: &now, LastMatched: result.Matched, LastUnmatched: result.Unmatched}
		err = s.store.SavePricingSyncState(ctx, state)
	}
	return result, err
}

// reconcilePrices runs with priceWrites held.
func (s *Service) reconcilePrices(ctx context.Context, models map[string]string, catalog Catalog, refreshPrices bool, pruned int64) (SyncResult, error) {
	result := SyncResult{Pruned: pruned}
	existing, err := s.store.ListModelPrices(ctx)
	if err != nil {
		return result, err
	}
	links, err := s.store.ListModelLinks(ctx)
	if err != nil {
		return result, err
	}
	prices := make(map[string]ModelPrice, len(existing))
	for _, p := range existing {
		prices[p.Model] = p
	}
	names := make([]string, 0, len(models))
	for model := range models {
		names = append(names, model)
	}
	sort.Strings(names)
	rows := make([]ModelPrice, 0, len(names))
	syncedAt := s.clock().UnixMilli()
	for _, model := range names {
		previous, hasPrice := prices[model]
		if hasPrice && (previous.Source == SourceManual || !refreshPrices) {
			result.Matched++
			continue
		}
		upstream, kind, found := resolveUpstream(catalog, model, models[model], links[model])
		if !found {
			// A temporary omission upstream is not an instruction to erase a known rate.
			if hasPrice {
				result.Matched++
			} else {
				result.Unmatched++
			}
			continue
		}
		multiplier := 1.0
		if hasPrice && previous.PriceMultiplier > 0 {
			multiplier = previous.PriceMultiplier
		}
		rows = append(rows, upstream.PriceFor(model, kind, multiplier, syncedAt))
		result.Matched++
	}
	if err := s.store.UpsertModelPrices(ctx, rows); err != nil {
		return result, err
	}
	result.Updated = int64(len(rows))
	return result, nil
}

// resolveUpstream applies an operator's link before any automatic match: a
// pinned model is followed even when the matcher would choose another.
func resolveUpstream(catalog Catalog, model, target, link string) (UpstreamModel, string, bool) {
	if len(catalog.Models) == 0 {
		return UpstreamModel{}, "", false
	}
	if link != "" {
		upstream, ok := catalog.Lookup(link)
		return upstream, MatchLinked, ok
	}
	if target == "" {
		return UpstreamModel{}, "", false
	}
	match, ok := catalog.MatchModel(target)
	return match.Model, match.Kind, ok
}

func (s *Service) recordFailure(ctx context.Context, syncErr error) {
	state, err := s.store.GetPricingSyncState(ctx, SourceOpenRouter)
	if err != nil && !errors.Is(err, sql.ErrNoRows) && !errors.Is(err, context.Canceled) {
		return
	}
	state.Source = SourceOpenRouter
	state.LastError = syncErr.Error()
	_ = s.store.SavePricingSyncState(ctx, state)
}

// ListPrices exposes the price table of the current CPA catalog, each row
// carrying its derived mode.
func (s *Service) ListPrices(ctx context.Context) ([]ModelPrice, error) {
	rows, err := s.store.ListModelPrices(ctx)
	if err != nil {
		return nil, err
	}
	models, err := s.store.ListPricingModels(ctx)
	if err != nil {
		return nil, err
	}
	links, err := s.store.ListModelLinks(ctx)
	if err != nil {
		return nil, err
	}
	current := make([]ModelPrice, 0, len(rows))
	for _, p := range rows {
		if _, ok := models[p.Model]; ok {
			_, linked := links[p.Model]
			p.Mode = DeriveMode(p.Source, linked)
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
	if limit > 0 && len(result) > limit {
		result = result[:limit]
	}
	return result, nil
}

// AutomaticMatch is what auto mode would price a model at, from the stored
// snapshot only; ok is false when nothing matches automatically.
func (s *Service) AutomaticMatch(ctx context.Context, model string) (Match, bool, error) {
	if s == nil || s.store == nil {
		return Match{}, false, errors.New("pricing service is not initialized")
	}
	models, err := s.store.ListPricingModels(ctx)
	if err != nil {
		return Match{}, false, err
	}
	target, ok := models[model]
	if !ok {
		target = model
	}
	if target == "" {
		return Match{}, false, nil
	}
	catalog, ok := s.localCatalog(ctx)
	if !ok {
		return Match{}, false, nil
	}
	match, found := catalog.MatchModel(target)
	return match, found, nil
}

// Suggestions offers the OpenRouter models a CPA model most resembles, from the
// stored snapshot only. A model that matches automatically needs no suggestion,
// so its first entry is the automatic match.
func (s *Service) Suggestions(ctx context.Context, model string, limit int) ([]UpstreamModel, error) {
	if s == nil || s.store == nil {
		return nil, errors.New("pricing service is not initialized")
	}
	models, err := s.store.ListPricingModels(ctx)
	if err != nil {
		return nil, err
	}
	target := models[model]
	if target == "" {
		target = model
	}
	catalog, ok := s.localCatalog(ctx)
	if !ok {
		return nil, nil
	}
	var result []UpstreamModel
	if match, ok := catalog.MatchModel(target); ok {
		result = append(result, match.Model)
	}
	for _, candidate := range catalog.Suggest(target, limit+1) {
		if len(result) >= limit {
			break
		}
		if len(result) > 0 && result[0].ID == candidate.ID {
			continue
		}
		result = append(result, candidate)
	}
	return result, nil
}

// SyncStateView returns the durable sync state for the API; sql.ErrNoRows from
// the store means "never synced" and surfaces as zero values.
func (s *Service) SyncStateView(ctx context.Context) (SyncState, bool, error) {
	s.mu.Lock()
	cachedHours := s.autoSyncIntervalHours
	s.mu.Unlock()

	state, err := s.store.GetPricingSyncState(ctx, SourceOpenRouter)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			hours := cachedHours
			if hours <= 0 && cachedHours == 0 {
				hours = 24
			}
			return SyncState{Source: SourceOpenRouter, AutoSyncIntervalHours: hours}, false, nil
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

// SetModelMode applies one operator decision. Every mode change is a single
// write, so it mints exactly one price version: custom stores the operator's
// rates, linked pins an OpenRouter model and prices it now, auto drops any pin
// and prices from the automatic match. A switch that would leave the model
// without a price is refused instead.
func (s *Service) SetModelMode(ctx context.Context, change ModeChange) (ModelPrice, error) {
	return s.SetModelModeChecked(ctx, change, nil)
}

// SetModelModeChecked makes approval preconditions atomic with the write.
func (s *Service) SetModelModeChecked(ctx context.Context, change ModeChange, check func([]ModelPrice) error) (ModelPrice, error) {
	if s == nil || s.store == nil {
		return ModelPrice{}, errors.New("pricing service is not initialized")
	}
	change.Model = strings.TrimSpace(change.Model)
	change.UpstreamID = strings.TrimSpace(change.UpstreamID)
	s.priceWrites.Lock()
	defer s.priceWrites.Unlock()
	if check != nil {
		current, err := s.ListPrices(ctx)
		if err != nil {
			return ModelPrice{}, err
		}
		if err := check(current); err != nil {
			return ModelPrice{}, err
		}
	}
	row, link, target, err := s.resolveModeChange(ctx, change)
	if err != nil {
		return ModelPrice{}, err
	}
	if err := s.store.ApplyModelPrice(ctx, row, link); err != nil {
		return ModelPrice{}, err
	}
	s.acknowledgeCandidate(ctx, change.Model, target, change.Mode, link)
	row.Mode = change.Mode
	return row, nil
}

// PreviewModeChange resolves the price a mode change would write, without
// writing it, so a dry run and the write can never disagree about the rates.
func (s *Service) PreviewModeChange(ctx context.Context, change ModeChange) (ModelPrice, error) {
	if s == nil || s.store == nil {
		return ModelPrice{}, errors.New("pricing service is not initialized")
	}
	change.Model = strings.TrimSpace(change.Model)
	change.UpstreamID = strings.TrimSpace(change.UpstreamID)
	row, _, _, err := s.resolveModeChange(ctx, change)
	row.Mode = change.Mode
	return row, err
}

// resolveModeChange turns a decision into the row to store, the pin to keep
// beside it and the catalog target the model resolves to.
func (s *Service) resolveModeChange(ctx context.Context, change ModeChange) (ModelPrice, string, string, error) {
	models, err := s.store.ListPricingModels(ctx)
	if err != nil {
		return ModelPrice{}, "", "", err
	}
	target, inCatalog := models[change.Model]
	if !inCatalog {
		return ModelPrice{}, "", "", fmt.Errorf("%w: %q", ErrModelNotInCatalog, change.Model)
	}
	multiplier := change.Multiplier
	if multiplier == 0 {
		multiplier = 1
	}
	var row ModelPrice
	link := ""
	switch change.Mode {
	case ModeCustom:
		row = change.Price
		row.Model = change.Model
		row.Source = SourceManual
		row.SyncedAtMS = 0
		row.UpstreamID = strings.TrimSpace(row.UpstreamID)
		row.MatchKind = ""
		row.PriceMultiplier = multiplier
		row.Tiers = CanonicalTiers(row.Tiers)
	case ModeLinked, ModeAuto:
		// Only the local snapshot: a write holds the lock here, and a link can only
		// name a model the picker showed from that same snapshot.
		catalog, ok := s.localCatalog(ctx)
		if !ok {
			return ModelPrice{}, "", "", fmt.Errorf("%w: the price list has not been downloaded yet", ErrUpstreamNotFound)
		}
		if change.Mode == ModeLinked {
			upstream, ok := catalog.Lookup(change.UpstreamID)
			if !ok {
				return ModelPrice{}, "", "", fmt.Errorf("%w: %q", ErrUpstreamNotFound, change.UpstreamID)
			}
			row = upstream.PriceFor(change.Model, MatchLinked, multiplier, s.clock().UnixMilli())
			link = upstream.ID
		} else {
			match, ok := catalog.MatchModel(target)
			if target == "" || !ok {
				return ModelPrice{}, "", "", fmt.Errorf("%w: %q", ErrNoAutomaticMatch, change.Model)
			}
			row = match.Model.PriceFor(change.Model, match.Kind, multiplier, s.clock().UnixMilli())
		}
	default:
		return ModelPrice{}, "", "", ErrInvalidMode
	}
	if err := row.ValidateWrite(); err != nil {
		return ModelPrice{}, "", "", fmt.Errorf("model %q: %w", change.Model, err)
	}
	return row, link, target, nil
}

// Candidate kinds: OpenRouter now prices the model by name, or only resembles it.
const (
	CandidateAutomatic = "automatic"
	CandidateSuggested = "suggested"
)

// Candidate is an OpenRouter model a custom or linked price could follow
// instead, offered because the operator has not seen it yet.
type Candidate struct {
	Model     UpstreamModel `json:"model"`
	Kind      string        `json:"kind"`
	MatchKind string        `json:"match_kind,omitempty"`
}

// candidateFor is what a model priced by the operator could follow now. A
// custom price is offered its automatic match, or failing that its closest
// suggestion; a linked price only an automatic match other than its pin, since
// the operator already chose among the suggestions. Auto rows have none.
func candidateFor(catalog Catalog, target, mode, link string) (Candidate, bool) {
	if target == "" || (mode != ModeCustom && mode != ModeLinked) {
		return Candidate{}, false
	}
	if match, ok := catalog.MatchModel(target); ok {
		if mode == ModeLinked && match.Model.ID == link {
			return Candidate{}, false
		}
		return Candidate{Model: match.Model, Kind: CandidateAutomatic, MatchKind: match.Kind}, true
	}
	if mode == ModeCustom {
		if suggested := catalog.Suggest(target, 1); len(suggested) > 0 {
			return Candidate{Model: suggested[0], Kind: CandidateSuggested}, true
		}
	}
	return Candidate{}, false
}

// acknowledgeCandidate records the candidate an operator decided against by
// choosing their own price, so only a later, different one is offered. It is
// bookkeeping beside the price write: a failure only means the current
// candidate is offered once more, so it is logged rather than failing the save.
func (s *Service) acknowledgeCandidate(ctx context.Context, model, target, mode, link string) {
	seen := ""
	if catalog, ok := s.localCatalog(ctx); ok {
		if candidate, found := candidateFor(catalog, target, mode, link); found {
			seen = candidate.Model.ID
		}
	}
	if err := s.store.SaveMatchReview(ctx, model, seen); err != nil {
		s.logger.Warn("pricing match review not recorded", "model", model, "error", err)
	}
}

// Candidates lists, for every custom or linked price in the current catalog,
// an OpenRouter model it could follow that its operator has not seen yet - such
// as a model OpenRouter started listing after a custom price was set. Read
// from the stored snapshot only. Candidates are advisory: callers degrade to
// none on an error instead of failing the read they decorate.
func (s *Service) Candidates(ctx context.Context, prices []ModelPrice) (map[string]Candidate, error) {
	if s == nil || s.store == nil {
		return nil, errors.New("pricing service is not initialized")
	}
	result := map[string]Candidate{}
	catalog, ok := s.localCatalog(ctx)
	if !ok {
		return result, nil
	}
	models, err := s.store.ListPricingModels(ctx)
	if err != nil {
		return nil, err
	}
	links, err := s.store.ListModelLinks(ctx)
	if err != nil {
		return nil, err
	}
	reviews, err := s.store.ListMatchReviews(ctx)
	if err != nil {
		return nil, err
	}
	for _, price := range prices {
		candidate, found := candidateFor(catalog, models[price.Model], price.Mode, links[price.Model])
		if found && reviews[price.Model] != candidate.Model.ID {
			result[price.Model] = candidate
		}
	}
	return result, nil
}

// DismissCandidate records that the operator saw a candidate and kept their
// own price; a different candidate appearing later is offered again.
func (s *Service) DismissCandidate(ctx context.Context, model, upstreamID string) error {
	if s == nil || s.store == nil {
		return errors.New("pricing service is not initialized")
	}
	model = strings.TrimSpace(model)
	upstreamID = strings.TrimSpace(upstreamID)
	if model == "" || upstreamID == "" {
		return ErrInvalidReview
	}
	return s.store.SaveMatchReview(ctx, model, upstreamID)
}

// DeletePrice retires one price and its pin; the next sync may recreate an
// automatic price when OpenRouter still matches the model.
func (s *Service) DeletePrice(ctx context.Context, model string) (bool, error) {
	return s.DeletePriceChecked(ctx, model, nil)
}

// DeletePriceChecked shares the write lock with normal edits and background sync.
func (s *Service) DeletePriceChecked(ctx context.Context, model string, check func([]ModelPrice) error) (bool, error) {
	if s == nil || s.store == nil {
		return false, errors.New("pricing service is not initialized")
	}
	s.priceWrites.Lock()
	defer s.priceWrites.Unlock()
	if check != nil {
		current, err := s.ListPrices(ctx)
		if err != nil {
			return false, err
		}
		if err := check(current); err != nil {
			return false, err
		}
	}
	deleted, err := s.store.DeleteModelPrice(ctx, model)
	if err == nil && deleted {
		s.NotifyModelsChanged()
	}
	return deleted, err
}

// ListChannels returns every channel multiplier.
func (s *Service) ListChannels(ctx context.Context) ([]ChannelMultiplier, error) {
	if s == nil || s.store == nil {
		return nil, errors.New("pricing service is not initialized")
	}
	return s.store.ListChannelMultipliers(ctx)
}

// SetChannel stores one channel multiplier; it governs requests stamped from
// now on and never reprices recorded ones.
func (s *Service) SetChannel(ctx context.Context, channel ChannelMultiplier) (ChannelMultiplier, error) {
	return s.SetChannelChecked(ctx, channel, nil)
}

// SetChannelChecked makes approval preconditions atomic with the write.
func (s *Service) SetChannelChecked(ctx context.Context, channel ChannelMultiplier, check func([]ChannelMultiplier) error) (ChannelMultiplier, error) {
	if s == nil || s.store == nil {
		return ChannelMultiplier{}, errors.New("pricing service is not initialized")
	}
	if err := channel.Validate(); err != nil {
		return ChannelMultiplier{}, err
	}
	s.priceWrites.Lock()
	defer s.priceWrites.Unlock()
	if err := s.checkChannels(ctx, check); err != nil {
		return ChannelMultiplier{}, err
	}
	if err := s.store.UpsertChannelMultiplier(ctx, channel); err != nil {
		return ChannelMultiplier{}, err
	}
	return channel, nil
}

// DeleteChannel returns a channel to 1x for requests stamped from now on.
func (s *Service) DeleteChannel(ctx context.Context, channel string) (bool, error) {
	return s.DeleteChannelChecked(ctx, channel, nil)
}

// DeleteChannelChecked shares the write lock and the approval precondition.
func (s *Service) DeleteChannelChecked(ctx context.Context, channel string, check func([]ChannelMultiplier) error) (bool, error) {
	if s == nil || s.store == nil {
		return false, errors.New("pricing service is not initialized")
	}
	s.priceWrites.Lock()
	defer s.priceWrites.Unlock()
	if err := s.checkChannels(ctx, check); err != nil {
		return false, err
	}
	return s.store.DeleteChannelMultiplier(ctx, strings.TrimSpace(channel))
}

func (s *Service) checkChannels(ctx context.Context, check func([]ChannelMultiplier) error) error {
	if check == nil {
		return nil
	}
	current, err := s.store.ListChannelMultipliers(ctx)
	if err != nil {
		return err
	}
	return check(current)
}
