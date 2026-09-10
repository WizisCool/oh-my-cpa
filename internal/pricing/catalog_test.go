package pricing

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestCatalogSyncPreservesManualAndMissingMetadata(t *testing.T) {
	store := &fakeStore{models: []string{"openai/gpt-5", "metadata-omission", "obsolete"}, prices: []ModelPrice{
		{Model: "openai/gpt-5", PromptPricePer1M: 99, PriceMultiplier: 1, Source: SourceManual},
		{Model: "metadata-omission", PromptPricePer1M: 7, PriceMultiplier: 1, Source: SourceModelsDev},
		{Model: "obsolete", PromptPricePer1M: 8, PriceMultiplier: 1, Source: SourceModelsDev},
	}}
	svc := NewService(store, &fakeFetcher{catalog: catalogFixture()}, nil)
	svc.SetModelLister(&fakeModelLister{models: []string{"openai/gpt-5", "metadata-omission", "new-unknown"}})
	if _, err := svc.SyncOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	rows, err := svc.ListPrices(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 2 || rows[0].PromptPricePer1M != 99 || rows[1].PromptPricePer1M != 7 {
		t.Fatalf("known/manual prices lost: %+v", rows)
	}
	missing, err := svc.UsedUnpricedModels(context.Background(), 0)
	if err != nil || len(missing) != 1 || missing[0] != "new-unknown" {
		t.Fatalf("catalog hints %v %v", missing, err)
	}
	svc.SetModelLister(&fakeModelLister{err: errors.New("partial CPA failure")})
	if _, err := svc.SyncOnce(context.Background()); err == nil {
		t.Fatal("partial catalog accepted")
	}
	rows, _ = svc.ListPrices(context.Background())
	if len(rows) != 2 {
		t.Fatal("failure pruned last complete snapshot")
	}
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
func TestAliasPricingAndCatalogReadsAreLocal(t *testing.T) {
	store := &fakeStore{}
	lister := &catalogLister{models: map[string]string{"my-friendly-alias": "openai/gpt-5", "conflicting-alias": ""}}
	svc := NewService(store, &fakeFetcher{catalog: catalogFixture()}, nil)
	svc.SetModelLister(lister)
	if _, err := svc.SyncOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(store.upserted) != 1 || store.upserted[0].Model != "my-friendly-alias" || store.upserted[0].PromptPricePer1M != 2 {
		t.Fatalf("wrong alias price: %+v", store.upserted)
	}
	for i := 0; i < 10; i++ {
		if _, err := svc.ListPrices(context.Background()); err != nil {
			t.Fatal(err)
		}
		if _, err := svc.UsedUnpricedModels(context.Background(), 0); err != nil {
			t.Fatal(err)
		}
	}
	if lister.calls != 1 {
		t.Fatalf("UI reads fetched CPA %d times", lister.calls)
	}
}

type blockingPriceFetcher struct {
	started, release chan struct{}
	calls            int
}

func (f *blockingPriceFetcher) Fetch(ctx context.Context) (Catalog, error) {
	f.calls++
	if f.calls == 1 {
		close(f.started)
		select {
		case <-f.release:
		case <-ctx.Done():
			return Catalog{}, ctx.Err()
		}
	}
	return catalogFixture(), nil
}

type changingLister struct{ calls int }

func (l *changingLister) ListConfiguredModels(context.Context) ([]string, error) {
	l.calls++
	if l.calls == 1 {
		return []string{"openai/gpt-5"}, nil
	}
	return []string{"claude-sonnet-5"}, nil
}
func TestConfigChangeDuringSyncIsReconciledWithCachedMetadata(t *testing.T) {
	store := &fakeStore{}
	f := &blockingPriceFetcher{started: make(chan struct{}), release: make(chan struct{})}
	l := &changingLister{}
	svc := NewService(store, f, nil)
	svc.SetModelLister(l)
	svc.NotifyModelsChanged()
	select {
	case <-f.started:
	case <-time.After(time.Second):
		t.Fatal("sync did not start")
	}
	for i := 0; i < 20; i++ {
		svc.NotifyModelsChanged()
	}
	close(f.release)
	deadline := time.Now().Add(3 * time.Second)
	for svc.IsRunning() && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if svc.IsRunning() {
		t.Fatal("sync never finished")
	}
	if l.calls != 2 || f.calls != 1 {
		t.Fatalf("notification lost/not coalesced or metadata refetched: catalog=%d fetch=%d", l.calls, f.calls)
	}
	if len(store.models) != 1 || store.models[0] != "claude-sonnet-5" {
		t.Fatalf("last config not applied: %v", store.models)
	}
}
