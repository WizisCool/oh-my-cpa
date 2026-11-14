package api

import (
	"context"
	"fmt"
	"maps"
	"net/http"
	"strings"
	"sync"

	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/management"
	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
	"github.com/oh-my-cpa/oh-my-cpa/internal/statecoord"
)

type ProviderKeyEntryDTO struct {
	ConnectionPool          *ProviderConnectionPoolSettingsDTO `json:"connection_pool"`
	EffectiveConnectionPool *ProviderConnectionPoolSettingsDTO `json:"effective_connection_pool"`
	Index                   int                                `json:"index"`
	APIKey                  string                             `json:"api_key"`
	ProxyURL                string                             `json:"proxy_url,omitempty"`
	Weight                  *int                               `json:"weight,omitempty"`
}

type ThinkingDTO struct {
	Levels []string `json:"levels,omitempty"`
}

type ProviderModelDTO struct {
	Name     string       `json:"name"`
	Alias    string       `json:"alias,omitempty"`
	Image    bool         `json:"image,omitempty"`
	Thinking *ThinkingDTO `json:"thinking,omitempty"`
	// Options is absent for a model with none of the advanced settings.
	Options *ProviderModelOptionsDTO `json:"options,omitempty"`
}

type ProviderItemDTO struct {
	ConnectionPool *ProviderConnectionPoolGroupDTO `json:"connection_pool,omitempty"`
	ID             string                          `json:"id"`
	Family         string                          `json:"family"`
	Name           string                          `json:"name"`
	// UpstreamName is the name the provider carries in CPA's own configuration,
	// recorded before a local custom name replaces it.
	//
	// It is not a secret - it is a label the operator wrote in config.yaml - and it
	// is the only sound way to join a stored request record back to the provider
	// that served it: CPA labels the usage queue with "openai-compatible-<name>",
	// so once Name has been overridden by a custom name the original is
	// unrecoverable and the join could only be guessed. Only the
	// openai-compatibility family names its entries upstream, so this stays empty
	// for the positional families, which CPA labels by family instead.
	UpstreamName   string `json:"upstream_name,omitempty"`
	Protocol       string `json:"protocol"`
	BaseURL        string `json:"base_url,omitempty"`
	Prefix         string `json:"prefix,omitempty"`
	Priority       *int   `json:"priority,omitempty"`
	DisableCooling bool   `json:"disable_cooling"`
	AuthIndex      string `json:"auth_index,omitempty"`
	// AuthIndexes are the runtime auth indexes of every key the provider holds. A request
	// record names the index of the key that served it, which is the only sound way to credit
	// traffic to a provider: CPA labels a family's keys by the family alone.
	AuthIndexes     []string                  `json:"auth_indexes,omitempty"`
	Models          []string                  `json:"models,omitempty"`
	ModelEntries    []ProviderModelDTO        `json:"model_entries,omitempty"`
	Disabled        bool                      `json:"disabled"`
	KeyConfigured   bool                      `json:"key_configured"`
	APIKey          string                    `json:"api_key,omitempty"`
	KeyEntries      []ProviderKeyEntryDTO     `json:"key_entries,omitempty"`
	Headers         map[string]string         `json:"headers,omitempty"`
	ProxyConfigured bool                      `json:"proxy_configured"`
	RuntimePolicy   *ProviderRuntimePolicyDTO `json:"runtime_policy,omitempty"`
	// Behavior is nil for a family with no request-behaviour switches.
	Behavior *ProviderBehaviorDTO `json:"behavior,omitempty"`

	// Website is the provider's own homepage. It is Oh My CPA management metadata
	// rather than a CPA configuration field - CPA has nowhere to put it - so it is
	// stored beside the display name and joined on the same positional id. Only an
	// absolute http/https URL is ever reported, because the list renders it as a
	// link.
	Website   string `json:"website,omitempty"`
	TestModel string `json:"test_model,omitempty"`

	// runtimeKeys stays internal so non-reveal projections can recover disabled
	// auth_indexes and record key masks without exposing plaintext keys in JSON.
	runtimeKeys          []providerRuntimeKey
	recoveredAuthIndexes map[string]bool
}

