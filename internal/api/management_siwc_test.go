package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/management"
)

const SIWC_TEST_FILE = `{"id":"managed-id","name":"codex.json","auth_index":"idx","provider":"codex","siwc_bind_supported":true,"use_siwc":true,"siwc_bound":true,"siwc_expires_at":"2026-10-21T00:00:00Z","metadata":{"siwc":{"access_token":"SYNTHETIC-TOKEN"}},"refresh_token":"SYNTHETIC-TOKEN"}`

func TestSIWCBindingLifecyclePreservesCallbackAndConfirmsReadback(t *testing.T) {
	var mu sync.Mutex
	isCompleted, isReadFailed, isCancelAllowed := false, false, false
	var callback string
	client, baseURL, recorder := startAuthFilesTestServer(t, "management-secret-value", func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/v8/management/credentials":
			if isReadFailed {
				w.WriteHeader(503)
				return
			}
			fmt.Fprintf(w, `{"files":[%s]}`, SIWC_TEST_FILE)
		case "/v8/management/oauth/siwc/bind":
			var body map[string]string
			_ = json.NewDecoder(r.Body).Decode(&body)
			if body["name"] != "managed-id" || len(body) != 1 {
				t.Errorf("unresolved bind target: %#v", body)
			}
			fmt.Fprint(w, `{"url":"https://auth.openai.com/api/accounts/authorize?state=fixture-state","state":"fixture-state","flow":"siwc_bind","expires_in":300}`)
		case "/v8/management/oauth/callback":
			var body map[string]string
			_ = json.NewDecoder(r.Body).Decode(&body)
			callback = body["redirect_url"]
			if body["provider"] != "codex" {
				t.Errorf("callback provider = %q", body["provider"])
			}
			fmt.Fprint(w, `{"status":"ok"}`)
		case "/v8/management/oauth/status":
			if isCompleted {
				fmt.Fprint(w, `{"status":"ok"}`)
			} else {
				fmt.Fprint(w, `{"status":"wait"}`)
			}
		case "/v8/management/oauth/session":
			fmt.Fprintf(w, `{"cancelled":%t}`, isCancelAllowed)
		default:
			fmt.Fprint(w, `{}`)
		}
	})
	base := baseURL + "/omc/api/v1/management/oauth/siwc"
	response, raw := doJSON(t, client, "POST", base+"/bind", `{"name":"codex.json","auth_index":"idx","rebind":true}`)
	if response.StatusCode != 200 || !strings.Contains(string(raw), `"flow":"siwc_bind"`) {
		t.Fatalf("start: %d %s", response.StatusCode, raw)
	}
	response, raw = getJSON(t, client, base+"/status?state=fixture-state")
	if response.StatusCode != 200 || !strings.Contains(string(raw), `"status":"wait"`) {
		t.Fatalf("pending: %d %s", response.StatusCode, raw)
	}
	for _, endpoint := range []struct{ method, path, body string }{
		{"GET", "/status?state=fixture-state", ""},
		{"DELETE", "/session?state=fixture-state", ""},
		{"POST", "/callback", `{"provider":"codex","redirect_url":"http://127.0.0.1:1455/auth/callback?state=fixture-state&code=SYNTHETIC-CODE&client_id=issued"}`},
	} {
		response, raw := doJSON(t, client, endpoint.method, baseURL+"/omc/api/v1/management/oauth"+endpoint.path, endpoint.body)
		if response.StatusCode != 400 {
			t.Fatalf("provider flow consumed binding: %d %s", response.StatusCode, raw)
		}
	}
	const redirect = "http://127.0.0.1:1455/auth/callback?code=SYNTHETIC-CODE&state=fixture-state&client_id=oaiapp_issued&extra=a%2Bb"
	response, raw = doJSON(t, client, "POST", base+"/callback?state=fixture-state", `{"redirect_url":"`+redirect+`"}`)
	if response.StatusCode != 200 {
		t.Fatalf("callback: %d %s", response.StatusCode, raw)
	}
	mu.Lock()
	if callback != redirect {
		t.Errorf("callback was rewritten: %q", callback)
	}
	mu.Unlock()
	response, raw = doJSON(t, client, "DELETE", base+"/session?state=fixture-state", "")
	if response.StatusCode != 200 || !strings.Contains(string(raw), `"cancelled":false`) {
		t.Fatalf("cancel: %d %s", response.StatusCode, raw)
	}
	mu.Lock()
	isCompleted = true
	isReadFailed = true
	mu.Unlock()
	response, raw = getJSON(t, client, base+"/status?state=fixture-state")
	if response.StatusCode != http.StatusOK || !strings.Contains(string(raw), `"completed":true`) || !strings.Contains(string(raw), `"status":"wait"`) {
		t.Fatalf("readback failure: %d %s", response.StatusCode, raw)
	}
	mu.Lock()
	isReadFailed = false
	mu.Unlock()
	response, raw = getJSON(t, client, base+"/status?state=fixture-state")
	if response.StatusCode != 200 || !strings.Contains(string(raw), `"status":"ok"`) || !strings.Contains(string(raw), `"siwc_bound":true`) || strings.Contains(string(raw), "SYNTHETIC-TOKEN") {
		t.Fatalf("completion: %d %s", response.StatusCode, raw)
	}
	response, raw = doJSON(t, client, "POST", base+"/callback?state=fixture-state", `{"redirect_url":"`+redirect+`"}`)
	if response.StatusCode != 409 {
		t.Fatalf("completed callback: %d %s", response.StatusCode, raw)
	}
	for _, request := range recorder.all() {
		if request.Path == "/v8/management/oauth/auth-url" || strings.Contains(request.Path, "/credentials/download") {
			t.Errorf("unexpected credential operation: %s", request.Path)
		}
	}
}

