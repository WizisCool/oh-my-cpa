package pricing

import (
	"context"
	"fmt"
	"slices"
	"strings"
)

// Channel prices use the provider label recorded on usage events, never a route prefix.
func (s *Service) validateChannelModel(ctx context.Context, channel, model string) error {
	providers, err := s.store.ListPricingProviders(ctx)
	if err != nil {
		return err
	}
	for _, provider := range providers {
		if provider.Channel == channel && slices.Contains(provider.Models, model) {
			return nil
		}
	}
	return fmt.Errorf("%w: %q on channel %q", ErrModelNotInCatalog, model, channel)
}

func (s *Service) DeleteChannelPrice(ctx context.Context, channel, model string) (bool, error) {
	channel, model = strings.TrimSpace(channel), strings.TrimSpace(model)
	if channel == "" || model == "" {
		return false, ErrModelNotInCatalog
	}
	s.priceWrites.Lock()
	defer s.priceWrites.Unlock()
	return s.store.DeleteChannelModelPrice(ctx, channel, model)
}
