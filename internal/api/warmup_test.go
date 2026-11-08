package api

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"os"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/crypto"
	"github.com/oh-my-cpa/oh-my-cpa/internal/domain"
	"github.com/oh-my-cpa/oh-my-cpa/internal/warmup"
)

type warmupFixture struct {
	provider      string
	models        []string
	onVerify      func(name, authIndex, model string)
	verifyStatus  int
	verifyReason  string
	isTimedOut    bool
	isActive      bool
	resetAt       time.Time
	mu            sync.Mutex
	sends         int
	usageReads    int
	lastModel     string
	lastAuthIndex string
	entered       chan struct{}
	release       chan struct{}
}

func newWarmupHandler(t *testing.T, fixture *warmupFixture) *Handler {
	t.Helper()
	provider := fixture.provider
	if provider == "" {
		provider = "claude"
	}
	models := fixture.models
	if len(models) == 0 {
		if provider == "codex" {
			models = []string{"gpt-5.4", "gpt-5.4-mini"}
		} else {
			models = []string{"claude-haiku-4-5", "claude-sonnet-4-6"}
		}
	}
	modelItems := make([]map[string]string, 0, len(models))
	for _, m := range models {
		modelItems = append(modelItems, map[string]string{"id": m})
	}
	modelsJSON, _ := json.Marshal(map[string]any{"models": modelItems})

	server := newFakeCPA(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		switch request.URL.Path {
		case "/v8/management/credentials":
			_, _ = fmt.Fprintf(writer, `{"files":[{"id":"%s-file","name":"%s.json","type":"%s","provider":"%s","auth_index":"exact-%s","source":"file"}]}`, provider, provider, provider, provider, provider)
		case "/v8/management/credentials/models":
			_, _ = writer.Write(modelsJSON)
		case "/v8/management/credentials/verify":
			var payload struct {
				Name      string `json:"name"`
				AuthIndex string `json:"auth_index"`
				Model     string `json:"model"`
			}
			_ = json.NewDecoder(request.Body).Decode(&payload)
			fixture.mu.Lock()
			fixture.sends++
			fixture.lastModel = payload.Model
			fixture.lastAuthIndex = payload.AuthIndex
			isTimedOut := fixture.isTimedOut
			verifyStatus := fixture.verifyStatus
			verifyReason := fixture.verifyReason
			if verifyStatus == 0 && verifyReason == "" && !isTimedOut {
				fixture.isActive = true
				if fixture.resetAt.IsZero() {
					fixture.resetAt = time.Now().UTC().Add(5 * time.Hour)
				}
			}
			fixture.mu.Unlock()
			if fixture.onVerify != nil {
				fixture.onVerify(payload.Name, payload.AuthIndex, payload.Model)
			}
			if fixture.entered != nil {
				close(fixture.entered)
				select {
				case <-fixture.release:
				case <-request.Context().Done():
				}
			}
			if isTimedOut {
				writer.WriteHeader(http.StatusGatewayTimeout)
				_, _ = writer.Write([]byte(`{"error":"upstream timeout"}`))
				return
			}
			if verifyStatus != 0 || verifyReason != "" {
				status := verifyStatus
				if status == 0 {
					status = 429
				}
				reason := verifyReason
				if reason == "" {
					reason = "rate_limited"
				}
				_ = json.NewEncoder(writer).Encode(map[string]any{
					"verified":    false,
					"status_code": status,
					"reason":      reason,
					"model":       payload.Model,
				})
				return
			}
			_ = json.NewEncoder(writer).Encode(map[string]any{
				"verified":    true,
				"status_code": 200,
				"model":       payload.Model,
			})
		case "/v8/management/requests/api-call":
			var payload struct {
				AuthIndex string `json:"auth_index"`
				URL       string `json:"url"`
			}
			_ = json.NewDecoder(request.Body).Decode(&payload)
			if payload.URL == "https://api.anthropic.com/api/oauth/profile" {
				_, _ = writer.Write([]byte(`{"status_code":200,"body":{"account":{"has_claude_max":true}}}`))
				return
			}
			if strings.HasPrefix(payload.URL, "https://api.anthropic.com/api/oauth/usage") || payload.URL == "https://chatgpt.com/backend-api/wham/usage" {
				fixture.mu.Lock()
				if !strings.Contains(payload.URL, "cedar_ember") {
					fixture.usageReads++
				}
				isActive := fixture.isActive
				resetAt := fixture.resetAt
				fixture.mu.Unlock()
				if resetAt.IsZero() {
					resetAt = time.Now().UTC().Add(5 * time.Hour)
				}
				if provider == "codex" {
					var fiveReset, weeklyReset any
					if isActive {
						fiveReset = resetAt.Unix()
						weeklyReset = resetAt.Add(7 * 24 * time.Hour).Unix()
					}
					body := map[string]any{
						"plan_type": "plus",
						"rate_limit": map[string]any{
							"allowed":       true,
							"limit_reached": false,
							"primary_window": map[string]any{
								"used_percent":         0,
								"limit_window_seconds": 18000,
								"reset_at":             fiveReset,
							},
							"secondary_window": map[string]any{
								"used_percent":         0,
								"limit_window_seconds": 604800,
								"reset_at":             weeklyReset,
							},
						},
					}
					_ = json.NewEncoder(writer).Encode(map[string]any{"status_code": 200, "body": body})
					return
				}
				five, week := "null", "null"
				if isActive {
					five = `{"utilization":2,"resets_at":"` + resetAt.UTC().Format(time.RFC3339) + `"}`
					week = `{"utilization":5,"resets_at":"` + resetAt.Add(7*24*time.Hour).UTC().Format(time.RFC3339) + `"}`
				}
				_ = json.NewEncoder(writer).Encode(map[string]any{
					"status_code": 200,
					"body":        json.RawMessage(`{"five_hour":` + five + `,"seven_day":` + week + `,"extra_usage":{"is_enabled":true}}`),
				})
				return
			}
			_, _ = writer.Write([]byte(`{"status_code":404,"body":{}}`))
		default:
			writer.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(server.Close)

	handler := testHandler(t, "")
	handler.repo.Timezone().Apply(time.UTC)
	cipher, err := crypto.New("01234567890123456789012345678901")
	if err != nil {
		t.Fatal(err)
	}
	ciphertext, nonce, err := cipher.Encrypt([]byte("management-secret"))
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 10, 13, 6, 0, 0, 0, time.UTC)
	handler.nowFn = func() time.Time { return now }
	if err = handler.repo.UpsertInstance(context.Background(), domain.CPAInstance{
		ID:                      "default",
		Name:                    "Default",
		BaseURL:                 server.URL,
		UsageAddr:               strings.TrimPrefix(server.URL, "http://"),
		ManagementKeyCiphertext: ciphertext,
		ManagementKeyNonce:      nonce,
		CreatedAt:               now,
		UpdatedAt:               now,
	}); err != nil {
		t.Fatal(err)
	}
	return handler
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
	if response.StatusCode != http.StatusOK {
		t.Fatalf("login %d", response.StatusCode)
	}
	return client, server.URL
}

func TestWarmupHandlerCertifiesWireCorpus(t *testing.T) {
	raw, err := os.ReadFile("../../scripts/acceptance/contracts/warmup.json")
	if err != nil {
		t.Fatal(err)
	}
	var corpus struct {
		Version int            `json:"version"`
		State   map[string]any `json:"state"`
		Run     map[string]any `json:"run"`
		Cases   []struct {
			ID       string          `json:"id"`
			Body     json.RawMessage `json:"body"`
			Status   int             `json:"status"`
			Response map[string]any  `json:"response"`
		} `json:"cases"`
	}
	if err = json.Unmarshal(raw, &corpus); err != nil || corpus.Version != 1 {
		t.Fatalf("invalid corpus: %v", err)
	}

	var clock atomic.Int64
	baseTime := time.Date(2026, 10, 13, 6, 0, 0, 0, time.UTC)
	clock.Store(baseTime.UnixMilli())
	fixture := &warmupFixture{
		onVerify: func(_, _, _ string) {
			clock.Add(100)
		},
	}
	handler := newWarmupHandler(t, fixture)
	handler.nowFn = func() time.Time { return time.UnixMilli(clock.Load()).UTC() }

	task := warmup.Task{
		ID:        "t_wire_test",
		Name:      "claude.json · 窗口重置后 (5h)",
		Enabled:   true,
		Provider:  "claude",
		AuthIndex: "exact-claude",
		Account:   "claude.json",
		Model:     "",
		Trigger:   warmup.Trigger{Kind: "window", Window: "five_hour"},
		CreatedAt: "2026-10-13T06:00:00Z",
		UpdatedAt: "2026-10-13T06:00:00Z",
	}
	if err := handler.repo.WriteWarmupTask(context.Background(), "default", task, baseTime.UnixMilli()); err != nil {
		t.Fatal(err)
	}

	caller, baseURL := warmupHTTPClient(t, handler)
	response, err := caller.Get(baseURL + "/api/v1/management/quota/warmup/settings")
	if err != nil {
		t.Fatal(err)
	}
	var actualState map[string]any
	_ = json.NewDecoder(response.Body).Decode(&actualState)
	_ = response.Body.Close()
	if !reflect.DeepEqual(actualState, corpus.State) {
		t.Fatalf("state projection differs\nactual=%#v\nexpected=%#v", actualState, corpus.State)
	}

	runResp, err := caller.Post(baseURL+"/api/v1/management/quota/warmup/tasks/t_wire_test/run", "application/json", nil)
	if err != nil {
		t.Fatal(err)
	}
	var actualRunResp map[string]any
	_ = json.NewDecoder(runResp.Body).Decode(&actualRunResp)
	_ = runResp.Body.Close()
	if runResp.StatusCode != http.StatusOK {
		t.Fatalf("unexpected run status: %d", runResp.StatusCode)
	}
	actualRun, _ := actualRunResp["run"].(map[string]any)
	actualRun["id"] = "r_wire_test"
	if !reflect.DeepEqual(actualRun, corpus.Run) {
		t.Fatalf("run projection differs\nactual=%#v\nexpected=%#v", actualRun, corpus.Run)
	}

	for _, entry := range corpus.Cases {
		t.Run(entry.ID, func(t *testing.T) {
			resp, err := caller.Post(baseURL+"/api/v1/management/quota/warmup/tasks", "application/json", bytes.NewReader(entry.Body))
			if err != nil {
				t.Fatal(err)
			}
			defer resp.Body.Close()
			var actual map[string]any
			_ = json.NewDecoder(resp.Body).Decode(&actual)
			if resp.StatusCode != entry.Status || !reflect.DeepEqual(actual, entry.Response) {
				t.Fatalf("status=%d body=%v; want %d %v", resp.StatusCode, actual, entry.Status, entry.Response)
			}
		})
	}

	unauthResp, err := http.Get(baseURL + "/api/v1/management/quota/warmup/settings")
	if err != nil {
		t.Fatal(err)
	}
	_ = unauthResp.Body.Close()
	if unauthResp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("unauthenticated status %d", unauthResp.StatusCode)
	}
}

