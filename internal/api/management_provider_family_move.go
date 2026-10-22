package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/management"
)

func (h *Handler) moveProviderFamily(ctx context.Context, client *management.Client, id, sourceFamily, targetFamily string, index int, req SaveProviderRequest, audit providerAudit) (map[string]any, error) {
	spec, isConfigFamily := lookupProviderConfigFamily(targetFamily)
	if targetFamily != openAICompatibilityFamily && !isConfigFamily {
		return nil, newProviderWriteError(http.StatusBadRequest, "unsupported provider family")
	}
	if spec.RequiresBaseURL && strings.TrimSpace(req.BaseURL) == "" {
		return nil, newProviderWriteError(http.StatusBadRequest, "base URL is required for this provider family")
	}
	website, isWebsiteProvided, isWebsiteValid := resolveProviderWebsite(req.Website)
	if !isWebsiteValid {
		return nil, newProviderWriteError(http.StatusBadRequest, "website must be an absolute http or https URL")
	}
	models, err := editedProviderModels(targetFamily, req)
	if err != nil {
		return nil, err
	}
	policy, err := resolveProviderPolicyEdit(targetFamily, req)
	if err != nil {
		return nil, err
	}
	details := map[string]any{"source_family": sourceFamily, "family": targetFamily}
	if err := audit("provider.update", "provider", id, "attempt", details); err != nil {
		return nil, newProviderWriteError(http.StatusInternalServerError, "audit failure; provider update aborted")
	}
	ids := []string{}
	err = gatedProviderListWrite(h, ctx,
		func(context.Context) (struct{}, error) { return struct{}{}, nil },
		func(ctx context.Context, _ struct{}) error {
			start, count, err := client.MoveProviderFamily(ctx, sourceFamily, targetFamily, index, func(source management.ProviderFamilyEntry) (management.ProviderFamilyEntry, error) {
				return convertProviderFamily(source, targetFamily, req, models, policy)
			})
			if errors.Is(err, management.ErrProviderNotFound) {
				return newProviderWriteError(http.StatusNotFound, err.Error())
			}
			if errors.Is(err, management.ErrProviderDestinationConflict) || errors.Is(err, management.ErrProviderSourceConflict) {
				return newProviderWriteError(http.StatusConflict, err.Error())
			}
			if err != nil {
				return err
			}
			for offset := 0; offset < count; offset++ {
				ids = append(ids, fmt.Sprintf("%s%d", idPrefixForFamily(targetFamily), start+offset))
			}
			return nil
		},
		func(*struct{}) error { return nil },
		func(ctx context.Context, _ struct{}) error {
			return h.moveProviderMetadata(ctx, id, ids, strings.TrimSpace(req.Name), website, isWebsiteProvided)
		})
	if err != nil {
		h.notifyPricingAfterPartialCommit(err)
		_ = audit("provider.update", "provider", id, "failure", details)
		return nil, err
	}
	_ = audit("provider.update", "provider", id, "success", details)
	if h.pricing != nil {
		h.pricing.NotifyModelsChanged()
	}
	return map[string]any{"status": "ok", "id": ids[0], "ids": ids, "family": targetFamily}, nil
}