// providerConfigFamilySpec describes one of CPA's config API-key credential
// families as the console presents and manages it.
//
// The families differ only in constants: which CPA list carries them, the
// positional id their rows get, and the name and protocol a row falls back to.
// They share one credential schema and one whole-list write, so they are data
// here instead of one copy of every code path per family - adding a provider whose
// credentials CPA stores this way is a row in providerConfigFamilies plus its
// console-side presentation.
type providerConfigFamilySpec struct {
	Family      management.ConfigKeyFamily
	IDPrefix    string
	DefaultName string
	// PrefixLabel names the family inside a derived row name, e.g. "Codex (team)"
	// for an entry whose configured prefix is "team".
	PrefixLabel string
	Protocol    string
	// RequiresBaseURL marks a family whose entries CPA discards when they carry
	// no base URL. CPA does so silently and still answers the write with 200, so
	// the console refuses such an entry up front instead of reporting a save
	// whose row then never appears.
	RequiresBaseURL bool
	// PullProtocol is the auth dialect the family's upstream expects on a
	// model-list request; empty means the OpenAI bearer dialect.
	PullProtocol string
}

// providerConfigFamilies is the ordered registry of config API-key families the
// console manages. The declared order is the provider list's row order.
var providerConfigFamilies = []providerConfigFamilySpec{
	{Family: management.ConfigFamilyCodex, IDPrefix: "codex-", DefaultName: "Codex / Responses", PrefixLabel: "Codex", Protocol: "OpenAI Responses", RequiresBaseURL: true},
	{Family: management.ConfigFamilyClaude, IDPrefix: "claude-", DefaultName: "Anthropic Claude", PrefixLabel: "Claude", Protocol: "Anthropic Messages", PullProtocol: "anthropic"},
	{Family: management.ConfigFamilyGemini, IDPrefix: "gemini-", DefaultName: "Google Gemini", PrefixLabel: "Gemini", Protocol: "Gemini Generate Content", PullProtocol: "gemini"},
	{Family: management.ConfigFamilyMeta, IDPrefix: "meta-", DefaultName: "Meta Muse", PrefixLabel: "Meta", Protocol: "Meta Muse"},
	{Family: management.ConfigFamilyXAI, IDPrefix: "xai-", DefaultName: "xAI Grok", PrefixLabel: "xAI", Protocol: "xAI Grok", RequiresBaseURL: true},
	{Family: management.ConfigFamilyVertex, IDPrefix: "vertex-", DefaultName: "Vertex AI", PrefixLabel: "Vertex", Protocol: "Vertex Generate Content", PullProtocol: "gemini"},
	{Family: management.ConfigFamilyInteractions, IDPrefix: "interactions-", DefaultName: "Gemini Interactions", PrefixLabel: "Interactions", Protocol: "Interactions API", PullProtocol: "gemini"},
}

// lookupProviderConfigFamily resolves a provider family name to its registry row.
func lookupProviderConfigFamily(family string) (providerConfigFamilySpec, bool) {
	normalized := strings.ToLower(strings.TrimSpace(family))
	for _, spec := range providerConfigFamilies {
		if string(spec.Family) == normalized {
			return spec, true
		}
	}
	return providerConfigFamilySpec{}, false
}

