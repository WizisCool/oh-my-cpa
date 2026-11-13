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
	Scalars                  management.ConfigScalarsDTO                                     `json:"scalars"`
	PendingScalars           map[string]pendingScalarEntry                                   `json:"pending_scalars,omitempty"`
	ScalarSeq                uint64                                                          `json:"scalar_seq"`
	ViewYAML                 string                                                          `json:"view_yaml"`
	SafeYAML                 string                                                          `json:"safe_yaml"`
	Revision                 string                                                          `json:"revision"`
	StoredLayout             string                                                          `json:"stored_layout"`
	ClientKeys               []string                                                        `json:"client_keys"`
	ConfigFamilies           map[management.ConfigKeyFamily][]management.ConfigAPIKey        `json:"config_families"`
	RuntimeOnlyFam           map[management.ConfigKeyFamily]bool                             `json:"runtime_only_fam,omitempty"`
	FailedProviderFamilies   map[management.ConfigKeyFamily]bool                             `json:"failed_provider_families,omitempty"`
	ProviderSliceFailed      bool                                                            `json:"provider_slice_failed,omitempty"`
	OpenAICompat             []management.OpenAICompatibility                                `json:"openai_compat"`
	OpenAIRuntime            bool                                                            `json:"openai_runtime,omitempty"`
	OpenAISliceFailed        bool                                                            `json:"openai_slice_failed,omitempty"`
	OAuthAliases             map[string][]managementOAuthModelAlias                          `json:"oauth_aliases"`
	OAuthAliasesUnavailable  bool                                                            `json:"oauth_aliases_unavailable,omitempty"`
	OAuthExcluded            map[string][]string                                             `json:"oauth_excluded"`
	OAuthExcludedUnavailable bool                                                            `json:"oauth_excluded_unavailable,omitempty"`
	AuthFiles                []management.AuthFile                                           `json:"auth_files"`
	AuthFilesUnavailable     bool                                                            `json:"auth_files_unavailable,omitempty"`
	PendingAuthStatus        map[string]pendingAuthFileStatus                                `json:"pending_auth_status,omitempty"`
	AuthStatusSeq            uint64                                                          `json:"auth_status_seq"`
	PendingOpenAIToggles     map[string]pendingProviderToggle                                `json:"pending_openai_toggles,omitempty"`
	PendingFamilyToggles     map[management.ConfigKeyFamily]map[string]pendingProviderToggle `json:"pending_family_toggles,omitempty"`
	ProviderToggleSeq        uint64                                                          `json:"provider_toggle_seq"`
}

