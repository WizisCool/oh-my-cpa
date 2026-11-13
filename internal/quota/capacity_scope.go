package quota

import (
	"regexp"
	"strings"

	"github.com/oh-my-cpa/oh-my-cpa/internal/usage"
)

var CLAUDE_FAMILY_PATTERN = regexp.MustCompile(`^claude-(?:(sonnet|opus|haiku|fable|mythos)(?:-|$)|[0-9]+(?:[.-][0-9]+)*-(sonnet|opus|haiku|fable|mythos)(?:-|$))`)

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
	if model == "o1" || model == "o3" || model == "o4" || strings.HasPrefix(model, "o1-") || strings.HasPrefix(model, "o3-") || strings.HasPrefix(model, "o4-") {
		return "openai-o"
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
	case "claude", "claude-sonnet", "claude-opus", "claude-haiku", "claude-fable", "claude-mythos", "gemini", "gemini-3-pro", "gemini-3-flash", "gemini-4-argon", "gpt", "openai-o", "fable":
		return true
	}
	return false
}

func matchWindowModelScope(families []string, exactModel, rawModel string) (isMatch bool, isUnknownFamily bool) {
	model := normalizeCapacityModel(rawModel)
	family := capacityModelFamily(model)
	if len(families) == 0 {
		// Only harmless spelling differences are removed; fuzzy aliases never
		// expand an exact model's quota scope.
		isMatch = model != "" && !usage.IsModelSubstituted(exactModel, model)
	} else {
		for _, meteredFamily := range families {
			if family == meteredFamily ||
				meteredFamily == "claude" && strings.HasPrefix(family, "claude-") ||
				meteredFamily == "gpt" && family == "openai-o" ||
				meteredFamily == "fable" && family == "claude-fable" ||
				strings.HasPrefix(meteredFamily, "gemini-") && (model == meteredFamily || strings.HasPrefix(model, meteredFamily+"-")) {
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
	for _, group := range groups {
		isMatch, isUnknown := matchWindowModelScope(families, exactModel, group.Model)
		if isUnknown {
			total.UnmatchedRequests += group.Usage.Requests
		}
		if isMatch {
			total.Requests += group.Usage.Requests
			total.PricedRequests += group.Usage.PricedRequests
			total.Tokens += group.Usage.Tokens
			total.PromptTokens += group.Usage.PromptTokens
			total.CachedTokens += group.Usage.CachedTokens
			total.CostNanos += group.Usage.CostNanos
		}
	}
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
	isMatch, _ := matchWindowModelScope(families, exactModel, name)
	return isMatch
}
