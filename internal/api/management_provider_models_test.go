package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"slices"
	"strings"
	"sync/atomic"
	"testing"
)

func TestPullProviderModels(t *testing.T) {
	// Fake upstream AI provider endpoint serving /v1/models
	fakeUpstream := newFakeCPA(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer sk-test-upstream-key" {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"data": []map[string]any{
				{"id": "DeepSeek-V4-Flash"},
				{"id": "DeepSeek-V4-Flash-Vision-Exp"},
				{"id": "MiniCPM5-1B"},
				{"id": "Qwen3.8-Flash-Next"},
			},
		})
	}))
	defer fakeUpstream.Close()

	client, baseURL, _ := startProviderTestServer(t)

	// 1. Successful pull from endpoint
	pullReq := fmt.Sprintf(`{"base_url":"%s/v1","api_key":"sk-test-upstream-key"}`, fakeUpstream.URL)
	resp, payload := doJSON(t, client, http.MethodPost, baseURL+"/omc/api/v1/management/providers/pull-models", pullReq)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("pull models status = %d body %s", resp.StatusCode, payload)
	}

	var pullResp struct {
		Models []string `json:"models"`
		Total  int      `json:"total"`
	}
	if err := json.Unmarshal(payload, &pullResp); err != nil {
		t.Fatal(err)
	}
	if len(pullResp.Models) != 4 || pullResp.Models[0] != "DeepSeek-V4-Flash" {
		t.Fatalf("unexpected models list: %#v", pullResp)
	}

	// 2. Reject missing base_url
	resp, _ = doJSON(t, client, http.MethodPost, baseURL+"/omc/api/v1/management/providers/pull-models", `{"api_key":"sk-xxx"}`)
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("expected 400 for missing base_url, got %d", resp.StatusCode)
	}

	// 3. Upstream 401 returns bad gateway
	badKeyReq := fmt.Sprintf(`{"base_url":"%s/v1","api_key":"wrong-key"}`, fakeUpstream.URL)
	resp, _ = doJSON(t, client, http.MethodPost, baseURL+"/omc/api/v1/management/providers/pull-models", badKeyReq)
	if resp.StatusCode != http.StatusBadGateway {
		t.Fatalf("expected 502 for upstream unauthorized, got %d", resp.StatusCode)
	}
}

func TestProviderHTTPHostname(t *testing.T) {
	useProviderDNS(t, map[string][]net.IP{"ai-manager.": {net.ParseIP("127.0.0.1")}})
	var requests atomic.Int32
	var containerHost string
	upstream := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		requests.Add(1)
		if request.Host != containerHost {
			t.Errorf("provider Host = %q, want %q", request.Host, containerHost)
		}
		if request.Header.Get("Authorization") != "Bearer sk-container-test" {
			http.Error(writer, "unauthorized", http.StatusUnauthorized)
			return
		}
		switch request.URL.Path {
		case "/v1/models":
			_, _ = writer.Write([]byte(`{"data":[{"id":"container-model"}]}`))
		case "/v1/chat/completions":
			_, _ = writer.Write([]byte(`{}`))
		default:
			http.NotFound(writer, request)
		}
	}))
	t.Cleanup(upstream.Close)
	containerURL := strings.Replace(upstream.URL, "127.0.0.1", "ai-manager", 1) + "/v1"
	parsed, err := url.Parse(containerURL)
	if err != nil {
		t.Fatal(err)
	}
	containerHost = parsed.Host
	fixture := newProviderTestFixture(t)
	for _, testCase := range []struct {
		name     string
		proxyURL string
	}{
		{name: "direct"},
		{name: "proxy", proxyURL: upstream.URL},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			t.Run("pull models", func(t *testing.T) {
				before := requests.Load()
				body := fmt.Sprintf(`{"base_url":%q,"api_key":"sk-container-test","proxy_url":%q}`, containerURL, testCase.proxyURL)
				resp, payload := doJSON(t, fixture.client, http.MethodPost, fixture.baseURL+"/omc/api/v1/management/providers/pull-models", body)
				if testCase.proxyURL != "" {
					if resp.StatusCode != http.StatusBadGateway || requests.Load() != before {
						t.Fatalf("proxied container model pull = %d, requests = %d, %s", resp.StatusCode, requests.Load()-before, payload)
					}
					return
				}
				if resp.StatusCode != http.StatusOK || !strings.Contains(string(payload), `"container-model"`) {
					t.Fatalf("container model pull = %d, %s", resp.StatusCode, payload)
				}
			})
			t.Run("probe", func(t *testing.T) {
				before := requests.Load()
				body := fmt.Sprintf(`{"family":"openai-compatibility","base_url":%q,"api_key":"sk-container-test","proxy_url":%q,"model":"container-model"}`, containerURL, testCase.proxyURL)
				status, result := postProbe(t, fixture, body)
				if testCase.proxyURL != "" {
					if status != http.StatusOK || result["ok"] != false || requests.Load() != before {
						t.Fatalf("proxied container probe = %d, requests = %d, %#v", status, requests.Load()-before, result)
					}
					return
				}
				if status != http.StatusOK || result["ok"] != true {
					t.Fatalf("container probe = %d, %#v", status, result)
				}
			})
		})
	}
}

