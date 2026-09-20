package api

import (
	"encoding/json"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/management"
)

type configFixtureCPA struct {
	mu           sync.Mutex
	putPaths     []string
	putBodies    []string
	contentTypes []string
	configData   map[string]any
	yamlData     string
	yamlError    bool
}

func (f *configFixtureCPA) serve(writer http.ResponseWriter, request *http.Request) {
	path := strings.TrimPrefix(request.URL.Path, "/v0/management")
	f.mu.Lock()
	defer f.mu.Unlock()

	if request.Method == http.MethodGet {
		switch path {
		case "/config":
			writer.Header().Set("Content-Type", "application/json")
			if f.configData == nil {
				f.configData = map[string]any{
					"debug":                    false,
					"proxy-url":                "http://proxy:8080",
					"request-log":              true,
					"logging-to-file":          false,
					"usage-statistics-enabled": true,
					"request-retry":            3,
					"max-retry-interval":       30,
					"max-retry-credentials":    2,
					"ws-auth":                  true,
					"force-model-prefix":       false,
					"logs-max-total-size-mb":   100,
					"error-logs-max-files":     5,
					"routing": map[string]any{
						"strategy": "least-load",
					},
					// Secret and complex fields that must be redacted
					"secret-key":     "top-secret-management-key",
					"api-keys":       []any{"key-1", "key-2"},
					"codex-api-key":  "secret-codex-key",
					"gemini-api-key": "secret-gemini-key",
				}
			}
			_ = json.NewEncoder(writer).Encode(f.configData)

		case "/config.yaml":
			writer.Header().Set("Content-Type", "application/yaml")
			if f.yamlData == "" {
				f.yamlData = "host: 127.0.0.1\nport: 8317\ndebug: false\n"
			}
			_, _ = writer.Write([]byte(f.yamlData))

		default:
			writer.WriteHeader(http.StatusNotFound)
		}
		return
	}

	if request.Method == http.MethodPut {
		f.putPaths = append(f.putPaths, path)
		f.contentTypes = append(f.contentTypes, request.Header.Get("Content-Type"))
		body := make([]byte, 1024*1024)
		n, _ := request.Body.Read(body)
		f.putBodies = append(f.putBodies, string(body[:n]))

		if path == "/config.yaml" && f.yamlError {
			writer.WriteHeader(http.StatusBadRequest)
			_, _ = writer.Write([]byte(`{"error":"invalid_yaml","message":"yaml parse error at line 2"}`))
			return
		}

		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write([]byte(`{"status":"ok"}`))
		return
	}

	writer.WriteHeader(http.StatusMethodNotAllowed)
}

func TestManagementConfigGetRedactsSecrets(t *testing.T) {
	fixture := &configFixtureCPA{}
	client, baseURL, _ := startDashboardTestServer(t, fixture.serve)

	base := baseURL + "/omc/api/v1/management/config"
	response, payload := getJSON(t, client, base)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("status = %d body %s", response.StatusCode, payload)
	}

	payloadStr := string(payload)
	// Assert secrets never appear in output
	if strings.Contains(payloadStr, "top-secret-management-key") || strings.Contains(payloadStr, "secret-codex-key") || strings.Contains(payloadStr, "secret-gemini-key") {
		t.Fatalf("leaked secret credentials in scalar response: %s", payloadStr)
	}

	var res struct {
		Scalars       management.ConfigScalarsDTO `json:"scalars"`
		SupportedKeys []string                    `json:"supported_keys"`
	}
	if err := json.Unmarshal(payload, &res); err != nil {
		t.Fatalf("failed to decode response: %v", err)
	}

	if res.Scalars.ProxyURL != "http://proxy:8080" {
		t.Errorf("expected proxy_url http://proxy:8080, got %s", res.Scalars.ProxyURL)
	}
	if res.Scalars.RoutingStrategy != "least-load" {
		t.Errorf("expected routing_strategy least-load, got %s", res.Scalars.RoutingStrategy)
	}
	if !res.Scalars.RequestLog {
		t.Errorf("expected request_log true")
	}
	if len(res.SupportedKeys) == 0 {
		t.Errorf("expected non-empty supported_keys")
	}
}

