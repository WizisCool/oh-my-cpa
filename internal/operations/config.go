package operations

import (
	"context"
	"errors"

	"github.com/oh-my-cpa/oh-my-cpa/internal/capability"
	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/management"
)

var AGENT_CONFIG_KEYS = map[string]bool{"request_retry": true, "max_retry_interval": true, "max_retry_credentials": true, "routing_strategy": true, "force_model_prefix": true}

type ConfigView struct {
	Values   map[string]any `json:"values"`
	Revision string         `json:"revision"`
}

func (s *Service) ReadConfig(ctx context.Context, _ Empty) (ConfigView, error) {
	client, err := s.Client(ctx)
	if err != nil {
		return ConfigView{}, err
	}
	values, err := client.ConfigScalars(ctx)
	if err != nil {
		return ConfigView{}, err
	}
	safe := map[string]any{"request_retry": values.RequestRetry, "max_retry_interval": values.MaxRetryInterval, "max_retry_credentials": values.MaxRetryCredentials, "routing_strategy": values.RoutingStrategy, "force_model_prefix": values.ForceModelPrefix}
	return ConfigView{safe, s.revision(values)}, nil
}
func (s *Service) SetScalar(ctx context.Context, key string, value any, revision string) error {
	validated, err := ValidateScalarValue(key, value)
	if err != nil {
		return err
	}
	release, err := s.lock(ctx)
	if err != nil {
		return err
	}
	defer release()
	client, err := s.Client(ctx)
	if err != nil {
		return err
	}
	if revision != "" {
		current, err := client.ConfigScalars(ctx)
		if err != nil {
			return err
		}
		if err = s.checkRevision(current, revision); err != nil {
			return err
		}
	}
	if err = client.UpdateConfigScalar(ctx, key, validated); err != nil {
		return configWriteOutcome(err)
	}
	if s.Notify != nil {
		s.Notify()
	}
	return nil
}
func (s *Service) registerConfig(registry *capability.Registry) error {
	if err := read(registry, "config_read", "Read allowlisted routing and retry settings; no raw YAML or proxy credentials.", s.ReadConfig); err != nil {
		return err
	}
	type Input struct {
		Key   string `json:"key"`
		Value any    `json:"value"`
	}
	metadata := Meta("config_set", "Change one allowlisted routing or retry setting after confirmation.", "write", "high")
	metadata.Invalidates = []string{"management-config", "management-config-source"}
	return capability.Register(registry, metadata, func(ctx context.Context, input Input) (capability.Preview, error) {
		if !AGENT_CONFIG_KEYS[input.Key] {
			return capability.Preview{}, errors.New("capability_forbidden")
		}
		if _, err := ValidateScalarValue(input.Key, input.Value); err != nil {
			return capability.Preview{}, errors.New("invalid_parameters")
		}
		current, err := s.ReadConfig(ctx, Empty{})
		return capability.Preview{Target: input.Key, Revision: current.Revision, Changes: map[string]any{"before": current.Values[input.Key], "after": input.Value}}, err
	}, func(ctx context.Context, input Input, revision, _ string) (Done, error) {
		if !AGENT_CONFIG_KEYS[input.Key] {
			return Done{}, errors.New("capability_forbidden")
		}
		err := s.SetScalar(ctx, input.Key, input.Value, revision)
		return Done{err == nil}, err
	})
}

// configWriteOutcome reports a failed configuration write. A write CPA refused,
// or one refused before anything was sent, is known not to have changed the
// file, so it keeps its own error; anything else may have landed.
func configWriteOutcome(err error) error {
	if errors.Is(err, management.ErrConfigBackupUnavailable) || errors.Is(err, management.ErrManagementV8Required) {
		return err
	}
	if _, rejected := management.IsConfigRejected(err); rejected {
		return err
	}
	return errors.New("operation_outcome_unknown")
}
