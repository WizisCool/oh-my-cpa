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
	SetModelModeChecked(context.Context, pricing.ModeChange, func([]pricing.ModelPrice) error) (pricing.ModelPrice, error)
	DeletePriceChecked(context.Context, string, func([]pricing.ModelPrice) error) (bool, error)
	ListChannels(context.Context) ([]pricing.ChannelMultiplier, error)
	SetChannelChecked(context.Context, pricing.ChannelMultiplier, func([]pricing.ChannelMultiplier) error) (pricing.ChannelMultiplier, error)
	DeleteChannelChecked(context.Context, string, func([]pricing.ChannelMultiplier) error) (bool, error)
	TriggerSync() bool
}
type PriceQuery struct {
	Model  string `json:"model,omitempty"`
	Offset int    `json:"offset,omitempty"`
}
type PricePage struct {
	Providers []pricing.CatalogProvider   `json:"providers"`
	Items     []pricing.ModelPrice        `json:"items"`
	Channels  []pricing.ChannelMultiplier `json:"channels"`
	HasMore   bool                        `json:"has_more"`
	Revision  string                      `json:"revision"`
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
	channels, err := s.Pricing.ListChannels(ctx)
	if err != nil {
		return PricePage{}, err
	}
	filtered := []pricing.ModelPrice{}
	for _, row := range rows {
		if input.Model == "" || strings.Contains(strings.ToLower(row.Model), strings.ToLower(input.Model)) {
			filtered = append(filtered, row)
		}
	}
	output := PricePage{Items: []pricing.ModelPrice{}, Channels: channels, Revision: s.revision(rows)}
	if output.Channels == nil {
		output.Channels = []pricing.ChannelMultiplier{}
	}
	if input.Offset < len(filtered) {
		end := min(input.Offset+50, len(filtered))
		output.Items = filtered[input.Offset:end]
		output.HasMore = end < len(filtered)
	}
	output.Providers = []pricing.CatalogProvider{}
	if s.Repo != nil {
		providers, err := s.Repo.ListPricingProviders(ctx)
		if err != nil {
			return PricePage{}, err
		}
		selected := make(map[string]bool, len(output.Items))
		for _, item := range output.Items {
			selected[item.Model] = true
		}
		for _, provider := range providers {
			models := []string{}
			for _, model := range provider.Models {
				if selected[model] {
					models = append(models, model)
				}
			}
			if len(models) > 0 {
				provider.Models = models
				output.Providers = append(output.Providers, provider)
			}
		}
	}
	return output, nil
}

// PriceInput is one pricing decision an agent proposes. Rates and tiers only
// matter for mode "custom"; "linked" names an OpenRouter model id; "auto"
// returns the model to automatic matching.
type PriceInput struct {
	Model      string              `json:"model"`
	Mode       string              `json:"mode"`
	UpstreamID string              `json:"upstream_id,omitempty"`
	Prompt     float64             `json:"prompt_price_per_1m,omitempty"`
	Completion float64             `json:"completion_price_per_1m,omitempty"`
	CacheRead  float64             `json:"cache_read_price_per_1m,omitempty"`
	CacheWrite float64             `json:"cache_write_price_per_1m,omitempty"`
	Multiplier float64             `json:"price_multiplier,omitempty"`
	Tiers      []pricing.PriceTier `json:"tiers,omitempty"`
}

func (input PriceInput) modeChange() (pricing.ModeChange, error) {
	change := pricing.ModeChange{
		Model: strings.TrimSpace(input.Model), Mode: input.Mode, UpstreamID: strings.TrimSpace(input.UpstreamID), Multiplier: input.Multiplier,
		Price: pricing.ModelPrice{Model: strings.TrimSpace(input.Model), PromptPricePer1M: input.Prompt, CompletionPer1M: input.Completion,
			CacheReadPer1M: input.CacheRead, CacheWritePer1M: input.CacheWrite, Tiers: input.Tiers},
	}
	if change.Model == "" || change.Multiplier < 0 {
		return change, errors.New("invalid_parameters")
	}
	switch change.Mode {
	case pricing.ModeCustom:
		candidate := change.Price
		candidate.PriceMultiplier = change.Multiplier
		if candidate.PriceMultiplier == 0 {
			candidate.PriceMultiplier = 1
		}
		candidate.Source = pricing.SourceManual
		if candidate.ValidateWrite() != nil {
			return change, errors.New("invalid_parameters")
		}
	case pricing.ModeLinked:
		if change.UpstreamID == "" {
			return change, errors.New("invalid_parameters")
		}
	case pricing.ModeAuto:
	default:
		return change, errors.New("invalid_parameters")
	}
	return change, nil
}

type ChannelInput struct {
	Channel    string  `json:"channel"`
	Multiplier float64 `json:"multiplier"`
	Note       string  `json:"note,omitempty"`
}

