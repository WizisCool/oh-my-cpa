package management

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

func (c *Client) AuthFiles(ctx context.Context) (AuthFilesResponse, error) {
	response, _, err := c.AuthFilesWithMeta(ctx)
	return response, err
}

func (c *Client) AuthFilesWithMeta(ctx context.Context) (AuthFilesResponse, ResponseMeta, error) {
	var response AuthFilesResponse
	meta, err := c.DoJSONWithMeta(ctx, http.MethodGet, "/auth-files", &response)
	if err != nil {
		return AuthFilesResponse{}, meta, err
	}
	return response, meta, nil
}

func (c *Client) ResetQuota(ctx context.Context, authIndex string) error {
	authIndex = strings.TrimSpace(authIndex)
	if authIndex == "" {
		return errors.New("auth_index is required")
	}
	payload := map[string]string{"auth_index": authIndex}
	return c.doJSONBody(ctx, http.MethodPost, "/reset-quota", payload, nil)
}

// PatchAuthFileStatus changes only the disabled state of a named auth file.
// The endpoint and request shape are fixed here rather than supplied by an
// HTTP caller.
func (c *Client) PatchAuthFileStatus(ctx context.Context, name, authIndex string, disabled bool) (map[string]any, error) {
	payload := map[string]any{
		"name":       strings.TrimSpace(name),
		"auth_index": strings.TrimSpace(authIndex),
		"disabled":   disabled,
	}
	var response map[string]any
	if err := c.doJSONBody(ctx, http.MethodPatch, "/auth-files/status", payload, &response); err != nil {
		return nil, err
	}
	return response, nil
}

// PatchAuthFileFields forwards the explicitly validated auth-file metadata
// fields to CPA's fixed fields endpoint.
func (c *Client) PatchAuthFileFields(ctx context.Context, name string, fields map[string]any) (map[string]any, error) {
	payload := make(map[string]any, len(fields)+1)
	payload["name"] = strings.TrimSpace(name)
	for key, value := range fields {
		payload[key] = value
	}
	var response map[string]any
	if err := c.doJSONBody(ctx, http.MethodPatch, "/auth-files/fields", payload, &response); err != nil {
		return nil, err
	}
	return response, nil
}

// UploadAuthFile uses CPA's documented raw-JSON upload form. The filename is
// query-encoded by this method and the handler validates the JSON before it is
// passed here.
func (c *Client) UploadAuthFile(ctx context.Context, name string, data []byte) (map[string]any, error) {
	query := url.Values{}
	query.Set("name", strings.TrimSpace(name))
	var response map[string]any
	if err := c.doBody(ctx, http.MethodPost, "/auth-files?"+query.Encode(), data, "application/json", &response); err != nil {
		return nil, err
	}
	return response, nil
}

// DeleteAuthFiles deletes the named files through CPA's batch JSON contract.
func (c *Client) DeleteAuthFiles(ctx context.Context, names []string) (map[string]any, error) {
	payload := map[string]any{"names": names}
	var response map[string]any
	if err := c.doJSONBody(ctx, http.MethodDelete, "/auth-files", payload, &response); err != nil {
		return nil, err
	}
	return response, nil
}

// DownloadAuthFile returns raw bytes for one explicitly named JSON auth file.
func (c *Client) DownloadAuthFile(ctx context.Context, name string) ([]byte, ResponseMeta, error) {
	query := url.Values{}
	query.Set("name", strings.TrimSpace(name))
	request, err := c.newRequest(ctx, http.MethodGet, "/auth-files/download?"+query.Encode(), nil, "")
	if err != nil {
		return nil, ResponseMeta{}, err
	}
	return c.doBytes(request, 8*1024*1024)
}

// AuthFileModels reads the model list for one named auth file.
func (c *Client) AuthFileModels(ctx context.Context, name string) ([]AuthModel, error) {
	query := url.Values{}
	query.Set("name", strings.TrimSpace(name))
	var response struct {
		Models []AuthModel `json:"models"`
	}
	if err := c.DoJSON(ctx, http.MethodGet, "/auth-files/models?"+query.Encode(), &response); err != nil {
		return nil, err
	}
	return response.Models, nil
}

type AuthFilesResponse struct {
	Files []AuthFile `json:"files"`
}

type AuthFile struct {
	ID            string `json:"id"`
	AuthIndex     string `json:"auth_index"`
	Name          string `json:"name"`
	Type          string `json:"type"`
	Provider      string `json:"provider"`
	Label         string `json:"label"`
	Status        string `json:"status"`
	StatusMessage string `json:"status_message"`
	Disabled      bool   `json:"disabled"`
	Unavailable   bool   `json:"unavailable"`
	RuntimeOnly   bool   `json:"runtime_only"`
	Source        string `json:"source"`
	Email         string `json:"email"`
	ProjectID     string `json:"project_id"`
	AccountType   string `json:"account_type"`
	Account       string `json:"account"`
	// IDToken carries CPA-projected identity claims (e.g. Codex
	// chatgpt_account_id). It is non-secret metadata used to scope
	// upstream quota queries, never a credential.
	IDToken        json.RawMessage           `json:"id_token,omitempty"`
	Success        int64                     `json:"success"`
	Failed         int64                     `json:"failed"`
	RecentRequests []RecentRequest           `json:"recent_requests"`
	Quota          map[string]any            `json:"quota"`
	ModelQuotas    map[string]map[string]any `json:"model_quotas"`
	Models         []AuthModel               `json:"models"`
	Priority       int                       `json:"priority"`
	Weight         int64                     `json:"weight"`
	Note           string                    `json:"note"`
	CreatedAt      json.RawMessage           `json:"created_at"`
	UpdatedAt      json.RawMessage           `json:"updated_at"`
	LastRefresh    json.RawMessage           `json:"last_refresh"`
}

