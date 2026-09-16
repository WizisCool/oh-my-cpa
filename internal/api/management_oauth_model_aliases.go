package api

import (
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/management"
)

const (
	managementOAuthModelAliasProviderLimit = 512
	managementOAuthModelAliasEntryLimit    = 512
	managementOAuthModelAliasFieldLimit    = 512
)

// managementOAuthModelAlias is the browser-safe shape for one global OAuth
// model mapping. It contains no credential material.
type managementOAuthModelAlias struct {
	Name         string `json:"name"`
	Alias        string `json:"alias"`
	Fork         bool   `json:"fork,omitempty"`
	DisplayName  string `json:"display_name,omitempty"`
	ForceMapping bool   `json:"force_mapping,omitempty"`
}

func (h *Handler) listManagementOAuthModelAliases(writer http.ResponseWriter, request *http.Request) {
	client, ok := h.managementClientOrError(writer, request)
	if !ok {
		return
	}
	aliases, err := client.OAuthModelAliases(request.Context())
	if err != nil {
		writeCPAFacadeError(writer, err)
		return
	}
	projected, err := projectManagementOAuthModelAliases(aliases)
	if err != nil {
		writeError(writer, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(writer, http.StatusOK, map[string]any{"aliases": projected})
}

func (h *Handler) patchManagementOAuthModelAliases(writer http.ResponseWriter, request *http.Request) {
	var payload struct {
		Provider string                       `json:"provider"`
		Aliases  *[]managementOAuthModelAlias `json:"aliases"`
	}
	if err := decodeManagementJSON(writer, request, managementAuthFileRequestLimit, &payload); err != nil {
		return
	}
	if payload.Aliases == nil {
		writeError(writer, http.StatusBadRequest, "aliases is required")
		return
	}
	provider, err := normalizeManagementOAuthModelAliasProvider(payload.Provider)
	if err != nil {
		writeError(writer, http.StatusBadRequest, err.Error())
		return
	}
	aliases, err := normalizeManagementOAuthModelAliases(*payload.Aliases)
	if err != nil {
		writeError(writer, http.StatusBadRequest, err.Error())
		return
	}
	client, ok := h.managementClientOrError(writer, request)
	if !ok {
		return
	}
	if auditErr := h.recordAudit(request, "oauth_model_alias.update", "oauth_provider", provider, "attempt", map[string]any{"count": len(aliases)}); auditErr != nil {
		writeError(writer, http.StatusInternalServerError, "audit log failure; model alias update aborted")
		return
	}
	if err := client.PatchOAuthModelAliases(request.Context(), provider, managementOAuthModelAliasesToCPA(aliases)); err != nil {
		// Deleting an already-absent provider reaches the same desired state; a
		// missing endpoint has an empty body and is still reported as unsupported.
		if len(aliases) != 0 || !managementOAuthModelAliasChannelMissing(err) {
			_ = h.recordAudit(request, "oauth_model_alias.update", "oauth_provider", provider, "failure", map[string]any{"error": err.Error()})
			writeCPAFacadeError(writer, err)
			return
		}
	}
	serverAliases, err := client.OAuthModelAliases(request.Context())
	if err != nil {
		_ = h.recordAudit(request, "oauth_model_alias.update", "oauth_provider", provider, "failure", map[string]any{"error": "readback failed"})
		writeCPAFacadeError(writer, err)
		return
	}
	projected, err := projectManagementOAuthModelAliases(serverAliases)
	if err != nil {
		_ = h.recordAudit(request, "oauth_model_alias.update", "oauth_provider", provider, "failure", map[string]any{"error": "readback projection failed"})
		writeError(writer, http.StatusBadGateway, err.Error())
		return
	}
	current, exists := projected[provider]
	if len(aliases) == 0 {
		if exists {
			_ = h.recordAudit(request, "oauth_model_alias.update", "oauth_provider", provider, "failure", map[string]any{"error": "provider still present after deletion"})
			writeError(writer, http.StatusBadGateway, "CPA did not persist the model alias deletion")
			return
		}
		current = []managementOAuthModelAlias{}
	} else if !exists || !managementOAuthModelAliasesEqual(current, aliases) {
		_ = h.recordAudit(request, "oauth_model_alias.update", "oauth_provider", provider, "failure", map[string]any{"error": "readback mismatch"})
		writeError(writer, http.StatusBadGateway, "CPA did not persist the OAuth model aliases")
		return
	}
	if h.pricing != nil {
		h.pricing.NotifyModelsChanged()
	}
	if auditErr := h.recordAudit(request, "oauth_model_alias.update", "oauth_provider", provider, "success", map[string]any{"count": len(current), "verified": true}); auditErr != nil {
		writeError(writer, http.StatusInternalServerError, "audit log failure after model alias update")
		return
	}
	writeJSON(writer, http.StatusOK, map[string]any{
		"status":   "ok",
		"provider": provider,
		"aliases":  current,
	})
}

func projectManagementOAuthModelAliases(source map[string][]management.OAuthModelAlias) (map[string][]managementOAuthModelAlias, error) {
	result := make(map[string][]managementOAuthModelAlias, len(source))
	if len(source) > managementOAuthModelAliasProviderLimit {
		return nil, errors.New("CPA returned too many OAuth model alias providers to display safely")
	}
	for rawProvider, entries := range source {
		provider, err := normalizeManagementOAuthModelAliasProvider(rawProvider)
		if err != nil {
			// CPA owns the global map, and an unrelated legacy/plugin channel
			// must not make the whole console capability unreadable.
			continue
		}
		normalized, err := normalizeManagementOAuthModelAliases(managementOAuthModelAliasesFromCPA(entries))
		if err != nil {
			continue
		}
		if len(normalized) > 0 {
			if _, exists := result[provider]; exists {
				continue
			}
			result[provider] = normalized
		}
	}
	return result, nil
}

func managementOAuthModelAliasesFromCPA(entries []management.OAuthModelAlias) []managementOAuthModelAlias {
	converted := make([]managementOAuthModelAlias, 0, len(entries))
	for _, entry := range entries {
		converted = append(converted, managementOAuthModelAlias{
			Name:         entry.Name,
			Alias:        entry.Alias,
			Fork:         entry.Fork,
			DisplayName:  entry.DisplayName,
			ForceMapping: entry.ForceMapping,
		})
	}
	return converted
}

func normalizeManagementOAuthModelAliasProvider(raw string) (string, error) {
	provider := strings.ToLower(strings.TrimSpace(raw))
	provider = strings.ReplaceAll(provider, "_", "-")
	switch provider {
	case "anti-gravity":
		provider = "antigravity"
	case "grok", "x-ai", "x.ai":
		provider = "xai"
	}
	if provider == "" {
		return "", errors.New("provider must be a non-empty provider key")
	}
	if len([]rune(provider)) > 64 {
		return "", errors.New("provider key must be at most 64 characters")
	}
	for _, char := range provider {
		if (char < 'a' || char > 'z') && (char < '0' || char > '9') && char != '-' {
			return "", errors.New("provider may contain only lowercase letters, digits, and hyphens")
		}
	}
	return provider, nil
}

func normalizeManagementOAuthModelAliases(entries []managementOAuthModelAlias) ([]managementOAuthModelAlias, error) {
	if len(entries) > managementOAuthModelAliasEntryLimit {
		return nil, fmt.Errorf("at most %d model aliases are allowed per provider", managementOAuthModelAliasEntryLimit)
	}
	result := make([]managementOAuthModelAlias, 0, len(entries))
	seenAlias := make(map[string]struct{}, len(entries))
	for _, entry := range entries {
		name := strings.TrimSpace(entry.Name)
		alias := strings.TrimSpace(entry.Alias)
		displayName := strings.TrimSpace(entry.DisplayName)
		if name == "" || alias == "" {
			return nil, errors.New("model alias name and alias are required")
		}
		if len([]rune(name)) > managementOAuthModelAliasFieldLimit || len([]rune(alias)) > managementOAuthModelAliasFieldLimit || len([]rune(displayName)) > managementOAuthModelAliasFieldLimit {
			return nil, errors.New("model alias fields are too long")
		}
		if strings.EqualFold(name, alias) {
			return nil, errors.New("model alias must differ from the upstream model name")
		}
		aliasKey := strings.ToLower(alias)
		if _, exists := seenAlias[aliasKey]; exists {
			return nil, fmt.Errorf("model alias %q is duplicated", alias)
		}
		seenAlias[aliasKey] = struct{}{}
		result = append(result, managementOAuthModelAlias{
			Name:         name,
			Alias:        alias,
			Fork:         entry.Fork,
			DisplayName:  displayName,
			ForceMapping: entry.ForceMapping,
		})
	}
	return result, nil
}

func managementOAuthModelAliasesToCPA(entries []managementOAuthModelAlias) []management.OAuthModelAlias {
	result := make([]management.OAuthModelAlias, 0, len(entries))
	for _, entry := range entries {
		result = append(result, management.OAuthModelAlias{
			Name:         entry.Name,
			Alias:        entry.Alias,
			Fork:         entry.Fork,
			DisplayName:  entry.DisplayName,
			ForceMapping: entry.ForceMapping,
		})
	}
	return result
}

func managementOAuthModelAliasesEqual(left []managementOAuthModelAlias, right []managementOAuthModelAlias) bool {
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if left[index] != right[index] {
			return false
		}
	}
	return true
}

func managementOAuthModelAliasChannelMissing(err error) bool {
	var httpErr *management.HTTPError
	return errors.As(err, &httpErr) && httpErr.StatusCode == http.StatusNotFound && strings.Contains(strings.ToLower(httpErr.Body), "channel not found")
}
