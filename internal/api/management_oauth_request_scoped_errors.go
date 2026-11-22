package api

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"slices"
	"sort"
	"strings"

	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/management"
	"github.com/oh-my-cpa/oh-my-cpa/internal/statecoord"
)

// OAuthRequestScopedErrorsResponseDTO maps OAuth provider channels to global
// request-scoped error classification rules.
type OAuthRequestScopedErrorsResponseDTO struct {
	Version             uint64                            `json:"version,omitempty"`
	RequestScopedErrors map[string][]ProviderErrorRuleDTO `json:"request_scoped_errors"`
}

// OAuthRequestScopedErrorsPatchRequestDTO replaces global request-scoped error
// rules for one OAuth provider channel.
type OAuthRequestScopedErrorsPatchRequestDTO struct {
	Provider string                  `json:"provider" validate:"required"`
	Rules    *[]ProviderErrorRuleDTO `json:"rules" validate:"required"`
}

// OAuthRequestScopedErrorsPatchResponseDTO returns the verified global
// request-scoped error rules for one OAuth provider channel.
type OAuthRequestScopedErrorsPatchResponseDTO struct {
	Status   string                 `json:"status"`
	Provider string                 `json:"provider"`
	Rules    []ProviderErrorRuleDTO `json:"rules"`
	Version  uint64                 `json:"version,omitempty"`
}

