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

	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
)

const recoveryCredentialFixture = `{"id":"runtime-codex-id","name":"codex.json","auth_index":"idx-1","provider":"codex","requires_sign_in":true,"renewal_state":"sign_in_required","recovery_stage":"sign_in_required","access_token_expires_at":"2026-11-02T01:00:00+01:00","next_refresh_after":"2026-11-01T01:00:00Z","adopted":true,"inference_verified":false,"renewal_verified":false,"refresh_error":{"code":"invalid_grant","http_status":401,"message":"OPAQUE-SECRET https://provider.test/?code=PRIVATE-CODE","access_token":"OPAQUE-SECRET","failure_stage":"PRIVATE-STAGE","receipt":"PRIVATE-RECEIPT","journal":{"refresh_token":"OPAQUE-SECRET"}},"next_action":"sign_in","recovery_hint":"OPAQUE-SECRET","renewal_event":{"account":"OPAQUE-SECRET"},"refresh_token":"OPAQUE-SECRET"}`

// A multi-entry plugin files its credentials under one family (zcode) while each
// login entry (zcode-zai, zcode-bigmodel) issues its own; CPA reports the issuing
// entry beside the family.
const recoveryPluginCredentialFixture = `{"id":"runtime-zcode-id","name":"zcode-demo.json","auth_index":"idx-z","provider":"zcode","oauth_provider":"zcode-zai","requires_sign_in":true,"renewal_state":"sign_in_required"}`

const recoveryCopilotCredentialFixture = `{"id":"runtime-copilot-id","name":"copilot-42.json","auth_index":"idx-copilot","type":"copilot","provider":"copilot","requires_sign_in":true,"renewal_state":"sign_in_required"}`

