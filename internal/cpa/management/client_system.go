package management

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/google/uuid"
)

// ServerIDHeader is the response header CPA attaches to authenticated
// management responses when a deployment identity is available.
const ServerIDHeader = "X-CPA-SERVER-ID"

// ServerIdentityDTO holds the non-secret deployment identity reported by CPA's
// GET /v8/management/server/server-id endpoint. It is distinct from any Home
// node identifier.
type ServerIdentityDTO struct {
	ServerID string `json:"server-id"`
}

// NormalizeServerID validates CPA's server.server-id format: a 36-character
// nonzero hyphenated UUID. It returns the canonical lowercase UUID on success.
func NormalizeServerID(raw string) (string, bool) {
	trimmed := strings.TrimSpace(raw)
	if len(trimmed) != 36 {
		return "", false
	}
	parsed, err := uuid.Parse(trimmed)
	if err != nil || parsed == uuid.Nil {
		return "", false
	}
	return parsed.String(), true
}

// SafeServerIDHeader reads and validates the X-CPA-SERVER-ID response header.
func SafeServerIDHeader(headers http.Header) string {
	if headers == nil {
		return ""
	}
	if normalized, ok := NormalizeServerID(headers.Get(ServerIDHeader)); ok {
		return normalized
	}
	return ""
}

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

// ServerID reads CPA's active deployment UUID from GET /v8/management/server/server-id.
// Gateways older than v8.1.0 answer 404 (IsMissingCapability); standby gateways may
// report an empty identity. Malformed values are never passed through.
func (c *Client) ServerID(ctx context.Context) (ServerIdentityDTO, ResponseMeta, error) {
	var response ServerIdentityDTO
	meta, err := c.DoJSONWithMeta(ctx, http.MethodGet, "/server/server-id", &response)
	if err != nil {
		return ServerIdentityDTO{}, meta, err
	}
	if normalized, ok := NormalizeServerID(response.ServerID); ok {
		return ServerIdentityDTO{ServerID: normalized}, meta, nil
	}
	if strings.TrimSpace(response.ServerID) == "" {
		if headerID := SafeServerIDHeader(meta.Header); headerID != "" {
			return ServerIdentityDTO{ServerID: headerID}, meta, nil
		}
	}
	return ServerIdentityDTO{}, meta, nil
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