func TestModelPullBaseURLPolicy(t *testing.T) {
	useProviderDNS(t, map[string][]net.IP{
		"ai-manager.":         {net.ParseIP("172.20.0.3")},
		"lan-relay.internal.": {net.ParseIP("10.20.30.40"), net.ParseIP("fd00::1")},
		"loopback-relay.":     {net.ParseIP("127.0.0.1"), net.ParseIP("::1")},
		"api.example.com.":    {net.ParseIP("93.184.216.34")},
		"mixed-relay.":        {net.ParseIP("172.20.0.3"), net.ParseIP("93.184.216.34")},
		"mixed-ipv6-relay.":   {net.ParseIP("172.20.0.3"), net.ParseIP("2606:4700:4700::1111")},
		"metadata-relay.":     {net.ParseIP("169.254.169.254")},
	})
	tests := []struct {
		name      string
		rawURL    string
		isAllowed bool
	}{
		{name: "public https", rawURL: "https://api.example.com/v1", isAllowed: true},
		{name: "public http", rawURL: "http://api.example.com/v1", isAllowed: false},
		{name: "container hostname", rawURL: "http://ai-manager:7864/v1", isAllowed: true},
		{name: "private DNS", rawURL: "http://lan-relay.internal:8080/v1", isAllowed: true},
		{name: "loopback DNS", rawURL: "http://loopback-relay:8080/v1", isAllowed: true},
		{name: "mixed public private DNS", rawURL: "http://mixed-relay/v1", isAllowed: false},
		{name: "mixed public ipv6 DNS", rawURL: "http://mixed-ipv6-relay/v1", isAllowed: false},
		{name: "metadata DNS", rawURL: "http://metadata-relay/v1", isAllowed: false},
		{name: "unresolved hostname", rawURL: "http://missing-relay/v1", isAllowed: false},
		{name: "missing host", rawURL: "https:///v1", isAllowed: false},
		{name: "public ipv4", rawURL: "http://93.184.216.34/v1", isAllowed: false},
		{name: "public ipv6", rawURL: "http://[2606:4700:4700::1111]/v1", isAllowed: false},
		{name: "localhost", rawURL: "http://localhost:8080/v1", isAllowed: true},
		{name: "loopback ipv4", rawURL: "http://127.0.0.1:8080/v1", isAllowed: true},
		{name: "loopback ipv6", rawURL: "http://[::1]:8080/v1", isAllowed: true},
		{name: "private ipv4", rawURL: "http://10.20.30.40:8080/v1", isAllowed: true},
		{name: "private ipv6", rawURL: "http://[fd00::1]:8080/v1", isAllowed: true},
		{name: "link-local ipv4", rawURL: "http://169.254.10.20:8080/v1", isAllowed: false},
		{name: "cloud metadata", rawURL: "http://169.254.169.254/latest/meta-data", isAllowed: false},
		{name: "other scheme", rawURL: "ftp://localhost/v1", isAllowed: false},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			parsed, err := url.Parse(test.rawURL)
			if err != nil {
				t.Fatal(err)
			}
			if _, got := resolveProviderURLAddresses(context.Background(), parsed); got != test.isAllowed {
				t.Fatalf("resolveProviderURLAddresses(%q) allowed = %v, want %v", test.rawURL, got, test.isAllowed)
			}
		})
	}
}

