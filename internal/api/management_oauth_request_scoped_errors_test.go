package api

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/management"
)

const oauthRequestScopedErrorsUpstreamPath = "/v8/management/config/oauth/request-scoped-errors"

func oauthRequestScopedErrorsUpstream(t *testing.T, state map[string][]management.RequestScopedErrorRule) http.HandlerFunc {
	t.Helper()
	return func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		switch {
		case request.Method == http.MethodGet && request.URL.Path == oauthRequestScopedErrorsUpstreamPath:
			_ = json.NewEncoder(writer).Encode(state)
		case request.Method == http.MethodPatch && request.URL.Path == "/v8/management/config":
			var payload struct {
				OAuth struct {
					RequestScopedErrors map[string][]management.RequestScopedErrorRule `json:"request-scoped-errors"`
				} `json:"oauth"`
			}
			if err := json.NewDecoder(request.Body).Decode(&payload); err != nil {
				t.Fatalf("decode request-scoped errors patch: %v", err)
			}
			for provider, rules := range payload.OAuth.RequestScopedErrors {
				state[provider] = rules
			}
			_, _ = writer.Write([]byte(`{"status":"ok"}`))
		case request.Method == http.MethodDelete && strings.HasPrefix(request.URL.Path, oauthRequestScopedErrorsUpstreamPath+"/"):
			delete(state, strings.TrimPrefix(request.URL.Path, oauthRequestScopedErrorsUpstreamPath+"/"))
			_, _ = writer.Write([]byte(`{"status":"ok"}`))
		default:
			_, _ = writer.Write([]byte(`{}`))
		}
	}
}

func TestManagementOAuthRequestScopedErrorsRoundTrip(t *testing.T) {
	state := map[string][]management.RequestScopedErrorRule{
		"Copilot": {
			{Status: 400, Match: []string{"  context_length  "}, MatchRegex: []string{" ^too_long$ "}, Action: " STOP "},
			{Status: 0, Match: []string{"invalid"}, Action: "stop"},
		},
		"claude": {
			{Status: 429, Match: []string{"rate_limit"}, Action: "continue-and-cooldown"},
		},
		"legacy:channel": {
			{Status: 500, Match: []string{"ignored"}, Action: "stop"},
		},
	}
	client, baseURL, recorder := startAuthFilesTestServer(t, "management-secret-value", oauthRequestScopedErrorsUpstream(t, state))
	base := baseURL + "/omc/api/v1/management/auth-files/request-scoped-errors"

	response, raw := doJSON(t, client, http.MethodGet, base, "")
	if response.StatusCode != http.StatusOK {
		t.Fatalf("list request-scoped errors = %d body = %s", response.StatusCode, raw)
	}
	var listed OAuthRequestScopedErrorsResponseDTO
	if err := json.Unmarshal(raw, &listed); err != nil {
		t.Fatal(err)
	}
	if len(listed.RequestScopedErrors["copilot"]) != 1 {
		t.Fatalf("copilot rules = %#v, want 1 sanitized rule", listed.RequestScopedErrors["copilot"])
	}
	gotRule := listed.RequestScopedErrors["copilot"][0]
	if gotRule.Status != 400 || gotRule.Action != "stop" || strings.Join(gotRule.Match, ",") != "context_length" || strings.Join(gotRule.MatchRegex, ",") != "^too_long$" {
		t.Fatalf("unexpected copilot rule: %+v", gotRule)
	}
	for _, provider := range []string{"legacy:channel", "Copilot"} {
		if _, exists := listed.RequestScopedErrors[provider]; exists {
			t.Fatalf("%q leaked into projection: %#v", provider, listed.RequestScopedErrors)
		}
	}

	response, raw = doJSON(t, client, http.MethodPatch, base, `{"provider":"COPILOT","rules":[{"status":429,"match":[" rate_limit_exceeded "],"match_regex":[" ^quota_.*$ "],"action":" STOP-AND-COOLDOWN "}]}`)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("patch request-scoped errors = %d body = %s", response.StatusCode, raw)
	}
	var mutation OAuthRequestScopedErrorsPatchResponseDTO
	if err := json.Unmarshal(raw, &mutation); err != nil {
		t.Fatal(err)
	}
	if mutation.Status != "ok" || mutation.Provider != "copilot" || len(mutation.Rules) != 1 || mutation.Rules[0].Action != "stop-and-cooldown" {
		t.Fatalf("request-scoped errors mutation = %s", raw)
	}
	forwarded := recorder.last(t, http.MethodPatch, "/v8/management/config")
	if !strings.Contains(forwarded.Body, `"request-scoped-errors":{"copilot":[`) || !strings.Contains(forwarded.Body, `"match-regexr":["^quota_.*$"]`) {
		t.Fatalf("forwarded patch = %s", forwarded.Body)
	}
	recorder.last(t, http.MethodDelete, oauthRequestScopedErrorsUpstreamPath+"/Copilot")
	if _, exists := state["Copilot"]; exists {
		t.Fatalf("alternate spelling Copilot survived replacement: %#v", state)
	}
	if len(state["claude"]) != 1 || state["claude"][0].Status != 429 {
		t.Fatalf("unrelated provider claude changed: %#v", state["claude"])
	}

	response, raw = doJSON(t, client, http.MethodPatch, base, `{"provider":"copilot","rules":[]}`)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("delete request-scoped errors = %d body = %s", response.StatusCode, raw)
	}
	var deletion struct {
		Rules json.RawMessage `json:"rules"`
	}
	if err := json.Unmarshal(raw, &deletion); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(bytes.TrimSpace(deletion.Rules), []byte("[]")) {
		t.Fatalf("deleted rules must be JSON [], got %s", deletion.Rules)
	}
	if _, exists := state["copilot"]; exists {
		t.Fatalf("copilot rules were not deleted: %#v", state)
	}
}

