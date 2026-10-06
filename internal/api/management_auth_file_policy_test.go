package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"testing"
)

// credentialPolicyUpstream is a CPA holding one credential whose stored file a
// fields patch edits the way CPA does: keys are canonicalised first, and a null
// retry count removes the key.
type credentialPolicyUpstream struct {
	mu            sync.Mutex
	stored        map[string]any
	refreshStatus int
}

func (u *credentialPolicyUpstream) serve(t *testing.T) http.HandlerFunc {
	return func(writer http.ResponseWriter, request *http.Request) {
		u.mu.Lock()
		defer u.mu.Unlock()
		writer.Header().Set("Content-Type", "application/json")
		switch request.URL.Path {
		case "/v8/management/credentials":
			_, _ = writer.Write([]byte(`{"files":[{"name":"codex.json","auth_index":"idx-1","type":"codex","provider":"codex","status":"ok"}]}`))
		case "/v8/management/credentials/download":
			_ = json.NewEncoder(writer).Encode(u.stored)
		case "/v8/management/credentials/fields":
			var patch map[string]any
			if err := json.NewDecoder(request.Body).Decode(&patch); err != nil {
				t.Errorf("decode fields patch: %v", err)
			}
			delete(patch, "name")
			// CPA rewrites a file's hyphenated keys to their canonical names before patching it.
			for key, value := range u.stored {
				if canonical := strings.ReplaceAll(key, "-", "_"); canonical != key {
					delete(u.stored, key)
					u.stored[canonical] = value
				}
			}
			for key, value := range patch {
				if value == nil {
					delete(u.stored, key)
				} else {
					u.stored[key] = value
				}
			}
			_, _ = writer.Write([]byte(`{"status":"ok"}`))
		case "/v8/management/credentials/refresh":
			if u.refreshStatus != http.StatusOK {
				writer.WriteHeader(u.refreshStatus)
				_, _ = writer.Write([]byte(`{"error":"token endpoint said: invalid_grant for PROVIDER-SIDE-DETAIL"}`))
				return
			}
			_, _ = writer.Write([]byte(`{"ok":true,"auth":{"id":"codex.json","metadata":{"refresh_token":"RENEWED-TOKEN-SECRET"}}}`))
		default:
			_, _ = writer.Write([]byte(`{"status":"ok"}`))
		}
	}
}

func TestCredentialPolicyFieldsRoundTrip(t *testing.T) {
	upstream := &credentialPolicyUpstream{stored: map[string]any{
		"type": "codex", "refresh_token": "STORED-TOKEN-SECRET", "request-retry": float64(4),
		"request-scoped-errors": []any{map[string]any{"status": float64(500), "match": []any{" boom "}, "action": "continue"}},
	}}
	client, baseURL, recorder := startAuthFilesTestServer(t, "management-secret-value", upstream.serve(t))
	base := baseURL + "/omc/api/v1/management/auth-files"

	// A file CPA wrote with its own hyphenated names reads the same as a patched one.
	response, raw := doJSON(t, client, http.MethodGet, base+"/safe-fields?name=codex.json&auth_index=idx-1", "")
	var safe managementAuthFileSafeFields
	if err := json.Unmarshal(raw, &safe); err != nil || response.StatusCode != http.StatusOK {
		t.Fatalf("safe fields = %d %s", response.StatusCode, raw)
	}
	if safe.RequestRetry == nil || *safe.RequestRetry != 4 || len(safe.ErrorRules) != 1 || safe.ErrorRules[0].Match[0] != " boom " {
		t.Fatalf("stored policy = %+v, want the retry count and the rule with its pattern verbatim", safe)
	}

	body := `{"name":"codex.json","auth_index":"idx-1","request_retry":0,"request_scoped_errors":[
		{"status":429,"match":["quota"],"match_regex":["rate.?limit"],"action":" Stop-And-Cooldown "}]}`
	response, raw = doJSON(t, client, http.MethodPatch, base+"/fields", body)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("fields patch = %d %s", response.StatusCode, raw)
	}
	var forwarded map[string]any
	if err := json.Unmarshal([]byte(recorder.last(t, http.MethodPatch, "/v8/management/credentials/fields").Body), &forwarded); err != nil {
		t.Fatal(err)
	}
	rule := anyList(forwarded["request_scoped_errors"])[0].(map[string]any)
	if forwarded["request_retry"] != float64(0) || rule["action"] != "stop-and-cooldown" || fmt.Sprint(rule["match-regexr"]) != "[rate.?limit]" {
		t.Fatalf("forwarded = %#v, want an explicit 0 and the rule under CPA's field names", forwarded)
	}
	if _, hasConsoleName := rule["match_regex"]; hasConsoleName {
		t.Fatalf("forwarded rule = %#v, want only CPA's field names", rule)
	}
	var mutation struct {
		Fields managementAuthFileSafeFields `json:"fields"`
	}
	if err := json.Unmarshal(raw, &mutation); err != nil {
		t.Fatal(err)
	}
	if mutation.Fields.RequestRetry == nil || *mutation.Fields.RequestRetry != 0 || len(mutation.Fields.ErrorRules) != 1 || mutation.Fields.ErrorRules[0].MatchRegex[0] != "rate.?limit" {
		t.Fatalf("read back = %+v, want the saved policy", mutation.Fields)
	}
	if strings.Contains(string(raw), "STORED-TOKEN-SECRET") {
		t.Fatalf("fields patch leaked the stored token: %s", raw)
	}

	// Null inherits the retry count and an empty list clears the rules.
	response, raw = doJSON(t, client, http.MethodPatch, base+"/fields", `{"name":"codex.json","auth_index":"idx-1","request_retry":null,"request_scoped_errors":[]}`)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("clearing patch = %d %s", response.StatusCode, raw)
	}
	var cleared struct {
		Fields managementAuthFileSafeFields `json:"fields"`
	}
	if err := json.Unmarshal(raw, &cleared); err != nil {
		t.Fatal(err)
	}
	if cleared.Fields.RequestRetry != nil || len(cleared.Fields.ErrorRules) != 0 {
		t.Fatalf("read back = %+v, want the policy cleared", cleared.Fields)
	}
}

