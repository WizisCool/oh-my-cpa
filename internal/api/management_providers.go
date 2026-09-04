package api

import (
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/management"
	"github.com/oh-my-cpa/oh-my-cpa/internal/security"
)

type ClientAPIKeyItemDTO struct {
	Index       int    `json:"index"`
	Masked      string `json:"masked"`
	Fingerprint string `json:"fingerprint"`
	Length      int    `json:"length"`
}

type ProviderItemDTO struct {
	ID              string   `json:"id"`
	Family          string   `json:"family"`
	Name            string   `json:"name"`
	Protocol        string   `json:"protocol"`
	BaseURL         string   `json:"base_url,omitempty"`
	AuthIndex       string   `json:"auth_index,omitempty"`
	Models          []string `json:"models,omitempty"`
	Disabled        bool     `json:"disabled"`
	KeyConfigured   bool     `json:"key_configured"`
	KeyMasked       string   `json:"key_masked,omitempty"`
	ProxyConfigured bool     `json:"proxy_configured"`
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

func (h *Handler) listManagementProviders(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	client, ok := h.managementClientOrError(writer, request)
	if !ok {
		return
	}

	ctx := request.Context()
	items := make([]ProviderItemDTO, 0)

	// 1. Codex API Keys
	if codexResp, err := client.CodexAPIKeys(ctx); err == nil {
		for i, entry := range codexResp.Entries {
			models := make([]string, 0, len(entry.Models))
			for _, m := range entry.Models {
				if m.Name != "" {
					models = append(models, m.Name)
				}
			}
			items = append(items, ProviderItemDTO{
				ID:              fmt.Sprintf("codex-%d", i),
				Family:          "codex",
				Name:            firstNonEmpty(entry.Prefix, "Codex / Responses"),
				Protocol:        "OpenAI Responses",
				BaseURL:         security.PublicURL(entry.BaseURL),
				AuthIndex:       entry.AuthIndex,
				Models:          models,
				Disabled:        false,
				KeyConfigured:   strings.TrimSpace(entry.APIKey) != "",
				KeyMasked:       maskSecretKey(entry.APIKey),
				ProxyConfigured: strings.TrimSpace(entry.ProxyURL) != "",
			})
		}
	}

	// 2. OpenAI Compatibility
	if oaiResp, err := client.OpenAICompatibility(ctx); err == nil {
		for i, entry := range oaiResp.Entries {
			models := make([]string, 0, len(entry.Models))
			for _, m := range entry.Models {
				if m.Name != "" {
					models = append(models, m.Name)
				}
			}
			hasKey := len(entry.LegacyAPIKeys) > 0 || len(entry.APIKeyEntries) > 0
			var firstKey string
			if len(entry.LegacyAPIKeys) > 0 {
				firstKey = entry.LegacyAPIKeys[0]
			} else if len(entry.APIKeyEntries) > 0 {
				firstKey = entry.APIKeyEntries[0].APIKey
			}
			items = append(items, ProviderItemDTO{
				ID:              fmt.Sprintf("openai-compat-%d", i),
				Family:          "openai-compatibility",
				Name:            firstNonEmpty(entry.Name, "OpenAI Compatible"),
				Protocol:        "OpenAI Chat Completions",
				BaseURL:         security.PublicURL(entry.BaseURL),
				Models:          models,
				Disabled:        entry.Disabled,
				KeyConfigured:   hasKey,
				KeyMasked:       maskSecretKey(firstKey),
				ProxyConfigured: false,
			})
		}
	}

	// 3. Claude API Keys
	if claudeEntries, err := client.ClaudeAPIKeys(ctx); err == nil {
		for i, entry := range claudeEntries {
			items = append(items, ProviderItemDTO{
				ID:              fmt.Sprintf("claude-%d", i),
				Family:          "claude",
				Name:            "Anthropic Claude",
				Protocol:        "Anthropic Messages",
				BaseURL:         security.PublicURL(entry.BaseURL),
				AuthIndex:       entry.AuthIndex,
				Disabled:        false,
				KeyConfigured:   strings.TrimSpace(entry.APIKey) != "",
				KeyMasked:       maskSecretKey(entry.APIKey),
				ProxyConfigured: strings.TrimSpace(entry.ProxyURL) != "",
			})
		}
	}

	// 4. Gemini API Keys
	if geminiEntries, err := client.GeminiAPIKeys(ctx); err == nil {
		for i, entry := range geminiEntries {
			items = append(items, ProviderItemDTO{
				ID:              fmt.Sprintf("gemini-%d", i),
				Family:          "gemini",
				Name:            "Google Gemini",
				Protocol:        "Gemini Generate Content",
				BaseURL:         security.PublicURL(entry.BaseURL),
				AuthIndex:       entry.AuthIndex,
				Disabled:        false,
				KeyConfigured:   strings.TrimSpace(entry.APIKey) != "",
				KeyMasked:       maskSecretKey(entry.APIKey),
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
	targetID := fmt.Sprintf("%s:%d", req.Family, req.Index)

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

type SaveProviderRequest struct {
	Family   string   `json:"family"`
	Name     string   `json:"name"`
	BaseURL  string   `json:"base_url"`
	APIKey   string   `json:"api_key"`
	Models   []string `json:"models"`
	Disabled bool     `json:"disabled"`
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
	models := make([]management.ModelAlias, 0, len(req.Models))
	for _, m := range req.Models {
		m = strings.TrimSpace(m)
		if m != "" {
			models = append(models, management.ModelAlias{Name: m, Alias: m})
		}
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
			Name:     name,
			BaseURL:  baseURL,
			Disabled: req.Disabled,
			Models:   models,
		}
		if apiKey != "" {
			newEntry.APIKeyEntries = []management.APIKeyEntry{{APIKey: apiKey}}
		}
		resp.Entries = append(resp.Entries, newEntry)
		if err := client.UpdateOpenAICompatibility(ctx, resp.Entries); err != nil {
			_ = h.recordAudit(request, "provider.create", "provider", family, "failure", map[string]any{"error": err.Error()})
			writeCPAFacadeError(writer, err)
			return
		}
	case "codex":
		resp, err := client.CodexAPIKeys(ctx)
		if err != nil {
			writeCPAFacadeError(writer, err)
			return
		}
		newEntry := management.CodexAPIKey{
			APIKey:  apiKey,
			BaseURL: baseURL,
			Models:  models,
		}
		resp.Entries = append(resp.Entries, newEntry)
		if err := client.UpdateCodexAPIKeys(ctx, resp.Entries); err != nil {
			_ = h.recordAudit(request, "provider.create", "provider", family, "failure", map[string]any{"error": err.Error()})
			writeCPAFacadeError(writer, err)
			return
		}
	case "claude":
		entries, err := client.ClaudeAPIKeys(ctx)
		if err != nil {
			writeCPAFacadeError(writer, err)
			return
		}
		entries = append(entries, management.SimpleKeyEntry{
			APIKey:  apiKey,
			BaseURL: baseURL,
		})
		if err := client.UpdateClaudeAPIKeys(ctx, entries); err != nil {
			_ = h.recordAudit(request, "provider.create", "provider", family, "failure", map[string]any{"error": err.Error()})
			writeCPAFacadeError(writer, err)
			return
		}
	case "gemini":
		entries, err := client.GeminiAPIKeys(ctx)
		if err != nil {
			writeCPAFacadeError(writer, err)
			return
		}
		entries = append(entries, management.SimpleKeyEntry{
			APIKey:  apiKey,
			BaseURL: baseURL,
		})
		if err := client.UpdateGeminiAPIKeys(ctx, entries); err != nil {
			_ = h.recordAudit(request, "provider.create", "provider", family, "failure", map[string]any{"error": err.Error()})
			writeCPAFacadeError(writer, err)
			return
		}
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

	models := make([]management.ModelAlias, 0, len(req.Models))
	for _, m := range req.Models {
		m = strings.TrimSpace(m)
		if m != "" {
			models = append(models, management.ModelAlias{Name: m, Alias: m})
		}
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
		entry.Disabled = req.Disabled
		entry.Models = models
		if apiKey != "" {
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
		entry.Models = models
		if apiKey != "" {
			entry.APIKey = apiKey
		}
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
		if apiKey != "" {
			entry.APIKey = apiKey
		}
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
		if apiKey != "" {
			entry.APIKey = apiKey
		}
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
		updated := make([]management.SimpleKeyEntry, 0, len(entries)-1)
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
		updated := make([]management.SimpleKeyEntry, 0, len(entries)-1)
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

	_ = h.recordAudit(request, "provider.delete", "provider", id, "success", nil)

	writeJSON(writer, http.StatusOK, map[string]any{
		"status": "ok",
		"id":     id,
	})
}
