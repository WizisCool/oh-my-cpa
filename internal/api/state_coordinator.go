package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"net/http"
	"slices"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/configyaml"
	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/management"
	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
	"github.com/oh-my-cpa/oh-my-cpa/internal/statecoord"
)

const (
	stateDomainScalars               statecoord.DomainKey = "scalars"
	stateDomainClientKeys            statecoord.DomainKey = "client_keys"
	stateDomainOpenAICompat          statecoord.DomainKey = "openai_compat"
	stateDomainProviderFamilyPrefix                       = "provider_family:"
	stateDomainOAuthAliasesPrefix                         = "oauth_aliases:"
	stateDomainOAuthExclusionsPrefix                      = "oauth_exclusions:"
	stateDomainAuthFileStatusPrefix                       = "auth_file_status:"
)

// StateCoordinatorOptions allows tests to tune debounce timing while production uses defaults.
type StateCoordinatorOptions struct {
	DebounceWindow time.Duration
	MaxBatchWait   time.Duration
}

type pendingScalarEntry struct {
	Value any    `json:"value"`
	Seq   uint64 `json:"seq"`
}

// projectedConfigState holds the in-memory hot projection of CPA configuration slices.
// Instances stored inside statecoord.Coordinator are never mutated in place outside Coordinator.Mutate.
type projectedConfigState struct {
	Scalars                  management.ConfigScalarsDTO                              `json:"scalars"`
	PendingScalars           map[string]pendingScalarEntry                            `json:"pending_scalars,omitempty"`
	ScalarSeq                uint64                                                   `json:"scalar_seq"`
	ViewYAML                 string                                                   `json:"view_yaml"`
	SafeYAML                 string                                                   `json:"safe_yaml"`
	Revision                 string                                                   `json:"revision"`
	StoredLayout             string                                                   `json:"stored_layout"`
	ClientKeys               []string                                                 `json:"client_keys"`
	ConfigFamilies           map[management.ConfigKeyFamily][]management.ConfigAPIKey `json:"config_families"`
	RuntimeOnlyFam           map[management.ConfigKeyFamily]bool                      `json:"runtime_only_fam,omitempty"`
	OpenAICompat             []management.OpenAICompatibility                         `json:"openai_compat"`
	OpenAIRuntime            bool                                                     `json:"openai_runtime,omitempty"`
	OAuthAliases             map[string][]managementOAuthModelAlias                   `json:"oauth_aliases"`
	OAuthAliasesUnavailable  bool                                                     `json:"oauth_aliases_unavailable,omitempty"`
	OAuthExcluded            map[string][]string                                      `json:"oauth_excluded"`
	OAuthExcludedUnavailable bool                                                     `json:"oauth_excluded_unavailable,omitempty"`
	AuthFiles                []management.AuthFile                                    `json:"auth_files"`
	AuthFilesUnavailable     bool                                                     `json:"auth_files_unavailable,omitempty"`
	PendingAuthStatus        map[string]pendingAuthFileStatus                         `json:"pending_auth_status,omitempty"`
	AuthStatusSeq            uint64                                                   `json:"auth_status_seq"`
}

type pendingAuthFileStatus struct {
	Name      string `json:"name"`
	AuthIndex string `json:"auth_index"`
	Disabled  bool   `json:"disabled"`
	Seq       uint64 `json:"seq"`
}

var errStateSliceUnavailable = errors.New("projected configuration slice is unavailable")

func encodeAuthFileSelector(name, authIndex string) string {
	return strconv.Itoa(len(name)) + ":" + name + "|" + authIndex
}

// SafeProviderStatusDTO exposes non-secret enablement state for reconciliation payloads.
type SafeProviderStatusDTO struct {
	ID       string `json:"id"`
	Family   string `json:"family"`
	Disabled bool   `json:"disabled"`
}

// SafeAuthFileStatusDTO exposes non-secret OAuth credential enablement state for reconciliation payloads.
type SafeAuthFileStatusDTO struct {
	Name      string `json:"name"`
	AuthIndex string `json:"auth_index,omitempty"`
	Disabled  bool   `json:"disabled"`
}

// SafeProjectedStateDTO is the secret-free state projection returned by GET /api/v1/management/state
// and embedded inside SSE sync_error events for immediate authoritative reconciliation.
type SafeProjectedStateDTO struct {
	Revision            string                                 `json:"revision"`
	StoredLayout        string                                 `json:"stored_layout"`
	Scalars             management.ConfigScalarsDTO            `json:"scalars"`
	SupportedKeys       []string                               `json:"supported_keys"`
	ClientKeysTotal     int                                    `json:"client_keys_total"`
	ProviderStatuses    []SafeProviderStatusDTO                `json:"provider_statuses"`
	AuthFileStatuses    []SafeAuthFileStatusDTO                `json:"auth_file_statuses"`
	OAuthModelAliases   map[string][]managementOAuthModelAlias `json:"oauth_model_aliases"`
	OAuthExcludedModels map[string][]string                    `json:"oauth_excluded_models"`
}

// cloneViaJSON preserves unexported wireExtras on management.ConfigAPIKey and
// management.OpenAICompatibility through their custom MarshalJSON/UnmarshalJSON methods.
func cloneViaJSON[T any](value T) T {
	encoded, err := json.Marshal(value)
	if err != nil {
		return value
	}
	var cloned T
	if err := json.Unmarshal(encoded, &cloned); err != nil {
		return value
	}
	return cloned
}

