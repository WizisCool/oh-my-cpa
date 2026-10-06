package operations

import (
	"context"
	"errors"
	"github.com/oh-my-cpa/oh-my-cpa/internal/capability"
	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/management"
)

type Credential struct {
	Name       string `json:"name"`
	AuthIndex  string `json:"auth_index"`
	Provider   string `json:"provider"`
	Status     string `json:"status"`
	IsDisabled bool   `json:"is_disabled"`
	Revision   string `json:"revision"`
}
type Credentials struct {
	Items []Credential `json:"items"`
}
type OAuthModelAlias struct {
	Name         string `json:"name"`
	Alias        string `json:"alias"`
	Fork         bool   `json:"fork,omitempty"`
	DisplayName  string `json:"display_name,omitempty"`
	ForceMapping bool   `json:"force_mapping,omitempty"`
}
type OAuthModelAliasView struct {
	Aliases  map[string][]OAuthModelAlias `json:"aliases"`
	Revision string                       `json:"revision"`
}
type OAuthExcludedModelsView struct {
	ExcludedModels map[string][]string `json:"excluded_models"`
	Revision       string              `json:"revision"`
}
type CredentialTarget struct {
	Name      string `json:"name"`
	AuthIndex string `json:"auth_index"`
}

func (s *Service) authFile(ctx context.Context, target CredentialTarget) (management.AuthFile, error) {
	client, err := s.Client(ctx)
	if err != nil {
		return management.AuthFile{}, err
	}
	files, err := client.AuthFiles(ctx)
	if err != nil {
		return management.AuthFile{}, err
	}
	var found management.AuthFile
	matches := 0
	for _, file := range files.Files {
		if file.Name == target.Name && file.AuthIndex == target.AuthIndex {
			found = file
			matches++
		}
	}
	if matches != 1 {
		return management.AuthFile{}, errors.New("resource_conflict")
	}
	return found, nil
}
func (s *Service) credentialPreview(ctx context.Context, target CredentialTarget, changes any) (capability.Preview, error) {
	file, err := s.authFile(ctx, target)
	return capability.Preview{Target: target.Name, Revision: s.revision(file), Changes: changes}, err
}

// SetCredentialStatus shares the same write gate with console updates and provider writes.
func (s *Service) SetCredentialStatus(ctx context.Context, target CredentialTarget, isDisabled bool, revision string) error {
	release, err := s.lock(ctx)
	if err != nil {
		return err
	}
	defer release()
	if revision != "" {
		file, err := s.authFile(ctx, target)
		if err != nil {
			return err
		}
		if err := s.checkRevision(file, revision); err != nil {
			return err
		}
	}
	client, err := s.Client(ctx)
	if err != nil {
		return err
	}
	if _, err := client.PatchAuthFileStatus(ctx, target.Name, target.AuthIndex, isDisabled); err != nil {
		return err
	}
	if s.Notify != nil {
		s.Notify()
	}
	return nil
}

// RefreshCredential renews one credential's tokens now. The target is resolved
// first so a stale or ambiguous selector never reaches CPA, which matches by
// name alone when the index is empty.
func (s *Service) RefreshCredential(ctx context.Context, target CredentialTarget, revision string) error {
	release, err := s.lock(ctx)
	if err != nil {
		return err
	}
	defer release()
	file, err := s.authFile(ctx, target)
	if err != nil {
		return err
	}
	if revision != "" {
		if err := s.checkRevision(file, revision); err != nil {
			return err
		}
	}
	client, err := s.Client(ctx)
	if err != nil {
		return err
	}
	if err := client.RefreshAuthFile(ctx, file.Name, file.AuthIndex); err != nil {
		return err
	}
	if s.Notify != nil {
		s.Notify()
	}
	return nil
}

// AGENT_CREDENTIAL_FIELDS is the agent-facing subset of the console's auth-file field
// allowlist. headers and proxy_url are excluded because both can carry credential material.
var AGENT_CREDENTIAL_FIELDS = map[string]bool{"prefix": true, "priority": true, "weight": true, "note": true, "excluded_models": true, "expired": true, "disable_cooling": true, "websockets": true, "using_api": true, "request_retry": true, "request_scoped_errors": true, "model_aliases": true}

