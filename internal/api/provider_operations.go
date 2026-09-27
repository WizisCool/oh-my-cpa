package api

import (
	"context"
	"fmt"
	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/management"
	"net/http"
	"strings"
)

type providerAudit func(action, targetType, targetID, result string, details map[string]any) error

func (h *Handler) createProvider(ctx context.Context, client *management.Client, req SaveProviderRequest, audit providerAudit) (map[string]any, error) {
	family := strings.ToLower(strings.TrimSpace(req.Family))
	if family == "" {
		family = openAICompatibilityFamily
	}
	name := strings.TrimSpace(req.Name)
	if name == "" {
		name = "Custom Provider"
	}
	baseURL := strings.TrimSpace(req.BaseURL)
	apiKey := strings.TrimSpace(req.APIKey)

	// Validated before any CPA write: refusing a bad scheme after the gateway had
	// already been changed would leave the console and CPA disagreeing.
	website, websiteProvided, isWebsiteValid := resolveProviderWebsite(req.Website)
	if !isWebsiteValid {
		return nil, newProviderWriteError(http.StatusBadRequest, "website must be an absolute http or https URL")
	}

	models := make([]management.ModelAlias, 0)
	if len(req.ModelEntries) > 0 {
		for _, m := range req.ModelEntries {
			mName := strings.TrimSpace(m.Name)
			if mName != "" {
				alias := strings.TrimSpace(m.Alias)
				if alias == "" {
					alias = mName
				}
				var thinking *management.ThinkingSupport
				if m.Thinking != nil && len(m.Thinking.Levels) > 0 {
					thinking = &management.ThinkingSupport{Levels: m.Thinking.Levels}
				}
				models = append(models, management.ModelAlias{
					Name:     mName,
					Alias:    alias,
					Image:    m.Image,
					Thinking: thinking,
				})
			}
		}
	} else {
		for _, m := range req.Models {
			m = strings.TrimSpace(m)
			if m != "" {
				models = append(models, management.ModelAlias{Name: m, Alias: m})
			}
		}
	}

	firstKey := apiKey
	firstProxy := ""
	var firstWeight *int
	if len(req.Keys) > 0 {
		if kVal := strings.TrimSpace(req.Keys[0].APIKey); kVal != "" {
			firstKey = kVal
		}
		firstProxy = strings.TrimSpace(req.Keys[0].ProxyURL)
		firstWeight = req.Keys[0].Weight
	}

	var disableCoolingPtr *bool
	if req.DisableCooling {
		t := true
		disableCoolingPtr = &t
	}

	if auditErr := audit("provider.create", "provider", family, "attempt", map[string]any{"name": name}); auditErr != nil {
		return nil, newProviderWriteError(http.StatusInternalServerError, "audit failure; provider creation aborted")
	}

	// The created row's positional id, so the response can name the provider it
	// just added. The console needs it to key the icon it stored for this row:
	// positions are assigned here, and a browser that only knew the display name
	// would key an override the row's own id key could then shadow.
	createdID := ""

	switch family {
	case openAICompatibilityFamily:
		newEntry := management.OpenAICompatibility{
			Name:           name,
			BaseURL:        baseURL,
			Prefix:         strings.TrimSpace(req.Prefix),
			Priority:       req.Priority,
			DisableCooling: req.DisableCooling,
			Disabled:       req.Disabled,
			Models:         models,
			Headers:        req.Headers,
		}
		if len(req.Keys) > 0 {
			for _, k := range req.Keys {
				if strings.TrimSpace(k.APIKey) != "" {
					newEntry.APIKeyEntries = append(newEntry.APIKeyEntries, management.APIKeyEntry{
						APIKey:   strings.TrimSpace(k.APIKey),
						ProxyURL: strings.TrimSpace(k.ProxyURL),
						Weight:   k.Weight,
					})
				}
			}
		} else if apiKey != "" {
			newEntry.APIKeyEntries = []management.APIKeyEntry{{APIKey: apiKey}}
		}
		_, err := h.appendOpenAICompatibilityGated(ctx, client, newEntry, func(ctx context.Context, entries []management.OpenAICompatibility) error {
			targetID := fmt.Sprintf("%s%d", openAICompatIDPrefix, len(entries)-1)
			createdID = targetID
			return h.applyProviderMetadata(ctx, targetID, name, website, websiteProvided)
		})
		if err != nil {
			h.notifyPricingAfterPartialCommit(err)
			_ = audit("provider.create", "provider", family, "failure", map[string]any{"error": err.Error()})
			return nil, err
		}

	default:
		// Every other supported family is a config API-key list, which the registry
		// describes. The entry body is identical across them.
		spec, isConfigFamily := lookupProviderConfigFamily(family)
		if !isConfigFamily {
			return nil, newProviderWriteError(http.StatusBadRequest, "unsupported provider family: "+family)
		}
		newEntry := management.ConfigAPIKey{
			APIKey:         firstKey,
			BaseURL:        baseURL,
			ProxyURL:       firstProxy,
			Prefix:         strings.TrimSpace(req.Prefix),
			Priority:       req.Priority,
			Weight:         firstWeight,
			Headers:        req.Headers,
			Models:         models,
			DisableCooling: disableCoolingPtr,
		}
		_, err := h.appendConfigKeyProvider(ctx, client, spec, newEntry, func(ctx context.Context, entries []management.ConfigAPIKey) error {
			targetID := fmt.Sprintf("%s%d", spec.IDPrefix, len(entries)-1)
			createdID = targetID
			return h.applyProviderMetadata(ctx, targetID, name, website, websiteProvided)
		})
		if err != nil {
			h.notifyPricingAfterPartialCommit(err)
			_ = audit("provider.create", "provider", family, "failure", map[string]any{"error": err.Error()})
			return nil, err
		}
	}

	_ = audit("provider.create", "provider", family, "success", map[string]any{"name": name})

	if h.pricing != nil {
		h.pricing.NotifyModelsChanged()
	}

	return map[string]any{
		"status": "ok",
		"family": family,
		"id":     createdID,
	}, nil
}