func cloneProjectedConfigState(src projectedConfigState) projectedConfigState {
	families := make(map[management.ConfigKeyFamily][]management.ConfigAPIKey, len(src.ConfigFamilies))
	for family, list := range src.ConfigFamilies {
		families[family] = cloneViaJSON(list)
	}
	aliases := make(map[string][]managementOAuthModelAlias, len(src.OAuthAliases))
	for provider, list := range src.OAuthAliases {
		copied := make([]managementOAuthModelAlias, len(list))
		for i, item := range list {
			copied[i] = item
			if item.OpenAPI != nil {
				flag := *item.OpenAPI
				copied[i].OpenAPI = &flag
			}
		}
		aliases[provider] = copied
	}
	excluded := make(map[string][]string, len(src.OAuthExcluded))
	for provider, rules := range src.OAuthExcluded {
		excluded[provider] = slices.Clone(rules)
	}
	return projectedConfigState{
		Scalars:                  src.Scalars,
		PendingScalars:           maps.Clone(src.PendingScalars),
		ScalarSeq:                src.ScalarSeq,
		ViewYAML:                 src.ViewYAML,
		SafeYAML:                 src.SafeYAML,
		Revision:                 src.Revision,
		StoredLayout:             src.StoredLayout,
		ClientKeys:               slices.Clone(src.ClientKeys),
		ConfigFamilies:           families,
		RuntimeOnlyFam:           maps.Clone(src.RuntimeOnlyFam),
		OpenAICompat:             cloneViaJSON(src.OpenAICompat),
		OpenAIRuntime:            src.OpenAIRuntime,
		OAuthAliases:             aliases,
		OAuthAliasesUnavailable:  src.OAuthAliasesUnavailable,
		OAuthExcluded:            excluded,
		OAuthExcludedUnavailable: src.OAuthExcludedUnavailable,
		AuthFiles:                cloneViaJSON(src.AuthFiles),
		AuthFilesUnavailable:     src.AuthFilesUnavailable,
		PendingAuthStatus:        maps.Clone(src.PendingAuthStatus),
		AuthStatusSeq:            src.AuthStatusSeq,
	}
}

func buildSafeProjectedStateDTO(state projectedConfigState) SafeProjectedStateDTO {
	statuses := make([]SafeProviderStatusDTO, 0)
	for _, spec := range providerConfigFamilies {
		for index, entry := range state.ConfigFamilies[spec.Family] {
			statuses = append(statuses, SafeProviderStatusDTO{
				ID:       fmt.Sprintf("%s%d", spec.IDPrefix, index),
				Family:   string(spec.Family),
				Disabled: management.IsExcludedAll(entry.ExcludedModels),
			})
		}
	}
	for index, entry := range state.OpenAICompat {
		statuses = append(statuses, SafeProviderStatusDTO{
			ID:       fmt.Sprintf("%s%d", openAICompatIDPrefix, index),
			Family:   openAICompatibilityFamily,
			Disabled: entry.Disabled,
		})
	}
	aliases := make(map[string][]managementOAuthModelAlias, len(state.OAuthAliases))
	for provider, list := range state.OAuthAliases {
		copied := make([]managementOAuthModelAlias, len(list))
		for i, item := range list {
			copied[i] = item
			if item.OpenAPI != nil {
				flag := *item.OpenAPI
				copied[i].OpenAPI = &flag
			}
		}
		aliases[provider] = copied
	}
	excluded := make(map[string][]string, len(state.OAuthExcluded))
	for provider, rules := range state.OAuthExcluded {
		excluded[provider] = slices.Clone(rules)
	}
	authStatuses := make([]SafeAuthFileStatusDTO, 0, len(state.AuthFiles))
	for _, file := range state.AuthFiles {
		name := firstNonEmpty(file.Name, file.ID)
		if name == "" {
			continue
		}
		authStatuses = append(authStatuses, SafeAuthFileStatusDTO{
			Name:      name,
			AuthIndex: file.AuthIndex,
			Disabled:  file.Disabled,
		})
	}
	return SafeProjectedStateDTO{
		Revision:            state.Revision,
		StoredLayout:        state.StoredLayout,
		Scalars:             state.Scalars,
		SupportedKeys:       management.KnownScalarKeys(),
		ClientKeysTotal:     len(state.ClientKeys),
		ProviderStatuses:    statuses,
		AuthFileStatuses:    authStatuses,
		OAuthModelAliases:   aliases,
		OAuthExcludedModels: excluded,
	}
}

