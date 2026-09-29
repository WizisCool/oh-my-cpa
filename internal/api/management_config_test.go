package api

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/configyaml"
	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/management"
)

// configFixtureCPA is a v8 gateway's configuration endpoints: a JSON and a YAML
// view of one document, and the writes sent to them.
type configFixtureCPA struct {
	mu         sync.Mutex
	writes     []string
	bodies     []string
	configData map[string]any
	yamlData   string
	// rejectWrites answers every write the way CPA refuses an invalid document.
	rejectWrites bool
	// rejectMessage replaces CPA's explanation when writes are refused.
	rejectMessage string
}

const configFixtureYAML = `server:
    host: 127.0.0.1
    port: 8317
management:
    secret-key: top-secret-management-key
observability:
    logs:
        debug: false
config-version: 8
`

func (f *configFixtureCPA) serve(writer http.ResponseWriter, request *http.Request) {
	path := strings.TrimPrefix(request.URL.Path, "/v8/management")
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.yamlData == "" {
		f.yamlData = configFixtureYAML
	}

	if request.Method == http.MethodGet {
		switch path {
		case "/config":
			writer.Header().Set("Content-Type", "application/json")
			if f.configData == nil {
				f.configData = map[string]any{
					"requests": map[string]any{"proxy-url": "http://proxy:8080"},
					"observability": map[string]any{
						"logs":  map[string]any{"debug": false, "request-log": true, "logs-max-total-size-mb": 100, "error-logs-max-files": 5},
						"usage": map[string]any{"usage-statistics-enabled": true},
					},
					"routing": map[string]any{
						"strategy": "least-load",
						"retry":    map[string]any{"request-retry": 3, "max-retry-interval": 30, "max-retry-credentials": 2},
					},
					// Secret and complex fields that must be redacted
					"management": map[string]any{"secret-key": "top-secret-management-key"},
					"access":     map[string]any{"api-keys": []any{"key-1", "key-2"}},
					"api-keys": map[string]any{
						"codex":  []any{map[string]any{"name": "codex-1", "keys": []any{map[string]any{"api-key": "secret-codex-key"}}}},
						"gemini": []any{map[string]any{"name": "gemini-1", "keys": []any{map[string]any{"api-key": "secret-gemini-key"}}}},
					},
				}
			}
			_ = json.NewEncoder(writer).Encode(f.configData)
		case "/config.yaml":
			writer.Header().Set("Content-Type", "application/yaml")
			_, _ = writer.Write([]byte(f.yamlData))
		default:
			writer.WriteHeader(http.StatusNotFound)
		}
		return
	}

	body, _ := io.ReadAll(request.Body)
	f.writes = append(f.writes, request.Method+" "+path)
	f.bodies = append(f.bodies, string(body))
	if f.rejectWrites {
		message := f.rejectMessage
		if message == "" {
			message = "legacy field debug is not accepted by v8; use observability.logs.debug"
		}
		refusal, _ := json.Marshal(map[string]string{"error": "invalid_config", "message": message})
		writer.WriteHeader(http.StatusBadRequest)
		_, _ = writer.Write(refusal)
		return
	}
	switch {
	case request.Method == http.MethodPut && path == "/config.yaml":
		// CPA stores the document in its own rendering.
		f.yamlData = string(body) + "config-version: 8\n"
	default:
		f.yamlData += "# written\n"
	}
	writer.Header().Set("Content-Type", "application/json")
	_, _ = writer.Write([]byte(`{"status":"ok","config-version":8}`))
}

