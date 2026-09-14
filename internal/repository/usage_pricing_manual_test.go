package repository

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"testing"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/pricing"
	"github.com/oh-my-cpa/oh-my-cpa/internal/usage"
)

// countingFetcher fails the test if a price sync ever reaches the metadata
// source. A manual edit must take effect on its own; if pricing depended on a
// sync, the operator would have to click "sync now" before costs appeared.
type countingFetcher struct{ calls int }

func (f *countingFetcher) Fetch(context.Context) (pricing.Catalog, error) {
	f.calls++
	return pricing.Catalog{}, errors.New("pricing metadata must not be fetched")
}

func manualPriceService(t *testing.T, r *Repository, fetcher pricing.Fetcher) *pricing.Service {
	t.Helper()
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	service := pricing.NewService(r, fetcher, logger)
	if _, err := r.ReplacePricingModels(context.Background(), map[string]string{"priced-model": "priced-model"}); err != nil {
		t.Fatal(err)
	}
	return service
}

func effectiveVersionID(t *testing.T, r *Repository, model string) int64 {
	t.Helper()
	var id int64
	if err := r.SQL().QueryRow(
		`SELECT id FROM model_price_versions WHERE model=? ORDER BY effective_from_ms DESC, id DESC LIMIT 1`, model,
	).Scan(&id); err != nil {
		t.Fatal(err)
	}
	return id
}

// A manual price must price later requests with no synchronization involved, and
// must record the version id that produced the amount so the snapshot is
// auditable.
func TestManualPricePricesLaterRequestsWithoutSync(t *testing.T) {
	r := usageTestRepository(t)
	ctx := context.Background()
	fetcher := &countingFetcher{}
	service := manualPriceService(t, r, fetcher)

	const model = "priced-model"
	if err := service.SaveManualPrices(ctx, []pricing.ModelPrice{{
		Model: model, PromptPricePer1M: 2, CompletionPer1M: 0, PriceMultiplier: 1,
	}}); err != nil {
		t.Fatal(err)
	}
	versionID := effectiveVersionID(t, r, model)

	// One million input tokens at $2 / 1M is exactly $2 in USD nanos.
	at := time.Now().UnixMilli()
	rowID, err := r.InsertUsageEvents(ctx, []usage.Event{{
		InstanceID: "default", EventKey: "after-manual", Model: model,
		TimestampMS: at, InputTokens: 1_000_000,
	}})
	if err != nil {
		t.Fatal(err)
	}
	row, err := r.GetUsageEvent(ctx, rowID)
	if err != nil {
		t.Fatal(err)
	}
	if row.CostUSD == nil || *row.CostUSD != 2 || row.PricingStatus != "priced" {
		t.Fatalf("manual price not applied: %+v", row)
	}
	if row.PriceVersionID == nil || *row.PriceVersionID != versionID {
		t.Fatalf("snapshot version = %v, want %d", row.PriceVersionID, versionID)
	}
	if fetcher.calls != 0 {
		t.Fatalf("manual edit triggered %d metadata fetches", fetcher.calls)
	}
}

// The effective timestamp is the boundary. A request stamped before it must stay
// unpriced even when the row is written afterwards, because the insert selects
// by request time rather than ingestion time.
func TestManualPriceBoundaryAndDelayedIngestion(t *testing.T) {
	r := usageTestRepository(t)
	ctx := context.Background()
	service := manualPriceService(t, r, &countingFetcher{})

	const model = "priced-model"
	if err := service.SaveManualPrices(ctx, []pricing.ModelPrice{{
		Model: model, PromptPricePer1M: 1, CompletionPer1M: 0, PriceMultiplier: 1,
	}}); err != nil {
		t.Fatal(err)
	}
	var effective int64
	if err := r.SQL().QueryRow(
		`SELECT effective_from_ms FROM model_price_versions WHERE model=? ORDER BY effective_from_ms DESC, id DESC LIMIT 1`, model,
	).Scan(&effective); err != nil {
		t.Fatal(err)
	}

	cases := []struct {
		name        string
		requestedAt int64
		wantCost    bool
	}{
		{"one millisecond before the version", effective - 1, false},
		{"exactly at the version", effective, true},
		{"after the version", effective + 1, true},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			// Ingested long after the request; only the request timestamp decides.
			key := "delayed-" + testCase.name
			rowID, err := r.InsertUsageEvents(ctx, []usage.Event{{
				InstanceID: "default", EventKey: key, Model: model,
				TimestampMS: testCase.requestedAt, InputTokens: 1_000_000,
			}})
			if err != nil {
				t.Fatal(err)
			}
			row, err := r.GetUsageEvent(ctx, rowID)
			if err != nil {
				t.Fatal(err)
			}
			if testCase.wantCost {
				if row.CostUSD == nil || *row.CostUSD != 1 || row.PricingStatus != "priced" {
					t.Fatalf("expected a locked cost: %+v", row)
				}
				return
			}
			if row.CostUSD != nil || row.PricingStatus != "unpriced" || row.PriceVersionID != nil {
				t.Fatalf("a pre-version request must stay unpriced: %+v", row)
			}
		})
	}
}