func TestCredentialRecoveryProjectionAndVerification(t *testing.T) {
	for _, test := range []struct{ code, wantCode string }{
		{"invalid_grant", "invalid_grant"},
		{"refresh_outcome_unknown", "refresh_outcome_unknown"},
		{"new_provider_error", "refresh_failed"},
		{"refresh_outcome_unknown OPAQUE-SECRET", "refresh_failed"},
	} {
		t.Run(test.code, func(t *testing.T) {
			fixture := strings.Replace(recoveryCredentialFixture, `"code":"invalid_grant","http_status":401`, fmt.Sprintf(`"code":%q,"http_status":502`, test.code), 1)
			client, base, recorder := startAuthFilesTestServer(t, "management-secret-value", func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				switch r.URL.Path {
				case "/v8/management/credentials":
					fmt.Fprintf(w, `{"files":[%s,{"name":"old.json","auth_index":"old","provider":"codex"}]}`, fixture)
				case "/v8/management/credentials/verify":
					fmt.Fprintf(w, `{"status":"ok","verified":true,"credential":%s,"access_token":"OPAQUE-SECRET"}`, fixture)
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
			refreshError, ok := file["refresh_error"].(map[string]any)
			if !ok || len(refreshError) != 2 || refreshError["code"] != test.wantCode || refreshError["http_status"] != float64(502) {
				t.Fatalf("refresh error projection: %s", raw)
			}
			if file["requires_sign_in"] != true || file["renewal_state"] != "sign_in_required" || file["inference_verified"] != false || file["access_token_expires_at"] != "2026-11-02T00:00:00Z" {
				t.Fatalf("missing recovery evidence: %s", raw)
			}
			if _, present := output.Files[1]["requires_sign_in"]; present {
				t.Fatal("missing evidence on old CPA was reported as healthy")
			}
			for _, private := range []string{"OPAQUE-SECRET", "PRIVATE-CODE", "PRIVATE-STAGE", "PRIVATE-RECEIPT", `"message"`, `"failure_stage"`, `"receipt"`, `"journal"`, `"refresh_token"`} {
				if strings.Contains(string(raw), private) {
					t.Fatalf("unsafe recovery projection: %s", raw)
				}
			}
			response, raw = doJSON(t, client, http.MethodPost, endpoint+"/verify", `{"name":"codex.json","auth_index":"idx-1"}`)
			if response.StatusCode != 200 || !strings.Contains(string(raw), `"verified":true`) || strings.Contains(string(raw), "OPAQUE-SECRET") || strings.Contains(string(raw), "credential") {
				t.Fatalf("verify outcome: %d %s", response.StatusCode, raw)
			}
			response, raw = doJSON(t, client, http.MethodPost, endpoint+"/verify", `{"name":"codex.json","auth_index":"stale"}`)
			if response.StatusCode != 404 || recorder.count(http.MethodPost, "/v8/management/credentials/verify") != 1 {
				t.Fatalf("stale verification target: %d %s", response.StatusCode, raw)
			}
		})
	}
}

func TestTargetedOAuthRecoveryNeverDowngrades(t *testing.T) {
	for _, scenario := range []string{"targeted", "opt_in", "stale", "provider_mismatch", "old_cpa", "missing_endpoint", "missing_state", "missing_target", "different_target", "wrong_account", "plugin_entry", "plugin_family", "plugin_sibling_entry", "plugin_entry_unreported", "copilot_device", "copilot_provider_mismatch"} {
		t.Run(scenario, func(t *testing.T) {
			isPlugin := strings.HasPrefix(scenario, "plugin_")
			isCopilot := strings.HasPrefix(scenario, "copilot_")
			fixture := recoveryCredentialFixture
			if isPlugin {
				fixture = recoveryPluginCredentialFixture
				if scenario == "plugin_entry_unreported" {
					fixture = strings.Replace(fixture, `,"oauth_provider":"zcode-zai"`, "", 1)
				}
			} else if isCopilot {
				fixture = recoveryCopilotCredentialFixture
			}
			client, base, recorder := startAuthFilesTestServer(t, "management-secret-value", func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				switch r.URL.Path {
				case "/v8/management/credentials":
					if scenario == "old_cpa" {
						fmt.Fprint(w, `{"files":[{"name":"codex.json","auth_index":"idx-1","provider":"codex"}]}`)
					} else {
						fmt.Fprintf(w, `{"files":[%s]}`, fixture)
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
					if isPlugin {
						targetID = "runtime-zcode-id"
					} else if isCopilot {
						targetID = "runtime-copilot-id"
					}
					if scenario == "missing_target" {
						targetID = ""
					} else if scenario == "different_target" {
						targetID = "other-account.json"
					}
					if isCopilot {
						fmt.Fprintf(w, `{"url":"https://github.com/login/device","state":"private-state","flow":"device","user_code":"WDJB-MJHT","expires_in":900,"target_auth_id":%q}`, targetID)
						return
					}
					fmt.Fprintf(w, `{"url":"https://auth.example.test/authorize","state":"private-state","target_auth_id":%q}`, targetID)
				default:
					http.NotFound(w, r)
				}
			})
			body := `{"provider":"codex","name":"codex.json","auth_index":"idx-1"}`
			if isPlugin {
				body = `{"provider":"zcode-zai","name":"zcode-demo.json","auth_index":"idx-z"}`
			} else if isCopilot {
				body = `{"provider":"copilot","name":"copilot-42.json","auth_index":"idx-copilot"}`
			}
			wantStatus, wantCalls := 200, 1
			switch scenario {
			case "copilot_provider_mismatch":
				body = `{"provider":"meta","name":"copilot-42.json","auth_index":"idx-copilot"}`
				wantStatus, wantCalls = 400, 0
			case "plugin_family":
				body = `{"provider":"zcode","name":"zcode-demo.json","auth_index":"idx-z"}`
			case "plugin_sibling_entry":
				body = `{"provider":"zcode-bigmodel","name":"zcode-demo.json","auth_index":"idx-z"}`
				wantStatus, wantCalls = 400, 0
			case "plugin_entry_unreported":
				wantStatus, wantCalls = 400, 0
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
			if scenario == "targeted" || scenario == "opt_in" || scenario == "plugin_entry" || scenario == "plugin_family" || scenario == "copilot_device" {
				wantName, wantIndex, wantProvider := "codex.json", "idx-1", "codex"
				if isPlugin {
					wantName, wantIndex = "zcode-demo.json", "idx-z"
					wantProvider = "zcode-zai"
					if scenario == "plugin_family" {
						wantProvider = "zcode"
					}
				} else if isCopilot {
					wantName, wantIndex, wantProvider = "copilot-42.json", "idx-copilot", "copilot"
				}
				var forwarded map[string]any
				json.Unmarshal([]byte(recorder.last(t, http.MethodPost, "/v8/management/oauth/auth-url").Body), &forwarded)
				if forwarded["provider"] != wantProvider || forwarded["name"] != wantName || forwarded["auth_index"] != wantIndex || forwarded["verify"] != (scenario == "opt_in") {
					t.Fatalf("target/opt-in lost: %+v", forwarded)
				}
				if isCopilot {
					if forwarded["is_webui"] != nil {
						t.Fatalf("copilot device recovery must not request loopback callback: %+v", forwarded)
					}
					var started StartOAuthResponseDTO
					if err := json.Unmarshal(raw, &started); err != nil {
						t.Fatal(err)
					}
					if started.Flow != "device" || started.UserCode != "WDJB-MJHT" || started.ExpiresIn != 900 || started.URL != "https://github.com/login/device" {
						t.Fatalf("copilot recovery response missing device metadata: %s", raw)
					}
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

func TestVerifyCredentialReleasesCredentialCooldownAndRefreshesQuota(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	recoverAt := now.Add(2 * time.Hour)
	modelRecoverAt := now.Add(3 * time.Hour)
	var apiCallReads atomic.Int32
	var cooldownResets atomic.Int32
	var verifiedAuth atomic.Bool

	client, base, repo := startDashboardTestServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/v8/management/credentials":
			idx1Status, idx1Unavailable, idx1Retry := "error", true, fmt.Sprintf(`,"next_retry_after":%q`, recoverAt.Format(time.RFC3339))
			if verifiedAuth.Load() {
				idx1Status, idx1Unavailable, idx1Retry = "active", false, ""
			}
			fmt.Fprintf(w, `{"files":[
				{"id":"cred-1","name":"codex.json","auth_index":"idx-1","type":"codex","provider":"codex","status":%q,"unavailable":%t%s,"requires_sign_in":false,"renewal_state":"awaiting_first_renewal","recovery_stage":"loaded","adopted":true,"inference_verified":%t},
				{"id":"cred-force","name":"codex-force.json","auth_index":"idx-force","type":"codex","provider":"codex","status":"error","unavailable":true,"next_retry_after":%q,"requires_sign_in":false,"renewal_state":"awaiting_first_renewal","recovery_stage":"quota_blocked","adopted":true,"inference_verified":false}
			]}`, idx1Status, idx1Unavailable, idx1Retry, verifiedAuth.Load(), recoverAt.Format(time.RFC3339))
		case "/v8/management/credentials/verify":
			var body struct {
				AuthIndex string `json:"auth_index"`
			}
			_ = json.NewDecoder(r.Body).Decode(&body)
			if body.AuthIndex == "idx-1" {
				verifiedAuth.Store(true)
			}
			fmt.Fprint(w, `{"status":"ok","verified":true}`)
		case "/v8/management/requests/api-call":
			apiCallReads.Add(1)
			fmt.Fprint(w, `{"status_code":200,"body":{"plan_type":"pro","rate_limit":{"primary_window":{"used_percent":10,"limit_window_seconds":18000,"reset_after_seconds":14400}}}}`)
		case "/v8/management/routing/cooldown/reset":
			cooldownResets.Add(1)
			fmt.Fprint(w, `{"status":"ok"}`)
		case "/v8/management/config/oauth/model-alias":
			fmt.Fprint(w, `{}`)
		default:
			http.NotFound(w, r)
		}
	})

	ctx := context.Background()
	// Seed credential_quota (with inherited mirror) + independent model cooldown on idx-1, and force_cooldown on idx-force.
	credQuota := fmt.Sprintf(`{"timestamp":%q,"auth_index":"idx-1","auth_status":{"quota":{"exceeded":true,"reason":"credential_quota","next_recover_at":%q,"backoff_level":4},"model":{"name":"gpt-5","next_retry_after":%q,"quota":{"exceeded":true,"reason":"quota","next_recover_at":%q,"backoff_level":4}}}}`,
		now.Format(time.RFC3339), recoverAt.Format(time.RFC3339), recoverAt.Format(time.RFC3339), recoverAt.Format(time.RFC3339))
	modelCooldown := fmt.Sprintf(`{"timestamp":%q,"auth_index":"idx-1","model":"gpt-5-pro","status_code":429,"auth_status":{"quota":{"exceeded":true,"reason":"quota","next_recover_at":%q,"backoff_level":2},"model":{"name":"gpt-5-pro","next_retry_after":%q,"quota":{"exceeded":true,"reason":"quota","next_recover_at":%q,"backoff_level":2}}}}`,
		now.Add(time.Second).Format(time.RFC3339), modelRecoverAt.Format(time.RFC3339), modelRecoverAt.Format(time.RFC3339), modelRecoverAt.Format(time.RFC3339))
	forceCooldown := fmt.Sprintf(`{"timestamp":%q,"auth_index":"idx-force","code":"force_cooldown","status_code":502,"auth_status":{"quota":{"exceeded":true,"reason":"force_cooldown","next_recover_at":%q,"backoff_level":1}}}`,
		now.Format(time.RFC3339), recoverAt.Format(time.RFC3339))
	for _, rawEvent := range []string{credQuota, modelCooldown, forceCooldown} {
		if err := repo.CaptureErrorEvent(ctx, "default", rawEvent, now); err != nil {
			t.Fatal(err)
		}
	}

	// Verify idx-1 succeeds -> releases credential_quota evidence, preserves gpt-5-pro model cooldown, and refreshes quota reading.
	response, raw := doJSON(t, client, http.MethodPost, base+"/omc/api/v1/management/auth-files/verify", `{"name":"codex.json","auth_index":"idx-1"}`)
	if response.StatusCode != http.StatusOK || !strings.Contains(string(raw), `"verified":true`) {
		t.Fatalf("verify idx-1 = %d %s", response.StatusCode, raw)
	}
	if apiCallReads.Load() == 0 {
		t.Fatalf("expected post-verify quota refresh to query upstream usage")
	}

	// VerifyCredential itself must release stored credential cooldown evidence before any
	// quota read reconciles it, while preserving the independent model cooldown.
	postVerifyCooldowns, err := repo.BatchCorrelatedCooldowns(ctx, []string{"idx-1"}, now.UnixMilli())
	if err != nil {
		t.Fatal(err)
	}
	if postVerifyCooldowns["idx-1"].IsActive {
		t.Fatalf("idx-1 credential cooldown must be cleared immediately by verify before quota read: %+v", postVerifyCooldowns["idx-1"])
	}
	postVerifyModels, err := repo.BatchModelCooldowns(ctx, []string{"idx-1"}, now.UnixMilli(), nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(postVerifyModels["idx-1"]) != 1 || postVerifyModels["idx-1"][0].Model != "gpt-5-pro" {
		t.Fatalf("idx-1 independent model cooldown must survive verify before quota read: %+v", postVerifyModels["idx-1"])
	}

	// Quota overview and detail immediately show the refreshed healthy state with no active credential cooldown,
	// while preserving the independent per-model cooldown.
	overviewResp, overviewRaw := doJSON(t, client, http.MethodGet, base+"/omc/api/v1/management/quota", "")
	if overviewResp.StatusCode != http.StatusOK {
		t.Fatalf("quota overview = %d %s", overviewResp.StatusCode, overviewRaw)
	}
	var overview struct {
		Summary struct {
			CooldownCount int `json:"cooldown_count"`
		} `json:"summary"`
		Quotas []struct {
			AuthIndex      string `json:"auth_index"`
			Status         string `json:"status"`
			ActiveCooldown *struct {
				IsActive bool `json:"is_active"`
			} `json:"active_cooldown"`
			ModelCooldowns []struct {
				Model string `json:"model"`
			} `json:"model_cooldowns"`
			Windows []struct {
				RemainingPercent *float64 `json:"remaining_percent"`
			} `json:"windows"`
		} `json:"quotas"`
	}
	if err := json.Unmarshal(overviewRaw, &overview); err != nil {
		t.Fatal(err)
	}
	if overview.Summary.CooldownCount != 1 {
		t.Fatalf("cooldown_count = %d, want 1 (only idx-force); body=%s", overview.Summary.CooldownCount, overviewRaw)
	}
	var sawIdx1 bool
	for _, item := range overview.Quotas {
		if item.AuthIndex != "idx-1" {
			continue
		}
		sawIdx1 = true
		if item.Status != "healthy" || item.ActiveCooldown != nil {
			t.Fatalf("idx-1 after verify = %+v, want healthy with no active credential cooldown", item)
		}
		if len(item.Windows) == 0 || item.Windows[0].RemainingPercent == nil || *item.Windows[0].RemainingPercent != 90 {
			t.Fatalf("idx-1 refreshed windows = %+v, want 90%% remaining", item.Windows)
		}
		if len(item.ModelCooldowns) != 1 || item.ModelCooldowns[0].Model != "gpt-5-pro" {
			t.Fatalf("idx-1 model_cooldowns = %+v, want independent gpt-5-pro preserved", item.ModelCooldowns)
		}
	}
	if !sawIdx1 {
		t.Fatalf("missing idx-1 in quota overview: %s", overviewRaw)
	}

	// Verify idx-force keeps its force_cooldown local evidence intact when CPA still keeps the force cooldown,
	// and post-verify quota refresh must not issue a redundant CPA cooldown reset for either credential.
	forceResp, forceRaw := doJSON(t, client, http.MethodPost, base+"/omc/api/v1/management/auth-files/verify", `{"name":"codex-force.json","auth_index":"idx-force"}`)
	if forceResp.StatusCode != http.StatusOK {
		t.Fatalf("verify idx-force = %d %s", forceResp.StatusCode, forceRaw)
	}
	if cooldownResets.Load() != 0 {
		t.Fatalf("post-verify refresh must not call CPA cooldown reset, got %d resets", cooldownResets.Load())
	}
	cooldowns, err := repo.BatchCorrelatedCooldowns(ctx, []string{"idx-force"}, now.UnixMilli())
	if err != nil || !cooldowns["idx-force"].IsActive {
		t.Fatalf("idx-force force_cooldown must survive verify: %+v, %v", cooldowns, err)
	}
}

func TestVerifyCredentialDistinguishes409VerificationNotApplied(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	recoverAt := now.Add(2 * time.Hour)

	for _, test := range []struct {
		name           string
		cpaBody        string
		wantHTTPStatus int
		wantCode       string
	}{
		{
			name:           "verification_not_applied",
			cpaBody:        `{"status":"error","verified":false,"error":"verification_not_applied: upstream completed the verification request, but the credential is still cooling down or disabled; OPAQUE-SECRET","credential":{"access_token":"OPAQUE-SECRET"}}`,
			wantHTTPStatus: http.StatusConflict,
			wantCode:       "verification_not_applied",
		},
		{
			name:           "credential_superseded_stays_generic",
			cpaBody:        `{"status":"error","verified":false,"error":"credential_superseded: credential was replaced OPAQUE-SECRET","credential":{"access_token":"OPAQUE-SECRET"}}`,
			wantHTTPStatus: http.StatusBadGateway,
			wantCode:       "cpa_unavailable",
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			client, base, repo := startDashboardTestServer(t, func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				switch r.URL.Path {
				case "/v8/management/credentials":
					fmt.Fprintf(w, `{"files":[{"id":"cred-1","name":"codex.json","auth_index":"idx-1","type":"codex","provider":"codex","status":"error","unavailable":true,"next_retry_after":%q,"requires_sign_in":false,"renewal_state":"awaiting_first_renewal","recovery_stage":"quota_blocked","adopted":true,"inference_verified":false}]}`, recoverAt.Format(time.RFC3339))
				case "/v8/management/credentials/verify":
					w.WriteHeader(http.StatusConflict)
					fmt.Fprint(w, test.cpaBody)
				default:
					http.NotFound(w, r)
				}
			})

			ctx := context.Background()
			rawEvent := fmt.Sprintf(`{"timestamp":%q,"auth_index":"idx-1","auth_status":{"quota":{"exceeded":true,"reason":"credential_quota","next_recover_at":%q,"backoff_level":3}}}`,
				now.Format(time.RFC3339), recoverAt.Format(time.RFC3339))
			if err := repo.CaptureErrorEvent(ctx, "default", rawEvent, now); err != nil {
				t.Fatal(err)
			}

			response, raw := doJSON(t, client, http.MethodPost, base+"/omc/api/v1/management/auth-files/verify", `{"name":"codex.json","auth_index":"idx-1"}`)
			if response.StatusCode != test.wantHTTPStatus {
				t.Fatalf("status = %d, want %d: %s", response.StatusCode, test.wantHTTPStatus, raw)
			}
			if strings.Contains(string(raw), "OPAQUE-SECRET") {
				t.Fatalf("response leaked upstream secret: %s", raw)
			}
			var body struct {
				Code string `json:"code"`
			}
			if err := json.Unmarshal(raw, &body); err != nil || body.Code != test.wantCode {
				t.Fatalf("code = %q, want %q; body=%s", body.Code, test.wantCode, raw)
			}

			// Local cooldown evidence must NOT be cleared when CPA refused to apply verification.
			cooldowns, err := repo.BatchCorrelatedCooldowns(ctx, []string{"idx-1"}, now.UnixMilli())
			if err != nil || !cooldowns["idx-1"].IsActive {
				t.Fatalf("cooldown must remain active after 409 %s: %+v, %v", test.name, cooldowns, err)
			}

			events, err := repo.ListAuditEvents(ctx, 10)
			if err != nil {
				t.Fatal(err)
			}
			rawAudit, _ := json.Marshal(events)
			if strings.Contains(string(rawAudit), "OPAQUE-SECRET") {
				t.Fatalf("audit leaked secret: %s", rawAudit)
			}
			if test.wantCode == "verification_not_applied" && !strings.Contains(string(rawAudit), `"verification_not_applied"`) {
				t.Fatalf("audit missing verification_not_applied code: %s", rawAudit)
			}
		})
	}
}

func TestCPAAuthoritativeProjectionReleasesStaleLocalCredentialCooldown(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	recoverAt := now.Add(2 * time.Hour)
	modelRecoverAt := now.Add(3 * time.Hour)

	client, base, repo := startDashboardTestServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/v8/management/credentials":
			fmt.Fprintf(w, `{"files":[
				{"id":"cred-lifted","name":"codex-lifted.json","auth_index":"idx-lifted","type":"codex","provider":"codex","account_type":"oauth","status":"active","unavailable":false,"recovery_stage":"quota_blocked","quota_blocked":true},
				{"id":"cred-cooling","name":"codex-cooling.json","auth_index":"idx-cooling","type":"codex","provider":"codex","account_type":"oauth","status":"error","unavailable":true,"next_retry_after":%q,"recovery_stage":"quota_blocked","quota_blocked":true}
			]}`, recoverAt.Format(time.RFC3339))
		case "/v8/management/config/oauth/model-alias":
			fmt.Fprint(w, `{}`)
		default:
			http.NotFound(w, r)
		}
	})

	ctx := context.Background()
	liftedCred := fmt.Sprintf(`{"timestamp":%q,"auth_index":"idx-lifted","auth_status":{"quota":{"exceeded":true,"reason":"credential_quota","next_recover_at":%q,"backoff_level":4}}}`,
		now.Format(time.RFC3339), recoverAt.Format(time.RFC3339))
	liftedModel := fmt.Sprintf(`{"timestamp":%q,"auth_index":"idx-lifted","model":"gpt-5-pro","status_code":429,"auth_status":{"quota":{"exceeded":true,"reason":"quota","next_recover_at":%q,"backoff_level":2},"model":{"name":"gpt-5-pro","next_retry_after":%q,"quota":{"exceeded":true,"reason":"quota","next_recover_at":%q,"backoff_level":2}}}}`,
		now.Add(time.Second).Format(time.RFC3339), modelRecoverAt.Format(time.RFC3339), modelRecoverAt.Format(time.RFC3339), modelRecoverAt.Format(time.RFC3339))
	stillCooling := fmt.Sprintf(`{"timestamp":%q,"auth_index":"idx-cooling","auth_status":{"quota":{"exceeded":true,"reason":"credential_quota","next_recover_at":%q,"backoff_level":4}}}`,
		now.Format(time.RFC3339), recoverAt.Format(time.RFC3339))
	for _, rawEvent := range []string{liftedCred, liftedModel, stillCooling} {
		if err := repo.CaptureErrorEvent(ctx, "default", rawEvent, now); err != nil {
			t.Fatal(err)
		}
	}

	// Quota overview reconciles against CPA's live auth-file projection.
	overviewResp, overviewRaw := doJSON(t, client, http.MethodGet, base+"/omc/api/v1/management/quota", "")
	if overviewResp.StatusCode != http.StatusOK {
		t.Fatalf("quota overview = %d %s", overviewResp.StatusCode, overviewRaw)
	}
	var overview struct {
		Quotas []struct {
			AuthIndex      string `json:"auth_index"`
			Status         string `json:"status"`
			ActiveCooldown *struct {
				IsActive bool `json:"is_active"`
			} `json:"active_cooldown"`
			ModelCooldowns []struct {
				Model string `json:"model"`
			} `json:"model_cooldowns"`
		} `json:"quotas"`
	}
	if err := json.Unmarshal(overviewRaw, &overview); err != nil {
		t.Fatal(err)
	}
	var sawLifted, sawCooling bool
	for _, item := range overview.Quotas {
		switch item.AuthIndex {
		case "idx-lifted":
			sawLifted = true
			if item.Status == "cooldown" || item.ActiveCooldown != nil {
				t.Fatalf("idx-lifted must not render stale cooldown after CPA lifted it: %+v", item)
			}
			if len(item.ModelCooldowns) != 1 || item.ModelCooldowns[0].Model != "gpt-5-pro" {
				t.Fatalf("idx-lifted independent model cooldown must survive reconciliation: %+v", item.ModelCooldowns)
			}
		case "idx-cooling":
			sawCooling = true
			if item.Status != "cooldown" || item.ActiveCooldown == nil || !item.ActiveCooldown.IsActive {
				t.Fatalf("idx-cooling must keep active cooldown while CPA reports error/unavailable: %+v", item)
			}
		}
	}
	if !sawLifted || !sawCooling {
		t.Fatalf("overview missing seeded credentials (sawLifted=%v, sawCooling=%v): %s", sawLifted, sawCooling, overviewRaw)
	}

	// Re-seed idx-lifted and verify single-credential detail and trends/quota reconcile too.
	if err := repo.CaptureErrorEvent(ctx, "default", strings.Replace(liftedCred, `"backoff_level":4`, `"backoff_level":5`, 1), now.Add(2*time.Second)); err != nil {
		t.Fatal(err)
	}
	detailResp, detailRaw := doJSON(t, client, http.MethodGet, base+"/omc/api/v1/management/quota/idx-lifted", "")
	if detailResp.StatusCode != http.StatusOK || strings.Contains(string(detailRaw), `"active_cooldown"`) {
		t.Fatalf("quota detail for idx-lifted = %d %s", detailResp.StatusCode, detailRaw)
	}

	if err := repo.CaptureErrorEvent(ctx, "default", strings.Replace(liftedCred, `"backoff_level":4`, `"backoff_level":6`, 1), now.Add(3*time.Second)); err != nil {
		t.Fatal(err)
	}
	trendsResp, trendsRaw := doJSON(t, client, http.MethodGet, base+"/omc/api/v1/management/trends/quota", "")
	if trendsResp.StatusCode != http.StatusOK {
		t.Fatalf("trends quota = %d %s", trendsResp.StatusCode, trendsRaw)
	}
	var trends struct {
		Items []struct {
			AuthIndex string `json:"auth_index"`
			Status    string `json:"status"`
		} `json:"items"`
	}
	if err := json.Unmarshal(trendsRaw, &trends); err != nil {
		t.Fatal(err)
	}
	var sawTrendsLifted bool
	for _, item := range trends.Items {
		if item.AuthIndex == "idx-lifted" {
			sawTrendsLifted = true
			if item.Status == "cooldown" {
				t.Fatalf("trends/quota kept stale cooldown for idx-lifted: %+v", item)
			}
		}
	}
	if !sawTrendsLifted {
		t.Fatalf("trends/quota missing idx-lifted: %s", trendsRaw)
	}

	// If the repository clear fails, the quota response must keep active_cooldown
	// consistent with stored routing state so a later read can retry reconciliation.
	if err := repo.CaptureErrorEvent(ctx, "default", strings.Replace(liftedCred, `"backoff_level":4`, `"backoff_level":7`, 1), now.Add(4*time.Second)); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.SQL().Exec(`CREATE TRIGGER reject_cooldown_clear BEFORE UPDATE ON error_events BEGIN SELECT RAISE(FAIL, 'db busy'); END`); err != nil {
		t.Fatal(err)
	}
	defer func() {
		_, _ = repo.SQL().Exec(`DROP TRIGGER IF EXISTS reject_cooldown_clear`)
	}()
	failResp, failRaw := doJSON(t, client, http.MethodGet, base+"/omc/api/v1/management/quota", "")
	if failResp.StatusCode != http.StatusOK {
		t.Fatalf("quota overview during db error = %d %s", failResp.StatusCode, failRaw)
	}
	var failOverview struct {
		Quotas []struct {
			AuthIndex      string `json:"auth_index"`
			Status         string `json:"status"`
			ActiveCooldown *struct {
				IsActive bool `json:"is_active"`
			} `json:"active_cooldown"`
		} `json:"quotas"`
	}
	if err := json.Unmarshal(failRaw, &failOverview); err != nil {
		t.Fatal(err)
	}
	var sawRetained bool
	for _, item := range failOverview.Quotas {
		if item.AuthIndex == "idx-lifted" {
			sawRetained = true
			if item.Status != "cooldown" || item.ActiveCooldown == nil || !item.ActiveCooldown.IsActive {
				t.Fatalf("idx-lifted must retain active_cooldown in response when repo clear fails: %+v", item)
			}
		}
	}
	if !sawRetained {
		t.Fatalf("overview missing idx-lifted during clear failure: %s", failRaw)
	}
}

func TestVerifyCredentialPreservesCooldownOnLegacyCPAAndNewerIngest(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	recoverAt := now.Add(2 * time.Hour)
	var repoRef *repository.Repository
	var injectDuringVerify atomic.Bool
	var replacedVerified atomic.Bool
	var failNextCredentialsRead atomic.Bool
	var guardedQuotaReads atomic.Int32

	client, base, repo := startDashboardTestServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/v8/management/credentials":
			if failNextCredentialsRead.CompareAndSwap(true, false) {
				w.WriteHeader(http.StatusBadGateway)
				fmt.Fprint(w, `{"error":"temporary readback failure"}`)
				return
			}
			// idx-legacy models pre-v8.1.8 CPA: verify returns 200 verified=true but CPA keeps it cooling.
			// idx-raced models CPA v8.1.8+ releasing the old cooldown, while a brand-new cooldown is ingested mid-verify.
			// idx-replaced models CPA swapping a different runtime ID under the same name/auth_index during verify.
			// idx-shared models two credentials sharing one auth_index (A active, B still cooling).
			// idx-readback-fail models a transient error on the post-verify readback.
			replacedID := "cred-replaced-old"
			if replacedVerified.Load() {
				replacedID = "cred-replaced-new"
			}
			fmt.Fprintf(w, `{"files":[
				{"id":"cred-legacy","name":"codex-legacy.json","auth_index":"idx-legacy","type":"codex","provider":"codex","status":"error","unavailable":true,"next_retry_after":%q,"requires_sign_in":false,"renewal_state":"awaiting_first_renewal","recovery_stage":"quota_blocked","adopted":true,"inference_verified":true},
				{"id":"cred-raced","name":"codex-raced.json","auth_index":"idx-raced","type":"codex","provider":"codex","status":"active","unavailable":false,"requires_sign_in":false,"renewal_state":"awaiting_first_renewal","recovery_stage":"loaded","adopted":true,"inference_verified":true},
				{"id":%q,"name":"codex-replaced.json","auth_index":"idx-replaced","type":"codex","provider":"codex","status":"active","unavailable":false,"requires_sign_in":false,"renewal_state":"awaiting_first_renewal","recovery_stage":"loaded","adopted":true,"inference_verified":true},
				{"id":"cred-shared-a","name":"codex-shared-a.json","auth_index":"idx-shared","type":"codex","provider":"codex","status":"active","unavailable":false,"requires_sign_in":false,"renewal_state":"awaiting_first_renewal","recovery_stage":"loaded","adopted":true,"inference_verified":true},
				{"id":"cred-shared-b","name":"codex-shared-b.json","auth_index":"idx-shared","type":"codex","provider":"codex","status":"error","unavailable":true,"next_retry_after":%q,"requires_sign_in":false,"renewal_state":"awaiting_first_renewal","recovery_stage":"quota_blocked","adopted":true,"inference_verified":false},
				{"id":"cred-readback","name":"codex-readback.json","auth_index":"idx-readback-fail","type":"codex","provider":"codex","status":"active","unavailable":false,"requires_sign_in":false,"renewal_state":"awaiting_first_renewal","recovery_stage":"loaded","adopted":true,"inference_verified":true}
			]}`, recoverAt.Format(time.RFC3339), replacedID, recoverAt.Format(time.RFC3339))
		case "/v8/management/credentials/verify":
			var body struct {
				AuthIndex string `json:"auth_index"`
			}
			_ = json.NewDecoder(r.Body).Decode(&body)
			if body.AuthIndex == "idx-raced" && injectDuringVerify.CompareAndSwap(true, false) && repoRef != nil {
				newerEvent := fmt.Sprintf(`{"timestamp":%q,"auth_index":"idx-raced","auth_status":{"quota":{"exceeded":true,"reason":"credential_quota","next_recover_at":%q,"backoff_level":9}}}`,
					now.Add(2*time.Second).Format(time.RFC3339), recoverAt.Add(time.Hour).Format(time.RFC3339))
				if err := repoRef.CaptureErrorEvent(context.Background(), "default", newerEvent, now.Add(2*time.Second)); err != nil {
					t.Errorf("CaptureErrorEvent during verify: %v", err)
				}
			}
			if body.AuthIndex == "idx-replaced" {
				replacedVerified.Store(true)
			}
			if body.AuthIndex == "idx-readback-fail" {
				failNextCredentialsRead.Store(true)
			}
			fmt.Fprint(w, `{"status":"ok","verified":true}`)
		case "/v8/management/requests/api-call":
			var payload struct {
				AuthIndex string `json:"auth_index"`
			}
			_ = json.NewDecoder(r.Body).Decode(&payload)
			switch payload.AuthIndex {
			case "idx-replaced", "idx-shared", "idx-readback-fail":
				guardedQuotaReads.Add(1)
			}
			fmt.Fprint(w, `{"status_code":200,"body":{"plan_type":"pro","rate_limit":{"primary_window":{"used_percent":10,"limit_window_seconds":18000,"reset_after_seconds":14400}}}}`)
		default:
			http.NotFound(w, r)
		}
	})
	repoRef = repo
	injectDuringVerify.Store(true)

	ctx := context.Background()
	for _, seed := range []struct {
		authIndex string
		backoff   int
	}{
		{"idx-legacy", 2},
		{"idx-raced", 1},
		{"idx-replaced", 3},
		{"idx-shared", 4},
		{"idx-readback-fail", 5},
	} {
		rawEvent := fmt.Sprintf(`{"timestamp":%q,"auth_index":%q,"auth_status":{"quota":{"exceeded":true,"reason":"credential_quota","next_recover_at":%q,"backoff_level":%d}}}`,
			now.Format(time.RFC3339), seed.authIndex, recoverAt.Format(time.RFC3339), seed.backoff)
		if err := repo.CaptureErrorEvent(ctx, "default", rawEvent, now); err != nil {
			t.Fatal(err)
		}
	}

	for _, body := range []string{
		`{"name":"codex-legacy.json","auth_index":"idx-legacy"}`,
		`{"name":"codex-raced.json","auth_index":"idx-raced"}`,
		`{"name":"codex-replaced.json","auth_index":"idx-replaced"}`,
		`{"name":"codex-shared-a.json","auth_index":"idx-shared"}`,
		`{"name":"codex-readback.json","auth_index":"idx-readback-fail"}`,
	} {
		resp, raw := doJSON(t, client, http.MethodPost, base+"/omc/api/v1/management/auth-files/verify", body)
		if resp.StatusCode != http.StatusOK || !strings.Contains(string(raw), `"verified":true`) {
			t.Fatalf("verify %s = %d %s", body, resp.StatusCode, raw)
		}
	}
	if guardedQuotaReads.Load() != 0 {
		t.Fatalf("unconfirmed, replaced, or ambiguous auth_index must not trigger post-verify quota refresh, got %d reads", guardedQuotaReads.Load())
	}

	cooldowns, err := repo.BatchCorrelatedCooldowns(ctx, []string{"idx-legacy", "idx-raced", "idx-replaced", "idx-shared", "idx-readback-fail"}, now.UnixMilli())
	if err != nil {
		t.Fatal(err)
	}
	if !cooldowns["idx-legacy"].IsActive {
		t.Fatalf("pre-v8.1.8 CPA keeping error/unavailable must retain local cooldown evidence: %+v", cooldowns["idx-legacy"])
	}
	if !cooldowns["idx-raced"].IsActive || cooldowns["idx-raced"].BackoffLevel != 9 {
		t.Fatalf("cooldown ingested during verify must not be erased by pre-verify watermark: %+v", cooldowns["idx-raced"])
	}
	if !cooldowns["idx-replaced"].IsActive {
		t.Fatalf("replacement runtime ID must not clear prior credential cooldown evidence: %+v", cooldowns["idx-replaced"])
	}
	if !cooldowns["idx-shared"].IsActive {
		t.Fatalf("shared auth_index must not clear sibling credential cooldown evidence: %+v", cooldowns["idx-shared"])
	}
	if !cooldowns["idx-readback-fail"].IsActive {
		t.Fatalf("failed post-verify readback must retain local cooldown evidence: %+v", cooldowns["idx-readback-fail"])
	}
}

