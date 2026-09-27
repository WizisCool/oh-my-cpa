package operations

import (
	"context"
	"errors"
	"strings"

	"github.com/oh-my-cpa/oh-my-cpa/internal/capability"
	"github.com/oh-my-cpa/oh-my-cpa/internal/pricing"
)

type Pricing interface {
	ListPrices(context.Context) ([]pricing.ModelPrice, error)
	SaveManualPricesChecked(context.Context, []pricing.ModelPrice, func([]pricing.ModelPrice) error) error
	DeletePriceChecked(context.Context, string, func([]pricing.ModelPrice) error) (bool, error)
	TriggerSync() bool
}
type PriceQuery struct {
	Model  string `json:"model,omitempty"`
	Offset int    `json:"offset,omitempty"`
}
type PricePage struct {
	Items    []pricing.ModelPrice `json:"items"`
	HasMore  bool                 `json:"has_more"`
	Revision string               `json:"revision"`
}

func (s *Service) ListPrices(ctx context.Context, input PriceQuery) (PricePage, error) {
	if s.Pricing == nil {
		return PricePage{}, errors.New("capability_unavailable")
	}
	if input.Offset < 0 || input.Offset > 10000 {
		return PricePage{}, errors.New("invalid_parameters")
	}
	rows, err := s.Pricing.ListPrices(ctx)
	if err != nil {
		return PricePage{}, err
	}
	filtered := []pricing.ModelPrice{}
	for _, row := range rows {
		if input.Model == "" || strings.Contains(strings.ToLower(row.Model), strings.ToLower(input.Model)) {
			filtered = append(filtered, row)
		}
	}
	output := PricePage{Items: []pricing.ModelPrice{}, Revision: s.revision(rows)}
	if input.Offset < len(filtered) {
		end := min(input.Offset+50, len(filtered))
		output.Items = filtered[input.Offset:end]
		output.HasMore = end < len(filtered)
	}
	return output, nil
}
func (s *Service) registerPricing(registry *capability.Registry) error {
	if err := read(registry, "pricing_list", "Read current model prices, paginated. Historical request cost snapshots do not change when current prices change.", s.ListPrices); err != nil {
		return err
	}
	metadata := Meta("pricing_sync", "Request a catalogue refresh from the configured pricing service.", "write", "high")
	metadata.Invalidates = []string{"pricing"}
	if err := capability.Register(registry, metadata, func(context.Context, Empty) (capability.Preview, error) {
		if s.Pricing == nil {
			return capability.Preview{}, errors.New("capability_unavailable")
		}
		return capability.Preview{Target: "pricing", Revision: "sync", Changes: map[string]string{"action": "sync"}}, nil
	}, func(context.Context, Empty, string, string) (Done, error) {
		if s.Pricing == nil {
			return Done{}, errors.New("capability_unavailable")
		}
		return Done{s.Pricing.TriggerSync()}, nil
	}); err != nil {
		return err
	}
	type PriceInput struct {
		Model      string  `json:"model"`
		Prompt     float64 `json:"prompt_price_per_1m"`
		Completion float64 `json:"completion_price_per_1m"`
		CacheRead  float64 `json:"cache_read_price_per_1m"`
		CacheWrite float64 `json:"cache_write_price_per_1m"`
		Multiplier float64 `json:"price_multiplier"`
	}
	toPrice := func(input PriceInput) pricing.ModelPrice {
		return pricing.ModelPrice{Model: input.Model, PromptPricePer1M: input.Prompt, CompletionPer1M: input.Completion, CacheReadPer1M: input.CacheRead, CacheWritePer1M: input.CacheWrite, PriceMultiplier: input.Multiplier, Source: pricing.SourceManual}
	}
	metadata = Meta("pricing_set", "Set one manual model price for future requests, preserving historical snapshots.", "write", "high")
	metadata.Invalidates = []string{"pricing"}
	if err := capability.Register(registry, metadata, func(ctx context.Context, input PriceInput) (capability.Preview, error) {
		price := toPrice(input)
		if price.Validate() != nil {
			return capability.Preview{}, errors.New("invalid_parameters")
		}
		current, err := s.ListPrices(ctx, PriceQuery{})
		return capability.Preview{Target: price.Model, Revision: current.Revision, Changes: price}, err
	}, func(ctx context.Context, input PriceInput, revision, _ string) (Done, error) {
		price := toPrice(input)
		if price.Validate() != nil {
			return Done{}, errors.New("invalid_parameters")
		}
		err := s.Pricing.SaveManualPricesChecked(ctx, []pricing.ModelPrice{price}, func(current []pricing.ModelPrice) error { return s.checkRevision(current, revision) })
		return Done{err == nil}, err
	}); err != nil {
		return err
	}
	type DeleteInput struct {
		Model string `json:"model"`
	}
	metadata = Meta("pricing_delete", "Delete one current model price. Future sync may recreate an automatic price; historical snapshots remain unchanged.", "destructive", "high")
	metadata.Invalidates = []string{"pricing"}
	return capability.Register(registry, metadata, func(ctx context.Context, input DeleteInput) (capability.Preview, error) {
		if strings.TrimSpace(input.Model) == "" {
			return capability.Preview{}, errors.New("invalid_parameters")
		}
		current, err := s.ListPrices(ctx, PriceQuery{})
		return capability.Preview{Target: input.Model, Revision: current.Revision, Challenge: input.Model, Changes: input}, err
	}, func(ctx context.Context, input DeleteInput, revision, _ string) (Done, error) {
		if s.Pricing == nil {
			return Done{}, errors.New("capability_unavailable")
		}
		deleted, err := s.Pricing.DeletePriceChecked(ctx, input.Model, func(current []pricing.ModelPrice) error { return s.checkRevision(current, revision) })
		return Done{deleted}, err
	})
}
