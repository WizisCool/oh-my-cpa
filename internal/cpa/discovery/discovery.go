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
	"github.com/oh-my-cpa/oh-my-cpa/internal/security"
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
	// Account is a credential-bearing CPA field. Identity is deliberately built
	// from CPA identifiers and descriptive metadata only.
	identity := []string{"auth-file", file.ID, file.Name, file.Provider, file.Email}
	key, err := d.resolveResourceKey(instanceID, "auth-file", file.AuthIndex, "", identity...)
	if err != nil {
		return domain.DiscoveredResource{}, err
	}
	models := make([]string, 0, len(file.Models))
	for _, model := range file.Models {
		if model.ID != "" {
			models = append(models, model.ID)
		}
	}
	extra := map[string]string{
		"account_present": fmt.Sprintf("%t", strings.TrimSpace(file.Account) != ""),
		"account_type":    safeAccountType(file.AccountType),
	}
	if strings.TrimSpace(file.AuthIndex) == "" {
		extra["identity_collision"] = "true"
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
			Email:       safeDisplayText(file.Email, 256),
			SourceFile:  safeDisplayText(file.Name, 256),
			Disabled:    file.Disabled,
			Unavailable: file.Unavailable,
			Extra:       omitEmptyExtra(extra),
		},
	}, nil
}

func (d *Discoverer) fromCodexAPIKey(instanceID string, index int, entry management.CodexAPIKey) (domain.DiscoveredResource, error) {
	_ = index // CPA array positions are not identity.
	baseURL := publicURL(entry.BaseURL)
	key, err := d.resolveResourceKey(instanceID, "codex-api-key", entry.AuthIndex, entry.APIKey, baseURL, safeDisplayText(entry.Prefix, 128))
	if err != nil {
		return domain.DiscoveredResource{}, err
	}
	extra := map[string]string{
		"proxy_configured": fmt.Sprintf("%t", strings.TrimSpace(entry.ProxyURL) != ""),
		"api_key_present":  fmt.Sprintf("%t", strings.TrimSpace(entry.APIKey) != ""),
	}
	if strings.TrimSpace(entry.AuthIndex) == "" && strings.TrimSpace(entry.APIKey) == "" {
		extra["identity_collision"] = "true"
	}
	var priorityVal int
	if entry.Priority != nil {
		priorityVal = *entry.Priority
	}
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
			Priority: priorityVal,
			Prefix:   safeDisplayText(entry.Prefix, 128),
			Extra:    omitEmptyExtra(extra),
		},
	}, nil
}

func (d *Discoverer) fromOpenAICompatibility(instanceID string, index int, provider management.OpenAICompatibility) ([]domain.DiscoveredResource, error) {
	_ = index // Provider ordering is not identity.
	base := publicURL(provider.BaseURL)
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
	for _, entry := range entries {
		resourceKey, err := d.resolveResourceKey(instanceID, "openai-compatibility", entry.AuthIndex, entry.APIKey, provider.Name, base)
		if err != nil {
			return nil, err
		}
		extra := map[string]string{
			"provider":         safeDisplayText(provider.Name, 256),
			"proxy_configured": fmt.Sprintf("%t", strings.TrimSpace(entry.ProxyURL) != ""),
			"api_key_present":  fmt.Sprintf("%t", strings.TrimSpace(entry.APIKey) != ""),
		}
		if strings.TrimSpace(entry.AuthIndex) == "" && strings.TrimSpace(entry.APIKey) == "" {
			extra["identity_collision"] = "true"
		}
		resources = append(resources, domain.DiscoveredResource{
			InstanceID:      instanceID,
			ResourceKey:     resourceKey,
			CPAResourceType: "openai-compatibility",
			CPAAuthIndex:    strings.TrimSpace(entry.AuthIndex),
			CPAResourceName: safeDisplayText(provider.Name, 256),
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
				Extra:    omitEmptyExtra(extra),
			},
		})
	}
	return resources, nil
}

func (d *Discoverer) resolveResourceKey(instanceID, family, authIndex, apiKey string, metadata ...string) (string, error) {
	// Level 1 & 2: Stable family-scoped auth index
	if authIndex = strings.TrimSpace(authIndex); authIndex != "" {
		return "auth-index:" + family + ":" + authIndex, nil
	}
	// Level 3: Keyed HMAC of normalized credential material
	if trimmedKey := strings.TrimSpace(apiKey); trimmedKey != "" {
		return d.cipher.Fingerprint("credential-hmac-v1", family, trimmedKey)
	}
	// Level 4: Unique non-sensitive metadata fingerprint
	parts := append([]string{"metadata-v1", instanceID, family}, metadata...)
	return d.cipher.Fingerprint(normalizeIdentityParts(parts)...)
}

func normalizeIdentityParts(parts []string) []string {
	result := make([]string, len(parts))
	for index, part := range parts {
		result[index] = strings.ToLower(strings.TrimSpace(part))
	}
	return result
}

func safeAccountType(value string) string {
	switch normalized := strings.ToLower(strings.TrimSpace(value)); normalized {
	case "", "oauth", "api_key", "apikey", "service_account", "service-account":
		return normalized
	default:
		return "other"
	}
}

func safeDisplayText(value string, limit int) string {
	value = security.RedactText(value)
	value = strings.TrimSpace(value)
	if limit > 0 && len([]rune(value)) > limit {
		value = string([]rune(value)[:limit])
	}
	return value
}

func omitEmptyExtra(values map[string]string) map[string]string {
	result := make(map[string]string, len(values))
	for key, value := range values {
		if strings.TrimSpace(value) != "" {
			result[key] = value
		}
	}
	if len(result) == 0 {
		return nil
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

func publicURL(value string) string { return security.PublicURL(value) }

func normalizeURL(value string) string {
	value = publicURL(value)
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
