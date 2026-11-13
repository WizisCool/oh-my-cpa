package quota

import (
	"regexp"
	"strings"

	"github.com/oh-my-cpa/oh-my-cpa/internal/usage"
)

var CLAUDE_FAMILY_PATTERN = regexp.MustCompile(`^claude-(?:(sonnet|opus|haiku)(?:-|$)|[0-9]+(?:[.-][0-9]+)*-(sonnet|opus|haiku)(?:-|$))`)

// ModelWindowUsage groups traffic by the best available upstream identity. A
// client alias without a served model is not evidence of its metered family.
type ModelWindowUsage struct {
	Model string
	Usage WindowUsage
}

func normalizeCapacityModel(model string) string {
	name := strings.ToLower(strings.TrimSpace(model))
	if strings.HasSuffix(name, ")") {
		if opening := strings.LastIndex(name, "("); opening > 0 {
			name = strings.TrimSpace(name[:opening])
		}
	}
	if slash := strings.LastIndex(name, "/"); slash >= 0 {
		switch name[:slash] {
		case "anthropic", "openai", "google", "google-vertex", "antigravity":
			name = name[slash+1:]
		default:
			return ""
		}
	}
	return name
}

func capacityModelFamily(model string) string {
	if matches := CLAUDE_FAMILY_PATTERN.FindStringSubmatch(model); matches != nil {
		if matches[1] != "" {
			return "claude-" + matches[1]
		}
		return "claude-" + matches[2]
	}
	for _, prefix := range []string{"gemini-", "gpt-", "fable-"} {
		if strings.HasPrefix(model, prefix) && len(model) > len(prefix) {
			return strings.TrimSuffix(prefix, "-")
		}
	}
	if model == "fable" {
		return "fable"
	}
	return ""
}

// AntigravityModelFamilies accepts only known, complete provider group names.
// A new or compound label must be reviewed rather than guessed from substrings.
func AntigravityModelFamilies(groupName string) []string {
	switch strings.ToLower(strings.TrimSpace(groupName)) {
	case "gemini models":
		return []string{"gemini"}
	case "claude and gpt models":
		return []string{"claude", "gpt"}
	case "gemini 3 pro":
		return []string{"gemini-3-pro"}
	case "gemini 3 flash":
		return []string{"gemini-3-flash"}
	case "gemini 4 argon":
		return []string{"gemini-4-argon"}
	}
	return nil
}

func windowModelFamilies(window QuotaWindow) []string {
	if len(window.ModelFamilies) > 0 {
		return window.ModelFamilies
	}
	// Older snapshots predate normalized family metadata; these provider window
	// ids already identify a whole Claude family, not one dated model release.
	switch window.ID {
	case "seven_day_sonnet":
		return []string{"claude-sonnet"}
	case "seven_day_opus":
		return []string{"claude-opus"}
	case "seven_day_fable":
		return []string{"fable"}
	}
	return nil
}

func isKnownCapacityFamily(family string) bool {
	switch family {
	case "claude", "claude-sonnet", "claude-opus", "claude-haiku", "gemini", "gemini-3-pro", "gemini-3-flash", "gemini-4-argon", "gpt", "fable":
		return true
	}
	return false
}

func matchWindowModelScope(window QuotaWindow, families []string, exactModel, rawModel string) (isMatch bool, isUnknownFamily bool) {
	model := normalizeCapacityModel(rawModel)
	family := capacityModelFamily(model)
	if len(families) == 0 {
		// Only harmless spelling differences are removed; fuzzy aliases never
		// expand an exact model's quota scope.
		isMatch = model != "" && !usage.IsModelSubstituted(exactModel, model)
	} else {
		for _, meteredFamily := range families {
			if family == meteredFamily || meteredFamily == "claude" && strings.HasPrefix(family, "claude-") || strings.HasPrefix(meteredFamily, "gemini-") && (model == meteredFamily || strings.HasPrefix(model, meteredFamily+"-")) {
				isMatch = true
			}
		}
	}
	return isMatch, !isMatch && family == ""
}

