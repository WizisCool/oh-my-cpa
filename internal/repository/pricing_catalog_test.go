package repository

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/pricing"
)

func TestCatalogReplacementRetiresOnlyAutomaticPrices(t *testing.T) {
	r := usageTestRepository(t)
	ctx := context.Background()
	if _, err := r.ReplacePricingModels(ctx, map[string]string{"alias": "old", "manual": "old", "removed": "removed"}); err != nil {
		t.Fatal(err)
	}
	rows := []pricing.ModelPrice{{Model: "alias", PromptPricePer1M: 1, PriceMultiplier: 1, Source: pricing.SourceOpenRouter}, {Model: "manual", PromptPricePer1M: 2, PriceMultiplier: 1, Source: pricing.SourceManual}, {Model: "removed", PromptPricePer1M: 3, PriceMultiplier: 1, Source: pricing.SourceOpenRouter}}
	if err := r.UpsertModelPrices(ctx, rows); err != nil {
		t.Fatal(err)
	}
	n, err := r.ReplacePricingModels(ctx, map[string]string{"alias": "new"})
	if err != nil || n != 2 {
		t.Fatalf("pruned %d %v", n, err)
	}
	remaining, err := r.ListModelPrices(ctx)
	if err != nil || len(remaining) != 1 || remaining[0].Model != "manual" {
		t.Fatalf("manual archive: %+v %v", remaining, err)
	}
	catalog, err := r.ListPricingModels(ctx)
	if err != nil || len(catalog) != 1 || catalog["alias"] != "new" {
		t.Fatalf("catalog %v %v", catalog, err)
	}
	var stopped int
	if err := r.SQL().QueryRow(`SELECT count(*) FROM model_price_versions WHERE available=0`).Scan(&stopped); err != nil || stopped != 2 {
		t.Fatalf("missing tombstones %d %v", stopped, err)
	}
}

func TestCatalogReplacementPreservesAmbiguousAliases(t *testing.T) {
	repository := usageTestRepository(t)
	ctx := context.Background()
	if _, err := repository.ReplacePricingModels(ctx, map[string]string{"alias": "gpt-5", "pinned": "gpt-5", "custom": "gpt-5"}); err != nil {
		t.Fatal(err)
	}
	prices := []pricing.ModelPrice{
		{Model: "alias", PromptPricePer1M: 1, PriceMultiplier: 1, Source: pricing.SourceOpenRouter},
		{Model: "pinned", PromptPricePer1M: 2, PriceMultiplier: 1, Source: pricing.SourceOpenRouter, UpstreamID: "openai/gpt-5"},
		{Model: "custom", PromptPricePer1M: 3, PriceMultiplier: 1, Source: pricing.SourceManual},
	}
	if err := repository.UpsertModelPrices(ctx, prices); err != nil {
		t.Fatal(err)
	}
	if _, err := repository.SQL().ExecContext(ctx, `INSERT INTO pricing_model_links(model,upstream_id,updated_at_ms) VALUES('pinned','openai/gpt-5',1)`); err != nil {
		t.Fatal(err)
	}
	pruned, err := repository.ReplacePricingModels(ctx, map[string]string{"alias": "", "pinned": "", "custom": "", "unrelated": "gpt-5"})
	if err != nil || pruned != 1 {
		t.Fatalf("ambiguous snapshot: pruned=%d, err=%v", pruned, err)
	}
	catalog, err := repository.ListPricingModels(ctx)
	if err != nil || len(catalog) != 4 || catalog["alias"] != "" || catalog["unrelated"] != "gpt-5" {
		t.Fatalf("catalog: %v, %v", catalog, err)
	}
	remaining, err := repository.ListModelPrices(ctx)
	if err != nil || len(remaining) != 2 {
		t.Fatalf("preserved prices: %+v, %v", remaining, err)
	}
	for _, price := range remaining {
		if price.Model == "alias" {
			t.Fatal("ambiguous alias retained an automatic price")
		}
	}
}

func TestCatalogReplacementRejectsInvalidIdentityAtomically(t *testing.T) {
	repository := usageTestRepository(t)
	ctx := context.Background()
	if _, err := repository.ReplacePricingModels(ctx, map[string]string{"existing": "existing"}); err != nil {
		t.Fatal(err)
	}
	for _, snapshot := range []map[string]string{
		{" ": "gpt-5"}, {strings.Repeat("m", 513): "gpt-5"}, {"alias": strings.Repeat("m", 513)},
	} {
		if _, err := repository.ReplacePricingModels(ctx, snapshot); err == nil {
			t.Fatal("invalid identity accepted")
		}
		catalog, err := repository.ListPricingModels(ctx)
		if err != nil || len(catalog) != 1 || catalog["existing"] != "existing" {
			t.Fatalf("rejected snapshot changed catalog: %v, %v", catalog, err)
		}
	}
}

type aliasCatalogLister struct{}

func (aliasCatalogLister) ListConfiguredModels(context.Context) ([]string, error) {
	return []string{"conflict", "gpt-5"}, nil
}
func (aliasCatalogLister) ListConfiguredModelCatalog(context.Context) (map[string]string, error) {
	return map[string]string{"conflict": "", "gpt-5": "gpt-5"}, nil
}

func (aliasCatalogLister) ListConfiguredModelSnapshot(ctx context.Context) (pricing.ModelCatalogSnapshot, error) {
	models, err := (aliasCatalogLister{}).ListConfiguredModelCatalog(ctx)
	return pricing.ModelCatalogSnapshot{Models: models, Providers: []pricing.CatalogProvider{{ID: "codex-0", Family: "codex", Models: []string{"gpt-5", "conflict"}}}}, err
}

