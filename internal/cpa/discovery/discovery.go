package discovery

import (
	"context"
	"fmt"
	"net/url"
	"regexp"
	"sort"
	"strings"

	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/management"
	"github.com/oh-my-cpa/oh-my-cpa/internal/crypto"
	"github.com/oh-my-cpa/oh-my-cpa/internal/domain"
)

type Discoverer struct {
	cipher *crypto.Cipher
}

func NewDiscoverer(cipher *crypto.Cipher) *Discoverer {
	return &Discoverer{cipher: cipher}
}

func (d *Discoverer) Discover(ctx context.Context, client *management.Client, instanceID string) ([]domain.DiscoveredResource, []string, error) {
	if d == nil || d.cipher == nil {
		return nil, nil, fmt.Errorf("discoverer is not initialized")
	}
	if client == nil {
		return nil, nil, fmt.Errorf("CPA client is required")
	}
	var errorsFound []string
	resources := make([]domain.DiscoveredResource, 0)
	if response, err := client.AuthFiles(ctx); err != nil {
		errorsFound = append(errorsFound, "auth-files: "+err.Error())
	} else {
		for _, file := range response.Files {
			resource, err := d.fromAuthFile(instanceID, file)
			if err != nil {
				errorsFound = append(errorsFound, "auth-file: "+err.Error())
				continue
			}
			resources = append(resources, resource)
		}
	}
	if response, err := client.CodexAPIKeys(ctx); err != nil {
		errorsFound = append(errorsFound, "codex-api-key: "+err.Error())
	} else {
		for index, entry := range response.Entries {
			resource, err := d.fromCodexAPIKey(instanceID, index, entry)
			if err != nil {
				errorsFound = append(errorsFound, "codex-api-key: "+err.Error())
				continue
			}
			resources = append(resources, resource)
		}
	}
	if response, err := client.OpenAICompatibility(ctx); err != nil {
		errorsFound = append(errorsFound, "openai-compatibility: "+err.Error())
	} else {
		for index, provider := range response.Entries {
			providerResources, err := d.fromOpenAICompatibility(instanceID, index, provider)
			if err != nil {
				errorsFound = append(errorsFound, "openai-compatibility: "+err.Error())
				continue
			}
			resources = append(resources, providerResources...)
		}
	}
	if len(resources) == 0 && len(errorsFound) > 0 {
		return nil, errorsFound, fmt.Errorf("all CPA discovery endpoints failed")
	}
	// Stable ordering makes discovery output and test fixtures deterministic.
	sort.Slice(resources, func(i, j int) bool {
		return resources[i].ResourceKey < resources[j].ResourceKey
	})
	return resources, errorsFound, nil
}

func (d *Discoverer) fromAuthFile(instanceID string, file management.AuthFile) (domain.DiscoveredResource, error) {
	provider := normalizeDriver(file.Provider)
	identity := []string{"auth-file", file.AuthIndex, file.ID, file.Name, file.Provider, file.Email, file.Account}
	key, err := d.resourceKey(instanceID, file.AuthIndex, identity...)
	if err != nil {
		return domain.DiscoveredResource{}, err
	}
	models := make([]string, 0, len(file.Models))
	for _, model := range file.Models {
		if model.ID != "" {
			models = append(models, model.ID)
		}
	}
	return domain.DiscoveredResource{
		InstanceID:      instanceID,
		ResourceKey:     key,
		CPAResourceType: "auth-file",
		CPAAuthIndex:    strings.TrimSpace(file.AuthIndex),
		CPAResourceName: strings.TrimSpace(file.Name),
		CPADriver:       provider,
		ProtocolDriver:  protocolForDriver(provider),
		ProtocolDisplay: protocolDisplayForDriver(provider),
		SuggestedSource: sourceSuggestion(file.Provider, ""),
		Status:          domain.ResourceStatusUnclaimed,
		Details: domain.ResourceDetails{
			Models:      models,
			AuthType:    "oauth",
			Email:       file.Email,
			SourceFile:  file.Name,
			Disabled:    file.Disabled,
			Unavailable: file.Unavailable,
			Extra:       map[string]string{"account": file.Account, "account_type": file.AccountType, "label": file.Label, "status": file.Status, "status_message": file.StatusMessage, "source": file.Source},
		},
	}, nil
}

