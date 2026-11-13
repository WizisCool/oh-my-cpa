package api

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"slices"
	"strings"

	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/management"
	"github.com/oh-my-cpa/oh-my-cpa/internal/statecoord"
)

const (
	managementOAuthModelAliasProviderLimit = 512
	managementOAuthModelAliasEntryLimit    = 512
	managementOAuthModelAliasFieldLimit    = 512
)

// managementOAuthModelAlias is the browser-safe shape for one global OAuth
// model mapping. It contains no credential material.
type managementOAuthModelAlias struct {
	OpenAPI      *bool  `json:"openapi,omitempty"`
	Name         string `json:"name"`
	Alias        string `json:"alias"`
	Fork         bool   `json:"fork,omitempty"`
	DisplayName  string `json:"display_name,omitempty"`
	ForceMapping bool   `json:"force_mapping,omitempty"`
}

// OAuthModelAliasesResponseDTO maps provider names to global OAuth model alias rules.
type OAuthModelAliasesResponseDTO struct {
	Version uint64                                 `json:"version,omitempty"`
	Aliases map[string][]managementOAuthModelAlias `json:"aliases"`
}

// OAuthModelAliasesPatchRequestDTO replaces the global OAuth model alias rules for one provider.
type OAuthModelAliasesPatchRequestDTO struct {
	Provider string                       `json:"provider"`
	Aliases  *[]managementOAuthModelAlias `json:"aliases"`
}

// OAuthModelAliasesPatchResponseDTO returns the verified alias rules for a provider.
type OAuthModelAliasesPatchResponseDTO struct {
	Status   string                      `json:"status"`
	Provider string                      `json:"provider"`
	Aliases  []managementOAuthModelAlias `json:"aliases"`
	Version  uint64                      `json:"version,omitempty"`
}

