package api

import (
	"fmt"
	"net/http"
	"regexp"
	"strings"

	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/management"
)

// A provider's cooling and Codex cloaking are pointer settings in CPA: absent
// inherits the global value, and the two explicit values override it either way.
// The console states all three rather than a switch, because a switch cannot
// tell "off" from "inherit".
const (
	providerOverrideInherit  = "inherit"
	providerOverrideEnabled  = "enabled"
	providerOverrideDisabled = "disabled"
)

const (
	maxProviderErrorRules        = 64
	maxProviderErrorRulePatterns = 32
	maxProviderErrorPatternBytes = 1024
)

// PROVIDER_ERROR_RULE_ACTIONS are the actions CPA acts on. A rule naming any
// other action is skipped by CPA without a report, so it is refused here.
var PROVIDER_ERROR_RULE_ACTIONS = []string{"stop", "stop-and-cooldown", "continue", "continue-and-cooldown"}

type ProviderErrorRuleDTO struct {
	Status     int      `json:"status"`
	Match      []string `json:"match,omitempty"`
	MatchRegex []string `json:"match_regex,omitempty"`
	Action     string   `json:"action"`
}

// ProviderRuntimePolicyDTO is how a provider overrides the gateway's retry and
// cooldown behaviour. On a write it is authoritative for all three settings.
type ProviderRuntimePolicyDTO struct {
	Cooling string `json:"cooling"`
	// RequestRetry is nil when the provider inherits the global retry count.
	RequestRetry *int                   `json:"request_retry,omitempty"`
	ErrorRules   []ProviderErrorRuleDTO `json:"error_rules,omitempty"`
	// SupportsErrorRules is reported on reads and ignored on writes.
	SupportsErrorRules bool `json:"supports_error_rules"`
}

// ProviderBehaviorDTO carries the request-behaviour switches a family has. A
// field is present on a read only for a family that has it.
type ProviderBehaviorDTO struct {
	AlphaSearch             *bool  `json:"alpha_search,omitempty"`
	CodexCloaking           string `json:"codex_cloaking,omitempty"`
	RebuildMidSystemMessage *bool  `json:"rebuild_mid_system_message,omitempty"`
	SupportPromptCacheKey   *bool  `json:"support_prompt_cache_key,omitempty"`
}

// providerPolicyCapabilities states which optional settings a family's CPA
// entry declares. CPA decodes each family strictly, so a setting written to a
// family without it makes CPA refuse the whole configuration.
type providerPolicyCapabilities struct {
	hasErrorRules              bool
	hasAlphaSearch             bool
	hasCodexCloaking           bool
	hasRebuildMidSystemMessage bool
	hasPromptCacheKey          bool
}

func providerPolicyCapabilitiesFor(family string) providerPolicyCapabilities {
	switch management.ConfigKeyFamily(family) {
	case management.ConfigFamilyCodex:
		return providerPolicyCapabilities{hasErrorRules: true, hasAlphaSearch: true, hasCodexCloaking: true}
	case management.ConfigFamilyClaude:
		return providerPolicyCapabilities{hasErrorRules: true, hasRebuildMidSystemMessage: true}
	case management.ConfigFamilyVertex:
		return providerPolicyCapabilities{}
	}
	if family == openAICompatibilityFamily {
		return providerPolicyCapabilities{hasErrorRules: true, hasPromptCacheKey: true}
	}
	return providerPolicyCapabilities{hasErrorRules: true}
}

func overrideState(disabled *bool) string {
	switch {
	case disabled == nil:
		return providerOverrideInherit
	case *disabled:
		return providerOverrideDisabled
	default:
		return providerOverrideEnabled
	}
}

// overrideValue is the stored pointer for a stated override; state names
// whether the feature is enabled, and the stored flag disables it.
func overrideValue(state string) (*bool, bool) {
	switch state {
	case providerOverrideInherit:
		return nil, true
	case providerOverrideEnabled:
		isDisabled := false
		return &isDisabled, true
	case providerOverrideDisabled:
		isDisabled := true
		return &isDisabled, true
	}
	return nil, false
}

func providerRuntimePolicyDTO(disableCooling *bool, requestRetry *int, rules []management.RequestScopedErrorRule, capabilities providerPolicyCapabilities) *ProviderRuntimePolicyDTO {
	policy := &ProviderRuntimePolicyDTO{
		Cooling:            overrideState(disableCooling),
		SupportsErrorRules: capabilities.hasErrorRules,
	}
	// CPA reads a negative count as "inherit", so it is reported as inherited.
	if requestRetry != nil && *requestRetry >= 0 {
		retry := *requestRetry
		policy.RequestRetry = &retry
	}
	for _, rule := range rules {
		policy.ErrorRules = append(policy.ErrorRules, ProviderErrorRuleDTO{
			Status:     rule.Status,
			Match:      rule.Match,
			MatchRegex: rule.MatchRegex,
			Action:     rule.Action,
		})
	}
	return policy
}

