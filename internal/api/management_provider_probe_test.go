package api

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type probeCapture struct {
	method string
	path   string
	header http.Header
	body   map[string]any
}

func startProbeUpstream(t *testing.T, status int, response string) (*httptest.Server, *probeCapture) {
	t.Helper()
	captured := &probeCapture{}
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		captured.method = request.Method
		captured.path = request.URL.Path
		captured.header = request.Header.Clone()
		raw, _ := io.ReadAll(request.Body)
		_ = json.Unmarshal(raw, &captured.body)
		writer.Header().Set("Content-Type", "application/json")
		writer.WriteHeader(status)
		_, _ = writer.Write([]byte(response))
	}))
	t.Cleanup(server.Close)
	return server, captured
}

func postProbe(t *testing.T, fixture providerTestFixture, body string) (int, map[string]any) {
	t.Helper()
	resp, payload := doJSON(t, fixture.client, http.MethodPost, fixture.baseURL+providersEndpoint+"/probe", body)
	var decoded map[string]any
	if err := json.Unmarshal([]byte(payload), &decoded); err != nil {
		t.Fatalf("decode probe response: %v (%s)", err, payload)
	}
	return resp.StatusCode, decoded
}

func TestProbeProviderSendsEachFamilyDialect(t *testing.T) {
	fixture := newProviderTestFixture(t)
	for _, testCase := range []struct {
		family      string
		path        string
		checkBody   func(t *testing.T, body map[string]any)
		checkHeader func(t *testing.T, header http.Header)
	}{
		{
			family: "openai-compatibility",
			path:   "/chat/completions",
			checkBody: func(t *testing.T, body map[string]any) {
				t.Helper()
				if body["model"] != "probe-model" || body["stream"] != false || body["max_tokens"] != float64(5) {
					t.Fatalf("openai probe body = %v", body)
				}
				messages, _ := body["messages"].([]any)
				if len(messages) != 1 || messages[0].(map[string]any)["content"] != "Hi" {
					t.Fatalf("openai probe messages = %v", messages)
				}
			},
			checkHeader: func(t *testing.T, header http.Header) {
				t.Helper()
				if header.Get("Authorization") != "Bearer sk-probe-1" {
					t.Fatalf("authorization = %q", header.Get("Authorization"))
				}
			},
		},
		{
			family: "codex",
			path:   "/responses",
			checkBody: func(t *testing.T, body map[string]any) {
				t.Helper()
				if body["model"] != "probe-model" || body["input"] != "Hi" || body["stream"] != false {
					t.Fatalf("codex probe body = %v", body)
				}
			},
			checkHeader: func(t *testing.T, header http.Header) {
				t.Helper()
				if header.Get("Authorization") != "Bearer sk-probe-1" {
					t.Fatalf("authorization = %q", header.Get("Authorization"))
				}
			},
		},
		{
			family: "claude",
			path:   "/v1/messages",
			checkBody: func(t *testing.T, body map[string]any) {
				t.Helper()
				if body["model"] != "probe-model" || body["max_tokens"] != float64(8) {
					t.Fatalf("claude probe body = %v", body)
				}
			},
			checkHeader: func(t *testing.T, header http.Header) {
				t.Helper()
				if header.Get("x-api-key") != "sk-probe-1" || header.Get("anthropic-version") != "2023-06-01" {
					t.Fatalf("claude headers = %v", header)
				}
			},
		},
		{
			family: "gemini",
			path:   "/v1beta/models/probe-model:generateContent",
			checkBody: func(t *testing.T, body map[string]any) {
				t.Helper()
				contents, _ := body["contents"].([]any)
				if len(contents) != 1 {
					t.Fatalf("gemini probe body = %v", body)
				}
			},
			checkHeader: func(t *testing.T, header http.Header) {
				t.Helper()
				if header.Get("x-goog-api-key") != "sk-probe-1" {
					t.Fatalf("x-goog-api-key = %q", header.Get("x-goog-api-key"))
				}
			},
		},
		{
			family: "vertex",
			path:   "/v1/publishers/google/models/probe-model:generateContent",
			checkBody: func(t *testing.T, body map[string]any) {
				t.Helper()
				contents, _ := body["contents"].([]any)
				if len(contents) != 1 {
					t.Fatalf("vertex probe body = %v", body)
				}
			},
			checkHeader: func(t *testing.T, header http.Header) {
				t.Helper()
				if header.Get("x-goog-api-key") != "sk-probe-1" {
					t.Fatalf("x-goog-api-key = %q", header.Get("x-goog-api-key"))
				}
			},
		},
		{
			family: "interactions",
			path:   "/v1beta/interactions",
			checkBody: func(t *testing.T, body map[string]any) {
				t.Helper()
				if body["model"] != "probe-model" || body["input"] != "Hi" {
					t.Fatalf("interactions probe body = %v", body)
				}
			},
			checkHeader: func(t *testing.T, header http.Header) {
				t.Helper()
				if header.Get("x-goog-api-key") != "sk-probe-1" || header.Get("Api-Revision") != "2026-05-20" {
					t.Fatalf("interactions headers = %v", header)
				}
			},
		},
	} {
		t.Run(testCase.family, func(t *testing.T) {
			upstream, captured := startProbeUpstream(t, http.StatusOK, `{"ok":true}`)
			status, decoded := postProbe(t, fixture, `{"family":"`+testCase.family+`","base_url":"`+upstream.URL+`","api_key":"sk-probe-1","model":"probe-model"}`)
			if status != http.StatusOK || decoded["ok"] != true || decoded["status_code"] != float64(200) {
				t.Fatalf("probe = %d %v, want a successful probe", status, decoded)
			}
			if captured.method != http.MethodPost || captured.path != testCase.path {
				t.Fatalf("upstream saw %s %s, want POST %s", captured.method, captured.path, testCase.path)
			}
			testCase.checkBody(t, captured.body)
			testCase.checkHeader(t, captured.header)
		})
	}
}

