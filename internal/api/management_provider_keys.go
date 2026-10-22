package api

import (
	"net/http"
	"strings"

	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/management"
)

// Config families expose one provider row per credential. A blank first key in
// an edit retains the stored secret; empty additional form rows carry no edit.
func editedConfigProviderKeys(req SaveProviderRequest, original management.ConfigAPIKey, isUpdate bool, models []editedProviderModel, policy providerPolicyEdit) ([]management.ConfigAPIKey, error) {
	submitted := req.Keys
	if len(submitted) == 0 {
		submitted = []SaveProviderKeyEntry{{APIKey: req.APIKey}}
	}
	mergedModels, err := mergeModelEdits(original.Models, models)
	if err != nil {
		return nil, err
	}
	keys := make([]management.ConfigAPIKey, 0, len(submitted))
	seen := map[string]bool{}
	for position, item := range submitted {
		apiKey := strings.TrimSpace(item.APIKey)
		if position == 0 && apiKey == "" {
			apiKey = strings.TrimSpace(req.APIKey)
			if apiKey == "" && isUpdate {
				apiKey = original.APIKey
			}
		}
		if apiKey == "" {
			continue
		}
		if seen[apiKey] {
			return nil, newProviderWriteErrorWithCode(http.StatusBadRequest, "duplicate API keys are not allowed", providerDuplicateKeyCode)
		}
		seen[apiKey] = true
		entry := original
		entry.APIKey = apiKey
		entry.BaseURL = original.SubmittedBaseURL(strings.TrimSpace(req.BaseURL))
		entry.ProxyURL = strings.TrimSpace(item.ProxyURL)
		entry.Weight = item.Weight
		entry.Prefix = strings.TrimSpace(req.Prefix)
		entry.Priority = req.Priority
		entry.Headers = req.Headers
		entry.Models = withoutImageFlag(mergedModels)
		entry.ExcludedModels = management.SetExcludedAll(original.ExcludedModels, req.Disabled)
		// New credentials must not inherit another key's runtime identity.
		if position > 0 || !isUpdate || apiKey != original.APIKey {
			entry.AuthIndex = ""
		}
		if err := policy.applyToConfigKey(&entry, req.DisableCooling); err != nil {
			return nil, err
		}
		keys = append(keys, entry)
	}
	if len(keys) == 0 {
		return nil, newProviderWriteErrorWithCode(http.StatusBadRequest, "an API key is required", providerKeyRequiredCode)
	}
	return keys, nil
}

// Refuse collisions before CPA normalizes its runtime list, otherwise a save
// could report positional ids for credentials CPA silently deduplicated.
func verifyConfigProviderKeys(existing, submitted []management.ConfigAPIKey, editedIndex int) error {
	for index, entry := range existing {
		if index == editedIndex {
			continue
		}
		for _, key := range submitted {
			if strings.TrimSpace(entry.APIKey) != strings.TrimSpace(key.APIKey) {
				continue
			}
			storedURL, newURL := strings.TrimSpace(entry.BaseURL), strings.TrimSpace(key.BaseURL)
			if storedURL == "" || newURL == "" || storedURL == newURL {
				return newProviderWriteErrorWithCode(http.StatusConflict, "this provider credential already exists", providerCredentialExistsCode)
			}
		}
	}
	return nil
}
