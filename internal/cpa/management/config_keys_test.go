package management

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"testing"
	"time"
)

func TestConfigAPIKeysReadsEachFamilySection(t *testing.T) {
	server := newV8Server(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
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
	server := newV8Server(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
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

func TestOAuthAuthURLSendsTheLoopbackFlagOnlyWhereItApplies(t *testing.T) {
	for _, proxyURL := range []string{"", "https://proxy.example.test"} {
		t.Run(proxyURL, func(t *testing.T) {
			queries := map[string]bool{}
			server := newV8Server(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
				if request.URL.Path != "/v8/management/oauth/auth-url" {
					t.Error("login must use the shared v8 endpoint")
				}
				provider := request.URL.Query().Get("provider")
				isWebUI := request.URL.Query().Get("is_webui") == "true"
				if proxyURL != "" {
					var body struct {
						Provider string `json:"provider"`
						ProxyURL string `json:"proxy_url"`
						IsWebUI  bool   `json:"is_webui"`
					}
					if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
						t.Error(err)
					}
					if request.Method != http.MethodPost || request.URL.RawQuery != "" || body.ProxyURL != proxyURL {
						t.Error("proxy must be POST JSON only")
					}
					provider, isWebUI = body.Provider, body.IsWebUI
				} else if request.Method != http.MethodGet {
					t.Error("omission must retain GET")
				}
				queries[provider] = isWebUI
				writer.Header().Set("Content-Type", "application/json")
				_, _ = writer.Write([]byte(`{"status":"ok","url":"https://auth.example.test/authorize","state":"st-1"}`))
			}))
			defer server.Close()
			client, err := NewClient(server.URL, "management-secret", time.Second, false)
			if err != nil {
				t.Fatal(err)
			}
			for _, provider := range []string{"codex", "anthropic", "antigravity", "xai", "devin", "kimi", "kimi-ai", "meta", "some-plugin"} {
				if _, err := client.OAuthAuthURL(context.Background(), provider, OAuthStartOptions{ProxyURL: proxyURL}); err != nil {
					t.Fatalf("%s: %v", provider, err)
				}
			}
			actual, _ := json.Marshal(queries)
			const expected = `{"antigravity":true,"claude":true,"codex":true,"devin":true,"kimi":false,"kimi-ai":false,"meta":false,"some-plugin":false,"xai":true}`
			if string(actual) != expected {
				t.Fatalf("provider/loopback mapping = %s, want %s", actual, expected)
			}
		})
	}
}

func TestOAuthProviderRegistryFlagsMatchTheConsoleFlow(t *testing.T) {
	byID := map[string]OAuthProvider{}
	for _, provider := range OAuthProviders {
		byID[provider.ID] = provider
	}
	for _, id := range []string{"kimi", "kimi-ai", "codex", "anthropic", "antigravity", "xai", "devin", "meta"} {
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

func TestConfigAPIKeyRoundTripKeepsUnmodelledFields(t *testing.T) {
	raw := `{"api-key":"k","base-url":"https://api.x.ai/v1","prefix":"old","websockets":true,"request-retry":2,"cloak":{"mode":"auto"}}`
	var entry ConfigAPIKey
	if err := json.Unmarshal([]byte(raw), &entry); err != nil {
		t.Fatal(err)
	}
	if entry.APIKey != "k" || entry.Prefix != "old" {
		t.Fatalf("modelled fields = %#v", entry)
	}

	// Clearing a modelled field must not let the stored copy of it come back.
	entry.Prefix = ""
	entry.APIKey = "k2"
	encoded, err := json.Marshal(entry)
	if err != nil {
		t.Fatal(err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(encoded, &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded["api-key"] != "k2" || decoded["websockets"] != true || decoded["request-retry"] != float64(2) {
		t.Fatalf("encoded entry = %s", encoded)
	}
	if cloak, _ := decoded["cloak"].(map[string]any); cloak["mode"] != "auto" {
		t.Fatalf("nested unmodelled field lost: %s", encoded)
	}
	if _, hasPrefix := decoded["prefix"]; hasPrefix {
		t.Fatalf("a cleared prefix came back: %s", encoded)
	}

	// An entry built in code, with nothing to replay, encodes as before.
	plain, err := json.Marshal(ConfigAPIKey{APIKey: "fresh"})
	if err != nil {
		t.Fatal(err)
	}
	if string(plain) != `{"api-key":"fresh"}` {
		t.Fatalf("plain entry = %s", plain)
	}
}

func TestConfigKeyFamiliesCoverEveryCPAList(t *testing.T) {
	sections := map[string]bool{}
	for _, family := range ConfigKeyFamilies {
		sections[family.ConfigSection()] = true
	}
	for _, section := range []string{"codex-api-key", "claude-api-key", "gemini-api-key", "meta-api-key", "xai-api-key", "vertex-api-key", "interactions-api-key"} {
		if !sections[section] {
			t.Fatalf("ConfigKeyFamilies is missing %s", section)
		}
	}
}

func TestOAuthProxyResponseBoundary(t *testing.T) {
	const proxyURL = "http://a:https@proxy.example.test:8080"
	for _, scenario := range []struct {
		name, authURL string
		status        int
	}{
		{"authorization", "https://auth.example.test/authorize", 200},
		{"proxy_url", proxyURL, 200},
		{"userinfo", "https://a:https@auth.example.test/authorize", 200},
		{"encoded", "https://auth.example.test/?route=http%3A%2F%2Fa%3Ahttps%40proxy.example.test%3A8080", 200},
		{"rejection", proxyURL, 400},
		{"missing", proxyURL, 404},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			server := newV8Server(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
				writer.WriteHeader(scenario.status)
				_ = json.NewEncoder(writer).Encode(OAuthAuthURLResponse{URL: scenario.authURL, State: "state-a"})
			}))
			defer server.Close()
			client, err := NewClient(server.URL, "management-secret", time.Second, false)
			if err != nil {
				t.Fatal(err)
			}
			_, err = client.OAuthAuthURL(context.Background(), "codex", OAuthStartOptions{ProxyURL: proxyURL})
			if (err != nil) != (scenario.name != "authorization") {
				t.Fatalf("response boundary error = %v", err)
			}
			if err != nil && strings.Contains(err.Error(), proxyURL) {
				t.Fatal("adapter errors must not retain reflected proxy input")
			}
		})
	}
}