func TestFetchEndpointModelsRejectsPublicHTTP(t *testing.T) {
	useProviderDNS(t, map[string][]net.IP{"example.com.": {net.ParseIP("93.184.216.34")}})
	_, err := fetchEndpointModels(context.Background(), "http://example.com/v1", "sk-provider-secret-1234", "", openAICompatibilityFamily, nil)
	if err == nil || !strings.Contains(err.Error(), "HTTPS") {
		t.Fatalf("expected HTTPS policy error, got %v", err)
	}
}

func TestPullProviderModelsReportsInvalidURL(t *testing.T) {
	useProviderDNS(t, map[string][]net.IP{"example.com.": {net.ParseIP("93.184.216.34")}})
	client, baseURL, _ := startProviderTestServer(t)

	resp, payload := doJSON(
		t,
		client,
		http.MethodPost,
		baseURL+"/omc/api/v1/management/providers/pull-models",
		`{"base_url":"http://example.com/v1","api_key":"sk-provider-secret-1234"}`,
	)
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("invalid base URL status = %d body %s", resp.StatusCode, payload)
	}
	var response struct {
		Error string `json:"error"`
		Code  string `json:"code"`
	}
	if err := json.Unmarshal(payload, &response); err != nil {
		t.Fatal(err)
	}
	if response.Code != "invalid_model_pull_url" || !strings.Contains(response.Error, "HTTPS") {
		t.Fatalf("unexpected invalid URL response: %#v", response)
	}
}

func TestPullProviderModelsReportsRedirectRefusal(t *testing.T) {
	redirectTarget := httptest.NewServer(http.NotFoundHandler())
	defer redirectTarget.Close()

	redirectSource := newFakeCPA(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		http.Redirect(writer, request, redirectTarget.URL+"/models", http.StatusFound)
	}))
	defer redirectSource.Close()

	client, baseURL, _ := startProviderTestServer(t)
	body := fmt.Sprintf(`{"base_url":%q,"api_key":"sk-provider-secret-1234"}`, redirectSource.URL)
	resp, payload := doJSON(t, client, http.MethodPost, baseURL+"/omc/api/v1/management/providers/pull-models", body)
	if resp.StatusCode != http.StatusBadGateway {
		t.Fatalf("redirect refusal status = %d body %s", resp.StatusCode, payload)
	}
	var response struct {
		Error string `json:"error"`
		Code  string `json:"code"`
	}
	if err := json.Unmarshal(payload, &response); err != nil {
		t.Fatal(err)
	}
	if response.Code != "model_pull_redirect_refused" || !strings.Contains(response.Error, "cross-origin redirect") {
		t.Fatalf("unexpected redirect response: %#v", response)
	}
}

