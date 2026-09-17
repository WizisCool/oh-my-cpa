package management

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestConfigAPIKeysReadsEachFamilySection(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		switch request.URL.Path {
		case "/v0/management/meta-api-key":
			_, _ = writer.Write([]byte(`{"meta-api-key":[{"api-key":"meta-key","auth-index":"m1","base-url":"https://api.meta.ai/v1"}]}`))
		case "/v0/management/claude-api-key":
			_, _ = writer.Write([]byte(`{"claude-api-key":null}`))
		case "/v0/management/gemini-api-key":
			_, _ = writer.Write([]byte(`{"gemini-api-key":[]}`))
		case "/v0/management/codex-api-key":
			// A gateway that omits an empty family has said nothing about it;
			// that is not an error and must not fail a reader that walks every
			// family at once.
			_, _ = writer.Write([]byte(`{}`))
		default:
			writer.WriteHeader(http.StatusNotFound)
			_, _ = writer.Write([]byte(`{"error":"not found"}`))
		}
	}))
	defer server.Close()

	client, err := NewClient(server.URL, "management-secret", time.Second, false)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()

	entries, err := client.ConfigAPIKeys(ctx, ConfigFamilyMeta)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || entries[0].APIKey != "meta-key" || entries[0].AuthIndex != "m1" {
		t.Fatalf("meta entries = %#v", entries)
	}

	// Both "null" and "[]" mean a family with no credentials; neither is an
	// error, and both normalize to an empty list rather than a nil slice.
	for _, family := range []ConfigKeyFamily{ConfigFamilyClaude, ConfigFamilyGemini, ConfigFamilyCodex} {
		entries, err := client.ConfigAPIKeys(ctx, family)
		if err != nil {
			t.Fatalf("%s: %v", family, err)
		}
		if entries == nil || len(entries) != 0 {
			t.Fatalf("%s entries = %#v, want an empty list", family, entries)
		}
	}

	if family := ConfigFamilyMeta.ConfigSection(); family != "meta-api-key" {
		t.Fatalf("meta section = %q", family)
	}
}

func TestConfigAPIKeysReportsAMissingFamilyAsAMissingCapability(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		// A CPA release older than the family answers 404, which the console has
		// to read as "this gateway does not have it" rather than as an empty or
		// broken credential list.
		writer.WriteHeader(http.StatusNotFound)
		_, _ = writer.Write([]byte(`{"error":"not found"}`))
	}))
	defer server.Close()

	client, err := NewClient(server.URL, "management-secret", time.Second, false)
	if err != nil {
		t.Fatal(err)
	}
	_, err = client.ConfigAPIKeys(context.Background(), ConfigFamilyMeta)
	if err == nil {
		t.Fatal("expected an error for a missing family")
	}
	if !IsMissingCapability(err) {
		t.Fatalf("expected a missing-capability error, got %v", err)
	}

	var httpErr *HTTPError
	if !errors.As(err, &httpErr) {
		t.Fatalf("expected an HTTPError, got %T", err)
	}
	if httpErr.Body == "" || strings.Contains(httpErr.Body, "management-secret") {
		t.Fatalf("error body must be kept but never contain the key: %q", httpErr.Body)
	}

	// A real gateway failure is not a missing capability.
	if IsMissingCapability(errors.New("connection refused")) {
		t.Fatal("a transport failure must not be reported as a missing capability")
	}
}

func TestUpdateConfigAPIKeysSendsABareArray(t *testing.T) {
	var path string
	var body string
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		path = request.URL.Path
		buf := make([]byte, request.ContentLength)
		_, _ = request.Body.Read(buf)
		body = string(buf)
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write([]byte(`{"status":"ok"}`))
	}))
	defer server.Close()

	client, err := NewClient(server.URL, "management-secret", time.Second, false)
	if err != nil {
		t.Fatal(err)
	}
	if err := client.UpdateConfigAPIKeys(context.Background(), ConfigFamilyMeta, nil); err != nil {
		t.Fatal(err)
	}
	if path != "/v0/management/meta-api-key" {
		t.Fatalf("path = %q", path)
	}
	// CPA rejects `null`; a cleared family has to be sent as an empty array.
	if strings.TrimSpace(body) != "[]" {
		t.Fatalf("body = %q, want []", body)
	}
}

func TestOAuthAuthURLSendsTheLoopbackFlagOnlyWhereItApplies(t *testing.T) {
	queries := map[string]string{}
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		provider := strings.TrimSuffix(strings.TrimPrefix(request.URL.Path, "/v0/management/"), "-auth-url")
		queries[provider] = request.URL.Query().Get("is_webui")
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write([]byte(`{"status":"ok","url":"https://auth.example.test/authorize","state":"st-1"}`))
	}))
	defer server.Close()

	client, err := NewClient(server.URL, "management-secret", time.Second, false)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	for _, provider := range []string{"codex", "anthropic", "antigravity", "xai", "devin", "kimi", "meta", "some-plugin"} {
		if _, err := client.OAuthAuthURL(ctx, provider); err != nil {
			t.Fatalf("%s: %v", provider, err)
		}
	}

	for _, provider := range []string{"codex", "anthropic", "antigravity", "xai", "devin"} {
		if queries[provider] != "true" {
			t.Fatalf("%s is_webui = %q, want true", provider, queries[provider])
		}
	}
	// Device grants have no redirect for a forwarder to serve, and a plugin
	// provider declares its own route, so neither asks CPA to open a listener.
	for _, provider := range []string{"kimi", "meta", "some-plugin"} {
		if queries[provider] != "" {
			t.Fatalf("%s is_webui = %q, want it omitted", provider, queries[provider])
		}
	}
}

func TestOAuthProviderRegistryFlagsMatchTheConsoleFlow(t *testing.T) {
	byID := map[string]OAuthProvider{}
	for _, provider := range OAuthProviders {
		byID[provider.ID] = provider
	}
	for _, id := range []string{"kimi", "codex", "anthropic", "antigravity", "xai", "devin", "meta"} {
		if _, ok := byID[id]; !ok {
			t.Fatalf("provider %s is missing from the registry", id)
		}
	}
	if byID["devin"].Flow != OAuthFlowRedirect {
		t.Fatalf("devin flow = %q, want redirect", byID["devin"].Flow)
	}
	if !byID["devin"].UsesLoopbackCallback {
		t.Fatal("devin's redirect lands on CPA's own callback route and needs the forwarder")
	}
	if byID["meta"].Flow != OAuthFlowDevice || byID["kimi"].Flow != OAuthFlowDevice {
		t.Fatal("device-code providers must be declared as device flows")
	}
	if byID["meta"].UsesLoopbackCallback || byID["kimi"].UsesLoopbackCallback {
		t.Fatal("a device flow must not request the loopback callback")
	}
	// Plugin providers are not in the registry; the lookup has to say so rather
	// than inventing flags for them.
	if _, ok := LookupOAuthProvider("some-plugin"); ok {
		t.Fatal("an unknown provider must not resolve")
	}
}
