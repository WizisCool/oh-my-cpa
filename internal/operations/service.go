// Package operations owns business operations shared by console and capability adapters.
package operations

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/capability"
	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/management"
	appcrypto "github.com/oh-my-cpa/oh-my-cpa/internal/crypto"
	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
)

type Service struct {
	TLSSkipVerify bool
	Pricing       Pricing
	Repo          *repository.Repository
	Cipher        *appcrypto.Cipher
	Client        func(context.Context) (*management.Client, error)
	Acquire       func(context.Context) error
	Release       func()
	Notify        func()
	// Existing normalized projections remain shared while HTTP adapters are narrowed.
	SaveProvider               func(context.Context, ProviderMutation, string, string) (ProviderMutationResult, error)
	DeleteProvider             func(context.Context, string, string) error
	RenameProvider             func(context.Context, string, string, string) error
	ListProviders              func(context.Context) ([]Provider, error)
	SetProviderStatus          func(context.Context, ProviderStatus, string) error
	Quotas                     func(context.Context) ([]Quota, error)
	ActOnQuota                 func(context.Context, CredentialTarget, string, string) error
	RefreshQuota               func(context.Context, string) (Quota, error)
	OAuthModelAliases          func(context.Context) (map[string][]OAuthModelAlias, string, error)
	NormalizeOAuthModelAliases func(string, []OAuthModelAlias) (string, []OAuthModelAlias, error)
	SetOAuthModelAliases       func(context.Context, string, []OAuthModelAlias, string) error
	NormalizeCredentialFields  func(map[string]any) (map[string]any, error)
	UpdateCredentialFields     func(context.Context, CredentialTarget, map[string]any, string) error
}
type Empty struct{}
type Done struct {
	IsUpdated bool `json:"is_updated"`
}

func (s *Service) revision(value any) string {
	raw, _ := json.Marshal(value)
	digest, _ := s.Cipher.Fingerprint("capability-revision", string(raw))
	return digest
}
func (s *Service) checkRevision(value any, expected string) error {
	if expected != "" && s.revision(value) != expected {
		return errors.New("resource_conflict")
	}
	return nil
}
func (s *Service) lock(ctx context.Context) (func(), error) {
	if s.Acquire == nil {
		return func() {}, nil
	}
	if err := s.Acquire(ctx); err != nil {
		return nil, errors.New("write_busy")
	}
	return s.Release, nil
}
func Meta(name, description, permission, risk string) capability.Metadata {
	return capability.Metadata{Name: name, Description: description, Version: 1, Permission: permission, Risk: risk, Adapters: []string{"agent", "mcp"}}
}
func read[I, O any](registry *capability.Registry, name, description string, handler func(context.Context, I) (O, error)) error {
	return capability.Register(registry, Meta(name, description, "read", "low"), nil, func(ctx context.Context, input I, _, _ string) (O, error) { return handler(ctx, input) })
}
func (s *Service) Register(registry *capability.Registry) error {
	registrations := []func(*capability.Registry) error{s.registerUsage, s.registerKeys, s.registerConfig, s.registerProviders, s.registerProviderMutations, s.registerOAuth, s.registerQuota, s.registerQuotaActions, s.registerSystem, s.registerPricing, s.registerDatabase, s.registerTimezone, s.registerTpsCalculation, s.registerCustomIcons, s.registerModelSquare}
	for _, register := range registrations {
		if err := register(registry); err != nil {
			return err
		}
	}
	return nil
}
func safeLabel(value string) string {
	value = strings.TrimSpace(value)
	if len(value) > 256 {
		value = value[:256]
	}
	return value
}
func queryContext(ctx context.Context) (context.Context, context.CancelFunc) {
	return context.WithTimeout(ctx, 10*time.Second)
}