func TestManagementOAuthRequestScopedErrorsRequireReadback(t *testing.T) {
	handler := func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		if request.Method == http.MethodGet && request.URL.Path == oauthRequestScopedErrorsUpstreamPath {
			_, _ = writer.Write([]byte(`{"copilot":[{"status":500,"match":["different"],"action":"continue"}]}`))
			return
		}
		_, _ = writer.Write([]byte(`{"status":"ok"}`))
	}
	client, baseURL, _ := startAuthFilesTestServer(t, "management-secret-value", handler)
	response, raw := doJSON(t, client, http.MethodPatch, baseURL+"/omc/api/v1/management/auth-files/request-scoped-errors", `{"provider":"copilot","rules":[{"status":400,"match":["context_length"],"action":"stop"}]}`)
	if response.StatusCode != http.StatusBadGateway {
		t.Fatalf("unverified write = %d body = %s, want 502", response.StatusCode, raw)
	}
}

func TestManagementOAuthRequestScopedErrorsRejectOversizedStoredList(t *testing.T) {
	oversized := make([]management.RequestScopedErrorRule, maxProviderErrorRules+1)
	for i := range oversized {
		oversized[i] = management.RequestScopedErrorRule{Status: 400, Match: []string{"err"}, Action: "stop"}
	}
	submitted := make([]ProviderErrorRuleDTO, maxProviderErrorRules)
	for i := range submitted {
		submitted[i] = ProviderErrorRuleDTO{Status: 400, Match: []string{"err"}, Action: "stop"}
	}
	client, baseURL, _ := startAuthFilesTestServer(t, "management-secret-value", func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		if request.Method == http.MethodGet && request.URL.Path == oauthRequestScopedErrorsUpstreamPath {
			_ = json.NewEncoder(writer).Encode(map[string][]management.RequestScopedErrorRule{"copilot": oversized})
			return
		}
		_, _ = writer.Write([]byte(`{"status":"ok"}`))
	})
	base := baseURL + "/omc/api/v1/management/auth-files/request-scoped-errors"

	listResp, listBody := doJSON(t, client, http.MethodGet, base, "")
	if listResp.StatusCode != http.StatusBadGateway {
		t.Fatalf("GET oversized stored list = %d body = %s, want 502", listResp.StatusCode, listBody)
	}

	payload, _ := json.Marshal(map[string]any{"provider": "copilot", "rules": submitted})
	patchResp, patchBody := doJSON(t, client, http.MethodPatch, base, string(payload))
	if patchResp.StatusCode != http.StatusBadGateway {
		t.Fatalf("PATCH readback with extra retained rule = %d body = %s, want 502", patchResp.StatusCode, patchBody)
	}
}

