package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"os"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/crypto"
	"github.com/oh-my-cpa/oh-my-cpa/internal/domain"
	"github.com/oh-my-cpa/oh-my-cpa/internal/warmup"
)

type warmupFixture struct {
	mu                                          sync.Mutex
	sends, reads, credentialReads               int
	onCredentialRead                            func(int) bool
	isActive, isPaid, isUsageFailed, isTimedOut bool
	entered, release                            chan struct{}
}

func newWarmupHandler(t *testing.T, fixture *warmupFixture) *Handler {
	t.Helper()
	server := newFakeCPA(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		switch request.URL.Path {
		case "/v8/management/credentials":
			fixture.mu.Lock()
			fixture.credentialReads++
			read, onRead := fixture.credentialReads, fixture.onCredentialRead
			fixture.mu.Unlock()
			if onRead != nil && onRead(read) {
				writer.WriteHeader(http.StatusServiceUnavailable)
				_, _ = writer.Write([]byte(`{"error":"temporary credential listing failure"}`))
				return
			}
			_, _ = writer.Write([]byte(`{"files":[{"id":"claude-file","name":"claude.json","type":"claude","provider":"claude","auth_index":"exact-claude","source":"file"}]}`))
		case "/v8/management/credentials/models":
			_, _ = writer.Write([]byte(`{"models":[{"id":"claude-haiku-test"}]}`))
		case "/v8/management/requests/api-call":
			var payload struct {
				AuthIndex string `json:"auth_index"`
				Method    string `json:"method"`
				URL       string `json:"url"`
				Data      string `json:"data"`
			}
			_ = json.NewDecoder(request.Body).Decode(&payload)
			if payload.AuthIndex != "exact-claude" {
				t.Errorf("wrong credential: %s", payload.AuthIndex)
			}
			if payload.URL == warmup.CLAUDE_ENDPOINT {
				fixture.mu.Lock()
				fixture.sends++
				fixture.isActive = true
				isTimedOut := fixture.isTimedOut
				fixture.mu.Unlock()
				if fixture.entered != nil {
					close(fixture.entered)
					select {
					case <-fixture.release:
					case <-request.Context().Done():
					}
				}
				if isTimedOut {
					writer.WriteHeader(502)
					_, _ = writer.Write([]byte(`{"error":"request failed"}`))
					return
				}
				_, _ = writer.Write([]byte(`{"status_code":200,"body":{"type":"message","stop_reason":"end_turn","content":[{"type":"text","text":"OK"}],"usage":{"input_tokens":5,"output_tokens":1}}}`))
				return
			}
			if strings.HasPrefix(payload.URL, "https://api.anthropic.com/api/oauth/usage") {
				fixture.mu.Lock()
				fixture.reads++
				isActive, isPaid, isUsageFailed := fixture.isActive, fixture.isPaid, fixture.isUsageFailed
				fixture.mu.Unlock()
				if isUsageFailed {
					_, _ = writer.Write([]byte(`{"status_code":500,"body":{}}`))
					return
				}
				five, week := "null", "null"
				if isActive {
					five = `{"utilization":0,"resets_at":"` + time.Now().Add(5*time.Hour).UTC().Format(time.RFC3339Nano) + `"}`
					week = `{"utilization":0,"resets_at":"` + time.Now().Add(7*24*time.Hour).UTC().Format(time.RFC3339Nano) + `"}`
				}
				_ = json.NewEncoder(writer).Encode(map[string]any{"status_code": 200, "body": json.RawMessage(`{"five_hour":` + five + `,"seven_day":` + week + `,"extra_usage":{"is_enabled":` + map[bool]string{true: "true", false: "false"}[isPaid] + `}}`)})
				return
			}
			_, _ = writer.Write([]byte(`{"status_code":404,"body":{}}`))
		default:
			writer.WriteHeader(404)
		}
	}))
	t.Cleanup(server.Close)
	handler := testHandler(t, "")
	if err := handler.repo.Timezone().Set("UTC"); err != nil {
		t.Fatal(err)
	}
	cipher, err := crypto.New("01234567890123456789012345678901")
	if err != nil {
		t.Fatal(err)
	}
	ciphertext, nonce, err := cipher.Encrypt([]byte("management-secret"))
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	if err = handler.repo.UpsertInstance(context.Background(), domain.CPAInstance{ID: "default", Name: "Default", BaseURL: server.URL, UsageAddr: strings.TrimPrefix(server.URL, "http://"), ManagementKeyCiphertext: ciphertext, ManagementKeyNonce: nonce, CreatedAt: now, UpdatedAt: now}); err != nil {
		t.Fatal(err)
	}
	policy := warmup.DefaultPolicy()
	policy.Model = "claude-haiku-test"
	policy.ResetMode = "all"
	if err = handler.repo.WriteWarmupPolicy(context.Background(), "default", "provider", "claude", &policy, now.UnixMilli()); err != nil {
		t.Fatal(err)
	}
	return handler
}
func credentialWarmupRevision(t *testing.T, handler *Handler) string {
	t.Helper()
	client, err := handler.capabilityClient(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	file, err := handler.warmupFile(context.Background(), client, "exact-claude")
	if err != nil {
		t.Fatal(err)
	}
	credential, err := handler.warmupCredential(context.Background(), client, file, true)
	if err != nil {
		t.Fatal(err)
	}
	return credential.Revision
}
func TestWarmupManualActivationAndReplay(t *testing.T) {
	fixture := &warmupFixture{}
	handler := newWarmupHandler(t, fixture)
	revision := credentialWarmupRevision(t, handler)
	result, err := handler.executeWarmup(context.Background(), "exact-claude", "manual-activation", revision, true)
	if err != nil || result.Status != "activated" {
		t.Fatalf("%+v %v", result, err)
	}
	state, err := handler.repo.ReadWarmupState(context.Background(), "default", "exact-claude")
	if err != nil || !state.IsProtocolVerified || state.VerifiedModel != "claude-haiku-test" {
		t.Fatalf("%+v %v", state, err)
	}
	replay, err := handler.executeWarmup(context.Background(), "exact-claude", "manual-activation", "old-revision", true)
	if err != nil || replay.Status != result.Status {
		t.Fatalf("replay: %+v %v", replay, err)
	}
	fixture.mu.Lock()
	sends := fixture.sends
	fixture.mu.Unlock()
	if sends != 1 {
		t.Fatalf("sent %d", sends)
	}
	if err = handler.runCredentialWarmupRound(context.Background()); err != nil {
		t.Fatal(err)
	}
	fixture.mu.Lock()
	sends = fixture.sends
	fixture.mu.Unlock()
	if sends != 1 {
		t.Fatalf("active duplicate %d", sends)
	}
}
func TestWarmupProtectionAndUnverifiedAutomation(t *testing.T) {
	for _, scenario := range []struct {
		name    string
		fixture *warmupFixture
		manual  bool
		reason  string
	}{
		{"paid", &warmupFixture{isPaid: true}, true, "paid_usage_enabled"},
		{"unread", &warmupFixture{isUsageFailed: true}, true, "quota_unknown"},
		{"unverified", &warmupFixture{}, false, "activation_unverified"},
		{"active", &warmupFixture{isActive: true}, true, "already_active"},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			handler := newWarmupHandler(t, scenario.fixture)
			result, err := handler.executeWarmup(context.Background(), "exact-claude", "manual-protection", credentialWarmupRevision(t, handler), scenario.manual)
			if err != nil || result.Reason != scenario.reason {
				t.Fatalf("%+v %v", result, err)
			}
			scenario.fixture.mu.Lock()
			sends := scenario.fixture.sends
			scenario.fixture.mu.Unlock()
			if sends != 0 {
				t.Fatalf("consumed %d", sends)
			}
		})
	}
}
func TestWarmupConcurrentManualRunAndUncertainRecovery(t *testing.T) {
	fixture := &warmupFixture{entered: make(chan struct{}), release: make(chan struct{}), isTimedOut: true}
	handler := newWarmupHandler(t, fixture)
	revision := credentialWarmupRevision(t, handler)
	done := make(chan warmup.Result, 1)
	go func() {
		result, _ := handler.executeWarmup(context.Background(), "exact-claude", "manual-uncertain", revision, true)
		done <- result
	}()
	<-fixture.entered
	if _, err := handler.executeWarmup(context.Background(), "exact-claude", "manual-parallel", revision, true); err != warmup.ErrBusy {
		t.Fatalf("parallel: %v", err)
	}
	close(fixture.release)
	result := <-done
	if result.Status != "uncertain" {
		t.Fatalf("%+v", result)
	}
	fixture.mu.Lock()
	fixture.isActive = false
	fixture.mu.Unlock()
	next, err := handler.executeWarmup(context.Background(), "exact-claude", "manual-new-id", revision, true)
	if err != nil || next.Reason != "outcome_unknown" {
		t.Fatalf("%+v %v", next, err)
	}
	fixture.mu.Lock()
	sends := fixture.sends
	fixture.mu.Unlock()
	if sends != 1 {
		t.Fatalf("uncertain resent: %d", sends)
	}
}
func TestWarmupSettingsRevisionAndInheritance(t *testing.T) {
	handler := newWarmupHandler(t, &warmupFixture{})
	settings, err := handler.warmupSettings(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	policy := warmup.DefaultPolicy()
	policy.Model = "claude-haiku-test"
	policy.IsDailyEnabled = true
	input := warmup.PolicyWrite{Provider: "claude", Policy: policy, Revision: settings.Revision, IsConfirmed: true}
	if _, err = handler.saveWarmupSettings(context.Background(), input); err != nil {
		t.Fatal(err)
	}
	if _, err = handler.saveWarmupSettings(context.Background(), input); err == nil || err.Error() != "resource_conflict" {
		t.Fatalf("stale: %v", err)
	}
	client, _ := handler.capabilityClient(context.Background())
	file, _ := handler.warmupFile(context.Background(), client, "exact-claude")
	credential, _ := handler.warmupCredential(context.Background(), client, file, true)
	if !credential.IsInherited || credential.Policy != policy {
		t.Fatalf("%+v", credential)
	}
	override := warmup.DefaultPolicy()
	override.Model = "claude-haiku-test"
	saved, err := handler.saveWarmupCredential(context.Background(), file.AuthIndex, warmup.CredentialWrite{IsInherited: false, Policy: override, Revision: credential.Revision, IsConfirmed: true})
	if err != nil || saved.IsInherited || saved.Policy.IsEnabled() {
		t.Fatalf("%+v %v", saved, err)
	}
	inherited, err := handler.saveWarmupCredential(context.Background(), file.AuthIndex, warmup.CredentialWrite{IsInherited: true, Revision: saved.Revision, IsConfirmed: true})
	if err != nil || !inherited.IsInherited || inherited.Policy != policy {
		t.Fatalf("%+v %v", inherited, err)
	}
}

func TestWarmupHandlerCertifiesWireCorpus(t *testing.T) {
	raw, err := os.ReadFile("../../scripts/acceptance/contracts/warmup.json")
	if err != nil {
		t.Fatal(err)
	}
	var corpus struct {
		Version    int            `json:"version"`
		Credential map[string]any `json:"credential"`
		Cases      []struct {
			ID       string          `json:"id"`
			Body     json.RawMessage `json:"body"`
			Status   int             `json:"status"`
			Response map[string]any  `json:"response"`
		} `json:"cases"`
	}
	if err = json.Unmarshal(raw, &corpus); err != nil || corpus.Version != 1 {
		t.Fatal("invalid corpus")
	}
	handler := newWarmupHandler(t, &warmupFixture{})
	caller, baseURL := warmupHTTPClient(t, handler)
	response, err := caller.Get(baseURL + "/api/v1/management/quota/warmup/credentials/exact-claude")
	if err != nil {
		t.Fatal(err)
	}
	var actual map[string]any
	_ = json.NewDecoder(response.Body).Decode(&actual)
	_ = response.Body.Close()
	// Only the signing revision is environment-specific; the rest is the real DTO.
	actual["revision"] = "wire-revision"
	actual["state"].(map[string]any)["credential_id"] = "wire-credential-identity"
	if !reflect.DeepEqual(actual, corpus.Credential) {
		t.Fatalf("projection differs\nactual=%v\nexpected=%v", actual, corpus.Credential)
	}
	for _, entry := range corpus.Cases {
		t.Run(entry.ID, func(t *testing.T) {
			response, err := caller.Post(baseURL+"/api/v1/management/quota/warmup/credentials/exact-claude/run", "application/json", bytes.NewReader(entry.Body))
			if err != nil {
				t.Fatal(err)
			}
			defer response.Body.Close()
			var actual map[string]any
			_ = json.NewDecoder(response.Body).Decode(&actual)
			if response.StatusCode != entry.Status || !reflect.DeepEqual(actual, entry.Response) {
				t.Fatalf("%d %v", response.StatusCode, actual)
			}
		})
	}
	response, err = http.Get(baseURL + "/api/v1/management/quota/warmup/settings")
	if err != nil {
		t.Fatal(err)
	}
	_ = response.Body.Close()
	if response.StatusCode != 401 {
		t.Fatalf("unauthenticated status %d", response.StatusCode)
	}
}
func warmupHTTPClient(t *testing.T, handler *Handler) (*http.Client, string) {
	t.Helper()
	server := httptest.NewServer(handler.Router())
	t.Cleanup(server.Close)
	jar, _ := cookiejar.New(nil)
	client := &http.Client{Jar: jar}
	response, err := client.Post(server.URL+"/api/auth/login", "application/json", strings.NewReader(`{"password":"management-secret"}`))
	if err != nil {
		t.Fatal(err)
	}
	_ = response.Body.Close()
	if response.StatusCode != 200 {
		t.Fatalf("login %d", response.StatusCode)
	}
	return client, server.URL
}

func TestWarmupOffAndModelScopedRefusals(t *testing.T) {
	handler := newWarmupHandler(t, &warmupFixture{})
	policy := warmup.DefaultPolicy()
	policy.Model = "claude-haiku-test"
	if err := handler.repo.WriteWarmupPolicy(context.Background(), "default", "provider", "claude", &policy, time.Now().UnixMilli()); err != nil {
		t.Fatal(err)
	}
	fixtureReading, err := handler.repo.GetLatestQuotaSnapshots(context.Background(), []string{"exact-claude"})
	if err != nil || len(fixtureReading) != 0 {
		t.Fatal("unexpected prior reading")
	}
	if err = handler.runCredentialWarmupRound(context.Background()); err != nil {
		t.Fatal(err)
	}
	fixtureReading, err = handler.repo.GetLatestQuotaSnapshots(context.Background(), []string{"exact-claude"})
	if err != nil || len(fixtureReading) != 0 {
		t.Fatal("off read a provider")
	}
}

func TestWarmupIdentityReplacementRevokesVerification(t *testing.T) {
	handler := newWarmupHandler(t, &warmupFixture{})
	client, _ := handler.capabilityClient(context.Background())
	file, _ := handler.warmupFile(context.Background(), client, "exact-claude")
	state := warmup.State{CredentialID: handler.warmupCredentialIdentity(file), Provider: "claude", IsProtocolVerified: true, VerifiedModel: "claude-haiku-test"}
	if err := handler.repo.WriteWarmupState(context.Background(), "default", file.AuthIndex, state, time.Now().UnixMilli()); err != nil {
		t.Fatal(err)
	}
	file.Account = "another-upstream-account"
	credential, err := handler.warmupCredential(context.Background(), client, file, false)
	if err != nil || credential.State.IsProtocolVerified {
		t.Fatalf("replacement retained verification %+v %v", credential, err)
	}
}

func TestWarmupDailySkippedTaskIsNotQueued(t *testing.T) {
	fixture := &warmupFixture{isActive: true}
	handler := newWarmupHandler(t, fixture)
	now := time.Now().UTC()
	handler.nowFn = func() time.Time { return now }
	policy := warmup.DefaultPolicy()
	policy.Model = "claude-haiku-test"
	policy.IsDailyEnabled = true
	policy.DailyTime = now.Format("15:04")
	if err := handler.repo.WriteWarmupPolicy(context.Background(), "default", "provider", "claude", &policy, now.UnixMilli()); err != nil {
		t.Fatal(err)
	}
	client, _ := handler.capabilityClient(context.Background())
	file, _ := handler.warmupFile(context.Background(), client, "exact-claude")
	state := warmup.State{CredentialID: handler.warmupCredentialIdentity(file), Provider: "claude", IsProtocolVerified: true, VerifiedModel: policy.Model}
	if err := handler.repo.WriteWarmupState(context.Background(), "default", file.AuthIndex, state, now.UnixMilli()); err != nil {
		t.Fatal(err)
	}
	if err := handler.runCredentialWarmupRound(context.Background()); err != nil {
		t.Fatal(err)
	}
	state, _ = handler.repo.ReadWarmupState(context.Background(), "default", file.AuthIndex)
	if state.DailyKey != warmup.DailyKey(policy.DailyTime, now) {
		t.Fatal("running daily task not consumed")
	}
	fixture.mu.Lock()
	fixture.isActive = false
	fixture.mu.Unlock()
	now = now.Add(time.Minute)
	if err := handler.runCredentialWarmupRound(context.Background()); err != nil {
		t.Fatal(err)
	}
	fixture.mu.Lock()
	sends := fixture.sends
	fixture.mu.Unlock()
	if sends != 0 {
		t.Fatalf("queued skipped task consumed %d", sends)
	}
}

func TestWarmupDemoRefusesDirectOperationAdapters(t *testing.T) {
	handler := newWarmupHandler(t, &warmupFixture{})
	handler.cfg.IsDemoMode = true
	if _, err := handler.executeWarmup(context.Background(), "exact-claude", "manual-demo-test", "revision", true); err == nil || err.Error() != "demo_operation_refused" {
		t.Fatalf("demo execution: %v", err)
	}
	if _, err := handler.saveWarmupSettings(context.Background(), warmup.PolicyWrite{IsConfirmed: true}); err == nil || err.Error() != "demo_operation_refused" {
		t.Fatalf("demo policy: %v", err)
	}
	if _, err := handler.saveWarmupCredential(context.Background(), "exact-claude", warmup.CredentialWrite{IsConfirmed: true}); err == nil || err.Error() != "demo_operation_refused" {
		t.Fatalf("demo credential: %v", err)
	}
}

func TestWarmupRevisionIgnoresTrafficButBindsPolicy(t *testing.T) {
	handler := newWarmupHandler(t, &warmupFixture{})
	client, _ := handler.capabilityClient(context.Background())
	file, _ := handler.warmupFile(context.Background(), client, "exact-claude")
	before, err := handler.warmupCredential(context.Background(), client, file, false)
	if err != nil {
		t.Fatal(err)
	}
	file.Success++
	file.Failed++
	file.StatusMessage = "fresh operational status"
	file.LastRefresh = json.RawMessage(`"2099-01-01T00:00:00Z"`)
	after, err := handler.warmupCredential(context.Background(), client, file, false)
	if err != nil || before.Revision != after.Revision {
		t.Fatalf("traffic invalidated confirmation: %v", err)
	}
	file.Disabled = true
	after, err = handler.warmupCredential(context.Background(), client, file, false)
	if err != nil || before.Revision == after.Revision {
		t.Fatalf("disablement failed to bind revision: %v", err)
	}
}

func TestWarmupIdentityNeverExposesOpaqueAccount(t *testing.T) {
	handler := newWarmupHandler(t, &warmupFixture{})
	client, _ := handler.capabilityClient(context.Background())
	file, _ := handler.warmupFile(context.Background(), client, "exact-claude")
	const secretMarker = "opaque-account-secret-for-test"
	file.Account = secretMarker
	credential, err := handler.warmupCredential(context.Background(), client, file, false)
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(credential)
	if strings.Contains(string(raw), secretMarker) || strings.Contains(handler.warmupPolicyTarget(file), secretMarker) || !strings.HasPrefix(credential.State.CredentialID, "hmac:") {
		t.Fatal("identity projection exposed account material")
	}
	if err = handler.repo.WriteWarmupState(context.Background(), "default", file.AuthIndex, credential.State, time.Now().UnixMilli()); err != nil {
		t.Fatal(err)
	}
	var stored string
	if err = handler.repo.SQL().QueryRowContext(context.Background(), `SELECT document_json FROM credential_warmup_state WHERE auth_index=?`, file.AuthIndex).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(stored, secretMarker) {
		t.Fatal("state persisted account material")
	}
}

func TestWarmupResetBoundaryDoesNotWaitForFiveMinuteAge(t *testing.T) {
	fixture := &warmupFixture{}
	handler := newWarmupHandler(t, fixture)
	now := time.Now().UTC()
	handler.nowFn = func() time.Time { return now }
	client, _ := handler.capabilityClient(context.Background())
	file, _ := handler.warmupFile(context.Background(), client, "exact-claude")
	expired := now.Add(-time.Second).UnixMilli()
	future := now.Add(3 * 24 * time.Hour).UnixMilli()
	zero := float64(0)
	observation := warmup.Observation{Provider: "claude", ObservedAtMS: now.Add(-time.Minute).UnixMilli(), PaidFallback: "disabled", FiveHour: warmup.Window{State: "active", UsedPercent: &zero, ResetAtMS: &expired, PeriodMS: warmup.FIVE_HOUR_MS}, Weekly: warmup.Window{State: "active", UsedPercent: &zero, ResetAtMS: &future, PeriodMS: warmup.WEEK_MS}}
	state := warmup.State{CredentialID: handler.warmupCredentialIdentity(file), Provider: "claude", IsProtocolVerified: true, VerifiedModel: "claude-haiku-test", Observation: &observation}
	if err := handler.repo.WriteWarmupState(context.Background(), "default", file.AuthIndex, state, now.UnixMilli()); err != nil {
		t.Fatal(err)
	}
	if err := handler.runCredentialWarmupRound(context.Background()); err != nil {
		t.Fatal(err)
	}
	fixture.mu.Lock()
	sends := fixture.sends
	fixture.mu.Unlock()
	if sends != 1 {
		t.Fatalf("fresh reset boundary waited: sends=%d", sends)
	}
}

func TestWarmupRestartDurablyMarksAbandonedExecutionUnknown(t *testing.T) {
	handler := newWarmupHandler(t, &warmupFixture{})
	ctx := context.Background()
	state := warmup.State{LastResult: &warmup.Result{RequestID: "abandoned-run", Status: "executing", Model: "claude-haiku-test"}, LastCycle: "cycle/0"}
	if err := handler.repo.WriteWarmupState(ctx, "default", "exact-claude", state, time.Now().UnixMilli()); err != nil {
		t.Fatal(err)
	}
	if err := handler.repo.WriteWarmupRun(ctx, "default", "exact-claude", *state.LastResult); err != nil {
		t.Fatal(err)
	}
	if err := handler.recoverWarmupExecution(ctx); err != nil {
		t.Fatal(err)
	}
	stored, _ := handler.repo.ReadWarmupState(ctx, "default", "exact-claude")
	receipt, _ := handler.repo.ReadWarmupRun(ctx, "default", "exact-claude", "abandoned-run")
	if stored.LastResult.Status != "uncertain" || receipt.Status != "uncertain" || stored.LastCycle != "cycle/0" {
		t.Fatal("restart did not retain uncertainty and suppression")
	}
}

func TestWarmupRevalidationRefusalDoesNotConsumeSchedule(t *testing.T) {
	for _, trigger := range []string{"reset", "daily"} {
		for _, refusal := range []string{"credential_read", "policy_change"} {
			t.Run(trigger+"/"+refusal, func(t *testing.T) {
				fixture := &warmupFixture{}
				handler := newWarmupHandler(t, fixture)
				now := time.Date(2026, 10, 13, 6, 0, 0, 0, time.UTC)
				handler.nowFn = func() time.Time { return now }
				ctx := context.Background()
				client, _ := handler.capabilityClient(ctx)
				file, _ := handler.warmupFile(ctx, client, "exact-claude")
				policy := warmup.DefaultPolicy()
				policy.Model = "claude-haiku-test"
				policy.ResetMode = "all"
				policy.IsDailyEnabled = trigger == "daily"
				if err := handler.repo.WriteWarmupPolicy(ctx, "default", "provider", "claude", &policy, now.UnixMilli()); err != nil {
					t.Fatal(err)
				}
				state := warmup.State{CredentialID: handler.warmupCredentialIdentity(file), Provider: "claude", IsProtocolVerified: true, VerifiedModel: policy.Model, LastCycle: "previous-cycle", DailyKey: "previous-day"}
				if err := handler.repo.WriteWarmupState(ctx, "default", file.AuthIndex, state, now.UnixMilli()); err != nil {
					t.Fatal(err)
				}
				fixture.mu.Lock()
				fixture.credentialReads = 0
				fixture.onCredentialRead = func(read int) bool {
					if read != 2 {
						return false
					}
					if refusal == "credential_read" {
						return true
					}
					changed := policy
					changed.IsDailyEnabled = false
					changed.ResetMode = "off"
					if err := handler.repo.WriteWarmupPolicy(ctx, "default", "provider", "claude", &changed, now.UnixMilli()); err != nil {
						t.Error(err)
					}
					return false
				}
				fixture.mu.Unlock()
				result, err := handler.executeWarmup(ctx, file.AuthIndex, "", "", false)
				if err != nil || result.Status != "failed" || result.Reason != "resource_conflict" {
					t.Fatalf("refusal: %+v %v", result, err)
				}
				refusedState, err := handler.repo.ReadWarmupState(ctx, "default", file.AuthIndex)
				if err != nil || refusedState.LastCycle != state.LastCycle || refusedState.DailyKey != state.DailyKey {
					t.Fatalf("unconsumed schedule lost: %+v %v", refusedState, err)
				}
				fixture.mu.Lock()
				if fixture.sends != 0 {
					t.Errorf("refusal sent %d consuming requests", fixture.sends)
				}
				fixture.onCredentialRead = nil
				fixture.mu.Unlock()
				if err := handler.repo.WriteWarmupPolicy(ctx, "default", "provider", "claude", &policy, now.UnixMilli()); err != nil {
					t.Fatal(err)
				}
				retry, err := handler.executeWarmup(ctx, file.AuthIndex, "", "", false)
				if err != nil || retry.Status != "pending" {
					t.Fatalf("schedule retry: %+v %v", retry, err)
				}
				fixture.mu.Lock()
				defer fixture.mu.Unlock()
				if fixture.sends != 1 {
					t.Fatalf("retry sent %d", fixture.sends)
				}
			})
		}
	}
}

type warmupLogWriter func([]byte) (int, error)

func (write warmupLogWriter) Write(payload []byte) (int, error) { return write(payload) }

func TestWarmupLoopRecoversOnLaterTickWithoutRestart(t *testing.T) {
	fixture := &warmupFixture{}
	handler := newWarmupHandler(t, fixture)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	state := warmup.State{Provider: "claude", LastResult: &warmup.Result{RequestID: "abandoned-live-run", Status: "executing", Model: "claude-haiku-test", StartedAtMS: handler.now().UnixMilli()}}
	if err := handler.persistWarmupResult(ctx, "exact-claude", state, *state.LastResult); err != nil {
		t.Fatal(err)
	}
	if _, err := handler.repo.SQL().ExecContext(ctx, `ALTER TABLE credential_warmup_state RENAME TO credential_warmup_state_held`); err != nil {
		t.Fatal(err)
	}
	logs := make(chan string, 8)
	handler.logger = slog.New(slog.NewJSONHandler(warmupLogWriter(func(payload []byte) (int, error) { logs <- string(payload); return len(payload), nil }), nil))
	ticks := make(chan time.Time)
	done := make(chan error, 1)
	go func() { done <- handler.runCredentialWarmupTicks(ctx, ticks) }()
	select {
	case err := <-done:
		t.Fatalf("transient recovery failure stopped loop: %v", err)
	case line := <-logs:
		var record map[string]any
		if json.Unmarshal([]byte(line), &record) != nil || record["error"] == nil {
			t.Fatalf("missing recovery diagnostic: %s", line)
		}
	case <-ctx.Done():
		t.Fatal("no recovery failure event")
	}
	if _, err := handler.repo.SQL().ExecContext(ctx, `ALTER TABLE credential_warmup_state_held RENAME TO credential_warmup_state`); err != nil {
		t.Fatal(err)
	}
	entered := make(chan struct{}, 1)
	fixture.mu.Lock()
	fixture.onCredentialRead = func(int) bool {
		select {
		case entered <- struct{}{}:
		default:
		}
		return false
	}
	fixture.mu.Unlock()
	select {
	case ticks <- handler.now():
	case <-ctx.Done():
		t.Fatal("loop did not accept recovery tick")
	}
	select {
	case <-entered:
	case <-done:
		t.Fatal("loop stopped instead of resuming rounds")
	case <-ctx.Done():
		t.Fatal("no scheduled round after recovery")
	}
	result, err := handler.repo.ReadWarmupRun(ctx, "default", "exact-claude", state.LastResult.RequestID)
	if err != nil || result == nil || result.Status != "uncertain" {
		t.Fatalf("abandoned receipt not recovered: %+v %v", result, err)
	}
	cancel()
	if err := <-done; !errors.Is(err, context.Canceled) {
		t.Fatalf("shutdown: %v", err)
	}
}