func TestFetchEndpointModelsRefusesCrossOriginRedirect(t *testing.T) {
	for _, family := range []string{openAICompatibilityFamily, "claude", "gemini"} {
		t.Run(family, func(t *testing.T) {
			redirectedHeaders := make(chan http.Header, 1)
			redirectTarget := newFakeCPA(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
				redirectedHeaders <- request.Header.Clone()
				_ = json.NewEncoder(writer).Encode(map[string]any{"data": []map[string]any{{"id": "leaked-model"}}})
			}))
			defer redirectTarget.Close()

			redirectSource := newFakeCPA(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
				http.Redirect(writer, request, redirectTarget.URL+"/models", http.StatusFound)
			}))
			defer redirectSource.Close()

			_, err := fetchEndpointModels(
				context.Background(),
				redirectSource.URL,
				"sk-provider-secret-1234",
				"",
				family,
				map[string]string{"X-Provider-Secret": "custom-secret"},
			)
			if err == nil {
				t.Fatal("expected cross-origin redirect to be refused")
			}
			select {
			case headers := <-redirectedHeaders:
				t.Fatalf("redirect target received credentials: %v", headers)
			default:
			}
		})
	}
}

func TestFetchEndpointModelsFollowsSameOriginRedirect(t *testing.T) {
	upstream := newFakeCPA(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path == "/models" {
			http.Redirect(writer, request, "/v1/models", http.StatusFound)
			return
		}
		if request.URL.Path != "/v1/models" {
			http.NotFound(writer, request)
			return
		}
		if request.Header.Get("Authorization") != "Bearer sk-provider-secret-1234" {
			http.Error(writer, "unauthorized", http.StatusUnauthorized)
			return
		}
		_ = json.NewEncoder(writer).Encode(map[string]any{"data": []map[string]any{{"id": "redirected-model"}}})
	}))
	defer upstream.Close()

	models, err := fetchEndpointModels(context.Background(), upstream.URL, "sk-provider-secret-1234", "", openAICompatibilityFamily, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(models) != 1 || models[0] != "redirected-model" {
		t.Fatalf("unexpected models after same-origin redirect: %#v", models)
	}
}

func TestPullProviderModelsByProviderID(t *testing.T) {
	// Upstream serves /v1/models only (like the official Anthropic API);
	// wrong or missing auth is rejected with 401 the way relays report it.
	var claudeAuthHeaders []string
	fakeUpstream := newFakeCPA(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path != "/v1/models" {
			http.NotFound(w, r)
			return
		}
		switch r.Header.Get("Authorization") {
		case "Bearer sk-codex-secret-key-9999":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"data": []map[string]any{{"id": "gpt-5.2-codex"}, {"id": "gpt-5.2-mini"}},
			})
		case "Bearer sk-ant-secret-1234":
			if r.Header.Get("x-api-key") == "sk-ant-secret-1234" && r.Header.Get("anthropic-version") == "2023-06-01" {
				claudeAuthHeaders = []string{r.Header.Get("x-api-key"), r.Header.Get("anthropic-version")}
				_ = json.NewEncoder(w).Encode(map[string]any{
					"data": []map[string]any{{"id": "claude-opus-4.6"}, {"id": "claude-sonnet-4.6"}},
				})
				return
			}
			http.Error(w, "missing anthropic auth headers", http.StatusUnauthorized)
		default:
			http.Error(w, `{"error":{"code":"1001","message":"Header中未收到Authorization参数，无法进行身份验证。"}}`, http.StatusUnauthorized)
		}
	}))
	defer fakeUpstream.Close()

	// Point the stored claude/codex entries at the fake upstream, then pull
	// with provider_id only (no api_key): the handler must resolve the
	// stored key itself, otherwise relays reject the request with HTTP 401.
	client, baseURL, _ := startProviderTestServer(t)

	updateClaude := fmt.Sprintf(`{"family":"claude","name":"Claude relay","base_url":"%s","keys":[{"api_key":"sk-ant-secret-1234"}]}`, fakeUpstream.URL)
	resp, payload := doJSON(t, client, http.MethodPut, baseURL+"/omc/api/v1/management/providers/claude-0", updateClaude)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("update claude provider status = %d body %s", resp.StatusCode, payload)
	}

	resp, payload = doJSON(t, client, http.MethodPost, baseURL+"/omc/api/v1/management/providers/pull-models", `{"provider_id":"claude-0","base_url":"`+fakeUpstream.URL+`"}`)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("claude pull by provider_id status = %d body %s", resp.StatusCode, payload)
	}
	var pullResp struct {
		Models []string `json:"models"`
	}
	if err := json.Unmarshal(payload, &pullResp); err != nil {
		t.Fatal(err)
	}
	if len(pullResp.Models) != 2 || pullResp.Models[0] != "claude-opus-4.6" {
		t.Fatalf("unexpected claude models list: %#v", pullResp.Models)
	}
	if len(claudeAuthHeaders) != 2 || claudeAuthHeaders[0] != "sk-ant-secret-1234" || claudeAuthHeaders[1] != "2023-06-01" {
		t.Fatalf("anthropic auth headers missing: %#v", claudeAuthHeaders)
	}
	updateCodex := fmt.Sprintf(`{"family":"codex","name":"Codex relay","base_url":"%s","keys":[{"api_key":"sk-codex-secret-key-9999"}]}`, fakeUpstream.URL)
	resp, payload = doJSON(t, client, http.MethodPut, baseURL+"/omc/api/v1/management/providers/codex-0", updateCodex)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("update codex provider status = %d body %s", resp.StatusCode, payload)
	}

	resp, payload = doJSON(t, client, http.MethodPost, baseURL+"/omc/api/v1/management/providers/pull-models", `{"provider_id":"codex-0","base_url":"`+fakeUpstream.URL+`"}`)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("codex pull by provider_id status = %d body %s", resp.StatusCode, payload)
	}
	if err := json.Unmarshal(payload, &pullResp); err != nil {
		t.Fatal(err)
	}
	if len(pullResp.Models) != 2 || pullResp.Models[0] != "gpt-5.2-codex" {
		t.Fatalf("unexpected codex models list: %#v", pullResp.Models)
	}
}