func TestManagementOAuthRequestScopedErrorsGuardrails(t *testing.T) {
	client, baseURL, recorder := startAuthFilesTestServer(t, "management-secret-value", oauthRequestScopedErrorsUpstream(t, map[string][]management.RequestScopedErrorRule{}))
	base := baseURL + "/omc/api/v1/management/auth-files/request-scoped-errors"
	tooMany := make([]ProviderErrorRuleDTO, maxProviderErrorRules+1)
	for i := range tooMany {
		tooMany[i] = ProviderErrorRuleDTO{Status: 400, Match: []string{"err"}, Action: "stop"}
	}
	encodedTooMany, _ := json.Marshal(map[string]any{"provider": "copilot", "rules": tooMany})

	cases := map[string]string{
		"missing rules":    `{"provider":"copilot"}`,
		"invalid provider": `{"provider":"bad provider","rules":[]}`,
		"bad status":       `{"provider":"copilot","rules":[{"status":99,"match":["err"],"action":"stop"}]}`,
		"unknown action":   `{"provider":"copilot","rules":[{"status":400,"match":["err"],"action":"retry"}]}`,
		"missing matches":  `{"provider":"copilot","rules":[{"status":400,"action":"stop"}]}`,
		"whitespace match": `{"provider":"copilot","rules":[{"status":400,"match":["   "],"action":"stop"}]}`,
		"invalid regex":    `{"provider":"copilot","rules":[{"status":400,"match_regex":["[unclosed"],"action":"stop"}]}`,
		"too many rules":   string(encodedTooMany),
	}
	for name, body := range cases {
		t.Run(name, func(t *testing.T) {
			before := len(recordedCPARequests(recorder))
			response, raw := doJSON(t, client, http.MethodPatch, base, body)
			if response.StatusCode != http.StatusBadRequest {
				t.Fatalf("status = %d body = %s, want 400", response.StatusCode, raw)
			}
			if after := recordedCPARequests(recorder)[before:]; len(after) != 0 {
				t.Fatalf("invalid request reached CPA: %#v", after)
			}
		})
	}
}

func TestManagementOAuthRequestScopedErrorsAuditFailure(t *testing.T) {
	for _, outcome := range []string{"attempt", "success"} {
		t.Run(outcome, func(t *testing.T) {
			state := map[string][]management.RequestScopedErrorRule{
				"copilot": {{Status: 500, Match: []string{"original"}, Action: "continue"}},
				"claude":  {{Status: 400, Match: []string{"prompt is too long"}, Action: "stop"}},
			}
			var mu sync.Mutex
			patchCount := 0
			upstream := oauthRequestScopedErrorsUpstream(t, state)
			client, baseURL, repo := startDashboardTestServer(t, func(writer http.ResponseWriter, request *http.Request) {
				mu.Lock()
				defer mu.Unlock()
				if request.Method == http.MethodPatch && request.URL.Path == "/v8/management/config" {
					patchCount++
				}
				upstream(writer, request)
			})
			var triggerSQL string
			switch outcome {
			case "attempt":
				triggerSQL = `CREATE TRIGGER reject_oauth_error_rules_audit BEFORE INSERT ON audit_events
					WHEN NEW.action = 'oauth_request_scoped_errors.update' AND NEW.result = 'attempt'
					BEGIN SELECT RAISE(FAIL, 'audit unavailable'); END`
			case "success":
				triggerSQL = `CREATE TRIGGER reject_oauth_error_rules_audit BEFORE INSERT ON audit_events
					WHEN NEW.action = 'oauth_request_scoped_errors.update' AND NEW.result = 'success'
					BEGIN SELECT RAISE(FAIL, 'audit unavailable'); END`
			default:
				t.Fatalf("unexpected outcome %q", outcome)
			}
			_, err := repo.SQL().Exec(triggerSQL)
			if err != nil {
				t.Fatal(err)
			}
			response, raw := doJSON(t, client, http.MethodPatch, baseURL+"/omc/api/v1/management/auth-files/request-scoped-errors", `{"provider":"COPILOT","rules":[{"status":429,"match":["rate_limit"],"action":"stop-and-cooldown"}]}`)
			mu.Lock()
			defer mu.Unlock()
			if outcome == "attempt" {
				if response.StatusCode != http.StatusInternalServerError || patchCount != 0 || state["copilot"][0].Status != 500 {
					t.Fatalf("failed attempt audit: status=%d patches=%d state=%#v body=%s", response.StatusCode, patchCount, state, raw)
				}
			} else {
				if response.StatusCode != http.StatusOK || patchCount != 1 || state["copilot"][0].Status != 429 {
					t.Fatalf("failed success audit: status=%d patches=%d state=%#v body=%s", response.StatusCode, patchCount, state, raw)
				}
			}
			if len(state["claude"]) != 1 || state["claude"][0].Match[0] != "prompt is too long" {
				t.Fatalf("unrelated provider changed: %#v", state["claude"])
			}
		})
	}
}

