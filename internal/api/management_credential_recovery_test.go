package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

const recoveryCredentialFixture = `{"id":"runtime-codex-id","name":"codex.json","auth_index":"idx-1","provider":"codex","requires_sign_in":true,"renewal_state":"sign_in_required","recovery_stage":"sign_in_required","access_token_expires_at":"2026-11-02T01:00:00+01:00","next_refresh_after":"2026-11-01T01:00:00Z","adopted":true,"inference_verified":false,"renewal_verified":false,"refresh_error":{"code":"invalid_grant","http_status":401,"message":"OPAQUE-SECRET https://provider.test/?code=PRIVATE-CODE","access_token":"OPAQUE-SECRET"},"next_action":"sign_in","recovery_hint":"OPAQUE-SECRET","renewal_event":{"account":"OPAQUE-SECRET"},"refresh_token":"OPAQUE-SECRET"}`

func TestCredentialRecoveryProjectionAndVerification(t *testing.T) {
	client, base, recorder := startAuthFilesTestServer(t, "management-secret-value", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/v8/management/credentials":
			fmt.Fprintf(w, `{"files":[%s,{"name":"old.json","auth_index":"old","provider":"codex"}]}`, recoveryCredentialFixture)
		case "/v8/management/credentials/verify":
			fmt.Fprintf(w, `{"status":"ok","verified":true,"credential":%s,"access_token":"OPAQUE-SECRET"}`, recoveryCredentialFixture)
		default:
			http.NotFound(w, r)
		}
	})
	endpoint := base + "/omc/api/v1/management/auth-files"
	response, raw := doJSON(t, client, http.MethodGet, endpoint, "")
	var output struct {
		Files []map[string]any `json:"files"`
	}
	if err := json.Unmarshal(raw, &output); err != nil || response.StatusCode != 200 {
		t.Fatalf("list: %d %s", response.StatusCode, raw)
	}
	file := output.Files[0]
	if file["requires_sign_in"] != true || file["renewal_state"] != "sign_in_required" || file["inference_verified"] != false || file["access_token_expires_at"] != "2026-11-02T00:00:00Z" {
		t.Fatalf("missing recovery evidence: %s", raw)
	}
	if _, present := output.Files[1]["requires_sign_in"]; present {
		t.Fatal("missing evidence on old CPA was reported as healthy")
	}
	if strings.Contains(string(raw), "OPAQUE-SECRET") || strings.Contains(string(raw), "PRIVATE-CODE") {
		t.Fatalf("unsafe recovery projection: %s", raw)
	}
	response, raw = doJSON(t, client, http.MethodPost, endpoint+"/verify", `{"name":"codex.json","auth_index":"idx-1"}`)
	if response.StatusCode != 200 || !strings.Contains(string(raw), `"verified":true`) || strings.Contains(string(raw), "OPAQUE-SECRET") || strings.Contains(string(raw), "credential") {
		t.Fatalf("verify outcome: %d %s", response.StatusCode, raw)
	}
	response, raw = doJSON(t, client, http.MethodPost, endpoint+"/verify", `{"name":"codex.json","auth_index":"stale"}`)
	if response.StatusCode != 404 || recorder.count(http.MethodPost, "/v8/management/credentials/verify") != 1 {
		t.Fatalf("stale verification target: %d %s", response.StatusCode, raw)
	}
}

