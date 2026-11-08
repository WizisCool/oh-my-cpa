package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/management"
	"github.com/oh-my-cpa/oh-my-cpa/internal/security"
)

const MAX_MODEL_PULL_REDIRECTS = 10

var (
	errInvalidModelPullURL      = errors.New("invalid model pull URL")
	errModelPullRedirectRefused = errors.New("model pull redirect refused")
)

type pullModelsRequest struct {
	ProviderID string            `json:"provider_id,omitempty"`
	Family     string            `json:"family,omitempty"`
	BaseURL    string            `json:"base_url,omitempty"`
	APIKey     string            `json:"api_key,omitempty"`
	ProxyURL   string            `json:"proxy_url,omitempty"`
	Headers    map[string]string `json:"headers,omitempty"`
}

// mergePullDefaults fills empty pull parameters from a stored provider entry,
// letting values the user typed in the form win over stored ones.
func mergePullDefaults(entryBaseURL, entryAPIKey, entryProxyURL string, entryHeaders map[string]string, baseURL, apiKey, proxyURL string, headers map[string]string) (string, string, string, map[string]string) {
	if baseURL == "" {
		baseURL = entryBaseURL
	}
	if apiKey == "" {
		apiKey = entryAPIKey
	}
	if proxyURL == "" {
		proxyURL = entryProxyURL
	}
	if len(headers) == 0 && len(entryHeaders) > 0 {
		headers = entryHeaders
	}
	return baseURL, apiKey, proxyURL, headers
}

// pullProtocol maps a provider family to the auth dialect of its upstream so
// model-list requests are authenticated the same way CPA itself would be.
func pullProtocol(family string) string {
	if spec, isConfigFamily := lookupProviderConfigFamily(family); isConfigFamily && spec.PullProtocol != "" {
		return spec.PullProtocol
	}
	return "openai"
}

func (h *Handler) pullProviderModels(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	var req pullModelsRequest
	if err := decodeManagementJSON(writer, request, 32*1024, &req); err != nil {
		return
	}

	baseURL := strings.TrimSpace(req.BaseURL)
	apiKey := strings.TrimSpace(req.APIKey)
	proxyURL := strings.TrimSpace(req.ProxyURL)
	headers := req.Headers
	family := strings.ToLower(strings.TrimSpace(req.Family))

	if req.ProviderID != "" && (baseURL == "" || apiKey == "") {
		client, ok := h.managementClientOrError(writer, request)
		if ok {
			storedFamily, index, err := parseProviderID(req.ProviderID)
			if err == nil && index >= 0 {
				ctx := request.Context()
				switch {
				case storedFamily == openAICompatibilityFamily:
					resp, err := client.OpenAICompatibility(ctx)
					if err == nil && index < len(resp.Entries) {
						entry := resp.Entries[index]
						if baseURL == "" {
							baseURL = entry.BaseURL
						}
						if apiKey == "" && len(entry.APIKeyEntries) > 0 {
							apiKey = entry.APIKeyEntries[0].APIKey
							if proxyURL == "" {
								proxyURL = entry.APIKeyEntries[0].ProxyURL
							}
						}
						if len(headers) == 0 && len(entry.Headers) > 0 {
							headers = entry.Headers
						}
					}
				default:
					if spec, isConfigFamily := lookupProviderConfigFamily(storedFamily); isConfigFamily {
						entries, err := client.ConfigAPIKeys(ctx, spec.Family)
						if err == nil && index < len(entries) {
							entry := entries[index]
							baseURL, apiKey, proxyURL, headers = mergePullDefaults(entry.BaseURL, entry.APIKey, entry.ProxyURL, entry.Headers, baseURL, apiKey, proxyURL, headers)
						}
					}
				}
				family = storedFamily
			}
		}
	}

	if baseURL == "" {
		writeError(writer, http.StatusBadRequest, "base_url is required")
		return
	}

	models, err := fetchEndpointModels(request.Context(), baseURL, apiKey, proxyURL, family, headers)
	if err != nil {
		switch {
		case errors.Is(err, errInvalidModelPullURL):
			writeJSON(writer, http.StatusBadRequest, map[string]string{
				"error": err.Error(),
				"code":  "invalid_model_pull_url",
			})
		case errors.Is(err, errModelPullRedirectRefused):
			writeJSON(writer, http.StatusBadGateway, map[string]string{
				"error": err.Error(),
				"code":  "model_pull_redirect_refused",
			})
		default:
			// The upstream's own words are useful to the operator, but a relay that
			// echoes the request back would hand the stored key to a caller who
			// supplied only a provider id.
			secrets := []string{apiKey}
			for _, value := range headers {
				secrets = append(secrets, value)
			}
			writeError(writer, http.StatusBadGateway, fmt.Sprintf("failed to pull models: %s", security.RedactText(err.Error(), secrets...)))
		}
		return
	}

	writeJSON(writer, http.StatusOK, map[string]any{
		"models": models,
		"total":  len(models),
	})
}

