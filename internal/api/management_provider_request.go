package api

import (
	"fmt"
	"net/url"
	"strconv"
	"strings"
)

type SaveProviderKeyEntry struct {
	APIKey   string `json:"api_key,omitempty"`
	ProxyURL string `json:"proxy_url,omitempty"`
	Weight   *int   `json:"weight,omitempty"`
}

type SaveProviderModelEntry struct {
	Name     string       `json:"name"`
	Alias    string       `json:"alias,omitempty"`
	Image    bool         `json:"image,omitempty"`
	Thinking *ThinkingDTO `json:"thinking,omitempty"`
}

type SaveProviderRequest struct {
	Family         string                   `json:"family"`
	Name           string                   `json:"name"`
	BaseURL        string                   `json:"base_url"`
	Prefix         string                   `json:"prefix,omitempty"`
	Priority       *int                     `json:"priority,omitempty"`
	DisableCooling bool                     `json:"disable_cooling"`
	APIKey         string                   `json:"api_key,omitempty"`
	Keys           []SaveProviderKeyEntry   `json:"keys,omitempty"`
	Models         []string                 `json:"models,omitempty"`
	ModelEntries   []SaveProviderModelEntry `json:"model_entries,omitempty"`
	Headers        map[string]string        `json:"headers,omitempty"`
	Disabled       bool                     `json:"disabled"`
	// Website is operator metadata, not a CPA field. nil means "leave the stored
	// value alone"; a present empty string clears it. That distinction is what
	// lets a rename save from a client that never carried a website field avoid
	// erasing one.
	Website *string `json:"website,omitempty"`
}

// normalizeProviderWebsite accepts only a URL this console may render as a link.
//
// The value ends up in an href, so the scheme is the security boundary: a
// javascript: or data: URL would be script execution with the session's
// authority, and a scheme-relative or relative value would silently point at
// this console instead of the provider. Anything that is not an absolute
// http/https URL with a host is refused rather than repaired.
func normalizeProviderWebsite(raw string) (string, bool) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return "", true
	}
	if len(trimmed) > maxProviderWebsiteLength {
		return "", false
	}
	parsed, err := url.Parse(trimmed)
	if err != nil {
		return "", false
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return "", false
	}
	if parsed.Host == "" {
		return "", false
	}
	return parsed.String(), true
}

// resolveProviderWebsite validates the optional website field of a save request,
// reporting separately whether the field was present and whether it is usable.
// The two questions are independent: an absent field is valid input that leaves
// the stored value alone, while a present but unusable one is an error.
func resolveProviderWebsite(raw *string) (website string, isProvided bool, isValid bool) {
	if raw == nil {
		return "", false, true
	}
	normalized, ok := normalizeProviderWebsite(*raw)
	if !ok {
		return "", true, false
	}
	return normalized, true, true
}

// maxProviderWebsiteLength bounds the stored value well below the preference
// document limit, so one absurd entry cannot consume the whole map's budget.
const maxProviderWebsiteLength = 512

// The openai-compatibility family is not a config API-key list: its entries are
// whole provider objects with their own credential list, so it keeps constants
// of its own instead of a row in providerConfigFamilies.
const (
	openAICompatibilityFamily = "openai-compatibility"
	openAICompatIDPrefix      = "openai-compat-"
)

// parseProviderID splits a positional provider id such as `meta-2` into its
// family and index. The config API-key prefixes come from the family registry,
// so a new family is addressable without touching this function.
func parseProviderID(id string) (string, int, error) {
	trimmed := strings.TrimSpace(id)
	if strings.HasPrefix(trimmed, openAICompatIDPrefix) {
		idx, err := strconv.Atoi(strings.TrimPrefix(trimmed, openAICompatIDPrefix))
		return openAICompatibilityFamily, idx, err
	}
	for _, spec := range providerConfigFamilies {
		if !strings.HasPrefix(trimmed, spec.IDPrefix) {
			continue
		}
		idx, err := strconv.Atoi(strings.TrimPrefix(trimmed, spec.IDPrefix))
		return string(spec.Family), idx, err
	}
	return "", 0, fmt.Errorf("unknown provider id format: %s", trimmed)
}
