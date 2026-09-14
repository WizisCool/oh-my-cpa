package repository

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/pricing"
	"github.com/oh-my-cpa/oh-my-cpa/internal/usage"
)

// Pricing persistence round-trips and the cost query that powers the dashboard:
// unpriced events count separately instead of quietly adding zero.
func TestPricingRoundTripAndUsageCost(t *testing.T) {
	repo := usageTestRepository(t)
	ctx := context.Background()
	now := time.Now().UTC()

	rows := []pricing.ModelPrice{
		{
			Model: "openai/gpt-5", PromptPricePer1M: 2, CompletionPer1M: 10,
			CacheReadPer1M: 0.2, CacheWritePer1M: 2, PriceMultiplier: 1.5,
			Source: pricing.SourceModelsDev, SyncedAtMS: now.UnixMilli(),
		},
		{
			Model: "manual-model", PromptPricePer1M: 5, CompletionPer1M: 5,
			PriceMultiplier: 1, Source: pricing.SourceManual,
		},
	}
	if err := repo.UpsertModelPrices(ctx, rows); err != nil {
		t.Fatal(err)
	}
	got, err := repo.ListModelPrices(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || got[0].Model != "manual-model" {
		t.Fatalf("unexpected rows: %+v", got)
	}

	// Two usage events: one priced (1M input at $2/1M × 1.5 = $3), one unpriced.
	timestamp := time.Now().UnixMilli()
	if _, err := repo.InsertUsageEvents(ctx, []usage.Event{
		{InstanceID: "default", EventKey: "priced", Model: "openai/gpt-5",
			Generate: true, TimestampMS: timestamp, InputTokens: 1_000_000, TotalTokens: 1_000_000},
		{InstanceID: "default", EventKey: "unpriced", Model: "unpriced-model",
			Generate: true, TimestampMS: timestamp, InputTokens: 500, TotalTokens: 500},
	}); err != nil {
		t.Fatal(err)
	}

	stats, err := repo.QueryUsageCost(ctx, "default", 0, now.Add(time.Minute).UnixMilli())
	if err != nil {
		t.Fatal(err)
	}
	if stats.PricedEvents != 1 || stats.UnpricedEvents != 1 {
		t.Fatalf("priced=%d unpriced=%d", stats.PricedEvents, stats.UnpricedEvents)
	}
	if diff := stats.CostUSD - 3.0; diff < -1e-6 || diff > 1e-6 {
		t.Fatalf("cost = %v, want 3.0", stats.CostUSD)
	}

	// ListUsageEvents reports cost per event; unpriced stays nil, never zero.
	page, err := repo.ListUsageEvents(ctx, UsageEventFilter{InstanceID: "default", FromMS: 0, ToMS: now.Add(time.Minute).UnixMilli()})
	if err != nil {
		t.Fatal(err)
	}
	pricedCost := 0.0
	nilCost := 0
	for _, item := range page.Items {
		if item.CostUSD == nil {
			nilCost++
			continue
		}
		pricedCost += *item.CostUSD
	}
	if nilCost != 1 || pricedCost < 3.0-1e-6 || pricedCost > 3.0+1e-6 {
		t.Fatalf("list costs wrong: nil=%d sum=%v", nilCost, pricedCost)
	}

	if _, err := repo.DeleteModelPrice(ctx, "openai/gpt-5"); err != nil {
		t.Fatal(err)
	}
	if deleted, err := repo.DeleteModelPrice(ctx, "openai/gpt-5"); err != nil || deleted {
		t.Fatalf("second delete: deleted=%v err=%v", deleted, err)
	}

	if err := repo.SavePricingSyncState(ctx, pricing.SyncState{Source: pricing.SourceModelsDev, LastMatched: 3, LastUnmatched: 1}); err != nil {
		t.Fatal(err)
	}
	state, err := repo.GetPricingSyncState(ctx, pricing.SourceModelsDev)
	if err != nil {
		t.Fatal(err)
	}
	if state.LastMatched != 3 || state.LastUnmatched != 1 {
		t.Fatalf("state not saved: %+v", state)
	}
}

// Sync bookkeeping is written through an UPSERT. The first revision bound an
// extra placeholder inside the DO UPDATE clause and passed the source name for
// it, so the second and every later sync stored TEXT in the INTEGER column
// last_success_at_ms; the pricing page then failed with a 500. Repeat syncs must
// update the success timestamp, and a failed sync must keep the last good one.
func TestSavePricingSyncStateSurvivesRepeatedUpserts(t *testing.T) {
	repo := usageTestRepository(t)
	ctx := context.Background()
	first := int64(1788935416510)
	if err := repo.SavePricingSyncState(ctx, PricingSyncState{
		Source: pricing.SourceModelsDev, LastSuccessAtMS: &first, LastMatched: 4, LastUnmatched: 3,
	}); err != nil {
		t.Fatal(err)
	}
	second := first + 60_000
	if err := repo.SavePricingSyncState(ctx, PricingSyncState{
		Source: pricing.SourceModelsDev, LastSuccessAtMS: &second, LastMatched: 5, LastUnmatched: 2,
	}); err != nil {
		t.Fatal(err)
	}
	state, err := repo.GetPricingSyncState(ctx, pricing.SourceModelsDev)
	if err != nil {
		t.Fatalf("read state after a repeat sync: %v", err)
	}
	if state.LastSuccessAtMS == nil || *state.LastSuccessAtMS != second {
		t.Fatalf("repeat sync must store its own success timestamp, got %v", state.LastSuccessAtMS)
	}
	if state.LastMatched != 5 || state.LastUnmatched != 2 {
		t.Fatalf("counters must update together, got %+v", state)
	}
	// A failed sync records the error and preserves the last good success.
	if err := repo.SavePricingSyncState(ctx, PricingSyncState{
		Source: pricing.SourceModelsDev, LastError: "models.dev is unreachable",
	}); err != nil {
		t.Fatal(err)
	}
	state, err = repo.GetPricingSyncState(ctx, pricing.SourceModelsDev)
	if err != nil {
		t.Fatalf("read state after a failed sync: %v", err)
	}
	if state.LastSuccessAtMS == nil || *state.LastSuccessAtMS != second {
		t.Fatalf("failed sync must keep the last good success, got %v", state.LastSuccessAtMS)
	}
	if state.LastError != "models.dev is unreachable" {
		t.Fatalf("last_error = %q", state.LastError)
	}
}

// SQLite treats column types as advisory, so rows already written by that
// defective upsert hold TEXT in an INTEGER column. Reading them must degrade to
// "no recorded success" instead of failing, and the next sync must heal the row.
func TestGetPricingSyncStateToleratesCorruptSuccessTimestamp(t *testing.T) {
	repo := usageTestRepository(t)
	ctx := context.Background()
	success := int64(1788935416510)
	if err := repo.SavePricingSyncState(ctx, PricingSyncState{
		Source: pricing.SourceModelsDev, LastSuccessAtMS: &success, LastMatched: 4, LastUnmatched: 3,
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.SQL().ExecContext(ctx,
		`UPDATE pricing_sync_state SET last_success_at_ms = 'modelsdev' WHERE source = ?`, pricing.SourceModelsDev); err != nil {
		t.Fatal(err)
	}
	state, err := repo.GetPricingSyncState(ctx, pricing.SourceModelsDev)
	if err != nil {
		t.Fatalf("corrupt success must stay readable: %v", err)
	}
	if state.LastSuccessAtMS != nil {
		t.Fatalf("corrupt success must read as unknown, got %v", *state.LastSuccessAtMS)
	}
	if state.LastMatched != 4 {
		t.Fatalf("healthy fields must survive, got %+v", state)
	}
	next := success + 1000
	if err := repo.SavePricingSyncState(ctx, PricingSyncState{
		Source: pricing.SourceModelsDev, LastSuccessAtMS: &next, LastMatched: 6,
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.GetPricingSyncState(ctx, pricing.SourceModelsDev); err != nil {
		t.Fatalf("resync after corruption: %v", err)
	}
}

// Migration 016 normalises the stored damage so no reader has to guess.
func TestMigrationRepairsCorruptPricingSyncState(t *testing.T) {
	repo := usageTestRepository(t)
	ctx := context.Background()
	if _, err := repo.SQL().ExecContext(ctx, `INSERT INTO pricing_sync_state (
		source, running, last_success_at_ms, last_error, last_matched, last_unmatched, updated_at_ms
	) VALUES ('modelsdev', 0, 'modelsdev', '', 'three', 'four', 'fifteen')`); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.SQL().ExecContext(ctx, `DELETE FROM schema_migrations WHERE version = 16`); err != nil {
		t.Fatal(err)
	}
	if err := repo.db.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	var successType, matchedType, unmatchedType, updatedAtType string
	if err := repo.SQL().QueryRowContext(ctx, `SELECT
		typeof(last_success_at_ms), typeof(last_matched), typeof(last_unmatched), typeof(updated_at_ms)
		FROM pricing_sync_state WHERE source = 'modelsdev'`).
		Scan(&successType, &matchedType, &unmatchedType, &updatedAtType); err != nil {
		t.Fatal(err)
	}
	if successType != "null" {
		t.Fatalf("text success timestamp must be repaired to NULL, got %q", successType)
	}
	for column, kind := range map[string]string{"last_matched": matchedType, "last_unmatched": unmatchedType, "updated_at_ms": updatedAtType} {
		if kind != "integer" {
			t.Fatalf("%s must be repaired to an integer, got %q", column, kind)
		}
	}
	if _, err := repo.GetPricingSyncState(ctx, pricing.SourceModelsDev); err != nil {
		t.Fatalf("repaired state must read cleanly: %v", err)
	}
}

// TestQueryUsageCostWindowBuckets pins the per-bucket cost grouping the dashboard
// cost tile reads.
//
// It also pins the type SQLite actually returns: `TOTAL()` is a float aggregate by
// definition, so scanning it straight into an int64 fails at runtime with a type
// error. That is not a hypothetical - it took the dashboard endpoint down with a
// 500, against a populated database, while every unit test passed because they run
// on an empty event table where the aggregate is NULL.
func TestQueryUsageCostWindowBuckets(t *testing.T) {
	r := usageTestRepository(t)
	ctx := context.Background()
	const bucket = int64(60_000)

	// Two events in one bucket and one in the next, so grouping has to do work.
	base := bucket * 100
	for index, cost := range []int64{1_500_000_000, 2_500_000_000, 4_000_000_000} {
		started := base
		if index == 2 {
			started = base + bucket
		}
		if _, err := r.SQL().ExecContext(ctx,
			`INSERT INTO usage_events (instance_id, event_key, api_group_key, model, timestamp_ms, created_at_ms, cost_nanos, pricing_status)
			 VALUES ('default', ?, 'group', 'model', ?, ?, ?, 'priced')`,
			fmt.Sprintf("cost-bucket-%d", index), started, started, cost,
		); err != nil {
			t.Fatal(err)
		}
	}

	stats, err := r.QueryUsageCostWindow(ctx, "default", base, base+bucket*2, bucket)
	if err != nil {
		t.Fatalf("QueryUsageCostWindow failed: %v", err)
	}
	if stats.CostUSD != 8 {
		t.Fatalf("window cost = %v, want 8", stats.CostUSD)
	}
	if len(stats.Buckets) != 2 {
		t.Fatalf("got %d cost buckets, want 2: %+v", len(stats.Buckets), stats.Buckets)
	}
	if stats.Buckets[0].CostNanos != 4_000_000_000 {
		t.Fatalf("first bucket = %d, want 4000000000", stats.Buckets[0].CostNanos)
	}
	if stats.Buckets[1].CostNanos != 4_000_000_000 {
		t.Fatalf("second bucket = %d, want 4000000000", stats.Buckets[1].CostNanos)
	}
	if stats.Buckets[0].StartMS != base || stats.Buckets[1].StartMS != base+bucket {
		t.Fatalf("buckets are not grid aligned: %+v", stats.Buckets)
	}

	// bucketMS <= 0 must skip grouping rather than divide by zero.
	windowOnly, err := r.QueryUsageCostWindow(ctx, "default", base, base+bucket*2, 0)
	if err != nil {
		t.Fatalf("QueryUsageCostWindow without buckets failed: %v", err)
	}
	if windowOnly.Buckets != nil {
		t.Fatalf("expected no buckets when bucketMS <= 0, got %+v", windowOnly.Buckets)
	}
	if windowOnly.CostUSD != 8 {
		t.Fatalf("window cost without grouping = %v, want 8", windowOnly.CostUSD)
	}
}