func TestRestoredQuotaVetoedByMixedForceCooldownAndAutoRefreshReconcilesWithActiveModel(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	futureAt := now.Add(2 * time.Hour)
	pastAt := now.Add(-10 * time.Minute)
	var cooldownResets atomic.Int32
	var handler *Handler

	client, base, repo := startDashboardTestServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/v8/management/credentials":
			fmt.Fprint(w, `{"files":[
				{"id":"cred-mixed","name":"codex-mixed.json","auth_index":"idx-mixed","type":"codex","provider":"codex","status":"error","unavailable":true,"disabled":false},
				{"id":"cred-auto","name":"codex-auto.json","auth_index":"idx-auto","type":"codex","provider":"codex","status":"active","unavailable":false,"disabled":false}
			]}`)
		case "/v8/management/requests/api-call":
			fmt.Fprint(w, `{"status_code":200,"body":{"plan_type":"pro","rate_limit":{"primary_window":{"used_percent":5,"limit_window_seconds":18000,"reset_after_seconds":14400}}}}`)
		case "/v8/management/routing/cooldown/reset":
			cooldownResets.Add(1)
			fmt.Fprint(w, `{"status":"ok"}`)
		case "/v8/management/config/oauth/model-alias":
			fmt.Fprint(w, `{}`)
		default:
			http.NotFound(w, r)
		}
	}, func(h *Handler) { handler = h })

	ctx := context.Background()
	// idx-mixed has both an ordinary quota row and an active force_cooldown row: manual
	// quota refresh showing healthy capacity must NOT issue a credential-wide CPA reset.
	ordinaryQuota := fmt.Sprintf(`{"timestamp":%q,"auth_index":"idx-mixed","auth_status":{"quota":{"exceeded":true,"reason":"credential_quota","next_recover_at":%q,"backoff_level":2}}}`,
		now.Add(-time.Minute).Format(time.RFC3339), futureAt.Format(time.RFC3339))
	activeForce := fmt.Sprintf(`{"timestamp":%q,"auth_index":"idx-mixed","code":"force_cooldown","status_code":502,"auth_status":{"quota":{"exceeded":true,"reason":"force_cooldown","next_recover_at":%q,"backoff_level":1}}}`,
		now.Format(time.RFC3339), futureAt.Format(time.RFC3339))
	// idx-auto has an expired credential cooldown + still-active model cooldown while CPA reports active.
	expiredCred := fmt.Sprintf(`{"timestamp":%q,"auth_index":"idx-auto","auth_status":{"quota":{"exceeded":true,"reason":"credential_quota","next_recover_at":%q,"backoff_level":2}}}`,
		now.Add(-20*time.Minute).Format(time.RFC3339), pastAt.Format(time.RFC3339))
	activeModel := fmt.Sprintf(`{"timestamp":%q,"auth_index":"idx-auto","model":"gpt-5-pro","status_code":429,"auth_status":{"quota":{"exceeded":true,"reason":"quota","next_recover_at":%q,"backoff_level":2},"model":{"name":"gpt-5-pro","next_retry_after":%q,"quota":{"exceeded":true,"reason":"quota","next_recover_at":%q,"backoff_level":2}}}}`,
		now.Format(time.RFC3339), futureAt.Format(time.RFC3339), futureAt.Format(time.RFC3339), futureAt.Format(time.RFC3339))
	for _, rawEvent := range []string{ordinaryQuota, activeForce, expiredCred, activeModel} {
		if err := repo.CaptureErrorEvent(ctx, "default", rawEvent, now); err != nil {
			t.Fatal(err)
		}
	}

	refreshResp, refreshRaw := doJSON(t, client, http.MethodPost, base+"/omc/api/v1/management/quota/refresh", `{"auth_index":"idx-mixed"}`)
	if refreshResp.StatusCode != http.StatusOK {
		t.Fatalf("quota refresh idx-mixed = %d %s", refreshResp.StatusCode, refreshRaw)
	}
	if cooldownResets.Load() != 0 {
		t.Fatalf("active force_cooldown mixed with quota row must veto CPA cooldown reset, got %d resets", cooldownResets.Load())
	}
	if hasForce, err := repo.HasActiveForceCooldownEvidence(ctx, "idx-mixed", now.UnixMilli()); err != nil || !hasForce {
		t.Fatalf("idx-mixed force_cooldown must survive healthy quota refresh: %v, %v", hasForce, err)
	}

	// Run one automatic refresh round: idx-auto's expired credential cooldown is reconciled
	// locally despite its active model cooldown, with zero credential-wide CPA resets.
	round, err := handler.runQuotaAutoRefreshRound(ctx)
	if err != nil {
		t.Fatalf("runQuotaAutoRefreshRound: %v", err)
	}
	if round.CooldownsCleared != 1 {
		t.Fatalf("round.CooldownsCleared = %d, want 1 (local reconciliation for idx-auto)", round.CooldownsCleared)
	}
	if cooldownResets.Load() != 0 {
		t.Fatalf("auto-refresh must not call CPA reset when CPA already reports idx-auto active, got %d", cooldownResets.Load())
	}
	remainingExpired, err := repo.BatchExpiredCredentialCooldowns(ctx, []string{"idx-auto"}, now.UnixMilli())
	if err != nil || len(remainingExpired) != 0 {
		t.Fatalf("idx-auto expired credential cooldown should be cleared: %+v, %v", remainingExpired, err)
	}
	models, err := repo.BatchModelCooldowns(ctx, []string{"idx-auto"}, now.UnixMilli(), nil)
	if err != nil || len(models["idx-auto"]) != 1 || models["idx-auto"][0].Model != "gpt-5-pro" {
		t.Fatalf("idx-auto independent model cooldown must survive auto-refresh reconciliation: %+v, %v", models, err)
	}
}