// EnableStateCoordinator initializes the in-memory state projection coordinator,
// registers all write-behind configuration domains, performs best-effort startup
// bootstrap, and starts the single serialized 250ms debounce flusher.
func (h *Handler) EnableStateCoordinator(ctx context.Context, opts StateCoordinatorOptions) error {
	if h == nil {
		return nil
	}
	var stateSecretsMu sync.Mutex
	var lastViewYAML string
	var knownSecrets []string

	collectSecrets := func(s projectedConfigState) []string {
		seen := make(map[string]struct{})
		add := func(raw string) {
			trimmed := strings.TrimSpace(raw)
			if trimmed != "" {
				seen[trimmed] = struct{}{}
			}
		}
		if s.Scalars.ProxyURL != "" {
			add(s.Scalars.ProxyURL)
		}
		if entry, ok := s.PendingScalars["proxy_url"]; ok {
			if proxyStr, isStr := entry.Value.(string); isStr {
				add(proxyStr)
			}
		}
		for _, k := range s.ClientKeys {
			add(k)
		}
		for _, list := range s.ConfigFamilies {
			for _, entry := range list {
				add(entry.APIKey)
				add(entry.ProxyURL)
				for _, headerVal := range entry.Headers {
					add(headerVal)
				}
			}
		}
		for _, entry := range s.OpenAICompat {
			for _, k := range entry.LegacyAPIKeys {
				add(k)
			}
			for _, ke := range entry.APIKeyEntries {
				add(ke.APIKey)
				add(ke.ProxyURL)
			}
			for _, headerVal := range entry.Headers {
				add(headerVal)
			}
		}
		out := make([]string, 0, len(seen))
		for secret := range seen {
			out = append(out, secret)
		}
		// Replace longer secrets first so shared prefixes cannot leave suffixes exposed.
		sort.Slice(out, func(i, j int) bool { return len(out[i]) > len(out[j]) })
		return out
	}

	coord := statecoord.New(statecoord.Options[projectedConfigState]{
		DebounceWindow: opts.DebounceWindow,
		MaxBatchWait:   opts.MaxBatchWait,
		Logger:         h.logger,
		Load: func(loadCtx context.Context) (projectedConfigState, error) {
			loaded, err := h.loadUpstreamProjectedState(loadCtx)
			if err == nil {
				secrets := collectSecrets(loaded)
				stateSecretsMu.Lock()
				lastViewYAML = loaded.ViewYAML
				knownSecrets = secrets
				stateSecretsMu.Unlock()
			}
			return loaded, err
		},
		Clone: cloneProjectedConfigState,
		ProjectSafe: func(state projectedConfigState, _ uint64) any {
			return buildSafeProjectedStateDTO(state)
		},
		ScrubError: func(err error, snapshot projectedConfigState) (string, string) {
			stateSecretsMu.Lock()
			yamlCopy := lastViewYAML
			secretsCopy := slices.Clone(knownSecrets)
			stateSecretsMu.Unlock()
			if yamlCopy == "" {
				yamlCopy = snapshot.ViewYAML
			}
			snapshotSecrets := collectSecrets(snapshot)
			combinedSecrets := make([]string, 0, len(secretsCopy)+len(snapshotSecrets))
			seen := make(map[string]struct{}, len(secretsCopy)+len(snapshotSecrets))
			for _, sec := range append(secretsCopy, snapshotSecrets...) {
				if _, exists := seen[sec]; !exists {
					seen[sec] = struct{}{}
					combinedSecrets = append(combinedSecrets, sec)
				}
			}
			sort.Slice(combinedSecrets, func(i, j int) bool { return len(combinedSecrets[i]) > len(combinedSecrets[j]) })

			scrubbed := scrubConfigRejection(err, yamlCopy)
			_, code, message, _ := classifyCPAFacadeError(scrubbed)
			message = configyaml.ScrubStoredSecrets(message, yamlCopy)
			if snapshot.ViewYAML != "" && snapshot.ViewYAML != yamlCopy {
				message = configyaml.ScrubStoredSecrets(message, snapshot.ViewYAML)
			}
			for _, secret := range combinedSecrets {
				message = strings.ReplaceAll(message, secret, "[hidden]")
			}
			return code, message
		},
		WithWriteGate: func(gateCtx context.Context, fn func(context.Context) error) error {
			if err := h.providerWrites.acquire(gateCtx); err != nil {
				return err
			}
			defer h.providerWrites.release()
			h.configMu.Lock()
			defer h.configMu.Unlock()
			return fn(gateCtx)
		},
		OnDomainOutcome: func(rec statecoord.PendingAuditRecord, flushErr error, _ projectedConfigState) {
			h.recordDeferredDomainAudit(rec, flushErr)
		},
		AfterFlush: func(_ []statecoord.DomainKey) {
			h.afterConfigWriteSideEffects()
			h.refreshCoordinatorYAMLBaseline()
		},
	})

	h.registerCoordinatorDomains(coord)
	h.stateCoord = coord

	var bootErr error
	if ctx != nil {
		bootErr = coord.Bootstrap(ctx)
		if bootErr != nil {
			h.logger.Debug("state coordinator cold bootstrap deferred to lazy singleflight load", "reason", bootErr.Error())
		}
	}
	coord.Start()
	return bootErr
}

func (h *Handler) ensureSnapshotRevisionMatchesUpstream(ctx context.Context, client *management.Client, expectedRevision string) error {
	if strings.TrimSpace(expectedRevision) == "" {
		return nil
	}
	currentYAML, err := client.ConfigYAML(ctx)
	if err != nil {
		return err
	}
	currentRev := configyaml.ComputeRevision(currentYAML)
	if !strings.EqualFold(expectedRevision, currentRev) {
		return management.ErrConfigChanged
	}
	return nil
}

