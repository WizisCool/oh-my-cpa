package management

import (
	"bytes"
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

// Clients carry per-instance credentials, but transports must outlive requests.
// Creating one pool per API call prevents keep-alive reuse and leaves idle
// connections/goroutines around until their timeout. TLS policies stay isolated.
var managementTransports = [2]*http.Transport{newManagementTransport(false), newManagementTransport(true)}

func newManagementTransport(insecure bool) *http.Transport {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.TLSClientConfig = &tls.Config{MinVersion: tls.VersionTLS12, InsecureSkipVerify: insecure} // #nosec G402 -- explicit operator opt-in only.
	return transport
}

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
	if parsed.User != nil {
		return nil, errors.New("CPA base URL must not contain user info")
	}
	if strings.TrimSpace(managementKey) == "" {
		return nil, errors.New("CPA management key is required")
	}
	if timeout <= 0 {
		timeout = 15 * time.Second
	}
	transport := managementTransports[0]
	if tlsSkipVerify {
		transport = managementTransports[1]
	}
	return &Client{
		baseURL:    baseURL,
		management: managementKey,
		httpClient: &http.Client{Timeout: timeout, Transport: transport},
	}, nil
}

func (c *Client) BaseURL() string { return c.baseURL }

// HasManagementKey is intentionally the only key-related observation the
// client exposes. The actual key is never returned or formatted in an error.
func (c *Client) HasManagementKey() bool { return c != nil && c.management != "" }

func (c *Client) DoJSON(ctx context.Context, method, endpoint string, output any) error {
	_, err := c.DoJSONWithMeta(ctx, method, endpoint, output)
	return err
}

// ResponseMeta contains non-sensitive metadata from a CPA management response.
// It intentionally excludes request URLs and authorization values.
type ResponseMeta struct {
	StatusCode int
	Header     http.Header
}

// DoJSONWithMeta is kept as a typed internal escape hatch for response metadata
// such as CPA version headers. Callers still provide a fixed management endpoint;
// this client does not expose a general-purpose browser proxy.
func (c *Client) DoJSONWithMeta(ctx context.Context, method, endpoint string, output any) (ResponseMeta, error) {
	if c == nil {
		return ResponseMeta{}, errors.New("CPA client is not initialized")
	}
	request, err := c.newRequest(ctx, method, endpoint, nil, "")
	if err != nil {
		return ResponseMeta{}, err
	}
	return c.do(request, output)
}

func (c *Client) newRequest(ctx context.Context, method, endpoint string, body io.Reader, contentType string) (*http.Request, error) {
	if c == nil {
		return nil, errors.New("CPA client is not initialized")
	}
	request, err := http.NewRequestWithContext(ctx, method, c.baseURL+"/v0/management"+endpoint, body)
	if err != nil {
		return nil, fmt.Errorf("create CPA request: %w", err)
	}
	if strings.TrimSpace(contentType) != "" {
		request.Header.Set("Content-Type", contentType)
	}
	return request, nil
}

func (c *Client) doJSONBody(ctx context.Context, method, endpoint string, payload any, output any) error {
	data, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("encode CPA request: %w", err)
	}
	return c.doBody(ctx, method, endpoint, data, "application/json", output)
}

func (c *Client) doBody(ctx context.Context, method, endpoint string, data []byte, contentType string, output any) error {
	request, err := c.newRequest(ctx, method, endpoint, bytes.NewReader(data), contentType)
	if err != nil {
		return err
	}
	_, err = c.do(request, output)
	return err
}

func (c *Client) do(request *http.Request, output any) (ResponseMeta, error) {
	request.Header.Set("Authorization", "Bearer "+c.management)
	request.Header.Set("Accept", "application/json")
	response, err := c.httpClient.Do(request)
	if err != nil {
		return ResponseMeta{}, fmt.Errorf("CPA request failed: %w", err)
	}
	defer response.Body.Close()
	meta := ResponseMeta{StatusCode: response.StatusCode, Header: response.Header.Clone()}
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		body, _ := io.ReadAll(io.LimitReader(response.Body, 16*1024))
		return meta, &HTTPError{StatusCode: response.StatusCode, Body: redactSecret(strings.TrimSpace(string(body)), c.management)}
	}
	if output == nil || response.StatusCode == http.StatusNoContent {
		return meta, nil
	}
	decoder := json.NewDecoder(io.LimitReader(response.Body, 16*1024*1024))
	if err := decoder.Decode(output); err != nil {
		return meta, fmt.Errorf("decode CPA response: %w", err)
	}
	return meta, nil
}

func (c *Client) doBytes(request *http.Request, maxBytes int64) ([]byte, ResponseMeta, error) {
	request.Header.Set("Authorization", "Bearer "+c.management)
	request.Header.Set("Accept", "application/json, application/octet-stream")
	response, err := c.httpClient.Do(request)
	if err != nil {
		return nil, ResponseMeta{}, fmt.Errorf("CPA request failed: %w", err)
	}
	defer response.Body.Close()
	meta := ResponseMeta{StatusCode: response.StatusCode, Header: response.Header.Clone()}
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		body, _ := io.ReadAll(io.LimitReader(response.Body, 16*1024))
		return nil, meta, &HTTPError{StatusCode: response.StatusCode, Body: redactSecret(strings.TrimSpace(string(body)), c.management)}
	}
	if maxBytes <= 0 {
		maxBytes = 8 * 1024 * 1024
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, maxBytes+1))
	if err != nil {
		return nil, meta, fmt.Errorf("read CPA response: %w", err)
	}
	if int64(len(data)) > maxBytes {
		return nil, meta, fmt.Errorf("CPA response exceeds %d bytes", maxBytes)
	}
	return data, meta, nil
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
