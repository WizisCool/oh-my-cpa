package management

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

type Client struct {
	baseURL    string
	management string
	httpClient *http.Client
}

func NewClient(baseURL, managementKey string, timeout time.Duration, tlsSkipVerify bool) (*Client, error) {
	baseURL = strings.TrimRight(strings.TrimSpace(baseURL), "/")
	if baseURL == "" {
		return nil, errors.New("CPA base URL is required")
	}
	parsed, err := url.Parse(baseURL)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return nil, fmt.Errorf("invalid CPA base URL %q", baseURL)
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return nil, fmt.Errorf("CPA base URL must use http or https")
	}
	if strings.TrimSpace(managementKey) == "" {
		return nil, errors.New("CPA management key is required")
	}
	if timeout <= 0 {
		timeout = 15 * time.Second
	}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	if tlsSkipVerify {
		transport.TLSClientConfig = &tls.Config{MinVersion: tls.VersionTLS12, InsecureSkipVerify: true} // #nosec G402 -- explicit operator opt-in for private CPA deployments.
	} else {
		transport.TLSClientConfig = &tls.Config{MinVersion: tls.VersionTLS12}
	}
	return &Client{
		baseURL:    baseURL,
		management: managementKey,
		httpClient: &http.Client{Timeout: timeout, Transport: transport},
	}, nil
}

func (c *Client) BaseURL() string { return c.baseURL }

// ManagementKeyPresent is intentionally the only key-related observation the
// client exposes. The actual key is never returned or formatted in an error.
func (c *Client) ManagementKeyPresent() bool { return c != nil && c.management != "" }

func (c *Client) DoJSON(ctx context.Context, method, endpoint string, output any) error {
	request, err := http.NewRequestWithContext(ctx, method, c.baseURL+"/v0/management"+endpoint, nil)
	if err != nil {
		return fmt.Errorf("create CPA request: %w", err)
	}
	return c.do(request, output)
}

func (c *Client) AuthFiles(ctx context.Context) (AuthFilesResponse, error) {
	var response AuthFilesResponse
	if err := c.DoJSON(ctx, http.MethodGet, "/auth-files", &response); err != nil {
		return AuthFilesResponse{}, err
	}
	return response, nil
}

func (c *Client) CodexAPIKeys(ctx context.Context) (CodexAPIKeysResponse, error) {
	var response CodexAPIKeysResponse
	if err := c.DoJSON(ctx, http.MethodGet, "/codex-api-key", &response); err != nil {
		return CodexAPIKeysResponse{}, err
	}
	return response, nil
}

func (c *Client) OpenAICompatibility(ctx context.Context) (OpenAICompatibilityResponse, error) {
	var response OpenAICompatibilityResponse
	if err := c.DoJSON(ctx, http.MethodGet, "/openai-compatibility", &response); err != nil {
		return OpenAICompatibilityResponse{}, err
	}
	return response, nil
}

func (c *Client) Health(ctx context.Context) error {
	// /auth-files is a documented read-only management endpoint and exercises
	// both CPA reachability and management-key authentication.
	var response AuthFilesResponse
	return c.DoJSON(ctx, http.MethodGet, "/auth-files", &response)
}

func (c *Client) do(request *http.Request, output any) error {
	request.Header.Set("Authorization", "Bearer "+c.management)
	request.Header.Set("Accept", "application/json")
	response, err := c.httpClient.Do(request)
	if err != nil {
		return fmt.Errorf("CPA request failed: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		body, _ := io.ReadAll(io.LimitReader(response.Body, 16*1024))
		return &HTTPError{StatusCode: response.StatusCode, Body: redactSecret(strings.TrimSpace(string(body)), c.management)}
	}
	if output == nil || response.StatusCode == http.StatusNoContent {
		return nil
	}
	decoder := json.NewDecoder(io.LimitReader(response.Body, 16*1024*1024))
	if err := decoder.Decode(output); err != nil {
		return fmt.Errorf("decode CPA response: %w", err)
	}
	return nil
}

type HTTPError struct {
	StatusCode int
	Body       string
}

func redactSecret(value, secret string) string {
	if strings.TrimSpace(secret) == "" {
		return value
	}
	return strings.ReplaceAll(value, secret, "[redacted]")
}

func (e *HTTPError) Error() string {
	if e.Body == "" {
		return fmt.Sprintf("CPA returned HTTP %d", e.StatusCode)
	}
	return fmt.Sprintf("CPA returned HTTP %d: %s", e.StatusCode, e.Body)
}

type AuthFilesResponse struct {
	Files []AuthFile `json:"files"`
}

type AuthFile struct {
	ID            string      `json:"id"`
	AuthIndex     string      `json:"auth_index"`
	Name          string      `json:"name"`
	Provider      string      `json:"provider"`
	Label         string      `json:"label"`
	Status        string      `json:"status"`
	StatusMessage string      `json:"status_message"`
	Disabled      bool        `json:"disabled"`
	Unavailable   bool        `json:"unavailable"`
	RuntimeOnly   bool        `json:"runtime_only"`
	Source        string      `json:"source"`
	Email         string      `json:"email"`
	AccountType   string      `json:"account_type"`
	Account       string      `json:"account"`
	Models        []AuthModel `json:"models"`
}

type AuthModel struct {
	ID          string `json:"id"`
	DisplayName string `json:"display_name"`
}

type CodexAPIKeysResponse struct {
	Entries []CodexAPIKey `json:"codex-api-key"`
}

type CodexAPIKey struct {
	APIKey         string            `json:"api-key"`
	AuthIndex      string            `json:"auth-index"`
	BaseURL        string            `json:"base-url"`
	ProxyURL       string            `json:"proxy-url"`
	Headers        map[string]string `json:"headers"`
	Models         []ModelAlias      `json:"models"`
	ExcludedModels []string          `json:"excluded-models"`
	Priority       int               `json:"priority"`
	Prefix         string            `json:"prefix"`
}

type OpenAICompatibilityResponse struct {
	Entries []OpenAICompatibility `json:"openai-compatibility"`
}

type OpenAICompatibility struct {
	Name          string            `json:"name"`
	Disabled      bool              `json:"disabled"`
	BaseURL       string            `json:"base-url"`
	APIKeyEntries []APIKeyEntry     `json:"api-key-entries"`
	LegacyAPIKeys []string          `json:"api-keys"`
	Models        []ModelAlias      `json:"models"`
	Headers       map[string]string `json:"headers"`
}

type APIKeyEntry struct {
	APIKey    string `json:"api-key"`
	AuthIndex string `json:"auth-index"`
	ProxyURL  string `json:"proxy-url"`
}

type ModelAlias struct {
	Name        string `json:"name"`
	Alias       string `json:"alias"`
	DisplayName string `json:"display-name"`
}