// A family's model directory hangs from its own versioned root. Typing that
// segment is the operator's job nowhere else in the console, so a version-less
// base URL must still reach it - and reach it first, because a wrong path can
// answer with something other than 404 (the Gemini host answers 403 at
// /v1/models), which ends the search.
func TestModelDirectoryTargetsFollowFamilyDialect(t *testing.T) {
	for _, testCase := range []struct {
		name   string
		family string
		base   string
		want   []string
	}{
		{
			name:   "anthropic messages without a version segment",
			family: "claude",
			base:   "https://api.anthropic.com",
			want:   []string{"https://api.anthropic.com/v1/models?limit=1000", "https://api.anthropic.com/models"},
		},
		{
			name:   "anthropic messages naming /v1",
			family: "claude",
			base:   "https://relay.example.test/anthropic/v1/",
			want:   []string{"https://relay.example.test/anthropic/v1/models?limit=1000"},
		},
		{
			name:   "anthropic messages pasted with its messages endpoint",
			family: "claude",
			base:   "https://relay.example.test/v1/messages",
			want:   []string{"https://relay.example.test/v1/models?limit=1000"},
		},
		{
			name:   "gemini without a version segment",
			family: "gemini",
			base:   "https://generativelanguage.googleapis.com",
			want: []string{
				"https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000",
				"https://generativelanguage.googleapis.com/models",
				"https://generativelanguage.googleapis.com/v1/models",
			},
		},
		{
			name:   "gemini naming its openai-compatible base",
			family: "gemini",
			base:   "https://generativelanguage.googleapis.com/v1beta/openai",
			want:   []string{"https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000"},
		},
		{
			name:   "interactions shares the gemini directory",
			family: "interactions",
			base:   "https://interactions.example.test",
			want: []string{
				"https://interactions.example.test/v1beta/models?pageSize=1000",
				"https://interactions.example.test/models",
				"https://interactions.example.test/v1/models",
			},
		},
		{
			name:   "openai-compatible keeps the openai shapes",
			family: openAICompatibilityFamily,
			base:   "https://relay.example.test/v1",
			want:   []string{"https://relay.example.test/v1/models"},
		},
		{
			name:   "an unknown family keeps the openai shapes",
			family: "",
			base:   "https://relay.example.test",
			want:   []string{"https://relay.example.test/models", "https://relay.example.test/v1/models"},
		},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			if got := modelDirectoryTargets(testCase.family, testCase.base); !slices.Equal(got, testCase.want) {
				t.Fatalf("targets = %v, want %v", got, testCase.want)
			}
		})
	}
}