func TestSIWCBindingRejectsUnsafeAndUnsupportedTargets(t *testing.T) {
	for _, tc := range []struct {
		name, files, body string
		status            int
	}{
		{"path", SIWC_TEST_FILE, `{"name":"../codex.json","auth_index":"idx","rebind":true}`, 400},
		{"rebind confirmation", SIWC_TEST_FILE, `{"name":"codex.json","auth_index":"idx"}`, 409},
		{"stale index", SIWC_TEST_FILE, `{"name":"codex.json","auth_index":"old","rebind":true}`, 409},
		{"duplicate", SIWC_TEST_FILE + "," + SIWC_TEST_FILE, `{"name":"codex.json","auth_index":"idx","rebind":true}`, 409},
		{"unsupported", `{"name":"codex.json","auth_index":"idx","provider":"codex"}`, `{"name":"codex.json","auth_index":"idx","rebind":true}`, 400},
		{"runtime", strings.Replace(SIWC_TEST_FILE, `"provider":"codex"`, `"provider":"codex","runtime_only":true`, 1), `{"name":"codex.json","auth_index":"idx","rebind":true}`, 400},
		{"id collision", SIWC_TEST_FILE + `,{"id":"other","name":"managed-id","auth_index":"other"}`, `{"name":"codex.json","auth_index":"idx","rebind":true}`, 409},
	} {
		t.Run(tc.name, func(t *testing.T) {
			client, base, recorder := startAuthFilesTestServer(t, "management-secret-value", func(w http.ResponseWriter, r *http.Request) { fmt.Fprintf(w, `{"files":[%s]}`, tc.files) })
			response, raw := doJSON(t, client, "POST", base+"/omc/api/v1/management/oauth/siwc/bind", tc.body)
			if response.StatusCode != tc.status {
				t.Fatalf("status %d, want %d: %s", response.StatusCode, tc.status, raw)
			}
			for _, r := range recorder.all() {
				if r.Path == "/v8/management/oauth/siwc/bind" {
					t.Fatal("rejected target reached bind")
				}
			}
		})
	}
}

