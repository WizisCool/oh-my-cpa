package management

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
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

// ApiCall forwards an authenticated HTTP probe through CPA's api-call operation.
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
	if err := c.doJSONBody(ctx, http.MethodPost, "/requests/api-call", payload, &resp); err != nil {
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
	meta, err := c.DoJSONWithMeta(ctx, http.MethodGet, "/server/latest-version", &response)
	return strings.TrimSpace(response.Version), meta, err
}

func (c *Client) Health(ctx context.Context) error {
	// The credential list is a read-only v8 endpoint that exercises reachability,
	// management-key authentication and, through the gate, the API generation.
	var response AuthFilesResponse
	return c.DoJSON(ctx, http.MethodGet, "/credentials", &response)
}
