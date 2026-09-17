package api

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/management"
	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
	"github.com/oh-my-cpa/oh-my-cpa/internal/security"
)

type ClientAPIKeyItemDTO struct {
	Index int    `json:"index"`
	Key   string `json:"key"`
	// Fingerprint is the legacy keys-page identity, computed under the
	// "client-key" purpose. It is retained so existing clients keep working.
	Fingerprint string `json:"fingerprint"`
	// UsageFingerprint is the identity this key has in the usage records
	// (`usage_events.api_group_key`), computed under the "usage-api-key"
	// purpose. Only this value can be joined to a request record, so it is what
	// an alias is stored against and what the "view requests" action filters by.
	// Empty when the cipher is unavailable; an empty value must never be used as
	// an alias identity.
	UsageFingerprint string `json:"usage_fingerprint,omitempty"`
	Length           int    `json:"length"`
	// Alias is the operator-assigned name, empty when the key is unnamed.
	Alias string `json:"alias,omitempty"`
	// AliasVersion is the version a rename must cite; zero means no alias exists.
	AliasVersion int64 `json:"alias_version"`
}

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

func (h *Handler) listClientAPIKeys(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	client, ok := h.managementClientOrError(writer, request)
	if !ok {
		return
	}

	keys, err := client.ClientAPIKeys(request.Context())
	if err != nil {
		writeCPAFacadeError(writer, err)
		return
	}

	aliases, aliasErr := h.repo.ListClientKeyAliases(request.Context(), defaultInstanceID())
	if aliasErr != nil {
		// The alias overlay is metadata. Failing the whole key list over it would
		// hide the keys themselves, so the list is served unnamed instead.
		aliases = map[string]repository.ClientKeyAlias{}
	}

	items := make([]ClientAPIKeyItemDTO, 0, len(keys))
	for i, key := range keys {
		trimmed := strings.TrimSpace(key)
		fingerprint := security.FingerprintOrRedacted(h.cipher, "client-key", trimmed)
		item := ClientAPIKeyItemDTO{
			Index:       i,
			Key:         trimmed,
			Fingerprint: fingerprint,
			Length:      len(trimmed),
		}
		// The usage identity is derived with the purpose the ingestion path uses,
		// which is what makes a name attach to the requests this key served. It is
		// left empty when the fingerprint fails rather than filled with the shared
		// redacted marker, because an alias keyed on that value would leak one
		// key's name onto another's records.
		if usageFingerprint, fpErr := h.repo.UsageClientKeyFingerprint(trimmed); fpErr == nil {
			item.UsageFingerprint = usageFingerprint
			if entry, ok := aliases[usageFingerprint]; ok {
				item.Alias = entry.Alias
				item.AliasVersion = entry.Version
			}
		}
		items = append(items, item)
	}

	writeJSON(writer, http.StatusOK, map[string]any{
		"keys":  items,
		"total": len(items),
	})
}

type createClientKeyRequest struct {
	Key string `json:"key"`
}

func (h *Handler) createClientAPIKey(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	var req createClientKeyRequest
	if err := decodeManagementJSON(writer, request, 8*1024, &req); err != nil {
		return
	}
	newKey := strings.TrimSpace(req.Key)
	if newKey == "" {
		writeError(writer, http.StatusBadRequest, "api key cannot be empty")
		return
	}

	client, ok := h.managementClientOrError(writer, request)
	if !ok {
		return
	}

	currentKeys, err := client.ClientAPIKeys(request.Context())
	if err != nil {
		writeCPAFacadeError(writer, err)
		return
	}

	updated := append(currentKeys, newKey)
	if auditErr := h.recordAudit(request, "api_key.create", "client_api_key", fmt.Sprintf("index:%d", len(currentKeys)), "attempt", nil); auditErr != nil {
		writeError(writer, http.StatusInternalServerError, "audit failure; key creation aborted")
		return
	}

	if err := client.UpdateClientAPIKeys(request.Context(), updated); err != nil {
		_ = h.recordAudit(request, "api_key.create", "client_api_key", fmt.Sprintf("index:%d", len(currentKeys)), "failure", map[string]any{"error": err.Error()})
		writeCPAFacadeError(writer, err)
		return
	}

	_ = h.recordAudit(request, "api_key.create", "client_api_key", fmt.Sprintf("index:%d", len(currentKeys)), "success", nil)

	writeJSON(writer, http.StatusOK, map[string]any{
		"status": "ok",
		"index":  len(currentKeys),
		"key":    newKey,
	})
}

func (h *Handler) deleteClientAPIKey(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	rawIndex := chi.URLParam(request, "index")
	index, err := strconv.Atoi(rawIndex)
	if err != nil || index < 0 {
		writeError(writer, http.StatusBadRequest, "invalid key index")
		return
	}

	client, ok := h.managementClientOrError(writer, request)
	if !ok {
		return
	}

	currentKeys, err := client.ClientAPIKeys(request.Context())
	if err != nil {
		writeCPAFacadeError(writer, err)
		return
	}

	if index >= len(currentKeys) {
		writeError(writer, http.StatusNotFound, "key index out of bounds")
		return
	}

	updated := make([]string, 0, len(currentKeys)-1)
	for i, key := range currentKeys {
		if i != index {
			updated = append(updated, key)
		}
	}

	if auditErr := h.recordAudit(request, "api_key.delete", "client_api_key", fmt.Sprintf("index:%d", index), "attempt", nil); auditErr != nil {
		writeError(writer, http.StatusInternalServerError, "audit failure; key deletion aborted")
		return
	}

	if err := client.UpdateClientAPIKeys(request.Context(), updated); err != nil {
		_ = h.recordAudit(request, "api_key.delete", "client_api_key", fmt.Sprintf("index:%d", index), "failure", map[string]any{"error": err.Error()})
		writeCPAFacadeError(writer, err)
		return
	}

	_ = h.recordAudit(request, "api_key.delete", "client_api_key", fmt.Sprintf("index:%d", index), "success", nil)

	writeJSON(writer, http.StatusOK, map[string]any{
		"status":  "ok",
		"deleted": index,
	})
}

