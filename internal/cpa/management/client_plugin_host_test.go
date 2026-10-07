package management

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestPluginResourcePathAcceptsOnlyAPluginsOwnTree(t *testing.T) {
	cases := []struct {
		raw      string
		pluginID string
		ok       bool
	}{
		{"/v0/resource/plugins/logger/console", "logger", true},
		{"/v0/resource/plugins/logger/assets/app.js", "logger", true},
		{"/v0/resource/plugins/logger", "", false},
		{"/v0/resource/plugins//console", "", false},
		{"/v0/resource/plugins/logger/../other/console", "", false},
		{"/v0/resource/plugins/logger/a\\b", "", false},
		{"/v0/resource/plugins/logger/a\x00b", "", false},
		{"/v0/management/config", "", false},
		{"v0/resource/plugins/logger/console", "", false},
		{"https://elsewhere.example/v0/resource/plugins/logger/console", "", false},
	}
	for _, tc := range cases {
		_, pluginID, ok := PluginResourcePath(tc.raw)
		if ok != tc.ok || (ok && pluginID != tc.pluginID) {
			t.Errorf("PluginResourcePath(%q) = (%q, %v), want (%q, %v)", tc.raw, pluginID, ok, tc.pluginID, tc.ok)
		}
	}
}

func TestPluginRoutePathPermitsNativeTreesButRefusesArbitraryTargets(t *testing.T) {
	allowed := []string{
		"/v0/management/config",
		"/v0/management/auth-files/models",
		"/v0/management/plugins/example/state",
		"/v8/management/config/api-keys",
		"/v8/management/credentials",
		"/v0/management/clinepassbridge",
		"/v0/management/clinepassbridge/accounts/1",
		"/v0/management/logger/status",
	}
	for _, raw := range allowed {
		if _, ok := PluginRoutePath(raw); !ok {
			t.Errorf("PluginRoutePath(%q) refused a plugin route", raw)
		}
	}
	refused := []string{
		"/v8/management/requests/api-call",
		"/v8/management/REQUESTS/API-CALL/nested",
		"/v0/management/API-CALL/anything",
		"/v1/models",
		"https://outside.example/v0/management/config",
		"/v8/management/config/../requests/api-call",
		"/v8/management/config/a\tb",
		"/v0/management/api-call",
		"/v0/management/",
		"/v0/management/logger/../config",
		"/v0/management/logger//status",
		"/v0/resource/plugins/logger/console",
	}
	for _, raw := range refused {
		if routePath, ok := PluginRoutePath(raw); ok {
			t.Errorf("PluginRoutePath(%q) = %q, want it refused", raw, routePath)
		}
	}
}

func TestPluginHostNativeWriteClassification(t *testing.T) {
	for _, route := range []string{"/v0/management/config.yaml", "/v0/management/api-keys", "/v0/management/auth-files/status", "/v0/management/plugins/example", "/v0/management/plugins/example/config", "/v0/management/plugins/example/enabled", "/v0/management/plugins/store/example/install", "/v8/management/config/api-keys", "/v8/management/credentials/status"} {
		if !IsPluginHostNativeWrite("PATCH", route) {
			t.Errorf("native write not classified: %s", route)
		}
		if IsPluginHostNativeWrite("GET", route) || IsPluginHostNativeWrite("HEAD", route) {
			t.Errorf("read classified as write: %s", route)
		}
	}
	for _, route := range []string{"/v0/management/plugins/example/credentials/sync", "/v0/management/plugins/example/run", "/v0/management/example/run"} {
		if IsPluginHostNativeWrite("POST", route) {
			t.Errorf("plugin action classified as native config write: %s", route)
		}
	}
}

