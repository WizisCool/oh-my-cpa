package api

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"unicode"

	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/management"
)

const (
	managementOAuthExcludedModelRuleLimit  = 512
	managementOAuthExcludedModelFieldLimit = 256
)

func (h *Handler) listManagementOAuthExcludedModels(writer http.ResponseWriter, request *http.Request) {
	client, ok := h.managementClientOrError(writer, request)
	if !ok {
		return
	}
	stored, err := client.OAuthExcludedModels(request.Context())
	if err != nil {
		writeCPAFacadeError(writer, err)
		return
	}
	projected, err := projectManagementOAuthExcludedModels(stored)
	if err != nil {
		writeError(writer, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(writer, http.StatusOK, map[string]any{"excluded_models": projected})
}

// errOAuthExcludedModelsMismatch reports a write CPA accepted but did not read back as requested.
var errOAuthExcludedModelsMismatch = errors.New("CPA did not persist the OAuth excluded models")

// applyManagementOAuthExcludedModels replaces one provider's exclusion rules and verifies the readback.
// CPA stores every provider's rules in one document, so the whole-configuration write gate covers it.
func (h *Handler) applyManagementOAuthExcludedModels(ctx context.Context, client *management.Client, provider string, rules []string, beforeWrite func(context.Context) error) ([]string, error) {
	if err := h.providerWrites.acquire(ctx); err != nil {
		return nil, errors.New("write_busy")
	}
	defer h.providerWrites.release()
	if beforeWrite != nil {
		if err := beforeWrite(ctx); err != nil {
			return nil, err
		}
	}
	if err := client.PatchOAuthExcludedModels(ctx, provider, rules); err != nil {
		return nil, err
	}
	stored, err := client.OAuthExcludedModels(ctx)
	if err != nil {
		return nil, err
	}
	projected, err := projectManagementOAuthExcludedModels(stored)
	if err != nil {
		return nil, err
	}
	current := projected[provider]
	if current == nil {
		current = []string{}
	}
	if !equalStringSlices(current, rules) {
		return nil, errOAuthExcludedModelsMismatch
	}
	// The set of models a provider serves is what pricing membership is read from.
	if h.pricing != nil {
		h.pricing.NotifyModelsChanged()
	}
	return current, nil
}

func (h *Handler) patchManagementOAuthExcludedModels(writer http.ResponseWriter, request *http.Request) {
	var payload struct {
		Provider string    `json:"provider"`
		Models   *[]string `json:"models"`
	}
	if err := decodeManagementJSON(writer, request, managementAuthFileRequestLimit, &payload); err != nil {
		return
	}
	if payload.Models == nil {
		writeError(writer, http.StatusBadRequest, "models is required")
		return
	}
	provider, err := normalizeManagementOAuthModelAliasProvider(payload.Provider)
	if err != nil {
		writeError(writer, http.StatusBadRequest, err.Error())
		return
	}
	rules, err := normalizeManagementOAuthExcludedModels(*payload.Models)
	if err != nil {
		writeError(writer, http.StatusBadRequest, err.Error())
		return
	}
	client, ok := h.managementClientOrError(writer, request)
	if !ok {
		return
	}
	if auditErr := h.recordAudit(request, "oauth_excluded_models.update", "oauth_provider", provider, "attempt", map[string]any{"count": len(rules)}); auditErr != nil {
		writeError(writer, http.StatusInternalServerError, "audit log failure; excluded models update aborted")
		return
	}
	current, err := h.applyManagementOAuthExcludedModels(request.Context(), client, provider, rules, nil)
	if err != nil {
		_ = h.recordAudit(request, "oauth_excluded_models.update", "oauth_provider", provider, "failure", map[string]any{"error": err.Error()})
		if errors.Is(err, errOAuthExcludedModelsMismatch) {
			writeError(writer, http.StatusBadGateway, err.Error())
			return
		}
		writeCPAFacadeError(writer, err)
		return
	}
	if auditErr := h.recordAudit(request, "oauth_excluded_models.update", "oauth_provider", provider, "success", map[string]any{"count": len(current), "verified": true}); auditErr != nil {
		writeError(writer, http.StatusInternalServerError, "audit log failure after excluded models update")
		return
	}
	writeJSON(writer, http.StatusOK, map[string]any{
		"status":   "ok",
		"provider": provider,
		"models":   current,
	})
}

// listManagementOAuthProviderModels serves the model catalog the rule editors
// pick from. `available` is false for a provider CPA keeps no catalog for; the
// editors then accept typed model IDs only.
func (h *Handler) listManagementOAuthProviderModels(writer http.ResponseWriter, request *http.Request) {
	provider, err := normalizeManagementOAuthModelAliasProvider(request.URL.Query().Get("provider"))
	if err != nil {
		writeError(writer, http.StatusBadRequest, err.Error())
		return
	}
	client, ok := h.managementClientOrError(writer, request)
	if !ok {
		return
	}
	models, isAvailable, err := client.OAuthChannelModelDefinitions(request.Context(), provider)
	if err != nil {
		writeCPAFacadeError(writer, err)
		return
	}
	projected := make([]managementAuthFileModel, 0, len(models))
	seen := make(map[string]struct{}, len(models))
	for _, model := range models {
		id := boundedText(model.ID, managementAuthFileFieldLimit)
		key := strings.ToLower(id)
		if _, isRepeated := seen[key]; id == "" || isRepeated {
			continue
		}
		seen[key] = struct{}{}
		projected = append(projected, managementAuthFileModel{ID: id, DisplayName: boundedText(model.DisplayName, managementAuthFileFieldLimit)})
		if len(projected) >= managementAuthFileListLimit {
			break
		}
	}
	writeJSON(writer, http.StatusOK, map[string]any{"provider": provider, "available": isAvailable, "models": projected})
}

func projectManagementOAuthExcludedModels(source map[string][]string) (map[string][]string, error) {
	if len(source) > managementOAuthModelAliasProviderLimit {
		return nil, errors.New("CPA returned too many OAuth excluded model providers to display safely")
	}
	result := make(map[string][]string, len(source))
	for rawProvider, rules := range source {
		provider, err := normalizeManagementOAuthModelAliasProvider(rawProvider)
		if err != nil {
			// CPA owns the global map, and an unrelated legacy/plugin channel
			// must not make the whole console capability unreadable.
			continue
		}
		normalized, err := normalizeManagementOAuthExcludedModels(rules)
		if err != nil || len(normalized) == 0 {
			continue
		}
		if _, exists := result[provider]; exists {
			continue
		}
		result[provider] = normalized
	}
	return result, nil
}

// normalizeManagementOAuthExcludedModels returns the rules as CPA will apply
// them. A rule is a model ID or a pattern in which only `*` is special, so
// whitespace and control characters can never be part of one.
func normalizeManagementOAuthExcludedModels(rules []string) ([]string, error) {
	if len(rules) > managementOAuthExcludedModelRuleLimit {
		return nil, fmt.Errorf("at most %d excluded model rules are allowed per provider", managementOAuthExcludedModelRuleLimit)
	}
	normalized := management.NormalizeExcludedModelRules(rules)
	for _, rule := range normalized {
		if len([]rune(rule)) > managementOAuthExcludedModelFieldLimit {
			return nil, errors.New("excluded model rule is too long")
		}
		for _, char := range rule {
			if unicode.IsSpace(char) || unicode.IsControl(char) {
				return nil, errors.New("excluded model rule must not contain whitespace or control characters")
			}
		}
	}
	return normalized, nil
}