func (h *Handler) registerCoordinatorDomains(coord *statecoord.Coordinator[projectedConfigState]) {
	// 1. Scalar settings: coalesces multiple scalar edits inside 250ms into a single ApplyConfigChanges write.
	coord.RegisterDomain(stateDomainScalars, statecoord.DomainSpec[projectedConfigState]{
		Order:  10,
		Scopes: []string{"management-config", "management-routing", "management-logs-status"},
		Flush: func(ctx context.Context, _ statecoord.DomainKey, snapshot projectedConfigState) error {
			if len(snapshot.PendingScalars) == 0 {
				return nil
			}
			client, err := h.capabilityClient(ctx)
			if err != nil {
				return err
			}
			keys := make([]string, 0, len(snapshot.PendingScalars))
			for key := range snapshot.PendingScalars {
				keys = append(keys, key)
			}
			sort.Strings(keys)
			changes := make([]management.ConfigChange, 0, len(keys))
			for _, key := range keys {
				change, changeErr := management.ScalarConfigChange(key, snapshot.PendingScalars[key].Value)
				if changeErr != nil {
					return changeErr
				}
				changes = append(changes, change)
			}
			return client.ApplyConfigChanges(management.WithBackupReason(ctx, management.BackupReasonConfigChanges), changes)
		},
		CleanPending: func(state *projectedConfigState, _ statecoord.DomainKey, flushed projectedConfigState) {
			for key, flushedEntry := range flushed.PendingScalars {
				if cur, ok := state.PendingScalars[key]; ok && cur.Seq <= flushedEntry.Seq {
					delete(state.PendingScalars, key)
				}
			}
		},
	})

	// 2. Gateway caller API keys: coalesces rapid key creates/edits/deletes into one UpdateClientAPIKeys write.
	coord.RegisterDomain(stateDomainClientKeys, statecoord.DomainSpec[projectedConfigState]{
		Order:  20,
		Scopes: []string{"management-client-keys", "management-config"},
		Flush: func(ctx context.Context, _ statecoord.DomainKey, snapshot projectedConfigState) error {
			client, err := h.capabilityClient(ctx)
			if err != nil {
				return err
			}
			// Compare against upstream revision when no earlier domain in this batch mutated YAML.
			// Scalar writes (Order 10) advance YAML revision if present in the same batch; if PendingScalars
			// was empty, snapshot.Revision must still match CPA's current config.yaml or we refuse to overwrite
			// out-of-band key edits.
			if len(snapshot.PendingScalars) == 0 {
				if err := h.ensureSnapshotRevisionMatchesUpstream(ctx, client, snapshot.Revision); err != nil {
					return err
				}
			}
			h.invalidateClientKeyCatalog()
			return client.UpdateClientAPIKeys(ctx, snapshot.ClientKeys)
		},
	})

	// 3. OpenAI-compatibility provider status toggles.
	coord.RegisterDomain(stateDomainOpenAICompat, statecoord.DomainSpec[projectedConfigState]{
		Order:  30,
		Scopes: []string{"management-providers", "management-providers-sanitized", "management-routing", "management-config"},
		Flush: func(ctx context.Context, _ statecoord.DomainKey, snapshot projectedConfigState) error {
			client, err := h.capabilityClient(ctx)
			if err != nil {
				return err
			}
			if len(snapshot.PendingScalars) == 0 {
				// Re-read editable OpenAI-compatibility entries if snapshot.Revision moved because
				// client_keys flushed earlier in the same batch; otherwise enforce exact revision match.
				currentYAML, yamlErr := client.ConfigYAML(ctx)
				if yamlErr != nil {
					return yamlErr
				}
				if snapshot.Revision != "" && !strings.EqualFold(snapshot.Revision, configyaml.ComputeRevision(currentYAML)) {
					// Check whether an out-of-band writer changed openai-compatibility itself by comparing lengths/names.
					liveEntries, liveErr := client.EditableOpenAICompatibility(ctx)
					if liveErr != nil || len(liveEntries) != len(snapshot.OpenAICompat) {
						return management.ErrConfigChanged
					}
					for idx := range liveEntries {
						if liveEntries[idx].Name != snapshot.OpenAICompat[idx].Name {
							return management.ErrConfigChanged
						}
					}
				}
			}
			return client.UpdateOpenAICompatibility(ctx, snapshot.OpenAICompat)
		},
	})

	// 4. Per-family config API-key provider status toggles (codex, claude, gemini, meta, xai, vertex, interactions).
	coord.RegisterDomainPrefix(stateDomainProviderFamilyPrefix, statecoord.DomainSpec[projectedConfigState]{
		Order:  35,
		Scopes: []string{"management-providers", "management-providers-sanitized", "management-routing", "management-config"},
		Flush: func(ctx context.Context, key statecoord.DomainKey, snapshot projectedConfigState) error {
			family := management.ConfigKeyFamily(strings.TrimPrefix(string(key), stateDomainProviderFamilyPrefix))
			client, err := h.capabilityClient(ctx)
			if err != nil {
				return err
			}
			currentYAML, yamlErr := client.ConfigYAML(ctx)
			if yamlErr != nil {
				return yamlErr
			}
			if snapshot.Revision != "" && !strings.EqualFold(snapshot.Revision, configyaml.ComputeRevision(currentYAML)) {
				liveEntries, liveErr := client.EditableConfigAPIKeys(ctx, family)
				if liveErr != nil || len(liveEntries) != len(snapshot.ConfigFamilies[family]) {
					return management.ErrConfigChanged
				}
				for idx := range liveEntries {
					if strings.TrimSpace(liveEntries[idx].APIKey) != strings.TrimSpace(snapshot.ConfigFamilies[family][idx].APIKey) {
						return management.ErrConfigChanged
					}
				}
			}
			return client.UpdateConfigAPIKeys(ctx, family, snapshot.ConfigFamilies[family])
		},
	})

	// 5. Global OAuth model alias rules per provider.
	coord.RegisterDomainPrefix(stateDomainOAuthAliasesPrefix, statecoord.DomainSpec[projectedConfigState]{
		Order:  40,
		Scopes: []string{"management-oauth-model-aliases", "management-config"},
		Flush: func(ctx context.Context, key statecoord.DomainKey, snapshot projectedConfigState) error {
			provider := strings.TrimPrefix(string(key), stateDomainOAuthAliasesPrefix)
			client, err := h.capabilityClient(ctx)
			if err != nil {
				return err
			}
			aliases := snapshot.OAuthAliases[provider]
			if err := client.PatchOAuthModelAliases(ctx, provider, managementOAuthModelAliasesToCPA(aliases)); err != nil {
				return err
			}
			serverAliases, err := client.OAuthModelAliases(ctx)
			if err != nil {
				return err
			}
			projected, err := projectManagementOAuthModelAliases(serverAliases)
			if err != nil {
				return err
			}
			current, exists := projected[provider]
			if len(aliases) == 0 {
				if exists {
					return errOAuthModelAliasMismatch
				}
				return nil
			}
			if !exists || !managementOAuthModelAliasesEqual(current, aliases) {
				return errOAuthModelAliasMismatch
			}
			return nil
		},
	})

	// 6. Global OAuth excluded model rules per provider.
	coord.RegisterDomainPrefix(stateDomainOAuthExclusionsPrefix, statecoord.DomainSpec[projectedConfigState]{
		Order:  45,
		Scopes: []string{"management-oauth-excluded-models", "management-config"},
		Flush: func(ctx context.Context, key statecoord.DomainKey, snapshot projectedConfigState) error {
			provider := strings.TrimPrefix(string(key), stateDomainOAuthExclusionsPrefix)
			client, err := h.capabilityClient(ctx)
			if err != nil {
				return err
			}
			rules := snapshot.OAuthExcluded[provider]
			if err := client.PatchOAuthExcludedModels(ctx, provider, rules); err != nil {
				return err
			}
			stored, err := client.OAuthExcludedModels(ctx)
			if err != nil {
				return err
			}
			projected, err := projectManagementOAuthExcludedModels(stored)
			if err != nil {
				return err
			}
			current := projected[provider]
			if current == nil {
				current = []string{}
			}
			if !equalStringSlices(current, rules) {
				return errOAuthExcludedModelsMismatch
			}
			return nil
		},
	})

	// 7. OAuth / credential auth-file enablement toggles: coalesces rapid per-credential
	// and multi-credential switches inside 250ms under a single write-gate acquisition.
	coord.RegisterDomainPrefix(stateDomainAuthFileStatusPrefix, statecoord.DomainSpec[projectedConfigState]{
		Order:  50,
		Scopes: []string{"management-auth-files", "management-routing", "management-quota"},
		Flush: func(ctx context.Context, key statecoord.DomainKey, snapshot projectedConfigState) error {
			selector := strings.TrimPrefix(string(key), stateDomainAuthFileStatusPrefix)
			pending, exists := snapshot.PendingAuthStatus[selector]
			if !exists {
				return nil
			}
			client, err := h.capabilityClient(ctx)
			if err != nil {
				return err
			}
			_, err = client.PatchAuthFileStatus(ctx, pending.Name, pending.AuthIndex, pending.Disabled)
			return err
		},
		CleanPending: func(state *projectedConfigState, key statecoord.DomainKey, flushed projectedConfigState) {
			selector := strings.TrimPrefix(string(key), stateDomainAuthFileStatusPrefix)
			if flushedEntry, exists := flushed.PendingAuthStatus[selector]; exists {
				if cur, ok := state.PendingAuthStatus[selector]; ok && cur.Seq <= flushedEntry.Seq {
					delete(state.PendingAuthStatus, selector)
				}
			}
		},
	})
}

