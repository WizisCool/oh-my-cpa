package operations

import (
	"context"
	"errors"
	"github.com/oh-my-cpa/oh-my-cpa/internal/capability"
)

type Provider struct {
	ID           string   `json:"id"`
	Family       string   `json:"family"`
	Index        int      `json:"index"`
	Name         string   `json:"name"`
	UpstreamName string   `json:"upstream_name"`
	AuthIndex    string   `json:"auth_index"`
	IsDisabled   bool     `json:"is_disabled"`
	Models       []string `json:"models"`
	Revision     string   `json:"revision"`
}
type ProviderStatus struct {
	ID         string `json:"id"`
	IsDisabled bool   `json:"is_disabled"`
}

func (s *Service) FindProvider(ctx context.Context, id string) (Provider, error) {
	items, err := s.ListProviders(ctx)
	if err != nil {
		return Provider{}, err
	}
	for _, item := range items {
		if item.ID == id {
			return item, nil
		}
	}
	return Provider{}, errors.New("resource_missing")
}
func (s *Service) registerProviders(registry *capability.Registry) error {
	type List struct {
		Items []Provider `json:"items"`
	}
	if err := read(registry, "providers_list", "List configured API providers and callable model mappings. IDs, not labels, identify targets.", func(ctx context.Context, _ Empty) (List, error) {
		items, err := s.ListProviders(ctx)
		if len(items) > 100 {
			return List{}, errors.New("tool_result_too_large")
		}
		return List{items}, err
	}); err != nil {
		return err
	}
	if err := read(registry, "providers_get", "Inspect one API provider's safe state.", func(ctx context.Context, input struct {
		ID string `json:"id"`
	}) (Provider, error) {
		return s.FindProvider(ctx, input.ID)
	}); err != nil {
		return err
	}
	metadata := Meta("providers_set_status", "Enable or disable exactly one API provider. Disabling interrupts its availability for callers.", "write", "high")
	metadata.Invalidates = []string{"management-providers", "providers"}
	return capability.Register(registry, metadata, func(ctx context.Context, input ProviderStatus) (capability.Preview, error) {
		current, err := s.FindProvider(ctx, input.ID)
		return capability.Preview{Target: input.ID, Revision: current.Revision, Changes: map[string]any{"provider": current, "is_disabled": input.IsDisabled}}, err
	}, func(ctx context.Context, input ProviderStatus, revision, _ string) (Done, error) {
		err := s.SetProviderStatus(ctx, input, revision)
		return Done{err == nil}, err
	})
}