func TestProbeProviderRefusesBadRequests(t *testing.T) {
	fixture := newProviderTestFixture(t)
	upstream, _ := startProbeUpstream(t, http.StatusOK, `{}`)
	for _, testCase := range []struct {
		name string
		body string
	}{
		{name: "unknown family", body: `{"family":"carrier-pigeon","base_url":"` + upstream.URL + `","api_key":"sk-probe-1","model":"m"}`},
		{name: "missing model", body: `{"family":"codex","base_url":"` + upstream.URL + `","api_key":"sk-probe-1"}`},
		{name: "missing key", body: `{"family":"codex","base_url":"` + upstream.URL + `","model":"m"}`},
		{name: "missing base url", body: `{"family":"codex","api_key":"sk-probe-1","model":"m"}`},
		{name: "bad scheme", body: `{"family":"codex","base_url":"ftp://example.test","api_key":"sk-probe-1","model":"m"}`},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			if status, _ := postProbe(t, fixture, testCase.body); status != http.StatusBadRequest {
				t.Fatalf("probe = %d, want 400", status)
			}
		})
	}
}

func TestProbeProviderRedactsTheKeyFromFailures(t *testing.T) {
	fixture := newProviderTestFixture(t)
	// A relay that echoes the request back must not hand the stored key to a
	// caller who triggered the probe: the failure names the status, never the secret.
	upstream, _ := startProbeUpstream(t, http.StatusUnauthorized, `{"error":"bad key sk-probe-secret-9"}`)
	status, decoded := postProbe(t, fixture, `{"family":"codex","base_url":"`+upstream.URL+`","api_key":"sk-probe-secret-9","model":"m"}`)
	if status != http.StatusOK || decoded["ok"] != false || decoded["status_code"] != float64(401) {
		t.Fatalf("probe = %d %v, want an unsuccessful probe", status, decoded)
	}
	if payload, _ := json.Marshal(decoded); strings.Contains(string(payload), "sk-probe-secret-9") {
		t.Fatalf("probe failure leaked the key: %v", decoded)
	}
}