func (h *Handler) loadProviderNames(ctx context.Context) map[string]string {
	if h.repo == nil {
		return nil
	}
	raw, found, err := h.repo.GetPreference(ctx, repository.PreferenceProviderNames)
	if err != nil || !found || raw == "" {
		return nil
	}
	var res map[string]string
	if err := json.Unmarshal([]byte(raw), &res); err != nil {
		return nil
	}
	return res
}

func (h *Handler) saveProviderName(ctx context.Context, id, name string) {
	if h.repo == nil || id == "" || name == "" {
		return
	}
	names := h.loadProviderNames(ctx)
	if names == nil {
		names = make(map[string]string)
	}
	names[id] = name
	h.saveProviderNames(ctx, names)
}

func (h *Handler) removeProviderName(ctx context.Context, id string) {
	if h.repo == nil || id == "" {
		return
	}
	names := h.loadProviderNames(ctx)
	if names == nil {
		return
	}
	delete(names, id)
	h.saveProviderNames(ctx, names)
}

// saveProviderNames replaces the whole name map. It exists for the operations
// that re-key several entries at once (a delete shifts every later position), so
// those cannot leave the stored overlay half-written.
func (h *Handler) saveProviderNames(ctx context.Context, names map[string]string) {
	if h.repo == nil {
		return
	}
	encoded, err := json.Marshal(names)
	if err == nil {
		_ = h.repo.PutPreference(ctx, repository.PreferenceProviderNames, string(encoded))
	}
}

// shiftProviderMetadataAfterDelete re-keys the operator metadata of every entry
// that moved down one position when an entry was deleted.
func (h *Handler) shiftProviderMetadataAfterDelete(ctx context.Context, idPrefix string, deletedIndex int) {
	if idPrefix == "" {
		return
	}
	if names := h.loadProviderNames(ctx); len(names) > 0 {
		h.saveProviderNames(ctx, shiftPositionalProviderIDs(names, idPrefix, deletedIndex))
	}
	if websites := h.loadProviderWebsites(ctx); len(websites) > 0 {
		h.saveProviderWebsites(ctx, shiftPositionalProviderIDs(websites, idPrefix, deletedIndex))
	}
}

// idPrefixForFamily is the positional id prefix a family's rows carry.
func idPrefixForFamily(family string) string {
	if spec, ok := lookupProviderConfigFamily(family); ok {
		return spec.IDPrefix
	}
	if family == openAICompatibilityFamily {
		return openAICompatIDPrefix
	}
	return ""
}

// shiftPositionalProviderIDs re-keys one family's metadata after an entry was
// deleted, mapping a stored positional id onto the entry's new position.
//
// Provider rows are addressed by position, and an operator's name and website are
// stored under that same id. Deleting an entry moves every later entry down one,
// so without re-keying the name given to one credential would relabel whichever
// credential took its place — and the deleted entry's own name would survive on
// an unrelated row. Ids of other families are left untouched; the overlay is
// shared across families and only this one's positions moved.
func shiftPositionalProviderIDs(entries map[string]string, idPrefix string, deletedIndex int) map[string]string {
	if len(entries) == 0 {
		return entries
	}
	shifted := make(map[string]string, len(entries))
	for id, value := range entries {
		if !strings.HasPrefix(id, idPrefix) {
			shifted[id] = value
			continue
		}
		index, err := strconv.Atoi(strings.TrimPrefix(id, idPrefix))
		if err != nil {
			// An id this family cannot be addressed by is not ours to rewrite.
			shifted[id] = value
			continue
		}
		switch {
		case index == deletedIndex:
			// The entry this metadata described no longer exists.
		case index > deletedIndex:
			shifted[fmt.Sprintf("%s%d", idPrefix, index-1)] = value
		default:
			shifted[id] = value
		}
	}
	return shifted
}

// loadProviderWebsites reads the per-provider homepage map. It is keyed by the
// same positional provider id as provider_names, so the two move together when a
// provider is deleted and neither can be joined to the wrong entry.
func (h *Handler) loadProviderWebsites(ctx context.Context) map[string]string {
	if h.repo == nil {
		return nil
	}
	raw, found, err := h.repo.GetPreference(ctx, repository.PreferenceProviderWebsites)
	if err != nil || !found || raw == "" {
		return nil
	}
	var res map[string]string
	if err := json.Unmarshal([]byte(raw), &res); err != nil {
		return nil
	}
	return res
}

// saveProviderWebsite writes one provider's homepage. An empty url removes the
// entry rather than storing an empty string, so "no website" has exactly one
// representation in storage.
func (h *Handler) saveProviderWebsite(ctx context.Context, id, website string) {
	if h.repo == nil || id == "" {
		return
	}
	websites := h.loadProviderWebsites(ctx)
	if websites == nil {
		websites = make(map[string]string)
	}
	if website == "" {
		if _, present := websites[id]; !present {
			return
		}
		delete(websites, id)
	} else {
		websites[id] = website
	}
	h.saveProviderWebsites(ctx, websites)
}

// applyProviderWebsite stores a website only when the save request actually
// carried the field.
//
// The distinction is load-bearing rather than defensive: a client that predates
// the field sends no website at all, and reading that as "clear it" would wipe
// operator metadata on every rename performed from such a client. An explicitly
// present empty string is what clears it.
func (h *Handler) applyProviderWebsite(ctx context.Context, id, website string, isProvided bool) {
	if !isProvided {
		return
	}
	h.saveProviderWebsite(ctx, id, website)
}

// saveProviderWebsites replaces the whole website map, for the operations that
// re-key several entries at once.
func (h *Handler) saveProviderWebsites(ctx context.Context, websites map[string]string) {
	if h.repo == nil {
		return
	}
	encoded, err := json.Marshal(websites)
	if err == nil {
		_ = h.repo.PutPreference(ctx, repository.PreferenceProviderWebsites, string(encoded))
	}
}

