package repository

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/management"
	"github.com/oh-my-cpa/oh-my-cpa/internal/pricing"
	"github.com/oh-my-cpa/oh-my-cpa/internal/usage"
)

const OAUTH_CALL_MODEL = "gemini-3.8-flash"
const OAUTH_UPSTREAM_MODEL = "gemini-3.8-flash-high"

type oauthCatalogLister struct{ client *management.Client }

func (lister oauthCatalogLister) ListConfiguredModels(ctx context.Context) ([]string, error) {
	return lister.client.ListAllConfiguredModels(ctx)
}
func (lister oauthCatalogLister) ListConfiguredModelSnapshot(ctx context.Context) (pricing.ModelCatalogSnapshot, error) {
	snapshot, err := lister.client.ListConfiguredModelSnapshot(ctx)
	providers := make([]pricing.CatalogProvider, 0, len(snapshot.Providers))
	for _, provider := range snapshot.Providers {
		providers = append(providers, pricing.CatalogProvider{ID: provider.ID, Family: provider.Family, IsOAuth: provider.IsOAuth, Models: provider.ListPricingModelIDs()})
	}
	return pricing.ModelCatalogSnapshot{Models: snapshot.Models, Providers: providers}, err
}

type oauthPriceFetcher struct{}

func (oauthPriceFetcher) Fetch(context.Context) (pricing.Catalog, error) {
	return pricing.NewCatalog([]pricing.UpstreamModel{{ID: "google/gemini-3.8-flash", Author: "google", PromptPricePer1M: 0.75, CompletionPer1M: 3.75}}, time.Now()), nil
}