func TestProbeProviderKeepsStoredKeysAtTheirEndpoint(t *testing.T) {
	fixture := newProviderTestFixture(t)
	fixture.state.mu.Lock()
	fixture.state.codexProviders = []map[string]any{{
		"api-key": "sk-stored-codex-1", "base-url": "https://codex.test/v1",
	}}
	fixture.state.mu.Unlock()
	upstream, captured := startProbeUpstream(t, http.StatusOK, `{"ok":true}`)

	// A different typed URL with no retyped key is refused before anything is
	// sent: the stored key never leaves for a caller-chosen host.
	status, decoded := postProbe(t, fixture, `{"provider_id":"codex-0","family":"codex","base_url":"`+upstream.URL+`/v1","model":"m"}`)
	if status != http.StatusBadRequest {
		t.Fatalf("foreign probe = %d %v, want a refusal", status, decoded)
	}
	if captured.method != "" {
		t.Fatalf("upstream saw %s %s, want no request at all", captured.method, captured.path)
	}

	// The configured endpoint probes with the stored key: point the stored
	// entry at a local upstream and assert the wire carries the stored key.
	local, localCaptured := startProbeUpstream(t, http.StatusOK, `{"ok":true}`)
	fixture.state.mu.Lock()
	fixture.state.codexProviders = []map[string]any{{
		"api-key": "sk-stored-codex-1", "base-url": local.URL + "/v1",
	}}
	fixture.state.mu.Unlock()
	status, decoded = postProbe(t, fixture, `{"provider_id":"codex-0","family":"codex","model":"m"}`)
	if status != http.StatusOK || decoded["ok"] != true {
		t.Fatalf("configured probe = %d %v, want a successful probe", status, decoded)
	}
	if localCaptured.path != "/v1/responses" || localCaptured.header.Get("Authorization") != "Bearer sk-stored-codex-1" {
		t.Fatalf("upstream saw %s with %q, want the stored key at /v1/responses",
			localCaptured.path, localCaptured.header.Get("Authorization"))
	}
}

func TestProbeProviderAuditsAttemptsAndOutcomes(t *testing.T) {
	fixture := newProviderTestFixture(t)
	upstream, _ := startProbeUpstream(t, http.StatusOK, `{"ok":true}`)
	if status, decoded := postProbe(t, fixture, `{"family":"codex","base_url":"`+upstream.URL+`","api_key":"sk-probe-1","model":"m"}`); status != http.StatusOK || decoded["ok"] != true {
		t.Fatalf("probe = %d %v, want success", status, decoded)
	}
	// The trail folds an attempt into its outcome by default; the unfolded
	// read proves both rows were written.
	resp, payload := doJSON(t, fixture.client, http.MethodGet, fixture.baseURL+"/omc/api/v1/management/audit/events?limit=10&fold=0", "")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("audit events = %d %s", resp.StatusCode, payload)
	}
	var page struct {
		Events []struct {
			Action string `json:"action"`
			Result string `json:"result"`
		} `json:"events"`
	}
	if err := json.Unmarshal([]byte(payload), &page); err != nil {
		t.Fatalf("decode audit events: %v", err)
	}
	var attempt, success bool
	for _, event := range page.Events {
		if event.Action == "provider.probe" && event.Result == "attempt" {
			attempt = true
		}
		if event.Action == "provider.probe" && event.Result == "success" {
			success = true
		}
	}
	if !attempt || !success {
		t.Fatalf("audit events = %s, want provider.probe attempt and success rows", payload)
	}
	if strings.Contains(string(payload), "sk-probe-1") {
		t.Fatalf("audit events leaked the key: %s", payload)
	}
}

func TestProbeProviderDropsStoredHeadersForForeignURLs(t *testing.T) {
	fixture := newProviderTestFixture(t)
	fixture.state.mu.Lock()
	fixture.state.codexProviders = []map[string]any{{
		"api-key": "sk-stored-codex-1", "base-url": "https://codex.test/v1",
		"headers": map[string]any{"Authorization": "Bearer stored-header-secret-7"},
	}}
	fixture.state.mu.Unlock()
	upstream, captured := startProbeUpstream(t, http.StatusOK, `{"ok":true}`)

	// A retyped key unlocks the foreign URL, but the stored entry's headers
	// stay behind: only the caller's own values travel.
	status, decoded := postProbe(t, fixture, `{"provider_id":"codex-0","family":"codex","base_url":"`+upstream.URL+`/v1","api_key":"sk-typed-1","model":"m"}`)
	if status != http.StatusOK || decoded["ok"] != true {
		t.Fatalf("typed-key probe = %d %v, want success", status, decoded)
	}
	if captured.header.Get("Authorization") != "Bearer sk-typed-1" {
		t.Fatalf("authorization = %q, want the typed key", captured.header.Get("Authorization"))
	}
	if payload, _ := json.Marshal(captured.header); strings.Contains(string(payload), "stored-header-secret-7") {
		t.Fatalf("upstream saw stored headers: %v", captured.header)
	}
}