// CodexChatgptAccountID extracts the ChatGPT account id from CPA-projected
// id_token claims. CPA returns decoded JSON claims (never the raw JWT), and
// older builds omit the field entirely, so every shape degrades to "".
func (f AuthFile) CodexChatgptAccountID() string {
	if len(f.IDToken) == 0 {
		return ""
	}
	var claims map[string]any
	decoder := json.NewDecoder(bytes.NewReader(f.IDToken))
	decoder.UseNumber()
	if err := decoder.Decode(&claims); err != nil || len(claims) == 0 {
		return ""
	}
	for _, key := range []string{"chatgpt_account_id", "chatgptAccountId"} {
		if value, ok := claims[key].(string); ok && strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

// CodexPlanType extracts the plan type from CPA-projected id_token claims
// (e.g. "plus"). Empty when the build does not project the claim.
func (f AuthFile) CodexPlanType() string {
	if len(f.IDToken) == 0 {
		return ""
	}
	var claims map[string]any
	decoder := json.NewDecoder(bytes.NewReader(f.IDToken))
	decoder.UseNumber()
	if err := decoder.Decode(&claims); err != nil || len(claims) == 0 {
		return ""
	}
	for _, key := range []string{"plan_type", "planType"} {
		if value, ok := claims[key].(string); ok && strings.TrimSpace(value) != "" {
			return strings.ToLower(strings.TrimSpace(value))
		}
	}
	return ""
}

// CodexSubscriptionActiveUntil extracts the subscription expiry from
// CPA-projected id_token claims as a Unix-millisecond instant. Zero and false
// mean the build did not project the claim.
func (f AuthFile) CodexSubscriptionActiveUntil() (int64, bool) {
	if len(f.IDToken) == 0 {
		return 0, false
	}
	var claims map[string]any
	decoder := json.NewDecoder(bytes.NewReader(f.IDToken))
	decoder.UseNumber()
	if err := decoder.Decode(&claims); err != nil || len(claims) == 0 {
		return 0, false
	}
	for _, key := range []string{"chatgpt_subscription_active_until", "chatgptSubscriptionActiveUntil", "subscription_active_until", "subscriptionActiveUntil"} {
		value, ok := claims[key]
		if !ok || value == nil {
			continue
		}
		if ms, ok := idTokenInstantToMS(value); ok {
			return ms, true
		}
	}
	return 0, false
}

func idTokenInstantToMS(value any) (int64, bool) {
	switch typed := value.(type) {
	case json.Number:
		if asInt, err := typed.Int64(); err == nil {
			if asInt > 0 && asInt < 100000000000 {
				asInt *= 1000
			}
			if asInt > 0 {
				return asInt, true
			}
		}
		if asFloat, err := typed.Float64(); err == nil && asFloat > 0 {
			if asFloat < 100000000000 {
				asFloat *= 1000
			}
			return int64(asFloat), true
		}
	case float64:
		if typed > 0 {
			if typed < 100000000000 {
				typed *= 1000
			}
			return int64(typed), true
		}
	case int64:
		if typed > 0 {
			if typed < 100000000000 {
				typed *= 1000
			}
			return typed, true
		}
	case string:
		text := strings.TrimSpace(typed)
		if text == "" {
			return 0, false
		}
		if parsed, err := strconv.ParseInt(text, 10, 64); err == nil && parsed > 0 {
			if parsed < 100000000000 {
				parsed *= 1000
			}
			return parsed, true
		}
		for _, layout := range []string{time.RFC3339Nano, time.RFC3339, "2006-01-02T15:04:05"} {
			if instant, err := time.Parse(layout, text); err == nil {
				return instant.UnixMilli(), true
			}
		}
	}
	return 0, false
}

// QuotaTokenPlaceholder is the CPA server-side credential substitution marker.
// CPA replaces it with the stored OAuth access token for auth_index before
// forwarding the request upstream. Sending anything else (or nothing) makes
// CPA forward the request unauthenticated, which is exactly the 401 every
// OAuth refresh was hitting.
const QuotaTokenPlaceholder = "Bearer $TOKEN$"

// WithQuotaCredential returns a copy of headers with the CPA credential marker
// injected unless the caller already set an Authorization value.
func WithQuotaCredential(headers map[string]string) map[string]string {
	return withQuotaCredential(headers)
}

func withQuotaCredential(headers map[string]string) map[string]string {
	out := make(map[string]string, len(headers)+1)
	for key, value := range headers {
		out[key] = value
	}
	for key := range out {
		if strings.EqualFold(strings.TrimSpace(key), "Authorization") {
			return out
		}
	}
	out["Authorization"] = QuotaTokenPlaceholder
	return out
}

type AuthModel struct {
	ID          string `json:"id"`
	DisplayName string `json:"display_name"`
}
