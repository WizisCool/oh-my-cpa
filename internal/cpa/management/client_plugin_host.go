package management

import (
	"bytes"
	"context"
	"crypto/subtle"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"path"
	"strings"
	"unicode"
)

// Trusted installed pages use CPA's native management contract. This is a bounded
// exception to the ordinary facade's DTO projection: only this instance's fixed
// management trees and model directory are reachable (ADR 0067).

const (
	// PluginResourcePrefix is where CPA serves the browser-navigable resources of plugins.
	PluginResourcePrefix = "/v0/resource/plugins/"
	// PluginRoutePrefix is where CPA serves the management routes plugins register.
	PluginRoutePrefix   = "/v0/management/"
	PluginRouteV8Prefix = "/v8/management/"
	PluginModelsPath    = "/v1/models"
	// PLUGIN_HOST_BODY_LIMIT bounds one plugin page request or response body.
	PLUGIN_HOST_BODY_LIMIT = 32 * 1024 * 1024
)

// coreManagementSegments classify native v0 writes that may save CPA's config.
// Plugin namespaces share /plugins with core operations; their deeper routes are
// classified separately so an evaluation does not acquire the config write gate.
var coreManagementSegments = map[string]struct{}{
	"anthropic-auth-url": {}, "antigravity-auth-url": {}, "api-call": {}, "api-key-usage": {},
	"api-keys": {}, "auth-files": {}, "claude-api-key": {}, "codex-api-key": {},
	"codex-auth-url": {}, "config": {}, "config.yaml": {}, "debug": {}, "devin-auth-url": {},
	"error-logs-max-files": {}, "force-model-prefix": {}, "gemini-api-key": {},
	"get-auth-status": {}, "interactions-api-key": {}, "kimi-ai-auth-url": {},
	"kimi-auth-url": {}, "latest-version": {}, "logging-to-file": {}, "logs": {},
	"logs-max-total-size-mb": {}, "max-retry-credentials": {}, "max-retry-interval": {},
	"meta-api-key": {}, "meta-auth-url": {}, "model-definitions": {},
	"oauth-excluded-models": {}, "oauth-model-alias": {}, "oauth-request-scoped-errors": {},
	"oauth-session": {}, "openai-compatibility": {}, "plugin-store": {}, "plugins": {},
	"proxy-url": {}, "quota": {}, "quota-exceeded": {}, "request-error-logs": {},
	"request-log": {}, "request-log-by-id": {}, "request-retry": {}, "reset-quota": {},
	"routing": {}, "usage-queue": {}, "usage-statistics-enabled": {}, "vertex": {},
	"vertex-api-key": {}, "ws-auth": {}, "xai-api-key": {}, "xai-auth-url": {},
}

// ErrPluginHostPath marks a path that is not a plugin resource or a plugin route.
var ErrPluginHostPath = errors.New("not a plugin resource or plugin route path")

// PluginHostResponse is what a plugin answered, whatever its status.
type PluginHostResponse struct {
	StatusCode int
	Header     http.Header
	Body       []byte
}

func cleanPluginHostPath(raw string) (string, bool) {
	if raw == "" || len(raw) > 2048 || !strings.HasPrefix(raw, "/") || strings.ContainsAny(raw, "\\") || strings.IndexFunc(raw, unicode.IsControl) >= 0 {
		return "", false
	}
	trimmed := strings.TrimRight(raw, "/")
	if trimmed == "" || path.Clean(trimmed) != trimmed {
		return "", false
	}
	return trimmed, true
}

// PluginResourcePath validates a plugin resource path and returns it with the id of
// the plugin that owns it.
func PluginResourcePath(raw string) (resourcePath, pluginID string, ok bool) {
	cleaned, ok := cleanPluginHostPath(raw)
	if !ok || !strings.HasPrefix(cleaned, PluginResourcePrefix) {
		return "", "", false
	}
	pluginID, rest, found := strings.Cut(strings.TrimPrefix(cleaned, PluginResourcePrefix), "/")
	if !found || pluginID == "" || rest == "" {
		return "", "", false
	}
	return cleaned, pluginID, true
}

// PluginRoutePath permits the native management trees, but never CPA's arbitrary
// outbound api-call bridge. The target cannot be chosen as a URL or another origin.
func PluginRoutePath(raw string) (string, bool) {
	cleaned, ok := cleanPluginHostPath(raw)
	if !ok {
		return "", false
	}
	for _, prefix := range []string{PluginRoutePrefix, PluginRouteV8Prefix} {
		if !strings.HasPrefix(cleaned, prefix) {
			continue
		}
		relative := strings.ToLower(strings.TrimPrefix(cleaned, prefix))
		blocked := "api-call"
		if prefix == PluginRouteV8Prefix {
			blocked = "requests/api-call"
		}
		if relative == "" || relative == blocked || strings.HasPrefix(relative, blocked+"/") {
			return "", false
		}
		return cleaned, true
	}
	return "", false
}

// IsPluginHostNativeWrite identifies writes that must participate in the console's
// configuration serialization and backup contract, not just native config PUTs.
func IsPluginHostNativeWrite(method, routePath string) bool {
	if method == http.MethodGet || method == http.MethodHead {
		return false
	}
	if strings.HasPrefix(routePath, PluginRouteV8Prefix) {
		return true
	}
	parts := strings.Split(strings.ToLower(strings.TrimPrefix(routePath, PluginRoutePrefix)), "/")
	if parts[0] == "plugins" && len(parts) >= 3 {
		return parts[1] == "store" || parts[2] == "enabled" || parts[2] == "config" || parts[2] == "quota"
	}
	_, isNative := coreManagementSegments[parts[0]]
	return isNative
}

