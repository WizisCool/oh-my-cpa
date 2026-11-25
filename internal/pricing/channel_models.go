package pricing

import (
	"context"
	"fmt"
	"slices"
	"sort"
	"strings"
)

const openAICompatibleChannelPrefix = "openai-compatible-"

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
	observed, err := s.store.HasObservedChannelModel(ctx, channel, model)
	if err != nil {
		return err
	}
	if observed {
		return nil
	}
	return fmt.Errorf("%w: %q on channel %q", ErrModelNotInCatalog, model, channel)
}

// EffectiveProviders returns configured CPA providers enriched with serving
// channels observed for active models that CPA's static catalog does not list
// (such as runtime-selected thinking variants or retired models with unpriced traffic).
func (s *Service) EffectiveProviders(ctx context.Context, activeModels map[string]struct{}) ([]CatalogProvider, error) {
	if s == nil || s.store == nil {
		return nil, fmt.Errorf("pricing service is not initialized")
	}
	providers, err := s.store.ListPricingProviders(ctx)
	if err != nil {
		return nil, err
	}
	observed, err := s.observedModels(ctx)
	if err != nil {
		return nil, err
	}
	if len(observed) == 0 {
		return providers, nil
	}
	result := make([]CatalogProvider, len(providers))
	byChannel := make(map[string][]int, len(providers))
	for i, provider := range providers {
		provider.Models = slices.Clone(provider.Models)
		result[i] = provider
		if provider.Channel != "" {
			byChannel[provider.Channel] = append(byChannel[provider.Channel], i)
		}
	}
	modified := make(map[int]bool)
	observedOnly := make(map[string][]string)
	for model, obs := range observed {
		if len(activeModels) > 0 {
			if _, ok := activeModels[model]; !ok {
				continue
			}
		} else if !obs.HasUnpriced && !obs.HasRecentUsage {
			continue
		}
		for _, channel := range obs.Channels {
			channel = strings.TrimSpace(channel)
			if channel == "" {
				continue
			}
			if indices, ok := byChannel[channel]; ok {
				for _, idx := range indices {
					if !slices.Contains(result[idx].Models, model) {
						result[idx].Models = append(result[idx].Models, model)
						modified[idx] = true
					}
				}
			} else {
				observedOnly[channel] = append(observedOnly[channel], model)
			}
		}
	}
	for idx := range modified {
		sort.Strings(result[idx].Models)
		result[idx].Models = slices.Compact(result[idx].Models)
	}
	if len(observedOnly) > 0 {
		channels := make([]string, 0, len(observedOnly))
		for channel := range observedOnly {
			channels = append(channels, channel)
		}
		sort.Strings(channels)
		for _, channel := range channels {
			models := observedOnly[channel]
			sort.Strings(models)
			models = slices.Compact(models)
			family, name, isOAuth := channel, channel, true
			if strings.HasPrefix(channel, openAICompatibleChannelPrefix) {
				family = "openai-compatibility"
				name = strings.TrimPrefix(channel, openAICompatibleChannelPrefix)
				isOAuth = false
			}
			result = append(result, CatalogProvider{
				ID:      "observed:" + channel,
				Family:  family,
				Name:    name,
				Channel: channel,
				IsOAuth: isOAuth,
				Models:  models,
			})
		}
	}
	return result, nil
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