func TestTargetedOAuthRecoveryNeverDowngrades(t *testing.T) {
	for _, scenario := range []string{"targeted", "opt_in", "stale", "provider_mismatch", "old_cpa", "missing_endpoint", "missing_state", "missing_target", "different_target", "wrong_account"} {
		t.Run(scenario, func(t *testing.T) {
			client, base, recorder := startAuthFilesTestServer(t, "management-secret-value", func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				switch r.URL.Path {
				case "/v8/management/credentials":
					if scenario == "old_cpa" {
						fmt.Fprint(w, `{"files":[{"name":"codex.json","auth_index":"idx-1","provider":"codex"}]}`)
					} else {
						fmt.Fprintf(w, `{"files":[%s]}`, recoveryCredentialFixture)
					}
				case "/v8/management/oauth/auth-url":
					if scenario == "missing_endpoint" {
						w.WriteHeader(404)
						return
					}
					if scenario == "wrong_account" {
						w.WriteHeader(400)
						fmt.Fprint(w, `{"error":"account mismatch OPAQUE-SECRET"}`)
						return
					}
					if scenario == "missing_state" {
						fmt.Fprint(w, `{"url":"https://auth.example.test/authorize"}`)
						return
					}
					targetID := "runtime-codex-id"
					if scenario == "missing_target" {
						targetID = ""
					} else if scenario == "different_target" {
						targetID = "other-account.json"
					}
					fmt.Fprintf(w, `{"url":"https://auth.example.test/authorize","state":"private-state","target_auth_id":%q}`, targetID)
				default:
					http.NotFound(w, r)
				}
			})
			body := `{"provider":"codex","name":"codex.json","auth_index":"idx-1"}`
			wantStatus, wantCalls := 200, 1
			switch scenario {
			case "opt_in":
				body = `{"provider":"codex","name":"codex.json","auth_index":"idx-1","verify":true}`
			case "stale":
				body = `{"provider":"codex","name":"codex.json","auth_index":"stale"}`
				wantStatus, wantCalls = 409, 0
			case "provider_mismatch":
				body = `{"provider":"anthropic","name":"codex.json","auth_index":"idx-1"}`
				wantStatus, wantCalls = 400, 0
			case "old_cpa":
				wantStatus, wantCalls = 501, 0
			case "missing_endpoint", "missing_target":
				wantStatus = 501
			case "different_target":
				wantStatus = 400
			case "wrong_account", "missing_state":
				wantStatus = 502
			}
			response, raw := doJSON(t, client, http.MethodPost, base+"/omc/api/v1/management/oauth/start", body)
			if response.StatusCode != wantStatus || recorder.count(http.MethodPost, "/v8/management/oauth/auth-url") != wantCalls || recorder.count(http.MethodGet, "/v8/management/oauth/auth-url") != 0 || strings.Contains(string(raw), "OPAQUE-SECRET") {
				t.Fatalf("targeted recovery: %d %s, calls=%+v", response.StatusCode, raw, recorder.all())
			}
			if scenario == "targeted" || scenario == "opt_in" {
				var forwarded map[string]any
				json.Unmarshal([]byte(recorder.last(t, http.MethodPost, "/v8/management/oauth/auth-url").Body), &forwarded)
				if forwarded["name"] != "codex.json" || forwarded["auth_index"] != "idx-1" || forwarded["verify"] != (scenario == "opt_in") {
					t.Fatalf("target/opt-in lost: %+v", forwarded)
				}
			}
		})
	}
}

func TestCredentialRecoveryAuditAdmissionAndLandedOutcome(t *testing.T) {
	for _, operation := range []string{"start", "verify"} {
		for _, phase := range []string{"attempt", "success"} {
			t.Run(operation+"_"+phase, func(t *testing.T) {
				var writes atomic.Int32
				client, base, repo := startDashboardTestServer(t, func(w http.ResponseWriter, r *http.Request) {
					switch r.URL.Path {
					case "/v8/management/credentials":
						fmt.Fprintf(w, `{"files":[%s]}`, recoveryCredentialFixture)
					case "/v8/management/credentials/verify":
						writes.Add(1)
						fmt.Fprint(w, `{"status":"ok","verified":true,"credential":{"access_token":"OPAQUE-SECRET"}}`)
					case "/v8/management/oauth/auth-url":
						writes.Add(1)
						fmt.Fprint(w, `{"url":"https://auth.example.test/authorize","state":"private-state","target_auth_id":"runtime-codex-id"}`)
					default:
						http.NotFound(w, r)
					}
				})
				action, endpoint := "auth_file.verify", "/management/auth-files/verify"
				body := `{"name":"codex.json","auth_index":"idx-1"}`
				if operation == "start" {
					action, endpoint = "oauth.start", "/management/oauth/start"
					body = `{"provider":"codex","name":"codex.json","auth_index":"idx-1","verify":true}`
				}
				if _, err := repo.SQL().Exec(fmt.Sprintf(`CREATE TRIGGER reject_recovery_audit BEFORE INSERT ON audit_events WHEN NEW.action = '%s' AND NEW.result = '%s' BEGIN SELECT RAISE(FAIL, 'audit unavailable'); END`, action, phase)); err != nil {
					t.Fatal(err)
				}
				response, raw := doJSON(t, client, http.MethodPost, base+"/omc/api/v1"+endpoint, body)
				wantStatus, wantWrites := 200, int32(1)
				if phase == "attempt" {
					wantStatus, wantWrites = 500, 0
				}
				if response.StatusCode != wantStatus || writes.Load() != wantWrites || strings.Contains(string(raw), "OPAQUE-SECRET") {
					t.Fatalf("%d %s writes=%d", response.StatusCode, raw, writes.Load())
				}
				var attempts string
				if err := repo.SQL().QueryRow(`SELECT COALESCE(GROUP_CONCAT(details_json), '') FROM audit_events WHERE action = ?`, action).Scan(&attempts); err != nil {
					t.Fatal(err)
				}
				if strings.Contains(attempts, "private-state") || strings.Contains(attempts, "OPAQUE-SECRET") {
					t.Fatalf("private material in audit: %s", attempts)
				}
			})
		}
	}
}