// MODEL_DIRECTORY_PAGE_SIZE asks a paged directory for one full page. Both
// upstreams otherwise truncate a pull silently: Anthropic's list answers 20
// entries by default and Gemini's 50, and neither is the whole directory.
const MODEL_DIRECTORY_PAGE_SIZE = 1000

// modelDirectoryTargets lists the URLs a family's model directory may live at,
// most authoritative first.
//
// The dialect comes first because that is what the credential is for, and its
// version segment is exactly what an operator is not expected to type: the
// Anthropic Messages API lists at /v1/models, and both Gemini dialects at
// /v1beta/models. The OpenAI shapes follow as fallbacks, since republishing the
// same directory at /models or /v1/models is what a relay does, and they are the
// whole answer for the families that speak the OpenAI dialect themselves.
//
// Vertex AI has no versioned candidate on purpose: its publisher model list is
// OAuth-only, so an API key has no directory to ask for there.
func modelDirectoryTargets(family, rawBaseURL string) []string {
	base := strings.TrimRight(strings.TrimSpace(rawBaseURL), "/")
	if base == "" {
		return nil
	}
	targets := make([]string, 0, 3)
	seen := make(map[string]bool, 3)
	appendTarget := func(target string) {
		// One candidate per path: a query only asks the same endpoint for a
		// different slice of the directory, not for a directory that may exist.
		path := target
		if index := strings.IndexByte(path, '?'); index >= 0 {
			path = path[:index]
		}
		if seen[path] {
			return
		}
		seen[path] = true
		targets = append(targets, target)
	}
	family = strings.ToLower(strings.TrimSpace(family))
	root := base
	pageQuery := ""
	switch family {
	case string(management.ConfigFamilyClaude):
		root = claudeAPIRoot(base)
		pageQuery = fmt.Sprintf("?limit=%d", MODEL_DIRECTORY_PAGE_SIZE)
	case string(management.ConfigFamilyGemini), string(management.ConfigFamilyInteractions):
		root = geminiAPIRoot(base)
		pageQuery = fmt.Sprintf("?pageSize=%d", MODEL_DIRECTORY_PAGE_SIZE)
	}
	appendTarget(root + "/models" + pageQuery)
	// A base that names no version segment leaves /v1 as the OpenAI default to
	// try, and its own path as one a relay may republish the directory at.
	if !strings.Contains(strings.ToLower(base), "/v1") {
		if base != root {
			appendTarget(base + "/models")
		}
		appendTarget(base + "/v1/models")
	}
	return targets
}

func fetchEndpointModels(ctx context.Context, rawBaseURL, apiKey, proxyStr, family string, customHeaders map[string]string) ([]string, error) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()

	parsed, err := url.Parse(rawBaseURL)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", errInvalidModelPullURL, err)
	}
	addresses, isAllowed := resolveProviderURLAddresses(ctx, parsed)
	if !isAllowed {
		return nil, fmt.Errorf("%w: base URL must use HTTPS unless it targets localhost, a loopback/private IP address, or a hostname resolving only to those addresses", errInvalidModelPullURL)
	}

	transport := &http.Transport{
		Proxy: providerEnvironmentProxy,
	}
	if proxyStr != "" {
		// A proxy the operator named must be the path taken: falling back to
		// a direct connection on a parse failure would silently change it.
		pURL, err := url.Parse(proxyStr)
		if err != nil || pURL.Host == "" {
			return nil, fmt.Errorf("%w: proxy URL is not a valid URL", errInvalidModelPullURL)
		}
		transport.Proxy = http.ProxyURL(pURL)
	}
	defer transport.CloseIdleConnections()
	client := &http.Client{
		Timeout:       15 * time.Second,
		Transport:     pinProviderHostname(transport, parsed, addresses),
		CheckRedirect: sameOriginRedirectGuard(errModelPullRedirectRefused, MAX_MODEL_PULL_REDIRECTS),
	}

	trimmed := strings.TrimRight(rawBaseURL, "/")
	protocol := pullProtocol(family)
	buildRequest := func(target string) (*http.Request, error) {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
		if err != nil {
			return nil, err
		}
		setModelPullAuthHeaders(req, apiKey, protocol)
		for k, v := range customHeaders {
			req.Header.Set(k, v)
		}
		return req, nil
	}

	targets := modelDirectoryTargets(family, trimmed)
	if len(targets) == 0 {
		return nil, fmt.Errorf("%w: base URL is required", errInvalidModelPullURL)
	}
	// A 404 means this path is not the directory, so the next candidate is worth
	// asking. Any other status is the upstream's answer about the request itself -
	// a key it rejects, a body it refuses - and asking again at another path would
	// only send the same key to a destination that already declined it.
	var unreachable error
	for _, target := range targets {
		req, err := buildRequest(target)
		if err != nil {
			return nil, err
		}
		resp, err := client.Do(req)
		if err != nil {
			return nil, err
		}
		if resp.StatusCode == http.StatusOK {
			defer resp.Body.Close()
			return parseModelsResponse(resp.Body)
		}
		bodySnippet, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		resp.Body.Close()
		unreachable = fmt.Errorf("HTTP %d: %s", resp.StatusCode, strings.TrimSpace(string(bodySnippet)))
		if resp.StatusCode != http.StatusNotFound {
			return nil, unreachable
		}
	}
	return nil, unreachable
}