func TestSIWCCallbackScopeConflictsAndSecretExclusion(t *testing.T) {
	client, base, recorder := startAuthFilesTestServer(t, "management-secret-value", func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v8/management/credentials":
			fmt.Fprintf(w, `{"files":[%s]}`, SIWC_TEST_FILE)
		case "/v8/management/oauth/siwc/bind":
			fmt.Fprint(w, `{"url":"https://auth.openai.com/api/accounts/authorize","state":"fixture-state","flow":"siwc_bind","expires_in":300}`)
		case "/v8/management/oauth/callback":
			w.WriteHeader(409)
			fmt.Fprint(w, `{"error":"SYNTHETIC-CODE SYNTHETIC-TOKEN"}`)
		default:
			fmt.Fprint(w, `{}`)
		}
	})
	base += "/omc/api/v1/management/oauth/siwc"
	doJSON(t, client, "POST", base+"/bind", `{"name":"codex.json","auth_index":"idx","rebind":true}`)
	for _, redirect := range []string{
		"http://127.0.0.1:1455/auth/callback?state=other&code=SYNTHETIC-CODE&client_id=issued",
		"http://127.0.0.1:1455/auth/callback?state=fixture-state&state=other&code=SYNTHETIC-CODE&client_id=issued",
		"https://evil.example.test/auth/callback?state=fixture-state",
	} {
		body, _ := json.Marshal(map[string]string{"redirect_url": redirect})
		response, raw := doJSON(t, client, "POST", base+"/callback?state=fixture-state", string(body))
		if response.StatusCode != 400 {
			t.Fatalf("bad callback: %d %s", response.StatusCode, raw)
		}
	}
	for _, r := range recorder.all() {
		if r.Path == "/v8/management/oauth/callback" {
			t.Fatal("mismatched callback reached CPA")
		}
	}
	response, raw := doJSON(t, client, "POST", base+"/callback?state=fixture-state", `{"redirect_url":"http://127.0.0.1:1455/auth/callback?state=fixture-state&code=SYNTHETIC-CODE&client_id=issued"}`)
	if response.StatusCode != 409 || strings.Contains(string(raw), "SYNTHETIC-") {
		t.Fatalf("conflict leaked or was swallowed: %d %s", response.StatusCode, raw)
	}
	response, raw = getJSON(t, client, base+"/status?state=unknown")
	if response.StatusCode != 404 {
		t.Fatalf("unknown state: %d %s", response.StatusCode, raw)
	}
}

