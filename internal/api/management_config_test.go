package api

import (
	"encoding/json"
	"net/http"
	"strings"
	"sync"
	"testing"

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

func TestManagementConfigSourceGetAndPut(t *testing.T) {
	fixture := &configFixtureCPA{}
	client, baseURL, _ := startDashboardTestServer(t, fixture.serve)

	// GET source
	resp, payload := getJSON(t, client, baseURL+"/omc/api/v1/management/config/source")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("get source status = %d body %s", resp.StatusCode, payload)
	}
	var srcRes struct {
		YAML      string `json:"yaml"`
		SizeBytes int    `json:"size_bytes"`
	}
	if err := json.Unmarshal(payload, &srcRes); err != nil {
		t.Fatalf("decode source response: %v", err)
	}
	if !strings.Contains(srcRes.YAML, "host: 127.0.0.1") || srcRes.SizeBytes == 0 {
		t.Fatalf("unexpected yaml content: %s", srcRes.YAML)
	}

	// PUT source success
	newYAML := "host: 0.0.0.0\nport: 8317\ndebug: true\n"
	putBody, _ := json.Marshal(map[string]string{"yaml": newYAML})
	resp, payload = doJSON(t, client, http.MethodPut, baseURL+"/omc/api/v1/management/config/source", string(putBody))
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("put source status = %d body %s", resp.StatusCode, payload)
	}

	// PUT source invalid YAML error propagation
	fixture.mu.Lock()
	fixture.yamlError = true
	fixture.mu.Unlock()

	badYAML := "bad: [unclosed"
	badPutBody, _ := json.Marshal(map[string]string{"yaml": badYAML})
	resp, payload = doJSON(t, client, http.MethodPut, baseURL+"/omc/api/v1/management/config/source", string(badPutBody))
	if resp.StatusCode == http.StatusOK {
		t.Fatalf("expected error for bad YAML, got 200")
	}
}
