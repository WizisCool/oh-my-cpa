package pricing

import (
	"context"
	"database/sql"
	"errors"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeStore mirrors the repository's write guards: an automatic write never
// replaces a custom row, and never replaces a row pinned to another model.
type fakeStore struct {
	mu         sync.Mutex
	prices     []ModelPrice
	upserted   []ModelPrice
	applied    []ModelPrice
	deleted    []string
	saved      []SyncState
	models     map[string]string
	links      map[string]string
	upstream   []UpstreamModel
	channels   map[string]ChannelMultiplier
	state      SyncState
	stateKnown bool
}

func newFakeStore(models ...string) *fakeStore {
	store := &fakeStore{models: map[string]string{}, links: map[string]string{}, channels: map[string]ChannelMultiplier{}}
	for _, model := range models {
		store.models[model] = model
	}
	return store
}

func (s *fakeStore) ListModelPrices(context.Context) ([]ModelPrice, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]ModelPrice(nil), s.prices...), nil
}

func (s *fakeStore) UpsertModelPrices(_ context.Context, rows []ModelPrice) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.upserted = append(s.upserted, rows...)
	for _, row := range rows {
		if link, ok := s.links[row.Model]; ok && row.Source != SourceManual && link != row.UpstreamID {
			continue
		}
		s.putLocked(row, row.Source == SourceManual)
	}
	return nil
}

func (s *fakeStore) putLocked(row ModelPrice, force bool) {
	for i, p := range s.prices {
		if p.Model == row.Model {
			if force || p.Source != SourceManual {
				s.prices[i] = row
			}
			return
		}
	}
	s.prices = append(s.prices, row)
}

func (s *fakeStore) ApplyModelPrice(_ context.Context, row ModelPrice, link string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.applied = append(s.applied, row)
	s.putLocked(row, true)
	if link == "" {
		delete(s.links, row.Model)
	} else {
		s.links[row.Model] = link
	}
	return nil
}

func (s *fakeStore) ListModelLinks(context.Context) (map[string]string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	result := make(map[string]string, len(s.links))
	for model, link := range s.links {
		result[model] = link
	}
	return result, nil
}

func (s *fakeStore) DeleteModelPrice(_ context.Context, model string) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.deleted = append(s.deleted, model)
	delete(s.links, model)
	for i, p := range s.prices {
		if p.Model == model {
			s.prices = append(s.prices[:i], s.prices[i+1:]...)
			return true, nil
		}
	}
	return false, nil
}

func (s *fakeStore) ListPricingModels(context.Context) (map[string]string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	result := make(map[string]string, len(s.models))
	for model, target := range s.models {
		result[model] = target
	}
	return result, nil
}

func (s *fakeStore) ReplacePricingModels(_ context.Context, models map[string]string, providers ...CatalogProvider) (int64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.models = make(map[string]string, len(models))
	for model, target := range models {
		s.models[model] = target
	}
	var kept []ModelPrice
	var pruned int64
	for _, p := range s.prices {
		if _, ok := models[p.Model]; !ok && p.Source != SourceManual {
			pruned++
			s.deleted = append(s.deleted, p.Model)
			continue
		}
		kept = append(kept, p)
	}
	s.prices = kept
	return pruned, nil
}

func (s *fakeStore) ReplaceUpstreamCatalog(_ context.Context, models []UpstreamModel) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.upstream = append([]UpstreamModel(nil), models...)
	return nil
}

func (s *fakeStore) ListUpstreamCatalog(context.Context) ([]UpstreamModel, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]UpstreamModel(nil), s.upstream...), nil
}

func (s *fakeStore) GetPricingSyncState(context.Context, string) (SyncState, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.stateKnown {
		return SyncState{}, sql.ErrNoRows
	}
	return s.state, nil
}

func (s *fakeStore) SavePricingSyncState(_ context.Context, state SyncState) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.saved = append(s.saved, state)
	s.state = state
	s.stateKnown = true
	return nil
}

func (s *fakeStore) UpdatePricingSyncSchedule(_ context.Context, _ string, intervalHours int64) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.state.AutoSyncIntervalHours = intervalHours
	s.stateKnown = true
	return nil
}

func (s *fakeStore) ListChannelMultipliers(context.Context) ([]ChannelMultiplier, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	result := make([]ChannelMultiplier, 0, len(s.channels))
	for _, channel := range s.channels {
		result = append(result, channel)
	}
	sort.Slice(result, func(i, j int) bool { return result[i].Channel < result[j].Channel })
	return result, nil
}

