package operations

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/oh-my-cpa/oh-my-cpa/internal/capability"
	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
)

type TpsCalculationInfo struct {
	Mode repository.TpsCalculationMode `json:"mode"`
}

func (s *Service) registerTpsCalculation(registry *capability.Registry) error {
	if err := read(registry, "tps_calculation_get", "Read the deployment-wide TPS calculation mode. exclude_ttft subtracts measurable first-token latency, falling back to total latency when unavailable; include_ttft uses total latency.", func(ctx context.Context, _ Empty) (TpsCalculationInfo, error) {
		mode, err := s.Repo.ReadTpsCalculationMode(ctx)
		return TpsCalculationInfo{Mode: mode}, err
	}); err != nil {
		return err
	}
	type Input struct {
		Mode repository.TpsCalculationMode `json:"mode,omitempty" jsonschema:"TPS calculation mode: exclude_ttft or include_ttft"`
	}
	metadata := Meta("tps_calculation_set", "Set the deployment-wide TPS display calculation for request records and Playground. This does not alter recorded timings or usage.", "write", "low")
	metadata.Invalidates = []string{"preferences"}
	return capability.Register(registry, metadata, nil, func(ctx context.Context, input Input, _, _ string) (TpsCalculationInfo, error) {
		if input.Mode != repository.TpsExcludeTTFT && input.Mode != repository.TpsIncludeTTFT {
			return TpsCalculationInfo{}, errors.New("invalid_parameters")
		}
		raw, _ := json.Marshal(input.Mode)
		if err := s.Repo.PutPreference(ctx, repository.PreferenceTpsCalculationMode, string(raw)); err != nil {
			return TpsCalculationInfo{}, err
		}
		return TpsCalculationInfo{Mode: input.Mode}, nil
	})
}