func TestOAuthRecoveryPrivateFailureBoundary(t *testing.T) {
	client, base, repo := startDashboardTestServer(t, func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v8/management/oauth/status":
			fmt.Fprint(w, `{"status":"error","message":"wrong account OPAQUE-SECRET","error":"PRIVATE-CODE","profile":{"access_token":"OPAQUE-SECRET"}}`)
		default:
			w.WriteHeader(400)
			fmt.Fprint(w, `{"error":"wrong account OPAQUE-SECRET PRIVATE-CODE"}`)
		}
	})
	for _, request := range []struct {
		method, path, body string
		status             int
	}{
		{http.MethodGet, "/management/oauth/status?state=private-state", "", 200},
		{http.MethodGet, "/management/auth-files", "", 502},
		{http.MethodPost, "/management/oauth/start", `{"provider":"codex","name":"codex.json","auth_index":"idx-1"}`, 502},
		{http.MethodPost, "/management/auth-files/verify", `{"name":"codex.json","auth_index":"idx-1"}`, 502},
		{http.MethodPost, "/management/oauth/callback", `{"provider":"codex","redirect_url":"http://localhost:1455/auth/callback?state=private-state&code=PRIVATE-CODE"}`, 502},
		{http.MethodDelete, "/management/oauth/session?state=private-state", "", 502},
	} {
		response, raw := doJSON(t, client, request.method, base+"/omc/api/v1"+request.path, request.body)
		if response.StatusCode != request.status || strings.Contains(string(raw), "OPAQUE-SECRET") || strings.Contains(string(raw), "PRIVATE-CODE") {
			t.Fatalf("private failure response %d %s", response.StatusCode, raw)
		}
	}
	events, err := repo.ListAuditEvents(context.Background(), 20)
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(events)
	for _, private := range []string{"OPAQUE-SECRET", "PRIVATE-CODE", "private-state"} {
		if strings.Contains(string(raw), private) {
			t.Fatalf("private OAuth material in ordinary audit: %s", raw)
		}
	}
	if _, err := repo.SQL().Exec(`CREATE TRIGGER reject_cancel_audit BEFORE INSERT ON audit_events WHEN NEW.action = 'oauth.cancel' AND NEW.result = 'attempt' BEGIN SELECT RAISE(FAIL, 'audit unavailable'); END`); err != nil {
		t.Fatal(err)
	}
	response, raw := doJSON(t, client, http.MethodDelete, base+"/omc/api/v1/management/oauth/session?state=private-state", "")
	if response.StatusCode != 500 || !strings.Contains(string(raw), "cancellation aborted") {
		t.Fatalf("cancellation admission: %d %s", response.StatusCode, raw)
	}
}

func TestCredentialVerificationHonoursProviderWriteGate(t *testing.T) {
	var verifications atomic.Int32
	var handler *Handler
	client, base, _ := startDashboardTestServer(t, func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v8/management/credentials":
			fmt.Fprintf(w, `{"files":[%s]}`, recoveryCredentialFixture)
		case "/v8/management/credentials/verify":
			verifications.Add(1)
			fmt.Fprint(w, `{"status":"ok","verified":true}`)
		default:
			http.NotFound(w, r)
		}
	}, func(h *Handler) { handler = h })
	handler.providerWrites.permits <- struct{}{}
	previousTimeout := handler.providerWrites.acquireTimeout
	handler.providerWrites.acquireTimeout = 50 * time.Millisecond
	t.Cleanup(func() {
		handler.providerWrites.acquireTimeout = previousTimeout
		<-handler.providerWrites.permits
	})
	response, raw := doJSON(t, client, http.MethodPost, base+"/omc/api/v1/management/auth-files/verify", `{"name":"codex.json","auth_index":"idx-1"}`)
	var body struct {
		Code string `json:"code"`
	}
	_ = json.Unmarshal(raw, &body)
	if response.StatusCode != http.StatusServiceUnavailable || body.Code != providerWriteBusyCode || verifications.Load() != 0 {
		t.Fatalf("busy verification must be refused as write_busy: %d %s verifications=%d", response.StatusCode, raw, verifications.Load())
	}
}