func (s *Service) normalizeAgentCredentialFields(fields map[string]any) (map[string]any, error) {
	if len(fields) == 0 || len(fields) > 16 {
		return nil, errors.New("invalid_parameters")
	}
	for key := range fields {
		if !AGENT_CREDENTIAL_FIELDS[key] {
			return nil, errors.New("capability_forbidden")
		}
	}
	if s.NormalizeCredentialFields == nil {
		return nil, errors.New("capability_unavailable")
	}
	return s.NormalizeCredentialFields(fields)
}

func (s *Service) registerOAuth(registry *capability.Registry) error {
	if err := read(registry, "oauth_credentials_list", "List OAuth credential identities and status without tokens, emails, account metadata or raw errors.", func(ctx context.Context, _ Empty) (Credentials, error) {
		client, err := s.Client(ctx)
		if err != nil {
			return Credentials{}, err
		}
		files, err := client.AuthFiles(ctx)
		output := Credentials{Items: []Credential{}}
		if len(files.Files) > 100 {
			return output, errors.New("tool_result_too_large")
		}
		for _, file := range files.Files {
			output.Items = append(output.Items, Credential{safeLabel(file.Name), file.AuthIndex, file.Provider, file.Status, file.Disabled, s.revision(file)})
		}
		return output, err
	}); err != nil {
		return err
	}
	type StatusInput struct {
		Name       string `json:"name"`
		AuthIndex  string `json:"auth_index"`
		IsDisabled bool   `json:"is_disabled"`
	}
	metadata := Meta("oauth_set_status", "Enable or disable one OAuth credential after confirming its identity.", "write", "high")
	metadata.Invalidates = []string{"management-auth-files", "management-quota"}
	if err := capability.Register(registry, metadata, func(ctx context.Context, input StatusInput) (capability.Preview, error) {
		return s.credentialPreview(ctx, CredentialTarget{input.Name, input.AuthIndex}, input)
	}, func(ctx context.Context, input StatusInput, revision, _ string) (Done, error) {
		err := s.SetCredentialStatus(ctx, CredentialTarget{input.Name, input.AuthIndex}, input.IsDisabled, revision)
		return Done{err == nil}, err
	}); err != nil {
		return err
	}
	metadata = Meta("oauth_refresh_credential", "Renew one OAuth credential's tokens now instead of waiting for its scheduled refresh. Reports only whether it succeeded.", "write", "high")
	metadata.Invalidates = []string{"management-auth-files", "management-quota"}
	if err := capability.Register(registry, metadata, func(ctx context.Context, input CredentialTarget) (capability.Preview, error) {
		return s.credentialPreview(ctx, input, input)
	}, func(ctx context.Context, input CredentialTarget, revision, _ string) (Done, error) {
		err := s.RefreshCredential(ctx, input, revision)
		return Done{err == nil}, err
	}); err != nil {
		return err
	}
	metadata = Meta("oauth_delete", "Permanently delete one OAuth credential. Its authorization will no longer be available.", "destructive", "high")
	metadata.Invalidates = []string{"management-auth-files", "management-quota"}
	if err := capability.Register(registry, metadata, func(ctx context.Context, input CredentialTarget) (capability.Preview, error) {
		return s.credentialPreview(ctx, input, input)
	}, func(ctx context.Context, input CredentialTarget, revision, _ string) (Done, error) {
		release, err := s.lock(ctx)
		if err != nil {
			return Done{}, err
		}
		defer release()
		file, err := s.authFile(ctx, input)
		if err != nil {
			return Done{}, err
		}
		if err = s.checkRevision(file, revision); err != nil {
			return Done{}, err
		}
		client, err := s.Client(ctx)
		if err != nil {
			return Done{}, err
		}
		_, err = client.DeleteAuthFiles(ctx, []string{file.Name})
		if err != nil {
			return Done{}, errors.New("operation_outcome_unknown")
		}
		remaining, err := client.AuthFiles(ctx)
		if err != nil {
			return Done{}, errors.New("operation_outcome_unknown")
		}
		for _, entry := range remaining.Files {
			if entry.Name == file.Name {
				return Done{}, errors.New("operation_outcome_unknown")
			}
		}
		return Done{true}, nil
	}); err != nil {
		return err
	}
	// The console allowlist also carries headers and proxy_url, which can transport
	// credentials. The agent-facing capability deliberately exposes only fields that
	// cannot hold a secret, so a value can never enter the model context through a preview.
	type FieldsInput struct {
		Name      string         `json:"name"`
		AuthIndex string         `json:"auth_index"`
		Fields    map[string]any `json:"fields"`
	}
	metadata = Meta("oauth_set_credential_fields", "Edit allowlisted routing metadata of one OAuth credential: prefix, priority, weight, note, excluded_models, expired, disable_cooling, websockets, using_api, request_retry (null inherits), request_scoped_errors (rules of status, match, match_regex and action; an empty list clears them), model_aliases (entries of name, alias and optional fork, display_name and force_mapping; an empty list clears them). Credential secrets, headers and proxy URLs are not accepted here.", "write", "high")
	metadata.Invalidates = []string{"management-auth-files", "management-quota", "pricing"}
	if err := capability.Register(registry, metadata, func(ctx context.Context, input FieldsInput) (capability.Preview, error) {
		fields, err := s.normalizeAgentCredentialFields(input.Fields)
		if err != nil {
			return capability.Preview{}, err
		}
		return s.credentialPreview(ctx, CredentialTarget{Name: input.Name, AuthIndex: input.AuthIndex}, map[string]any{"credential": CredentialTarget{Name: input.Name, AuthIndex: input.AuthIndex}, "fields": fields})
	}, func(ctx context.Context, input FieldsInput, revision, _ string) (Done, error) {
		if s.UpdateCredentialFields == nil {
			return Done{}, errors.New("capability_unavailable")
		}
		fields, err := s.normalizeAgentCredentialFields(input.Fields)
		if err != nil {
			return Done{}, err
		}
		err = s.UpdateCredentialFields(ctx, CredentialTarget{Name: input.Name, AuthIndex: input.AuthIndex}, fields, revision)
		return Done{err == nil}, err
	}); err != nil {
		return err
	}
	if err := read(registry, "oauth_model_aliases_list", "Read the global per-provider OAuth model alias mappings without credential material.", func(ctx context.Context, _ Empty) (OAuthModelAliasView, error) {
		if s.OAuthModelAliases == nil {
			return OAuthModelAliasView{}, errors.New("capability_unavailable")
		}
		aliases, revision, err := s.OAuthModelAliases(ctx)
		if aliases == nil {
			aliases = map[string][]OAuthModelAlias{}
		}
		return OAuthModelAliasView{Aliases: aliases, Revision: revision}, err
	}); err != nil {
		return err
	}
	type SetAliasesInput struct {
		Provider string            `json:"provider"`
		Aliases  []OAuthModelAlias `json:"aliases"`
	}
	metadata = Meta("oauth_set_model_aliases", "Replace one provider's OAuth model alias mapping after confirmation. Empty aliases delete the mapping.", "write", "high")
	metadata.Invalidates = []string{"management-oauth-model-aliases", "auth-file-models", "model-square", "pricing"}
	if err := capability.Register(registry, metadata, func(ctx context.Context, input SetAliasesInput) (capability.Preview, error) {
		if s.NormalizeOAuthModelAliases == nil {
			return capability.Preview{}, errors.New("capability_unavailable")
		}
		provider, aliases, err := s.NormalizeOAuthModelAliases(input.Provider, input.Aliases)
		if err != nil {
			return capability.Preview{}, errors.New("invalid_parameters")
		}
		view, revision, err := s.OAuthModelAliases(ctx)
		if err != nil {
			return capability.Preview{}, err
		}
		before := view[provider]
		if before == nil {
			before = []OAuthModelAlias{}
		}
		return capability.Preview{Target: provider, Revision: revision, Changes: map[string]any{"provider": provider, "before": before, "after": aliases}}, nil
	}, func(ctx context.Context, input SetAliasesInput, revision, _ string) (Done, error) {
		if s.SetOAuthModelAliases == nil {
			return Done{}, errors.New("capability_unavailable")
		}
		provider, aliases, err := s.NormalizeOAuthModelAliases(input.Provider, input.Aliases)
		if err != nil {
			return Done{}, errors.New("invalid_parameters")
		}
		if err := s.SetOAuthModelAliases(ctx, provider, aliases, revision); err != nil {
			return Done{}, err
		}
		return Done{true}, nil
	}); err != nil {
		return err
	}
	if err := read(registry, "oauth_excluded_models_list", "Read the global per-provider OAuth model exclusion rules: the models CPA hides from every OAuth credential of a provider. A rule is a model ID or a pattern where * matches any characters.", func(ctx context.Context, _ Empty) (OAuthExcludedModelsView, error) {
		if s.OAuthExcludedModels == nil {
			return OAuthExcludedModelsView{}, errors.New("capability_unavailable")
		}
		excluded, revision, err := s.OAuthExcludedModels(ctx)
		if excluded == nil {
			excluded = map[string][]string{}
		}
		return OAuthExcludedModelsView{ExcludedModels: excluded, Revision: revision}, err
	}); err != nil {
		return err
	}
	type SetExcludedModelsInput struct {
		Provider string   `json:"provider"`
		Models   []string `json:"models"`
	}
	metadata = Meta("oauth_set_excluded_models", "Replace one provider's OAuth model exclusion rules after confirmation. Excluded models stop being served by every OAuth credential of that provider; the rule * excludes all of them. Empty models delete the provider's rules.", "write", "high")
	metadata.Invalidates = []string{"management-oauth-excluded-models", "auth-file-models", "model-square", "pricing"}
	if err := capability.Register(registry, metadata, func(ctx context.Context, input SetExcludedModelsInput) (capability.Preview, error) {
		if s.NormalizeOAuthExclusions == nil || s.OAuthExcludedModels == nil {
			return capability.Preview{}, errors.New("capability_unavailable")
		}
		provider, rules, err := s.NormalizeOAuthExclusions(input.Provider, input.Models)
		if err != nil {
			return capability.Preview{}, errors.New("invalid_parameters")
		}
		view, revision, err := s.OAuthExcludedModels(ctx)
		if err != nil {
			return capability.Preview{}, err
		}
		before := view[provider]
		if before == nil {
			before = []string{}
		}
		return capability.Preview{Target: provider, Revision: revision, Changes: map[string]any{"provider": provider, "before": before, "after": rules}}, nil
	}, func(ctx context.Context, input SetExcludedModelsInput, revision, _ string) (Done, error) {
		if s.NormalizeOAuthExclusions == nil || s.SetOAuthExcludedModels == nil {
			return Done{}, errors.New("capability_unavailable")
		}
		provider, rules, err := s.NormalizeOAuthExclusions(input.Provider, input.Models)
		if err != nil {
			return Done{}, errors.New("invalid_parameters")
		}
		if err := s.SetOAuthExcludedModels(ctx, provider, rules, revision); err != nil {
			return Done{}, err
		}
		return Done{true}, nil
	}); err != nil {
		return err
	}
	type ProviderList struct {
		Providers []string `json:"providers"`
	}
	if err := read(registry, "oauth_providers", "List supported OAuth login provider identifiers.", func(context.Context, Empty) (ProviderList, error) {
		result := ProviderList{Providers: []string{}}
		for _, provider := range management.OAuthProviders {
			result.Providers = append(result.Providers, provider.ID)
		}
		return result, nil
	}); err != nil {
		return err
	}
	// Login is a browser-only handoff. The capability never receives the OAuth state or URL.
	metadata = Meta("oauth_connect", "Ask the operator to connect an OAuth account privately in OMC.", "write", "high")
	metadata.HumanInput = "oauth"
	type ConnectInput struct {
		Provider string `json:"provider"`
	}
	return capability.Register(registry, metadata, func(_ context.Context, input ConnectInput) (capability.Preview, error) {
		if _, ok := management.LookupOAuthProvider(input.Provider); !ok {
			return capability.Preview{}, errors.New("invalid_parameters")
		}
		return capability.Preview{Target: input.Provider, Revision: input.Provider, Changes: input}, nil
	}, func(_ context.Context, input ConnectInput, revision, _ string) (Done, error) {
		if input.Provider != revision {
			return Done{}, errors.New("resource_conflict")
		}
		return Done{true}, nil
	})
}