func (h *Handler) removeProviderWebsite(ctx context.Context, id string) {
	h.saveProviderWebsite(ctx, id, "")
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

type patchProviderStatusRequest struct {
	Family   string `json:"family"`
	Index    int    `json:"index"`
	Disabled bool   `json:"disabled"`
	// ExpectedAuthIndex and ExpectedName are optional preconditions. Providers
	// are addressed positionally, and the client now retries a transient failure,
	// so between two attempts another session could delete a provider and shift
	// every later index. Without a precondition that retry would toggle a
	// different provider than the operator clicked, silently. When either is
	// supplied it must still match the entry at that index, or the write is
	// refused with a conflict instead of touching the wrong row.
	//
	// They are optional rather than required so an older client keeps working;
	// the browser always sends whichever of the two its row carries.
	ExpectedAuthIndex string `json:"expected_auth_index,omitempty"`
	ExpectedName      string `json:"expected_name,omitempty"`
}

// verifyAuthIndex refuses the write when the caller named the provider it meant
// and the entry at that position is not it.
//
// The client retries a transient failure, and positions shift when a provider is
// deleted; comparing the identity the operator actually saw turns a retry that
// would have toggled a different provider into an explicit conflict.
func (req patchProviderStatusRequest) verifyAuthIndex(actual string) error {
	expected := strings.TrimSpace(req.ExpectedAuthIndex)
	if expected == "" {
		return nil
	}
	if strings.TrimSpace(actual) != expected {
		return newProviderWriteError(
			http.StatusConflict,
			"the provider at this position changed since it was read; refresh and try again",
		)
	}
	return nil
}

// verifyName is the same precondition for the family that has no auth index:
// openai-compatibility entries are identified by their configured name.
func (req patchProviderStatusRequest) verifyName(actual string) error {
	expected := strings.TrimSpace(req.ExpectedName)
	if expected == "" {
		return nil
	}
	if strings.TrimSpace(actual) != expected {
		return newProviderWriteError(
			http.StatusConflict,
			"the provider at this position changed since it was read; refresh and try again",
		)
	}
	return nil
}

func (h *Handler) patchManagementProviderStatus(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	var req patchProviderStatusRequest
	if err := decodeManagementJSON(writer, request, 8*1024, &req); err != nil {
		return
	}
	// A negative index is rejected here rather than by the bounds check below,
	// which compares against a length and would accept it.
	if req.Index < 0 {
		writeError(writer, http.StatusBadRequest, "provider index must not be negative")
		return
	}

	client, ok := h.managementClientOrError(writer, request)
	if !ok {
		return
	}

	ctx := request.Context()
	targetID := fmt.Sprintf("%s-%d", req.Family, req.Index)

	if auditErr := h.recordAudit(request, "provider.toggle_status", "provider", targetID, "attempt", map[string]any{"disabled": req.Disabled}); auditErr != nil {
		writeError(writer, http.StatusInternalServerError, "audit failure; status update aborted")
		return
	}

	if err := h.writeProviderStatus(ctx, client, req); err != nil {
		_ = h.recordAudit(request, "provider.toggle_status", "provider", targetID, "failure", map[string]any{"error": err.Error()})
		writeProviderWriteError(writer, err)
		return
	}

	_ = h.recordAudit(request, "provider.toggle_status", "provider", targetID, "success", map[string]any{"disabled": req.Disabled})

	writeJSON(writer, http.StatusOK, map[string]any{
		"status":   "ok",
		"family":   req.Family,
		"index":    req.Index,
		"disabled": req.Disabled,
	})
}

// writeProviderStatus is the whole-list read-modify-write behind one toggle. It
// reports the outcome instead of replying, because the caller records the audit
// result and composes the response only after the write window is released.
func (h *Handler) writeProviderStatus(ctx context.Context, client *management.Client, req patchProviderStatusRequest) error {
	if spec, ok := lookupProviderConfigFamily(req.Family); ok {
		return h.writeConfigKeyProviderStatus(ctx, client, spec, req)
	}
	switch req.Family {
	case openAICompatibilityFamily:
		return gatedProviderListWrite(h, ctx,
			func(ctx context.Context) (management.OpenAICompatibilityResponse, error) {
				return client.OpenAICompatibility(ctx)
			},
			func(ctx context.Context, list management.OpenAICompatibilityResponse) error {
				return client.UpdateOpenAICompatibility(ctx, list.Entries)
			},
			func(list *management.OpenAICompatibilityResponse) error {
				if req.Index >= len(list.Entries) {
					return newProviderWriteError(http.StatusNotFound, "provider index out of bounds")
				}
				if err := req.verifyName(list.Entries[req.Index].Name); err != nil {
					return err
				}
				list.Entries[req.Index].Disabled = req.Disabled
				return nil
			})
	default:
		return newProviderWriteError(http.StatusBadRequest, "provider family does not support status toggle")
	}
}

// writeConfigKeyProviderStatus flips one config API-key credential's enable state.
//
// These entries have no disabled field in CPA's schema, so the gateway cannot see
// a local preference. CPA's own disable mechanism is the excluded-all marker in
// excluded-models; anything else only repaints the UI while the gateway keeps
// routing — that is exactly the fallback leak this used to cause.
func (h *Handler) writeConfigKeyProviderStatus(ctx context.Context, client *management.Client, spec providerConfigFamilySpec, req patchProviderStatusRequest) error {
	return gatedProviderListWrite(h, ctx,
		func(ctx context.Context) ([]management.ConfigAPIKey, error) {
			return client.ConfigAPIKeys(ctx, spec.Family)
		},
		func(ctx context.Context, list []management.ConfigAPIKey) error {
			return client.UpdateConfigAPIKeys(ctx, spec.Family, list)
		},
		func(list *[]management.ConfigAPIKey) error {
			if req.Index >= len(*list) {
				return newProviderWriteError(http.StatusNotFound, "provider index out of bounds")
			}
			if err := req.verifyAuthIndex((*list)[req.Index].AuthIndex); err != nil {
				return err
			}
			(*list)[req.Index].ExcludedModels = management.SetExcludedAll((*list)[req.Index].ExcludedModels, req.Disabled)
			return nil
		})
}

type SaveProviderKeyEntry struct {
	APIKey   string `json:"api_key,omitempty"`
	ProxyURL string `json:"proxy_url,omitempty"`
	Weight   *int   `json:"weight,omitempty"`
}

type SaveProviderModelEntry struct {
	Name     string       `json:"name"`
	Alias    string       `json:"alias,omitempty"`
	Image    bool         `json:"image,omitempty"`
	Thinking *ThinkingDTO `json:"thinking,omitempty"`
}

type SaveProviderRequest struct {
	Family         string                   `json:"family"`
	Name           string                   `json:"name"`
	BaseURL        string                   `json:"base_url"`
	Prefix         string                   `json:"prefix,omitempty"`
	Priority       *int                     `json:"priority,omitempty"`
	DisableCooling bool                     `json:"disable_cooling"`
	APIKey         string                   `json:"api_key,omitempty"`
	Keys           []SaveProviderKeyEntry   `json:"keys,omitempty"`
	Models         []string                 `json:"models,omitempty"`
	ModelEntries   []SaveProviderModelEntry `json:"model_entries,omitempty"`
	Headers        map[string]string        `json:"headers,omitempty"`
	Disabled       bool                     `json:"disabled"`
	// Website is operator metadata, not a CPA field. nil means "leave the stored
	// value alone"; a present empty string clears it. That distinction is what
	// lets a rename save from a client that never carried a website field avoid
	// erasing one.
	Website *string `json:"website,omitempty"`
}

// normalizeProviderWebsite accepts only a URL this console may render as a link.
//
// The value ends up in an href, so the scheme is the security boundary: a
// javascript: or data: URL would be script execution with the session's
// authority, and a scheme-relative or relative value would silently point at
// this console instead of the provider. Anything that is not an absolute
// http/https URL with a host is refused rather than repaired.
func normalizeProviderWebsite(raw string) (string, bool) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return "", true
	}
	if len(trimmed) > maxProviderWebsiteLength {
		return "", false
	}
	parsed, err := url.Parse(trimmed)
	if err != nil {
		return "", false
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return "", false
	}
	if parsed.Host == "" {
		return "", false
	}
	return parsed.String(), true
}

