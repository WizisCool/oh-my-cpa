package management

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"mime/multipart"
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
	meta, err := c.DoJSONWithMeta(ctx, http.MethodGet, "/credentials", &response)
	if err != nil {
		return AuthFilesResponse{}, meta, safeCredentialError(err)
	}
	return response, meta, nil
}

func (c *Client) ResetQuota(ctx context.Context, authIndex string) error {
	authIndex = strings.TrimSpace(authIndex)
	if authIndex == "" {
		return errors.New("auth_index is required")
	}
	payload := map[string]string{"auth_index": authIndex}
	return c.doJSONBody(ctx, http.MethodPost, "/routing/cooldown/reset", payload, nil)
}

// PatchAuthFileStatus changes only the disabled state of a named auth file.
// The endpoint and request shape are fixed here rather than supplied by an
// HTTP caller. For a credential that lives in the configuration file CPA saves
// that file in the v8 layout, so the stored one is kept first.
func (c *Client) PatchAuthFileStatus(ctx context.Context, name, authIndex string, disabled bool) (map[string]any, error) {
	if _, err := c.keepStoredConfig(WithBackupReason(ctx, BackupReasonCredentialStatus)); err != nil {
		return nil, err
	}
	payload := map[string]any{
		"name":       strings.TrimSpace(name),
		"auth_index": strings.TrimSpace(authIndex),
		"disabled":   disabled,
	}
	var response map[string]any
	if err := c.doJSONBody(ctx, http.MethodPatch, "/credentials/status", payload, &response); err != nil {
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
	if err := c.doJSONBody(ctx, http.MethodPatch, "/credentials/fields", payload, &response); err != nil {
		return nil, err
	}
	return response, nil
}

// RefreshAuthFile asks CPA to renew one credential's tokens now rather than at
// its next scheduled refresh. CPA answers with the refreshed credential, tokens
// included, so the response body is never decoded: only the outcome leaves here.
func (c *Client) RefreshAuthFile(ctx context.Context, name, authIndex string) error {
	payload := map[string]string{
		"name":       strings.TrimSpace(name),
		"auth_index": strings.TrimSpace(authIndex),
	}
	return c.doJSONBody(ctx, http.MethodPost, "/credentials/refresh", payload, nil)
}

// UploadAuthFile uses CPA's documented raw-JSON upload form. The filename is
// query-encoded by this method and the handler validates the JSON before it is
// passed here.
func (c *Client) UploadAuthFile(ctx context.Context, name string, data []byte) (map[string]any, error) {
	query := url.Values{}
	query.Set("name", strings.TrimSpace(name))
	var response map[string]any
	if err := c.doBody(ctx, http.MethodPost, "/credentials?"+query.Encode(), data, "application/json", &response); err != nil {
		return nil, err
	}
	return response, nil
}

// DeleteAuthFiles deletes the named files through CPA's batch JSON contract.
func (c *Client) DeleteAuthFiles(ctx context.Context, names []string) (map[string]any, error) {
	payload := map[string]any{"names": names}
	var response map[string]any
	if err := c.doJSONBody(ctx, http.MethodDelete, "/credentials", payload, &response); err != nil {
		return nil, err
	}
	return response, nil
}

// DownloadAuthFile returns raw bytes for one explicitly named JSON auth file.
func (c *Client) DownloadAuthFile(ctx context.Context, name string) ([]byte, ResponseMeta, error) {
	query := url.Values{}
	query.Set("name", strings.TrimSpace(name))
	request, err := c.newRequest(ctx, http.MethodGet, "/credentials/download?"+query.Encode(), nil, "")
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
	if err := c.DoJSON(ctx, http.MethodGet, "/credentials/models?"+query.Encode(), &response); err != nil {
		return nil, err
	}
	return response.Models, nil
}

// VERTEX_OPENAPI_FIELDS are the credential metadata keys CPA reads only for a
// Vertex service account's OpenAPI route to partner and open models.
var VERTEX_OPENAPI_FIELDS = []string{"openapi", "openapi_location", "openapi_models"}

// IsVertexServiceAccount reports whether the credential is a file-backed Vertex
// service account, the only kind whose metadata carries the OpenAPI overrides.
// Vertex API keys are configuration, not credential files.
func (f AuthFile) IsVertexServiceAccount() bool {
	return strings.EqualFold(strings.TrimSpace(f.Provider), "vertex") || strings.EqualFold(strings.TrimSpace(f.Type), "vertex")
}

type AuthFilesResponse struct {
	Files []AuthFile `json:"files"`
}

// SIWCSummary contains local state and configuration facts, never token material.
// A missing support field is deliberately indistinguishable from false.
type SIWCSummary struct {
	SIWCStatus        string `json:"siwc_status,omitempty"`
	SIWCBindSupported bool   `json:"siwc_bind_supported"`
	UseSIWC           bool   `json:"use_siwc"`
	SIWCBound         bool   `json:"siwc_bound"`
	SIWCExpiresAt     string `json:"siwc_expires_at,omitempty"`
}

func (s SIWCSummary) SafeSIWCSummary() SIWCSummary {
	switch s.SIWCStatus {
	case "off", "valid", "invalid":
	default:
		s.SIWCStatus = ""
	}
	if expiry, err := time.Parse(time.RFC3339, s.SIWCExpiresAt); err == nil {
		s.SIWCExpiresAt = expiry.UTC().Format(time.RFC3339)
	} else {
		s.SIWCExpiresAt = ""
	}
	return s
}

type AuthFile struct {
	CredentialRecoverySummary
	SIWCSummary
	ID        string `json:"id"`
	AuthIndex string `json:"auth_index"`
	Name      string `json:"name"`
	Type      string `json:"type"`
	Provider  string `json:"provider"`
	Prefix    string `json:"prefix,omitempty"`
	// OAuthProvider is the login entry that issued the credential, for a plugin
	// that declares several (Harbor and Harbor CN share the type "harbor"). Gateways
	// that do not report it leave it empty.
	OAuthProvider            string `json:"oauth_provider,omitempty"`
	Label                    string `json:"label"`
	Status                   string `json:"status"`
	StatusMessage            string `json:"status_message"`
	TOSAppealURL             string `json:"tos_appeal_url,omitempty"`
	TOSAppealURLText         string `json:"tos_appeal_url_text,omitempty"`
	Disabled                 bool   `json:"disabled"`
	Unavailable              bool   `json:"unavailable"`
	unavailableOmitted       bool
	NextRetryAfter           string `json:"next_retry_after,omitempty"`
	hasInvalidNextRetryAfter bool
	RuntimeOnly              bool   `json:"runtime_only"`
	Source                   string `json:"source"`
	Email                    string `json:"email"`
	ProjectID                string `json:"project_id"`
	AccountType              string `json:"account_type"`
	Account                  string `json:"account"`
	// IDToken carries CPA-projected identity claims (e.g. Codex
	// chatgpt_account_id). It is non-secret metadata used to scope
	// upstream quota queries, never a credential.
	IDToken        json.RawMessage `json:"id_token,omitempty"`
	Success        int64           `json:"success"`
	Failed         int64           `json:"failed"`
	RecentRequests []RecentRequest `json:"recent_requests"`
	Quota          map[string]any  `json:"quota"`
	// SupportsQuota and QuotaProvider are CPA's quota advertisement for this
	// credential: set when a built-in or plugin quota provider claims it.
	// QuotaPluginID names the plugin CPA itself selected to serve that quota
	// (CPA v8.0.25+); it already skips fused plugins in favour of a healthy one.
	// QuotaProbe carries a declarative quota_probe credential, which has no v8
	// management route and is reported as unsupported rather than fetched;
	// CPA v8.0.25+ no longer advertises it on v8 lists.
	SupportsQuota bool                      `json:"supports_quota,omitempty"`
	QuotaProvider string                    `json:"quota_provider,omitempty"`
	QuotaPluginID string                    `json:"quota_plugin_id,omitempty"`
	QuotaProbe    json.RawMessage           `json:"quota_probe,omitempty"`
	ModelQuotas   map[string]map[string]any `json:"model_quotas"`
	Models        []AuthModel               `json:"models"`
	Priority      int                       `json:"priority"`
	// Weight is absent when the credential states none, which CPA runs as 1; an
	// explicit 0 instead excludes it from weighted routing, so the two differ.
	Weight      *int64          `json:"weight"`
	Note        string          `json:"note"`
	CreatedAt   json.RawMessage `json:"created_at"`
	UpdatedAt   json.RawMessage `json:"updated_at"`
	LastRefresh json.RawMessage `json:"last_refresh"`
}

// UnmarshalJSON distinguishes an explicit JSON `"unavailable": false` from an
// omitted or null field so sparse payloads cannot falsely claim availability,
// and decodes `next_retry_after` tolerantly so non-string representations never
// fail the entire credential list.
func (f *AuthFile) UnmarshalJSON(data []byte) error {
	type authFileAlias AuthFile
	var decoded struct {
		authFileAlias
		RawUnavailable    *bool           `json:"unavailable"`
		RawNextRetryAfter json.RawMessage `json:"next_retry_after"`
	}
	if err := json.Unmarshal(data, &decoded); err != nil {
		return err
	}
	result := AuthFile(decoded.authFileAlias)
	if decoded.RawUnavailable != nil {
		result.Unavailable = *decoded.RawUnavailable
		result.unavailableOmitted = false
	} else {
		result.Unavailable = false
		result.unavailableOmitted = true
	}
	if raw := bytes.TrimSpace(decoded.RawNextRetryAfter); len(raw) > 0 && !bytes.Equal(raw, []byte("null")) {
		var text string
		if err := json.Unmarshal(raw, &text); err == nil {
			result.NextRetryAfter = strings.TrimSpace(text)
		} else {
			decoder := json.NewDecoder(bytes.NewReader(raw))
			decoder.UseNumber()
			var value any
			if err := decoder.Decode(&value); err == nil {
				if num, ok := value.(json.Number); ok {
					if ms, ok := idTokenInstantToMS(num); ok {
						result.NextRetryAfter = time.UnixMilli(ms).UTC().Format(time.RFC3339Nano)
					} else {
						result.hasInvalidNextRetryAfter = true
					}
				} else {
					result.hasInvalidNextRetryAfter = true
				}
			} else {
				result.hasInvalidNextRetryAfter = true
			}
		}
	}
	*f = result
	return nil
}

// HasClearedCredentialCooldown reports whether CPA's live auth-file projection
// affirmatively shows that this credential is not under an active
// credential-level cooldown. CPA's reconcileAuthFileCooldownState always sets
// status="error" and unavailable=true (with next_retry_after for timed blocks)
// while any credential-level cooldown is active, and restores status="active"
// with unavailable=false and no future next_retry_after once it is lifted
// (even when an independent per-model cooldown still remains).
//
// Sparse payloads that omit status or unavailable, or credentials marked
// disabled or requiring sign-in, do not make this claim and return false.
func (f AuthFile) HasClearedCredentialCooldown(now time.Time) bool {
	if f.Disabled || f.Unavailable || f.unavailableOmitted || f.hasInvalidNextRetryAfter {
		return false
	}
	if f.RequiresSignIn != nil && *f.RequiresSignIn {
		return false
	}
	if !strings.EqualFold(strings.TrimSpace(f.Status), "active") {
		return false
	}
	if raw := strings.TrimSpace(f.NextRetryAfter); raw != "" {
		retryAt, err := time.Parse(time.RFC3339Nano, raw)
		if err != nil || retryAt.After(now) {
			return false
		}
	}
	return true
}

func (f AuthFile) idTokenClaims() map[string]any {
	if len(f.IDToken) == 0 {
		return nil
	}
	var claims map[string]any
	decoder := json.NewDecoder(bytes.NewReader(f.IDToken))
	decoder.UseNumber()
	if err := decoder.Decode(&claims); err == nil && len(claims) > 0 {
		return flattenIDTokenClaims(claims)
	}
	var rawJWT string
	if err := json.Unmarshal(f.IDToken, &rawJWT); err != nil {
		return nil
	}
	return decodeJWTClaims(rawJWT)
}

func decodeJWTClaims(rawJWT string) map[string]any {
	parts := strings.Split(strings.TrimSpace(rawJWT), ".")
	if len(parts) != 3 || parts[1] == "" {
		return nil
	}
	payload, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(parts[1], "="))
	if err != nil || len(payload) == 0 {
		return nil
	}
	var claims map[string]any
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.UseNumber()
	if err := decoder.Decode(&claims); err != nil || len(claims) == 0 {
		return nil
	}
	return flattenIDTokenClaims(claims)
}