func TestWarmupTaskLifecycleAndManualExecution(t *testing.T) {
	fixture := &warmupFixture{provider: "claude", isActive: true}
	handler := newWarmupHandler(t, fixture)
	caller, baseURL := warmupHTTPClient(t, handler)

	createBody := `{"name":"","enabled":true,"provider":"claude","auth_index":"exact-claude","account":"claude.json","model":"","trigger":{"kind":"daily","time":"08:55","time_zone":"UTC"}}`
	resp, err := caller.Post(baseURL+"/api/v1/management/quota/warmup/tasks", "application/json", strings.NewReader(createBody))
	if err != nil {
		t.Fatal(err)
	}
	var state warmup.StateView
	_ = json.NewDecoder(resp.Body).Decode(&state)
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusCreated || len(state.Tasks) != 1 {
		t.Fatalf("create status=%d tasks=%+v", resp.StatusCode, state.Tasks)
	}
	task := state.Tasks[0]
	if task.Name != "claude.json · 08:55" || state.Next[task.ID] == nil || *state.Next[task.ID] != "2026-10-13T08:55:00.000Z" {
		t.Fatalf("unexpected created task or next schedule: task=%+v next=%v", task, state.Next[task.ID])
	}

	// Update task to fixed interval
	updateBody := `{"name":"Custom Every","enabled":true,"provider":"claude","auth_index":"exact-claude","account":"claude.json","model":"claude-sonnet-4-6","trigger":{"kind":"every","hours":5,"anchor":"2026-10-13T06:00:00Z"}}`
	req, _ := http.NewRequest(http.MethodPut, baseURL+"/api/v1/management/quota/warmup/tasks/"+task.ID, strings.NewReader(updateBody))
	req.Header.Set("Content-Type", "application/json")
	resp, err = caller.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	_ = json.NewDecoder(resp.Body).Decode(&state)
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusOK || state.Tasks[0].Name != "Custom Every" || state.Tasks[0].Model != "claude-sonnet-4-6" {
		t.Fatalf("update failed: status=%d task=%+v", resp.StatusCode, state.Tasks)
	}

	// Manual trigger sends immediately via CPA VerifyAuthFile even when window is active and extra_usage is enabled
	resp, err = caller.Post(baseURL+"/api/v1/management/quota/warmup/tasks/"+task.ID+"/run", "application/json", nil)
	if err != nil {
		t.Fatal(err)
	}
	var runOut warmup.RunResponse
	_ = json.NewDecoder(resp.Body).Decode(&runOut)
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusOK || runOut.Run.Outcome != "ok" || runOut.Run.Source != "manual" || runOut.Run.Model != "claude-sonnet-4-6" {
		t.Fatalf("manual run failed: status=%d run=%+v", resp.StatusCode, runOut.Run)
	}
	fixture.mu.Lock()
	if fixture.sends != 1 || fixture.lastModel != "claude-sonnet-4-6" || fixture.lastAuthIndex != "exact-claude" {
		t.Fatalf("unexpected verify call: sends=%d model=%s auth=%s", fixture.sends, fixture.lastModel, fixture.lastAuthIndex)
	}
	fixture.mu.Unlock()

	// Delete task
	req, _ = http.NewRequest(http.MethodDelete, baseURL+"/api/v1/management/quota/warmup/tasks/"+task.ID, nil)
	resp, err = caller.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	_ = json.NewDecoder(resp.Body).Decode(&state)
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusOK || len(state.Tasks) != 0 {
		t.Fatalf("delete failed: status=%d tasks=%+v", resp.StatusCode, state.Tasks)
	}
}

