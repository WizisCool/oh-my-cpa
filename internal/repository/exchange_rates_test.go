package repository

import (
	"context"
	"errors"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/oh-my-cpa/oh-my-cpa/internal/exchangerate"
)

type exchangeFetcher struct {
	rates []exchangerate.Rate
	err   error
}

func (f *exchangeFetcher) Fetch(context.Context) ([]exchangerate.Rate, error) { return f.rates, f.err }

func TestExchangeRateCacheSurvivesRefreshFailureAndRestart(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "rates.db")
	db, err := Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	repo := New(db)
	empty, err := repo.ReadExchangeRates(ctx)
	if err != nil || len(empty.Rates) != 0 || empty.UpdatedAtMS != 0 {
		t.Fatalf("fresh cache: %+v, %v", empty, err)
	}
	fetcher := &exchangeFetcher{rates: []exchangerate.Rate{{Currency: "CNY", Rate: 6.7, Date: "2026-10-27"}, {Currency: "MYR", Rate: 4.1, Date: "2026-10-27"}}}
	service := exchangerate.NewService(repo, fetcher, nil)
	first, err := service.Refresh(ctx)
	if err != nil {
		t.Fatal(err)
	}
	fetcher.err = errors.New("offline")
	if _, err = service.Refresh(ctx); !errors.Is(err, exchangerate.ErrFetchFailed) {
		t.Fatalf("refresh failure: %v", err)
	}
	if err = db.Close(); err != nil {
		t.Fatal(err)
	}
	db, err = Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	repo = New(db)
	cached, err := repo.ReadExchangeRates(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(cached.Rates, first.Rates) || cached.UpdatedAtMS != first.UpdatedAtMS || cached.LastError != exchangerate.ErrFetchFailed.Error() {
		t.Fatalf("lost cached rates across restart: %+v", cached)
	}
	fetcher.err = nil
	fetcher.rates = []exchangerate.Rate{{Currency: "EUR", Rate: .9, Date: "2026-10-28"}}
	service = exchangerate.NewService(repo, fetcher, nil)
	next, err := service.Refresh(ctx)
	if err != nil {
		t.Fatal(err)
	}
	saved, err := repo.ReadExchangeRates(ctx)
	if err != nil || !reflect.DeepEqual(saved, next) || len(saved.Rates) != 1 || saved.LastError != "" {
		t.Fatalf("successful refresh did not replace the entire snapshot: %+v %v", saved, err)
	}
}
