package management

import "strings"

// ExcludedAllPattern is CLIProxyAPI's own marker for "this config API-key
// credential serves nothing": a bare "*" in excluded-models. CPA itself uses
// this exact pattern when the auth-files status endpoint disables a
// codex/claude/gemini API-key credential, because those entries have no
// disabled field in the config schema. Reusing the same marker keeps OMC and
// CPA agree on what a disabled key means.
const ExcludedAllPattern = "*"

// IsExcludedAll reports whether the credential is disabled through the
// excluded-all marker.
func IsExcludedAll(models []string) bool {
	for _, model := range models {
		if strings.TrimSpace(model) == ExcludedAllPattern {
			return true
		}
	}
	return false
}

// SetExcludedAll adds or removes the excluded-all marker while preserving every
// operator-defined exclusion pattern, mirroring CPA's toggle semantics.
func SetExcludedAll(models []string, disable bool) []string {
	if disable {
		for _, model := range models {
			if strings.TrimSpace(model) == ExcludedAllPattern {
				return models
			}
		}
		return append(append([]string(nil), models...), ExcludedAllPattern)
	}
	filtered := make([]string, 0, len(models))
	for _, model := range models {
		if strings.TrimSpace(model) == ExcludedAllPattern {
			continue
		}
		filtered = append(filtered, model)
	}
	if len(filtered) == 0 {
		return nil
	}
	return filtered
}