// @Summary List OAuth model aliases
// @Description Return global OAuth model alias mappings grouped by provider.
// @Tags AuthFiles
// @Produce json
// @Security CookieAuth
// @Success 200 {object} OAuthModelAliasesResponseDTO
// @Failure 401 {object} ErrorResponseDTO
// @Failure 502 {object} ErrorResponseDTO
// @Router /v1/management/auth-files/model-aliases [get]
func (h *Handler) listManagementOAuthModelAliases(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	client, ok := h.managementClientOrError(writer, request)
	if !ok {
		return
	}
	if h.stateCoord != nil {
		env, err := statecoord.ProjectTyped(request.Context(), h.stateCoord, func(state projectedConfigState, _ uint64) (map[string][]managementOAuthModelAlias, error) {
			if state.OAuthAliasesUnavailable {
				return nil, errStateSliceUnavailable
			}
			copied := make(map[string][]managementOAuthModelAlias, len(state.OAuthAliases))
			for provider, list := range state.OAuthAliases {
				copied[provider] = slices.Clone(list)
			}
			return copied, nil
		})
		if err == nil {
			setStateVersionHeader(writer, env.Version)
			writeJSON(writer, http.StatusOK, OAuthModelAliasesResponseDTO{
				Version: env.Version,
				Aliases: env.Data,
			})
			return
		}
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
	writeJSON(writer, http.StatusOK, OAuthModelAliasesResponseDTO{Aliases: projected})
}

// errOAuthModelAliasMismatch reports a write CPA accepted but did not read back as requested.
var errOAuthModelAliasMismatch = errors.New("CPA did not persist the OAuth model aliases")

// applyManagementOAuthModelAliases replaces one provider's global mapping and verifies the readback.
// CPA stores every provider's mapping in one document, so the whole-configuration write gate covers it.
func (h *Handler) applyManagementOAuthModelAliases(ctx context.Context, client *management.Client, provider string, aliases []managementOAuthModelAlias, beforeWrite func(context.Context) error) ([]managementOAuthModelAlias, error) {
	if err := h.providerWrites.acquire(ctx); err != nil {
		return nil, errors.New("write_busy")
	}
	defer h.providerWrites.release()
	if err := h.flushCoordinatorUnderProviderGate(ctx); err != nil {
		return nil, err
	}
	if beforeWrite != nil {
		if err := beforeWrite(ctx); err != nil {
			return nil, err
		}
	}
	if err := client.PatchOAuthModelAliases(ctx, provider, managementOAuthModelAliasesToCPA(aliases)); err != nil {
		if errors.Is(err, management.ErrConfigPartiallyApplied) {
			h.invalidateCoordinator("management-oauth-model-aliases", "management-config")
		}
		return nil, err
	}
	h.invalidateCoordinator("management-oauth-model-aliases", "management-config")
	serverAliases, err := client.OAuthModelAliases(ctx)
	if err != nil {
		return nil, err
	}
	projected, err := projectManagementOAuthModelAliases(serverAliases)
	if err != nil {
		return nil, err
	}
	current, exists := projected[provider]
	if len(aliases) == 0 {
		if exists {
			return nil, errOAuthModelAliasMismatch
		}
		current = []managementOAuthModelAlias{}
	} else if !exists || !managementOAuthModelAliasesEqual(current, aliases) {
		return nil, errOAuthModelAliasMismatch
	}
	if h.pricing != nil {
		h.pricing.NotifyModelsChanged()
	}
	return current, nil
}

// @Summary Update OAuth model aliases for a provider
// @Description Replace global OAuth model aliases for one provider and verify persistence.
// @Tags AuthFiles
// @Accept json
// @Produce json
// @Security CookieAuth
// @Param body body OAuthModelAliasesPatchRequestDTO true "Provider model alias list"
// @Success 200 {object} OAuthModelAliasesPatchResponseDTO
// @Failure 400 {object} ErrorResponseDTO
// @Failure 401 {object} ErrorResponseDTO
// @Failure 500 {object} ErrorResponseDTO
// @Failure 502 {object} ErrorResponseDTO
// @Router /v1/management/auth-files/model-aliases [patch]
func (h *Handler) patchManagementOAuthModelAliases(writer http.ResponseWriter, request *http.Request) {
	var payload OAuthModelAliasesPatchRequestDTO
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
	if err := validateOAuthAliasFamily(provider, aliases); err != nil {
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
	if h.stateCoord != nil {
		domain := statecoord.DomainKey(stateDomainOAuthAliasesPrefix + provider)
		var useFallback bool
		version, mutErr := h.mutateCoordinatorWithAudit(
			request,
			domain,
			"oauth_model_alias.update",
			"oauth_provider",
			provider,
			map[string]any{"count": len(aliases), "verified": true},
			func(state *projectedConfigState) error {
				if state.OAuthAliasesUnavailable {
					useFallback = true
					return errStateSliceUnavailable
				}
				if state.OAuthAliases == nil {
					state.OAuthAliases = make(map[string][]managementOAuthModelAlias)
				}
				if len(aliases) == 0 {
					delete(state.OAuthAliases, provider)
				} else {
					state.OAuthAliases[provider] = slices.Clone(aliases)
				}
				return nil
			},
		)
		if !useFallback {
			if mutErr != nil {
				_ = h.recordAudit(request, "oauth_model_alias.update", "oauth_provider", provider, "failure", map[string]any{"error": mutErr.Error()})
				writeProviderWriteError(writer, mutErr)
				return
			}
			setStateVersionHeader(writer, version)
			writeJSON(writer, http.StatusOK, OAuthModelAliasesPatchResponseDTO{
				Status:   "ok",
				Provider: provider,
				Aliases:  aliases,
				Version:  version,
			})
			return
		}
	}
	current, err := h.applyManagementOAuthModelAliases(request.Context(), client, provider, aliases, nil)
	if err != nil {
		_ = h.recordAudit(request, "oauth_model_alias.update", "oauth_provider", provider, "failure", map[string]any{"error": err.Error()})
		if errors.Is(err, errOAuthModelAliasMismatch) {
			writeError(writer, http.StatusBadGateway, err.Error())
			return
		}
		writeCPAFacadeError(writer, err)
		return
	}
	if auditErr := h.recordAudit(request, "oauth_model_alias.update", "oauth_provider", provider, "success", map[string]any{"count": len(current), "verified": true}); auditErr != nil {
		writeError(writer, http.StatusInternalServerError, "audit log failure after model alias update")
		return
	}
	writeJSON(writer, http.StatusOK, OAuthModelAliasesPatchResponseDTO{
		Status:   "ok",
		Provider: provider,
		Aliases:  current,
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
			ForceMapping: entry.ForceMapping, OpenAPI: entry.OpenAPI,
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
		// Only the alias is unique: CPA resolves a rule by the call point it names, so several
		// aliases may reach one upstream model, and a Vertex rule may map it once per API shape.
		if _, exists := seenAlias[aliasKey]; exists {
			return nil, fmt.Errorf("model alias %q is duplicated", alias)
		}
		seenAlias[aliasKey] = struct{}{}
		result = append(result, managementOAuthModelAlias{
			Name:         name,
			Alias:        alias,
			Fork:         entry.Fork,
			DisplayName:  displayName,
			ForceMapping: entry.ForceMapping, OpenAPI: entry.OpenAPI,
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
			ForceMapping: entry.ForceMapping, OpenAPI: entry.OpenAPI,
		})
	}
	return result
}

func managementOAuthModelAliasesEqual(left []managementOAuthModelAlias, right []managementOAuthModelAlias) bool {
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if !equalOptionalBool(left[index].OpenAPI, right[index].OpenAPI) {
			return false
		}
		leftEntry, rightEntry := left[index], right[index]
		leftEntry.OpenAPI, rightEntry.OpenAPI = nil, nil
		if leftEntry != rightEntry {
			return false
		}
	}
	return true
}

func equalOptionalBool(left, right *bool) bool {
	return (left == nil && right == nil) || (left != nil && right != nil && *left == *right)
}

func validateOAuthAliasFamily(provider string, aliases []managementOAuthModelAlias) error {
	for _, alias := range aliases {
		if alias.OpenAPI != nil && provider != "vertex" {
			return errors.New("model alias openapi requires Vertex")
		}
	}
	return nil
}