func (h *Handler) invalidateClientKeyCatalog() {
	h.agent.catalogMu.Lock()
	h.agent.catalog = nil
	h.agent.catalogMu.Unlock()
}

// refreshCoordinatorYAMLBaseline updates the cached YAML/revision fields after a
// write-behind flush commits so subsequent ConfigPage reads see the new ETag in <1ms.
func (h *Handler) refreshCoordinatorYAMLBaseline() {
	if h.stateCoord == nil || h.stateCoord.IsDirty() {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	client, err := h.capabilityClient(ctx)
	if err != nil {
		return
	}
	viewYAML, err := client.ConfigYAML(ctx)
	if err != nil {
		return
	}
	storedLayout := storedConfigLayoutUnknown
	if isV8, _, layoutErr := client.IsStoredConfigV8(ctx); layoutErr == nil {
		storedLayout = storedConfigLayoutLegacy
		if isV8 {
			storedLayout = storedConfigLayoutV8
		}
	}
	safeYAML, err := configyaml.SanitizeSafeYAML(viewYAML)
	if err != nil {
		safeYAML = ""
	}
	rev := configyaml.ComputeRevision(viewYAML)
	h.stateCoord.RefreshCleanBaseline(func(state *projectedConfigState) {
		state.ViewYAML = viewYAML
		state.SafeYAML = safeYAML
		state.Revision = rev
		state.StoredLayout = storedLayout
		clear(state.PendingScalars)
		clear(state.PendingAuthStatus)
	})
}

func (h *Handler) loadUpstreamProjectedState(ctx context.Context) (projectedConfigState, error) {
	client, err := h.capabilityClient(ctx)
	if err != nil {
		return projectedConfigState{}, err
	}

	scalars, err := client.ConfigScalars(ctx)
	if err != nil {
		return projectedConfigState{}, err
	}

	var (
		wg                       sync.WaitGroup
		viewYAML                 string
		yamlErr                  error
		storedLayout             = storedConfigLayoutUnknown
		clientKeys               []string
		keysErr                  error
		openAICompat             []management.OpenAICompatibility
		openAIRuntime            bool
		openAIFailed             bool
		oauthAliases             = map[string][]managementOAuthModelAlias{}
		oauthAliasesUnavailable  bool
		oauthExcluded            = map[string][]string{}
		oauthExcludedUnavailable bool
		authFiles                []management.AuthFile
		authFilesUnavailable     bool
		familyEntries            = make([][]management.ConfigAPIKey, len(providerConfigFamilies))
		familyFallback           = make([]bool, len(providerConfigFamilies))
		familyFailed             = make([]bool, len(providerConfigFamilies))
	)

	wg.Go(func() {
		viewYAML, yamlErr = client.ConfigYAML(ctx)
		if isV8, _, errLayout := client.IsStoredConfigV8(ctx); errLayout == nil {
			storedLayout = storedConfigLayoutLegacy
			if isV8 {
				storedLayout = storedConfigLayoutV8
			}
		}
	})

	wg.Go(func() {
		clientKeys, keysErr = client.ClientAPIKeys(ctx)
	})

	wg.Go(func() {
		entries, errCompat := client.EditableOpenAICompatibility(ctx)
		if errCompat != nil {
			if runtime, runtimeErr := client.OpenAICompatibility(ctx); runtimeErr == nil {
				for i := range runtime.Entries {
					runtime.Entries[i].ConnectionPool = nil
					for ki := range runtime.Entries[i].APIKeyEntries {
						runtime.Entries[i].APIKeyEntries[ki].ConnectionPool = nil
					}
				}
				openAICompat = runtime.Entries
				openAIRuntime = true
				return
			}
			if !management.IsMissingCapability(errCompat) {
				openAIFailed = true
			}
		} else {
			openAICompat = entries
		}
	})

	for idx, spec := range providerConfigFamilies {
		wg.Go(func() {
			entries, errFam := client.EditableConfigAPIKeys(ctx, spec.Family)
			if errFam != nil {
				if runtimeEntries, runtimeErr := client.ConfigAPIKeys(ctx, spec.Family); runtimeErr == nil {
					for i := range runtimeEntries {
						runtimeEntries[i].ConnectionPool = nil
					}
					familyEntries[idx] = runtimeEntries
					familyFallback[idx] = true
					return
				}
				if !management.IsMissingCapability(errFam) {
					familyFailed[idx] = true
				}
				return
			}
			familyEntries[idx] = entries
		})
	}

	wg.Go(func() {
		rawAliases, errAlias := client.OAuthModelAliases(ctx)
		if errAlias != nil {
			if !management.IsMissingCapability(errAlias) {
				oauthAliasesUnavailable = true
			}
			return
		}
		projected, projErr := projectManagementOAuthModelAliases(rawAliases)
		if projErr != nil {
			oauthAliasesUnavailable = true
			return
		}
		oauthAliases = projected
	})

	wg.Go(func() {
		rawExcluded, errExcl := client.OAuthExcludedModels(ctx)
		if errExcl != nil {
			if !management.IsMissingCapability(errExcl) {
				oauthExcludedUnavailable = true
			}
			return
		}
		projected, projErr := projectManagementOAuthExcludedModels(rawExcluded)
		if projErr != nil {
			oauthExcludedUnavailable = true
			return
		}
		oauthExcluded = projected
	})

	wg.Go(func() {
		filesResp, errFiles := client.AuthFiles(ctx)
		if errFiles != nil {
			authFilesUnavailable = true
			return
		}
		authFiles = filesResp.Files
	})

	wg.Wait()

	if yamlErr != nil {
		return projectedConfigState{}, yamlErr
	}
	if keysErr != nil && !management.IsMissingCapability(keysErr) {
		return projectedConfigState{}, keysErr
	}

	configFamilies := make(map[management.ConfigKeyFamily][]management.ConfigAPIKey, len(providerConfigFamilies))
	runtimeOnlyFam := make(map[management.ConfigKeyFamily]bool)
	for idx, spec := range providerConfigFamilies {
		if familyEntries[idx] != nil {
			configFamilies[spec.Family] = familyEntries[idx]
		} else {
			configFamilies[spec.Family] = []management.ConfigAPIKey{}
		}
		if familyFallback[idx] || familyFailed[idx] {
			runtimeOnlyFam[spec.Family] = true
		}
	}
	if openAIFailed {
		openAIRuntime = true
	}
	if openAICompat == nil {
		openAICompat = []management.OpenAICompatibility{}
	}
	if clientKeys == nil {
		clientKeys = []string{}
	}

	safeYAML, err := configyaml.SanitizeSafeYAML(viewYAML)
	if err != nil {
		safeYAML = ""
	}
	if authFiles == nil {
		authFiles = []management.AuthFile{}
	}
	return projectedConfigState{
		Scalars:                  scalars,
		PendingScalars:           make(map[string]pendingScalarEntry),
		ViewYAML:                 viewYAML,
		SafeYAML:                 safeYAML,
		Revision:                 configyaml.ComputeRevision(viewYAML),
		StoredLayout:             storedLayout,
		ClientKeys:               clientKeys,
		ConfigFamilies:           configFamilies,
		RuntimeOnlyFam:           runtimeOnlyFam,
		OpenAICompat:             openAICompat,
		OpenAIRuntime:            openAIRuntime,
		OAuthAliases:             oauthAliases,
		OAuthAliasesUnavailable:  oauthAliasesUnavailable,
		OAuthExcluded:            oauthExcluded,
		OAuthExcludedUnavailable: oauthExcludedUnavailable,
		AuthFiles:                authFiles,
		AuthFilesUnavailable:     authFilesUnavailable,
		PendingAuthStatus:        make(map[string]pendingAuthFileStatus),
	}, nil
}

// CloseStateCoordinator flushes pending write-behind mutations and terminates SSE streams.
func (h *Handler) CloseStateCoordinator(ctx context.Context) {
	if h == nil || h.stateCoord == nil {
		return
	}
	if ctx == nil {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
	}
	_ = h.stateCoord.Close(ctx)
}

// flushCoordinatorWithinGate drains pending write-behind state when the caller already
// holds providerWrites + configMu so synchronous structural writes read fresh CPA state.
func (h *Handler) flushCoordinatorWithinGate(ctx context.Context) error {
	if h == nil || h.stateCoord == nil {
		return nil
	}
	return h.stateCoord.FlushWithinGate(ctx)
}

// flushCoordinatorUnderProviderGate drains pending write-behind state when the caller
// holds providerWrites but has not yet acquired configMu, preserving strict lock order.
func (h *Handler) flushCoordinatorUnderProviderGate(ctx context.Context) error {
	if h == nil || h.stateCoord == nil {
		return nil
	}
	h.configMu.Lock()
	defer h.configMu.Unlock()
	return h.stateCoord.FlushWithinGate(ctx)
}

func (h *Handler) invalidateCoordinator(scopes ...string) {
	if h == nil || h.stateCoord == nil {
		return
	}
	h.stateCoord.Invalidate(scopes...)
}

func setStateVersionHeader(writer http.ResponseWriter, version uint64) {
	if version > 0 {
		writer.Header().Set("X-State-Version", strconv.FormatUint(version, 10))
	}
}

func isSyncWriteRequested(request *http.Request) bool {
	val := strings.TrimSpace(request.Header.Get("X-OMC-Sync"))
	return val == "1" || strings.EqualFold(val, "true")
}

func (h *Handler) buildPendingAuditRecord(request *http.Request, action, targetType, targetID string, details map[string]any) statecoord.PendingAuditRecord {
	clonedDetails := maps.Clone(details)
	if clientID := clientRequestID(request); clientID != "" {
		if clonedDetails == nil {
			clonedDetails = make(map[string]any, 1)
		}
		clonedDetails["client_request_id"] = clientID
	}
	return statecoord.PendingAuditRecord{
		Action:        action,
		TargetType:    targetType,
		TargetID:      targetID,
		RequestID:     getOrGenerateRequestID(request),
		SourceSummary: requestSourceSummary(request),
		Details:       clonedDetails,
	}
}

func (h *Handler) recordDeferredDomainAudit(rec statecoord.PendingAuditRecord, flushErr error) {
	if h == nil || h.repo == nil || rec.Action == "" {
		return
	}
	result := "success"
	details := maps.Clone(rec.Details)
	if flushErr != nil {
		result = "failure"
		if details == nil {
			details = make(map[string]any, 1)
		}
		details["error"] = publicCPAErrorMessage(flushErr)
	}
	auditCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, _ = h.repo.RecordAuditEvent(auditCtx, repository.AuditEvent{
		OccurredAtMS:  time.Now().UnixMilli(),
		Action:        rec.Action,
		TargetType:    rec.TargetType,
		TargetID:      rec.TargetID,
		Result:        result,
		RequestID:     rec.RequestID,
		SourceSummary: rec.SourceSummary,
		Details:       details,
	})
}

// queueOrFlushDomainAudit wires audit recording cleanly for both async write-behind
// and explicit X-OMC-Sync callers. Recording via QueueDomainAudit before FlushNow
// guarantees that even if FlushNow hits a transient write_busy on the gate, the audit
// stays attached to the dirty domain until writeBehindLoop actually commits or rolls back.
func (h *Handler) queueOrFlushDomainAudit(request *http.Request, domain statecoord.DomainKey, action, targetType, targetID string, details map[string]any) error {
	if h.stateCoord == nil {
		return nil
	}
	if !isSyncWriteRequested(request) {
		h.stateCoord.QueueDomainAudit(domain, h.buildPendingAuditRecord(request, action, targetType, targetID, details))
		return nil
	}
	h.stateCoord.QueueDomainAudit(domain, h.buildPendingAuditRecord(request, action, targetType, targetID, details))
	return h.stateCoord.FlushNow(request.Context())
}

// projectProviderItemsFromRaw builds ProviderItemDTO rows from raw family slices and SQLite metadata overlays.
func projectProviderItemsFromRaw(
	configFamilies map[management.ConfigKeyFamily][]management.ConfigAPIKey,
	openAICompat []management.OpenAICompatibility,
	customNames map[string]string,
	customWebsites map[string]string,
	testModels map[string]string,
) []ProviderItemDTO {
	items := make([]ProviderItemDTO, 0)
	for _, spec := range providerConfigFamilies {
		if entries := configFamilies[spec.Family]; len(entries) > 0 {
			items = append(items, configKeyProviderItems(spec, entries, customNames)...)
		}
	}

	compatCapabilities := providerPolicyCapabilitiesFor(openAICompatibilityFamily)
	for i, entry := range openAICompat {
		entry = entry.ProviderRuntimeView()
		id := fmt.Sprintf("%s%d", openAICompatIDPrefix, i)
		name := firstNonEmpty(entry.Name, "OpenAI Compatible")
		if customNames != nil && customNames[id] != "" {
			name = customNames[id]
		}

		models := make([]string, 0, len(entry.Models))
		modelEntries := make([]ProviderModelDTO, 0, len(entry.Models))
		for _, m := range entry.Models {
			if m.Name != "" {
				models = append(models, m.Name)
			}
			var thinking *ThinkingDTO
			if m.Thinking != nil && len(m.Thinking.Levels) > 0 {
				thinking = &ThinkingDTO{Levels: slices.Clone(m.Thinking.Levels)}
			}
			modelEntries = append(modelEntries, ProviderModelDTO{
				Name:     m.Name,
				Alias:    m.Alias,
				Image:    m.Image,
				Thinking: thinking,
				Options:  providerModelOptionsDTO(m),
			})
		}

		hasKey := len(entry.LegacyAPIKeys) > 0 || len(entry.APIKeyEntries) > 0
		var firstKey string
		if len(entry.LegacyAPIKeys) > 0 {
			firstKey = entry.LegacyAPIKeys[0]
		} else if len(entry.APIKeyEntries) > 0 {
			firstKey = entry.APIKeyEntries[0].APIKey
		}
		keyEntries := make([]ProviderKeyEntryDTO, 0, len(entry.APIKeyEntries)+len(entry.LegacyAPIKeys))
		authIndexes := make([]string, 0, len(entry.APIKeyEntries))
		for ki, k := range entry.APIKeyEntries {
			authIndexes = append(authIndexes, nonEmptyStrings(k.AuthIndex)...)
			keyEntries = append(keyEntries, ProviderKeyEntryDTO{
				ConnectionPool:          providerPoolSettingsDTO(k.ConnectionPool),
				EffectiveConnectionPool: providerPoolSettingsDTO(management.MergeConnectionPools(entry.ConnectionPool, k.ConnectionPool)),
				Index:                   ki,
				APIKey:                  k.APIKey,
				ProxyURL:                k.ProxyURL,
				Weight:                  k.Weight,
			})
		}
		for ki, k := range entry.LegacyAPIKeys {
			keyEntries = append(keyEntries, ProviderKeyEntryDTO{
				Index:  len(entry.APIKeyEntries) + ki,
				APIKey: k,
			})
		}

		isPromptCacheKeySupported := entry.SupportPromptCacheKey
		items = append(items, ProviderItemDTO{
			ConnectionPool:  providerPoolGroupDTO(entry.Name, len(keyEntries), entry.ConnectionPool),
			ID:              id,
			Family:          openAICompatibilityFamily,
			Name:            name,
			UpstreamName:    entry.Name,
			Protocol:        "OpenAI Chat Completions",
			BaseURL:         entry.BaseURL,
			Prefix:          entry.Prefix,
			Priority:        entry.Priority,
			DisableCooling:  entry.DisableCooling != nil && *entry.DisableCooling,
			AuthIndexes:     authIndexes,
			Models:          models,
			ModelEntries:    modelEntries,
			Disabled:        entry.Disabled,
			KeyConfigured:   hasKey,
			APIKey:          firstKey,
			KeyEntries:      keyEntries,
			Headers:         maps.Clone(entry.Headers),
			ProxyConfigured: false,
			RuntimePolicy:   providerRuntimePolicyDTO(entry.DisableCooling, entry.RequestRetry, entry.RequestScopedErrors, compatCapabilities),
			Behavior:        &ProviderBehaviorDTO{SupportPromptCacheKey: &isPromptCacheKeySupported},
		})
	}

	for index := range items {
		if website := customWebsites[items[index].ID]; website != "" {
			items[index].Website = website
		}
		items[index].TestModel = testModels[items[index].ID]
	}
	return items
}

var errRuntimeOnlyProviderSlice = errors.New("provider group ownership is unavailable from CPA; refusing uneditable status write")
