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
	case "claude", "claude-sonnet", "claude-opus", "claude-haiku", "gemini", "gemini-3-pro", "gemini-3-flash", "gpt", "fable":
		return true
	}
	return false
}

// SelectWindowUsage refuses the whole scoped numerator if any recorded model
// cannot be classified. Counting only recognizable names would silently omit
// an alias that may spend this very window's quota.
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
		model := normalizeCapacityModel(group.Model)
		family := capacityModelFamily(model)
		isMatch := false
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
		if !isMatch && family == "" {
			return WindowUsage{}, CapacityReasonScopeUnknown
		}
		if isMatch {
			total.Requests += group.Usage.Requests
			total.PricedRequests += group.Usage.PricedRequests
			total.Tokens += group.Usage.Tokens
			total.CostNanos += group.Usage.CostNanos
		}
	}
	return total, ""
}