// Both ingestion entry points must select the same request-time rate.
func TestManualPriceAppliesOnBothInsertPaths(t *testing.T) {
	r := usageTestRepository(t)
	ctx := context.Background()
	service := manualPriceService(t, r, &countingFetcher{})

	const model = "priced-model"
	if err := service.SaveManualPrices(ctx, []pricing.ModelPrice{{
		Model: model, PromptPricePer1M: 3, CompletionPer1M: 0, PriceMultiplier: 1,
	}}); err != nil {
		t.Fatal(err)
	}
	versionID := effectiveVersionID(t, r, model)
	at := time.Now().UnixMilli()

	directID, err := r.InsertUsageEvents(ctx, []usage.Event{{
		InstanceID: "default", EventKey: "direct", Model: model,
		TimestampMS: at, InputTokens: 1_000_000,
	}})
	if err != nil {
		t.Fatal(err)
	}

	if _, err := r.AppendUsageInbox(ctx, "default", "http_pull", []string{`{"request_id":"decoded"}`}, time.Now()); err != nil {
		t.Fatal(err)
	}
	batch, err := r.ClaimUsageInboxBatch(ctx, 10)
	if err != nil || len(batch) != 1 {
		t.Fatalf("claim inbox: %d %v", len(batch), err)
	}
	if _, err := r.CommitUsageDecoded(ctx, []UsageDecoded{{
		InboxID: batch[0].ID,
		Event: usage.Event{
			InstanceID: "default", EventKey: "decoded", Model: model,
			TimestampMS: at, InputTokens: 1_000_000,
		},
	}}); err != nil {
		t.Fatal(err)
	}

	var decodedID int64
	if err := r.SQL().QueryRow(`SELECT id FROM usage_events WHERE event_key='decoded'`).Scan(&decodedID); err != nil {
		t.Fatal(err)
	}
	for _, rowID := range []int64{directID, decodedID} {
		row, err := r.GetUsageEvent(ctx, rowID)
		if err != nil {
			t.Fatal(err)
		}
		if row.CostUSD == nil || *row.CostUSD != 3 || row.PricingStatus != "priced" {
			t.Fatalf("row %d not priced: %+v", rowID, row)
		}
		if row.PriceVersionID == nil || *row.PriceVersionID != versionID {
			t.Fatalf("row %d version = %v, want %d", rowID, row.PriceVersionID, versionID)
		}
	}
}

// Price bookkeeping is server-authoritative: a manual row is shown as updated at
// the moment the server stored it, never at a time the browser supplied.
func TestManualPriceUpdateTimeIsServerAuthoritative(t *testing.T) {
	r := usageTestRepository(t)
	ctx := context.Background()
	service := manualPriceService(t, r, &countingFetcher{})

	cases := []struct {
		name       string
		clientTime int64
	}{
		{"client clock far in the past", time.Date(2001, 1, 1, 0, 0, 0, 0, time.UTC).UnixMilli()},
		{"client clock far in the future", time.Date(2100, 1, 1, 0, 0, 0, 0, time.UTC).UnixMilli()},
		{"client sent no timestamp", 0},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			before := time.Now().UnixMilli()
			const model = "priced-model"
			if err := service.SaveManualPrices(ctx, []pricing.ModelPrice{{
				Model: model, PromptPricePer1M: 1, CompletionPer1M: 1, PriceMultiplier: 1,
				UpdatedAtMS: testCase.clientTime,
			}}); err != nil {
				t.Fatal(err)
			}
			after := time.Now().UnixMilli()

			rows, err := r.ListModelPrices(ctx)
			if err != nil {
				t.Fatal(err)
			}
			// The row must exist for the window to mean anything: this loop used to
			// skip non-matching rows without recording that it saw one, so a write
			// that stored nothing passed the subtest vacuously.
			var stamped *int64
			for index := range rows {
				if rows[index].Model == model {
					value := rows[index].UpdatedAtMS
					stamped = &value
					break
				}
			}
			if stamped == nil {
				t.Fatalf("no price row was stored for %q", model)
			}
			if *stamped < before || *stamped > after {
				t.Fatalf("updated_at_ms %d outside the server window [%d, %d]", *stamped, before, after)
			}
		})
	}
}

// A retired rate must not leak forward to later requests, and the tombstone must
// keep later rows unpriced.
func TestManualPriceDeletionStopsFutureRequests(t *testing.T) {
	r := usageTestRepository(t)
	ctx := context.Background()
	service := manualPriceService(t, r, &countingFetcher{})

	const model = "priced-model"
	if err := service.SaveManualPrices(ctx, []pricing.ModelPrice{{
		Model: model, PromptPricePer1M: 1, CompletionPer1M: 0, PriceMultiplier: 1,
	}}); err != nil {
		t.Fatal(err)
	}
	if deleted, err := service.DeletePrice(ctx, model); err != nil || !deleted {
		t.Fatalf("delete price: %v %v", deleted, err)
	}

	rowID, err := r.InsertUsageEvents(ctx, []usage.Event{{
		InstanceID: "default", EventKey: "after-delete", Model: model,
		TimestampMS: time.Now().UnixMilli(), InputTokens: 1_000_000,
	}})
	if err != nil {
		t.Fatal(err)
	}
	row, err := r.GetUsageEvent(ctx, rowID)
	if err != nil {
		t.Fatal(err)
	}
	if row.CostUSD != nil || row.PricingStatus != "unpriced" {
		t.Fatalf("retired rate leaked forward: %+v", row)
	}
}