// resolveProviderWebsite validates the optional website field of a save request,
// reporting separately whether the field was present and whether it is usable.
// The two questions are independent: an absent field is valid input that leaves
// the stored value alone, while a present but unusable one is an error.
func resolveProviderWebsite(raw *string) (website string, isProvided bool, isValid bool) {
	if raw == nil {
		return "", false, true
	}
	normalized, ok := normalizeProviderWebsite(*raw)
	if !ok {
		return "", true, false
	}
	return normalized, true, true
}

// maxProviderWebsiteLength bounds the stored value well below the preference
// document limit, so one absurd entry cannot consume the whole map's budget.
const maxProviderWebsiteLength = 512

// The openai-compatibility family is not a config API-key list: its entries are
// whole provider objects with their own credential list, so it keeps constants
// of its own instead of a row in providerConfigFamilies.
const (
	openAICompatibilityFamily = "openai-compatibility"
	openAICompatIDPrefix      = "openai-compat-"
)

// parseProviderID splits a positional provider id such as `meta-2` into its
// family and index. The config API-key prefixes come from the family registry,
// so a new family is addressable without touching this function.
func parseProviderID(id string) (string, int, error) {
	trimmed := strings.TrimSpace(id)
	if strings.HasPrefix(trimmed, openAICompatIDPrefix) {
		idx, err := strconv.Atoi(strings.TrimPrefix(trimmed, openAICompatIDPrefix))
		return openAICompatibilityFamily, idx, err
	}
	for _, spec := range providerConfigFamilies {
		if !strings.HasPrefix(trimmed, spec.IDPrefix) {
			continue
		}
		idx, err := strconv.Atoi(strings.TrimPrefix(trimmed, spec.IDPrefix))
		return string(spec.Family), idx, err
	}
	return "", 0, fmt.Errorf("unknown provider id format: %s", trimmed)
}

// The openai-compatibility append helper builds the new entry against the list as it
// exists inside the write window, so an append cannot be based on a stale length.
func (h *Handler) appendOpenAICompatibilityGated(ctx context.Context, client *management.Client, entry management.OpenAICompatibility) ([]management.OpenAICompatibility, error) {
	var updated []management.OpenAICompatibility
	err := gatedProviderListWrite(h, ctx,
		func(ctx context.Context) ([]management.OpenAICompatibility, error) {
			resp, err := client.OpenAICompatibility(ctx)
			if err != nil {
				return nil, err
			}
			return resp.Entries, nil
		},
		func(ctx context.Context, list []management.OpenAICompatibility) error {
			return client.UpdateOpenAICompatibility(ctx, list)
		},
		func(list *[]management.OpenAICompatibility) error {
			updated = append(append([]management.OpenAICompatibility{}, *list...), entry)
			*list = updated
			return nil
		})
	return updated, err
}

// The helpers below run one config API-key family's read-modify-write inside the
// console's provider write window. They are family-agnostic on purpose: the
// family is a runtime value, so a new credential list needs no new code path.

// appendConfigKeyProvider adds one credential to the family list.
func (h *Handler) appendConfigKeyProvider(ctx context.Context, client *management.Client, spec providerConfigFamilySpec, entry management.ConfigAPIKey) ([]management.ConfigAPIKey, error) {
	var updated []management.ConfigAPIKey
	err := gatedProviderListWrite(h, ctx,
		func(ctx context.Context) ([]management.ConfigAPIKey, error) {
			return client.ConfigAPIKeys(ctx, spec.Family)
		},
		func(ctx context.Context, list []management.ConfigAPIKey) error {
			return client.UpdateConfigAPIKeys(ctx, spec.Family, list)
		},
		func(list *[]management.ConfigAPIKey) error {
			updated = append(append([]management.ConfigAPIKey{}, *list...), entry)
			*list = updated
			return nil
		})
	return updated, err
}

