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
	Index       int    `json:"index"`
	Masked      string `json:"masked"`
	Fingerprint string `json:"fingerprint"`
	Length      int    `json:"length"`
}

type ProviderKeyEntryDTO struct {
	Index    int    `json:"index"`
	Masked   string `json:"masked"`
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
	ID              string                `json:"id"`
	Family          string                `json:"family"`
	Name            string                `json:"name"`
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
	KeyMasked       string                `json:"key_masked,omitempty"`
	KeyEntries      []ProviderKeyEntryDTO `json:"key_entries,omitempty"`
	Headers         map[string]string     `json:"headers,omitempty"`
	ProxyConfigured bool                  `json:"proxy_configured"`
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

	items := make([]ClientAPIKeyItemDTO, 0, len(keys))
	for i, key := range keys {
		trimmed := strings.TrimSpace(key)
		fp := security.FingerprintOrRedacted(h.cipher, "client-key", trimmed)
		items = append(items, ClientAPIKeyItemDTO{
			Index:       i,
			Masked:      maskSecretKey(trimmed),
			Fingerprint: fp,
			Length:      len(trimmed),
		})
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
		"masked": maskSecretKey(newKey),
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
	encoded, err := json.Marshal(names)
	if err == nil {
		_ = h.repo.PutPreference(ctx, repository.PreferenceProviderNames, string(encoded))
	}
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
	encoded, err := json.Marshal(names)
	if err == nil {
		_ = h.repo.PutPreference(ctx, repository.PreferenceProviderNames, string(encoded))
	}
}

func (h *Handler) loadDisabledProviders(ctx context.Context) map[string]bool {
	if h.repo == nil {
		return nil
	}
	raw, found, err := h.repo.GetPreference(ctx, repository.PreferenceDisabledProviders)
	if err != nil || !found || raw == "" {
		return nil
	}
	var res map[string]bool
	if err := json.Unmarshal([]byte(raw), &res); err != nil {
		return nil
	}
	return res
}

func (h *Handler) toggleDisabledProvider(ctx context.Context, id string, disabled bool) {
	if h.repo == nil || id == "" {
		return
	}
	m := h.loadDisabledProviders(ctx)
	if m == nil {
		m = make(map[string]bool)
	}
	if disabled {
		m[id] = true
	} else {
		delete(m, id)
	}
	encoded, err := json.Marshal(m)
	if err == nil {
		_ = h.repo.PutPreference(ctx, repository.PreferenceDisabledProviders, string(encoded))
	}
}


func (h *Handler) listManagementProviders(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	client, ok := h.managementClientOrError(writer, request)
	if !ok {
		return
	}

	ctx := request.Context()
	items := make([]ProviderItemDTO, 0)
	customNames := h.loadProviderNames(ctx)
	disabledMap := h.loadDisabledProviders(ctx)

	// 1. Codex API Keys
	if codexResp, err := client.CodexAPIKeys(ctx); err == nil {
		for i, entry := range codexResp.Entries {
			id := fmt.Sprintf("codex-%d", i)
			name := "Codex / Responses"
			if customNames != nil && customNames[id] != "" {
				name = customNames[id]
			} else if entry.Prefix != "" {
				name = fmt.Sprintf("Codex (%s)", entry.Prefix)
			}

			models := make([]string, 0, len(entry.Models))
			modelEntries := make([]ProviderModelDTO, 0, len(entry.Models))
			for _, m := range entry.Models {
				if m.Name != "" {
					models = append(models, m.Name)
				}
				var th *ThinkingDTO
				if m.Thinking != nil && len(m.Thinking.Levels) > 0 {
					th = &ThinkingDTO{Levels: m.Thinking.Levels}
				}
				modelEntries = append(modelEntries, ProviderModelDTO{
					Name:     m.Name,
					Alias:    m.Alias,
					Image:    m.Image,
					Thinking: th,
				})
			}

			keyEntries := make([]ProviderKeyEntryDTO, 0)
			if strings.TrimSpace(entry.APIKey) != "" {
				keyEntries = append(keyEntries, ProviderKeyEntryDTO{
					Index:    0,
					Masked:   maskSecretKey(entry.APIKey),
					ProxyURL: entry.ProxyURL,
					Weight:   entry.Weight,
				})
			}

			var disableCoolingVal bool
			if entry.DisableCooling != nil {
				disableCoolingVal = *entry.DisableCooling
			}

			isDisabled := false
			if disabledMap != nil && disabledMap[id] {
				isDisabled = true
			}

			items = append(items, ProviderItemDTO{
				ID:              id,
				Family:          "codex",
				Name:            name,
				Protocol:        "OpenAI Responses",
				BaseURL:         security.PublicURL(entry.BaseURL),
				Prefix:          entry.Prefix,
				Priority:        entry.Priority,
				DisableCooling:  disableCoolingVal,
				AuthIndex:       entry.AuthIndex,
				Models:          models,
				ModelEntries:    modelEntries,
				Disabled:        isDisabled,
				KeyConfigured:   strings.TrimSpace(entry.APIKey) != "",
				KeyMasked:       maskSecretKey(entry.APIKey),
				KeyEntries:      keyEntries,
				Headers:         entry.Headers,
				ProxyConfigured: strings.TrimSpace(entry.ProxyURL) != "",
			})
		}
	}

	// 2. OpenAI Compatibility
	if oaiResp, err := client.OpenAICompatibility(ctx); err == nil {
		for i, entry := range oaiResp.Entries {
			id := fmt.Sprintf("openai-compat-%d", i)
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
				var th *ThinkingDTO
				if m.Thinking != nil && len(m.Thinking.Levels) > 0 {
					th = &ThinkingDTO{Levels: m.Thinking.Levels}
				}
				modelEntries = append(modelEntries, ProviderModelDTO{
					Name:     m.Name,
					Alias:    m.Alias,
					Image:    m.Image,
					Thinking: th,
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
					Masked:   maskSecretKey(k.APIKey),
					ProxyURL: k.ProxyURL,
					Weight:   k.Weight,
				})
			}
			for ki, k := range entry.LegacyAPIKeys {
				keyEntries = append(keyEntries, ProviderKeyEntryDTO{
					Index:  len(entry.APIKeyEntries) + ki,
					Masked: maskSecretKey(k),
				})
			}

			items = append(items, ProviderItemDTO{
				ID:              id,
				Family:          "openai-compatibility",
				Name:            name,
				Protocol:        "OpenAI Chat Completions",
				BaseURL:         security.PublicURL(entry.BaseURL),
				Prefix:          entry.Prefix,
				Priority:        entry.Priority,
				DisableCooling:  entry.DisableCooling,
				Models:          models,
				ModelEntries:    modelEntries,
				Disabled:        entry.Disabled,
				KeyConfigured:   hasKey,
				KeyMasked:       maskSecretKey(firstKey),
				KeyEntries:      keyEntries,
				Headers:         entry.Headers,
				ProxyConfigured: false,
			})
		}
	}

	// 3. Claude API Keys
	if claudeEntries, err := client.ClaudeAPIKeys(ctx); err == nil {
		for i, entry := range claudeEntries {
			id := fmt.Sprintf("claude-%d", i)
			name := "Anthropic Claude"
			if customNames != nil && customNames[id] != "" {
				name = customNames[id]
			} else if entry.Prefix != "" {
				name = fmt.Sprintf("Claude (%s)", entry.Prefix)
			}

			models := make([]string, 0, len(entry.Models))
			modelEntries := make([]ProviderModelDTO, 0, len(entry.Models))
			for _, m := range entry.Models {
				if m.Name != "" {
					models = append(models, m.Name)
				}
				var th *ThinkingDTO
				if m.Thinking != nil && len(m.Thinking.Levels) > 0 {
					th = &ThinkingDTO{Levels: m.Thinking.Levels}
				}
				modelEntries = append(modelEntries, ProviderModelDTO{
					Name:     m.Name,
					Alias:    m.Alias,
					Image:    m.Image,
					Thinking: th,
				})
			}

			keyEntries := make([]ProviderKeyEntryDTO, 0)
			if strings.TrimSpace(entry.APIKey) != "" {
				keyEntries = append(keyEntries, ProviderKeyEntryDTO{
					Index:    0,
					Masked:   maskSecretKey(entry.APIKey),
					ProxyURL: entry.ProxyURL,
					Weight:   entry.Weight,
				})
			}

			var disableCoolingVal bool
			if entry.DisableCooling != nil {
				disableCoolingVal = *entry.DisableCooling
			}

			isDisabled := false
			if disabledMap != nil && disabledMap[id] {
				isDisabled = true
			}

			items = append(items, ProviderItemDTO{
				ID:              id,
				Family:          "claude",
				Name:            name,
				Protocol:        "Anthropic Messages",
				BaseURL:         security.PublicURL(entry.BaseURL),
				Prefix:          entry.Prefix,
				Priority:        entry.Priority,
				DisableCooling:  disableCoolingVal,
				AuthIndex:       entry.AuthIndex,
				Models:          models,
				ModelEntries:    modelEntries,
				Disabled:        isDisabled,
				KeyConfigured:   strings.TrimSpace(entry.APIKey) != "",
				KeyMasked:       maskSecretKey(entry.APIKey),
				KeyEntries:      keyEntries,
				Headers:         entry.Headers,
				ProxyConfigured: strings.TrimSpace(entry.ProxyURL) != "",
			})
		}
	}

	// 4. Gemini API Keys
	if geminiEntries, err := client.GeminiAPIKeys(ctx); err == nil {
		for i, entry := range geminiEntries {
			id := fmt.Sprintf("gemini-%d", i)
			name := "Google Gemini"
			if customNames != nil && customNames[id] != "" {
				name = customNames[id]
			} else if entry.Prefix != "" {
				name = fmt.Sprintf("Gemini (%s)", entry.Prefix)
			}

			models := make([]string, 0, len(entry.Models))
			modelEntries := make([]ProviderModelDTO, 0, len(entry.Models))
			for _, m := range entry.Models {
				if m.Name != "" {
					models = append(models, m.Name)
				}
				var th *ThinkingDTO
				if m.Thinking != nil && len(m.Thinking.Levels) > 0 {
					th = &ThinkingDTO{Levels: m.Thinking.Levels}
				}
				modelEntries = append(modelEntries, ProviderModelDTO{
					Name:     m.Name,
					Alias:    m.Alias,
					Image:    m.Image,
					Thinking: th,
				})
			}

			keyEntries := make([]ProviderKeyEntryDTO, 0)
			if strings.TrimSpace(entry.APIKey) != "" {
				keyEntries = append(keyEntries, ProviderKeyEntryDTO{
					Index:    0,
					Masked:   maskSecretKey(entry.APIKey),
					ProxyURL: entry.ProxyURL,
					Weight:   entry.Weight,
				})
			}

			var disableCoolingVal bool
			if entry.DisableCooling != nil {
				disableCoolingVal = *entry.DisableCooling
			}

			isDisabled := false
			if disabledMap != nil && disabledMap[id] {
				isDisabled = true
			}

			items = append(items, ProviderItemDTO{
				ID:              id,
				Family:          "gemini",
				Name:            name,
				Protocol:        "Gemini Generate Content",
				BaseURL:         security.PublicURL(entry.BaseURL),
				Prefix:          entry.Prefix,
				Priority:        entry.Priority,
				DisableCooling:  disableCoolingVal,
				AuthIndex:       entry.AuthIndex,
				Models:          models,
				ModelEntries:    modelEntries,
				Disabled:        isDisabled,
				KeyConfigured:   strings.TrimSpace(entry.APIKey) != "",
				KeyMasked:       maskSecretKey(entry.APIKey),
				KeyEntries:      keyEntries,
				Headers:         entry.Headers,
				ProxyConfigured: strings.TrimSpace(entry.ProxyURL) != "",
			})
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
}

func (h *Handler) patchManagementProviderStatus(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	var req patchProviderStatusRequest
	if err := decodeManagementJSON(writer, request, 8*1024, &req); err != nil {
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

	switch req.Family {
	case "openai-compatibility":
		resp, err := client.OpenAICompatibility(ctx)
		if err != nil {
			writeCPAFacadeError(writer, err)
			return
		}
		if req.Index >= len(resp.Entries) {
			writeError(writer, http.StatusNotFound, "provider index out of bounds")
			return
		}
		resp.Entries[req.Index].Disabled = req.Disabled
		if err := client.UpdateOpenAICompatibility(ctx, resp.Entries); err != nil {
			_ = h.recordAudit(request, "provider.toggle_status", "provider", targetID, "failure", map[string]any{"error": err.Error()})
			writeCPAFacadeError(writer, err)
			return
		}
	case "claude", "codex", "gemini":
		h.toggleDisabledProvider(ctx, targetID, req.Disabled)
	default:
		writeError(writer, http.StatusBadRequest, "provider family does not support status toggle")
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

func maskSecretKey(key string) string {
	key = strings.TrimSpace(key)
	if key == "" {
		return ""
	}
	if len(key) <= 8 {
		return "••••••••"
	}
	prefixLen := 4
	if len(key) < 12 {
		prefixLen = 2
	}
	return key[:prefixLen] + "••••••••" + key[len(key)-4:]
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
}

func parseProviderID(id string) (string, int, error) {
	id = strings.TrimSpace(id)
	switch {
	case strings.HasPrefix(id, "openai-compat-"):
		idxStr := strings.TrimPrefix(id, "openai-compat-")
		idx, err := strconv.Atoi(idxStr)
		return "openai-compatibility", idx, err
	case strings.HasPrefix(id, "codex-"):
		idxStr := strings.TrimPrefix(id, "codex-")
		idx, err := strconv.Atoi(idxStr)
		return "codex", idx, err
	case strings.HasPrefix(id, "claude-"):
		idxStr := strings.TrimPrefix(id, "claude-")
		idx, err := strconv.Atoi(idxStr)
		return "claude", idx, err
	case strings.HasPrefix(id, "gemini-"):
		idxStr := strings.TrimPrefix(id, "gemini-")
		idx, err := strconv.Atoi(idxStr)
		return "gemini", idx, err
	default:
		return "", 0, fmt.Errorf("unknown provider id format: %s", id)
	}
}

func (h *Handler) createManagementProvider(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	var req SaveProviderRequest
	if err := decodeManagementJSON(writer, request, 32*1024, &req); err != nil {
		return
	}

	family := strings.ToLower(strings.TrimSpace(req.Family))
	if family == "" {
		family = "openai-compatibility"
	}
	name := strings.TrimSpace(req.Name)
	if name == "" {
		name = "Custom Provider"
	}
	baseURL := strings.TrimSpace(req.BaseURL)
	apiKey := strings.TrimSpace(req.APIKey)

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
				var th *management.ThinkingSupport
				if m.Thinking != nil && len(m.Thinking.Levels) > 0 {
					th = &management.ThinkingSupport{Levels: m.Thinking.Levels}
				}
				models = append(models, management.ModelAlias{
					Name:     mName,
					Alias:    alias,
					Image:    m.Image,
					Thinking: th,
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
	case "openai-compatibility":
		resp, err := client.OpenAICompatibility(ctx)
		if err != nil {
			writeCPAFacadeError(writer, err)
			return
		}
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
		resp.Entries = append(resp.Entries, newEntry)
		if err := client.UpdateOpenAICompatibility(ctx, resp.Entries); err != nil {
			_ = h.recordAudit(request, "provider.create", "provider", family, "failure", map[string]any{"error": err.Error()})
			writeCPAFacadeError(writer, err)
			return
		}
		targetID := fmt.Sprintf("openai-compat-%d", len(resp.Entries)-1)
		h.saveProviderName(ctx, targetID, name)

	case "codex":
		resp, err := client.CodexAPIKeys(ctx)
		if err != nil {
			writeCPAFacadeError(writer, err)
			return
		}
		newEntry := management.CodexAPIKey{
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
		resp.Entries = append(resp.Entries, newEntry)
		if err := client.UpdateCodexAPIKeys(ctx, resp.Entries); err != nil {
			_ = h.recordAudit(request, "provider.create", "provider", family, "failure", map[string]any{"error": err.Error()})
			writeCPAFacadeError(writer, err)
			return
		}
		targetID := fmt.Sprintf("codex-%d", len(resp.Entries)-1)
		h.saveProviderName(ctx, targetID, name)

	case "claude":
		entries, err := client.ClaudeAPIKeys(ctx)
		if err != nil {
			writeCPAFacadeError(writer, err)
			return
		}
		newEntry := management.ClaudeAPIKey{
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
		entries = append(entries, newEntry)
		if err := client.UpdateClaudeAPIKeys(ctx, entries); err != nil {
			_ = h.recordAudit(request, "provider.create", "provider", family, "failure", map[string]any{"error": err.Error()})
			writeCPAFacadeError(writer, err)
			return
		}
		targetID := fmt.Sprintf("claude-%d", len(entries)-1)
		h.saveProviderName(ctx, targetID, name)

	case "gemini":
		entries, err := client.GeminiAPIKeys(ctx)
		if err != nil {
			writeCPAFacadeError(writer, err)
			return
		}
		newEntry := management.GeminiAPIKey{
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
		entries = append(entries, newEntry)
		if err := client.UpdateGeminiAPIKeys(ctx, entries); err != nil {
			_ = h.recordAudit(request, "provider.create", "provider", family, "failure", map[string]any{"error": err.Error()})
			writeCPAFacadeError(writer, err)
			return
		}
		targetID := fmt.Sprintf("gemini-%d", len(entries)-1)
		h.saveProviderName(ctx, targetID, name)

	default:
		writeError(writer, http.StatusBadRequest, "unsupported provider family: "+family)
		return
	}

	_ = h.recordAudit(request, "provider.create", "provider", family, "success", map[string]any{"name": name})

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

	models := make([]management.ModelAlias, 0)
	if len(req.ModelEntries) > 0 {
		for _, m := range req.ModelEntries {
			mName := strings.TrimSpace(m.Name)
			if mName != "" {
				alias := strings.TrimSpace(m.Alias)
				if alias == "" {
					alias = mName
				}
				var th *management.ThinkingSupport
				if m.Thinking != nil && len(m.Thinking.Levels) > 0 {
					th = &management.ThinkingSupport{Levels: m.Thinking.Levels}
				}
				models = append(models, management.ModelAlias{
					Name:     mName,
					Alias:    alias,
					Image:    m.Image,
					Thinking: th,
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
	case "openai-compatibility":
		resp, err := client.OpenAICompatibility(ctx)
		if err != nil {
			writeCPAFacadeError(writer, err)
			return
		}
		if index >= len(resp.Entries) {
			writeError(writer, http.StatusNotFound, "provider index out of bounds")
			return
		}
		entry := &resp.Entries[index]
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
		if err := client.UpdateOpenAICompatibility(ctx, resp.Entries); err != nil {
			_ = h.recordAudit(request, "provider.update", "provider", id, "failure", map[string]any{"error": err.Error()})
			writeCPAFacadeError(writer, err)
			return
		}
	case "codex":
		resp, err := client.CodexAPIKeys(ctx)
		if err != nil {
			writeCPAFacadeError(writer, err)
			return
		}
		if index >= len(resp.Entries) {
			writeError(writer, http.StatusNotFound, "provider index out of bounds")
			return
		}
		entry := &resp.Entries[index]
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
		if err := client.UpdateCodexAPIKeys(ctx, resp.Entries); err != nil {
			_ = h.recordAudit(request, "provider.update", "provider", id, "failure", map[string]any{"error": err.Error()})
			writeCPAFacadeError(writer, err)
			return
		}
	case "claude":
		entries, err := client.ClaudeAPIKeys(ctx)
		if err != nil {
			writeCPAFacadeError(writer, err)
			return
		}
		if index >= len(entries) {
			writeError(writer, http.StatusNotFound, "provider index out of bounds")
			return
		}
		entry := &entries[index]
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
		if err := client.UpdateClaudeAPIKeys(ctx, entries); err != nil {
			_ = h.recordAudit(request, "provider.update", "provider", id, "failure", map[string]any{"error": err.Error()})
			writeCPAFacadeError(writer, err)
			return
		}
	case "gemini":
		entries, err := client.GeminiAPIKeys(ctx)
		if err != nil {
			writeCPAFacadeError(writer, err)
			return
		}
		if index >= len(entries) {
			writeError(writer, http.StatusNotFound, "provider index out of bounds")
			return
		}
		entry := &entries[index]
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
		if err := client.UpdateGeminiAPIKeys(ctx, entries); err != nil {
			_ = h.recordAudit(request, "provider.update", "provider", id, "failure", map[string]any{"error": err.Error()})
			writeCPAFacadeError(writer, err)
			return
		}
	default:
		writeError(writer, http.StatusBadRequest, "unsupported provider family")
		return
	}

	_ = h.recordAudit(request, "provider.update", "provider", id, "success", map[string]any{"name": name})

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
	case "openai-compatibility":
		resp, err := client.OpenAICompatibility(ctx)
		if err != nil {
			writeCPAFacadeError(writer, err)
			return
		}
		if index >= len(resp.Entries) {
			writeError(writer, http.StatusNotFound, "provider index out of bounds")
			return
		}
		updated := make([]management.OpenAICompatibility, 0, len(resp.Entries)-1)
		for i, e := range resp.Entries {
			if i != index {
				updated = append(updated, e)
			}
		}
		if err := client.UpdateOpenAICompatibility(ctx, updated); err != nil {
			_ = h.recordAudit(request, "provider.delete", "provider", id, "failure", map[string]any{"error": err.Error()})
			writeCPAFacadeError(writer, err)
			return
		}
	case "codex":
		resp, err := client.CodexAPIKeys(ctx)
		if err != nil {
			writeCPAFacadeError(writer, err)
			return
		}
		if index >= len(resp.Entries) {
			writeError(writer, http.StatusNotFound, "provider index out of bounds")
			return
		}
		updated := make([]management.CodexAPIKey, 0, len(resp.Entries)-1)
		for i, e := range resp.Entries {
			if i != index {
				updated = append(updated, e)
			}
		}
		if err := client.UpdateCodexAPIKeys(ctx, updated); err != nil {
			_ = h.recordAudit(request, "provider.delete", "provider", id, "failure", map[string]any{"error": err.Error()})
			writeCPAFacadeError(writer, err)
			return
		}
	case "claude":
		entries, err := client.ClaudeAPIKeys(ctx)
		if err != nil {
			writeCPAFacadeError(writer, err)
			return
		}
		if index >= len(entries) {
			writeError(writer, http.StatusNotFound, "provider index out of bounds")
			return
		}
		updated := make([]management.ClaudeAPIKey, 0, len(entries)-1)
		for i, e := range entries {
			if i != index {
				updated = append(updated, e)
			}
		}
		if err := client.UpdateClaudeAPIKeys(ctx, updated); err != nil {
			_ = h.recordAudit(request, "provider.delete", "provider", id, "failure", map[string]any{"error": err.Error()})
			writeCPAFacadeError(writer, err)
			return
		}
	case "gemini":
		entries, err := client.GeminiAPIKeys(ctx)
		if err != nil {
			writeCPAFacadeError(writer, err)
			return
		}
		if index >= len(entries) {
			writeError(writer, http.StatusNotFound, "provider index out of bounds")
			return
		}
		updated := make([]management.GeminiAPIKey, 0, len(entries)-1)
		for i, e := range entries {
			if i != index {
				updated = append(updated, e)
			}
		}
		if err := client.UpdateGeminiAPIKeys(ctx, updated); err != nil {
			_ = h.recordAudit(request, "provider.delete", "provider", id, "failure", map[string]any{"error": err.Error()})
			writeCPAFacadeError(writer, err)
			return
		}
	default:
		writeError(writer, http.StatusBadRequest, "unsupported provider family")
		return
	}

	h.removeProviderName(ctx, id)
	_ = h.recordAudit(request, "provider.delete", "provider", id, "success", nil)

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
				switch storedFamily {
				case "openai-compatibility":
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
				case "codex":
					resp, err := client.CodexAPIKeys(ctx)
					if err == nil && index < len(resp.Entries) {
						entry := resp.Entries[index]
						baseURL, apiKey, proxyURL, headers = mergePullDefaults(entry.BaseURL, entry.APIKey, entry.ProxyURL, entry.Headers, baseURL, apiKey, proxyURL, headers)
					}
				case "claude":
					entries, err := client.ClaudeAPIKeys(ctx)
					if err == nil && index < len(entries) {
						entry := entries[index]
						baseURL, apiKey, proxyURL, headers = mergePullDefaults(entry.BaseURL, entry.APIKey, entry.ProxyURL, entry.Headers, baseURL, apiKey, proxyURL, headers)
					}
				case "gemini":
					entries, err := client.GeminiAPIKeys(ctx)
					if err == nil && index < len(entries) {
						entry := entries[index]
						baseURL, apiKey, proxyURL, headers = mergePullDefaults(entry.BaseURL, entry.APIKey, entry.ProxyURL, entry.Headers, baseURL, apiKey, proxyURL, headers)
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