func TestCredentialPolicyFieldsRefuseWhatCPAWouldSkip(t *testing.T) {
	upstream := &credentialPolicyUpstream{stored: map[string]any{"type": "codex"}}
	client, baseURL, recorder := startAuthFilesTestServer(t, "management-secret-value", upstream.serve(t))
	base := baseURL + "/omc/api/v1/management/auth-files"

	cases := map[string]string{
		`"request_retry":-1`:                                                                  "request_retry",
		`"request_retry":1.5`:                                                                 "request_retry",
		`"request_retry":"3"`:                                                                 "request_retry",
		`"request_scoped_errors":null`:                                                        "cannot be null",
		`"request_scoped_errors":{"status":429}`:                                              "array of rules",
		`"request_scoped_errors":[{"status":429,"action":"stop"}]`:                            "at least one",
		`"request_scoped_errors":[{"status":42,"match":["x"],"action":"stop"}]`:               "status",
		`"request_scoped_errors":[{"status":429,"match":["x"],"action":"retry"}]`:             "action",
		`"request_scoped_errors":[{"status":429,"match_regex":["("],"action":"stop"}]`:        "regular expression",
		`"request_scoped_errors":[{"status":429,"match":["x"],"action":"stop","headers":{}}]`: "array of rules",
		`"request_retry":1,"request-retry":2`:                                                 "same field",
		`"model_aliases":null`:                                                                "cannot be null",
		`"model_aliases":[{"name":"gpt-5","alias":""}]`:                                       "both required",
		`"model_aliases":[{"name":"gpt-5","alias":"GPT-5"}]`:                                  "must differ",
		`"model_aliases":[{"name":"a","alias":"x"},{"name":"b","alias":"X"}]`:                 "already used",
		`"model_aliases":[{"name":"a","alias":"x","headers":{}}]`:                             "array of aliases",
	}
	for fields, reason := range cases {
		response, raw := doJSON(t, client, http.MethodPatch, base+"/fields", `{"name":"codex.json","auth_index":"idx-1",`+fields+`}`)
		if response.StatusCode != http.StatusBadRequest || !strings.Contains(string(raw), reason) {
			t.Errorf("%s = %d %s, want 400 naming %q", fields, response.StatusCode, raw, reason)
		}
	}
	if count := recorder.count(http.MethodPatch, "/v8/management/credentials/fields"); count != 0 {
		t.Fatalf("CPA received %d field patches, want a refused one to send nothing", count)
	}
}

func TestCredentialRefreshReportsOnlyTheOutcome(t *testing.T) {
	upstream := &credentialPolicyUpstream{stored: map[string]any{"type": "codex"}, refreshStatus: http.StatusOK}
	client, baseURL, recorder := startAuthFilesTestServer(t, "management-secret-value", upstream.serve(t))
	endpoint := baseURL + "/omc/api/v1/management/auth-files/refresh"

	response, raw := doJSON(t, client, http.MethodPost, endpoint, `{"name":"codex.json","auth_index":"idx-1"}`)
	if response.StatusCode != http.StatusOK || strings.TrimSpace(string(raw)) != `{"status":"ok"}` {
		t.Fatalf("refresh = %d %s, want the outcome alone", response.StatusCode, raw)
	}
	var forwarded map[string]any
	if err := json.Unmarshal([]byte(recorder.last(t, http.MethodPost, "/v8/management/credentials/refresh").Body), &forwarded); err != nil {
		t.Fatal(err)
	}
	if forwarded["name"] != "codex.json" || forwarded["auth_index"] != "idx-1" || forwarded["all"] != nil {
		t.Fatalf("forwarded = %#v, want the one credential and never all", forwarded)
	}

	// A selector that names no single credential never reaches CPA, which would
	// otherwise match by name alone.
	response, raw = doJSON(t, client, http.MethodPost, endpoint, `{"name":"codex.json","auth_index":"idx-9"}`)
	if response.StatusCode != http.StatusNotFound {
		t.Fatalf("unknown credential = %d %s, want 404", response.StatusCode, raw)
	}
	if count := recorder.count(http.MethodPost, "/v8/management/credentials/refresh"); count != 1 {
		t.Fatalf("CPA received %d refreshes, want only the resolved one", count)
	}

	upstream.mu.Lock()
	upstream.refreshStatus = http.StatusInternalServerError
	upstream.mu.Unlock()
	response, raw = doJSON(t, client, http.MethodPost, endpoint, `{"name":"codex.json","auth_index":"idx-1"}`)
	if response.StatusCode < 500 {
		t.Fatalf("failed refresh = %d %s, want a gateway failure", response.StatusCode, raw)
	}
	if strings.Contains(string(raw), "PROVIDER-SIDE-DETAIL") {
		t.Fatalf("failed refresh leaked the provider's reason: %s", raw)
	}
}

