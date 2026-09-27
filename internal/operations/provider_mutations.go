package operations

import (
	"context"
	"errors"
	"net/url"
	"strings"

	"github.com/oh-my-cpa/oh-my-cpa/internal/capability"
)

type ProviderModel struct {
	Name  string `json:"name"`
	Alias string `json:"alias,omitempty"`
}
type ProviderMutation struct {
	ID       string           `json:"id,omitempty"`
	Family   string           `json:"family,omitempty"`
	Name     *string          `json:"name,omitempty"`
	BaseURL  *string          `json:"base_url,omitempty"`
	Prefix   *string          `json:"prefix,omitempty"`
	Models   *[]ProviderModel `json:"models,omitempty"`
	Priority *int             `json:"priority,omitempty"`
}
type ProviderMutationResult struct {
	ID string `json:"id"`
}

func (input ProviderMutation) Validate(isCreate bool) error {
	if isCreate && (input.ID != "" || input.Name == nil || strings.TrimSpace(*input.Name) == "" || input.BaseURL == nil) {
		return errors.New("invalid_parameters")
	}
	if !isCreate && input.ID == "" {
		return errors.New("invalid_parameters")
	}
	if input.Name != nil && (len(*input.Name) > 256 || strings.TrimSpace(*input.Name) == "") {
		return errors.New("invalid_parameters")
	}
	if input.Prefix != nil && len(*input.Prefix) > 256 {
		return errors.New("invalid_parameters")
	}
	if input.Models != nil {
		if len(*input.Models) > 100 {
			return errors.New("invalid_parameters")
		}
		for _, model := range *input.Models {
			if model.Name == "" || len(model.Name) > 512 || len(model.Alias) > 512 {
				return errors.New("invalid_parameters")
			}
		}
	}
	if input.BaseURL != nil {
		parsed, err := url.Parse(*input.BaseURL)
		if err != nil || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" || parsed.Scheme != "https" && parsed.Scheme != "http" {
			return errors.New("invalid_parameters")
		}
	}
	return nil
}
func (s *Service) registerProviderMutations(registry *capability.Registry) error {
	metadata := Meta("providers_create", "Create an API provider. Supply its upstream key only in the OMC private form.", "write", "high")
	metadata.HumanInput = "secret"
	metadata.Invalidates = []string{"providers", "management-providers", "pricing"}
	if err := capability.Register(registry, metadata, func(_ context.Context, input ProviderMutation) (capability.Preview, error) {
		if err := input.Validate(true); err != nil {
			return capability.Preview{}, err
		}
		return capability.Preview{Target: input.Family, Revision: "create", Changes: input}, nil
	}, func(ctx context.Context, input ProviderMutation, revision, secret string) (ProviderMutationResult, error) {
		if err := input.Validate(true); err != nil {
			return ProviderMutationResult{}, err
		}
		return s.SaveProvider(ctx, input, revision, secret)
	}); err != nil {
		return err
	}
	metadata = Meta("providers_update", "Edit routing name, endpoint, prefix, priority or model mappings of one provider. Existing credentials are reused at the new endpoint.", "write", "high")
	metadata.Invalidates = []string{"providers", "management-providers", "pricing"}
	if err := capability.Register(registry, metadata, func(ctx context.Context, input ProviderMutation) (capability.Preview, error) {
		if err := input.Validate(false); err != nil {
			return capability.Preview{}, err
		}
		current, err := s.FindProvider(ctx, input.ID)
		return capability.Preview{Target: input.ID, Revision: current.Revision, Changes: map[string]any{"changes": input, "reuses_existing_credentials": input.BaseURL != nil, "current_provider": current}}, err
	}, func(ctx context.Context, input ProviderMutation, revision, _ string) (ProviderMutationResult, error) {
		if err := input.Validate(false); err != nil {
			return ProviderMutationResult{}, err
		}
		return s.SaveProvider(ctx, input, revision, "")
	}); err != nil {
		return err
	}
	type Target struct {
		ID string `json:"id"`
	}
	metadata = Meta("providers_delete", "Delete exactly one provider and its credentials and mappings. Calls routed to it will lose that route.", "destructive", "high")
	metadata.Invalidates = []string{"providers", "management-providers", "pricing"}
	if err := capability.Register(registry, metadata, func(ctx context.Context, input Target) (capability.Preview, error) {
		current, err := s.FindProvider(ctx, input.ID)
		return capability.Preview{Target: input.ID, Revision: current.Revision, Changes: current, Challenge: input.ID}, err
	}, func(ctx context.Context, input Target, revision, _ string) (Done, error) {
		err := s.DeleteProvider(ctx, input.ID, revision)
		return Done{err == nil}, err
	}); err != nil {
		return err
	}
	type Rename struct {
		ID       string `json:"id"`
		Revision string `json:"revision"`
		Name     string `json:"name"`
	}
	metadata = Meta("providers_set_display_name", "Change only the OMC display name, not the upstream routing name.", "write", "low")
	metadata.Invalidates = []string{"providers", "management-providers", "preferences"}
	return capability.Register(registry, metadata, nil, func(ctx context.Context, input Rename, _, _ string) (Done, error) {
		if input.Revision == "" || strings.TrimSpace(input.Name) == "" || len(input.Name) > 256 {
			return Done{}, errors.New("invalid_parameters")
		}
		err := s.RenameProvider(ctx, input.ID, input.Name, input.Revision)
		return Done{err == nil}, err
	})
}