func (f *configFixtureCPA) recordedWrites() ([]string, []string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.writes...), append([]string(nil), f.bodies...)
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

	if writes, _ := fixture.recordedWrites(); len(writes) != 0 {
		t.Fatalf("a refused scalar write reached CPA: %v", writes)
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
	newYAML := `server:
    host: 0.0.0.0
    port: 8317
observability:
    logs:
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
		YAML     string `json:"yaml"`
	}
	_ = json.Unmarshal(payload, &putRes)
	if putRes.Status != "ok" || putRes.Revision == "" || putRes.Revision == srcRes.Revision {
		t.Fatalf("expected new revision, got %#v", putRes)
	}
	// The answer is CPA's rendering of what it stored, which is what the next
	// save is compared against: the submitted text is not assumed to survive.
	resp, payload = getJSON(t, client, baseURL+"/omc/api/v1/management/config/source")
	_ = json.Unmarshal(payload, &srcRes)
	if resp.StatusCode != http.StatusOK || srcRes.Revision != putRes.Revision || srcRes.YAML != putRes.YAML {
		t.Fatalf("saved revision %q does not match the stored one %q", putRes.Revision, srcRes.Revision)
	}
	writes, bodies := fixture.recordedWrites()
	// The client secret-key sentinel is not involved, so the operator's text
	// reaches CPA's v8 source endpoint unchanged.
	if len(writes) != 1 || writes[0] != "PUT /config.yaml" || bodies[0] != newYAML {
		t.Fatalf("writes = %v, bodies = %q", writes, bodies)
	}
}

// CPA refuses a document it would partly ignore (a legacy field name, a wrong
// type); the console reports CPA's reason instead of a generic failure.
func TestManagementConfigSourcePutReportsCPARejection(t *testing.T) {
	fixture := &configFixtureCPA{rejectWrites: true}
	client, baseURL, _ := startDashboardTestServer(t, fixture.serve)
	_, payload := getJSON(t, client, baseURL+"/omc/api/v1/management/config/source")
	var source struct {
		Revision string `json:"revision"`
	}
	_ = json.Unmarshal(payload, &source)
	body, _ := json.Marshal(map[string]string{"yaml": "debug: true\n", "revision": source.Revision})
	resp, payload := doJSON(t, client, http.MethodPut, baseURL+"/omc/api/v1/management/config/source", string(body))
	var refusal map[string]any
	_ = json.Unmarshal(payload, &refusal)
	if resp.StatusCode != http.StatusUnprocessableEntity || refusal["code"] != "config_rejected" || !strings.Contains(fmt.Sprint(refusal["error"]), "observability.logs.debug") || !strings.Contains(fmt.Sprint(refusal["reason"]), "observability.logs.debug") {
		t.Fatalf("status = %d body %s", resp.StatusCode, payload)
	}
}

func TestManagementConfigPatchSendsOnlyTheChangedSettings(t *testing.T) {
	fixture := &configFixtureCPA{}
	client, baseURL, _ := startDashboardTestServer(t, fixture.serve)
	_, payload := getJSON(t, client, baseURL+"/omc/api/v1/management/config")
	var loaded struct {
		Revision     string `json:"revision"`
		SafeYAML     string `json:"safe_yaml"`
		StoredLayout string `json:"stored_layout"`
	}
	if err := json.Unmarshal(payload, &loaded); err != nil {
		t.Fatal(err)
	}
	if loaded.StoredLayout != "v8" || strings.Contains(loaded.SafeYAML, "top-secret-management-key") {
		t.Fatalf("loaded = %#v", loaded)
	}
	patch := func(body map[string]any) (*http.Response, []byte) {
		encoded, _ := json.Marshal(body)
		return doJSON(t, client, http.MethodPatch, baseURL+"/omc/api/v1/management/config", string(encoded))
	}

	// Nothing to save and no revision are both refused before CPA is called.
	if resp, _ := patch(map[string]any{"revision": loaded.Revision, "changes": []any{}}); resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("empty change set: %d", resp.StatusCode)
	}
	if resp, _ := patch(map[string]any{"changes": []any{map[string]any{"path": []string{"observability", "logs", "debug"}, "value": true}}}); resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("missing revision: %d", resp.StatusCode)
	}
	if resp, _ := patch(map[string]any{"revision": "stale", "changes": []any{map[string]any{"path": []string{"observability", "logs", "debug"}, "value": true}}}); resp.StatusCode != http.StatusConflict {
		t.Fatalf("stale revision: %d", resp.StatusCode)
	}
	if writes, _ := fixture.recordedWrites(); len(writes) != 0 {
		t.Fatalf("refused saves reached CPA: %v", writes)
	}

	resp, payload := patch(map[string]any{"revision": loaded.Revision, "changes": []any{
		map[string]any{"path": []string{"observability", "logs", "debug"}, "value": true},
		// A masked secret the operator did not change is put back, not sent masked.
		map[string]any{"path": []string{"management", "secret-key"}, "value": configyaml.UnchangedSentinel},
		map[string]any{"path": []string{"requests", "proxy-url"}, "remove": true},
	}})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("patch status = %d body %s", resp.StatusCode, payload)
	}
	var saved struct {
		Revision string `json:"revision"`
		SafeYAML string `json:"safe_yaml"`
	}
	_ = json.Unmarshal(payload, &saved)
	if saved.Revision == "" || saved.Revision == loaded.Revision || strings.Contains(saved.SafeYAML, "top-secret-management-key") {
		t.Fatalf("saved = %#v", saved)
	}
	writes, bodies := fixture.recordedWrites()
	if strings.Join(writes, "|") != "PATCH /config|DELETE /config/requests/proxy-url" {
		t.Fatalf("writes = %v", writes)
	}
	if bodies[0] != `{"management":{"secret-key":"top-secret-management-key"},"observability":{"logs":{"debug":true}}}` {
		t.Fatalf("PATCH body = %s", bodies[0])
	}
}

func TestManagementConfigPatchReportsCPARejection(t *testing.T) {
	fixture := &configFixtureCPA{rejectWrites: true}
	client, baseURL, _ := startDashboardTestServer(t, fixture.serve)
	_, payload := getJSON(t, client, baseURL+"/omc/api/v1/management/config")
	var loaded struct {
		Revision string `json:"revision"`
	}
	_ = json.Unmarshal(payload, &loaded)
	body, _ := json.Marshal(map[string]any{"revision": loaded.Revision, "changes": []any{map[string]any{"path": []string{"debug"}, "value": true}}})
	resp, payload := doJSON(t, client, http.MethodPatch, baseURL+"/omc/api/v1/management/config", string(body))
	if resp.StatusCode != http.StatusUnprocessableEntity || !strings.Contains(string(payload), "config_rejected") {
		t.Fatalf("status = %d body %s", resp.StatusCode, payload)
	}
}

// CPA's reason can quote the value it refused, and a save puts the stored
// secrets back into what it sends; the reason reaches the console without them.
func TestManagementConfigPatchRejectionDoesNotEchoRestoredSecrets(t *testing.T) {
	fixture := &configFixtureCPA{rejectWrites: true, rejectMessage: `management.secret-key: "top-secret-management-key" is too short`}
	client, baseURL, _ := startDashboardTestServer(t, fixture.serve)
	_, payload := getJSON(t, client, baseURL+"/omc/api/v1/management/config")
	var loaded struct {
		Revision string `json:"revision"`
	}
	_ = json.Unmarshal(payload, &loaded)
	body, _ := json.Marshal(map[string]any{"revision": loaded.Revision, "changes": []any{
		map[string]any{"path": []string{"management", "secret-key"}, "value": configyaml.UnchangedSentinel},
	}})
	resp, payload := doJSON(t, client, http.MethodPatch, baseURL+"/omc/api/v1/management/config", string(body))
	if resp.StatusCode != http.StatusUnprocessableEntity || strings.Contains(string(payload), "top-secret-management-key") || !strings.Contains(string(payload), "management.secret-key") {
		t.Fatalf("status = %d body %s", resp.StatusCode, payload)
	}
}

// The first v8 write converts a legacy file irreversibly, so the file as it was
// is kept, encrypted, before anything is sent, and can be read back.
func TestManagementConfigFirstSaveKeepsTheLegacyFile(t *testing.T) {
	legacy := "# operator notes\nport: 8317\ndebug: false\nremote-management:\n  secret-key: legacy-secret\n"
	fixture := &configFixtureCPA{}
	client, baseURL, repo := startDashboardTestServerStoring(t, legacy, fixture.serve)

	_, payload := getJSON(t, client, baseURL+"/omc/api/v1/management/config")
	var loaded struct {
		Revision     string `json:"revision"`
		StoredLayout string `json:"stored_layout"`
	}
	_ = json.Unmarshal(payload, &loaded)
	if loaded.StoredLayout != "legacy" {
		t.Fatalf("stored_layout = %q", loaded.StoredLayout)
	}
	_, payload = getJSON(t, client, baseURL+"/omc/api/v1/management/config/backups")
	if !strings.Contains(string(payload), `"backups":[]`) {
		t.Fatalf("backups before the first save = %s", payload)
	}

	body, _ := json.Marshal(map[string]any{"revision": loaded.Revision, "changes": []any{map[string]any{"path": []string{"observability", "logs", "debug"}, "value": true}}})
	if resp, payload := doJSON(t, client, http.MethodPatch, baseURL+"/omc/api/v1/management/config", string(body)); resp.StatusCode != http.StatusOK {
		t.Fatalf("patch status = %d body %s", resp.StatusCode, payload)
	}

	_, payload = getJSON(t, client, baseURL+"/omc/api/v1/management/config/backups")
	var listed struct {
		Backups []struct {
			ID        int64 `json:"id"`
			SizeBytes int64 `json:"size_bytes"`
		} `json:"backups"`
	}
	_ = json.Unmarshal(payload, &listed)
	if len(listed.Backups) != 1 || listed.Backups[0].SizeBytes != int64(len(legacy)) || strings.Contains(string(payload), "legacy-secret") || strings.Contains(string(payload), "gateway_url") {
		t.Fatalf("backups = %s", payload)
	}
	_, payload = getJSON(t, client, fmt.Sprintf("%s/omc/api/v1/management/config/backups/%d", baseURL, listed.Backups[0].ID))
	var kept struct {
		YAML string `json:"yaml"`
	}
	_ = json.Unmarshal(payload, &kept)
	if kept.YAML != legacy {
		t.Fatalf("kept document = %q", kept.YAML)
	}
	if resp, _ := getJSON(t, client, baseURL+"/omc/api/v1/management/config/backups/999"); resp.StatusCode != http.StatusNotFound {
		t.Fatalf("missing backup status = %d", resp.StatusCode)
	}
	// Revealing a kept file is audited fail-closed: without the audit row the
	// document is not served.
	if _, err := repo.SQL().Exec("DROP TABLE audit_events"); err != nil {
		t.Fatal(err)
	}
	resp, payload := getJSON(t, client, fmt.Sprintf("%s/omc/api/v1/management/config/backups/%d", baseURL, listed.Backups[0].ID))
	if resp.StatusCode != http.StatusInternalServerError || strings.Contains(string(payload), "legacy-secret") {
		t.Fatalf("reveal without audit = %d body %s", resp.StatusCode, payload)
	}
}

func TestManagementConfigSourcePutRejectsOversizedBody(t *testing.T) {
	fixture := &configFixtureCPA{}
	client, baseURL, _ := startDashboardTestServer(t, fixture.serve)
	oversized := strings.Repeat("a", 2*1024*1024+1)
	resp, payload := doJSON(t, client, http.MethodPut, baseURL+"/omc/api/v1/management/config/source",
		`{"yaml":"`+oversized+`","revision":"some-revision"}`)
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("oversized source body must be refused, got %d body %s", resp.StatusCode, payload)
	}
}

// A restore that cannot prove which stored entry a hidden value belongs to must
// be refused before anything is written upstream, so a reordered list can never
// publish one entry's secret onto another entry.
func TestManagementConfigSourcePutRefusesUnprovableSequenceRestore(t *testing.T) {
	fixture := &configFixtureCPA{}
	fixture.yamlData = `servers:
  - name: alpha
    tls:
      key: key-for-alpha
  - name: beta
    tls:
      key: key-for-beta
config-version: 8
`
	client, baseURL, _ := startDashboardTestServer(t, fixture.serve)

	// The console edits the safe view from GET /config, which masks the keys.
	resp, payload := getJSON(t, client, baseURL+"/omc/api/v1/management/config")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("config GET failed: %d body %s", resp.StatusCode, payload)
	}
	var configRes struct {
		SafeYAML string `json:"safe_yaml"`
		Revision string `json:"revision"`
	}
	if err := json.Unmarshal(payload, &configRes); err != nil {
		t.Fatalf("decode config response: %v", err)
	}
	if strings.Contains(configRes.SafeYAML, "key-for-alpha") || strings.Contains(configRes.SafeYAML, "key-for-beta") {
		t.Fatalf("safe view leaked a stored key: %s", configRes.SafeYAML)
	}

	// The operator swaps the two entries while both still carry the sentinel.
	swapped := strings.ReplaceAll(configRes.SafeYAML, "name: alpha", "name: __PLACEHOLDER__")
	swapped = strings.ReplaceAll(swapped, "name: beta", "name: alpha")
	swapped = strings.ReplaceAll(swapped, "name: __PLACEHOLDER__", "name: beta")
	if !strings.Contains(swapped, configyaml.UnchangedSentinel) {
		t.Fatalf("safe view did not mask the keys: %s", swapped)
	}
	body, _ := json.Marshal(map[string]string{"yaml": swapped, "revision": configRes.Revision})

	resp, payload = doJSON(t, client, http.MethodPut, baseURL+"/omc/api/v1/management/config/source", string(body))
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("expected 400 for an unprovable entry restore, got %d body %s", resp.StatusCode, payload)
	}

	_, bodies := fixture.recordedWrites()
	for _, written := range bodies {
		if strings.Contains(written, "key-for-alpha") || strings.Contains(written, "key-for-beta") {
			t.Fatalf("refused save still wrote stored keys upstream: %s", written)
		}
	}
}

func TestManagementConfigSaveAuditFailure(t *testing.T) {
	for _, mode := range []string{"changes", "source"} {
		for _, outcome := range []string{"attempt", "success"} {
			t.Run(mode+"/"+outcome, func(t *testing.T) {
				fixture := &configFixtureCPA{}
				client, baseURL, repo := startDashboardTestServer(t, fixture.serve)
				// Refuse only the selected audit phase so the success case reaches CPA.
				_, err := repo.SQL().Exec(`CREATE TRIGGER reject_config_audit BEFORE INSERT ON audit_events
					WHEN NEW.action = 'config.save_` + mode + `' AND NEW.result = '` + outcome + `'
					BEGIN SELECT RAISE(FAIL, 'audit unavailable'); END`)
				if err != nil {
					t.Fatal(err)
				}
				method, path, baselineKey := http.MethodPatch, "/management/config", "safe_yaml"
				body := map[string]any{
					"revision": configyaml.ComputeRevision(configFixtureYAML),
					"changes":  []management.ConfigChange{{Path: []string{"observability", "logs", "debug"}, Value: true}},
				}
				if mode == "source" {
					method, path, baselineKey = http.MethodPut, "/management/config/source", "yaml"
					body = map[string]any{"revision": body["revision"], "yaml": "server:\n  port: 8318\n"}
				}
				encoded, err := json.Marshal(body)
				if err != nil {
					t.Fatal(err)
				}
				response, payload := doJSON(t, client, method, baseURL+"/omc/api/v1"+path, string(encoded))
				writes, _ := fixture.recordedWrites()
				if outcome == "attempt" {
					if response.StatusCode != http.StatusInternalServerError || len(writes) != 0 {
						t.Fatalf("failed attempt audit: status %d, writes %v, body %s", response.StatusCode, writes, payload)
					}
					return
				}
				if response.StatusCode != http.StatusOK || len(writes) != 1 {
					t.Fatalf("failed success audit: status %d, writes %v, body %s", response.StatusCode, writes, payload)
				}
				var saved map[string]any
				if err := json.Unmarshal(payload, &saved); err != nil {
					t.Fatal(err)
				}
				fixture.mu.Lock()
				storedYAML := fixture.yamlData
				fixture.mu.Unlock()
				wantBaseline := storedYAML
				if mode == "changes" {
					wantBaseline, err = configyaml.SanitizeSafeYAML(storedYAML)
					if err != nil {
						t.Fatal(err)
					}
				}
				wantRevision := configyaml.ComputeRevision(storedYAML)
				if saved["status"] != "ok" || saved["revision"] != wantRevision || saved[baselineKey] != wantBaseline || response.Header.Get("ETag") != fmt.Sprintf("%q", wantRevision) {
					t.Fatalf("saved baseline mismatch: body %s, ETag %q", payload, response.Header.Get("ETag"))
				}
			})
		}
	}
}