// configKeyProviderItems projects one family's credential list into provider rows.
func configKeyProviderItems(spec providerConfigFamilySpec, entries []management.ConfigAPIKey, customNames map[string]string) []ProviderItemDTO {
	items := make([]ProviderItemDTO, 0, len(entries))
	capabilities := providerPolicyCapabilitiesFor(string(spec.Family))
	for i, entry := range entries {
		entry = entry.ProviderRuntimeView()
		id := fmt.Sprintf("%s%d", spec.IDPrefix, i)
		name := spec.DefaultName
		if customNames != nil && customNames[id] != "" {
			name = customNames[id]
		} else if entry.Prefix != "" {
			name = fmt.Sprintf("%s (%s)", spec.PrefixLabel, entry.Prefix)
		}

		models := make([]string, 0, len(entry.Models))
		modelEntries := make([]ProviderModelDTO, 0, len(entry.Models))
		for _, m := range entry.Models {
			if m.Name != "" {
				models = append(models, m.Name)
			}
			var thinking *ThinkingDTO
			if m.Thinking != nil && len(m.Thinking.Levels) > 0 {
				thinking = &ThinkingDTO{Levels: m.Thinking.Levels}
			}
			modelEntries = append(modelEntries, ProviderModelDTO{
				Name:     m.Name,
				Alias:    m.Alias,
				Image:    m.Image,
				Thinking: thinking,
				Options:  providerModelOptionsDTO(m),
			})
		}

		keyEntries := make([]ProviderKeyEntryDTO, 0)
		var runtimeKeys []providerRuntimeKey
		if strings.TrimSpace(entry.APIKey) != "" {
			pool := entry.ConnectionPoolContext()
			keyEntries = append(keyEntries, ProviderKeyEntryDTO{
				ConnectionPool:          providerPoolSettingsDTO(pool.Override),
				EffectiveConnectionPool: providerPoolSettingsDTO(pool.Effective),
				Index:                   0,
				APIKey:                  entry.APIKey,
				ProxyURL:                entry.ProxyURL,
				Weight:                  entry.Weight,
			})
			runtimeKeys = []providerRuntimeKey{{
				authIndex: entry.AuthIndex,
				apiKey:    entry.APIKey,
			}}
		}

		var disableCoolingVal bool
		if entry.DisableCooling != nil {
			disableCoolingVal = *entry.DisableCooling
		}

		// CPA disables config API-key credentials through the excluded-all marker
		// in excluded-models; the UI state must follow that truth.
		pool := entry.ConnectionPoolContext()
		items = append(items, ProviderItemDTO{
			ConnectionPool:  providerPoolGroupDTO(pool.GroupName, pool.GroupSize, pool.Group),
			ID:              id,
			Family:          string(spec.Family),
			Name:            name,
			Protocol:        spec.Protocol,
			BaseURL:         entry.BaseURL,
			Prefix:          entry.Prefix,
			Priority:        entry.Priority,
			DisableCooling:  disableCoolingVal,
			AuthIndex:       entry.AuthIndex,
			AuthIndexes:     nonEmptyStrings(entry.AuthIndex),
			Models:          models,
			ModelEntries:    modelEntries,
			Disabled:        management.IsExcludedAll(entry.ExcludedModels),
			KeyConfigured:   strings.TrimSpace(entry.APIKey) != "",
			APIKey:          entry.APIKey,
			KeyEntries:      keyEntries,
			Headers:         entry.Headers,
			ProxyConfigured: strings.TrimSpace(entry.ProxyURL) != "",
			RuntimePolicy:   providerRuntimePolicyDTO(entry.DisableCooling, entry.RequestRetry, entry.RequestScopedErrors, capabilities),
			Behavior:        configKeyBehaviorDTO(entry, capabilities),
			runtimeKeys:     runtimeKeys,
		})
	}
	return items
}

// nonEmptyStrings keeps the values that carry text, trimmed.
func nonEmptyStrings(values ...string) []string {
	kept := make([]string, 0, len(values))
	for _, value := range values {
		if trimmed := strings.TrimSpace(value); trimmed != "" {
			kept = append(kept, trimmed)
		}
	}
	return kept
}

// revealedProviderKeyCount counts the distinct credential entries in a provider
// response. KeyEntries is the complete list for both provider shapes, while a
// legacy response may carry only the first APIKey; counting both would report the
// compatibility providers' first key twice.
func revealedProviderKeyCount(items []ProviderItemDTO) int {
	count := 0
	for _, item := range items {
		if len(item.KeyEntries) > 0 {
			count += len(item.KeyEntries)
		} else if item.APIKey != "" {
			count++
		}
	}
	return count
}

// ManagementProviderListResponseDTO lists configured provider entries and optional state version.
type ManagementProviderListResponseDTO struct {
	Providers []ProviderItemDTO `json:"providers"`
	Total     int               `json:"total"`
	Version   uint64            `json:"version,omitempty"`
}

// @Summary List configured AI providers
// @Description Return configured AI providers with optional raw API key reveal (audited fail-closed when include_keys=true).
// @Tags Providers
// @Produce json
// @Security CookieAuth
// @Param include_keys query boolean false "Include raw API keys (audited fail-closed; refused in demo)"
// @Success 200 {object} ManagementProviderListResponseDTO
// @Failure 401 {object} ErrorResponseDTO
// @Failure 500 {object} ErrorResponseDTO
// @Failure 502 {object} ErrorResponseDTO
// @Router /v1/management/providers [get]
func (h *Handler) listManagementProviders(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	client, ok := h.managementClientOrError(writer, request)
	if !ok {
		return
	}
	// Downstream provider keys are plaintext only for the page whose contract
	// includes key management. Every other consumer (icon resolution, usage
	// pages) must request the sanitized projection; the secret never reaches
	// responses those pages receive.
	includeKeys := h.revealKeysAllowed(request)

	items, version := h.readProviderItemsWithVersion(request.Context(), client)

	if !includeKeys {
		// The sanitized projection keeps the configured/absent signal but
		// strips plaintext key material and its per-entry detail.
		for index := range items {
			items[index].APIKey = ""
			items[index].KeyEntries = nil
		}
	} else {
		// The reveal is the audit boundary: a masked response carries no credential,
		// so it is not a credential read and must not fill the log on every poll.
		if auditErr := h.recordAudit(request, "provider.reveal_keys", "provider", "list", "success", map[string]any{
			"provider_count": len(items),
			"key_count":      revealedProviderKeyCount(items),
		}); auditErr != nil {
			writeAuditFailure(writer, "audit log failure; provider key reveal aborted")
			return
		}
	}
	setStateVersionHeader(writer, version)
	writeJSON(writer, http.StatusOK, ManagementProviderListResponseDTO{
		Providers: items,
		Total:     len(items),
		Version:   version,
	})
}