func (d *Discoverer) fromCodexAPIKey(instanceID string, index int, entry management.CodexAPIKey) (domain.DiscoveredResource, error) {
	identity := []string{"codex-api-key", entry.AuthIndex, normalizeURL(entry.BaseURL), entry.Prefix, fmt.Sprintf("%d", index)}
	key, err := d.resourceKey(instanceID, entry.AuthIndex, identity...)
	if err != nil {
		return domain.DiscoveredResource{}, err
	}
	baseURL := strings.TrimSpace(entry.BaseURL)
	return domain.DiscoveredResource{
		InstanceID:      instanceID,
		ResourceKey:     key,
		CPAResourceType: "codex-api-key",
		CPAAuthIndex:    strings.TrimSpace(entry.AuthIndex),
		CPADriver:       "codex",
		ProtocolDriver:  "openai_responses",
		ProtocolDisplay: "OpenAI Responses",
		BaseURL:         baseURL,
		SuggestedSource: sourceSuggestion("", baseURL),
		Status:          domain.ResourceStatusUnclaimed,
		Details: domain.ResourceDetails{
			Models:   modelNames(entry.Models),
			AuthType: "api_key",
			Priority: entry.Priority,
			Prefix:   entry.Prefix,
			Extra:    map[string]string{"index": fmt.Sprintf("%d", index), "proxy_url": entry.ProxyURL, "api_key_present": fmt.Sprintf("%t", strings.TrimSpace(entry.APIKey) != "")},
		},
	}, nil
}

func (d *Discoverer) fromOpenAICompatibility(instanceID string, index int, provider management.OpenAICompatibility) ([]domain.DiscoveredResource, error) {
	base := strings.TrimSpace(provider.BaseURL)
	entries := provider.APIKeyEntries
	if len(entries) == 0 && len(provider.LegacyAPIKeys) > 0 {
		entries = make([]management.APIKeyEntry, 0, len(provider.LegacyAPIKeys))
		for _, key := range provider.LegacyAPIKeys {
			entries = append(entries, management.APIKeyEntry{APIKey: key})
		}
	}
	if len(entries) == 0 {
		entries = []management.APIKeyEntry{{}}
	}
	resources := make([]domain.DiscoveredResource, 0, len(entries))
	for keyIndex, entry := range entries {
		identity := []string{"openai-compatibility", provider.Name, normalizeURL(base), entry.AuthIndex, fmt.Sprintf("%d", index), fmt.Sprintf("%d", keyIndex)}
		resourceKey, err := d.resourceKey(instanceID, entry.AuthIndex, identity...)
		if err != nil {
			return nil, err
		}
		resources = append(resources, domain.DiscoveredResource{
			InstanceID:      instanceID,
			ResourceKey:     resourceKey,
			CPAResourceType: "openai-compatibility",
			CPAAuthIndex:    strings.TrimSpace(entry.AuthIndex),
			CPAResourceName: strings.TrimSpace(provider.Name),
			CPADriver:       "openai-compatibility",
			ProtocolDriver:  "openai_chat_completions",
			ProtocolDisplay: "OpenAI Chat Completions",
			BaseURL:         base,
			SuggestedSource: sourceSuggestion(provider.Name, base),
			Status:          domain.ResourceStatusUnclaimed,
			Details: domain.ResourceDetails{
				Models:   modelNames(provider.Models),
				AuthType: "api_key",
				Disabled: provider.Disabled,
				Extra:    map[string]string{"provider": provider.Name, "index": fmt.Sprintf("%d", index), "key_index": fmt.Sprintf("%d", keyIndex), "proxy_url": entry.ProxyURL, "api_key_present": fmt.Sprintf("%t", strings.TrimSpace(entry.APIKey) != "")},
			},
		})
	}
	return resources, nil
}