// PluginResource reads one plugin resource. It is sent without the management key.
func (c *Client) PluginResource(ctx context.Context, resourcePath, rawQuery string, header http.Header) (PluginHostResponse, error) {
	cleaned, _, ok := PluginResourcePath(resourcePath)
	if !ok {
		return PluginHostResponse{}, ErrPluginHostPath
	}
	return c.sendPluginHost(ctx, http.MethodGet, cleaned, rawQuery, header, nil, pluginHostResourceAuth)
}

// pluginHostManagementCredential reads a page's management credential with CPA's
// own precedence: a Bearer Authorization, else the raw Authorization value, else
// X-Management-Key. isExplicit is true when either header was sent, even empty.
func pluginHostManagementCredential(header http.Header) (credential string, isExplicit bool) {
	_, hasAuthorization := header["Authorization"]
	_, hasManagementKey := header["X-Management-Key"]
	credential = header.Get("Authorization")
	if scheme, token, found := strings.Cut(credential, " "); found && strings.EqualFold(scheme, "bearer") {
		credential = token
	}
	if credential == "" {
		credential = header.Get("X-Management-Key")
	}
	return credential, hasAuthorization || hasManagementKey
}

// refusedPluginHostCredential answers a wrong page credential in CPA's wire shape.
func refusedPluginHostCredential(credential string) PluginHostResponse {
	message := "invalid management key"
	if credential == "" {
		message = "missing management key"
	}
	return PluginHostResponse{
		StatusCode: http.StatusUnauthorized,
		Header:     http.Header{"Content-Type": {"application/json; charset=utf-8"}},
		Body:       []byte(`{"error":"` + message + `"}`),
	}
}

// PluginRoute judges an explicit page credential here and never sends it to CPA.
// CPA counts failed management authentications per client address and bans the
// address; every hosted page shares this process's address, so a key mistyped
// into a plugin's own prompt would otherwise lock the whole console out of CPA.
// A page that sends no credential acts with the session's stored key.
func (c *Client) PluginRoute(ctx context.Context, method, routePath, rawQuery string, header http.Header, body []byte) (PluginHostResponse, error) {
	cleaned, ok := PluginRoutePath(routePath)
	if !ok {
		return PluginHostResponse{}, ErrPluginHostPath
	}
	if c == nil {
		return PluginHostResponse{}, errors.New("CPA client is not initialized")
	}
	if credential, isExplicit := pluginHostManagementCredential(header); isExplicit && subtle.ConstantTimeCompare([]byte(credential), []byte(c.management)) != 1 {
		return refusedPluginHostCredential(credential), nil
	}
	if IsPluginHostNativeWrite(method, cleaned) {
		if _, err := c.keepStoredConfig(WithBackupReason(ctx, BackupReasonConfigChanges)); err != nil {
			return PluginHostResponse{}, err
		}
	}
	return c.sendPluginHost(ctx, method, cleaned, rawQuery, header, body, pluginHostManagementAuth)
}

// PluginModels exposes only the fixed directory read, using the caller's gateway
// credential. A management key must never be substituted for a missing client key.
func (c *Client) PluginModels(ctx context.Context, rawQuery string, header http.Header) (PluginHostResponse, error) {
	return c.sendPluginHost(ctx, http.MethodGet, PluginModelsPath, rawQuery, header, nil, pluginHostGatewayAuth)
}

type pluginHostAuth uint8

const (
	pluginHostResourceAuth pluginHostAuth = iota
	pluginHostManagementAuth
	pluginHostGatewayAuth
)

func (c *Client) sendPluginHost(ctx context.Context, method, cleanedPath, rawQuery string, header http.Header, body []byte, authentication pluginHostAuth) (PluginHostResponse, error) {
	if c == nil {
		return PluginHostResponse{}, errors.New("CPA client is not initialized")
	}
	if err := c.requireManagementV8(ctx); err != nil {
		return PluginHostResponse{}, err
	}
	target := c.baseURL + (&url.URL{Path: cleanedPath, RawQuery: rawQuery}).String()
	var reader io.Reader
	if len(body) > 0 {
		reader = bytes.NewReader(body)
	}
	request, err := http.NewRequestWithContext(ctx, method, target, reader)
	if err != nil {
		return PluginHostResponse{}, fmt.Errorf("create CPA request: %w", err)
	}
	for _, name := range []string{"Accept", "Accept-Language", "Content-Type", "If-None-Match", "If-Modified-Since"} {
		for _, value := range header.Values(name) {
			request.Header.Add(name, value)
		}
	}
	switch authentication {
	case pluginHostManagementAuth:
		// Always the stored key: a page's own header is judged in PluginRoute and
		// must not reach CPA's failed-attempt counter.
		request.Header.Set("Authorization", "Bearer "+c.management)
	case pluginHostGatewayAuth:
		if values, exists := header["Authorization"]; exists {
			request.Header["Authorization"] = append([]string(nil), values...)
		}
	}
	// A redirect is the plugin's answer to the browser, not somewhere this process goes.
	client := *c.httpClient
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	response, err := client.Do(request)
	if err != nil {
		return PluginHostResponse{}, fmt.Errorf("CPA request failed: %w", err)
	}
	defer response.Body.Close()
	data, err := io.ReadAll(io.LimitReader(response.Body, PLUGIN_HOST_BODY_LIMIT+1))
	if err != nil {
		return PluginHostResponse{}, fmt.Errorf("read CPA response: %w", err)
	}
	if len(data) > PLUGIN_HOST_BODY_LIMIT {
		return PluginHostResponse{}, fmt.Errorf("CPA response exceeds %d bytes", PLUGIN_HOST_BODY_LIMIT)
	}
	return PluginHostResponse{StatusCode: response.StatusCode, Header: response.Header.Clone(), Body: data}, nil
}