func TestCPAAuthoritativeProjectionDoesNotClearCooldownIngestedAfterSnapshotStarted(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	recoverAt := now.Add(2 * time.Hour)
	var repoRef *repository.Repository
	var injectNewCooldown atomic.Bool

	client, base, repo := startDashboardTestServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/v8/management/credentials":
			// Simulate CPA entering cooldown and OMC ingesting the error event after the
			// snapshot request began, while the in-flight response still returns active.
			if injectNewCooldown.CompareAndSwap(true, false) && repoRef != nil {
				rawEvent := fmt.Sprintf(`{"timestamp":%q,"auth_index":"idx-race","auth_status":{"quota":{"exceeded":true,"reason":"credential_quota","next_recover_at":%q,"backoff_level":2}}}`,
					now.Format(time.RFC3339), recoverAt.Format(time.RFC3339))
				if err := repoRef.CaptureErrorEvent(context.Background(), "default", rawEvent, now); err != nil {
					t.Errorf("CaptureErrorEvent during AuthFiles fetch: %v", err)
				}
			}
			fmt.Fprint(w, `{"files":[{"id":"cred-race","name":"codex-race.json","auth_index":"idx-race","type":"codex","provider":"codex","account_type":"oauth","status":"active","unavailable":false}]}`)
		case "/v8/management/config/oauth/model-alias":
			fmt.Fprint(w, `{}`)
		default:
			http.NotFound(w, r)
		}
	})
	// Seed an older event first so snapshotMaxEventID > 0 before the overview runs and
	// the per-event EventID > snapshotMaxEventID guard is genuinely exercised.
	seedEvent := fmt.Sprintf(`{"timestamp":%q,"auth_index":"idx-seed","auth_status":{"quota":{"exceeded":true,"reason":"credential_quota","next_recover_at":%q,"backoff_level":1}}}`,
		now.Add(-time.Minute).Format(time.RFC3339), now.Add(-30*time.Second).Format(time.RFC3339))
	if err := repo.CaptureErrorEvent(context.Background(), "default", seedEvent, now.Add(-time.Minute)); err != nil {
		t.Fatal(err)
	}
	repoRef = repo
	injectNewCooldown.Store(true)

	overviewResp, overviewRaw := doJSON(t, client, http.MethodGet, base+"/omc/api/v1/management/quota", "")
	if overviewResp.StatusCode != http.StatusOK {
		t.Fatalf("quota overview = %d %s", overviewResp.StatusCode, overviewRaw)
	}
	var overview struct {
		Quotas []struct {
			AuthIndex      string `json:"auth_index"`
			Status         string `json:"status"`
			ActiveCooldown *struct {
				IsActive bool `json:"is_active"`
			} `json:"active_cooldown"`
		} `json:"quotas"`
	}
	if err := json.Unmarshal(overviewRaw, &overview); err != nil {
		t.Fatal(err)
	}
	if len(overview.Quotas) != 1 || overview.Quotas[0].Status != "cooldown" || overview.Quotas[0].ActiveCooldown == nil || !overview.Quotas[0].ActiveCooldown.IsActive {
		t.Fatalf("stale CPA snapshot must not hide newer cooldown in response: %+v", overview.Quotas)
	}

	cooldowns, err := repo.BatchCorrelatedCooldowns(context.Background(), []string{"idx-race"}, now.UnixMilli())
	if err != nil || !cooldowns["idx-race"].IsActive {
		t.Fatalf("stale CPA snapshot must not clear newer cooldown in persistence: %+v, %v", cooldowns, err)
	}
}