func (d *Discoverer) resourceKey(instanceID string, authIndex string, identity ...string) (string, error) {
	if authIndex = strings.TrimSpace(authIndex); authIndex != "" {
		// CPA documents auth_index as a stable runtime credential identifier.
		// Keep the CPA resource family in the key too: an auth index can be
		// surfaced by more than one management collection.
		family := "resource"
		if len(identity) > 0 && strings.TrimSpace(identity[0]) != "" {
			family = strings.TrimSpace(identity[0])
		}
		return "auth-index:" + family + ":" + authIndex, nil
	}
	parts := append([]string{instanceID}, identity...)
	return d.cipher.Fingerprint(normalizeIdentityParts(parts)...)
}

func normalizeIdentityParts(parts []string) []string {
	result := make([]string, len(parts))
	for index, part := range parts {
		result[index] = strings.ToLower(strings.TrimSpace(part))
	}
	return result
}

func modelNames(models []management.ModelAlias) []string {
	result := make([]string, 0, len(models))
	for _, model := range models {
		if name := firstNonEmpty(model.Alias, model.Name); name != "" {
			result = append(result, name)
		}
	}
	return result
}

func protocolForDriver(driver string) string {
	switch normalizeDriver(driver) {
	case "codex", "openai":
		return "openai_responses"
	case "claude", "anthropic":
		return "anthropic_messages"
	case "gemini":
		return "gemini_generate_content"
	default:
		return "custom"
	}
}

func protocolDisplayForDriver(driver string) string {
	switch normalizeDriver(driver) {
	case "codex", "openai":
		return "OpenAI Responses"
	case "claude", "anthropic":
		return "Anthropic Messages"
	case "gemini":
		return "Gemini Generate Content"
	default:
		return "Unknown protocol"
	}
}

func normalizeDriver(value string) string {
	return strings.ToLower(strings.TrimSpace(value))
}

func normalizeURL(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return ""
	}
	parsed, err := url.Parse(value)
	if err != nil {
		return strings.TrimRight(strings.ToLower(value), "/")
	}
	parsed.Scheme = strings.ToLower(parsed.Scheme)
	parsed.Host = strings.ToLower(parsed.Host)
	parsed.Path = strings.TrimRight(parsed.Path, "/")
	return strings.TrimRight(parsed.String(), "/")
}

var nonAlphaNumeric = regexp.MustCompile(`[^a-z0-9.-]+`)

func sourceSuggestion(name, baseURL string) string {
	candidate := strings.ToLower(strings.TrimSpace(name))
	host := ""
	if parsed, err := url.Parse(strings.TrimSpace(baseURL)); err == nil {
		host = strings.ToLower(parsed.Hostname())
	}
	combined := candidate + " " + host
	switch {
	case strings.Contains(combined, "deepseek"):
		return "DeepSeek"
	case strings.Contains(combined, "openai") || strings.Contains(combined, "chatgpt"):
		return "OpenAI"
	case strings.Contains(combined, "goat"):
		return "Command Code GOAT"
	case strings.Contains(combined, "opencode"):
		return "OpenCode Go"
	case strings.Contains(combined, "anthropic") || strings.Contains(combined, "claude"):
		return "Anthropic / Claude"
	case strings.Contains(combined, "gemini") || strings.Contains(combined, "google"):
		return "Google Gemini"
	case host != "":
		return nonAlphaNumeric.ReplaceAllString(host, " ")
	case name != "":
		return strings.TrimSpace(name)
	default:
		return "未知来源"
	}
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return "Unnamed CPA resource"
}