func TestManagementOAuthRequestScopedErrorsStateCoordinatorRoundTrip(t *testing.T) {
	fixture := newProviderTestFixture(t)
	var mu sync.Mutex
	state := map[string][]management.RequestScopedErrorRule{
		"claude": {{Status: 400, Match: []string{"prompt is too long"}, Action: "stop"}},
	}
	upstream := newFakeCPA(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		writer.Header().Set("Content-Type", "application/json")
		switch {
		case request.Method == http.MethodGet && (request.URL.Path == "/v8/management/config.yaml" || request.URL.Path == "/v0/management/config.yaml"):
			_, _ = writer.Write([]byte("config-version: 8\n"))
		case request.Method == http.MethodGet && request.URL.Path == "/v8/management/config":
			_, _ = writer.Write([]byte(`{"config-version":8}`))
		case request.Method == http.MethodGet && strings.HasPrefix(request.URL.Path, "/v8/management/credentials"):
			_, _ = writer.Write([]byte(`{"files":[]}`))
		case request.Method == http.MethodGet && request.URL.Path == oauthRequestScopedErrorsUpstreamPath:
			_ = json.NewEncoder(writer).Encode(state)
		case request.Method == http.MethodPatch && request.URL.Path == "/v8/management/config":
			var payload struct {
				OAuth struct {
					RequestScopedErrors map[string][]management.RequestScopedErrorRule `json:"request-scoped-errors"`
				} `json:"oauth"`
			}
			if err := json.NewDecoder(request.Body).Decode(&payload); err != nil {
				t.Fatalf("decode patch: %v", err)
			}
			for provider, rules := range payload.OAuth.RequestScopedErrors {
				state[provider] = rules
			}
			_, _ = writer.Write([]byte(`{"status":"ok"}`))
		default:
			_, _ = writer.Write([]byte(`{}`))
		}
	}))
	defer upstream.Close()
	pointPlaygroundAt(t, fixture.handler, upstream.URL)

	if err := fixture.handler.EnableStateCoordinator(context.Background(), StateCoordinatorOptions{
		DebounceWindow: 30 * time.Millisecond,
		MaxBatchWait:   200 * time.Millisecond,
	}); err != nil {
		t.Fatalf("EnableStateCoordinator failed: %v", err)
	}
	t.Cleanup(func() { fixture.handler.CloseStateCoordinator(context.Background()) })

	resp, raw := doJSON(t, fixture.client, http.MethodPatch, fixture.baseURL+"/omc/api/v1/management/auth-files/request-scoped-errors", `{"provider":"copilot","rules":[{"status":429,"match":["rate_limit"],"action":"stop"}]}`)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("PATCH request-scoped-errors = %d body = %s", resp.StatusCode, raw)
	}

	// Read immediately from coordinator projection (before upstream flush completes).
	resp, raw = getJSON(t, fixture.client, fixture.baseURL+"/omc/api/v1/management/state")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("GET /management/state = %d body = %s", resp.StatusCode, raw)
	}
	var env struct {
		Data SafeProjectedStateDTO `json:"data"`
	}
	if err := json.Unmarshal(raw, &env); err != nil {
		t.Fatal(err)
	}
	if len(env.Data.OAuthRequestScopedErrors["copilot"]) != 1 || env.Data.OAuthRequestScopedErrors["copilot"][0].Status != 429 {
		t.Fatalf("projected state missing copilot error rules: %#v", env.Data.OAuthRequestScopedErrors)
	}

	// Wait for debounced flush to persist to CPA.
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		mu.Lock()
		flushed := len(state["copilot"]) == 1 && state["copilot"][0].Status == 429
		mu.Unlock()
		if flushed {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for StateCoordinator to flush copilot error rules to CPA; state=%#v", state)
}