func TestOAuthAliasCatalogLocksUpstreamPrices(t *testing.T) {
	for _, isFork := range []bool{false, true} {
		t.Run(fmt.Sprintf("fork=%t", isFork), func(t *testing.T) {
			ctx := context.Background()
			var shouldFailAliases atomic.Bool
			server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
				writer.Header().Set("Content-Type", "application/json")
				switch {
				case request.URL.Path == "/v8/management/config/config-version":
					_, _ = writer.Write([]byte(`8`))
				case request.URL.Path == "/v8/management/credentials":
					_, _ = writer.Write([]byte(`{"files":[{"name":"antigravity.json","provider":"antigravity"}]}`))
				case request.URL.Path == "/v8/management/credentials/models":
					models := []map[string]string{{"id": OAUTH_CALL_MODEL}}
					if isFork {
						models = append(models, map[string]string{"id": OAUTH_UPSTREAM_MODEL})
					}
					_ = json.NewEncoder(writer).Encode(map[string]any{"models": models})
				case request.URL.Path == "/v8/management/credentials/download":
					// The credential states no aliases of its own, so only the provider's rule applies.
					_, _ = writer.Write([]byte(`{"name":"antigravity.json"}`))
				case request.URL.Path == "/v0/management/openai-compatibility":
					_, _ = writer.Write([]byte(`{"openai-compatibility":[]}`))
				case request.URL.Path == "/v8/management/config/oauth/model-alias":
					if shouldFailAliases.Load() {
						writer.WriteHeader(http.StatusServiceUnavailable)
						return
					}
					_ = json.NewEncoder(writer).Encode(map[string]any{"antigravity": []map[string]any{{"name": OAUTH_UPSTREAM_MODEL, "alias": OAUTH_CALL_MODEL, "fork": isFork}}})
				default:
					if strings.HasPrefix(request.URL.Path, "/v0/management/") {
						writer.WriteHeader(http.StatusNotFound)
						_, _ = writer.Write([]byte(`{"error":"not_found"}`))
						return
					}
					t.Errorf("unexpected request path: %s", request.URL.Path)
					http.NotFound(writer, request)
				}
			}))
			defer server.Close()
			client, err := management.NewClient(server.URL, "fixture-key", time.Second, false)
			if err != nil {
				t.Fatal(err)
			}
			repository := usageTestRepository(t)
			service := pricing.NewService(repository, oauthPriceFetcher{}, nil)
			service.SetModelLister(oauthCatalogLister{client: client})
			if _, err := service.SyncOnce(ctx); err != nil {
				t.Fatal(err)
			}
			catalog, err := repository.ListPricingModels(ctx)
			if err != nil {
				t.Fatal(err)
			}
			_, hasSource := catalog[OAUTH_UPSTREAM_MODEL]
			if !hasSource || catalog[OAUTH_CALL_MODEL] != OAUTH_UPSTREAM_MODEL {
				t.Fatalf("alias upstream missing: %v", catalog)
			}
			now := time.Now().UnixMilli()
			modelAlias := OAUTH_CALL_MODEL
			eventID, err := repository.InsertUsageEvents(ctx, []usage.Event{{InstanceID: "default", EventKey: "before-link", Model: OAUTH_UPSTREAM_MODEL, ModelAlias: &modelAlias, TimestampMS: now, InputTokens: 1_000_000}})
			if err != nil {
				t.Fatal(err)
			}
			event, err := repository.GetUsageEvent(ctx, eventID)
			if err != nil || event.PricingStatus != "unpriced" || event.CostUSD != nil {
				t.Fatalf("before link: %+v %v", event, err)
			}
			_, err = service.SetModelMode(ctx, pricing.ModeChange{Model: OAUTH_UPSTREAM_MODEL, Mode: pricing.ModeLinked, UpstreamID: "google/gemini-3.8-flash"})
			if err != nil {
				t.Fatal(err)
			}
			var effectiveFrom int64
			if err := repository.SQL().QueryRow(`SELECT max(effective_from_ms) FROM model_price_versions WHERE model=?`, OAUTH_UPSTREAM_MODEL).Scan(&effectiveFrom); err != nil {
				t.Fatal(err)
			}
			newID, err := repository.InsertUsageEvents(ctx, []usage.Event{{InstanceID: "default", EventKey: "after-link", Model: OAUTH_UPSTREAM_MODEL, ModelAlias: &modelAlias, TimestampMS: effectiveFrom, InputTokens: 1_000_000}})
			if err != nil {
				t.Fatal(err)
			}
			newEvent, err := repository.GetUsageEvent(ctx, newID)
			if err != nil || newEvent.CostUSD == nil || *newEvent.CostUSD != 0.75 {
				t.Fatalf("new event: %+v %v", newEvent, err)
			}
			shouldFailAliases.Store(true)
			if _, err := service.SyncOnce(ctx); err == nil {
				t.Fatal("unreadable OAuth rules published a complete catalog")
			}
			retained, err := repository.ListPricingModels(ctx)
			if err != nil || retained[OAUTH_UPSTREAM_MODEL] != OAUTH_UPSTREAM_MODEL || retained[OAUTH_CALL_MODEL] != OAUTH_UPSTREAM_MODEL {
				t.Fatalf("last complete catalog was lost: %v, %v", retained, err)
			}

			oldEvent, err := repository.GetUsageEvent(ctx, eventID)
			if err != nil || oldEvent.CostUSD != nil || oldEvent.PricingStatus != "unpriced" {
				t.Fatalf("history changed: %+v %v", oldEvent, err)
			}
		})
	}
}