func (s *fakeStore) UpsertChannelMultiplier(_ context.Context, channel ChannelMultiplier) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.channels[channel.Channel] = channel
	return nil
}

func (s *fakeStore) DeleteChannelMultiplier(_ context.Context, channel string) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, ok := s.channels[channel]
	delete(s.channels, channel)
	return ok, nil
}

func (s *fakeStore) price(model string) (ModelPrice, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, p := range s.prices {
		if p.Model == model {
			return p, true
		}
	}
	return ModelPrice{}, false
}

type fakeFetcher struct {
	mu      sync.Mutex
	catalog Catalog
	err     error
	calls   int
}

func (f *fakeFetcher) Fetch(context.Context) (Catalog, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls++
	return f.catalog, f.err
}

type fakeModelLister struct {
	models []string
	err    error
}

func (f *fakeModelLister) ListConfiguredModels(context.Context) ([]string, error) {
	return f.models, f.err
}

type catalogLister struct {
	models map[string]string
	calls  int
}

func (l *catalogLister) ListConfiguredModels(context.Context) ([]string, error) {
	panic("rich catalog must be preferred")
}

func (l *catalogLister) ListConfiguredModelCatalog(context.Context) (map[string]string, error) {
	l.calls++
	return l.models, nil
}

func TestSyncCreatesAutoRowsAndProtectsCustom(t *testing.T) {
	store := newFakeStore("claude-opus-5.5", "glm-5.3", "totally-unknown-model")
	store.prices = []ModelPrice{
		{Model: "claude-opus-5.5", PromptPricePer1M: 1, PriceMultiplier: 2, Source: SourceOpenRouter},
		{Model: "glm-5.3", PromptPricePer1M: 99, PriceMultiplier: 1, Source: SourceManual},
	}
	service := NewService(store, &fakeFetcher{catalog: loadFixtureCatalog(t)}, nil)
	result, err := service.SyncOnce(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if result.Matched != 2 || result.Unmatched != 1 || result.Updated != 1 {
		t.Fatalf("unexpected result: %+v", result)
	}
	opus, _ := store.price("claude-opus-5.5")
	if opus.PromptPricePer1M != 4 || opus.PriceMultiplier != 2 || opus.UpstreamID != "anthropic/claude-opus-5.5" || opus.MatchKind != MatchExact {
		t.Fatalf("auto row not refreshed or multiplier lost: %+v", opus)
	}
	glm, _ := store.price("glm-5.3")
	if glm.PromptPricePer1M != 99 || glm.Source != SourceManual {
		t.Fatalf("custom row was overwritten: %+v", glm)
	}
	if len(store.upstream) == 0 {
		t.Fatal("the downloaded snapshot was not stored for the picker")
	}
	if store.state.Source != SourceOpenRouter || store.state.LastSuccessAtMS == nil {
		t.Fatalf("sync state: %+v", store.state)
	}
}

// A legacy models.dev row stays until a sync can replace it, and then records
// OpenRouter as its source.
func TestSyncReplacesLegacyRowsOnlyWhenMatched(t *testing.T) {
	store := newFakeStore("claude-opus-5.5", "legacy-only")
	store.prices = []ModelPrice{
		{Model: "claude-opus-5.5", PromptPricePer1M: 1, PriceMultiplier: 1, Source: SourceModelsDev},
		{Model: "legacy-only", PromptPricePer1M: 7, PriceMultiplier: 1, Source: SourceModelsDev},
	}
	service := NewService(store, &fakeFetcher{catalog: loadFixtureCatalog(t)}, nil)
	if _, err := service.SyncOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	opus, _ := store.price("claude-opus-5.5")
	if opus.Source != SourceOpenRouter {
		t.Fatalf("matched legacy row not replaced: %+v", opus)
	}
	legacy, _ := store.price("legacy-only")
	if legacy.Source != SourceModelsDev || legacy.PromptPricePer1M != 7 {
		t.Fatalf("unmatched legacy row lost its rate: %+v", legacy)
	}
}

func TestSyncFailureKeepsLastGoodPrices(t *testing.T) {
	store := newFakeStore("claude-opus-5.5")
	service := NewService(store, &fakeFetcher{err: errors.New("network down")}, nil)
	if _, err := service.SyncOnce(context.Background()); err == nil {
		t.Fatal("expected fetch failure")
	}
	if len(store.upserted) != 0 {
		t.Fatalf("failed sync must not write prices: %+v", store.upserted)
	}
	if !strings.Contains(store.state.LastError, "network down") {
		t.Fatalf("failure not recorded: %+v", store.state)
	}
	if len(store.saved) != 1 || store.saved[0].LastSuccessAtMS != nil {
		t.Fatalf("failure must not fake success: %+v", store.saved)
	}
}

func TestSyncPrunesAutoRowsOutsideCatalog(t *testing.T) {
	store := newFakeStore("claude-opus-5.5")
	store.prices = []ModelPrice{
		{Model: "stale/catalog-model", PromptPricePer1M: 1, PriceMultiplier: 1, Source: SourceOpenRouter},
		{Model: "manual-keep", PromptPricePer1M: 5, PriceMultiplier: 1, Source: SourceManual},
	}
	service := NewService(store, &fakeFetcher{catalog: loadFixtureCatalog(t)}, nil)
	service.SetModelLister(&fakeModelLister{models: []string{"claude-opus-5.5"}})
	result, err := service.SyncOnce(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if result.Pruned != 1 || len(store.deleted) != 1 || store.deleted[0] != "stale/catalog-model" {
		t.Fatalf("stale auto row not pruned: %+v deleted=%v", result, store.deleted)
	}
	if _, ok := store.price("manual-keep"); !ok {
		t.Fatal("custom row must survive pruning")
	}
}

// A second sync with unchanged upstream data writes identical rows, so the
// version trigger has nothing to record.
func TestSyncIsIdempotent(t *testing.T) {
	store := newFakeStore("claude-sonnet-4.5", "tencent-hy3")
	store.models["tencent-hy3"] = "hy3"
	service := NewService(store, &fakeFetcher{catalog: loadFixtureCatalog(t)}, nil)
	if _, err := service.SyncOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	first := append([]ModelPrice(nil), store.prices...)
	if _, err := service.SyncOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	for i, row := range store.prices {
		a, _ := EncodeTiers(first[i].Tiers)
		b, _ := EncodeTiers(row.Tiers)
		if a != b || row.PromptPricePer1M != first[i].PromptPricePer1M || row.UpstreamID != first[i].UpstreamID {
			t.Fatalf("second sync changed %s:\n%+v\n%+v", row.Model, first[i], row)
		}
	}
}

func TestLinkedModelFollowsPin(t *testing.T) {
	store := newFakeStore("claude-opus-5.5")
	service := NewService(store, &fakeFetcher{catalog: loadFixtureCatalog(t)}, nil)
	if _, err := service.SyncOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	row, err := service.SetModelMode(context.Background(), ModeChange{Model: "claude-opus-5.5", Mode: ModeLinked, UpstreamID: "anthropic/claude-sonnet-5", Multiplier: 1})
	if err != nil {
		t.Fatal(err)
	}
	if row.UpstreamID != "anthropic/claude-sonnet-5" || row.MatchKind != MatchLinked || row.PromptPricePer1M != 2 {
		t.Fatalf("link not applied: %+v", row)
	}
	if _, err := service.SyncOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	after, _ := store.price("claude-opus-5.5")
	if after.UpstreamID != "anthropic/claude-sonnet-5" {
		t.Fatalf("sync replaced a pinned model with its own match: %+v", after)
	}
	prices, _ := service.ListPrices(context.Background())
	if len(prices) != 1 || prices[0].Mode != ModeLinked {
		t.Fatalf("mode not derived: %+v", prices)
	}
	if _, err := service.SetModelMode(context.Background(), ModeChange{Model: "claude-opus-5.5", Mode: ModeLinked, UpstreamID: "nobody/nothing"}); !errors.Is(err, ErrUpstreamNotFound) {
		t.Fatalf("unknown pin accepted: %v", err)
	}
}

func TestModeSwitchesAreSingleWrites(t *testing.T) {
	store := newFakeStore("claude-opus-5.5", "gpt-5.4-mini-high")
	service := NewService(store, &fakeFetcher{catalog: loadFixtureCatalog(t)}, nil)
	if _, err := service.SyncOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	custom := ModelPrice{PromptPricePer1M: 1, CompletionPer1M: 2, Tiers: []PriceTier{{MinPromptTokens: 1000, PromptPricePer1M: ptr(3.0)}}}
	if _, err := service.SetModelMode(context.Background(), ModeChange{Model: "claude-opus-5.5", Mode: ModeCustom, Price: custom, Multiplier: 1}); err != nil {
		t.Fatal(err)
	}
	row, _ := store.price("claude-opus-5.5")
	if row.Source != SourceManual || row.PromptPricePer1M != 1 || len(row.Tiers) != 1 {
		t.Fatalf("custom not stored: %+v", row)
	}
	// Back to automatic: the custom row is replaced in one write.
	applied := len(store.applied)
	if _, err := service.SetModelMode(context.Background(), ModeChange{Model: "claude-opus-5.5", Mode: ModeAuto}); err != nil {
		t.Fatal(err)
	}
	row, _ = store.price("claude-opus-5.5")
	if row.Source != SourceOpenRouter || row.PromptPricePer1M != 4 || len(store.applied) != applied+1 {
		t.Fatalf("auto switch: %+v", row)
	}
	if _, err := service.SetModelMode(context.Background(), ModeChange{Model: "gpt-5.4-mini-high", Mode: ModeAuto}); !errors.Is(err, ErrNoAutomaticMatch) {
		t.Fatalf("an unmatched auto switch must be refused: %v", err)
	}
	if _, err := service.SetModelMode(context.Background(), ModeChange{Model: "not-configured", Mode: ModeCustom, Price: custom}); !errors.Is(err, ErrModelNotInCatalog) {
		t.Fatalf("a model outside the catalog was priced: %v", err)
	}
	if _, err := service.SetModelMode(context.Background(), ModeChange{Model: "claude-opus-5.5", Mode: "bogus"}); !errors.Is(err, ErrInvalidMode) {
		t.Fatalf("an unknown mode was accepted: %v", err)
	}
}

// An operator link set while the download is in flight is re-read under the
// write lock, so the sync cannot overwrite it with its own match.
func TestSyncHonoursLinkSetDuringDownload(t *testing.T) {
	store := newFakeStore("claude-opus-5.5")
	catalog := loadFixtureCatalog(t)
	store.upstream = catalog.Models
	fetcher := &blockingFetcher{catalog: catalog, started: make(chan struct{}), release: make(chan struct{})}
	service := NewService(store, fetcher, nil)
	done := make(chan error, 1)
	go func() {
		_, err := service.SyncOnce(context.Background())
		done <- err
	}()
	<-fetcher.started
	if _, err := service.SetModelMode(context.Background(), ModeChange{Model: "claude-opus-5.5", Mode: ModeLinked, UpstreamID: "anthropic/claude-sonnet-5"}); err != nil {
		t.Fatal(err)
	}
	close(fetcher.release)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	row, _ := store.price("claude-opus-5.5")
	if row.UpstreamID != "anthropic/claude-sonnet-5" {
		t.Fatalf("sync overwrote a link set during its download: %+v", row)
	}
}

type blockingFetcher struct {
	catalog          Catalog
	started, release chan struct{}
	once             sync.Once
	calls            int
}

func (f *blockingFetcher) Fetch(ctx context.Context) (Catalog, error) {
	f.calls++
	f.once.Do(func() {
		close(f.started)
		select {
		case <-f.release:
		case <-ctx.Done():
		}
	})
	return f.catalog, ctx.Err()
}

func TestCatalogSyncRejectsEmptyAuthoritativeSnapshot(t *testing.T) {
	store := newFakeStore("claude-opus-5.5")
	store.prices = []ModelPrice{{Model: "claude-opus-5.5", PromptPricePer1M: 2, PriceMultiplier: 1, Source: SourceOpenRouter}}
	svc := NewService(store, &fakeFetcher{catalog: loadFixtureCatalog(t)}, nil)
	svc.SetModelLister(&catalogLister{models: map[string]string{}})
	if _, err := svc.SyncOnce(context.Background()); err == nil {
		t.Fatal("empty catalog snapshot was accepted")
	}
	if len(store.models) != 1 || len(store.prices) != 1 || store.prices[0].PromptPricePer1M != 2 {
		t.Fatalf("empty snapshot pruned the previous catalog or prices: %v %+v", store.models, store.prices)
	}
}

func TestAliasPricingAndCatalogReadsAreLocal(t *testing.T) {
	store := newFakeStore()
	lister := &catalogLister{models: map[string]string{"my-friendly-alias": "claude-opus-5.5", "conflicting-alias": ""}}
	fetcher := &fakeFetcher{catalog: loadFixtureCatalog(t)}
	svc := NewService(store, fetcher, nil)
	svc.SetModelLister(lister)
	if _, err := svc.SyncOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	alias, ok := store.price("my-friendly-alias")
	if !ok || alias.PromptPricePer1M != 4 {
		t.Fatalf("wrong alias price: %+v", store.prices)
	}
	for i := 0; i < 10; i++ {
		if _, err := svc.ListPrices(context.Background()); err != nil {
			t.Fatal(err)
		}
		if _, err := svc.UsedUnpricedModels(context.Background(), 0); err != nil {
			t.Fatal(err)
		}
		if _, err := svc.Suggestions(context.Background(), "conflicting-alias", 3); err != nil {
			t.Fatal(err)
		}
		if _, err := svc.StoredCatalog(context.Background()); err != nil {
			t.Fatal(err)
		}
	}
	if lister.calls != 1 || fetcher.calls != 1 {
		t.Fatalf("console reads reached CPA %d times and OpenRouter %d times", lister.calls, fetcher.calls)
	}
}

// A new CPA model found by catalog reconciliation is priced from the stored
// snapshot without waiting for the next scheduled download.
func TestNewModelPricedFromStoredSnapshot(t *testing.T) {
	store := newFakeStore("claude-opus-5.5")
	store.upstream = loadFixtureCatalog(t).Models
	fetcher := &fakeFetcher{err: errors.New("offline")}
	svc := NewService(store, fetcher, nil)
	svc.SetModelLister(&fakeModelLister{models: []string{"claude-opus-5.5", "glm-5.3"}})
	if _, err := svc.syncOnce(context.Background(), false); err != nil {
		t.Fatal(err)
	}
	if _, ok := store.price("glm-5.3"); !ok || fetcher.calls != 0 {
		t.Fatalf("new model not priced offline (fetches=%d): %+v", fetcher.calls, store.prices)
	}
}

func TestConfigChangeDuringSyncIsReconciled(t *testing.T) {
	store := newFakeStore()
	fetcher := &blockingFetcher{catalog: loadFixtureCatalog(t), started: make(chan struct{}), release: make(chan struct{})}
	lister := &changingLister{}
	svc := NewService(store, fetcher, nil)
	svc.SetModelLister(lister)
	svc.NotifyModelsChanged()
	select {
	case <-fetcher.started:
	case <-time.After(2 * time.Second):
		t.Fatal("sync did not start")
	}
	for i := 0; i < 20; i++ {
		svc.NotifyModelsChanged()
	}
	close(fetcher.release)
	deadline := time.Now().Add(3 * time.Second)
	for svc.IsRunning() && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if svc.IsRunning() {
		t.Fatal("sync never finished")
	}
	if lister.calls != 2 || fetcher.calls != 1 {
		t.Fatalf("notification lost/not coalesced or catalog refetched: catalog=%d fetch=%d", lister.calls, fetcher.calls)
	}
	if _, ok := store.models["claude-sonnet-5"]; !ok || len(store.models) != 1 {
		t.Fatalf("last config not applied: %v", store.models)
	}
}

type changingLister struct{ calls int }

func (l *changingLister) ListConfiguredModels(context.Context) ([]string, error) {
	l.calls++
	if l.calls == 1 {
		return []string{"claude-opus-5.5"}, nil
	}
	return []string{"claude-sonnet-5"}, nil
}

func TestSuggestionsLeadWithTheAutomaticMatch(t *testing.T) {
	store := newFakeStore("claude-opus-5.5", "gpt-5.4-mini-high")
	store.upstream = loadFixtureCatalog(t).Models
	svc := NewService(store, &fakeFetcher{}, nil)
	matched, err := svc.Suggestions(context.Background(), "claude-opus-5.5", 3)
	if err != nil || len(matched) == 0 || matched[0].ID != "anthropic/claude-opus-5.5" {
		t.Fatalf("matched suggestions: %+v %v", matched, err)
	}
	if match, ok, err := svc.AutomaticMatch(context.Background(), "claude-opus-5.5"); err != nil || !ok || match.Model.ID != "anthropic/claude-opus-5.5" {
		t.Fatalf("automatic match: %+v %v %v", match, ok, err)
	}
	if _, ok, _ := svc.AutomaticMatch(context.Background(), "gpt-5.4-mini-high"); ok {
		t.Fatal("a resembling model must not match automatically")
	}
	resembling, _ := svc.Suggestions(context.Background(), "gpt-5.4-mini-high", 3)
	if len(resembling) == 0 || resembling[0].ID != "openai/gpt-5.4-mini" {
		t.Fatalf("resembling suggestions: %+v", resembling)
	}
}

func TestChannelMultipliers(t *testing.T) {
	store := newFakeStore()
	svc := NewService(store, &fakeFetcher{}, nil)
	if _, err := svc.SetChannel(context.Background(), ChannelMultiplier{Channel: " relay ", Multiplier: 0.3, Note: "resells at 30%"}); err != nil {
		t.Fatal(err)
	}
	for _, bad := range []ChannelMultiplier{{Channel: "", Multiplier: 1}, {Channel: "x", Multiplier: 0}, {Channel: "x", Multiplier: 101}} {
		if _, err := svc.SetChannel(context.Background(), bad); err == nil {
			t.Fatalf("invalid channel accepted: %+v", bad)
		}
	}
	channels, _ := svc.ListChannels(context.Background())
	if len(channels) != 1 || channels[0].Channel != "relay" || channels[0].Multiplier != 0.3 {
		t.Fatalf("channels: %+v", channels)
	}
	if deleted, _ := svc.DeleteChannel(context.Background(), "relay"); !deleted {
		t.Fatal("channel not deleted")
	}
}

func TestSyncStateViewNeverSynced(t *testing.T) {
	service := NewService(newFakeStore(), &fakeFetcher{}, nil)
	state, known, err := service.SyncStateView(context.Background())
	if err != nil || known {
		t.Fatalf("unexpected: state=%+v known=%v err=%v", state, known, err)
	}
	if state.Source != SourceOpenRouter || state.AutoSyncIntervalHours != 24 {
		t.Fatalf("defaults: %+v", state)
	}
}

func TestTriggerSyncRunsOnce(t *testing.T) {
	store := newFakeStore("claude-opus-5.5")
	service := NewService(store, &fakeFetcher{catalog: loadFixtureCatalog(t)}, nil)
	if !service.TriggerSync() {
		t.Fatal("first trigger should start")
	}
	if service.TriggerSync() {
		t.Fatal("second concurrent trigger should be refused")
	}
	deadline := time.Now().Add(2 * time.Second)
	for service.IsRunning() && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if _, ok := store.price("claude-opus-5.5"); !ok {
		t.Fatal("background sync never wrote prices")
	}
}

func TestUsedUnpricedModelsHonoursLimit(t *testing.T) {
	store := newFakeStore("a-model", "b-model", "c-model")
	service := NewService(store, &fakeFetcher{}, nil)
	unpriced, err := service.UsedUnpricedModels(context.Background(), 2)
	if err != nil || len(unpriced) != 2 || unpriced[0] != "a-model" {
		t.Fatalf("unpriced: %v %v", unpriced, err)
	}
}

func TestCatalogReconciliationPreservesFailedRefresh(t *testing.T) {
	store := newFakeStore("glm-5.3")
	store.upstream = loadFixtureCatalog(t).Models
	store.state = SyncState{Source: SourceOpenRouter, LastError: "upstream unavailable"}
	store.stateKnown = true
	service := NewService(store, &fakeFetcher{catalog: loadFixtureCatalog(t)}, nil)
	if _, err := service.syncOnce(context.Background(), false); err != nil {
		t.Fatal(err)
	}
	if len(store.saved) != 0 || store.state.LastError != "upstream unavailable" {
		t.Fatalf("local reconciliation erased upstream failure: %+v", store.state)
	}
	if _, err := service.SyncOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	if store.state.LastError != "" || store.state.LastSuccessAtMS == nil {
		t.Fatalf("successful refresh did not clear failure: %+v", store.state)
	}
}

func TestSuggestionsReuseLocalCatalog(t *testing.T) {
	store := newFakeStore("glm-5.3")
	store.upstream = loadFixtureCatalog(t).Models
	service := NewService(store, &fakeFetcher{err: errors.New("offline")}, nil)
	first, err := service.Suggestions(context.Background(), "glm-5.3", 3)
	if err != nil || len(first) == 0 {
		t.Fatalf("first suggestions: %v %v", first, err)
	}
	store.upstream = nil
	second, err := service.Suggestions(context.Background(), "glm-5.3", 3)
	if err != nil || len(second) != len(first) || second[0].ID != first[0].ID {
		t.Fatalf("cached suggestions lost: %v %v", second, err)
	}
}