func TestManagementOAuthRequestScopedErrorsPreserveDistinctProviderKeys(t *testing.T) {
	state := map[string][]management.RequestScopedErrorRule{
		"grok": {{Status: 400, Match: []string{"grok_only"}, Action: "stop"}},
		"xai":  {{Status: 429, Match: []string{"xai_only"}, Action: "continue"}},
	}
	client, baseURL, _ := startAuthFilesTestServer(t, "management-secret-value", oauthRequestScopedErrorsUpstream(t, state))
	base := baseURL + "/omc/api/v1/management/auth-files/request-scoped-errors"

	resp, raw := doJSON(t, client, http.MethodGet, base, "")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("GET = %d body = %s", resp.StatusCode, raw)
	}
	var listed OAuthRequestScopedErrorsResponseDTO
	if err := json.Unmarshal(raw, &listed); err != nil {
		t.Fatal(err)
	}
	if len(listed.RequestScopedErrors["grok"]) != 1 || listed.RequestScopedErrors["grok"][0].Match[0] != "grok_only" {
		t.Fatalf("grok rules = %#v, want distinct grok entry", listed.RequestScopedErrors["grok"])
	}
	if len(listed.RequestScopedErrors["xai"]) != 1 || listed.RequestScopedErrors["xai"][0].Match[0] != "xai_only" {
		t.Fatalf("xai rules = %#v, want distinct xai entry", listed.RequestScopedErrors["xai"])
	}

	// Clearing xai must leave grok intact and succeed readback.
	resp, raw = doJSON(t, client, http.MethodPatch, base, `{"provider":"xai","rules":[]}`)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("PATCH clear xai = %d body = %s", resp.StatusCode, raw)
	}
	if _, exists := state["xai"]; exists {
		t.Fatalf("xai should be removed: %#v", state)
	}
	if len(state["grok"]) != 1 {
		t.Fatalf("grok should remain untouched: %#v", state)
	}
}

func TestManagementOAuthRequestScopedErrorsWriteGateBusyReturns503(t *testing.T) {
	fixture := newProviderTestFixture(t)
	fixture.handler.providerWrites = providerWriteGate{
		permits:        make(chan struct{}, 1),
		acquireTimeout: 10 * time.Millisecond,
	}
	fixture.handler.providerWrites.permits <- struct{}{}
	t.Cleanup(func() { <-fixture.handler.providerWrites.permits })

	resp, raw := doJSON(t, fixture.client, http.MethodPatch, fixture.baseURL+"/omc/api/v1/management/auth-files/request-scoped-errors", `{"provider":"copilot","rules":[{"status":429,"match":["rate_limit"],"action":"stop"}]}`)
	if resp.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("busy write gate = %d body = %s, want 503", resp.StatusCode, raw)
	}
	if !strings.Contains(string(raw), `"code":"write_busy"`) {
		t.Fatalf("expected write_busy code, got %s", raw)
	}
}

func TestBuildSafeProjectedStateDTOPreservesUnavailableOAuthErrorRules(t *testing.T) {
	unavailable := buildSafeProjectedStateDTO(projectedConfigState{
		OAuthErrorRules:            map[string][]ProviderErrorRuleDTO{},
		OAuthErrorRulesUnavailable: true,
	})
	encodedUnavailable, err := json.Marshal(unavailable)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(encodedUnavailable), `"oauth_request_scoped_errors":null`) {
		t.Fatalf("expected null for unavailable rules, got %s", encodedUnavailable)
	}

	availableEmpty := buildSafeProjectedStateDTO(projectedConfigState{
		OAuthErrorRules:            map[string][]ProviderErrorRuleDTO{},
		OAuthErrorRulesUnavailable: false,
	})
	encodedAvailable, err := json.Marshal(availableEmpty)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(encodedAvailable), `"oauth_request_scoped_errors":{}`) {
		t.Fatalf("expected empty object for loaded empty rules, got %s", encodedAvailable)
	}
}