// mutateConfigKeyProvider edits one credential at index. The list is read inside
// the write window, so the edit cannot be applied to a stale snapshot.
func (h *Handler) mutateConfigKeyProvider(ctx context.Context, client *management.Client, spec providerConfigFamilySpec, index int, apply func(*management.ConfigAPIKey)) error {
	return gatedProviderListWrite(h, ctx,
		func(ctx context.Context) ([]management.ConfigAPIKey, error) {
			return client.ConfigAPIKeys(ctx, spec.Family)
		},
		func(ctx context.Context, list []management.ConfigAPIKey) error {
			return client.UpdateConfigAPIKeys(ctx, spec.Family, list)
		},
		func(list *[]management.ConfigAPIKey) error {
			if index >= len(*list) {
				return newProviderWriteError(http.StatusNotFound, "provider index out of bounds")
			}
			apply(&(*list)[index])
			return nil
		})
}

// deleteConfigKeyProvider removes one credential at index.
func (h *Handler) deleteConfigKeyProvider(ctx context.Context, client *management.Client, spec providerConfigFamilySpec, index int) error {
	return gatedProviderListWrite(h, ctx,
		func(ctx context.Context) ([]management.ConfigAPIKey, error) {
			return client.ConfigAPIKeys(ctx, spec.Family)
		},
		func(ctx context.Context, list []management.ConfigAPIKey) error {
			return client.UpdateConfigAPIKeys(ctx, spec.Family, list)
		},
		func(list *[]management.ConfigAPIKey) error {
			if index >= len(*list) {
				return newProviderWriteError(http.StatusNotFound, "provider index out of bounds")
			}
			*list = append(append([]management.ConfigAPIKey{}, (*list)[:index]...), (*list)[index+1:]...)
			return nil
		})
}

func (h *Handler) createManagementProvider(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	var req SaveProviderRequest
	if err := decodeManagementJSON(writer, request, 32*1024, &req); err != nil {
		return
	}

	family := strings.ToLower(strings.TrimSpace(req.Family))
	if family == "" {
		family = openAICompatibilityFamily
	}
	name := strings.TrimSpace(req.Name)
	if name == "" {
		name = "Custom Provider"
	}
	baseURL := strings.TrimSpace(req.BaseURL)
	apiKey := strings.TrimSpace(req.APIKey)

	// Validated before any CPA write: refusing a bad scheme after the gateway had
	// already been changed would leave the console and CPA disagreeing.
	website, websiteProvided, isWebsiteValid := resolveProviderWebsite(req.Website)
	if !isWebsiteValid {
		writeError(writer, http.StatusBadRequest, "website must be an absolute http or https URL")
		return
	}

	client, ok := h.managementClientOrError(writer, request)
	if !ok {
		return
	}

	ctx := request.Context()
	models := make([]management.ModelAlias, 0)
	if len(req.ModelEntries) > 0 {
		for _, m := range req.ModelEntries {
			mName := strings.TrimSpace(m.Name)
			if mName != "" {
				alias := strings.TrimSpace(m.Alias)
				if alias == "" {
					alias = mName
				}
				var thinking *management.ThinkingSupport
				if m.Thinking != nil && len(m.Thinking.Levels) > 0 {
					thinking = &management.ThinkingSupport{Levels: m.Thinking.Levels}
				}
				models = append(models, management.ModelAlias{
					Name:     mName,
					Alias:    alias,
					Image:    m.Image,
					Thinking: thinking,
				})
			}
		}
	} else {
		for _, m := range req.Models {
			m = strings.TrimSpace(m)
			if m != "" {
				models = append(models, management.ModelAlias{Name: m, Alias: m})
			}
		}
	}

	firstKey := apiKey
	firstProxy := ""
	var firstWeight *int
	if len(req.Keys) > 0 {
		if kVal := strings.TrimSpace(req.Keys[0].APIKey); kVal != "" {
			firstKey = kVal
		}
		firstProxy = strings.TrimSpace(req.Keys[0].ProxyURL)
		firstWeight = req.Keys[0].Weight
	}

	var disableCoolingPtr *bool
	if req.DisableCooling {
		t := true
		disableCoolingPtr = &t
	}

	if auditErr := h.recordAudit(request, "provider.create", "provider", family, "attempt", map[string]any{"name": name}); auditErr != nil {
		writeError(writer, http.StatusInternalServerError, "audit failure; provider creation aborted")
		return
	}

	switch family {
	case openAICompatibilityFamily:
		newEntry := management.OpenAICompatibility{
			Name:           name,
			BaseURL:        baseURL,
			Prefix:         strings.TrimSpace(req.Prefix),
			Priority:       req.Priority,
			DisableCooling: req.DisableCooling,
			Disabled:       req.Disabled,
			Models:         models,
			Headers:        req.Headers,
		}
		if len(req.Keys) > 0 {
			for _, k := range req.Keys {
				if strings.TrimSpace(k.APIKey) != "" {
					newEntry.APIKeyEntries = append(newEntry.APIKeyEntries, management.APIKeyEntry{
						APIKey:   strings.TrimSpace(k.APIKey),
						ProxyURL: strings.TrimSpace(k.ProxyURL),
						Weight:   k.Weight,
					})
				}
			}
		} else if apiKey != "" {
			newEntry.APIKeyEntries = []management.APIKeyEntry{{APIKey: apiKey}}
		}
		entries, err := h.appendOpenAICompatibilityGated(ctx, client, newEntry)
		if err != nil {
			_ = h.recordAudit(request, "provider.create", "provider", family, "failure", map[string]any{"error": err.Error()})
			writeProviderWriteError(writer, err)
			return
		}
		targetID := fmt.Sprintf("%s%d", openAICompatIDPrefix, len(entries)-1)
		h.saveProviderName(ctx, targetID, name)
		h.applyProviderWebsite(ctx, targetID, website, websiteProvided)

	default:
		// Every other supported family is a config API-key list, which the registry
		// describes. The entry body is identical across them.
		spec, isConfigFamily := lookupProviderConfigFamily(family)
		if !isConfigFamily {
			writeError(writer, http.StatusBadRequest, "unsupported provider family: "+family)
			return
		}
		newEntry := management.ConfigAPIKey{
			APIKey:         firstKey,
			BaseURL:        baseURL,
			ProxyURL:       firstProxy,
			Prefix:         strings.TrimSpace(req.Prefix),
			Priority:       req.Priority,
			Weight:         firstWeight,
			Headers:        req.Headers,
			Models:         models,
			DisableCooling: disableCoolingPtr,
		}
		entries, err := h.appendConfigKeyProvider(ctx, client, spec, newEntry)
		if err != nil {
			_ = h.recordAudit(request, "provider.create", "provider", family, "failure", map[string]any{"error": err.Error()})
			writeProviderWriteError(writer, err)
			return
		}
		targetID := fmt.Sprintf("%s%d", spec.IDPrefix, len(entries)-1)
		h.saveProviderName(ctx, targetID, name)
		h.applyProviderWebsite(ctx, targetID, website, websiteProvided)
	}

	_ = h.recordAudit(request, "provider.create", "provider", family, "success", map[string]any{"name": name})

	if h.pricing != nil {
		h.pricing.NotifyModelsChanged()
	}

	writeJSON(writer, http.StatusOK, map[string]any{
		"status": "ok",
		"family": family,
	})
}