func (h *Handler) readProviderItems(ctx context.Context, client *management.Client) []ProviderItemDTO {
	items, _ := h.readProviderItemsWithVersion(ctx, client)
	return items
}

func (h *Handler) readProviderItemsWithStatus(ctx context.Context, client *management.Client) ([]ProviderItemDTO, bool) {
	items, _, known := h.readProviderItemsCore(ctx, client)
	return items, known
}

func (h *Handler) readProviderItemsWithVersion(ctx context.Context, client *management.Client) ([]ProviderItemDTO, uint64) {
	items, version, _ := h.readProviderItemsCore(ctx, client)
	return items, version
}

func (h *Handler) readProviderItemsCore(ctx context.Context, client *management.Client) ([]ProviderItemDTO, uint64, bool) {
	if h.stateCoord != nil {
		// Load local SQLite metadata overlays BEFORE acquiring stateCoord.RLock so
		// the coordinator lock stays strictly I/O-free.
		customNames := h.loadProviderNames(ctx)
		customWebsites := h.loadProviderWebsites(ctx)
		testModels, _ := h.loadStringPreference(ctx, repository.PreferenceProviderTestModels)
		type projectedProviderInput struct {
			families      map[management.ConfigKeyFamily][]management.ConfigAPIKey
			failedFam     map[management.ConfigKeyFamily]bool
			openAI        []management.OpenAICompatibility
			openAIFailed  bool
			hasAnyFailure bool
		}
		env, err := statecoord.ProjectTyped(ctx, h.stateCoord, func(state projectedConfigState, _ uint64) (projectedProviderInput, error) {
			fams := make(map[management.ConfigKeyFamily][]management.ConfigAPIKey, len(state.ConfigFamilies))
			for fam, list := range state.ConfigFamilies {
				fams[fam] = cloneConfigAPIKeys(list)
			}
			return projectedProviderInput{
				families:      fams,
				failedFam:     maps.Clone(state.FailedProviderFamilies),
				openAI:        cloneOpenAICompatEntries(state.OpenAICompat),
				openAIFailed:  state.OpenAISliceFailed,
				hasAnyFailure: state.ProviderSliceFailed,
			}, nil
		})
		if err == nil {
			input := env.Data
			stillAnyFailure := false
			if input.hasAnyFailure {
				recoveredFamilies := make(map[management.ConfigKeyFamily][]management.ConfigAPIKey)
				recoveredRuntimeOnly := make(map[management.ConfigKeyFamily]bool)
				for fam := range input.failedFam {
					if entries, editErr := client.EditableConfigAPIKeys(ctx, fam); editErr == nil {
						input.families[fam] = entries
						recoveredFamilies[fam] = entries
					} else if runtimeEntries, runErr := client.ConfigAPIKeys(ctx, fam); runErr == nil {
						for idx := range runtimeEntries {
							runtimeEntries[idx].ConnectionPool = nil
						}
						input.families[fam] = runtimeEntries
						recoveredFamilies[fam] = runtimeEntries
						recoveredRuntimeOnly[fam] = true
					} else {
						stillAnyFailure = true
					}
				}
				var recoveredOpenAI []management.OpenAICompatibility
				var didRecoverOpenAI, recoveredOpenAIRuntime bool
				if input.openAIFailed {
					if entries, editErr := client.EditableOpenAICompatibility(ctx); editErr == nil {
						input.openAI = entries
						recoveredOpenAI = entries
						didRecoverOpenAI = true
					} else if runtime, runErr := client.OpenAICompatibility(ctx); runErr == nil {
						for idx := range runtime.Entries {
							runtime.Entries[idx].ConnectionPool = nil
							for ki := range runtime.Entries[idx].APIKeyEntries {
								runtime.Entries[idx].APIKeyEntries[ki].ConnectionPool = nil
							}
						}
						input.openAI = runtime.Entries
						recoveredOpenAI = runtime.Entries
						didRecoverOpenAI = true
						recoveredOpenAIRuntime = true
					} else {
						stillAnyFailure = true
					}
				}
				if len(recoveredFamilies) > 0 || didRecoverOpenAI {
					h.stateCoord.UpdateBaseline(func(state *projectedConfigState, _ bool) {
						for fam, entries := range recoveredFamilies {
							if len(state.PendingFamilyToggles[fam]) == 0 {
								state.ConfigFamilies[fam] = cloneConfigAPIKeys(entries)
							}
							delete(state.FailedProviderFamilies, fam)
							if recoveredRuntimeOnly[fam] {
								state.RuntimeOnlyFam[fam] = true
							} else {
								delete(state.RuntimeOnlyFam, fam)
							}
						}
						if didRecoverOpenAI {
							if len(state.PendingOpenAIToggles) == 0 {
								state.OpenAICompat = cloneOpenAICompatEntries(recoveredOpenAI)
							}
							state.OpenAISliceFailed = false
							state.OpenAIRuntime = recoveredOpenAIRuntime
						}
						state.ProviderSliceFailed = state.OpenAISliceFailed || len(state.FailedProviderFamilies) > 0
					})
				}
			}
			items := projectProviderItemsFromRaw(input.families, input.openAI, customNames, customWebsites, testModels)
			complete := !stillAnyFailure
			h.enrichAndArchiveProviders(ctx, items, complete)
			return items, env.Version, complete
		}
	}
	items, known := h.readProviderItemsUpstreamWithStatus(ctx, client)
	h.enrichAndArchiveProviders(ctx, items, known)
	return items, 0, known
}

