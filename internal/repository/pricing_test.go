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
