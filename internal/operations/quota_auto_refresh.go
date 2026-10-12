package operations

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/oh-my-cpa/oh-my-cpa/internal/capability"
	"github.com/oh-my-cpa/oh-my-cpa/internal/quota"
	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
)

func (s *Service) registerQuotaAutoRefresh(registry *capability.Registry) error {
	if err := read(registry, "quota_auto_refresh_get", "Read the automatic quota refresh policy. interval_minutes re-reads credentials whose reading is that old (0 = off); refresh_on_reset re-reads a credential once a window it reported has reset.", func(ctx context.Context, _ Empty) (quota.AutoRefreshSettings, error) {
		raw, isStored, err := s.Repo.GetPreference(ctx, repository.PreferenceQuotaAutoRefresh)
		if err != nil {
			return quota.AutoRefreshSettings{}, err
		}
		return quota.ResolveAutoRefreshSettings(raw, isStored), nil
	}); err != nil {
		return err
	}
	type Input struct {
		IntervalMinutes *int  `json:"interval_minutes,omitempty" jsonschema:"0 turns the schedule off; otherwise 5-1440"`
		RefreshOnReset  *bool `json:"refresh_on_reset,omitempty" jsonschema:"Re-read a credential once a reported window resets"`
	}
	metadata := Meta("quota_auto_refresh_set", "Set the automatic quota refresh policy. Automatic reads call each provider with the credential itself; Meta credentials are never read automatically.", "write", "low")
	metadata.Invalidates = []string{"preferences"}
	return capability.Register(registry, metadata, nil, func(ctx context.Context, input Input, _, _ string) (quota.AutoRefreshSettings, error) {
		if input.IntervalMinutes == nil || input.RefreshOnReset == nil {
			return quota.AutoRefreshSettings{}, errors.New("invalid_parameters")
		}
		settings := quota.AutoRefreshSettings{IntervalMinutes: *input.IntervalMinutes, IsRefreshOnResetEnabled: *input.RefreshOnReset}
		if settings.Validate() != nil {
			return quota.AutoRefreshSettings{}, errors.New("invalid_parameters")
		}
		raw, _ := json.Marshal(settings)
		if err := s.Repo.PutPreference(ctx, repository.PreferenceQuotaAutoRefresh, string(raw)); err != nil {
			return quota.AutoRefreshSettings{}, err
		}
		return settings, nil
	})
}