// @Summary List OAuth request-scoped error rules
// @Description Return per-provider global request-scoped error rules configured in CPA for OAuth credentials.
// @Tags AuthFiles
// @Produce json
// @Security CookieAuth
// @Success 200 {object} OAuthRequestScopedErrorsResponseDTO
// @Failure 401 {object} ErrorResponseDTO
// @Failure 502 {object} ErrorResponseDTO
// @Router /v1/management/auth-files/request-scoped-errors [get]
func (h *Handler) listManagementOAuthRequestScopedErrors(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	client, ok := h.managementClientOrError(writer, request)
	if !ok {
		return
	}
	if h.stateCoord != nil {
		env, err := statecoord.ProjectTyped(request.Context(), h.stateCoord, func(state projectedConfigState, _ uint64) (map[string][]ProviderErrorRuleDTO, error) {
			if state.OAuthErrorRulesUnavailable {
				return nil, errStateSliceUnavailable
			}
			return cloneOAuthErrorRulesMap(state.OAuthErrorRules), nil
		})
		if err == nil {
			setStateVersionHeader(writer, env.Version)
			writeJSON(writer, http.StatusOK, OAuthRequestScopedErrorsResponseDTO{
				Version:             env.Version,
				RequestScopedErrors: env.Data,
			})
			return
		}
	}
	stored, err := client.OAuthRequestScopedErrors(request.Context())
	if err != nil {
		writeCPAFacadeError(writer, err)
		return
	}
	projected, err := projectManagementOAuthRequestScopedErrors(stored)
	if err != nil {
		writeError(writer, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(writer, http.StatusOK, OAuthRequestScopedErrorsResponseDTO{RequestScopedErrors: projected})
}

// errOAuthRequestScopedErrorsMismatch reports a write CPA accepted but did not read back as requested.
var errOAuthRequestScopedErrorsMismatch = errors.New("CPA did not persist the OAuth request-scoped error rules")

// applyManagementOAuthRequestScopedErrors replaces one provider's global error rules and verifies the readback.
func (h *Handler) applyManagementOAuthRequestScopedErrors(
	ctx context.Context,
	client *management.Client,
	provider string,
	rules []ProviderErrorRuleDTO,
	beforeWrite func(context.Context) error,
) ([]ProviderErrorRuleDTO, error) {
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
	if err := client.PatchOAuthRequestScopedErrors(ctx, provider, providerErrorRulesToManagement(rules)); err != nil {
		if errors.Is(err, management.ErrConfigPartiallyApplied) {
			h.invalidateCoordinator("management-oauth-request-scoped-errors", "management-config")
		}
		return nil, err
	}
	h.invalidateCoordinator("management-oauth-request-scoped-errors", "management-config")
	stored, err := client.OAuthRequestScopedErrors(ctx)
	if err != nil {
		return nil, err
	}
	projected, err := projectManagementOAuthRequestScopedErrors(stored)
	if err != nil {
		return nil, err
	}
	current := projected[provider]
	if current == nil {
		current = []ProviderErrorRuleDTO{}
	}
	if !equalErrorRules(current, rules) {
		return nil, errOAuthRequestScopedErrorsMismatch
	}
	return current, nil
}

// @Summary Update OAuth request-scoped error rules for a provider
// @Description Replace global request-scoped error rules for one OAuth provider channel and verify persistence.
// @Tags AuthFiles
// @Accept json
// @Produce json
// @Security CookieAuth
// @Param body body OAuthRequestScopedErrorsPatchRequestDTO true "Provider request-scoped error rules payload"
// @Success 200 {object} OAuthRequestScopedErrorsPatchResponseDTO
// @Failure 400 {object} ErrorResponseDTO
// @Failure 401 {object} ErrorResponseDTO
// @Failure 500 {object} ErrorResponseDTO
// @Failure 502 {object} ErrorResponseDTO
// @Router /v1/management/auth-files/request-scoped-errors [patch]
func (h *Handler) patchManagementOAuthRequestScopedErrors(writer http.ResponseWriter, request *http.Request) {
	var payload OAuthRequestScopedErrorsPatchRequestDTO
	if err := decodeManagementJSON(writer, request, managementAuthFileRequestLimit, &payload); err != nil {
		return
	}
	if payload.Rules == nil {
		writeError(writer, http.StatusBadRequest, "rules is required")
		return
	}
	provider, err := normalizeManagementOAuthModelAliasProvider(payload.Provider)
	if err != nil {
		writeError(writer, http.StatusBadRequest, err.Error())
		return
	}
	rules, err := normalizeManagementOAuthRequestScopedErrors(*payload.Rules)
	if err != nil {
		writeError(writer, http.StatusBadRequest, err.Error())
		return
	}
	client, ok := h.managementClientOrError(writer, request)
	if !ok {
		return
	}
	if auditErr := h.recordAudit(request, "oauth_request_scoped_errors.update", "oauth_provider", provider, "attempt", map[string]any{"count": len(rules)}); auditErr != nil {
		writeError(writer, http.StatusInternalServerError, "audit log failure; request-scoped error rules update aborted")
		return
	}
	if h.stateCoord != nil {
		domain := statecoord.DomainKey(stateDomainOAuthErrorRulesPrefix + provider)
		var useFallback bool
		version, mutErr := h.mutateCoordinatorWithAudit(
			request,
			domain,
			"oauth_request_scoped_errors.update",
			"oauth_provider",
			provider,
			map[string]any{"count": len(rules), "verified": true},
			func(state *projectedConfigState) error {
				if state.OAuthErrorRulesUnavailable {
					useFallback = true
					return errStateSliceUnavailable
				}
				if state.OAuthErrorRules == nil {
					state.OAuthErrorRules = make(map[string][]ProviderErrorRuleDTO)
				}
				if len(rules) == 0 {
					delete(state.OAuthErrorRules, provider)
				} else {
					state.OAuthErrorRules[provider] = cloneErrorRuleDTOs(rules)
				}
				return nil
			},
		)
		if !useFallback {
			if mutErr != nil {
				_ = h.recordAudit(request, "oauth_request_scoped_errors.update", "oauth_provider", provider, "failure", map[string]any{"error": mutErr.Error()})
				writeProviderWriteError(writer, mutErr)
				return
			}
			setStateVersionHeader(writer, version)
			writeJSON(writer, http.StatusOK, OAuthRequestScopedErrorsPatchResponseDTO{
				Status:   "ok",
				Provider: provider,
				Rules:    rules,
				Version:  version,
			})
			return
		}
	}
	current, err := h.applyManagementOAuthRequestScopedErrors(request.Context(), client, provider, rules, nil)
	if err != nil {
		_ = h.recordAudit(request, "oauth_request_scoped_errors.update", "oauth_provider", provider, "failure", map[string]any{"error": err.Error()})
		if errors.Is(err, errOAuthRequestScopedErrorsMismatch) {
			writeError(writer, http.StatusBadGateway, err.Error())
			return
		}
		writeCPAFacadeError(writer, err)
		return
	}
	// CPA has already persisted and verified the rules; an audit failure cannot undo that write.
	_ = h.recordAudit(request, "oauth_request_scoped_errors.update", "oauth_provider", provider, "success", map[string]any{"count": len(current), "verified": true})
	writeJSON(writer, http.StatusOK, OAuthRequestScopedErrorsPatchResponseDTO{
		Status:   "ok",
		Provider: provider,
		Rules:    current,
	})
}

func projectManagementOAuthRequestScopedErrors(source map[string][]management.RequestScopedErrorRule) (map[string][]ProviderErrorRuleDTO, error) {
	if len(source) > managementOAuthModelAliasProviderLimit {
		return nil, errors.New("CPA returned too many OAuth request-scoped error providers to display safely")
	}
	rawProviders := make([]string, 0, len(source))
	for rawProvider := range source {
		rawProviders = append(rawProviders, rawProvider)
	}
	sort.Strings(rawProviders)
	result := make(map[string][]ProviderErrorRuleDTO, len(source))
	for _, rawProvider := range rawProviders {
		provider, err := normalizeManagementOAuthModelAliasProvider(rawProvider)
		if err != nil {
			continue
		}
		if _, exists := result[provider]; exists {
			continue
		}
		rules := source[rawProvider]
		if len(rules) == 0 {
			continue
		}
		if len(rules) > maxProviderErrorRules {
			return nil, fmt.Errorf("CPA returned too many OAuth request-scoped error rules for provider %q", provider)
		}
		converted := make([]ProviderErrorRuleDTO, 0, len(rules))
		for _, rule := range rules {
			converted = append(converted, ProviderErrorRuleDTO{
				Status:     rule.Status,
				Match:      slices.Clone(rule.Match),
				MatchRegex: slices.Clone(rule.MatchRegex),
				Action:     rule.Action,
			})
		}
		if len(converted) > 0 {
			result[provider] = converted
		}
	}
	return result, nil
}

// normalizeManagementOAuthRequestScopedErrors validates and normalizes submitted
// rules to match CPA's SanitizeOAuthRequestScopedErrors trimming behavior so
// verified readbacks agree verbatim with what was submitted.
func normalizeManagementOAuthRequestScopedErrors(rules []ProviderErrorRuleDTO) ([]ProviderErrorRuleDTO, error) {
	if len(rules) > maxProviderErrorRules {
		return nil, fmt.Errorf("request_scoped_errors holds more than %d rules", maxProviderErrorRules)
	}
	normalized := make([]ProviderErrorRuleDTO, 0, len(rules))
	for position, rule := range rules {
		var match []string
		if len(rule.Match) > 0 {
			match = make([]string, 0, len(rule.Match))
			for _, raw := range rule.Match {
				trimmed := strings.TrimSpace(raw)
				if trimmed == "" {
					return nil, fmt.Errorf("request_scoped_errors[%d]: a match must not be empty", position)
				}
				match = append(match, trimmed)
			}
		}
		var matchRegex []string
		if len(rule.MatchRegex) > 0 {
			matchRegex = make([]string, 0, len(rule.MatchRegex))
			for _, raw := range rule.MatchRegex {
				trimmed := strings.TrimSpace(raw)
				if trimmed == "" {
					return nil, fmt.Errorf("request_scoped_errors[%d]: a match must not be empty", position)
				}
				matchRegex = append(matchRegex, trimmed)
			}
		}
		candidate := ProviderErrorRuleDTO{
			Status:     rule.Status,
			Match:      match,
			MatchRegex: matchRegex,
			Action:     strings.ToLower(strings.TrimSpace(rule.Action)),
		}
		if reason := errorRuleProblem(candidate); reason != "" {
			return nil, fmt.Errorf("request_scoped_errors[%d]: %s", position, reason)
		}
		normalized = append(normalized, candidate)
	}
	return normalized, nil
}

func providerErrorRulesToManagement(rules []ProviderErrorRuleDTO) []management.RequestScopedErrorRule {
	if len(rules) == 0 {
		return nil
	}
	converted := make([]management.RequestScopedErrorRule, 0, len(rules))
	for _, rule := range rules {
		converted = append(converted, management.RequestScopedErrorRule{
			Status:     rule.Status,
			Match:      slices.Clone(rule.Match),
			MatchRegex: slices.Clone(rule.MatchRegex),
			Action:     rule.Action,
		})
	}
	return converted
}

func cloneErrorRuleDTOs(rules []ProviderErrorRuleDTO) []ProviderErrorRuleDTO {
	if rules == nil {
		return nil
	}
	copied := make([]ProviderErrorRuleDTO, len(rules))
	for i, rule := range rules {
		copied[i] = ProviderErrorRuleDTO{
			Status:     rule.Status,
			Match:      slices.Clone(rule.Match),
			MatchRegex: slices.Clone(rule.MatchRegex),
			Action:     rule.Action,
		}
	}
	return copied
}

func cloneOAuthErrorRulesMap(source map[string][]ProviderErrorRuleDTO) map[string][]ProviderErrorRuleDTO {
	copied := make(map[string][]ProviderErrorRuleDTO, len(source))
	for provider, rules := range source {
		copied[provider] = cloneErrorRuleDTOs(rules)
	}
	return copied
}