func TestProbeProviderRefusesAnInvalidProxy(t *testing.T) {
	fixture := newProviderTestFixture(t)
	upstream, captured := startProbeUpstream(t, http.StatusOK, `{"ok":true}`)
	status, _ := postProbe(t, fixture, `{"family":"codex","base_url":"`+upstream.URL+`","api_key":"sk-probe-1","model":"m","proxy_url":"://bad-proxy"}`)
	if status != http.StatusBadRequest {
		t.Fatalf("bad proxy probe = %d, want 400", status)
	}
	if captured.method != "" {
		t.Fatalf("upstream saw %s %s, want no request at all", captured.method, captured.path)
	}
}

func TestProbeProviderBorrowedSecretsStayOffACallerProxy(t *testing.T) {
	fixture := newProviderTestFixture(t)
	fixture.state.mu.Lock()
	fixture.state.codexProviders = []map[string]any{{
		"api-key": "sk-stored-codex-9", "base-url": "https://codex.test/v1",
	}}
	fixture.state.mu.Unlock()
	proxy, proxyCaptured := startProbeUpstream(t, http.StatusOK, `{"ok":true}`)
	upstream, upstreamCaptured := startProbeUpstream(t, http.StatusOK, `{"ok":true}`)

	// Borrowing the stored key while naming another proxy is refused: the
	// proxy would see the stored secret in transit.
	status, _ := postProbe(t, fixture, `{"provider_id":"codex-0","family":"codex","base_url":"`+upstream.URL+`","model":"m","proxy_url":"`+proxy.URL+`"}`)
	if status != http.StatusBadRequest {
		t.Fatalf("borrowed-key proxy probe = %d, want 400", status)
	}
	if proxyCaptured.method != "" || upstreamCaptured.method != "" {
		t.Fatalf("request escaped: proxy saw %s, upstream saw %s", proxyCaptured.method, upstreamCaptured.method)
	}

	// A retyped key may use a caller proxy, carrying only typed values.
	status, decoded := postProbe(t, fixture, `{"provider_id":"codex-0","family":"codex","base_url":"`+upstream.URL+`","api_key":"sk-typed-9","model":"m","proxy_url":"`+proxy.URL+`"}`)
	if status != http.StatusOK || decoded["ok"] != true {
		t.Fatalf("typed-key proxy probe = %d %v, want success", status, decoded)
	}
	if proxyCaptured.header.Get("Authorization") != "Bearer sk-typed-9" {
		t.Fatalf("proxy saw %q, want only the typed key", proxyCaptured.header.Get("Authorization"))
	}
}

func TestProbeProviderHidesRedirectDestinations(t *testing.T) {
	fixture := newProviderTestFixture(t)
	upstream, _ := startProbeUpstream(t, http.StatusFound, ``)
	_ = upstream
	redirecting := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Location", "https://foreign.example.test/failure?echo=sk-probe-secret-4")
		writer.WriteHeader(http.StatusFound)
	}))
	defer redirecting.Close()
	status, decoded := postProbe(t, fixture, `{"family":"codex","base_url":"`+redirecting.URL+`","api_key":"sk-probe-secret-4","model":"m"}`)
	if status != http.StatusOK || decoded["ok"] != false {
		t.Fatalf("probe = %d %v, want an unsuccessful probe", status, decoded)
	}
	if payload, _ := json.Marshal(decoded); strings.Contains(string(payload), "foreign.example.test") || strings.Contains(string(payload), "sk-probe-secret-4") {
		t.Fatalf("redirect refusal leaked destination or key: %v", decoded)
	}
}