func TestPluginHostTransportKeepsCredentialsOnTheirSurface(t *testing.T) {
	var calls []struct{ path, authorization, managementKey, cookie, query string }
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path == "/v8/management/config/config-version" {
			writer.Write([]byte("8"))
			return
		}
		calls = append(calls, struct{ path, authorization, managementKey, cookie, query string }{request.URL.Path, request.Header.Get("Authorization"), request.Header.Get("X-Management-Key"), request.Header.Get("Cookie"), request.URL.RawQuery})
		writer.Header().Set("Set-Cookie", "upstream=1")
		writer.WriteHeader(http.StatusOK)
		writer.Write([]byte(`{"status":"ok"}`))
	}))
	defer server.Close()
	client, err := NewClient(server.URL, "synthetic-server-key", time.Second, false)
	if err != nil {
		t.Fatal(err)
	}
	callerHeaders := http.Header{"Authorization": {"Bearer caller-key"}, "X-Management-Key": {"explicit-management-key"}, "Cookie": {"console=session"}}
	if _, err := client.PluginResource(context.Background(), "/v0/resource/plugins/example/ui", "q=one%20two", callerHeaders); err != nil {
		t.Fatal(err)
	}
	if _, err := client.PluginRoute(context.Background(), http.MethodGet, "/v0/management/plugins/example/state", "q=one%20two", callerHeaders, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := client.PluginModels(context.Background(), "q=one%20two", callerHeaders); err != nil {
		t.Fatal(err)
	}
	if len(calls) != 3 {
		t.Fatalf("surface calls=%#v", calls)
	}
	if calls[0].authorization != "" || calls[0].managementKey != "" || calls[0].cookie != "" {
		t.Fatalf("resource leaked credentials: %#v", calls[0])
	}
	if calls[1].authorization != "Bearer caller-key" || calls[1].managementKey != "explicit-management-key" || calls[1].cookie != "" {
		t.Fatalf("management call replaced credentials: %#v", calls[1])
	}
	if calls[2].authorization != "Bearer caller-key" || calls[2].managementKey != "" || calls[2].cookie != "" {
		t.Fatalf("gateway call leaked management credentials: %#v", calls[2])
	}
	for _, call := range calls {
		if call.query != "q=one%20two" {
			t.Fatalf("query changed: %#v", call)
		}
	}
}

func TestPluginHostTransportNeverFollowsRedirects(t *testing.T) {
	var hasFollowed bool
	target := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) { hasFollowed = true }))
	defer target.Close()
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path == "/v8/management/config/config-version" {
			writer.Write([]byte("8"))
			return
		}
		writer.Header().Set("Location", target.URL+"/capture")
		writer.WriteHeader(http.StatusTemporaryRedirect)
	}))
	defer server.Close()
	client, err := NewClient(server.URL, "synthetic-server-key", time.Second, false)
	if err != nil {
		t.Fatal(err)
	}
	response, err := client.PluginRoute(context.Background(), http.MethodGet, "/v8/management/config", "", nil, nil)
	if err != nil || response.StatusCode != http.StatusTemporaryRedirect || hasFollowed {
		t.Fatalf("redirect followed or lost: response=%#v followed=%v err=%v", response, hasFollowed, err)
	}
}

func TestPluginHostNativeWriteRefusesWithoutLegacyBackup(t *testing.T) {
	writes := 0
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		switch {
		case request.URL.Path == "/v8/management/config/config-version":
			writer.Write([]byte("8"))
		case request.Method == http.MethodGet && request.URL.Path == "/v0/management/config.yaml":
			writer.Write([]byte("port: 8317\napi-keys: []\n"))
		default:
			writes++
			writer.Write([]byte(`{"status":"ok"}`))
		}
	}))
	defer server.Close()
	client, err := NewClient(server.URL, "synthetic-server-key", time.Second, false)
	if err != nil {
		t.Fatal(err)
	}
	_, err = client.PluginRoute(context.Background(), http.MethodPatch, "/v8/management/config", "", nil, []byte(`{"observability":{"logs":{"debug":true}}}`))
	if !errors.Is(err, ErrConfigBackupUnavailable) || writes != 0 {
		t.Fatalf("legacy config written without a backup: writes=%d err=%v", writes, err)
	}
}

func TestPluginHostTransportBoundsResponseBodies(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path == "/v8/management/config/config-version" {
			writer.Write([]byte("8"))
			return
		}
		chunk := strings.Repeat("x", 1024*1024)
		for i := 0; i < 33; i++ {
			if _, err := io.WriteString(writer, chunk); err != nil {
				return
			}
		}
	}))
	defer server.Close()
	client, err := NewClient(server.URL, "synthetic-server-key", time.Second*5, false)
	if err != nil {
		t.Fatal(err)
	}
	response, err := client.PluginResource(context.Background(), "/v0/resource/plugins/example/large", "", nil)
	if err == nil || !strings.Contains(err.Error(), "exceeds") || len(response.Body) != 0 {
		t.Fatalf("oversized body returned: bytes=%d err=%v", len(response.Body), err)
	}
}
