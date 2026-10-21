package management

import "strings"

// CredentialPolicyFieldsApplicable keeps target restrictions identical in previews and writes.
func CredentialPolicyFieldsApplicable(file AuthFile, fields map[string]any) bool {
	provider := strings.ToLower(strings.TrimSpace(file.Provider))
	if provider == "" {
		provider = strings.ToLower(strings.TrimSpace(file.Type))
	}
	if value, exists := fields["use_siwc"]; exists {
		if provider != "codex" {
			return false
		}
		if isEnabled, ok := value.(bool); ok && isEnabled && !file.SIWCBound {
			return false
		}
	}
	if aliases, ok := fields["model_aliases"].([]any); ok {
		for _, alias := range aliases {
			if entry, ok := alias.(map[string]any); ok {
				if value, exists := entry["openapi"]; exists && value != nil && provider != "vertex" {
					return false
				}
			}
		}
	}
	return true
}
