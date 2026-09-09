package repository

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/domain"
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
	timestamp := now.UnixMilli()
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

// ListEffectiveModels feeds the sync from real traffic only: models that show
// up in usage events, most recent first. A provider catalog model that was
// never called must stay out of pricing, or the table bloats with hundreds of
// configured-but-unused models.
func TestListEffectiveModelsFollowsTraffic(t *testing.T) {
	repo := usageTestRepository(t)
	ctx := context.Background()
	now := time.Now().UTC()
	if _, err := repo.InsertUsageEvents(ctx, []usage.Event{
		{InstanceID: "default", EventKey: "e-old", Model: "old/used-model", Generate: true, TimestampMS: now.Add(-time.Hour).UnixMilli()},
		{InstanceID: "default", EventKey: "e-new", Model: "openai/gpt-5", Generate: true, TimestampMS: now.UnixMilli()},
	}); err != nil {
		t.Fatal(err)
	}
	// A catalog-only model claimed by a configured resource, never requested.
	if _, err := repo.UpsertDiscoveredResources(ctx, "default", []domain.DiscoveredResource{
		{
			ResourceKey:     "auth-index:codex-api-key:idx-catalog",
			CPAResourceType: "codex-api-key",
			CPAAuthIndex:    "idx-catalog",
			CPAResourceName: "catalog-only.json",
			CPADriver:       "codex",
			Details:         domain.ResourceDetails{Models: []string{"catalog/only-model", "another/catalog-model"}},
		},
	}, now, false); err != nil {
		t.Fatal(err)
	}
	models, err := repo.ListEffectiveModels(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(models) != 2 {
		t.Fatalf("expected exactly the two used models, got %v", models)
	}
	if models[0] != "openai/gpt-5" || models[1] != "old/used-model" {
		t.Fatalf("ordering must be most recent first, got %v", models)
	}
	for _, model := range models {
		if strings.Contains(model, "catalog") {
			t.Fatalf("provider-catalog model leaked into pricing scope: %v", models)
		}
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