func TestFetchEndpointModelsAsksTheFamilyDialectFirst(t *testing.T) {
	for _, testCase := range []struct {
		name    string
		family  string
		path    string
		query   string
		status  int
		body    string
		want    []string
		wantErr string
	}{
		{
			name:   "anthropic messages",
			family: "claude",
			path:   "/v1/models",
			query:  "limit=1000",
			body:   `{"data":[{"id":"claude-opus-4.6"},{"id":"claude-sonnet-4.6"}]}`,
			want:   []string{"claude-opus-4.6", "claude-sonnet-4.6"},
		},
		{
			name:   "gemini generate content",
			family: "gemini",
			path:   "/v1beta/models",
			query:  "pageSize=1000",
			body:   `{"models":[{"name":"models/gemini-2.5-pro"},{"name":"models/gemini-2.5-flash"}]}`,
			want:   []string{"gemini-2.5-pro", "gemini-2.5-flash"},
		},
		{
			// Only a 404 means this path is not the directory. A refusal is the
			// upstream's answer about the request, and the same key must not be
			// presented again at another path on that host.
			name:    "a refused request ends the ladder",
			family:  "claude",
			path:    "/v1/models",
			query:   "limit=1000",
			status:  http.StatusForbidden,
			wantErr: "HTTP 403",
		},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			var requested []string
			var query string
			upstream := newFakeCPA(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
				requested = append(requested, request.URL.Path)
				// Anything this dialect does not publish is refused the way the
				// Google host refuses another path: not with a 404 a fallback could
				// step over, but with a refusal that ends the search.
				if request.URL.Path != testCase.path {
					http.Error(writer, "not this dialect's directory", http.StatusForbidden)
					return
				}
				query = request.URL.RawQuery
				if testCase.status != 0 {
					http.Error(writer, "refused", testCase.status)
					return
				}
				writer.Header().Set("Content-Type", "application/json")
				_, _ = writer.Write([]byte(testCase.body))
			}))
			defer upstream.Close()

			models, err := fetchEndpointModels(context.Background(), upstream.URL, "sk-provider-secret-1234", "", testCase.family, nil)
			if !slices.Equal(requested, []string{testCase.path}) {
				t.Fatalf("requested %v, want exactly [%s]", requested, testCase.path)
			}
			if query != testCase.query {
				t.Fatalf("query = %q, want %q", query, testCase.query)
			}
			if testCase.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), testCase.wantErr) {
					t.Fatalf("error = %v, want %q", err, testCase.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatalf("pull from %s: %v", testCase.family, err)
			}
			if !slices.Equal(models, testCase.want) {
				t.Fatalf("models = %v, want %v", models, testCase.want)
			}
		})
	}
}

func TestPullProtocolFollowsFamilyRegistry(t *testing.T) {
	for family, want := range map[string]string{
		"claude":               "anthropic",
		"gemini":               "gemini",
		"vertex":               "gemini",
		"interactions":         "gemini",
		"xai":                  "openai",
		"codex":                "openai",
		"openai-compatibility": "openai",
	} {
		if got := pullProtocol(family); got != want {
			t.Fatalf("pullProtocol(%q) = %q, want %q", family, got, want)
		}
	}
}