type pendingProviderToggle struct {
	Disabled bool   `json:"disabled"`
	Seq      uint64 `json:"seq"`
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

func cloneConfigAPIKeys(src []management.ConfigAPIKey) []management.ConfigAPIKey {
	cloned := cloneViaJSON(src)
	if len(cloned) == len(src) {
		for i := range cloned {
			cloned[i].CopyRuntimeMetadataFrom(src[i])
		}
	}
	return cloned
}

func cloneOpenAICompatEntries(src []management.OpenAICompatibility) []management.OpenAICompatibility {
	cloned := cloneViaJSON(src)
	if len(cloned) == len(src) {
		for i := range cloned {
			cloned[i].CopyRuntimeMetadataFrom(src[i])
		}
	}
	return cloned
}

func cloneProjectedConfigState(src projectedConfigState) projectedConfigState {
	families := make(map[management.ConfigKeyFamily][]management.ConfigAPIKey, len(src.ConfigFamilies))
	for family, list := range src.ConfigFamilies {
		families[family] = cloneConfigAPIKeys(list)
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
	familyToggles := make(map[management.ConfigKeyFamily]map[string]pendingProviderToggle, len(src.PendingFamilyToggles))
	for fam, m := range src.PendingFamilyToggles {
		familyToggles[fam] = maps.Clone(m)
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
		FailedProviderFamilies:   maps.Clone(src.FailedProviderFamilies),
		ProviderSliceFailed:      src.ProviderSliceFailed,
		OpenAICompat:             cloneOpenAICompatEntries(src.OpenAICompat),
		OpenAIRuntime:            src.OpenAIRuntime,
		OpenAISliceFailed:        src.OpenAISliceFailed,
		OAuthAliases:             aliases,
		OAuthAliasesUnavailable:  src.OAuthAliasesUnavailable,
		OAuthExcluded:            excluded,
		OAuthExcludedUnavailable: src.OAuthExcludedUnavailable,
		AuthFiles:                cloneViaJSON(src.AuthFiles),
		AuthFilesUnavailable:     src.AuthFilesUnavailable,
		PendingAuthStatus:        maps.Clone(src.PendingAuthStatus),
		AuthStatusSeq:            src.AuthStatusSeq,
		PendingOpenAIToggles:     maps.Clone(src.PendingOpenAIToggles),
		PendingFamilyToggles:     familyToggles,
		ProviderToggleSeq:        src.ProviderToggleSeq,
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
		AfterFlush: func(flushedKeys []statecoord.DomainKey) {
			h.afterConfigWriteSideEffects()
			h.refreshCoordinatorYAMLBaseline()
			h.refreshFlushedProviderBaselines(flushedKeys)
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
			if len(snapshot.PendingScalars) == 0 {
				if err := h.ensureSnapshotRevisionMatchesUpstream(ctx, client, snapshot.Revision); err != nil {
					return err
				}
			}
			h.invalidateClientKeyCatalog()
			return client.UpdateClientAPIKeys(ctx, snapshot.ClientKeys)
		},
	})

	// 3. OpenAI-compatibility provider status toggles: reads fresh editable entries inside the gate
	// and overlays only pending status toggles so concurrent structural edits (BaseURL, routing priority/weights)
	// are never overwritten.
	coord.RegisterDomain(stateDomainOpenAICompat, statecoord.DomainSpec[projectedConfigState]{
		Order:  30,
		Scopes: []string{"management-providers", "management-providers-sanitized", "management-routing", "management-config", stateScopeIdentityDirectory},
		Flush: func(ctx context.Context, _ statecoord.DomainKey, snapshot projectedConfigState) error {
			if len(snapshot.PendingOpenAIToggles) == 0 {
				return nil
			}
			client, err := h.capabilityClient(ctx)
			if err != nil {
				return err
			}
			liveEntries, err := client.EditableOpenAICompatibility(ctx)
			if err != nil {
				return err
			}
			for targetKey, toggle := range snapshot.PendingOpenAIToggles {
				matches := 0
				var matchedIdx int
				for idx := range liveEntries {
					key := openAIToggleSelector(idx, liveEntries[idx].Name)
					if key == targetKey || (strings.HasPrefix(targetKey, "name:") && "name:"+strings.TrimSpace(liveEntries[idx].Name) == targetKey) {
						matchedIdx = idx
						matches++
					}
				}
				if matches != 1 {
					return management.ErrConfigChanged
				}
				liveEntries[matchedIdx].Disabled = toggle.Disabled
			}
			if err := client.UpdateOpenAICompatibility(ctx, liveEntries); err != nil {
				return err
			}
			h.providerKeyMasks.invalidate()
			h.identityArchive.reset()
			return nil
		},
		CleanPending: func(state *projectedConfigState, _ statecoord.DomainKey, flushed projectedConfigState) {
			for k, entry := range flushed.PendingOpenAIToggles {
				if cur, ok := state.PendingOpenAIToggles[k]; ok && cur.Seq <= entry.Seq {
					delete(state.PendingOpenAIToggles, k)
				}
			}
		},
	})

	// 4. Per-family config API-key provider status toggles (codex, claude, gemini, meta, xai, vertex, interactions):
	// reads fresh editable family entries inside the gate and overlays only ExcludedModels status toggles.
	coord.RegisterDomainPrefix(stateDomainProviderFamilyPrefix, statecoord.DomainSpec[projectedConfigState]{
		Order:  35,
		Scopes: []string{"management-providers", "management-providers-sanitized", "management-routing", "management-config", stateScopeIdentityDirectory},
		Flush: func(ctx context.Context, key statecoord.DomainKey, snapshot projectedConfigState) error {
			family := management.ConfigKeyFamily(strings.TrimPrefix(string(key), stateDomainProviderFamilyPrefix))
			pendingMap := snapshot.PendingFamilyToggles[family]
			if len(pendingMap) == 0 {
				return nil
			}
			client, err := h.capabilityClient(ctx)
			if err != nil {
				return err
			}
			liveEntries, err := client.EditableConfigAPIKeys(ctx, family)
			if err != nil {
				return err
			}
			for targetKey, toggle := range pendingMap {
				matched := false
				for idx := range liveEntries {
					entrySelector := familyToggleSelector(idx, liveEntries[idx].AuthIndex, liveEntries[idx].APIKey)
					if entrySelector == targetKey ||
						(strings.HasPrefix(targetKey, "auth:") && "auth:"+strings.TrimSpace(liveEntries[idx].AuthIndex) == targetKey) ||
						(strings.HasPrefix(targetKey, "key:") && "key:"+strings.TrimSpace(liveEntries[idx].APIKey) == targetKey) {
						liveEntries[idx].ExcludedModels = management.SetExcludedAll(liveEntries[idx].ExcludedModels, toggle.Disabled)
						matched = true
					}
				}
				if !matched {
					return management.ErrConfigChanged
				}
			}
			if err := client.UpdateConfigAPIKeys(ctx, family, liveEntries); err != nil {
				return err
			}
			h.providerKeyMasks.invalidate()
			h.identityArchive.reset()
			return nil
		},
		CleanPending: func(state *projectedConfigState, key statecoord.DomainKey, flushed projectedConfigState) {
			family := management.ConfigKeyFamily(strings.TrimPrefix(string(key), stateDomainProviderFamilyPrefix))
			flushedMap := flushed.PendingFamilyToggles[family]
			curMap := state.PendingFamilyToggles[family]
			if curMap == nil {
				return
			}
			for k, entry := range flushedMap {
				if cur, ok := curMap[k]; ok && cur.Seq <= entry.Seq {
					delete(curMap, k)
				}
			}
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
		Scopes: []string{"management-auth-files", "management-routing", "management-quota", stateScopeIdentityDirectory},
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

// refreshFlushedProviderBaselines reloads the runtime/editable slices of flushed
// provider toggle domains after CleanPending has cleared their staging maps, so
// regenerated CPA runtime auth_indexes and key masks are visible before state_sync fires.
func (h *Handler) refreshFlushedProviderBaselines(flushedKeys []statecoord.DomainKey) {
	if h == nil || h.stateCoord == nil || len(flushedKeys) == 0 {
		return
	}
	needOpenAI := false
	families := make([]management.ConfigKeyFamily, 0)
	for _, key := range flushedKeys {
		switch {
		case key == stateDomainOpenAICompat:
			needOpenAI = true
		case strings.HasPrefix(string(key), stateDomainProviderFamilyPrefix):
			fam := management.ConfigKeyFamily(strings.TrimPrefix(string(key), stateDomainProviderFamilyPrefix))
			families = append(families, fam)
		}
	}
	if !needOpenAI && len(families) == 0 {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	client, err := h.capabilityClient(ctx)
	if err != nil {
		return
	}
	var refreshedOpenAI []management.OpenAICompatibility
	var gotOpenAI bool
	if needOpenAI {
		if entries, readErr := client.EditableOpenAICompatibility(ctx); readErr == nil {
			refreshedOpenAI = entries
			gotOpenAI = true
		}
	}
	refreshedFamilies := make(map[management.ConfigKeyFamily][]management.ConfigAPIKey, len(families))
	for _, fam := range families {
		if entries, readErr := client.EditableConfigAPIKeys(ctx, fam); readErr == nil {
			refreshedFamilies[fam] = entries
		}
	}
	if !gotOpenAI && len(refreshedFamilies) == 0 {
		return
	}
	h.stateCoord.UpdateBaseline(func(state *projectedConfigState, _ bool) {
		if gotOpenAI && len(state.PendingOpenAIToggles) == 0 {
			state.OpenAICompat = cloneOpenAICompatEntries(refreshedOpenAI)
			state.OpenAISliceFailed = false
			state.OpenAIRuntime = false
		}
		for fam, entries := range refreshedFamilies {
			if len(state.PendingFamilyToggles[fam]) == 0 {
				state.ConfigFamilies[fam] = cloneConfigAPIKeys(entries)
				delete(state.FailedProviderFamilies, fam)
				delete(state.RuntimeOnlyFam, fam)
			}
		}
		state.ProviderSliceFailed = state.OpenAISliceFailed || len(state.FailedProviderFamilies) > 0
	})
	_, _ = h.readProviderItemsWithVersion(ctx, client)
}

// refreshCoordinatorYAMLBaseline updates the cached YAML/revision fields after a
// write-behind flush commits so subsequent ConfigPage reads and revision checks see
// the new upstream ETag immediately, even if another domain became dirty during flush.
func (h *Handler) refreshCoordinatorYAMLBaseline() {
	if h.stateCoord == nil {
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
	h.stateCoord.UpdateBaseline(func(state *projectedConfigState, isClean bool) {
		state.ViewYAML = viewYAML
		state.SafeYAML = safeYAML
		state.Revision = rev
		state.StoredLayout = storedLayout
		if isClean {
			clear(state.PendingScalars)
			clear(state.PendingAuthStatus)
			clear(state.PendingOpenAIToggles)
			clear(state.PendingFamilyToggles)
		}
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
	failedFamilies := make(map[management.ConfigKeyFamily]bool)
	anyProviderSliceFailed := openAIFailed
	for idx, spec := range providerConfigFamilies {
		if familyEntries[idx] != nil {
			configFamilies[spec.Family] = familyEntries[idx]
		} else {
			configFamilies[spec.Family] = []management.ConfigAPIKey{}
		}
		if familyFallback[idx] || familyFailed[idx] {
			runtimeOnlyFam[spec.Family] = true
		}
		if familyFailed[idx] {
			failedFamilies[spec.Family] = true
			anyProviderSliceFailed = true
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
		FailedProviderFamilies:   failedFamilies,
		ProviderSliceFailed:      anyProviderSliceFailed,
		OpenAICompat:             openAICompat,
		OpenAIRuntime:            openAIRuntime,
		OpenAISliceFailed:        openAIFailed,
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
	if err := h.stateCoord.Close(ctx); err != nil && h.logger != nil {
		h.logger.Warn("state coordinator close flush failed", "error", publicCPAErrorMessage(err))
	}
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

func openAIToggleSelector(index int, name string) string {
	trimmed := strings.TrimSpace(name)
	if trimmed != "" {
		return "name:" + trimmed
	}
	return fmt.Sprintf("idx:%d", index)
}

func familyToggleSelector(index int, authIndex, apiKey string) string {
	if trimmedAuth := strings.TrimSpace(authIndex); trimmedAuth != "" {
		return "auth:" + trimmedAuth
	}
	if trimmedKey := strings.TrimSpace(apiKey); trimmedKey != "" {
		return "key:" + trimmedKey
	}
	return fmt.Sprintf("idx:%d", index)
}

// mutateCoordinatorWithAudit atomically publishes an in-memory mutation together with its
// request-scoped deferred audit record, and for explicit X-OMC-Sync callers acquires the
// write gate BEFORE publishing the mutation so a gate timeout never leaves a rejected sync
// write queued in memory.
func (h *Handler) mutateCoordinatorWithAudit(
	request *http.Request,
	domain statecoord.DomainKey,
	action, targetType, targetID string,
	details map[string]any,
	mutateFn func(state *projectedConfigState) error,
) (uint64, error) {
	rec := h.buildPendingAuditRecord(request, action, targetType, targetID, details)
	if !isSyncWriteRequested(request) {
		return h.stateCoord.MutateWithAudit(request.Context(), domain, &rec, mutateFn)
	}
	if err := h.providerWrites.acquire(request.Context()); err != nil {
		return 0, err
	}
	defer h.providerWrites.release()
	h.configMu.Lock()
	defer h.configMu.Unlock()
	// Drain any pre-existing dirty domains before publishing this synchronous mutation so
	// an unrelated earlier domain's flush failure is never misreported as this write failing.
	_ = h.stateCoord.FlushWithinGate(request.Context())
	version, err := h.stateCoord.MutateWithAudit(request.Context(), domain, &rec, mutateFn)
	if err != nil {
		return 0, err
	}
	if flushErr := h.stateCoord.FlushWithinGate(request.Context()); flushErr != nil {
		return 0, flushErr
	}
	return version, nil
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
		runtimeKeys := make([]providerRuntimeKey, 0, len(entry.APIKeyEntries)+len(entry.LegacyAPIKeys))
		for ki, k := range entry.APIKeyEntries {
			authIndexes = append(authIndexes, nonEmptyStrings(k.AuthIndex)...)
			runtimeKeys = append(runtimeKeys, providerRuntimeKey{
				authIndex: k.AuthIndex,
				apiKey:    k.APIKey,
			})
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
			runtimeKeys = append(runtimeKeys, providerRuntimeKey{apiKey: k})
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
			runtimeKeys:     runtimeKeys,
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