func (h *Handler) updateManagementProvider(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	id := chi.URLParam(request, "id")
	family, index, err := parseProviderID(id)
	if err != nil || index < 0 {
		writeError(writer, http.StatusBadRequest, "invalid provider id")
		return
	}

	var req SaveProviderRequest
	if err := decodeManagementJSON(writer, request, 32*1024, &req); err != nil {
		return
	}

	client, ok := h.managementClientOrError(writer, request)
	if !ok {
		return
	}

	ctx := request.Context()
	name := strings.TrimSpace(req.Name)
	baseURL := strings.TrimSpace(req.BaseURL)
	apiKey := strings.TrimSpace(req.APIKey)

	// Validated before any CPA write: refusing a bad scheme after the gateway had
	// already changed would leave the console and CPA disagreeing.
	website, websiteProvided, isWebsiteValid := resolveProviderWebsite(req.Website)
	if !isWebsiteValid {
		writeError(writer, http.StatusBadRequest, "website must be an absolute http or https URL")
		return
	}

	models := make([]management.ModelAlias, 0)
	if len(req.ModelEntries) > 0 {
		for _, m := range req.ModelEntries {
			mName := strings.TrimSpace(m.Name)
			if mName != "" {
				alias := strings.TrimSpace(m.Alias)
				if alias == "" {
					alias = mName
				}
				var thinking *management.ThinkingSupport
				if m.Thinking != nil && len(m.Thinking.Levels) > 0 {
					thinking = &management.ThinkingSupport{Levels: m.Thinking.Levels}
				}
				models = append(models, management.ModelAlias{
					Name:     mName,
					Alias:    alias,
					Image:    m.Image,
					Thinking: thinking,
				})
			}
		}
	} else {
		for _, m := range req.Models {
			m = strings.TrimSpace(m)
			if m != "" {
				models = append(models, management.ModelAlias{Name: m, Alias: m})
			}
		}
	}

	firstKey := apiKey
	firstProxy := ""
	var firstWeight *int
	if len(req.Keys) > 0 {
		if kVal := strings.TrimSpace(req.Keys[0].APIKey); kVal != "" {
			firstKey = kVal
		}
		firstProxy = strings.TrimSpace(req.Keys[0].ProxyURL)
		firstWeight = req.Keys[0].Weight
	}

	var disableCoolingPtr *bool
	if req.DisableCooling {
		t := true
		disableCoolingPtr = &t
	}

	if name != "" {
		h.saveProviderName(ctx, id, name)
	}

	if auditErr := h.recordAudit(request, "provider.update", "provider", id, "attempt", map[string]any{"name": name}); auditErr != nil {
		writeError(writer, http.StatusInternalServerError, "audit failure; provider update aborted")
		return
	}

	switch family {
	case openAICompatibilityFamily:
		if err := gatedProviderListWrite(h, ctx,
			func(ctx context.Context) ([]management.OpenAICompatibility, error) {
				resp, err := client.OpenAICompatibility(ctx)
				if err != nil {
					return nil, err
				}
				return resp.Entries, nil
			},
			func(ctx context.Context, list []management.OpenAICompatibility) error {
				return client.UpdateOpenAICompatibility(ctx, list)
			},
			func(list *[]management.OpenAICompatibility) error {
				if index >= len(*list) {
					return newProviderWriteError(http.StatusNotFound, "provider index out of bounds")
				}
				entry := &(*list)[index]
				if name != "" {
					entry.Name = name
				}
				entry.BaseURL = baseURL
				entry.Prefix = strings.TrimSpace(req.Prefix)
				entry.Priority = req.Priority
				entry.DisableCooling = req.DisableCooling
				entry.Disabled = req.Disabled
				entry.Models = models
				entry.Headers = req.Headers

				if len(req.Keys) > 0 {
					updatedKeys := make([]management.APIKeyEntry, 0, len(req.Keys))
					for ki, k := range req.Keys {
						kVal := strings.TrimSpace(k.APIKey)
						if kVal == "" {
							if ki < len(entry.APIKeyEntries) {
								kVal = entry.APIKeyEntries[ki].APIKey
							} else if ki < len(entry.LegacyAPIKeys) {
								kVal = entry.LegacyAPIKeys[ki]
							}
						}
						if kVal != "" {
							updatedKeys = append(updatedKeys, management.APIKeyEntry{
								APIKey:   kVal,
								ProxyURL: strings.TrimSpace(k.ProxyURL),
								Weight:   k.Weight,
							})
						}
					}
					entry.APIKeyEntries = updatedKeys
					entry.LegacyAPIKeys = nil
				} else if apiKey != "" {
					entry.APIKeyEntries = []management.APIKeyEntry{{APIKey: apiKey}}
					entry.LegacyAPIKeys = nil
				}
				return nil
			}); err != nil {
			_ = h.recordAudit(request, "provider.update", "provider", id, "failure", map[string]any{"error": err.Error()})
			writeProviderWriteError(writer, err)
			return
		}
		h.applyProviderWebsite(ctx, id, website, websiteProvided)
	default:
		spec, isConfigFamily := lookupProviderConfigFamily(family)
		if !isConfigFamily {
			writeError(writer, http.StatusBadRequest, "unsupported provider family")
			return
		}
		if err := h.mutateConfigKeyProvider(ctx, client, spec, index, func(entry *management.ConfigAPIKey) {
			entry.BaseURL = baseURL
			if firstKey != "" {
				entry.APIKey = firstKey
			}
			entry.ProxyURL = firstProxy
			entry.Prefix = strings.TrimSpace(req.Prefix)
			entry.Priority = req.Priority
			entry.Weight = firstWeight
			entry.Models = models
			entry.Headers = req.Headers
			entry.DisableCooling = disableCoolingPtr
		}); err != nil {
			_ = h.recordAudit(request, "provider.update", "provider", id, "failure", map[string]any{"error": err.Error()})
			writeProviderWriteError(writer, err)
			return
		}
		h.applyProviderWebsite(ctx, id, website, websiteProvided)
	}

	_ = h.recordAudit(request, "provider.update", "provider", id, "success", map[string]any{"name": name})

	if h.pricing != nil {
		h.pricing.NotifyModelsChanged()
	}

	writeJSON(writer, http.StatusOK, map[string]any{
		"status": "ok",
		"id":     id,
	})
}

