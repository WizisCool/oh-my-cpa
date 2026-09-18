package api

import (
	"fmt"
	"net/http"
	"strings"

	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/management"
)

type ProviderKeyEntryDTO struct {
	Index    int    `json:"index"`
	APIKey   string `json:"api_key"`
	ProxyURL string `json:"proxy_url,omitempty"`
	Weight   *int   `json:"weight,omitempty"`
}

type ThinkingDTO struct {
	Levels []string `json:"levels,omitempty"`
}

type ProviderModelDTO struct {
	Name     string       `json:"name"`
	Alias    string       `json:"alias,omitempty"`
	Image    bool         `json:"image,omitempty"`
	Thinking *ThinkingDTO `json:"thinking,omitempty"`
}

type ProviderItemDTO struct {
	ID     string `json:"id"`
	Family string `json:"family"`
	Name   string `json:"name"`
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
	UpstreamName    string                `json:"upstream_name,omitempty"`
	Protocol        string                `json:"protocol"`
	BaseURL         string                `json:"base_url,omitempty"`
	Prefix          string                `json:"prefix,omitempty"`
	Priority        *int                  `json:"priority,omitempty"`
	DisableCooling  bool                  `json:"disable_cooling"`
	AuthIndex       string                `json:"auth_index,omitempty"`
	Models          []string              `json:"models,omitempty"`
	ModelEntries    []ProviderModelDTO    `json:"model_entries,omitempty"`
	Disabled        bool                  `json:"disabled"`
	KeyConfigured   bool                  `json:"key_configured"`
	APIKey          string                `json:"api_key,omitempty"`
	KeyEntries      []ProviderKeyEntryDTO `json:"key_entries,omitempty"`
	Headers         map[string]string     `json:"headers,omitempty"`
	ProxyConfigured bool                  `json:"proxy_configured"`

	// Website is the provider's own homepage. It is Oh My CPA management metadata
	// rather than a CPA configuration field - CPA has nowhere to put it - so it is
	// stored beside the display name and joined on the same positional id. Only an
	// absolute http/https URL is ever reported, because the list renders it as a
	// link.
	Website string `json:"website,omitempty"`
}

// providerConfigFamilySpec describes one of CPA's config API-key credential
// families as the console presents and manages it.
//
// The families differ only in constants: which CPA list carries them, the
// positional id their rows get, and the name and protocol a row falls back to.
// They share one credential schema and one whole-list write, so they are data
// here instead of four copies of every code path - adding a provider whose
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
}

// providerConfigFamilies is the ordered registry of config API-key families the
// console manages. The declared order is the provider list's row order.
var providerConfigFamilies = []providerConfigFamilySpec{
	{Family: management.ConfigFamilyCodex, IDPrefix: "codex-", DefaultName: "Codex / Responses", PrefixLabel: "Codex", Protocol: "OpenAI Responses"},
	{Family: management.ConfigFamilyClaude, IDPrefix: "claude-", DefaultName: "Anthropic Claude", PrefixLabel: "Claude", Protocol: "Anthropic Messages"},
	{Family: management.ConfigFamilyGemini, IDPrefix: "gemini-", DefaultName: "Google Gemini", PrefixLabel: "Gemini", Protocol: "Gemini Generate Content"},
	{Family: management.ConfigFamilyMeta, IDPrefix: "meta-", DefaultName: "Meta Muse", PrefixLabel: "Meta", Protocol: "Meta Muse"},
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
	for i, entry := range entries {
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
			})
		}

		keyEntries := make([]ProviderKeyEntryDTO, 0)
		if strings.TrimSpace(entry.APIKey) != "" {
			keyEntries = append(keyEntries, ProviderKeyEntryDTO{
				Index:    0,
				APIKey:   entry.APIKey,
				ProxyURL: entry.ProxyURL,
				Weight:   entry.Weight,
			})
		}

		var disableCoolingVal bool
		if entry.DisableCooling != nil {
			disableCoolingVal = *entry.DisableCooling
		}

		// CPA disables config API-key credentials through the excluded-all marker
		// in excluded-models; the UI state must follow that truth.
		items = append(items, ProviderItemDTO{
			ID:              id,
			Family:          string(spec.Family),
			Name:            name,
			Protocol:        spec.Protocol,
			BaseURL:         entry.BaseURL,
			Prefix:          entry.Prefix,
			Priority:        entry.Priority,
			DisableCooling:  disableCoolingVal,
			AuthIndex:       entry.AuthIndex,
			Models:          models,
			ModelEntries:    modelEntries,
			Disabled:        management.IsExcludedAll(entry.ExcludedModels),
			KeyConfigured:   strings.TrimSpace(entry.APIKey) != "",
			APIKey:          entry.APIKey,
			KeyEntries:      keyEntries,
			Headers:         entry.Headers,
			ProxyConfigured: strings.TrimSpace(entry.ProxyURL) != "",
		})
	}
	return items
}

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
	includeKeys := strings.EqualFold(request.URL.Query().Get("include_keys"), "true")

	ctx := request.Context()
	items := make([]ProviderItemDTO, 0)
	customNames := h.loadProviderNames(ctx)
	customWebsites := h.loadProviderWebsites(ctx)

	// Config API-key families are walked from the registry rather than repeated
	// per family; the declared order is what the provider list follows.
	for _, spec := range providerConfigFamilies {
		entries, err := client.ConfigAPIKeys(ctx, spec.Family)
		if err != nil {
			continue
		}
		items = append(items, configKeyProviderItems(spec, entries, customNames)...)
	}

	if oaiResp, err := client.OpenAICompatibility(ctx); err == nil {
		for i, entry := range oaiResp.Entries {
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
			for ki, k := range entry.APIKeyEntries {
				keyEntries = append(keyEntries, ProviderKeyEntryDTO{
					Index:    ki,
					APIKey:   k.APIKey,
					ProxyURL: k.ProxyURL,
					Weight:   k.Weight,
				})
			}
			for ki, k := range entry.LegacyAPIKeys {
				keyEntries = append(keyEntries, ProviderKeyEntryDTO{
					Index:  len(entry.APIKeyEntries) + ki,
					APIKey: k,
				})
			}

			items = append(items, ProviderItemDTO{
				ID:              id,
				Family:          openAICompatibilityFamily,
				Name:            name,
				UpstreamName:    entry.Name,
				Protocol:        "OpenAI Chat Completions",
				BaseURL:         entry.BaseURL,
				Prefix:          entry.Prefix,
				Priority:        entry.Priority,
				DisableCooling:  entry.DisableCooling,
				Models:          models,
				ModelEntries:    modelEntries,
				Disabled:        entry.Disabled,
				KeyConfigured:   hasKey,
				APIKey:          firstKey,
				KeyEntries:      keyEntries,
				Headers:         entry.Headers,
				ProxyConfigured: false,
			})
		}
	}

	// Websites are management metadata keyed by the same positional id the names
	// use, so they are attached once here rather than in each family branch.
	if len(customWebsites) > 0 {
		for index := range items {
			if website := customWebsites[items[index].ID]; website != "" {
				items[index].Website = website
			}
		}
	}

	if !includeKeys {
		// The sanitized projection keeps the configured/absent signal but
		// strips plaintext key material and its per-entry detail.
		for index := range items {
			items[index].APIKey = ""
			items[index].KeyEntries = nil
		}
	}
	writeJSON(writer, http.StatusOK, map[string]any{
		"providers": items,
		"total":     len(items),
	})
}