func (s *Service) registerPricing(registry *capability.Registry) error {
	if err := read(registry, "pricing_list", "Read current model prices (mode auto, linked or custom, OpenRouter id, tiers) and channel multipliers, paginated. Historical request cost snapshots do not change when current prices change.", s.ListPrices); err != nil {
		return err
	}
	metadata := Meta("pricing_sync", "Request a price refresh from OpenRouter, the configured pricing source.", "write", "high")
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
	metadata = Meta("pricing_set", "Decide how one model is priced for future requests: mode custom (operator rates and optional tiers), linked (follow one OpenRouter model id) or auto (automatic OpenRouter match). Historical snapshots never change.", "write", "high")
	metadata.Invalidates = []string{"pricing"}
	if err := capability.Register(registry, metadata, func(ctx context.Context, input PriceInput) (capability.Preview, error) {
		if s.Pricing == nil {
			return capability.Preview{}, errors.New("capability_unavailable")
		}
		change, err := input.modeChange()
		if err != nil {
			return capability.Preview{}, err
		}
		current, err := s.ListPrices(ctx, PriceQuery{})
		return capability.Preview{Target: change.Model, Revision: current.Revision, Changes: input}, err
	}, func(ctx context.Context, input PriceInput, revision, _ string) (Done, error) {
		if s.Pricing == nil {
			return Done{}, errors.New("capability_unavailable")
		}
		change, err := input.modeChange()
		if err != nil {
			return Done{}, err
		}
		_, err = s.Pricing.SetModelModeChecked(ctx, change, func(current []pricing.ModelPrice) error { return s.checkRevision(current, revision) })
		return Done{err == nil}, err
	}); err != nil {
		return err
	}
	type DeleteInput struct {
		Model string `json:"model"`
	}
	metadata = Meta("pricing_delete", "Delete one current model price and its OpenRouter pin. A future sync may recreate an automatic price; historical snapshots remain unchanged.", "destructive", "high")
	metadata.Invalidates = []string{"pricing"}
	if err := capability.Register(registry, metadata, func(ctx context.Context, input DeleteInput) (capability.Preview, error) {
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
	}); err != nil {
		return err
	}
	channelRevision := func(ctx context.Context) (string, error) {
		if s.Pricing == nil {
			return "", errors.New("capability_unavailable")
		}
		channels, err := s.Pricing.ListChannels(ctx)
		return s.revision(channels), err
	}
	metadata = Meta("pricing_channel_set", "Set the multiplier applied to every future request one CPA provider (channel) answers, on top of the model price; 0.3 means the channel costs 30% of list price. Historical snapshots never change.", "write", "high")
	metadata.Invalidates = []string{"pricing"}
	if err := capability.Register(registry, metadata, func(ctx context.Context, input ChannelInput) (capability.Preview, error) {
		channel := pricing.ChannelMultiplier{Channel: input.Channel, Multiplier: input.Multiplier, Note: input.Note}
		if channel.Validate() != nil {
			return capability.Preview{}, errors.New("invalid_parameters")
		}
		revision, err := channelRevision(ctx)
		return capability.Preview{Target: channel.Channel, Revision: revision, Changes: channel}, err
	}, func(ctx context.Context, input ChannelInput, revision, _ string) (Done, error) {
		if s.Pricing == nil {
			return Done{}, errors.New("capability_unavailable")
		}
		channel := pricing.ChannelMultiplier{Channel: input.Channel, Multiplier: input.Multiplier, Note: input.Note}
		_, err := s.Pricing.SetChannelChecked(ctx, channel, func(current []pricing.ChannelMultiplier) error { return s.checkRevision(current, revision) })
		return Done{err == nil}, err
	}); err != nil {
		return err
	}
	type ChannelDeleteInput struct {
		Channel string `json:"channel"`
	}
	metadata = Meta("pricing_channel_delete", "Remove one channel multiplier, returning that CPA provider to 1x for future requests. Historical snapshots never change.", "destructive", "high")
	metadata.Invalidates = []string{"pricing"}
	return capability.Register(registry, metadata, func(ctx context.Context, input ChannelDeleteInput) (capability.Preview, error) {
		if strings.TrimSpace(input.Channel) == "" {
			return capability.Preview{}, errors.New("invalid_parameters")
		}
		revision, err := channelRevision(ctx)
		return capability.Preview{Target: input.Channel, Revision: revision, Challenge: input.Channel, Changes: input}, err
	}, func(ctx context.Context, input ChannelDeleteInput, revision, _ string) (Done, error) {
		if s.Pricing == nil {
			return Done{}, errors.New("capability_unavailable")
		}
		deleted, err := s.Pricing.DeleteChannelChecked(ctx, input.Channel, func(current []pricing.ChannelMultiplier) error { return s.checkRevision(current, revision) })
		return Done{deleted}, err
	})
}
