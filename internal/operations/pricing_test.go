package operations

import (
	"context"
	"errors"
	"testing"

	"github.com/oh-my-cpa/oh-my-cpa/internal/pricing"
)

type candidateFailingPricing struct {
	Pricing
	prices []pricing.ModelPrice
}

func (f candidateFailingPricing) ListPrices(context.Context) ([]pricing.ModelPrice, error) {
	return f.prices, nil
}

func (candidateFailingPricing) ListChannels(context.Context) ([]pricing.ChannelMultiplier, error) {
	return nil, nil
}

func (candidateFailingPricing) Candidates(context.Context, []pricing.ModelPrice) (map[string]pricing.Candidate, error) {
	return nil, errors.New("snapshot unreadable")
}

// pricing_list also backs the pricing_set and pricing_delete previews, so a
// candidate lookup that fails must leave the list readable.
func TestPriceListSurvivesAFailedCandidateLookup(t *testing.T) {
	service := &Service{Pricing: candidateFailingPricing{prices: []pricing.ModelPrice{{Model: "claude-sonnet", Source: pricing.SourceManual}}}}
	page, err := service.ListPrices(context.Background(), PriceQuery{})
	if err != nil {
		t.Fatalf("ListPrices failed with the candidate lookup: %v", err)
	}
	if len(page.Items) != 1 || page.Candidates == nil || len(page.Candidates) != 0 {
		t.Fatalf("page = %+v, want the price with no candidates", page)
	}
}