func TestProbeProviderRedactsBareTokensFromStoredHeaders(t *testing.T) {
	fixture := newProviderTestFixture(t)
	upstream, upstreamCaptured := startProbeUpstream(t, http.StatusUnauthorized, `{"error":"opaqueStoredToken42"}`)
	fixture.state.mu.Lock()
	fixture.state.codexProviders = []map[string]any{{
		"api-key": "sk-stored-codex-5", "base-url": upstream.URL,
		"headers": map[string]any{"Authorization": "Bearer opaqueStoredToken42"},
	}}
	fixture.state.mu.Unlock()
	status, decoded := postProbe(t, fixture, `{"provider_id":"codex-0","family":"codex","model":"m"}`)
	if status != http.StatusOK || decoded["ok"] != false {
		t.Fatalf("probe = %d %v, want an unsuccessful probe", status, decoded)
	}
	if upstreamCaptured.header.Get("Authorization") != "Bearer opaqueStoredToken42" {
		t.Fatalf("upstream saw %q, want the stored bearer to travel", upstreamCaptured.header.Get("Authorization"))
	}
	if payload, _ := json.Marshal(decoded); strings.Contains(string(payload), "opaqueStoredToken42") {
		t.Fatalf("stored bearer survived redaction: %v", decoded)
	}
}

func TestProbeEndpointMatchesCPAPrefixSemantics(t *testing.T) {
	for _, testCase := range []struct{ family, base, want string }{
		{"codex", "https://codex.example.test/backend-api/codex", "https://codex.example.test/backend-api/codex/responses"},
		{"codex", "https://codex.example.test/v1", "https://codex.example.test/v1/responses"},
		{"xai", "https://xai.example.test/custom", "https://xai.example.test/custom/responses"},
		{"vertex", "", "https://aiplatform.googleapis.com/v1/publishers/google/models/m:generateContent"},
		{"vertex", "https://vertex.example.test/custom", "https://vertex.example.test/custom/v1/publishers/google/models/m:generateContent"},
		{"vertex", "https://aiplatform.googleapis.com/v1/publishers/google/models/m:generateContent", "https://aiplatform.googleapis.com/v1/publishers/google/models/m:generateContent"},
	} {
		t.Run(testCase.family+"/"+testCase.base, func(t *testing.T) {
			spec, err := probeEndpointForFamily(testCase.family, testCase.base, "m")
			if err != nil {
				t.Fatal(err)
			}
			if spec.target != testCase.want {
				t.Fatalf("target = %s, want %s", spec.target, testCase.want)
			}
		})
	}
}

func TestProbeProviderUsesInteractionsDialectForVertex(t *testing.T) {
	fixture := newProviderTestFixture(t)
	upstream, captured := startProbeUpstream(t, http.StatusOK, `{"ok":true}`)
	vertexList := []map[string]any{{
		"api-key": "sk-stored-vertex-1", "base-url": upstream.URL, "interactions": true,
	}}
	fixture.state.mu.Lock()
	if fixture.state.familyLists == nil {
		fixture.state.familyLists = map[string]*[]map[string]any{}
	}
	fixture.state.familyLists["vertex"] = &vertexList
	fixture.state.mu.Unlock()

	// The stored entry enables Interactions: the probe speaks that dialect.
	status, decoded := postProbe(t, fixture, `{"provider_id":"vertex-0","family":"vertex","model":"m"}`)
	if status != http.StatusOK || decoded["ok"] != true {
		t.Fatalf("probe = %d %v, want a successful probe", status, decoded)
	}
	if captured.path != "/v1beta/interactions" || captured.header.Get("Api-Revision") == "" {
		t.Fatalf("upstream saw %s %v, want the interactions dialect", captured.path, captured.header)
	}

	// A draft can select the dialect explicitly without a stored entry.
	status, decoded = postProbe(t, fixture, `{"family":"vertex","base_url":"`+upstream.URL+`","api_key":"sk-typed-vertex-1","model":"m","interactions":true}`)
	if status != http.StatusOK || decoded["ok"] != true {
		t.Fatalf("typed probe = %d %v, want a successful probe", status, decoded)
	}
	if captured.path != "/v1beta/interactions" {
		t.Fatalf("upstream saw %s, want the interactions dialect", captured.path)
	}
}