func configKeyBehaviorDTO(entry management.ConfigAPIKey, capabilities providerPolicyCapabilities) *ProviderBehaviorDTO {
	behavior := &ProviderBehaviorDTO{}
	if capabilities.hasAlphaSearch {
		isEnabled := entry.AlphaSearch
		behavior.AlphaSearch = &isEnabled
	}
	if capabilities.hasCodexCloaking {
		behavior.CodexCloaking = overrideState(entry.DisableCodexCloaking)
	}
	if capabilities.hasRebuildMidSystemMessage {
		isEnabled := entry.RebuildMidSystemMessage
		behavior.RebuildMidSystemMessage = &isEnabled
	}
	if *behavior == (ProviderBehaviorDTO{}) {
		return nil
	}
	return behavior
}

// providerPolicyEdit is a save request's policy and behaviour after validation.
// A nil part was not submitted and leaves the stored settings as they are.
type providerPolicyEdit struct {
	policy       *ProviderRuntimePolicyDTO
	behavior     *ProviderBehaviorDTO
	capabilities providerPolicyCapabilities
}

// resolveProviderPolicyEdit validates the optional policy and behaviour of a
// save request against what the family supports. It runs before any CPA write,
// for the same reason the website is validated first.
func resolveProviderPolicyEdit(family string, req SaveProviderRequest) (providerPolicyEdit, error) {
	edit := providerPolicyEdit{policy: req.RuntimePolicy, behavior: req.Behavior, capabilities: providerPolicyCapabilitiesFor(family)}
	refuse := func(format string, args ...any) (providerPolicyEdit, error) {
		return providerPolicyEdit{}, newProviderWriteError(http.StatusBadRequest, fmt.Sprintf(format, args...))
	}
	if policy := edit.policy; policy != nil {
		if _, ok := overrideValue(policy.Cooling); !ok {
			return refuse("runtime_policy.cooling must be inherit, enabled or disabled")
		}
		if policy.RequestRetry != nil && *policy.RequestRetry < 0 {
			return refuse("runtime_policy.request_retry must be zero or greater; omit it to inherit the global setting")
		}
		if len(policy.ErrorRules) > 0 && !edit.capabilities.hasErrorRules {
			return refuse("this provider family does not support request-scoped error rules")
		}
		if len(policy.ErrorRules) > maxProviderErrorRules {
			return refuse("runtime_policy.error_rules holds more than %d rules", maxProviderErrorRules)
		}
	}
	if behavior := edit.behavior; behavior != nil {
		capabilities := edit.capabilities
		switch {
		case behavior.AlphaSearch != nil && !capabilities.hasAlphaSearch,
			behavior.CodexCloaking != "" && !capabilities.hasCodexCloaking,
			behavior.RebuildMidSystemMessage != nil && !capabilities.hasRebuildMidSystemMessage,
			behavior.SupportPromptCacheKey != nil && !capabilities.hasPromptCacheKey:
			return refuse("behavior names a setting this provider family does not have")
		}
		if behavior.CodexCloaking != "" {
			if _, ok := overrideValue(behavior.CodexCloaking); !ok {
				return refuse("behavior.codex_cloaking must be inherit, enabled or disabled")
			}
		}
	}
	return edit, nil
}

// validateProviderErrorRule refuses a rule CPA would skip. CPA applies a rule
// only when its status is positive, a pattern is non-empty and the action is
// known, and it ignores a regular expression that does not compile - all
// silently, so an operator would believe a dead rule was in force.
func validateProviderErrorRule(position int, rule ProviderErrorRuleDTO) error {
	if reason := errorRuleProblem(rule); reason != "" {
		return newProviderWriteError(http.StatusBadRequest, fmt.Sprintf("runtime_policy.error_rules[%d]: %s", position, reason))
	}
	return nil
}

