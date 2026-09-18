package management

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// ApiCallRequest represents the payload passed to CPA's /api-call proxy endpoint.
// It is used internally by quota service facades and must never be exposed as an
// arbitrary browser proxy.
type ApiCallRequest struct {
	AuthIndex string            `json:"auth_index,omitempty"`
	Method    string            `json:"method"`
	URL       string            `json:"url"`
	Header    map[string]string `json:"header,omitempty"`
	Data      string            `json:"data,omitempty"`
}

// ApiCallResponse represents the response returned by CPA's /api-call endpoint.
type ApiCallResponse struct {
	StatusCode int                 `json:"status_code"`
	Header     map[string][]string `json:"header"`
	Body       json.RawMessage     `json:"body"`
}

// ApiCall forwards an authenticated HTTP probe to CPA's /api-call endpoint.
func (c *Client) ApiCall(ctx context.Context, req ApiCallRequest) (ApiCallResponse, error) {
	if c == nil {
		return ApiCallResponse{}, errors.New("CPA client is not initialized")
	}
	method := strings.ToUpper(strings.TrimSpace(req.Method))
	if method == "" {
		return ApiCallResponse{}, errors.New("method is required")
	}
	targetURL := strings.TrimSpace(req.URL)
	if targetURL == "" {
		return ApiCallResponse{}, errors.New("url is required")
	}

	payload := map[string]any{
		"method": method,
		"url":    targetURL,
	}
	if authIndex := strings.TrimSpace(req.AuthIndex); authIndex != "" {
		payload["auth_index"] = authIndex
	}
	if len(req.Header) > 0 {
		payload["header"] = req.Header
	}
	if req.Data != "" {
		payload["data"] = req.Data
	}

	var resp ApiCallResponse
	if err := c.doJSONBody(ctx, http.MethodPost, "/api-call", payload, &resp); err != nil {
		return ApiCallResponse{}, err
	}
	return resp, nil
}

// NormalizedBody unwraps the body if CPA returned it as a JSON-encoded string.
func (r ApiCallResponse) NormalizedBody() ([]byte, error) {
	trimmed := bytes.TrimSpace(r.Body)
	if len(trimmed) == 0 {
		return []byte("{}"), nil
	}
	if trimmed[0] == '"' && trimmed[len(trimmed)-1] == '"' {
		var unquoted string
		if err := json.Unmarshal(trimmed, &unquoted); err == nil {
			unquotedTrimmed := strings.TrimSpace(unquoted)
			if unquotedTrimmed != "" {
				return []byte(unquotedTrimmed), nil
			}
		}
	}
	return trimmed, nil
}

// LatestVersion reads the CPA-managed latest version endpoint. It may itself
// depend on GitHub connectivity, so callers should treat failure as partial.
func (c *Client) LatestVersion(ctx context.Context) (string, ResponseMeta, error) {
	var response struct {
		Version string `json:"latest-version"`
	}
	meta, err := c.DoJSONWithMeta(ctx, http.MethodGet, "/latest-version", &response)
	return strings.TrimSpace(response.Version), meta, err
}

// ProbeResult records the outcome of a read-only probe against a single CPA endpoint.
type ProbeResult struct {
	Endpoint   string `json:"endpoint"`
	StatusCode int    `json:"http_status"`
	LatencyMs  int64  `json:"latency_ms"`
	Status     string `json:"status"` // "supported", "missing", "offline", "error"
	Error      string `json:"error,omitempty"`
}

// ProbeEndpoint performs a bounded, read-only GET against a management endpoint
// to check if upstream supports it, measuring latency and status code without
// buffering large payloads.
func (c *Client) ProbeEndpoint(ctx context.Context, endpoint string) ProbeResult {
	start := time.Now()
	if c == nil {
		return ProbeResult{
			Endpoint:  endpoint,
			Status:    "offline",
			Error:     "CPA client is not initialized",
			LatencyMs: 0,
		}
	}
	req, err := c.newRequest(ctx, http.MethodGet, endpoint, nil, "")
	if err != nil {
		return ProbeResult{
			Endpoint:  endpoint,
			Status:    "error",
			Error:     err.Error(),
			LatencyMs: time.Since(start).Milliseconds(),
		}
	}
	req.Header.Set("Authorization", "Bearer "+c.management)
	req.Header.Set("Accept", "*/*")

	resp, err := c.httpClient.Do(req)
	latency := time.Since(start).Milliseconds()
	if err != nil {
		return ProbeResult{
			Endpoint:  endpoint,
			Status:    "offline",
			LatencyMs: latency,
			Error:     "connection failed",
		}
	}
	defer resp.Body.Close()
	_, _ = io.CopyN(io.Discard, resp.Body, 16*1024)

	res := ProbeResult{
		Endpoint:   endpoint,
		StatusCode: resp.StatusCode,
		LatencyMs:  latency,
	}
	switch {
	case resp.StatusCode >= 200 && resp.StatusCode < 300:
		res.Status = "supported"
	case resp.StatusCode == http.StatusNotFound || resp.StatusCode == http.StatusMethodNotAllowed || resp.StatusCode == http.StatusNotImplemented:
		res.Status = "missing"
	default:
		res.Status = "error"
		res.Error = fmt.Sprintf("HTTP %d", resp.StatusCode)
	}
	return res
}

func (c *Client) Health(ctx context.Context) error {
	// /auth-files is a documented read-only management endpoint and exercises
	// both CPA reachability and management-key authentication.
	var response AuthFilesResponse
	return c.DoJSON(ctx, http.MethodGet, "/auth-files", &response)
}