func (h *Handler) readProviderItemsUpstreamWithStatus(ctx context.Context, client *management.Client) ([]ProviderItemDTO, bool) {
	items := make([]ProviderItemDTO, 0)
	customNames := h.loadProviderNames(ctx)
	customWebsites := h.loadProviderWebsites(ctx)
	testModels, _ := h.loadStringPreference(ctx, repository.PreferenceProviderTestModels)

	// Each family is independent and needs two upstream reads. Read them alongside
	// the compatibility list, then join by registry position so gateway latency
	// does not accumulate and completion order cannot reorder positional ids.
	familyItems := make([][]ProviderItemDTO, len(providerConfigFamilies))
	familyFailed := make([]bool, len(providerConfigFamilies))
	var reads sync.WaitGroup
	for index, spec := range providerConfigFamilies {
		reads.Go(func() {
			entries, err := client.EditableConfigAPIKeys(ctx, spec.Family)
			if err != nil {
				// Pool metadata is optional to this list. Keep the family visible from
				// CPA's runtime view when only the stored-group read failed; provider
				// writes still require the editable read and refuse to overwrite it.
				if entries, err = client.ConfigAPIKeys(ctx, spec.Family); err != nil {
					familyFailed[index] = true
					return
				}
				// The runtime read carries effective pool values, not the stored
				// group/key ownership. Omit them rather than presenting an inherited
				// value as this key's override.
				for index := range entries {
					entries[index].ConnectionPool = nil
				}
			}
			familyItems[index] = configKeyProviderItems(spec, entries, customNames)
		})
	}

	entries, err := client.EditableOpenAICompatibility(ctx)
	if err != nil {
		// The same runtime fallback applies to the OpenAI-compatible list, with
		// the same rule: its pool values have no stored ownership information.
		if runtime, runtimeErr := client.OpenAICompatibility(ctx); runtimeErr == nil {
			for index := range runtime.Entries {
				runtime.Entries[index].ConnectionPool = nil
				for keyIndex := range runtime.Entries[index].APIKeyEntries {
					runtime.Entries[index].APIKeyEntries[keyIndex].ConnectionPool = nil
				}
			}
			entries, err = runtime.Entries, nil
		}
	}
	reads.Wait()
	for _, family := range familyItems {
		items = append(items, family...)
	}
	if err == nil {
		for i, entry := range entries {
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
					thinking = &ThinkingDTO{Levels: m.Thinking.Levels}
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
			compatCapabilities := providerPolicyCapabilitiesFor(openAICompatibilityFamily)
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
				Headers:         entry.Headers,
				ProxyConfigured: false,
				RuntimePolicy:   providerRuntimePolicyDTO(entry.DisableCooling, entry.RequestRetry, entry.RequestScopedErrors, compatCapabilities),
				Behavior:        &ProviderBehaviorDTO{SupportPromptCacheKey: &isPromptCacheKeySupported},
				runtimeKeys:     runtimeKeys,
			})
		}
	}

	// Websites are management metadata keyed by the same positional id the names
	// use, so they are attached once here rather than in each family branch.
	for index := range items {
		if website := customWebsites[items[index].ID]; website != "" {
			items[index].Website = website
		}
		items[index].TestModel = testModels[items[index].ID]
	}

	allKnown := err == nil
	for _, failed := range familyFailed {
		if failed {
			allKnown = false
			break
		}
	}
	return items, allKnown
}