func (h *Handler) deleteManagementProvider(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	id := chi.URLParam(request, "id")
	family, index, err := parseProviderID(id)
	if err != nil || index < 0 {
		writeError(writer, http.StatusBadRequest, "invalid provider id")
		return
	}

	client, ok := h.managementClientOrError(writer, request)
	if !ok {
		return
	}

	ctx := request.Context()
	if auditErr := h.recordAudit(request, "provider.delete", "provider", id, "attempt", nil); auditErr != nil {
		writeError(writer, http.StatusInternalServerError, "audit failure; provider deletion aborted")
		return
	}

	switch family {
	case openAICompatibilityFamily:
		if err := gatedProviderListWrite(h, ctx,
			func(ctx context.Context) ([]management.OpenAICompatibility, error) {
				resp, err := client.OpenAICompatibility(ctx)
				if err != nil {
					return nil, err
				}
				return resp.Entries, nil
			},
			func(ctx context.Context, list []management.OpenAICompatibility) error {
				return client.UpdateOpenAICompatibility(ctx, list)
			},
			func(list *[]management.OpenAICompatibility) error {
				if index >= len(*list) {
					return newProviderWriteError(http.StatusNotFound, "provider index out of bounds")
				}
				*list = append(append([]management.OpenAICompatibility{}, (*list)[:index]...), (*list)[index+1:]...)
				return nil
			}); err != nil {
			_ = h.recordAudit(request, "provider.delete", "provider", id, "failure", map[string]any{"error": err.Error()})
			writeProviderWriteError(writer, err)
			return
		}
	default:
		spec, isConfigFamily := lookupProviderConfigFamily(family)
		if !isConfigFamily {
			writeError(writer, http.StatusBadRequest, "unsupported provider family")
			return
		}
		if err := h.deleteConfigKeyProvider(ctx, client, spec, index); err != nil {
			_ = h.recordAudit(request, "provider.delete", "provider", id, "failure", map[string]any{"error": err.Error()})
			writeProviderWriteError(writer, err)
			return
		}
	}

	// The deleted row's own metadata is dropped, and every later row's metadata
	// moves down with it: the overlay is keyed by the same positional id the row
	// is addressed by, so leaving the keys alone would relabel the credentials
	// that took the freed index.
	h.removeProviderName(ctx, id)
	h.removeProviderWebsite(ctx, id)
	h.shiftProviderMetadataAfterDelete(ctx, idPrefixForFamily(family), index)
	_ = h.recordAudit(request, "provider.delete", "provider", id, "success", nil)

	if h.pricing != nil {
		h.pricing.NotifyModelsChanged()
	}

	writeJSON(writer, http.StatusOK, map[string]any{
		"status":  "ok",
		"deleted": id,
	})
}

type pullModelsRequest struct {
	ProviderID string            `json:"provider_id,omitempty"`
	Family     string            `json:"family,omitempty"`
	BaseURL    string            `json:"base_url,omitempty"`
	APIKey     string            `json:"api_key,omitempty"`
	ProxyURL   string            `json:"proxy_url,omitempty"`
	Headers    map[string]string `json:"headers,omitempty"`
}

// mergePullDefaults fills empty pull parameters from a stored provider entry,
// letting values the user typed in the form win over stored ones.
func mergePullDefaults(entryBaseURL, entryAPIKey, entryProxyURL string, entryHeaders map[string]string, baseURL, apiKey, proxyURL string, headers map[string]string) (string, string, string, map[string]string) {
	if baseURL == "" {
		baseURL = entryBaseURL
	}
	if apiKey == "" {
		apiKey = entryAPIKey
	}
	if proxyURL == "" {
		proxyURL = entryProxyURL
	}
	if len(headers) == 0 && len(entryHeaders) > 0 {
		headers = entryHeaders
	}
	return baseURL, apiKey, proxyURL, headers
}

// pullProtocol maps a provider family to the auth dialect of its upstream so
// model-list requests are authenticated the same way CPA itself would be.
func pullProtocol(family string) string {
	switch family {
	case "claude":
		return "anthropic"
	case "gemini":
		return "gemini"
	default:
		return "openai"
	}
}