func TestManagementConfigPutScalarValidation(t *testing.T) {
	fixture := &configFixtureCPA{}
	client, baseURL, _ := startDashboardTestServer(t, fixture.serve)

	// Valid boolean
	resp, payload := doJSON(t, client, http.MethodPut, baseURL+"/omc/api/v1/management/config/debug", `{"value":true}`)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("debug status = %d body %s", resp.StatusCode, payload)
	}

	// Valid int
	resp, payload = doJSON(t, client, http.MethodPut, baseURL+"/omc/api/v1/management/config/request_retry", `{"value":5}`)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("request_retry status = %d body %s", resp.StatusCode, payload)
	}

	// Valid routing strategy
	resp, payload = doJSON(t, client, http.MethodPut, baseURL+"/omc/api/v1/management/config/routing_strategy", `{"value":"round-robin"}`)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("routing_strategy status = %d body %s", resp.StatusCode, payload)
	}

	// Invalid type: string for boolean
	resp, _ = doJSON(t, client, http.MethodPut, baseURL+"/omc/api/v1/management/config/debug", `{"value":"true"}`)
	if resp.StatusCode != http.StatusBadRequest {
		t.Errorf("expected 400 for string boolean, got %d", resp.StatusCode)
	}

	// Invalid type: negative int
	resp, _ = doJSON(t, client, http.MethodPut, baseURL+"/omc/api/v1/management/config/request_retry", `{"value":-1}`)
	if resp.StatusCode != http.StatusBadRequest {
		t.Errorf("expected 400 for negative int, got %d", resp.StatusCode)
	}

	// Invalid routing strategy
	resp, _ = doJSON(t, client, http.MethodPut, baseURL+"/omc/api/v1/management/config/routing_strategy", `{"value":"invalid-strategy"}`)
	if resp.StatusCode != http.StatusBadRequest {
		t.Errorf("expected 400 for invalid strategy, got %d", resp.StatusCode)
	}

	// Unknown key
	resp, _ = doJSON(t, client, http.MethodPut, baseURL+"/omc/api/v1/management/config/unknown_key", `{"value":123}`)
	if resp.StatusCode != http.StatusBadRequest {
		t.Errorf("expected 400 for unknown key, got %d", resp.StatusCode)
	}
}

func TestManagementConfigPutScalarHonoursProviderWriteGate(t *testing.T) {
	fixture := &configFixtureCPA{}
	var handler *Handler
	client, baseURL, _ := startDashboardTestServer(t, fixture.serve, func(h *Handler) {
		handler = h
	})

	handler.providerWrites.permits <- struct{}{}
	previousTimeout := handler.providerWrites.acquireTimeout
	handler.providerWrites.acquireTimeout = 50 * time.Millisecond
	t.Cleanup(func() {
		handler.providerWrites.acquireTimeout = previousTimeout
		<-handler.providerWrites.permits
	})

	resp, payload := doJSON(t, client, http.MethodPut, baseURL+"/omc/api/v1/management/config/debug", `{"value":true}`)
	if resp.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("a refused config write must answer 503, got %d body %s", resp.StatusCode, payload)
	}
	var body struct {
		Code string `json:"code"`
	}
	_ = json.Unmarshal(payload, &body)
	if body.Code != providerWriteBusyCode {
		t.Fatalf("refusal must carry code %q, got %q (%s)", providerWriteBusyCode, body.Code, payload)
	}

	fixture.mu.Lock()
	putCount := len(fixture.putPaths)
	fixture.mu.Unlock()
	if putCount != 0 {
		t.Fatalf("a refused scalar write reached CPA %d time(s)", putCount)
	}
}