type aliasCatalogFetcher struct{}

func (aliasCatalogFetcher) Fetch(context.Context) (pricing.Catalog, error) {
	return pricing.NewCatalog([]pricing.UpstreamModel{{ID: "openai/gpt-5", Author: "openai", PromptPricePer1M: 2, CompletionPer1M: 10}}, time.Now()), nil
}

func TestSyncWithAmbiguousAliasAndRealRepository(t *testing.T) {
	repository := usageTestRepository(t)
	ctx := context.Background()
	service := pricing.NewService(repository, aliasCatalogFetcher{}, nil)
	service.SetModelLister(aliasCatalogLister{})
	result, err := service.SyncOnce(ctx)
	if err != nil || result.Matched != 1 || result.Unmatched != 1 {
		t.Fatalf("sync: %+v, %v", result, err)
	}
	prices, err := repository.ListModelPrices(ctx)
	if err != nil || len(prices) != 1 || prices[0].Model != "gpt-5" {
		t.Fatalf("prices: %+v, %v", prices, err)
	}
	providers, err := repository.ListPricingProviders(ctx)
	if err != nil || len(providers) != 1 || providers[0].ID != "codex-0" {
		t.Fatalf("sync provider membership: %+v, %v", providers, err)
	}
	state, err := repository.GetPricingSyncState(ctx, pricing.SourceOpenRouter)
	if err != nil || state.LastError != "" || state.LastSuccessAtMS == nil || *state.LastSuccessAtMS == 0 {
		t.Fatalf("sync state: %+v, %v", state, err)
	}
}

func TestProviderSnapshotPublishesWithCatalog(t *testing.T) {
	repository := usageTestRepository(t)
	ctx := context.Background()
	provider := pricing.CatalogProvider{ID: "openai-compat-0", Family: "openai-compatibility", Name: "Relay", Priority: 10, Models: []string{"gpt-5"}}
	if _, err := repository.ReplacePricingModels(ctx, map[string]string{"gpt-5": "gpt-5"}, provider); err != nil {
		t.Fatal(err)
	}
	if _, err := repository.ReplacePricingModels(ctx, map[string]string{"": "gpt-5"}, pricing.CatalogProvider{ID: "wrong"}); err == nil {
		t.Fatal("invalid snapshot accepted")
	}
	providers, err := repository.ListPricingProviders(ctx)
	if err != nil || len(providers) != 1 || providers[0].ID != provider.ID || providers[0].Priority != 10 || len(providers[0].Models) != 1 {
		t.Fatalf("provider snapshot: %+v, %v", providers, err)
	}
	if _, err := repository.ReplacePricingModels(ctx, map[string]string{"replacement": "replacement"}); err != nil {
		t.Fatal(err)
	}
	providers, err = repository.ListPricingProviders(ctx)
	if err != nil || len(providers) != 0 {
		t.Fatalf("old provider membership survived: %+v, %v", providers, err)
	}
}

func TestProviderDeleteShiftsMembershipAndMetadataTogether(t *testing.T) {
	repository := usageTestRepository(t)
	ctx := context.Background()
	providers := []pricing.CatalogProvider{{ID: "codex-0", Models: []string{"removed"}}, {ID: "codex-1", Models: []string{"kept"}}, {ID: "oauth:codex", Models: []string{"oauth"}}}
	if _, err := repository.ReplacePricingModels(ctx, map[string]string{"kept": "kept"}, providers...); err != nil {
		t.Fatal(err)
	}
	if err := repository.PutProviderPreferencesAfterDelete(ctx, map[string]string{PreferenceProviderNames: `{"codex-0":"Kept"}`}, "codex-", 0); err != nil {
		t.Fatal(err)
	}
	stored, err := repository.ListPricingProviders(ctx)
	if err != nil || len(stored) != 2 || stored[0].ID != "codex-0" || stored[0].Models[0] != "kept" || stored[1].ID != "oauth:codex" {
		t.Fatalf("shifted membership: %+v, %v", stored, err)
	}
	if _, err := repository.SQL().Exec(`CREATE TRIGGER reject_provider_snapshot BEFORE UPDATE OF providers_json ON pricing_catalog_state BEGIN SELECT RAISE(ABORT, 'test rejection'); END`); err != nil {
		t.Fatal(err)
	}
	if err := repository.PutProviderPreferencesAfterDelete(ctx, map[string]string{PreferenceProviderNames: `{}`}, "codex-", 0); err == nil {
		t.Fatal("snapshot failure accepted")
	}
	names, _, err := repository.GetPreference(ctx, PreferenceProviderNames)
	if err != nil || names != `{"codex-0":"Kept"}` {
		t.Fatalf("partial metadata write: %s, %v", names, err)
	}
}

func TestProviderSnapshotRequiresMigration029(t *testing.T) {
	ctx := context.Background()
	database, err := Open(ctx, "file:pricing_provider_gate?mode=memory&cache=shared", withMigrationsUntil(28))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = database.Close() })
	repository := New(database)
	if _, err := repository.ListPricingProviders(ctx); err == nil || !strings.Contains(err.Error(), "migration 29") {
		t.Fatalf("read gate: %v", err)
	}
	if err := repository.PutProviderPreferencesAfterDelete(ctx, nil, "codex-", 0); err == nil || !strings.Contains(err.Error(), "migration 29") {
		t.Fatalf("write gate: %v", err)
	}
	database.migrateUntil = 0
	if err := database.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	if providers, err := repository.ListPricingProviders(ctx); err != nil || len(providers) != 0 {
		t.Fatalf("new snapshot: %+v, %v", providers, err)
	}
}