// flattenIDTokenClaims lifts OpenAI's nested auth claim object onto the top-level
// map so callers read the same claim names whether CPA projected flat fields or
// forwarded the raw JWT payload.
func flattenIDTokenClaims(claims map[string]any) map[string]any {
	nested, ok := claims["https://api.openai.com/auth"].(map[string]any)
	if !ok || len(nested) == 0 {
		return claims
	}
	merged := make(map[string]any, len(claims)+len(nested))
	for k, v := range claims {
		merged[k] = v
	}
	for k, v := range nested {
		merged[k] = v
	}
	return merged
}

// CodexChatgptAccountID extracts the ChatGPT account id from CPA-projected
// id_token claims or a raw JWT string. Older builds omit the field entirely, so
// every unrecognized shape degrades to "".
func (f AuthFile) CodexChatgptAccountID() string {
	claims := f.idTokenClaims()
	if claims == nil {
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
	claims := f.idTokenClaims()
	if claims == nil {
		return ""
	}
	for _, key := range []string{"plan_type", "planType", "chatgpt_plan_type"} {
		if value, ok := claims[key].(string); ok && strings.TrimSpace(value) != "" {
			return strings.ToLower(strings.TrimSpace(value))
		}
	}
	return ""
}

// CodexSubscriptionActiveStart extracts the subscription start from
// CPA-projected id_token claims as a Unix-millisecond instant. Zero and false
// mean the build did not project the claim.
func (f AuthFile) CodexSubscriptionActiveStart() (int64, bool) {
	return f.idTokenInstant("chatgpt_subscription_active_start", "chatgptSubscriptionActiveStart", "subscription_active_start", "subscriptionActiveStart")
}

// CodexSubscriptionActiveUntil extracts the subscription expiry from
// CPA-projected id_token claims as a Unix-millisecond instant. Zero and false
// mean the build did not project the claim.
func (f AuthFile) CodexSubscriptionActiveUntil() (int64, bool) {
	return f.idTokenInstant("chatgpt_subscription_active_until", "chatgptSubscriptionActiveUntil", "subscription_active_until", "subscriptionActiveUntil")
}

func (f AuthFile) idTokenInstant(keys ...string) (int64, bool) {
	claims := f.idTokenClaims()
	if claims == nil {
		return 0, false
	}
	for _, key := range keys {
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

// VertexImportResult is what CPA reports about a stored Vertex service account.
type VertexImportResult struct {
	// AuthFile is the path CPA saved to, on CPA's own filesystem.
	AuthFile  string `json:"auth-file"`
	ProjectID string `json:"project_id"`
	Email     string `json:"email"`
	Location  string `json:"location"`
}

// ImportVertexCredential hands a Google service-account key to CPA, which wraps it
// as a Vertex credential named after the key's project. CPA only reads this route
// as a multipart form, so the key travels as the form's `file` part.
func (c *Client) ImportVertexCredential(ctx context.Context, serviceAccount []byte, location string) (VertexImportResult, error) {
	var body bytes.Buffer
	form := multipart.NewWriter(&body)
	part, err := form.CreateFormFile("file", "service-account.json")
	if err != nil {
		return VertexImportResult{}, err
	}
	if _, err = part.Write(serviceAccount); err != nil {
		return VertexImportResult{}, err
	}
	if location = strings.TrimSpace(location); location != "" {
		if err = form.WriteField("location", location); err != nil {
			return VertexImportResult{}, err
		}
	}
	if err = form.Close(); err != nil {
		return VertexImportResult{}, err
	}
	var result VertexImportResult
	if err = c.doBody(ctx, http.MethodPost, "/oauth/import?provider=vertex", body.Bytes(), form.FormDataContentType(), &result); err != nil {
		return VertexImportResult{}, err
	}
	return result, nil
}