// errorRuleProblem states why CPA would not run the rule, or "" when it would.
// A provider's rules and a credential's are read by the same CPA code.
func errorRuleProblem(rule ProviderErrorRuleDTO) string {
	refuse := func(reason string) string { return reason }
	if rule.Status < 100 || rule.Status > 599 {
		return refuse("status must be an HTTP status code")
	}
	isKnownAction := false
	for _, action := range PROVIDER_ERROR_RULE_ACTIONS {
		if rule.Action == action {
			isKnownAction = true
		}
	}
	if !isKnownAction {
		return refuse("action must be one of " + strings.Join(PROVIDER_ERROR_RULE_ACTIONS, ", "))
	}
	if len(rule.Match)+len(rule.MatchRegex) == 0 {
		return refuse("at least one text or regular-expression match is required")
	}
	if len(rule.Match)+len(rule.MatchRegex) > maxProviderErrorRulePatterns {
		return refuse(fmt.Sprintf("more than %d matches", maxProviderErrorRulePatterns))
	}
	for _, pattern := range append(append([]string{}, rule.Match...), rule.MatchRegex...) {
		if pattern == "" {
			return refuse("a match must not be empty")
		}
		if len(pattern) > maxProviderErrorPatternBytes {
			return refuse(fmt.Sprintf("a match is longer than %d bytes", maxProviderErrorPatternBytes))
		}
	}
	for _, pattern := range rule.MatchRegex {
		// CPA compiles these with the same package, so this is the exact test.
		if _, err := regexp.Compile(pattern); err != nil {
			return refuse("invalid regular expression: " + err.Error())
		}
	}
	return ""
}

// editedErrorRules is the stored rule list after an edit. A submitted rule equal
// to the stored rule in its position is kept as stored: it keeps the settings
// the console does not edit, and a rule CPA already accepted is not refused
// because an unrelated field of the provider changed.
func editedErrorRules(stored []management.RequestScopedErrorRule, submitted []ProviderErrorRuleDTO) ([]management.RequestScopedErrorRule, error) {
	if len(submitted) == 0 {
		return nil, nil
	}
	edited := make([]management.RequestScopedErrorRule, 0, len(submitted))
	for position, rule := range submitted {
		candidate := management.RequestScopedErrorRule{
			Status:     rule.Status,
			Match:      rule.Match,
			MatchRegex: rule.MatchRegex,
			Action:     rule.Action,
		}
		if position < len(stored) && stored[position].IsSameRule(candidate) {
			edited = append(edited, stored[position])
			continue
		}
		candidate.Action = strings.ToLower(strings.TrimSpace(rule.Action))
		rule.Action = candidate.Action
		if err := validateProviderErrorRule(position, rule); err != nil {
			return nil, err
		}
		edited = append(edited, candidate)
	}
	return edited, nil
}

// applyToConfigKey writes the submitted policy and behaviour onto a config
// API-key entry. isLegacyCoolingChecked is the single switch older clients
// send; it decides cooling only when no policy was submitted.
func (e providerPolicyEdit) applyToConfigKey(entry *management.ConfigAPIKey, isLegacyCoolingChecked bool) error {
	if e.policy == nil {
		entry.DisableCooling = editedDisableCooling(entry.DisableCooling, isLegacyCoolingChecked)
	} else {
		rules, err := editedErrorRules(entry.RequestScopedErrors, e.policy.ErrorRules)
		if err != nil {
			return err
		}
		entry.DisableCooling, _ = overrideValue(e.policy.Cooling)
		entry.RequestRetry = e.policy.RequestRetry
		entry.RequestScopedErrors = rules
	}
	if behavior := e.behavior; behavior != nil {
		if behavior.AlphaSearch != nil {
			entry.AlphaSearch = *behavior.AlphaSearch
		}
		if behavior.CodexCloaking != "" {
			entry.DisableCodexCloaking, _ = overrideValue(behavior.CodexCloaking)
		}
		if behavior.RebuildMidSystemMessage != nil {
			entry.RebuildMidSystemMessage = *behavior.RebuildMidSystemMessage
		}
	}
	return nil
}

// applyToOpenAICompatibility is applyToConfigKey for an OpenAI-compatible
// provider, whose policy lives on the provider rather than on a key.
func (e providerPolicyEdit) applyToOpenAICompatibility(entry *management.OpenAICompatibility, isLegacyCoolingChecked bool) error {
	if e.policy == nil {
		entry.DisableCooling = editedDisableCooling(entry.DisableCooling, isLegacyCoolingChecked)
	} else {
		rules, err := editedErrorRules(entry.RequestScopedErrors, e.policy.ErrorRules)
		if err != nil {
			return err
		}
		entry.DisableCooling, _ = overrideValue(e.policy.Cooling)
		entry.RequestRetry = e.policy.RequestRetry
		entry.RequestScopedErrors = rules
	}
	if e.behavior != nil && e.behavior.SupportPromptCacheKey != nil {
		entry.SupportPromptCacheKey = *e.behavior.SupportPromptCacheKey
	}
	return nil
}