func convertProviderFamily(source management.ProviderFamilyEntry, family string, req SaveProviderRequest, models []editedProviderModel, policy providerPolicyEdit) (management.ProviderFamilyEntry, error) {
	precondition := patchProviderStatusRequest{ExpectedName: req.ExpectedName, ExpectedAuthIndex: req.ExpectedAuthIndex}
	var defaults management.ConfigAPIKey
	var original []management.ConfigAPIKey
	overrides := map[string]map[string]any{}
	if source.Compatibility != nil {
		provider := source.Compatibility
		if err := precondition.verifyName(provider.Name); err != nil {
			return management.ProviderFamilyEntry{}, err
		}
		defaults = management.ConfigAPIKey{
			BaseURL: provider.BaseURL, Prefix: provider.Prefix, Priority: provider.Priority,
			Headers: provider.Headers, Models: provider.Models, DisableCooling: provider.DisableCooling,
			RequestRetry: provider.RequestRetry, RequestScopedErrors: provider.RequestScopedErrors,
		}
		for _, key := range provider.APIKeyEntries {
			data, err := json.Marshal(key)
			if err != nil {
				return management.ProviderFamilyEntry{}, err
			}
			var fields map[string]any
			if err := json.Unmarshal(data, &fields); err != nil {
				return management.ProviderFamilyEntry{}, err
			}
			overrides[key.APIKey] = fields
			merged := defaults
			merged.APIKey, merged.ProxyURL, merged.Weight = key.APIKey, key.ProxyURL, key.Weight
			original = append(original, merged)
		}
		for _, key := range provider.LegacyAPIKeys {
			merged := defaults
			merged.APIKey = key
			original = append(original, merged)
		}
	} else {
		defaults = source.Keys[0]
		if err := precondition.verifyAuthIndex(defaults.AuthIndex); err != nil {
			return management.ProviderFamilyEntry{}, err
		}
		original = source.Keys
	}
	keys := req.Keys
	if len(keys) == 0 {
		for _, key := range original {
			keys = append(keys, SaveProviderKeyEntry{APIKey: key.APIKey, ProxyURL: key.ProxyURL, Weight: key.Weight})
		}
		if req.APIKey != "" {
			keys = []SaveProviderKeyEntry{{APIKey: req.APIKey}}
		}
	}
	converted := make([]management.ConfigAPIKey, 0, len(keys))
	seen := map[string]bool{}
	for position, submitted := range keys {
		apiKey := strings.TrimSpace(submitted.APIKey)
		if apiKey == "" && position < len(original) {
			apiKey = original[position].APIKey
		}
		if apiKey == "" {
			return management.ProviderFamilyEntry{}, newProviderWriteErrorWithCode(http.StatusBadRequest, "every credential needs an API key when changing protocol", providerKeyRequiredCode)
		}
		if seen[apiKey] {
			return management.ProviderFamilyEntry{}, newProviderWriteErrorWithCode(http.StatusBadRequest, "duplicate API keys cannot be moved to another protocol", providerDuplicateKeyCode)
		}
		seen[apiKey] = true
		old := defaults
		for _, key := range original {
			if key.APIKey == apiKey {
				old = key
				break
			}
		}
		movedModels, err := moveProviderModels(old.Models, models, family)
		if err != nil {
			return management.ProviderFamilyEntry{}, err
		}
		// Cross-protocol writes carry the common schema, not unknown fields of
		// the old dialect. Replaying those fields would make CPA reject the file.
		key := management.ConfigAPIKey{
			APIKey: apiKey, BaseURL: strings.TrimSpace(req.BaseURL), ProxyURL: strings.TrimSpace(submitted.ProxyURL),
			Weight: submitted.Weight, Prefix: strings.TrimSpace(req.Prefix), Priority: req.Priority,
			Headers: req.Headers, Models: movedModels,
			ExcludedModels: management.SetExcludedAll(old.ExcludedModels, req.Disabled),
			DisableCooling: old.DisableCooling, RequestRetry: old.RequestRetry,
			RequestScopedErrors: old.RequestScopedErrors,
		}
		if !policy.capabilities.hasErrorRules {
			key.RequestScopedErrors = nil
		}
		if err := policy.applyToConfigKey(&key, req.DisableCooling); err != nil {
			return management.ProviderFamilyEntry{}, err
		}
		if fields := overrides[apiKey]; fields != nil {
			// Apply the original key's overrides after editing the shared fields,
			// as a same-family provider edit would. Credentials are set explicitly
			// afterwards because a submitted key row owns those three fields.
			data, err := json.Marshal(key)
			if err != nil {
				return management.ProviderFamilyEntry{}, err
			}
			var merged map[string]any
			if err := json.Unmarshal(data, &merged); err != nil {
				return management.ProviderFamilyEntry{}, err
			}
			for field, value := range fields {
				merged[field] = value
			}
			data, err = json.Marshal(merged)
			if err != nil {
				return management.ProviderFamilyEntry{}, err
			}
			var effective management.ConfigAPIKey
			if err := json.Unmarshal(data, &effective); err != nil {
				return management.ProviderFamilyEntry{}, err
			}
			key = commonProviderMoveKey(effective)
			key.APIKey, key.ProxyURL, key.Weight = apiKey, strings.TrimSpace(submitted.ProxyURL), submitted.Weight
			key.Models = supportedProviderMoveModels(key.Models, family)
			key.ExcludedModels = management.SetExcludedAll(key.ExcludedModels, req.Disabled || management.IsExcludedAll(key.ExcludedModels))
			if !policy.capabilities.hasErrorRules {
				key.RequestScopedErrors = nil
			}
			// The old dialect's switches were stripped with its unknown fields;
			// only the target behavior is reapplied, not the shared policy that
			// the key's explicit retry/cooling/error overrides just replaced.
			policy.applyBehaviorToConfigKey(&key)
		}
		converted = append(converted, key)
	}
	if len(converted) == 0 {
		return management.ProviderFamilyEntry{}, newProviderWriteErrorWithCode(http.StatusBadRequest, "an API key is required when changing protocol", providerKeyRequiredCode)
	}
	if family != openAICompatibilityFamily {
		return management.ProviderFamilyEntry{Keys: converted}, nil
	}
	first := converted[0]
	name := strings.TrimSpace(req.Name)
	if name == "" {
		name = "Custom Provider"
	}
	provider := &management.OpenAICompatibility{
		Name: name, BaseURL: first.BaseURL, Prefix: first.Prefix, Priority: first.Priority,
		Headers: first.Headers, Models: first.Models, DisableCooling: first.DisableCooling,
		RequestRetry: first.RequestRetry, RequestScopedErrors: first.RequestScopedErrors, Disabled: req.Disabled,
	}
	for _, key := range converted {
		// Shared settings belong to the provider. Repeating them on its keys
		// would pin stale overrides that future provider edits cannot change.
		fields := map[string]any{
			"api-key": key.APIKey, "proxy-url": key.ProxyURL, "weight": key.Weight,
		}
		if excluded := management.SetExcludedAll(key.ExcludedModels, false); len(excluded) > 0 {
			fields["excluded-models"] = excluded
		}
		data, err := json.Marshal(fields)
		if err != nil {
			return management.ProviderFamilyEntry{}, err
		}
		var entry management.APIKeyEntry
		if err := json.Unmarshal(data, &entry); err != nil {
			return management.ProviderFamilyEntry{}, err
		}
		provider.APIKeyEntries = append(provider.APIKeyEntries, entry)
	}
	if err := policy.applyToOpenAICompatibility(provider, req.DisableCooling); err != nil {
		return management.ProviderFamilyEntry{}, err
	}
	return management.ProviderFamilyEntry{Compatibility: provider}, nil
}

