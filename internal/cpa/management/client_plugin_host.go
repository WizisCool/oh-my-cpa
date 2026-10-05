package management

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"path"
	"strings"
)

/**
 * The two CPA surfaces a plugin's own page is made of.
 *
 * A plugin page is a document CPA serves from `/v0/resource/plugins/<id>/`, and the
 * script in it calls the routes that plugin registered under `/v0/management/`. Neither
 * shape belongs to this client: the document and the routes are the plugin's. What this
 * file owns is where such a request may go and what it carries - the resource read never
 * carries the management key, because CPA hands a request's headers to the plugin's
 * handler and the resource routes are unauthenticated by contract.
 */

const (
	// PluginResourcePrefix is where CPA serves the browser-navigable resources of plugins.
	PluginResourcePrefix = "/v0/resource/plugins/"
	// PluginRoutePrefix is where CPA serves the management routes plugins register.
	PluginRoutePrefix = "/v0/management/"
	// PLUGIN_HOST_BODY_LIMIT bounds one plugin page request or response body.
	PLUGIN_HOST_BODY_LIMIT = 32 * 1024 * 1024
)

// coreManagementSegments are the first path segments of CPA's own /v0/management
// routes. A plugin cannot register a route CPA already serves, so a path below one
// of these is never needed to reach a plugin, and it is where the raw, unmasked
// management documents live.
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
	if raw == "" || len(raw) > 2048 || !strings.HasPrefix(raw, "/") || strings.ContainsAny(raw, "\\\x00\r\n") {
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

// PluginRoutePath validates a plugin management route path. A path under one of CPA's
// own management routes is refused.
func PluginRoutePath(raw string) (string, bool) {
	cleaned, ok := cleanPluginHostPath(raw)
	if !ok || !strings.HasPrefix(cleaned, PluginRoutePrefix) {
		return "", false
	}
	segment, _, _ := strings.Cut(strings.TrimPrefix(cleaned, PluginRoutePrefix), "/")
	if segment == "" {
		return "", false
	}
	if _, isCore := coreManagementSegments[strings.ToLower(segment)]; isCore {
		return "", false
	}
	return cleaned, true
}

// PluginResource reads one plugin resource. It is sent without the management key.
func (c *Client) PluginResource(ctx context.Context, resourcePath, rawQuery string, header http.Header) (PluginHostResponse, error) {
	cleaned, _, ok := PluginResourcePath(resourcePath)
	if !ok {
		return PluginHostResponse{}, ErrPluginHostPath
	}
	return c.sendPluginHost(ctx, http.MethodGet, cleaned, rawQuery, header, nil, false)
}

// PluginRoute calls one management route a plugin registered, with the management key.
func (c *Client) PluginRoute(ctx context.Context, method, routePath, rawQuery string, header http.Header, body []byte) (PluginHostResponse, error) {
	cleaned, ok := PluginRoutePath(routePath)
	if !ok {
		return PluginHostResponse{}, ErrPluginHostPath
	}
	return c.sendPluginHost(ctx, method, cleaned, rawQuery, header, body, true)
}

func (c *Client) sendPluginHost(ctx context.Context, method, cleanedPath, rawQuery string, header http.Header, body []byte, isAuthenticated bool) (PluginHostResponse, error) {
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
	for name, values := range header {
		for _, value := range values {
			request.Header.Add(name, value)
		}
	}
	request.Header.Del("Authorization")
	request.Header.Del("X-Management-Key")
	if isAuthenticated {
		request.Header.Set("Authorization", "Bearer "+c.management)
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