func TestSIWCBindingAuditsFailClosedAtEveryMutation(t *testing.T) {
	for _, action := range []string{"bind", "callback", "cancel"} {
		for _, phase := range []string{"attempt", "success"} {
			t.Run(action+"/"+phase, func(t *testing.T) {
				var mutationCount atomic.Int32
				client, base, repo := startDashboardTestServer(t, func(w http.ResponseWriter, r *http.Request) {
					if (action == "bind" && r.URL.Path == "/v8/management/oauth/siwc/bind") ||
						(action == "callback" && r.URL.Path == "/v8/management/oauth/callback") ||
						(action == "cancel" && r.URL.Path == "/v8/management/oauth/session") {
						mutationCount.Add(1)
					}
					switch r.URL.Path {
					case "/v8/management/credentials":
						fmt.Fprintf(w, `{"files":[%s]}`, SIWC_TEST_FILE)
					case "/v8/management/oauth/siwc/bind":
						fmt.Fprint(w, `{"url":"https://auth.openai.com/api/accounts/authorize","state":"fixture-state","flow":"siwc_bind","expires_in":300}`)
					default:
						fmt.Fprint(w, `{"status":"ok","cancelled":true}`)
					}
				})
				base += "/omc/api/v1/management/oauth/siwc"
				if action != "bind" {
					response, raw := doJSON(t, client, "POST", base+"/bind", `{"name":"codex.json","auth_index":"idx","rebind":true}`)
					if response.StatusCode != 200 {
						t.Fatalf("setup: %d %s", response.StatusCode, raw)
					}
				}
				_, err := repo.SQL().Exec(`CREATE TRIGGER reject_siwc_audit BEFORE INSERT ON audit_events WHEN NEW.action = 'oauth.siwc.` + action + `' AND NEW.result = '` + phase + `' BEGIN SELECT RAISE(FAIL, 'audit unavailable'); END`)
				if err != nil {
					t.Fatal(err)
				}
				method, path, body := "POST", "/bind", `{"name":"codex.json","auth_index":"idx","rebind":true}`
				if action == "callback" {
					path = "/callback?state=fixture-state"
					body = `{"redirect_url":"http://127.0.0.1:1455/auth/callback?state=fixture-state&code=SYNTHETIC-CODE&client_id=issued"}`
				}
				if action == "cancel" {
					method = "DELETE"
					path = "/session?state=fixture-state"
					body = ""
				}
				response, raw := doJSON(t, client, method, base+path, body)
				want := 200
				if phase == "attempt" {
					want = 500
				}
				if (phase == "attempt" && mutationCount.Load() != 0) || (phase == "success" && mutationCount.Load() != 1) {
					t.Fatalf("audit gate forwarded %d mutations", mutationCount.Load())
				}
				if response.StatusCode != want {
					t.Fatalf("audit %s: %d want %d: %s", phase, response.StatusCode, want, raw)
				}
				rows, err := repo.SQL().Query(`SELECT details_json FROM audit_events WHERE action LIKE 'oauth.siwc.%'`)
				if err != nil {
					t.Fatal(err)
				}
				defer rows.Close()
				for rows.Next() {
					var detail string
					if err := rows.Scan(&detail); err != nil {
						t.Fatal(err)
					}
					if strings.Contains(detail, "SYNTHETIC-CODE") {
						t.Fatal("callback code in audit")
					}
				}
				if err := rows.Err(); err != nil {
					t.Fatal(err)
				}
			})
		}
	}
}

func TestSIWCBindingExpiryAndGatewayIsolation(t *testing.T) {
	for _, tc := range []struct {
		name   string
		age    time.Duration
		status int
	}{
		{"expired", 6 * time.Minute, 410}, {"different gateway", time.Minute, 409},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var handler *Handler
			var upstreamCalls atomic.Int32
			client, base, repo := startDashboardTestServer(t, func(w http.ResponseWriter, r *http.Request) { upstreamCalls.Add(1); fmt.Fprint(w, `{"status":"ok"}`) }, func(h *Handler) { handler = h })
			instance, err := repo.GetInstance(context.Background(), defaultInstanceID())
			if err != nil {
				t.Fatal(err)
			}
			now := time.Date(2026, 10, 20, 0, 0, 0, 0, time.UTC)
			handler.nowFn = func() time.Time { return now }
			gateway := instance.BaseURL
			if tc.name == "different gateway" {
				gateway = "http://other.test"
			}
			handler.siwcBindings.sessions = map[string]*siwcBinding{"fixture": {gateway: gateway, expiresAt: now.Add(SIWC_BINDING_TTL - tc.age), retainUntil: now.Add(time.Minute)}}
			response, raw := getJSON(t, client, base+"/omc/api/v1/management/oauth/siwc/status?state=fixture")
			if response.StatusCode != tc.status || upstreamCalls.Load() != 0 {
				t.Fatalf("status %d want %d, CPA calls=%d: %s", response.StatusCode, tc.status, upstreamCalls.Load(), raw)
			}
		})
	}
}