func TestWarmupConcurrentManualRunReturnsConflict(t *testing.T) {
	fixture := &warmupFixture{
		entered:    make(chan struct{}),
		release:    make(chan struct{}),
		isTimedOut: true,
	}
	handler := newWarmupHandler(t, fixture)
	ctx := context.Background()
	state, err := handler.saveWarmupTask(ctx, "", warmup.TaskInput{
		Enabled:   true,
		Provider:  "claude",
		AuthIndex: "exact-claude",
		Trigger:   warmup.Trigger{Kind: "window", Window: "five_hour"},
	})
	if err != nil || len(state.Tasks) != 1 {
		t.Fatalf("save task: %v", err)
	}
	taskID := state.Tasks[0].ID

	done := make(chan warmup.RunResponse, 1)
	go func() {
		res, _ := handler.triggerWarmupTask(ctx, taskID)
		done <- res
	}()
	<-fixture.entered

	if _, err := handler.triggerWarmupTask(ctx, taskID); err != errWarmupTaskBusy {
		t.Fatalf("expected busy conflict, got %v", err)
	}
	close(fixture.release)
	res := <-done
	if res.Run.Outcome != "unknown" {
		t.Fatalf("expected unknown outcome on gateway timeout, got %+v", res.Run)
	}
}

func TestWarmupWindowTriggerIdleAndResetGrace(t *testing.T) {
	fixture := &warmupFixture{provider: "claude", isActive: false}
	handler := newWarmupHandler(t, fixture)
	ctx := context.Background()
	now := time.Date(2026, 10, 13, 6, 15, 0, 0, time.UTC)
	handler.nowFn = func() time.Time { return now }

	state, err := handler.saveWarmupTask(ctx, "", warmup.TaskInput{
		Enabled:   true,
		Provider:  "claude",
		AuthIndex: "exact-claude",
		Trigger:   warmup.Trigger{Kind: "window", Window: "five_hour"},
	})
	if err != nil {
		t.Fatal(err)
	}
	taskID := state.Tasks[0].ID

	// Round 1: No snapshot yet -> refreshes quota (idle window), fires once with idle reset_key
	resetTarget := now.Add(5 * time.Hour)
	fixture.mu.Lock()
	fixture.resetAt = resetTarget
	fixture.mu.Unlock()

	if err := handler.runCredentialWarmupRound(ctx); err != nil {
		t.Fatal(err)
	}
	fixture.mu.Lock()
	if fixture.sends != 1 || fixture.lastModel != "claude-haiku-4-5" {
		t.Fatalf("expected 1 auto-model send on idle window, got sends=%d model=%s", fixture.sends, fixture.lastModel)
	}
	fixture.mu.Unlock()

	// Round 2 at +30s: Does not re-fire in the same idle hour or before POST_SEND_SETTLE
	now = now.Add(30 * time.Second)
	if err := handler.runCredentialWarmupRound(ctx); err != nil {
		t.Fatal(err)
	}
	fixture.mu.Lock()
	if fixture.sends != 1 {
		t.Fatalf("unexpected duplicate send at +30s: %d", fixture.sends)
	}
	fixture.mu.Unlock()

	// Round 3 at +65s (after POST_SEND_SETTLE): refreshes quota to observe new active resets_at, records LastReset, does not fire
	now = now.Add(35 * time.Second)
	if err := handler.runCredentialWarmupRound(ctx); err != nil {
		t.Fatal(err)
	}
	marks, err := handler.repo.ReadWarmupMarks(ctx, "default", taskID)
	if err != nil || marks.LastReset != warmup.FormatISO(resetTarget) {
		t.Fatalf("expected LastReset=%s, got %+v (err=%v)", warmup.FormatISO(resetTarget), marks, err)
	}
	fixture.mu.Lock()
	if fixture.sends != 1 {
		t.Fatalf("unexpected send while window active: %d", fixture.sends)
	}
	fixture.mu.Unlock()

	// Round 4 at resetTarget + 10s (before 30s grace): refreshes quota, does not fire yet
	nextReset := resetTarget.Add(5 * time.Hour)
	fixture.mu.Lock()
	fixture.resetAt = nextReset
	fixture.mu.Unlock()
	now = resetTarget.Add(10 * time.Second)
	// Keep snapshot before resetTarget so we test the 30s grace on resetTarget first
	if err := handler.runCredentialWarmupRound(ctx); err != nil {
		t.Fatal(err)
	}

	// Simulate window still reporting resetTarget until resetTarget + 31s
	marks.LastReset = resetTarget.Format(time.RFC3339)
	_ = handler.repo.WriteWarmupMarks(ctx, "default", taskID, marks, now.UnixMilli())
	account := &warmup.CatalogAccount{
		AuthIndex:  "exact-claude",
		SnapshotAt: warmup.FormatISO(resetTarget.Add(-time.Minute)),
		Windows: []warmup.QuotaWindow{
			{ID: "five_hour", Label: "5h", ResetsAt: resetTarget.Format(time.RFC3339)},
		},
	}
	dueBeforeGrace := warmup.CurrentWindowDue(state.Tasks[0], account, marks, resetTarget.Add(10*time.Second))
	if dueBeforeGrace == nil || dueBeforeGrace.At != warmup.FormatISO(resetTarget.Add(warmup.WINDOW_GRACE)) {
		t.Fatalf("expected due at resetTarget+30s, got %+v", dueBeforeGrace)
	}
}

