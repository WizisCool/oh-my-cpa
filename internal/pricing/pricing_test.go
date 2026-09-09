package pricing

import (
	"context"
	"database/sql"
	"errors"
	"math"
	"strings"
	"testing"
	"time"
)

func TestCostUSDCalculatesAndClamps(t *testing.T) {
	price := ModelPrice{
		PromptPricePer1M: 3, CompletionPer1M: 15,
		CacheReadPer1M: 0.3, CacheWritePer1M: 3.75,
		PriceMultiplier: 1.2,
	}
	// 1M uncached input + 1M output + 1M read + 1M write, times 1.2.
	got := price.CostUSD(1_000_000, 1_000_000, 1_000_000, 1_000_000)
	want := (0 + 15 + 0.3 + 3.75) * 1.2
	if math.Abs(got-want) > 1e-9 {
		t.Fatalf("CostUSD = %v, want %v", got, want)
	}
	// Telemetry with cached > input must not go negative.
	if got := price.CostUSD(100, 0, 900, 0); got < 0 {
		t.Fatalf("CostUSD = %v, want non-negative", got)
	}
}

func TestModelPriceValidate(t *testing.T) {
	valid := func() ModelPrice { return ModelPrice{Model: "gpt-x", PriceMultiplier: 1} }
	row := valid()
	if err := row.Validate(); err != nil {
		t.Fatalf("valid row rejected: %v", err)
	}
	negative := valid()
	negative.PromptPricePer1M = -1
	if err := negative.Validate(); err == nil {
		t.Fatal("negative price accepted")
	}
	badMultiplier := valid()
	badMultiplier.PriceMultiplier = 0
	if err := badMultiplier.Validate(); err == nil {
		t.Fatal("zero multiplier accepted")
	}
	nan := valid()
	nan.CacheReadPer1M = math.NaN()
	if err := nan.Validate(); err == nil {
		t.Fatal("NaN price accepted")
	}
	unknownSource := valid()
	unknownSource.Source = "whatever"
	if err := unknownSource.Validate(); err == nil {
		t.Fatal("unknown source accepted")
	}
}

func catalogFixture() Catalog {
	entry := func(provider, id string, input float64) CatalogEntry {
		in := input
		out := input * 3
		return CatalogEntry{ProviderID: provider, Model: MetadataModel{ID: id, Cost: MetadataCost{Input: &in, Output: &out}}}
	}
	return Catalog{Entries: []CatalogEntry{
		entry("openai", "gpt-5", 2),
		entry("anthropic", "claude-sonnet-5", 3),
		entry("aggregator", "claude-sonnet-5", 99),
		entry("acme", "totally-unique-model", 7),
	}}
}

func TestMatchModelPrefersOfficialFamily(t *testing.T) {
	catalog := catalogFixture()
	entry := catalog.MatchModel("claude-sonnet-5")
	if entry == nil {
		t.Fatal("expected a match for claude-sonnet-5")
	}
	if entry.ProviderID != "anthropic" {
		t.Fatalf("official family preferred: got provider %q", entry.ProviderID)
	}
}

func TestMatchModelStripsProviderPrefix(t *testing.T) {
	catalog := catalogFixture()
	if entry := catalog.MatchModel("openai/gpt-5"); entry == nil || entry.ProviderID != "openai" {
		t.Fatalf("prefix strip failed: %+v", entry)
	}
}

func TestMatchModelAmbiguousStaysUnpriced(t *testing.T) {
	catalog := Catalog{Entries: []CatalogEntry{
		{ProviderID: "acme", Model: MetadataModel{ID: "shared-name"}},
		{ProviderID: "beta", Model: MetadataModel{ID: "shared-name"}},
	}}
	if entry := catalog.MatchModel("shared-name"); entry != nil {
		t.Fatalf("ambiguous match must be nil, got %+v", entry)
	}
}

func TestDecodeCatalog(t *testing.T) {
	body := []byte(`{"openai":{"id":"openai","name":"OpenAI","models":{"gpt-5":{"id":"gpt-5","cost":{"input":1.25,"output":10}}}}}`)
	entries, err := DecodeCatalog(body)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || entries[0].ProviderID != "openai" || entries[0].Model.ID != "gpt-5" {
		t.Fatalf("unexpected entries: %+v", entries)
	}
	if entries[0].Model.Cost.Input == nil || *entries[0].Model.Cost.Input != 1.25 {
		t.Fatalf("cost not decoded: %+v", entries[0].Model.Cost)
	}
}

type fakeStore struct {
	prices     []ModelPrice
	upserted   []ModelPrice
	deleted    []string
	saved      []SyncState
	models     []string
	state      SyncState
	stateKnown bool
}