func TestManagementConfigSourceGetAndPut(t *testing.T) {
	fixture := &configFixtureCPA{}
	client, baseURL, _ := startDashboardTestServer(t, fixture.serve)

	// 1. GET source is served to the authenticated session with no step-up grant.
	// This is the deliberate policy: the management key is the console's only
	// credential, so the session that reaches this route already carries the
	// authority the removed reveal grant re-checked. The reveal is still audited
	// fail-closed server-side.
	resp, payload := getJSON(t, client, baseURL+"/omc/api/v1/management/config/source")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 with an authenticated session, got %d body %s", resp.StatusCode, payload)
	}
	if resp.Header.Get("Cache-Control") != "no-store" {
		t.Fatalf("raw source must not be cacheable, got Cache-Control %q", resp.Header.Get("Cache-Control"))
	}
	var srcRes struct {
		YAML      string `json:"yaml"`
		SizeBytes int    `json:"size_bytes"`
		Revision  string `json:"revision"`
	}
	if err := json.Unmarshal(payload, &srcRes); err != nil {
		t.Fatalf("decode source response: %v", err)
	}
	if srcRes.Revision == "" || srcRes.YAML == "" {
		t.Fatalf("source response missing yaml or revision: %s", payload)
	}

	// 2. The removed grant endpoint is gone rather than silently ignoring input.
	resp, _ = doJSON(t, client, http.MethodPost, baseURL+"/omc/api/v1/management/config/source/grant", `{"password":"management-secret-value"}`)
	if resp.StatusCode != http.StatusNotFound && resp.StatusCode != http.StatusMethodNotAllowed {
		t.Fatalf("expected the grant endpoint to be removed, got %d", resp.StatusCode)
	}

	// 2b. The remaining boundary is the session, and it is still enforced. The raw
	// source route is covered by the unauthenticated-routes test
	// (TestUnauthenticatedRoutesAreRejected), which now includes it: dropping
	// step-up auth must not have opened the source to anyone who can reach the port.

	// 3. PUT source without revision must return 400 missing_revision
	putNoRev, _ := json.Marshal(map[string]string{"yaml": `host: 0.0.0.0
`})
	resp, payload = doJSON(t, client, http.MethodPut, baseURL+"/omc/api/v1/management/config/source", string(putNoRev))
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("expected 400 for missing revision, got %d body %s", resp.StatusCode, payload)
	}

	// 6. PUT source with outdated revision must return 409 config_conflict
	putStale, _ := json.Marshal(map[string]string{"yaml": `host: 0.0.0.0
`, "revision": "outdated-sha256-hex"})
	resp, payload = doJSON(t, client, http.MethodPut, baseURL+"/omc/api/v1/management/config/source", string(putStale))
	if resp.StatusCode != http.StatusConflict {
		t.Fatalf("expected 409 config_conflict, got %d body %s", resp.StatusCode, payload)
	}
	var conflictObj map[string]any
	_ = json.Unmarshal(payload, &conflictObj)
	if conflictObj["code"] != "config_conflict" || conflictObj["current_revision"] != srcRes.Revision {
		t.Fatalf("unexpected conflict payload: %#v", conflictObj)
	}

	// 7. PUT source with invalid YAML syntax returns 400 yaml_syntax_error with line & col
	putBadSyntax, _ := json.Marshal(map[string]string{"yaml": `bad: [unclosed
`, "revision": srcRes.Revision})
	resp, payload = doJSON(t, client, http.MethodPut, baseURL+"/omc/api/v1/management/config/source", string(putBadSyntax))
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("expected 400 for syntax error, got %d body %s", resp.StatusCode, payload)
	}
	var synObj map[string]any
	_ = json.Unmarshal(payload, &synObj)
	if synObj["code"] != "yaml_syntax_error" {
		t.Fatalf("expected yaml_syntax_error, got %#v", synObj)
	}

	// 8. PUT source with matching revision succeeds and returns new revision
	newYAML := `host: 0.0.0.0
port: 8317
debug: true
`
	putGood, _ := json.Marshal(map[string]string{"yaml": newYAML, "revision": srcRes.Revision})
	resp, payload = doJSON(t, client, http.MethodPut, baseURL+"/omc/api/v1/management/config/source", string(putGood))
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("put source with valid revision failed: %d body %s", resp.StatusCode, payload)
	}
	var putRes struct {
		Status   string `json:"status"`
		Revision string `json:"revision"`
	}
	_ = json.Unmarshal(payload, &putRes)
	if putRes.Status != "ok" || putRes.Revision == "" || putRes.Revision == srcRes.Revision {
		t.Fatalf("expected new revision, got %#v", putRes)
	}
}