func (h *Handler) pullProviderModels(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	var req pullModelsRequest
	if err := decodeManagementJSON(writer, request, 32*1024, &req); err != nil {
		return
	}

	baseURL := strings.TrimSpace(req.BaseURL)
	apiKey := strings.TrimSpace(req.APIKey)
	proxyURL := strings.TrimSpace(req.ProxyURL)
	headers := req.Headers
	family := strings.ToLower(strings.TrimSpace(req.Family))

	if req.ProviderID != "" && (baseURL == "" || apiKey == "") {
		client, ok := h.managementClientOrError(writer, request)
		if ok {
			storedFamily, index, err := parseProviderID(req.ProviderID)
			if err == nil && index >= 0 {
				ctx := request.Context()
				switch {
				case storedFamily == openAICompatibilityFamily:
					resp, err := client.OpenAICompatibility(ctx)
					if err == nil && index < len(resp.Entries) {
						entry := resp.Entries[index]
						if baseURL == "" {
							baseURL = entry.BaseURL
						}
						if apiKey == "" && len(entry.APIKeyEntries) > 0 {
							apiKey = entry.APIKeyEntries[0].APIKey
							if proxyURL == "" {
								proxyURL = entry.APIKeyEntries[0].ProxyURL
							}
						}
						if len(headers) == 0 && len(entry.Headers) > 0 {
							headers = entry.Headers
						}
					}
				default:
					if spec, isConfigFamily := lookupProviderConfigFamily(storedFamily); isConfigFamily {
						entries, err := client.ConfigAPIKeys(ctx, spec.Family)
						if err == nil && index < len(entries) {
							entry := entries[index]
							baseURL, apiKey, proxyURL, headers = mergePullDefaults(entry.BaseURL, entry.APIKey, entry.ProxyURL, entry.Headers, baseURL, apiKey, proxyURL, headers)
						}
					}
				}
				family = storedFamily
			}
		}
	}

	if baseURL == "" {
		writeError(writer, http.StatusBadRequest, "base_url is required")
		return
	}

	models, err := fetchEndpointModels(request.Context(), baseURL, apiKey, proxyURL, pullProtocol(family), headers)
	if err != nil {
		writeError(writer, http.StatusBadGateway, fmt.Sprintf("failed to pull models: %v", err))
		return
	}

	writeJSON(writer, http.StatusOK, map[string]any{
		"models": models,
		"total":  len(models),
	})
}

func fetchEndpointModels(ctx context.Context, rawBaseURL, apiKey, proxyStr, protocol string, customHeaders map[string]string) ([]string, error) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()

	parsed, err := url.Parse(rawBaseURL)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") {
		return nil, fmt.Errorf("invalid base URL scheme: %s", rawBaseURL)
	}

	transport := &http.Transport{
		Proxy: http.ProxyFromEnvironment,
	}
	if proxyStr != "" {
		if pURL, err := url.Parse(proxyStr); err == nil {
			transport.Proxy = http.ProxyURL(pURL)
		}
	}
	client := &http.Client{
		Timeout:   15 * time.Second,
		Transport: transport,
	}

	trimmed := strings.TrimRight(rawBaseURL, "/")
	buildRequest := func(target string) (*http.Request, error) {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
		if err != nil {
			return nil, err
		}
		setModelPullAuthHeaders(req, apiKey, protocol)
		for k, v := range customHeaders {
			req.Header.Set(k, v)
		}
		return req, nil
	}

	req, err := buildRequest(trimmed + "/models")
	if err != nil {
		return nil, err
	}

	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusNotFound && !strings.HasSuffix(trimmed, "/v1") {
		retryURL := trimmed + "/v1/models"
		req2, err := buildRequest(retryURL)
		if err == nil {
			if resp2, err2 := client.Do(req2); err2 == nil {
				defer resp2.Body.Close()
				if resp2.StatusCode == http.StatusOK {
					return parseModelsResponse(resp2.Body)
				}
			}
		}
	}

	if resp.StatusCode != http.StatusOK {
		bodySnippet, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return nil, fmt.Errorf("HTTP %d: %s", resp.StatusCode, strings.TrimSpace(string(bodySnippet)))
	}

	return parseModelsResponse(resp.Body)
}

// setModelPullAuthHeaders authenticates a model-list request the way each
// protocol's upstream expects. Relays commonly gate /models behind
// Authorization, while the official Anthropic API requires x-api-key, so the
// anthropic dialect sends both; custom headers can still override any of them.
func setModelPullAuthHeaders(req *http.Request, apiKey, protocol string) {
	if apiKey == "" {
		return
	}
	switch protocol {
	case "anthropic":
		req.Header.Set("Authorization", "Bearer "+apiKey)
		req.Header.Set("x-api-key", apiKey)
		req.Header.Set("anthropic-version", "2023-06-01")
	case "gemini":
		req.Header.Set("x-goog-api-key", apiKey)
	default:
		req.Header.Set("Authorization", "Bearer "+apiKey)
	}
}

func parseModelsResponse(r io.Reader) ([]string, error) {
	data, err := io.ReadAll(io.LimitReader(r, 2*1024*1024))
	if err != nil {
		return nil, err
	}

	var oaiResp struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	if err := json.Unmarshal(data, &oaiResp); err == nil && len(oaiResp.Data) > 0 {
		models := make([]string, 0, len(oaiResp.Data))
		seen := make(map[string]bool)
		for _, m := range oaiResp.Data {
			id := strings.TrimSpace(m.ID)
			if id != "" && !seen[id] {
				seen[id] = true
				models = append(models, id)
			}
		}
		return models, nil
	}

	var objResp struct {
		Models []json.RawMessage `json:"models"`
	}
	if err := json.Unmarshal(data, &objResp); err == nil && len(objResp.Models) > 0 {
		models := make([]string, 0, len(objResp.Models))
		seen := make(map[string]bool)
		for _, raw := range objResp.Models {
			var str string
			if json.Unmarshal(raw, &str) == nil && str != "" {
				if !seen[str] {
					seen[str] = true
					models = append(models, str)
				}
				continue
			}
			var item struct {
				ID   string `json:"id"`
				Name string `json:"name"`
			}
			if json.Unmarshal(raw, &item) == nil {
				val := firstNonEmpty(item.ID, item.Name)
				if val != "" && !seen[val] {
					seen[val] = true
					models = append(models, val)
				}
			}
		}
		if len(models) > 0 {
			return models, nil
		}
	}

	var arrResp []struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	}
	if err := json.Unmarshal(data, &arrResp); err == nil && len(arrResp) > 0 {
		models := make([]string, 0, len(arrResp))
		seen := make(map[string]bool)
		for _, item := range arrResp {
			val := firstNonEmpty(item.ID, item.Name)
			if val != "" && !seen[val] {
				seen[val] = true
				models = append(models, val)
			}
		}
		return models, nil
	}

	return []string{}, nil
}