func TestSIWCSummaryAllowlistAndExpiry(t *testing.T) {
	var file management.AuthFile
	if err := json.Unmarshal([]byte(SIWC_TEST_FILE), &file); err != nil {
		t.Fatal(err)
	}
	projected := projectManagementAuthFile(file)
	raw, _ := json.Marshal(projected)
	if !projected.SIWCBindSupported || !projected.SIWCBound || !projected.UseSIWC || projected.SIWCExpiresAt != "2026-10-21T00:00:00Z" || strings.Contains(string(raw), "SYNTHETIC-TOKEN") {
		t.Fatalf("summary: %s", raw)
	}
	file.SIWCExpiresAt = "SYNTHETIC-TOKEN"
	if projectManagementAuthFile(file).SIWCExpiresAt != "" {
		t.Fatal("invalid expiry was exposed")
	}
	recorder := httptest.NewRecorder()
	writeSIWCError(recorder, &management.HTTPError{StatusCode: 404, Body: "SYNTHETIC-TOKEN"})
	if recorder.Code != 404 || strings.Contains(recorder.Body.String(), "SYNTHETIC-TOKEN") {
		t.Fatal("upstream error was exposed")
	}
}

func TestSIWCRejectedStartAuditsFailureAndCleansUpWithAuditGate(t *testing.T) {
	for _, tc := range []struct {
		name             string
		status           int
		response         string
		isCleanupBlocked bool
		wantStatus       int
		wantCancels      int32
	}{
		{"older gateway", 404, `{"error":"SYNTHETIC-CODE"}`, false, 404, 0},
		{"pending conflict", 409, `{"error":"SYNTHETIC-CODE"}`, false, 409, 0},
		{"invalid URL", 200, `{"url":"https://evil.example.test/authorize","state":"fixture","flow":"siwc_bind","expires_in":300}`, false, 502, 1},
		{"cleanup audit refused", 200, `{"url":"https://evil.example.test/authorize","state":"fixture","flow":"siwc_bind","expires_in":300}`, true, 502, 0},
		{"missing state", 200, `{"url":"https://auth.openai.com/api/accounts/authorize","flow":"siwc_bind","expires_in":300}`, false, 502, 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var cancellations, ordinaryLogins atomic.Int32
			client, base, repo := startDashboardTestServer(t, func(w http.ResponseWriter, r *http.Request) {
				switch r.URL.Path {
				case "/v8/management/credentials":
					fmt.Fprintf(w, `{"files":[%s]}`, SIWC_TEST_FILE)
				case "/v8/management/oauth/siwc/bind":
					w.WriteHeader(tc.status)
					fmt.Fprint(w, tc.response)
				case "/v8/management/oauth/session":
					cancellations.Add(1)
					fmt.Fprint(w, `{"cancelled":true}`)
				case "/v8/management/oauth/auth-url":
					ordinaryLogins.Add(1)
				}
			})
			if tc.isCleanupBlocked {
				_, err := repo.SQL().Exec(`CREATE TRIGGER reject_siwc_cleanup_audit BEFORE INSERT ON audit_events WHEN NEW.action = 'oauth.siwc.cancel' AND NEW.result = 'attempt' BEGIN SELECT RAISE(FAIL, 'audit unavailable'); END`)
				if err != nil {
					t.Fatal(err)
				}
			}
			response, raw := doJSON(t, client, "POST", base+"/omc/api/v1/management/oauth/siwc/bind", `{"name":"codex.json","auth_index":"idx","rebind":true}`)
			if response.StatusCode != tc.wantStatus || cancellations.Load() != tc.wantCancels || ordinaryLogins.Load() != 0 || strings.Contains(string(raw), "SYNTHETIC-CODE") {
				t.Fatalf("start %d cancellations %d logins %d body %s", response.StatusCode, cancellations.Load(), ordinaryLogins.Load(), raw)
			}
			var failures int
			if err := repo.SQL().QueryRow(`SELECT COUNT(*) FROM audit_events WHERE action = 'oauth.siwc.bind' AND result = 'failure'`).Scan(&failures); err != nil {
				t.Fatal(err)
			}
			if failures != 1 {
				t.Fatalf("bind failure audits = %d", failures)
			}
		})
	}
}