func TestWarmupDailyAndEveryCatchup(t *testing.T) {
	fixture := &warmupFixture{provider: "codex"}
	handler := newWarmupHandler(t, fixture)
	ctx := context.Background()
	createdAt := time.Date(2026, 10, 13, 6, 0, 0, 0, time.UTC)
	now := createdAt
	handler.nowFn = func() time.Time { return now }

	state, err := handler.saveWarmupTask(ctx, "", warmup.TaskInput{
		Enabled:   true,
		Provider:  "codex",
		AuthIndex: "exact-codex",
		Trigger:   warmup.Trigger{Kind: "daily", Time: "08:00", TimeZone: "UTC"},
	})
	if err != nil {
		t.Fatal(err)
	}
	taskID := state.Tasks[0].ID

	// Jump to 08:05 (5 minutes past 08:00 -> > 90s lag -> source = "catchup")
	now = time.Date(2026, 10, 13, 8, 5, 0, 0, time.UTC)
	if err := handler.runCredentialWarmupRound(ctx); err != nil {
		t.Fatal(err)
	}
	runs, err := handler.repo.ListWarmupRuns(ctx, "default")
	if err != nil || len(runs) != 1 {
		t.Fatalf("expected 1 catchup run, got %+v (err=%v)", runs, err)
	}
	if runs[0].TaskID != taskID || runs[0].Outcome != "ok" || runs[0].Source != "catchup" || runs[0].Model != "gpt-5.4-mini" {
		t.Fatalf("unexpected catchup run: %+v", runs[0])
	}

	// Second tick at 08:06 must not replay the same daily slot
	now = time.Date(2026, 10, 13, 8, 6, 0, 0, time.UTC)
	if err := handler.runCredentialWarmupRound(ctx); err != nil {
		t.Fatal(err)
	}
	fixture.mu.Lock()
	if fixture.sends != 1 {
		t.Fatalf("daily slot replayed: sends=%d", fixture.sends)
	}
	fixture.mu.Unlock()
}