func (h *Handler) updateProvider(ctx context.Context, client *management.Client, id string, req SaveProviderRequest, audit providerAudit) (map[string]any, error) {
	family, index, err := parseProviderID(id)
	if err != nil || index < 0 {
		return nil, newProviderWriteError(400, "invalid provider id")
	}
	name := strings.TrimSpace(req.Name)
	baseURL := strings.TrimSpace(req.BaseURL)
	apiKey := strings.TrimSpace(req.APIKey)

	// Validated before any CPA write: refusing a bad scheme after the gateway had
	// already changed would leave the console and CPA disagreeing.
	website, websiteProvided, isWebsiteValid := resolveProviderWebsite(req.Website)
	if !isWebsiteValid {
		return nil, newProviderWriteError(http.StatusBadRequest, "website must be an absolute http or https URL")
	}

	models := make([]management.ModelAlias, 0)
	if len(req.ModelEntries) > 0 {
		for _, m := range req.ModelEntries {
			mName := strings.TrimSpace(m.Name)
			if mName != "" {
				alias := strings.TrimSpace(m.Alias)
				if alias == "" {
					alias = mName
				}
				var thinking *management.ThinkingSupport
				if m.Thinking != nil && len(m.Thinking.Levels) > 0 {
					thinking = &management.ThinkingSupport{Levels: m.Thinking.Levels}
				}
				models = append(models, management.ModelAlias{
					Name:     mName,
					Alias:    alias,
					Image:    m.Image,
					Thinking: thinking,
				})
			}
		}
	} else {
		for _, m := range req.Models {
			m = strings.TrimSpace(m)
			if m != "" {
				models = append(models, management.ModelAlias{Name: m, Alias: m})
			}
		}
	}

	firstKey := apiKey
	firstProxy := ""
	var firstWeight *int
	if len(req.Keys) > 0 {
		if kVal := strings.TrimSpace(req.Keys[0].APIKey); kVal != "" {
			firstKey = kVal
		}
		firstProxy = strings.TrimSpace(req.Keys[0].ProxyURL)
		firstWeight = req.Keys[0].Weight
	}

	var disableCoolingPtr *bool
	if req.DisableCooling {
		t := true
		disableCoolingPtr = &t
	}

	if auditErr := audit("provider.update", "provider", id, "attempt", map[string]any{"name": name}); auditErr != nil {
		return nil, newProviderWriteError(http.StatusInternalServerError, "audit failure; provider update aborted")
	}

	// The operator's own overlays are written only by the branches below, once the
	// gateway has accepted the write. The row, the request list's provider label
	// and the name resolver all read these maps, so an overlay recorded ahead of a
	// refused write would leave this console naming a provider CPA never accepted.
	switch family {
	case openAICompatibilityFamily:
		if err := gatedProviderListWrite(h, ctx,
			func(ctx context.Context) ([]management.OpenAICompatibility, error) {
				resp, err := client.OpenAICompatibility(ctx)
				if err != nil {
					return nil, err
				}
				return resp.Entries, nil
			},
			func(ctx context.Context, list []management.OpenAICompatibility) error {
				return client.UpdateOpenAICompatibility(ctx, list)
			},
			func(list *[]management.OpenAICompatibility) error {
				if index >= len(*list) {
					return newProviderWriteError(http.StatusNotFound, "provider index out of bounds")
				}
				entry := &(*list)[index]
				if name != "" {
					entry.Name = name
				}
				entry.BaseURL = baseURL
				entry.Prefix = strings.TrimSpace(req.Prefix)
				entry.Priority = req.Priority
				entry.DisableCooling = req.DisableCooling
				entry.Disabled = req.Disabled
				entry.Models = models
				entry.Headers = req.Headers

				if len(req.Keys) > 0 {
					updatedKeys := make([]management.APIKeyEntry, 0, len(req.Keys))
					for ki, k := range req.Keys {
						kVal := strings.TrimSpace(k.APIKey)
						if kVal == "" {
							if ki < len(entry.APIKeyEntries) {
								kVal = entry.APIKeyEntries[ki].APIKey
							} else if ki < len(entry.LegacyAPIKeys) {
								kVal = entry.LegacyAPIKeys[ki]
							}
						}
						if kVal != "" {
							updatedKeys = append(updatedKeys, management.APIKeyEntry{
								APIKey:   kVal,
								ProxyURL: strings.TrimSpace(k.ProxyURL),
								Weight:   k.Weight,
							})
						}
					}
					entry.APIKeyEntries = updatedKeys
					entry.LegacyAPIKeys = nil
				} else if apiKey != "" {
					entry.APIKeyEntries = []management.APIKeyEntry{{APIKey: apiKey}}
					entry.LegacyAPIKeys = nil
				}
				return nil
			},
			func(ctx context.Context, _ []management.OpenAICompatibility) error {
				return h.applyProviderMetadata(ctx, id, name, website, websiteProvided)
			}); err != nil {
			h.notifyPricingAfterPartialCommit(err)
			_ = audit("provider.update", "provider", id, "failure", map[string]any{"error": err.Error()})
			return nil, err
		}
	default:
		spec, isConfigFamily := lookupProviderConfigFamily(family)
		if !isConfigFamily {
			return nil, newProviderWriteError(http.StatusBadRequest, "unsupported provider family")
		}
		if err := h.mutateConfigKeyProvider(ctx, client, spec, index, func(entry *management.ConfigAPIKey) {
			entry.BaseURL = baseURL
			if firstKey != "" {
				entry.APIKey = firstKey
			}
			entry.ProxyURL = firstProxy
			entry.Prefix = strings.TrimSpace(req.Prefix)
			entry.Priority = req.Priority
			entry.Weight = firstWeight
			entry.Models = models
			entry.Headers = req.Headers
			entry.DisableCooling = disableCoolingPtr
		}, func(ctx context.Context, _ []management.ConfigAPIKey) error {
			return h.applyProviderMetadata(ctx, id, name, website, websiteProvided)
		}); err != nil {
			h.notifyPricingAfterPartialCommit(err)
			_ = audit("provider.update", "provider", id, "failure", map[string]any{"error": err.Error()})
			return nil, err
		}
	}

	_ = audit("provider.update", "provider", id, "success", map[string]any{"name": name})

	if h.pricing != nil {
		h.pricing.NotifyModelsChanged()
	}

	return map[string]any{
		"status": "ok",
		"id":     id,
	}, nil
}

