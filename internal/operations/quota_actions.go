package operations

import (
	"context"
	"github.com/oh-my-cpa/oh-my-cpa/internal/capability"
)

func (s *Service) CheckCredential(ctx context.Context, target CredentialTarget, revision string) error {
	file, err := s.authFile(ctx, target)
	if err != nil {
		return err
	}
	return s.checkRevision(file, revision)
}
func (s *Service) registerQuotaActions(registry *capability.Registry) error {
	for _, action := range []struct{ Name, Description, Action string }{
		{"quota_clear_cooldown", "Clear local cooldown evidence and CPA cooldown for one credential. This does not replenish provider entitlement.", "clear"},
		{"quota_redeem_credit", "Consume an available Codex reset credit for one credential.", "redeem"},
	} {
		metadata := Meta(action.Name, action.Description, "write", "high")
		metadata.Invalidates = []string{"management-quota", "management-auth-files"}
		if err := capability.Register(registry, metadata, func(ctx context.Context, input CredentialTarget) (capability.Preview, error) {
			preview, err := s.credentialPreview(ctx, input, map[string]any{"credential": input, "action": action.Action})
			preview.Challenge = ""
			return preview, err
		}, func(ctx context.Context, input CredentialTarget, revision, _ string) (Done, error) {
			err := s.ActOnQuota(ctx, input, action.Action, revision)
			return Done{err == nil}, err
		}); err != nil {
			return err
		}
	}
	return nil
}
