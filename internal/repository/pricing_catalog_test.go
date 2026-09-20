package repository

import (
	"context"
	"testing"

	"github.com/oh-my-cpa/oh-my-cpa/internal/pricing"
)

func TestCatalogReplacementRetiresOnlyAutomaticPrices(t *testing.T) {
	r := usageTestRepository(t)
	ctx := context.Background()
	if _, err := r.ReplacePricingModels(ctx, map[string]string{"alias": "old", "manual": "old", "removed": "removed"}); err != nil {
		t.Fatal(err)
	}
	rows := []pricing.ModelPrice{{Model: "alias", PromptPricePer1M: 1, PriceMultiplier: 1, Source: pricing.SourceModelsDev}, {Model: "manual", PromptPricePer1M: 2, PriceMultiplier: 1, Source: pricing.SourceManual}, {Model: "removed", PromptPricePer1M: 3, PriceMultiplier: 1, Source: pricing.SourceModelsDev}}
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

func TestCatalogReplacementRejectsEmptyPriceModel(t *testing.T) {
	r := usageTestRepository(t)
	if _, err := r.ReplacePricingModels(context.Background(), map[string]string{"alias": " "}); err == nil {
		t.Fatal("empty price_model was accepted")
	}
	catalog, err := r.ListPricingModels(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(catalog) != 0 {
		t.Fatalf("rejected snapshot changed the catalog: %v", catalog)
	}
}