func (h *Handler) deleteProvider(ctx context.Context, client *management.Client, id string, audit providerAudit) (map[string]any, error) {
	family, index, err := parseProviderID(id)
	if err != nil || index < 0 {
		return nil, newProviderWriteError(400, "invalid provider id")
	}
	if auditErr := audit("provider.delete", "provider", id, "attempt", nil); auditErr != nil {
		return nil, newProviderWriteError(http.StatusInternalServerError, "audit failure; provider deletion aborted")
	}

	// The deleted row's own metadata is dropped, and every later row's metadata
	// moves down with it: the overlay is keyed by the same positional id the row is
	// addressed by, so leaving the keys alone would relabel the credentials that
	// took the freed index. The icon overlay rides along with the name and website
	// maps for the same reason. The callback runs inside the admitted write, so a
	// second delete cannot re-key the maps while this one is still shifting them.
	switch family {
	case openAICompatibilityFamily:
		if err := gatedProviderListWrite(h, ctx,
			func(ctx context.Context) ([]management.OpenAICompatibility, error) {
				resp, err := client.OpenAICompatibility(ctx)
				if err != nil {
					return nil, err
				}
				return resp.Entries, nil
			},
			func(ctx context.Context, list []management.OpenAICompatibility) error {
				return client.UpdateOpenAICompatibility(ctx, list)
			},
			func(list *[]management.OpenAICompatibility) error {
				if index >= len(*list) {
					return newProviderWriteError(http.StatusNotFound, "provider index out of bounds")
				}
				*list = append(append([]management.OpenAICompatibility{}, (*list)[:index]...), (*list)[index+1:]...)
				return nil
			},
			func(ctx context.Context, _ []management.OpenAICompatibility) error {
				return h.shiftProviderMetadataAfterDelete(ctx, idPrefixForFamily(family), index)
			}); err != nil {
			h.notifyPricingAfterPartialCommit(err)
			_ = audit("provider.delete", "provider", id, "failure", map[string]any{"error": err.Error()})
			return nil, err
		}
	default:
		spec, isConfigFamily := lookupProviderConfigFamily(family)
		if !isConfigFamily {
			return nil, newProviderWriteError(http.StatusBadRequest, "unsupported provider family")
		}
		if err := h.deleteConfigKeyProvider(ctx, client, spec, index, func(ctx context.Context, _ []management.ConfigAPIKey) error {
			return h.shiftProviderMetadataAfterDelete(ctx, idPrefixForFamily(family), index)
		}); err != nil {
			h.notifyPricingAfterPartialCommit(err)
			_ = audit("provider.delete", "provider", id, "failure", map[string]any{"error": err.Error()})
			return nil, err
		}
	}

	_ = audit("provider.delete", "provider", id, "success", nil)

	if h.pricing != nil {
		h.pricing.NotifyModelsChanged()
	}

	return map[string]any{
		"status":  "ok",
		"deleted": id,
	}, nil
}
