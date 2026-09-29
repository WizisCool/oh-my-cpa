package operations

import (
	"context"
	"errors"
	"strings"

	"github.com/oh-my-cpa/oh-my-cpa/internal/capability"
	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
	"github.com/oh-my-cpa/oh-my-cpa/internal/security"
)

type Key struct {
	Index       int    `json:"index"`
	Fingerprint string `json:"fingerprint"`
	Mask        string `json:"mask"`
	Alias       string `json:"alias"`
	Version     int64  `json:"version"`
}
type Keys struct {
	Items    []Key  `json:"items"`
	Revision string `json:"revision"`
}

func (s *Service) ListKeys(ctx context.Context, _ Empty) (Keys, error) {
	client, err := s.Client(ctx)
	if err != nil {
		return Keys{}, err
	}
	keys, err := client.ClientAPIKeys(ctx)
	if err != nil {
		return Keys{}, err
	}
	aliases, err := s.Repo.ListClientKeyAliases(ctx, "default")
	if err != nil {
		return Keys{}, err
	}
	result := Keys{Items: []Key{}, Revision: s.revision(keys)}
	if len(keys) > 100 {
		return Keys{}, errors.New("tool_result_too_large")
	}
	for index, key := range keys {
		fingerprint, err := s.Repo.UsageClientKeyFingerprint(strings.TrimSpace(key))
		if err != nil {
			return Keys{}, err
		}
		alias := aliases[fingerprint]
		result.Items = append(result.Items, Key{index, fingerprint, security.MaskSecret(key), safeLabel(alias.Alias), alias.Version})
	}
	return result, nil
}
func (s *Service) CreateKey(ctx context.Context, secret, revision string) (int, error) {
	secret = strings.TrimSpace(secret)
	if len(secret) == 0 || len(secret) > 8192 {
		return 0, errors.New("secret_required")
	}
	release, err := s.lock(ctx)
	if err != nil {
		return 0, err
	}
	defer release()
	client, err := s.Client(ctx)
	if err != nil {
		return 0, err
	}
	keys, err := client.ClientAPIKeys(ctx)
	if err != nil {
		return 0, err
	}
	if err = s.checkRevision(keys, revision); err != nil {
		return 0, err
	}
	for _, key := range keys {
		if key == secret {
			return 0, errors.New("resource_conflict")
		}
	}
	if err = client.UpdateClientAPIKeys(ctx, append(keys, secret)); err != nil {
		return 0, configWriteOutcome(err)
	}
	return len(keys), nil
}
func (s *Service) DeleteKey(ctx context.Context, index int, fingerprint, revision string) error {
	release, err := s.lock(ctx)
	if err != nil {
		return err
	}
	defer release()
	client, err := s.Client(ctx)
	if err != nil {
		return err
	}
	keys, err := client.ClientAPIKeys(ctx)
	if err != nil {
		return err
	}
	if index < 0 || index >= len(keys) {
		return errors.New("resource_missing")
	}
	if err = s.checkRevision(keys, revision); err != nil {
		return err
	}
	if fingerprint != "" {
		actual, err := s.Repo.UsageClientKeyFingerprint(strings.TrimSpace(keys[index]))
		if err != nil {
			return err
		}
		if actual != fingerprint {
			return errors.New("resource_conflict")
		}
	}
	if err = client.UpdateClientAPIKeys(ctx, append(keys[:index:index], keys[index+1:]...)); err != nil {
		return configWriteOutcome(err)
	}
	return nil
}

type KeyTarget struct {
	Index       int    `json:"index"`
	Fingerprint string `json:"fingerprint"`
}

func (s *Service) registerKeys(registry *capability.Registry) error {
	if err := read(registry, "keys_list", "List client key identities and display masks, never secrets.", s.ListKeys); err != nil {
		return err
	}
	type AliasInput struct {
		Fingerprint string `json:"fingerprint"`
		Alias       string `json:"alias"`
		Version     int64  `json:"version"`
	}
	metadata := Meta("keys_set_alias", "Change a display-only client key alias using its current version.", "write", "low")
	metadata.Invalidates = []string{"client-key-aliases", "client-api-keys", "playground-keys", "management-client-keys", "management-config"}
	if err := capability.Register(registry, metadata, nil, func(ctx context.Context, input AliasInput, _, _ string) (repository.ClientKeyAlias, error) {
		return s.Repo.SetClientKeyAlias(ctx, "default", input.Fingerprint, input.Alias, input.Version)
	}); err != nil {
		return err
	}
	metadata = Meta("keys_create", "Create a client API key. The operator supplies the key privately in OMC.", "write", "high")
	metadata.HumanInput = "secret"
	metadata.Invalidates = []string{"client-api-keys", "playground-keys", "management-client-keys", "management-config"}
	if err := capability.Register(registry, metadata, func(ctx context.Context, _ Empty) (capability.Preview, error) {
		keys, err := s.ListKeys(ctx, Empty{})
		return capability.Preview{Target: "client_api_keys", Revision: keys.Revision, Changes: map[string]string{"action": "create"}}, err
	}, func(ctx context.Context, _ Empty, revision, secret string) (Done, error) {
		_, err := s.CreateKey(ctx, secret, revision)
		return Done{err == nil}, err
	}); err != nil {
		return err
	}
	metadata = Meta("keys_delete", "Delete one client key; all callers using it lose access.", "destructive", "high")
	metadata.Invalidates = []string{"client-api-keys", "playground-keys", "management-client-keys", "management-config"}
	return capability.Register(registry, metadata, func(ctx context.Context, input KeyTarget) (capability.Preview, error) {
		keys, err := s.ListKeys(ctx, Empty{})
		if err != nil {
			return capability.Preview{}, err
		}
		for _, key := range keys.Items {
			if key.Index == input.Index && key.Fingerprint == input.Fingerprint {
				return capability.Preview{Target: key.Fingerprint, Revision: keys.Revision, Changes: key}, nil
			}
		}
		return capability.Preview{}, errors.New("resource_conflict")
	}, func(ctx context.Context, input KeyTarget, revision, _ string) (Done, error) {
		err := s.DeleteKey(ctx, input.Index, input.Fingerprint, revision)
		return Done{err == nil}, err
	})
}
