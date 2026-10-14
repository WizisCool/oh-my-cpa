package operations

import (
	"context"
	"errors"

	"github.com/google/uuid"
	"github.com/oh-my-cpa/oh-my-cpa/internal/capability"
	"github.com/oh-my-cpa/oh-my-cpa/internal/warmup"
)

func (service *Service) registerWarmup(registry *capability.Registry) error {
	if service.WarmupSettings == nil {
		return nil
	}
	if err := read(registry, "quota_warmup_settings_get", "Read opt-in credential window warmup defaults, timezone and revision. Warmup consumes subscription quota; it never redeems reset entitlements.", func(ctx context.Context, _ Empty) (warmup.Settings, error) { return service.WarmupSettings(ctx) }); err != nil {
		return err
	}
	type Target struct {
		AuthIndex string `json:"auth_index"`
	}
	if err := read(registry, "quota_warmup_credential_get", "Read one credential's effective warmup policy, selected model, verified activation and safe paused reason.", func(ctx context.Context, input Target) (warmup.Credential, error) {
		return service.WarmupCredential(ctx, input.AuthIndex)
	}); err != nil {
		return err
	}
	type SettingsInput struct {
		Provider string        `json:"provider"`
		Policy   warmup.Policy `json:"policy"`
	}
	metadata := Meta("quota_warmup_settings_set", "Change one provider's default warmup policy for existing and future inheriting credentials. Consumes a small amount of quota when enabled. Paid fallback must be explicitly disabled; unverified activation pauses automation.", "write", "high")
	metadata.Invalidates = []string{"quota-warmup-settings", "quota-warmup-credential"}
	if err := capability.Register(registry, metadata, func(ctx context.Context, input SettingsInput) (capability.Preview, error) {
		if !warmup.IsProvider(input.Provider) || input.Policy.Validate() != nil {
			return capability.Preview{}, errors.New("invalid_parameters")
		}
		current, err := service.WarmupSettings(ctx)
		return capability.Preview{Target: input.Provider, Revision: current.Revision, Changes: input}, err
	}, func(ctx context.Context, input SettingsInput, revision, _ string) (warmup.Settings, error) {
		return service.SaveWarmupSettings(ctx, warmup.PolicyWrite{Provider: input.Provider, Policy: input.Policy, Revision: revision, IsConfirmed: true})
	}); err != nil {
		return err
	}
	type CredentialInput struct {
		AuthIndex   string        `json:"auth_index"`
		IsInherited bool          `json:"inherit"`
		Policy      warmup.Policy `json:"policy"`
	}
	metadata = Meta("quota_warmup_credential_set", "Override a credential warmup policy or restore provider inheritance. Requires confirmation; does not modify provider credentials or billing settings.", "write", "high")
	metadata.Invalidates = []string{"quota-warmup-credential"}
	if err := capability.Register(registry, metadata, func(ctx context.Context, input CredentialInput) (capability.Preview, error) {
		if !input.IsInherited && input.Policy.Validate() != nil {
			return capability.Preview{}, errors.New("invalid_parameters")
		}
		current, err := service.WarmupCredential(ctx, input.AuthIndex)
		return capability.Preview{Target: current.Name, Revision: current.Revision, Changes: input}, err
	}, func(ctx context.Context, input CredentialInput, revision, _ string) (warmup.Credential, error) {
		return service.SaveWarmupCredential(ctx, input.AuthIndex, warmup.CredentialWrite{IsInherited: input.IsInherited, Policy: input.Policy, Revision: revision, IsConfirmed: true})
	}); err != nil {
		return err
	}
	metadata = Meta("quota_warmup_run", "Send one tiny request to the exact credential to start an idle subscription window. Human confirmation authorizes quota consumption and initial protocol validation. Unknown billing state, enabled paid fallback and active windows are refused; never retry an uncertain result.", "write", "high")
	metadata.Invalidates = []string{"management-quota", "quota-warmup-credential"}
	return capability.Register(registry, metadata, func(ctx context.Context, input Target) (capability.Preview, error) {
		current, err := service.WarmupCredential(ctx, input.AuthIndex)
		return capability.Preview{Target: current.Name, Revision: current.Revision, Changes: map[string]any{"model": current.Policy.Model, "consumes_quota": true}}, err
	}, func(ctx context.Context, input Target, revision, _ string) (warmup.Result, error) {
		return service.RunWarmup(ctx, input.AuthIndex, uuid.NewString(), revision)
	})
}