func TestWarmupRestartRecoversInterruptedRuns(t *testing.T) {
	handler := newWarmupHandler(t, &warmupFixture{})
	ctx := context.Background()
	run := warmup.Run{
		ID:        "r_interrupted",
		TaskID:    "t_1",
		TaskName:  "Interrupted Task",
		At:        "2026-10-13T06:00:00Z",
		Outcome:   "running",
		Source:    "manual",
		Provider:  "claude",
		AuthIndex: "exact-claude",
		Account:   "claude.json",
		Model:     "claude-haiku-4-5",
	}
	if err := handler.repo.WriteWarmupRun(ctx, "default", run); err != nil {
		t.Fatal(err)
	}
	state, err := handler.warmupState(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(state.Runs) != 1 || state.Runs[0].Outcome != "unknown" || state.Runs[0].Message != "interrupted_by_restart" {
		t.Fatalf("interrupted run was not recovered: %+v", state.Runs)
	}
}

func TestWarmupDemoRefusesDirectOperationAdapters(t *testing.T) {
	handler := newWarmupHandler(t, &warmupFixture{})
	handler.cfg.IsDemoMode = true
	ctx := context.Background()
	if _, err := handler.saveWarmupTask(ctx, "", warmup.TaskInput{
		Enabled:   true,
		Provider:  "claude",
		AuthIndex: "exact-claude",
		Trigger:   warmup.Trigger{Kind: "window", Window: "five_hour"},
	}); err == nil || err.Error() != "demo_operation_refused" {
		t.Fatalf("demo saveWarmupTask: %v", err)
	}
	if _, err := handler.removeWarmupTask(ctx, "t_1"); err == nil || err.Error() != "demo_operation_refused" {
		t.Fatalf("demo removeWarmupTask: %v", err)
	}
	if _, err := handler.triggerWarmupTask(ctx, "t_1"); err == nil || err.Error() != "demo_operation_refused" {
		t.Fatalf("demo triggerWarmupTask: %v", err)
	}
}