// SelectWindowUsage counts identified models and records unclassified traffic
// separately. A client alias must not erase useful evidence from served models,
// nor be silently assigned to a metered family.
func SelectWindowUsage(window QuotaWindow, groups []ModelWindowUsage) (WindowUsage, string) {
	var total WindowUsage
	families := windowModelFamilies(window)
	exactModel := normalizeCapacityModel(window.Model)
	if window.Scope == "group" && len(families) == 0 || window.Scope == "model" && len(families) == 0 && exactModel == "" {
		return total, CapacityReasonScopeUnknown
	}
	for _, family := range families {
		if !isKnownCapacityFamily(family) {
			return total, CapacityReasonScopeUnknown
		}
	}
	hasFirstTier := false
	hasFirstBounds := false
	hasAllBounds := true
	for _, group := range groups {
		isMatch, isUnknown := matchWindowModelScope(window, families, exactModel, group.Model)
		if isUnknown {
			total.UnmatchedRequests += group.Usage.Requests
		}
		if isMatch {
			total.Requests += group.Usage.Requests
			total.BreakdownRequests += group.Usage.BreakdownRequests
			total.PricedRequests += group.Usage.PricedRequests
			total.Tokens += group.Usage.Tokens
			total.PricedTokens += group.Usage.PricedTokens
			total.PromptTokens += group.Usage.PromptTokens
			total.CachedTokens += group.Usage.CachedTokens
			total.CacheWriteTokens += group.Usage.CacheWriteTokens
			total.OutputTokens += group.Usage.OutputTokens
			total.CostNanos += group.Usage.CostNanos
			if gMin, gMax, ok := group.Usage.inputBounds(); !ok {
				hasAllBounds = false
			} else if !hasFirstBounds {
				total.MinInputTokens, total.MaxInputTokens = gMin, gMax
				hasFirstBounds = true
			} else {
				total.MinInputTokens = min(total.MinInputTokens, gMin)
				total.MaxInputTokens = max(total.MaxInputTokens, gMax)
			}
			if group.Usage.HasMixedServiceTiers {
				total.HasMixedServiceTiers = true
				hasFirstTier = true
			} else if !hasFirstTier {
				total.ServiceTier = group.Usage.ServiceTier
				hasFirstTier = true
			} else if total.ServiceTier != group.Usage.ServiceTier {
				total.HasMixedServiceTiers = true
			}
		}
	}
	total.HasInputBounds = hasFirstBounds && hasAllBounds
	total.CacheRate = ComputeCacheRate(total.CachedTokens, total.PromptTokens)
	return total, ""
}

// IsModelInWindowScope reports whether a model name belongs to the quota pool
// that window meters.
func IsModelInWindowScope(window QuotaWindow, rawModel string) bool {
	name := strings.TrimSpace(rawModel)
	if name == "" || strings.EqualFold(name, "unknown") {
		return false
	}
	if window.Scope != "model" && window.Scope != "group" {
		return window.Scope == "standard"
	}
	families := windowModelFamilies(window)
	exactModel := normalizeCapacityModel(window.Model)
	if window.Scope == "group" && len(families) == 0 || window.Scope == "model" && len(families) == 0 && exactModel == "" {
		return false
	}
	for _, family := range families {
		if !isKnownCapacityFamily(family) {
			return false
		}
	}
	isMatch, _ := matchWindowModelScope(window, families, exactModel, name)
	return isMatch
}

// CanAffectWindowForecast reports whether a request for rawModel can change or
// obscure window's attribution. Known models outside a scoped window's pool do not.
func CanAffectWindowForecast(window QuotaWindow, rawModel string) bool {
	if capacityModelFamily(normalizeCapacityModel(rawModel)) == "" {
		return true
	}
	return IsModelInWindowScope(window, rawModel)
}