// setModelPullAuthHeaders authenticates a model-list request the way each
// protocol's upstream expects. Relays commonly gate /models behind
// Authorization, while the official Anthropic API requires x-api-key, so the
// anthropic dialect sends both; custom headers can still override any of them.
func setModelPullAuthHeaders(req *http.Request, apiKey, protocol string) {
	if apiKey == "" {
		return
	}
	switch protocol {
	case "anthropic":
		req.Header.Set("Authorization", "Bearer "+apiKey)
		req.Header.Set("x-api-key", apiKey)
		req.Header.Set("anthropic-version", "2023-06-01")
	case "gemini":
		req.Header.Set("x-goog-api-key", apiKey)
	default:
		req.Header.Set("Authorization", "Bearer "+apiKey)
	}
}

// MODEL_DIRECTORY_LIMIT_BYTES bounds a pulled model directory; a larger body is refused, not truncated.
const MODEL_DIRECTORY_LIMIT_BYTES = 2 * 1024 * 1024

var errModelDirectoryUnrecognized = errors.New("upstream did not return a model list")

// parseModelsResponse reads the three directory shapes upstreams publish: OpenAI's
// `{"data":[...]}`, `{"models":[...]}` and a bare array. An empty list in one of those
// shapes is a real answer; anything else - an error document, `null`, a truncated or
// oversized body - is refused, because reporting it as "no models" would let a failed
// pull look like an upstream that offers nothing.
func parseModelsResponse(r io.Reader) ([]string, error) {
	data, err := io.ReadAll(io.LimitReader(r, MODEL_DIRECTORY_LIMIT_BYTES+1))
	if err != nil {
		return nil, err
	}
	if len(data) > MODEL_DIRECTORY_LIMIT_BYTES {
		return nil, fmt.Errorf("%w: response exceeds %d bytes", errModelDirectoryUnrecognized, MODEL_DIRECTORY_LIMIT_BYTES)
	}
	entries, err := modelDirectoryEntries(data)
	if err != nil {
		return nil, err
	}
	models := make([]string, 0, len(entries))
	seen := make(map[string]bool, len(entries))
	for _, raw := range entries {
		var name string
		if json.Unmarshal(raw, &name) != nil {
			var item struct {
				ID   string `json:"id"`
				Name string `json:"name"`
			}
			if json.Unmarshal(raw, &item) != nil {
				continue
			}
			name = firstNonEmpty(item.ID, item.Name)
		}
		name = directoryModelName(name)
		if name != "" && !seen[name] {
			seen[name] = true
			models = append(models, name)
		}
	}
	return models, nil
}

// directoryModelName drops the resource path a Google directory names a model by
// - "models/gemini-2.5-pro" for Gemini, "publishers/google/models/..." for Vertex -
// so the entry matches the model CPA routes.
//
// Only Google's own resource containers are stripped. Another directory may route
// by a path of its own - Fireworks names a model "accounts/fireworks/models/..." -
// and cutting that prefix would hand the operator a name the upstream rejects.
func directoryModelName(name string) string {
	trimmed := strings.TrimSpace(name)
	lower := asciiLower(trimmed)
	googleContainer := strings.HasPrefix(lower, "publishers/") || strings.HasPrefix(lower, "projects/")
	if index := strings.LastIndex(lower, "/models/"); index >= 0 && googleContainer {
		return trimmed[index+len("/models/"):]
	}
	if strings.HasPrefix(lower, "models/") {
		return trimmed[len("models/"):]
	}
	return trimmed
}

func modelDirectoryEntries(data []byte) ([]json.RawMessage, error) {
	var entries []json.RawMessage
	if trimmed := bytes.TrimSpace(data); len(trimmed) > 0 && trimmed[0] == '[' {
		if err := json.Unmarshal(trimmed, &entries); err != nil {
			return nil, errModelDirectoryUnrecognized
		}
		return entries, nil
	}
	var document struct {
		Data   json.RawMessage `json:"data"`
		Models json.RawMessage `json:"models"`
	}
	if err := json.Unmarshal(data, &document); err != nil {
		return nil, errModelDirectoryUnrecognized
	}
	for _, list := range []json.RawMessage{document.Data, document.Models} {
		if trimmed := bytes.TrimSpace(list); len(trimmed) > 0 && trimmed[0] == '[' {
			if err := json.Unmarshal(trimmed, &entries); err != nil {
				return nil, errModelDirectoryUnrecognized
			}
			if len(entries) > 0 {
				return entries, nil
			}
		}
	}
	if entries == nil {
		return nil, errModelDirectoryUnrecognized
	}
	return entries, nil
}