func (s *fakeStore) ListModelPrices(context.Context) ([]ModelPrice, error) { return s.prices, nil }
func (s *fakeStore) UpsertModelPrices(_ context.Context, rows []ModelPrice) error {
	s.upserted = append(s.upserted, rows...)
	s.prices = append(s.prices, rows...)
	return nil
}
func (s *fakeStore) DeleteModelPrice(_ context.Context, model string) (bool, error) {
	s.deleted = append(s.deleted, model)
	return true, nil
}
func (s *fakeStore) ListEffectiveModels(context.Context) ([]string, error) { return s.models, nil }
func (s *fakeStore) GetPricingSyncState(context.Context, string) (SyncState, error) {
	if !s.stateKnown {
		return SyncState{}, sql.ErrNoRows
	}
	return s.state, nil
}
func (s *fakeStore) SavePricingSyncState(_ context.Context, state SyncState) error {
	s.saved = append(s.saved, state)
	s.state = state
	s.stateKnown = true
	return nil
}

type fakeFetcher struct {
	catalog Catalog
	err     error
}

func (f *fakeFetcher) Fetch(context.Context) (Catalog, error) { return f.catalog, f.err }

func TestSyncOnceCreatesAutoRowsAndProtectsManual(t *testing.T) {
	store := &fakeStore{models: []string{"openai/gpt-5", "totally-unknown-model"}}
	store.prices = []ModelPrice{
		{Model: "openai/gpt-5", PriceMultiplier: 2, Source: SourceModelsDev},
		{Model: "manual-only", PromptPricePer1M: 5, PriceMultiplier: 1, Source: SourceManual},
	}
	service := NewService(store, &fakeFetcher{catalog: catalogFixture()}, nil)
	result, err := service.SyncOnce(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if result.Matched != 1 || result.Unmatched != 1 {
		t.Fatalf("unexpected result: %+v", result)
	}
	// Manual rows are not in the upsert batch and multipliers survive sync.
	for _, row := range store.upserted {
		if row.Source == SourceManual {
			t.Fatalf("manual row got overwritten: %+v", row)
		}
		if row.Model == "openai/gpt-5" && row.PriceMultiplier != 2 {
			t.Fatalf("multiplier lost: %+v", row)
		}
	}
}

func TestSyncOnceFailureKeepsLastGoodPrices(t *testing.T) {
	store := &fakeStore{models: []string{"openai/gpt-5"}}
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

// Auto rows for models that left the traffic scope are pruned on the next
// sync; manual rows are never touched by pruning.
func TestSyncOncePrunesAutoRowsOutsideTraffic(t *testing.T) {
	store := &fakeStore{models: []string{"openai/gpt-5"}}
	store.prices = []ModelPrice{
		{Model: "stale/catalog-model", PromptPricePer1M: 1, PriceMultiplier: 1, Source: SourceModelsDev},
		{Model: "manual-keep", PromptPricePer1M: 5, PriceMultiplier: 1, Source: SourceManual},
	}
	service := NewService(store, &fakeFetcher{catalog: catalogFixture()}, nil)
	result, err := service.SyncOnce(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if result.Pruned != 1 {
		t.Fatalf("pruned = %d, want 1", result.Pruned)
	}
	if len(store.deleted) != 1 || store.deleted[0] != "stale/catalog-model" {
		t.Fatalf("stale auto row not pruned: deleted=%v", store.deleted)
	}
	manualSurvived := false
	for _, row := range store.prices {
		if row.Model == "manual-keep" && row.Source == SourceManual {
			manualSurvived = true
		}
	}
	if !manualSurvived {
		t.Fatal("manual row must survive pruning")
	}
}
func TestSaveManualPricesForcesManualSource(t *testing.T) {
	store := &fakeStore{}
	service := NewService(store, &fakeFetcher{}, nil)
	rows := []ModelPrice{{Model: "acme/totally-unique-model", PromptPricePer1M: 7, PriceMultiplier: 1, Source: SourceModelsDev, SyncedAtMS: 123}}
	if err := service.SaveManualPrices(context.Background(), rows); err != nil {
		t.Fatal(err)
	}
	if store.upserted[0].Source != SourceManual || store.upserted[0].SyncedAtMS != 0 {
		t.Fatalf("manual rows must be manual with cleared sync stamp: %+v", store.upserted[0])
	}
}

func TestSyncStateViewNeverSynced(t *testing.T) {
	store := &fakeStore{}
	service := NewService(store, &fakeFetcher{}, nil)
	state, known, err := service.SyncStateView(context.Background())
	if err != nil || known {
		t.Fatalf("unexpected: state=%+v known=%v err=%v", state, known, err)
	}
	if state.Source != SourceModelsDev {
		t.Fatalf("source should default to models.dev: %+v", state)
	}
}

func TestTriggerSyncRunsOnce(t *testing.T) {
	store := &fakeStore{models: []string{"openai/gpt-5"}}
	service := NewService(store, &fakeFetcher{catalog: catalogFixture()}, nil)
	if !service.TriggerSync() {
		t.Fatal("first trigger should start")
	}
	if service.TriggerSync() {
		t.Fatal("second concurrent trigger should be refused")
	}
	deadline := time.Now().Add(2 * time.Second)
	for len(store.upserted) == 0 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if len(store.upserted) == 0 {
		t.Fatal("background sync never wrote prices")
	}
}