func TestObservedRuntimeVariantOutsideCatalogCanBePricedAndRepriced(t *testing.T) {
	ctx := context.Background()
	repo := usageTestRepository(t)
	now := time.Now().UnixMilli()

	// Static CPA catalog has alias gemini-4-hydrogen -> gemini-4-hydrogen-xhigh,
	// without the runtime thinking variant gemini-4-hydrogen-high.
	if _, err := repo.ReplacePricingModels(ctx, map[string]string{
		"gemini-4-hydrogen":       "gemini-4-hydrogen-xhigh",
		"gemini-4-hydrogen-xhigh": "gemini-4-hydrogen-xhigh",
	}, pricing.CatalogProvider{
		ID: "oauth:antigravity", Family: "antigravity", Name: "antigravity", Channel: "antigravity", IsOAuth: true,
		Models: []string{"gemini-4-hydrogen", "gemini-4-hydrogen-xhigh"},
	}); err != nil {
		t.Fatal(err)
	}
	if err := repo.ReplaceUpstreamCatalog(ctx, []pricing.UpstreamModel{
		{ID: "google/gemini-4-hydrogen", Author: "google", PromptPricePer1M: 1.5, CompletionPer1M: 7.5},
		{ID: "anthropic/claude-sonnet-4.6", Author: "anthropic", PromptPricePer1M: 3, CompletionPer1M: 15},
	}); err != nil {
		t.Fatal(err)
	}
	service := pricing.NewService(repo, nil, nil)

	alias := "gemini-4-hydrogen"
	variantID, err := repo.InsertUsageEvents(ctx, []usage.Event{
		{InstanceID: "default", EventKey: "variant-1", Provider: "antigravity", Model: "gemini-4-hydrogen-high", ModelAlias: &alias, TimestampMS: now - 10_000, InputTokens: 1_000_000},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := repo.InsertUsageEvents(ctx, []usage.Event{
		{InstanceID: "default", EventKey: "passthrough-1", Provider: "claude", Model: "claude-sonnet-4-6", TimestampMS: now - 9_000, InputTokens: 1_000_000},
		{InstanceID: "default", EventKey: "unknown-1", Provider: "antigravity", Model: "unknown", TimestampMS: now - 8_000, InputTokens: 100},
		{InstanceID: "default", EventKey: "inconsistent-1", Provider: "antigravity", Model: "broken-variant", TimestampMS: now - 7_000, InputTokens: 100, Accounting: &usage.TokenAccounting{Version: 2, Status: "inconsistent"}},
	}); err != nil {
		t.Fatal(err)
	}

	// Only unpriced complete-accounting observed models surface (never unknown or inconsistent-only).
	unpriced, err := service.UsedUnpricedModels(ctx, 0)
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Contains(unpriced, "gemini-4-hydrogen-high") || !slices.Contains(unpriced, "claude-sonnet-4-6") {
		t.Fatalf("observed unpriced models missing: %v", unpriced)
	}
	if slices.Contains(unpriced, "unknown") || slices.Contains(unpriced, "broken-variant") {
		t.Fatalf("invalid models surfaced in UsedUnpricedModels: %v", unpriced)
	}

	// Linking the runtime variant and setting a channel override on its observed channel succeed.
	if _, err := service.SetModelMode(ctx, pricing.ModeChange{
		Model: "gemini-4-hydrogen-high", Mode: pricing.ModeLinked, UpstreamID: "google/gemini-4-hydrogen", Multiplier: 1,
	}); err != nil {
		t.Fatalf("linking runtime variant failed: %v", err)
	}
	if _, err := service.SetModelMode(ctx, pricing.ModeChange{
		Model: "gemini-4-hydrogen-high", Channel: "antigravity", Mode: pricing.ModeCustom,
		Price: pricing.ModelPrice{PromptPricePer1M: 2, CompletionPer1M: 8}, Multiplier: 1,
	}); err != nil {
		t.Fatalf("channel price on observed variant failed: %v", err)
	}
	if _, err := service.SetModelMode(ctx, pricing.ModeChange{
		Model: "gemini-4-hydrogen-high", Channel: "codex", Mode: pricing.ModeCustom,
		Price: pricing.ModelPrice{PromptPricePer1M: 2, CompletionPer1M: 8}, Multiplier: 1,
	}); !errors.Is(err, pricing.ErrModelNotInCatalog) {
		t.Fatalf("unobserved channel must be refused: %v", err)
	}
	if _, err := service.SetModelMode(ctx, pricing.ModeChange{
		Model: "unknown", Mode: pricing.ModeCustom, Price: pricing.ModelPrice{PromptPricePer1M: 1, CompletionPer1M: 2}, Multiplier: 1,
	}); !errors.Is(err, pricing.ErrModelNotInCatalog) {
		t.Fatalf("unknown placeholder must be refused: %v", err)
	}

	// Auto-matching a pass-through observed model succeeds and survives catalog refresh.
	if _, err := service.SetModelMode(ctx, pricing.ModeChange{Model: "claude-sonnet-4-6", Mode: pricing.ModeAuto, Multiplier: 1}); err != nil {
		t.Fatalf("auto-matching observed pass-through model failed: %v", err)
	}
	if _, err := repo.ReplacePricingModels(ctx, map[string]string{
		"gemini-4-hydrogen":       "gemini-4-hydrogen-xhigh",
		"gemini-4-hydrogen-xhigh": "gemini-4-hydrogen-xhigh",
	}, pricing.CatalogProvider{
		ID: "oauth:antigravity", Family: "antigravity", Name: "antigravity", Channel: "antigravity", IsOAuth: true,
		Models: []string{"gemini-4-hydrogen", "gemini-4-hydrogen-xhigh"},
	}); err != nil {
		t.Fatal(err)
	}
	if _, ok, err := service.GetPrice(ctx, "claude-sonnet-4-6"); err != nil || !ok {
		t.Fatalf("catalog refresh pruned active observed automatic price: ok=%v err=%v", ok, err)
	}

	// Repricing prices the earlier unpriced runtime-variant event, and new events lock immediately.
	pricedCount, err := repo.PriceUnpricedUsage(ctx, "gemini-4-hydrogen-high", time.Now().UnixMilli())
	if err != nil || pricedCount != 1 {
		t.Fatalf("PriceUnpricedUsage = %d, err=%v", pricedCount, err)
	}
	backfilled, err := repo.GetUsageEvent(ctx, variantID)
	if err != nil || backfilled.PricingStatus != "priced" || backfilled.CostUSD == nil || *backfilled.CostUSD != 2 {
		t.Fatalf("backfilled runtime variant = %+v, err=%v", backfilled, err)
	}
	nextID, err := repo.InsertUsageEvents(ctx, []usage.Event{{
		InstanceID: "default", EventKey: "variant-2", Provider: "antigravity",
		Model: "gemini-4-hydrogen-high", ModelAlias: &alias, TimestampMS: time.Now().UnixMilli(), InputTokens: 1_000_000,
	}})
	if err != nil {
		t.Fatal(err)
	}
	nextEvent, err := repo.GetUsageEvent(ctx, nextID)
	if err != nil || nextEvent.PricingStatus != "priced" || nextEvent.CostUSD == nil || *nextEvent.CostUSD != 2 {
		t.Fatalf("new runtime variant event = %+v, err=%v", nextEvent, err)
	}

	// Even with zero unpriced rows left, the priced observed variant stays in ListPrices and EffectiveProviders.
	prices, err := service.ListPrices(ctx)
	if err != nil {
		t.Fatal(err)
	}
	foundPrice := false
	for _, row := range prices {
		if row.Model == "gemini-4-hydrogen-high" {
			foundPrice = true
		}
	}
	if !foundPrice {
		t.Fatalf("priced observed variant vanished after repricing: %+v", prices)
	}
	providers, err := service.EffectiveProviders(ctx, map[string]struct{}{"gemini-4-hydrogen-high": {}})
	if err != nil {
		t.Fatal(err)
	}
	foundProviderModel := false
	for _, provider := range providers {
		if provider.ID == "oauth:antigravity" && slices.Contains(provider.Models, "gemini-4-hydrogen-high") {
			foundProviderModel = true
		}
	}
	if !foundProviderModel {
		t.Fatalf("EffectiveProviders missing runtime variant on antigravity: %+v", providers)
	}
}

func TestObservedAutomaticPriceSurvivesDetailExpiryWhenFactsRemain(t *testing.T) {
	ctx := context.Background()
	repo := usageTestRepository(t)
	now := time.Now()

	if _, err := repo.ReplacePricingModels(ctx, map[string]string{"catalog-model": "catalog-model"}); err != nil {
		t.Fatal(err)
	}
	if err := repo.ReplaceUpstreamCatalog(ctx, []pricing.UpstreamModel{
		{ID: "anthropic/claude-sonnet-4.6", Author: "anthropic", PromptPricePer1M: 3, CompletionPer1M: 15},
		{ID: "openai/gpt-5.4", Author: "openai", PromptPricePer1M: 2.5, CompletionPer1M: 15},
	}); err != nil {
		t.Fatal(err)
	}
	service := pricing.NewService(repo, nil, nil)

	// One purely observed model has traffic 10 days ago (inside 30d window);
	// another had traffic 35 days ago (outside 30d window).
	if _, err := repo.InsertUsageEvents(ctx, []usage.Event{
		{InstanceID: "default", EventKey: "recent-fact-only", Provider: "claude", Model: "claude-sonnet-4-6", TimestampMS: now.Add(-10 * 24 * time.Hour).UnixMilli(), InputTokens: 1_000_000},
		{InstanceID: "default", EventKey: "stale-fact-only", Provider: "codex", Model: "gpt-5.4", TimestampMS: now.Add(-35 * 24 * time.Hour).UnixMilli(), InputTokens: 1_000_000},
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := service.SetModelMode(ctx, pricing.ModeChange{Model: "claude-sonnet-4-6", Mode: pricing.ModeAuto, Multiplier: 1}); err != nil {
		t.Fatalf("auto price recent observed model: %v", err)
	}
	if _, err := service.SetModelMode(ctx, pricing.ModeChange{Model: "gpt-5.4", Mode: pricing.ModeAuto, Multiplier: 1}); err != nil {
		t.Fatalf("auto price stale observed model: %v", err)
	}

	// Fold both requests into permanent facts and expire detail retention at 5 days ago.
	if _, err := repo.AggregateUsageFacts(ctx, 100); err != nil {
		t.Fatal(err)
	}
	horizonMS := now.Add(-5 * 24 * time.Hour).UnixMilli()
	for pass := 0; pass < 3; pass++ {
		if _, err := repo.RunLifecycle(ctx, map[string]int64{LifecycleUsageDetail: horizonMS}, 10); err != nil {
			t.Fatal(err)
		}
	}
	var remainingEvents int
	if err := repo.SQL().QueryRowContext(ctx, `SELECT COUNT(1) FROM usage_events`).Scan(&remainingEvents); err != nil {
		t.Fatal(err)
	}
	if remainingEvents != 0 {
		t.Fatalf("expected all expired usage_events to be deleted, got %d", remainingEvents)
	}

	// Refreshing the static CPA catalog must preserve the recent fact-only automatic
	// price while still retiring the stale (>30d) observed model's automatic price.
	pruned, err := repo.ReplacePricingModels(ctx, map[string]string{"catalog-model": "catalog-model"})
	if err != nil {
		t.Fatal(err)
	}
	if pruned != 1 {
		t.Fatalf("pruned = %d, want 1 (only the >30d model)", pruned)
	}
	if row, ok, err := service.GetPrice(ctx, "claude-sonnet-4-6"); err != nil || !ok || row.Mode != pricing.ModeAuto {
		t.Fatalf("recent fact-only automatic price was lost: row=%+v ok=%v err=%v", row, ok, err)
	}
	if _, ok, err := service.GetPrice(ctx, "gpt-5.4"); err != nil || ok {
		t.Fatalf("stale (>30d) automatic price should have been retired: ok=%v err=%v", ok, err)
	}
}
