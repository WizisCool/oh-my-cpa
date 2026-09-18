package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
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
	switch family {
	case "claude":
		return "anthropic"
	case "gemini":
		return "gemini"
	default:
		return "openai"
	}
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

	models, err := fetchEndpointModels(request.Context(), baseURL, apiKey, proxyURL, pullProtocol(family), headers)
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
			writeError(writer, http.StatusBadGateway, fmt.Sprintf("failed to pull models: %v", err))
		}
		return
	}

	writeJSON(writer, http.StatusOK, map[string]any{
		"models": models,
		"total":  len(models),
	})
}

func fetchEndpointModels(ctx context.Context, rawBaseURL, apiKey, proxyStr, protocol string, customHeaders map[string]string) ([]string, error) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()

	parsed, err := url.Parse(rawBaseURL)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", errInvalidModelPullURL, err)
	}
	if !isModelPullURLAllowed(parsed) {
		return nil, fmt.Errorf("%w: base URL must use HTTPS unless it targets localhost, a loopback address, or a private IP address", errInvalidModelPullURL)
	}

	transport := &http.Transport{
		Proxy: http.ProxyFromEnvironment,
	}
	if proxyStr != "" {
		if pURL, err := url.Parse(proxyStr); err == nil {
			transport.Proxy = http.ProxyURL(pURL)
		}
	}
	client := &http.Client{
		Timeout:   15 * time.Second,
		Transport: transport,
		// Refuse cross-origin redirects instead of trying to scrub known
		// credential headers: custom provider headers can carry secrets too,
		// and a scheme change could downgrade any credential that survived.
		CheckRedirect: func(redirectedRequest *http.Request, via []*http.Request) error {
			if len(via) >= MAX_MODEL_PULL_REDIRECTS {
				return fmt.Errorf("%w: stopped after %d redirects", errModelPullRedirectRefused, MAX_MODEL_PULL_REDIRECTS)
			}
			origin := via[0].URL
			if !strings.EqualFold(redirectedRequest.URL.Scheme, origin.Scheme) || !strings.EqualFold(redirectedRequest.URL.Host, origin.Host) {
				return fmt.Errorf("%w: cross-origin redirect", errModelPullRedirectRefused)
			}
			return nil
		},
	}

	trimmed := strings.TrimRight(rawBaseURL, "/")
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

	req, err := buildRequest(trimmed + "/models")
	if err != nil {
		return nil, err
	}

	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusNotFound && !strings.HasSuffix(trimmed, "/v1") {
		retryURL := trimmed + "/v1/models"
		req2, err := buildRequest(retryURL)
		if err == nil {
			if resp2, err2 := client.Do(req2); err2 == nil {
				defer resp2.Body.Close()
				if resp2.StatusCode == http.StatusOK {
					return parseModelsResponse(resp2.Body)
				}
			}
		}
	}

	if resp.StatusCode != http.StatusOK {
		bodySnippet, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return nil, fmt.Errorf("HTTP %d: %s", resp.StatusCode, strings.TrimSpace(string(bodySnippet)))
	}

	return parseModelsResponse(resp.Body)
}

// isModelPullURLAllowed keeps the operator's upstream key off public plaintext
// links while still allowing self-hosted relays reached over loopback or
// private addresses.
func isModelPullURLAllowed(parsed *url.URL) bool {
	if parsed == nil {
		return false
	}
	switch strings.ToLower(parsed.Scheme) {
	case "https":
		return true
	case "http":
		return isPlaintextModelPullHostAllowed(parsed.Hostname())
	default:
		return false
	}
}

func isPlaintextModelPullHostAllowed(host string) bool {
	host = strings.TrimSuffix(strings.ToLower(strings.TrimSpace(host)), ".")
	if host == "localhost" {
		return true
	}
	if zoneIndex := strings.IndexByte(host, '%'); zoneIndex >= 0 {
		host = host[:zoneIndex]
	}
	address := net.ParseIP(host)
	if address == nil {
		return false
	}
	return address.IsLoopback() || address.IsPrivate()
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

func parseModelsResponse(r io.Reader) ([]string, error) {
	data, err := io.ReadAll(io.LimitReader(r, 2*1024*1024))
	if err != nil {
		return nil, err
	}

	var oaiResp struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	if err := json.Unmarshal(data, &oaiResp); err == nil && len(oaiResp.Data) > 0 {
		models := make([]string, 0, len(oaiResp.Data))
		seen := make(map[string]bool)
		for _, m := range oaiResp.Data {
			id := strings.TrimSpace(m.ID)
			if id != "" && !seen[id] {
				seen[id] = true
				models = append(models, id)
			}
		}
		return models, nil
	}

	var objResp struct {
		Models []json.RawMessage `json:"models"`
	}
	if err := json.Unmarshal(data, &objResp); err == nil && len(objResp.Models) > 0 {
		models := make([]string, 0, len(objResp.Models))
		seen := make(map[string]bool)
		for _, raw := range objResp.Models {
			var str string
			if json.Unmarshal(raw, &str) == nil && str != "" {
				if !seen[str] {
					seen[str] = true
					models = append(models, str)
				}
				continue
			}
			var item struct {
				ID   string `json:"id"`
				Name string `json:"name"`
			}
			if json.Unmarshal(raw, &item) == nil {
				val := firstNonEmpty(item.ID, item.Name)
				if val != "" && !seen[val] {
					seen[val] = true
					models = append(models, val)
				}
			}
		}
		if len(models) > 0 {
			return models, nil
		}
	}

	var arrResp []struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	}
	if err := json.Unmarshal(data, &arrResp); err == nil && len(arrResp) > 0 {
		models := make([]string, 0, len(arrResp))
		seen := make(map[string]bool)
		for _, item := range arrResp {
			val := firstNonEmpty(item.ID, item.Name)
			if val != "" && !seen[val] {
				seen[val] = true
				models = append(models, val)
			}
		}
		return models, nil
	}

	return []string{}, nil
}