func (r *cpaRecorder) count(method, path string) int {
	matched := 0
	for _, request := range r.all() {
		if request.Method == method && request.Path == path {
			matched++
		}
	}
	return matched
}

func TestCredentialModelAliasesRoundTrip(t *testing.T) {
	upstream := &credentialPolicyUpstream{stored: map[string]any{
		"type": "codex", "refresh_token": "STORED-TOKEN-SECRET",
		"model-aliases": []any{map[string]any{"name": "gpt-5", "alias": "fast", "force-mapping": true}, map[string]any{"name": "same", "alias": "SAME"}},
	}}
	client, baseURL, recorder := startAuthFilesTestServer(t, "management-secret-value", upstream.serve(t))
	base := baseURL + "/omc/api/v1/management/auth-files"

	response, raw := doJSON(t, client, http.MethodGet, base+"/safe-fields?name=codex.json&auth_index=idx-1", "")
	var safe managementAuthFileSafeFields
	if err := json.Unmarshal(raw, &safe); err != nil || response.StatusCode != http.StatusOK {
		t.Fatalf("safe fields = %d %s", response.StatusCode, raw)
	}
	if len(safe.ModelAliases) != 1 || safe.ModelAliases[0].Alias != "fast" || !safe.ModelAliases[0].ForceMapping {
		t.Fatalf("stored aliases = %+v, want the one alias CPA applies", safe.ModelAliases)
	}

	body := `{"name":"codex.json","auth_index":"idx-1","model_aliases":[
		{"name":" gpt-5 ","alias":"fast","fork":true,"display_name":"Fast","force_mapping":true},{"name":"gpt-5-mini","alias":"cheap"}]}`
	response, raw = doJSON(t, client, http.MethodPatch, base+"/fields", body)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("fields patch = %d %s", response.StatusCode, raw)
	}
	var forwarded map[string]any
	if err := json.Unmarshal([]byte(recorder.last(t, http.MethodPatch, "/v8/management/credentials/fields").Body), &forwarded); err != nil {
		t.Fatal(err)
	}
	first := anyList(forwarded["model_aliases"])[0].(map[string]any)
	if first["name"] != "gpt-5" || first["display-name"] != "Fast" || first["force-mapping"] != true || first["fork"] != true {
		t.Fatalf("forwarded alias = %#v, want trimmed values under CPA's field names", first)
	}
	if _, hasConsoleName := first["force_mapping"]; hasConsoleName {
		t.Fatalf("forwarded alias = %#v, want only CPA's field names", first)
	}
	var mutation struct {
		Fields managementAuthFileSafeFields `json:"fields"`
	}
	if err := json.Unmarshal(raw, &mutation); err != nil {
		t.Fatal(err)
	}
	if len(mutation.Fields.ModelAliases) != 2 || mutation.Fields.ModelAliases[0].DisplayName != "Fast" || mutation.Fields.ModelAliases[1].Alias != "cheap" {
		t.Fatalf("read back = %+v, want both saved aliases", mutation.Fields.ModelAliases)
	}
	if strings.Contains(string(raw), "STORED-TOKEN-SECRET") {
		t.Fatalf("fields patch leaked the stored token: %s", raw)
	}

	response, raw = doJSON(t, client, http.MethodPatch, base+"/fields", `{"name":"codex.json","auth_index":"idx-1","model_aliases":[]}`)
	// A fresh value: the cleared list is omitted from the answer, and decoding into
	// the earlier one would keep its aliases.
	var cleared struct {
		Fields managementAuthFileSafeFields `json:"fields"`
	}
	if err := json.Unmarshal(raw, &cleared); err != nil || response.StatusCode != http.StatusOK {
		t.Fatalf("clearing patch = %d %s", response.StatusCode, raw)
	}
	if len(cleared.Fields.ModelAliases) != 0 {
		t.Fatalf("read back = %+v, want the aliases cleared", cleared.Fields.ModelAliases)
	}
}
