package operations

import (
	"context"
	"encoding/json"
	"github.com/oh-my-cpa/oh-my-cpa/internal/capability"
	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
)

func (s *Service) registerTimezone(registry *capability.Registry) error {
	if err := read(registry, "timezone_get", "Read the OMC deployment timezone, optional override, and effective timezone. Stored timestamps remain absolute instants.", func(ctx context.Context, _ Empty) (repository.TimezoneInfo, error) { return s.Repo.ReadTimezone(ctx) }); err != nil {
		return err
	}
	type Input struct {
		Timezone string `json:"timezone" jsonschema:"IANA timezone name; empty string restores the server deployment timezone"`
	}
	metadata := Meta("timezone_set", "Set the deployment-wide OMC timezone for calendar days, console timestamps and service logs.", "write", "low")
	metadata.Invalidates = []string{"preferences", "timezone"}
	return capability.Register(registry, metadata, nil, func(ctx context.Context, input Input, _, _ string) (repository.TimezoneInfo, error) {
		raw, _ := json.Marshal(input.Timezone)
		if err := s.Repo.PutPreference(ctx, repository.PreferenceTimezone, string(raw)); err != nil {
			return repository.TimezoneInfo{}, err
		}
		return s.Repo.ReadTimezone(ctx)
	})
}