func commonProviderMoveKey(key management.ConfigAPIKey) management.ConfigAPIKey {
	return management.ConfigAPIKey{
		APIKey: key.APIKey, BaseURL: key.BaseURL, ProxyURL: key.ProxyURL, Weight: key.Weight,
		Prefix: key.Prefix, Priority: key.Priority, Headers: key.Headers, Models: key.Models,
		ExcludedModels: key.ExcludedModels, DisableCooling: key.DisableCooling,
		RequestRetry: key.RequestRetry, RequestScopedErrors: key.RequestScopedErrors,
	}
}

func moveProviderModels(stored []management.ModelAlias, edited []editedProviderModel, family string) ([]management.ModelAlias, error) {
	merged, err := mergeModelEdits(stored, edited)
	if err != nil {
		return nil, err
	}
	return supportedProviderMoveModels(merged, family), nil
}

func supportedProviderMoveModels(models []management.ModelAlias, family string) []management.ModelAlias {
	fields := providerModelOptionFieldsFor(family)
	for i, old := range models {
		model := management.ModelAlias{Name: old.Name, Alias: old.Alias, Thinking: old.Thinking, Image: family == openAICompatibilityFamily && old.Image}
		if options := providerModelOptionsDTO(old); options != nil {
			if !fields.hasOpenAPI {
				options.OpenAPI = nil
			}
			if !fields.hasMaxContextLength {
				options.MaxContextLength = 0
			}
			if !fields.hasIsCompat {
				options.IsCompat = false
			}
			if !fields.hasConfigurationUpdate {
				options.SupportConfigurationUpdate = false
			}
			if !fields.hasModalities {
				options.InputModalities = nil
				options.OutputModalities = nil
			}
			if !fields.hasMaxCompletionTokens {
				options.UseMaxCompletionTokens = false
			}
			options.applyTo(&model)
		}
		models[i] = model
	}
	return models
}
