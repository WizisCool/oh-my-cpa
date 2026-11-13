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
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/management"
	"github.com/oh-my-cpa/oh-my-cpa/internal/crypto"
	"github.com/oh-my-cpa/oh-my-cpa/internal/domain"
	"github.com/oh-my-cpa/oh-my-cpa/internal/pricing"
	"github.com/oh-my-cpa/oh-my-cpa/internal/warmup"
)

type warmupFixture struct {
	provider string
	models   []string
	// oauthProvider is the login portal CPA reports for the credential, when it reports one.
	oauthProvider string
	// credentialFile is what CPA serves when the credential file is downloaded (its model_aliases).
	credentialFile string
	// globalAliases is CPA's oauth model-alias map as JSON.
	globalAliases     string
	onVerify          func(name, authIndex, model string)
	verifyStatus      int
	verifyReason      string
	isTimedOut        bool
	isActive          bool
	isSlidingWhenIdle bool
	isDisabled        bool
	isUnavailable     bool
	usageHTTPStatus   int
	agFiveRemaining   float64
	agWeeklyRemaining float64
	agFiveResetAt     time.Time
	agWeeklyResetAt   time.Time
	clockFn           func() time.Time
	resetAt           time.Time
	mu                sync.Mutex
	sends             int
	modelReads        int
	usageReads        int
	lastModel         string
	lastAuthIndex     string
	entered           chan struct{}
	release           chan struct{}
}

func newWarmupHandler(t *testing.T, fixture *warmupFixture) *Handler {
	t.Helper()
	provider := fixture.provider
	if provider == "" {
		provider = "claude"
	}
	models := fixture.models
	if len(models) == 0 {
		switch provider {
		case "codex":
			models = []string{"gpt-5.4", "gpt-5.4-mini"}
		case "antigravity":
			models = []string{"gemini-3.8-flash", "gemini-4-carbon"}
		default:
			models = []string{"claude-haiku-4-5", "claude-sonnet-4-6"}
		}
	}
	modelItems := make([]map[string]string, 0, len(models))
	for _, m := range models {
		modelItems = append(modelItems, map[string]string{"id": m})
	}
	modelsJSON, _ := json.Marshal(map[string]any{"models": modelItems})
	var handler *Handler
	currentClock := func() time.Time {
		if fixture.clockFn != nil {
			return fixture.clockFn().UTC()
		}
		if handler != nil {
			return handler.now().UTC()
		}
		return time.Now().UTC()
	}

	server := newFakeCPA(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		switch request.URL.Path {
		case "/v8/management/credentials":
			fixture.mu.Lock()
			isDisabled := fixture.isDisabled
			isUnavailable := fixture.isUnavailable
			fixture.mu.Unlock()
			projectField := ""
			if provider == "antigravity" {
				projectField = `,"project_id":"ag-test-project"`
			}
			_, _ = fmt.Fprintf(writer, `{"files":[{"id":"%s-file","name":"%s.json","type":"%s","provider":"%s","oauth_provider":"%s","auth_index":"exact-%s","source":"file","disabled":%t,"unavailable":%t%s}]}`, provider, provider, provider, provider, fixture.oauthProvider, provider, isDisabled, isUnavailable, projectField)
		case "/v8/management/credentials/models":
			fixture.mu.Lock()
			fixture.modelReads++
			fixture.mu.Unlock()
			_, _ = writer.Write(modelsJSON)
		case "/v8/management/credentials/verify":
			var payload struct {
				Name      string `json:"name"`
				AuthIndex string `json:"auth_index"`
				Model     string `json:"model"`
			}
			_ = json.NewDecoder(request.Body).Decode(&payload)
			now := currentClock()
			fixture.mu.Lock()
			fixture.sends++
			fixture.lastModel = payload.Model
			fixture.lastAuthIndex = payload.AuthIndex
			isTimedOut := fixture.isTimedOut
			verifyStatus := fixture.verifyStatus
			verifyReason := fixture.verifyReason
			if verifyStatus == 0 && verifyReason == "" && !isTimedOut {
				fixture.isActive = true
				if fixture.resetAt.IsZero() || !fixture.resetAt.After(now) {
					fixture.resetAt = now.Add(5 * time.Hour)
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
			if strings.Contains(payload.URL, "retrieveUserQuotaSummary") {
				fixture.mu.Lock()
				fixture.usageReads++
				status := fixture.usageHTTPStatus
				fiveRem := fixture.agFiveRemaining
				weekRem := fixture.agWeeklyRemaining
				fiveReset := fixture.agFiveResetAt
				weekReset := fixture.agWeeklyResetAt
				fixture.mu.Unlock()
				if status != 0 && status != http.StatusOK {
					_ = json.NewEncoder(writer).Encode(map[string]any{
						"status_code": status,
						"body":        map[string]any{"message": "upstream failure"},
					})
					return
				}
				now := currentClock()
				if fiveReset.IsZero() {
					fiveReset = now.Add(5 * time.Hour)
				}
				if weekReset.IsZero() {
					weekReset = now.Add(7 * 24 * time.Hour)
				}
				body := map[string]any{
					"groups": []map[string]any{{
						"displayName": "Gemini Models",
						"buckets": []map[string]any{
							{
								"bucketId":          "gemini-week",
								"displayName":       "Weekly Limit",
								"window":            "weekly",
								"remainingFraction": weekRem,
								"resetTime":         weekReset.UTC().Format(time.RFC3339),
							},
							{
								"bucketId":          "gemini-5h",
								"displayName":       "Five Hour Limit",
								"window":            "5h",
								"remainingFraction": fiveRem,
								"resetTime":         fiveReset.UTC().Format(time.RFC3339),
							},
						},
					}},
				}
				_ = json.NewEncoder(writer).Encode(map[string]any{"status_code": 200, "body": body})
				return
			}
			if strings.Contains(payload.URL, "loadCodeAssist") {
				_, _ = writer.Write([]byte(`{"status_code":200,"body":{"currentTier":{"id":"ultra-lite"}}}`))
				return
			}
			if strings.HasPrefix(payload.URL, "https://api.anthropic.com/api/oauth/usage") || payload.URL == "https://chatgpt.com/backend-api/wham/usage" {
				now := currentClock()
				fixture.mu.Lock()
				if !strings.Contains(payload.URL, "cedar_ember") {
					fixture.usageReads++
				}
				status := fixture.usageHTTPStatus
				isActive := fixture.isActive
				isSliding := fixture.isSlidingWhenIdle
				resetAt := fixture.resetAt
				if isActive && !resetAt.IsZero() && !resetAt.After(now) {
					isActive = false
					fixture.isActive = false
				}
				fixture.mu.Unlock()
				if status != 0 && status != http.StatusOK {
					_ = json.NewEncoder(writer).Encode(map[string]any{
						"status_code": status,
						"body":        map[string]any{"message": "upstream failure"},
					})
					return
				}
				if resetAt.IsZero() {
					resetAt = now.Add(5 * time.Hour)
				}
				if provider == "codex" {
					var fiveReset, weeklyReset any
					if isActive {
						fiveReset = resetAt.Unix()
						weeklyReset = resetAt.Add(7 * 24 * time.Hour).Unix()
					} else if isSliding {
						fiveReset = now.Add(5 * time.Hour).Unix()
						weeklyReset = now.Add(7 * 24 * time.Hour).Unix()
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
		case "/v8/management/credentials/download":
			if fixture.credentialFile == "" {
				writer.WriteHeader(http.StatusNotFound)
				return
			}
			_, _ = writer.Write([]byte(fixture.credentialFile))
		case "/v8/management/config/oauth/model-alias":
			if fixture.globalAliases == "" {
				writer.WriteHeader(http.StatusNotFound)
				return
			}
			_, _ = writer.Write([]byte(fixture.globalAliases))
		default:
			writer.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(server.Close)

	handler = testHandler(t, "")
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
		Name:      "claude.json 窗口重置后 (5h)",
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
	if task.Name != "claude.json (08:55)" || state.Next[task.ID] == nil || *state.Next[task.ID] != "2026-10-13T08:55:00.000Z" {
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

	// Clear run history for this task
	req, _ = http.NewRequest(http.MethodDelete, baseURL+"/api/v1/management/quota/warmup/runs?task_id="+task.ID, nil)
	resp, err = caller.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	state = warmup.StateView{}
	_ = json.NewDecoder(resp.Body).Decode(&state)
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusOK || len(state.Runs) != 0 || len(state.Tasks) != 1 {
		t.Fatalf("clear runs failed: status=%d runs=%+v", resp.StatusCode, state.Runs)
	}

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

func TestWarmupRefusesDisabledCredentialWithoutAskingCPAForModelsTwice(t *testing.T) {
	fixture := &warmupFixture{provider: "codex", isDisabled: true}
	handler := newWarmupHandler(t, fixture)
	caller, baseURL := warmupHTTPClient(t, handler)

	// A credential that lists no models is asked once, and the answer serves both the account
	// and the provider scan of every later catalog build.
	for range 2 {
		resp, err := caller.Get(baseURL + "/api/v1/management/quota/warmup/settings")
		if err != nil {
			t.Fatal(err)
		}
		_ = resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("settings status=%d", resp.StatusCode)
		}
	}
	fixture.mu.Lock()
	modelReads := fixture.modelReads
	fixture.mu.Unlock()
	if modelReads != 1 {
		t.Fatalf("model reads = %d, want 1", modelReads)
	}

	createBody := `{"name":"","enabled":true,"provider":"codex","auth_index":"exact-codex","account":"codex.json","model":"","trigger":{"kind":"window","window":"five_hour"}}`
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

	// A credential the operator turned off is reported as such instead of being woken up.
	resp, err = caller.Post(baseURL+"/api/v1/management/quota/warmup/tasks/"+state.Tasks[0].ID+"/run", "application/json", nil)
	if err != nil {
		t.Fatal(err)
	}
	var runOut warmup.RunResponse
	_ = json.NewDecoder(resp.Body).Decode(&runOut)
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusOK || runOut.Run.Outcome != "failed" || runOut.Run.Message != "credential_disabled" {
		t.Fatalf("disabled run status=%d run=%+v", resp.StatusCode, runOut.Run)
	}
	fixture.mu.Lock()
	sends := fixture.sends
	fixture.mu.Unlock()
	if sends != 0 {
		t.Fatalf("disabled credential received %d warmup requests", sends)
	}
}

func TestWarmupAutoModelRanksOAuthAliasesByTheirUpstream(t *testing.T) {
	// The operator's aliases are names of their own choosing: a provider-wide one renaming an
	// older full model, and one in the credential file pointing at the mini model. By name alone
	// "zeta" sorts first. Auto must judge each alias by the model it reaches, credential rules
	// before provider ones, and still send the alias, the name CPA routes.
	fixture := &warmupFixture{
		provider:       "codex",
		models:         []string{"gpt-5.2", "gpt-5.4", "zeta", "aaa"},
		globalAliases:  `{"codex":[{"name":"gpt-5.1","alias":"zeta"}]}`,
		credentialFile: `{"type":"codex","model_aliases":[{"name":"gpt-5.4-mini","alias":"aaa"}]}`,
	}
	handler := newWarmupHandler(t, fixture)
	caller, baseURL := warmupHTTPClient(t, handler)

	resp, err := caller.Get(baseURL + "/api/v1/management/quota/warmup/settings")
	if err != nil {
		t.Fatal(err)
	}
	var state warmup.StateView
	_ = json.NewDecoder(resp.Body).Decode(&state)
	_ = resp.Body.Close()
	var autoModel string
	for _, group := range state.Catalog.Providers {
		for _, account := range group.Accounts {
			if account.AuthIndex == "exact-codex" {
				autoModel = account.AutoModel
			}
		}
	}
	if autoModel != "aaa" {
		t.Fatalf("auto model = %q, want aaa (the alias of gpt-5.4-mini)", autoModel)
	}
}

func TestWarmupCatalogExcludesImageGenerationModels(t *testing.T) {
	fixture := &warmupFixture{provider: "codex", models: []string{"gpt-image-1", "gpt-5.4"}}
	handler := newWarmupHandler(t, fixture)
	caller, baseURL := warmupHTTPClient(t, handler)

	resp, err := caller.Get(baseURL + "/api/v1/management/quota/warmup/settings")
	if err != nil {
		t.Fatal(err)
	}
	var state warmup.StateView
	_ = json.NewDecoder(resp.Body).Decode(&state)
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusOK || state.Catalog == nil {
		t.Fatalf("settings status=%d catalog=%+v", resp.StatusCode, state.Catalog)
	}
	codex := state.Catalog.Providers[0]
	if len(codex.Accounts) != 1 {
		t.Fatalf("accounts = %+v", codex.Accounts)
	}
	// Auto would otherwise rank the image model first on its letters alone.
	if got := codex.Accounts[0].Models; !reflect.DeepEqual(got, []string{"gpt-5.4"}) {
		t.Fatalf("models = %v, want [gpt-5.4]", got)
	}
	if got := codex.Accounts[0].AutoModel; got != "gpt-5.4" {
		t.Fatalf("auto_model = %q, want gpt-5.4", got)
	}
}

func TestWarmupAutoPrefersTheCheapestPricedModel(t *testing.T) {
	// "turbo" reads as a light tier by name, and the price book is what says Luna is cheaper. The
	// free model is not the answer either: a zero rate is a model that never starts a window.
	fixture := &warmupFixture{provider: "codex", models: []string{"gpt-6.1-turbo", "gpt-6.1-luna", "codex-auto-review"}}
	handler := newWarmupHandler(t, fixture)
	ctx := context.Background()
	if _, err := handler.repo.ReplacePricingModels(ctx, map[string]string{
		"gpt-6.1-turbo":     "gpt-6.1-turbo",
		"gpt-6.1-luna":      "gpt-6.1-luna",
		"codex-auto-review": "codex-auto-review",
	}); err != nil {
		t.Fatal(err)
	}
	if err := handler.repo.UpsertModelPrices(ctx, []pricing.ModelPrice{
		{Model: "gpt-6.1-turbo", PromptPricePer1M: 2.5, CompletionPer1M: 15, PriceMultiplier: 1, Source: pricing.SourceManual},
		{Model: "gpt-6.1-luna", PromptPricePer1M: 0.2, CompletionPer1M: 1.2, PriceMultiplier: 1, Source: pricing.SourceManual},
		{Model: "codex-auto-review", PromptPricePer1M: 0, CompletionPer1M: 0, PriceMultiplier: 1, Source: pricing.SourceManual},
	}); err != nil {
		t.Fatal(err)
	}
	handler.SetPricing(pricing.NewService(handler.repo, nil, nil))
	caller, baseURL := warmupHTTPClient(t, handler)

	if got := warmupAutoModel(t, caller, baseURL); got != "gpt-6.1-luna" {
		t.Fatalf("auto_model = %q, want gpt-6.1-luna", got)
	}

	// A channel's own rate outranks the shared book for that provider.
	if err := handler.repo.UpsertChannelModelPrice(ctx, pricing.ModelPrice{Channel: "codex", Model: "gpt-6.1-turbo",
		PromptPricePer1M: 0, CompletionPer1M: 0.5, PriceMultiplier: 1, Source: pricing.SourceManual}); err != nil {
		t.Fatal(err)
	}
	handler.warmupRuntime.mu.Lock()
	handler.warmupRuntime.prices = nil
	handler.warmupRuntime.mu.Unlock()
	if got := warmupAutoModel(t, caller, baseURL); got != "gpt-6.1-turbo" {
		t.Fatalf("auto_model with a channel rate = %q, want gpt-6.1-turbo", got)
	}
}

// warmupAutoModel reads the Auto answer the settings endpoint reports for the fixture's credential.
func warmupAutoModel(t *testing.T, caller *http.Client, baseURL string) string {
	t.Helper()
	resp, err := caller.Get(baseURL + "/api/v1/management/quota/warmup/settings")
	if err != nil {
		t.Fatal(err)
	}
	var state warmup.StateView
	_ = json.NewDecoder(resp.Body).Decode(&state)
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusOK || state.Catalog == nil || len(state.Catalog.Providers) == 0 || len(state.Catalog.Providers[0].Accounts) != 1 {
		t.Fatalf("settings status=%d catalog=%+v", resp.StatusCode, state.Catalog)
	}
	return state.Catalog.Providers[0].Accounts[0].AutoModel
}

func TestWarmupCatalogReportsTheIssuingPortal(t *testing.T) {
	// A plugin that fronts several brands reports which login portal issued the credential, and the
	// catalogue has to carry it: the row's mark is drawn from the portal, not from the family.
	fixture := &warmupFixture{provider: "codex", oauthProvider: "codex-cn"}
	handler := newWarmupHandler(t, fixture)
	caller, baseURL := warmupHTTPClient(t, handler)

	resp, err := caller.Get(baseURL + "/api/v1/management/quota/warmup/settings")
	if err != nil {
		t.Fatal(err)
	}
	var state warmup.StateView
	_ = json.NewDecoder(resp.Body).Decode(&state)
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusOK || state.Catalog == nil || len(state.Catalog.Providers[0].Accounts) != 1 {
		t.Fatalf("settings status=%d catalog=%+v", resp.StatusCode, state.Catalog)
	}
	if got := state.Catalog.Providers[0].Accounts[0].OAuthProvider; got != "codex-cn" {
		t.Fatalf("oauth_provider = %q, want codex-cn", got)
	}
}

func TestWarmupClearRunsScope(t *testing.T) {
	fixture := &warmupFixture{provider: "claude"}
	handler := newWarmupHandler(t, fixture)
	caller, baseURL := warmupHTTPClient(t, handler)

	createBody := `{"name":"","enabled":true,"provider":"claude","auth_index":"exact-claude","account":"claude.json","model":"","trigger":{"kind":"every","hours":5,"anchor":"2026-10-13T06:00:00Z"}}`
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
	resp, err = caller.Post(baseURL+"/api/v1/management/quota/warmup/tasks/"+state.Tasks[0].ID+"/run", "application/json", nil)
	if err != nil {
		t.Fatal(err)
	}
	var runBody warmup.RunResponse
	_ = json.NewDecoder(resp.Body).Decode(&runBody)
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusOK || len(runBody.State.Runs) != 1 {
		t.Fatalf("manual run status=%d runs=%+v", resp.StatusCode, runBody.State.Runs)
	}

	// A selection that names no task must not widen into "every task".
	req, _ := http.NewRequest(http.MethodDelete, baseURL+"/api/v1/management/quota/warmup/runs?task_id=", nil)
	resp, err = caller.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("blank task_id status=%d, want 400", resp.StatusCode)
	}
	resp, err = caller.Get(baseURL + "/api/v1/management/quota/warmup/settings")
	if err != nil {
		t.Fatal(err)
	}
	_ = json.NewDecoder(resp.Body).Decode(&state)
	_ = resp.Body.Close()
	if len(state.Runs) != 1 {
		t.Fatalf("a refused clear removed runs: %+v", state.Runs)
	}

	// Without a selection the request means every task, which is what the settings drawer asks for.
	req, _ = http.NewRequest(http.MethodDelete, baseURL+"/api/v1/management/quota/warmup/runs", nil)
	resp, err = caller.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	state = warmup.StateView{}
	_ = json.NewDecoder(resp.Body).Decode(&state)
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusOK || len(state.Runs) != 0 {
		t.Fatalf("clear all status=%d runs=%+v", resp.StatusCode, state.Runs)
	}
}

func TestWarmupInFlightRunRefusesConcurrentRunAndDelete(t *testing.T) {
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
	// The run in flight writes its record when it ends, so its task cannot be deleted under it.
	if _, err := handler.removeWarmupTask(ctx, taskID); err != errWarmupTaskBusy {
		t.Fatalf("expected busy conflict on delete, got %v", err)
	}
	close(fixture.release)
	res := <-done
	if res.Run.Outcome != "unknown" {
		t.Fatalf("expected unknown outcome on gateway timeout, got %+v", res.Run)
	}
	// Once the run has ended, the task and its history go together.
	state, err = handler.removeWarmupTask(ctx, taskID)
	if err != nil || len(state.Tasks) != 0 || len(state.Runs) != 0 {
		t.Fatalf("delete after the run: tasks=%+v runs=%+v err=%v", state.Tasks, state.Runs, err)
	}
}

// A run acts on its task as it stands when the run starts, not as the round or the console read it
// a moment earlier: one changed since sends what it names now, one switched off since does not run
// on schedule, and one deleted since does not run at all.
func TestWarmupRunRereadsItsTask(t *testing.T) {
	fixture := &warmupFixture{}
	handler := newWarmupHandler(t, fixture)
	ctx := context.Background()
	input := warmup.TaskInput{
		Enabled:   true,
		Provider:  "claude",
		AuthIndex: "exact-claude",
		Trigger:   warmup.Trigger{Kind: "window", Window: "five_hour"},
	}
	state, err := handler.saveWarmupTask(ctx, "", input)
	if err != nil || len(state.Tasks) != 1 {
		t.Fatalf("save task: %v", err)
	}
	read := state.Tasks[0]
	client, err := handler.capabilityClient(ctx)
	if err != nil {
		t.Fatal(err)
	}
	catalog, files := handler.warmupCatalogWithFiles(ctx, client)
	sent := func() (int, string) {
		fixture.mu.Lock()
		defer fixture.mu.Unlock()
		return fixture.sends, fixture.lastModel
	}

	changed := input
	changed.Model = "claude-sonnet-4-6"
	if _, err := handler.saveWarmupTask(ctx, read.ID, changed); err != nil {
		t.Fatal(err)
	}
	run, err := handler.executeTaskRun(ctx, client, &catalog, files, read, "manual", "", "")
	if sends, model := sent(); err != nil || run.Model != "claude-sonnet-4-6" || sends != 1 || model != "claude-sonnet-4-6" {
		t.Fatalf("the changed task ran as read: run=%+v sends=%d model=%s err=%v", run, sends, model, err)
	}

	changed.Enabled = false
	if _, err := handler.saveWarmupTask(ctx, read.ID, changed); err != nil {
		t.Fatal(err)
	}
	if _, err := handler.executeTaskRun(ctx, client, &catalog, files, read, "schedule", "", ""); err != errWarmupTaskNotFound {
		t.Fatalf("a task switched off since it was read ran on schedule: %v", err)
	}

	if _, err := handler.removeWarmupTask(ctx, read.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := handler.executeTaskRun(ctx, client, &catalog, files, read, "manual", "", ""); err != errWarmupTaskNotFound {
		t.Fatalf("a deleted task ran: %v", err)
	}
	runs, err := handler.repo.ListWarmupRuns(ctx, warmupInstanceID)
	if sends, _ := sent(); err != nil || sends != 1 || len(runs) != 0 {
		t.Fatalf("a withdrawn task reached CPA or left a record: sends=%d runs=%+v err=%v", sends, runs, err)
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

	// Round 0: If the Claude provider read gate is paused for 2 minutes by another credential's 429,
	// the deferred read must not trigger a 5-minute warmup failure backoff; once the 2-minute pause
	// expires, the round reads quota and fires immediately.
	gate := handler.quotaReadGates.claudeGate()
	gate.mu.Lock()
	gate.pausedUntilMS = now.Add(QUOTA_RATE_LIMIT_PROVIDER_PAUSE).UnixMilli()
	gate.mu.Unlock()
	if err := handler.runCredentialWarmupRound(ctx); err != nil {
		t.Fatal(err)
	}
	fixture.mu.Lock()
	if fixture.sends != 0 || fixture.usageReads != 0 {
		t.Fatalf("expected deferred read during provider pause to skip upstream read and send, got sends=%d usageReads=%d", fixture.sends, fixture.usageReads)
	}
	fixture.mu.Unlock()

	// Round 1 at +2m01s (provider pause expired, well under the 5m failure backoff): refreshes quota and fires once.
	now = now.Add(QUOTA_RATE_LIMIT_PROVIDER_PAUSE + time.Second)
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

func TestWarmupCodexSlidingIdleAndCycleRolloverFiresOnSchedule(t *testing.T) {
	now := time.Date(2026, 11, 13, 11, 3, 0, 0, time.UTC)
	fixture := &warmupFixture{
		provider:          "codex",
		isSlidingWhenIdle: true,
		clockFn:           func() time.Time { return now },
	}
	handler := newWarmupHandler(t, fixture)
	handler.nowFn = func() time.Time { return now }
	ctx := context.Background()
	caller, baseURL := warmupHTTPClient(t, handler)

	state := postWarmupTaskWire(t, caller, baseURL, map[string]any{
		"enabled":    true,
		"provider":   "codex",
		"auth_index": "exact-codex",
		"trigger":    map[string]any{"kind": "window", "window": "five_hour"},
	})
	taskID := state.Tasks[0].ID

	// Round 1 at 11:03:00Z: reads initial snapshot (reset_at = 16:03:00Z, used_percent = 0) and records baseline.
	if err := handler.runCredentialWarmupRound(ctx); err != nil {
		t.Fatal(err)
	}
	fixture.mu.Lock()
	if fixture.sends != 0 || fixture.usageReads != 1 {
		t.Fatalf("round 1: sends=%d usageReads=%d, want 0 and 1", fixture.sends, fixture.usageReads)
	}
	fixture.mu.Unlock()

	// Round 2 at 11:04:00Z (+60s): confirmation read sees reset_at slid to 16:04:00Z -> fires immediately.
	now = now.Add(time.Minute)
	if err := handler.runCredentialWarmupRound(ctx); err != nil {
		t.Fatal(err)
	}
	lockedFirstReset := now.Add(5 * time.Hour)
	fixture.mu.Lock()
	if fixture.sends != 1 || fixture.lastModel != "gpt-5.4-mini" || fixture.usageReads != 2 {
		t.Fatalf("round 2: sends=%d model=%q usageReads=%d, want 1 gpt-5.4-mini and 2", fixture.sends, fixture.lastModel, fixture.usageReads)
	}
	fixture.mu.Unlock()
	codexSettingsAfterRound2 := getWarmupSettingsWire(t, caller, baseURL)
	if len(codexSettingsAfterRound2.Runs) != 1 || codexSettingsAfterRound2.Runs[0].TaskID != taskID || codexSettingsAfterRound2.Runs[0].Outcome != "ok" || codexSettingsAfterRound2.Runs[0].Source != "schedule" {
		t.Fatalf("expected recorded scheduled Codex run over HTTP, got %+v", codexSettingsAfterRound2.Runs)
	}

	// Round 3 at 11:05:05Z (after POST_SEND_SETTLE): reads locked reset_at (16:04:00Z) with 0% usage and confirms active cycle.
	now = now.Add(65 * time.Second)
	if err := handler.runCredentialWarmupRound(ctx); err != nil {
		t.Fatal(err)
	}
	fixture.mu.Lock()
	readsAfterSettle := fixture.usageReads
	fixture.mu.Unlock()
	if readsAfterSettle != 3 {
		t.Fatalf("expected 1 post-send settle read (total 3), got %d", readsAfterSettle)
	}
	codexSettingsAfterSettle := getWarmupSettingsWire(t, caller, baseURL)
	if gotNext := codexSettingsAfterSettle.Next[taskID]; gotNext == nil || *gotNext != warmup.FormatISO(lockedFirstReset.Add(warmup.WINDOW_GRACE)) {
		t.Fatalf("unexpected Codex HTTP next after settle: %v", gotNext)
	}

	// Mid-cycle ticks make no redundant quota reads and send nothing.
	for _, step := range []time.Duration{time.Minute, time.Hour, 2 * time.Hour} {
		now = now.Add(step)
		if err := handler.runCredentialWarmupRound(ctx); err != nil {
			t.Fatal(err)
		}
	}
	fixture.mu.Lock()
	if fixture.sends != 1 || fixture.usageReads != 3 {
		t.Fatalf("mid-cycle: sends=%d usageReads=%d, want 1 and 3", fixture.sends, fixture.usageReads)
	}
	fixture.mu.Unlock()

	// Five-hour rollover at lockedFirstReset + 35s: upstream returns a fresh sliding 5h boundary, and warmup fires on schedule.
	now = lockedFirstReset.Add(35 * time.Second)
	if err := handler.runCredentialWarmupRound(ctx); err != nil {
		t.Fatal(err)
	}
	fixture.mu.Lock()
	if fixture.sends != 2 || fixture.usageReads != 4 {
		t.Fatalf("post-rollover: sends=%d usageReads=%d, want 2 and 4", fixture.sends, fixture.usageReads)
	}
	fixture.mu.Unlock()
	codexSettingsAfterRollover := getWarmupSettingsWire(t, caller, baseURL)
	if len(codexSettingsAfterRollover.Runs) != 2 || codexSettingsAfterRollover.Runs[0].Outcome != "ok" || codexSettingsAfterRollover.Runs[0].ResetKey != warmup.FormatISO(lockedFirstReset) {
		t.Fatalf("expected second scheduled Codex run for %s over HTTP, got %+v", warmup.FormatISO(lockedFirstReset), codexSettingsAfterRollover.Runs)
	}
}

func TestWarmupAntigravityGroupedWindowRolloverFiresAndHonorsRefreshBackoff(t *testing.T) {
	now := time.Date(2026, 11, 13, 11, 4, 0, 0, time.UTC)
	fiveReset1 := time.Date(2026, 11, 13, 12, 27, 0, 0, time.UTC)
	weekReset1 := time.Date(2026, 11, 18, 17, 21, 0, 0, time.UTC)
	fixture := &warmupFixture{
		provider:          "antigravity",
		agFiveRemaining:   0.77,
		agWeeklyRemaining: 0.30,
		agFiveResetAt:     fiveReset1,
		agWeeklyResetAt:   weekReset1,
		clockFn:           func() time.Time { return now },
	}
	handler := newWarmupHandler(t, fixture)
	handler.nowFn = func() time.Time { return now }
	ctx := context.Background()

	// Seed initial Antigravity quota observation so grouped window IDs are present in the catalog.
	if err := handler.runCredentialWarmupRound(ctx); err != nil {
		t.Fatal(err)
	}
	client, err := handler.capabilityClient(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if handler.refreshWarmupQuota(ctx, client, findWarmupTestFile(t, handler, ctx, "exact-antigravity")) != warmupQuotaRefreshed {
		t.Fatal("initial antigravity quota seed failed")
	}
	caller, baseURL := warmupHTTPClient(t, handler)

	fiveState := postWarmupTaskWire(t, caller, baseURL, map[string]any{
		"enabled":    true,
		"provider":   "antigravity",
		"auth_index": "exact-antigravity",
		"model":      "gemini-3.8-flash",
		"trigger":    map[string]any{"kind": "window", "window": "ag_Gemini Models_gemini-5h"},
	})
	fiveTaskID := fiveState.Tasks[0].ID

	allState := postWarmupTaskWire(t, caller, baseURL, map[string]any{
		"enabled":    true,
		"provider":   "antigravity",
		"auth_index": "exact-antigravity",
		"model":      "gemini-3.8-flash",
		"trigger":    map[string]any{"kind": "window", "window": "ag_Gemini Models_gemini-week"},
	})
	var weekTaskID string
	for _, task := range allState.Tasks {
		if task.ID != fiveTaskID {
			weekTaskID = task.ID
		}
	}
	initialSettings := getWarmupSettingsWire(t, caller, baseURL)
	if got5h := initialSettings.Next[fiveTaskID]; got5h == nil || *got5h != warmup.FormatISO(fiveReset1.Add(warmup.WINDOW_GRACE)) {
		t.Fatalf("unexpected 5h HTTP next instant: %v", got5h)
	}
	if gotWeek := initialSettings.Next[weekTaskID]; gotWeek == nil || *gotWeek != warmup.FormatISO(weekReset1.Add(warmup.WINDOW_GRACE)) {
		t.Fatalf("unexpected weekly HTTP next instant: %v", gotWeek)
	}
	if len(initialSettings.Runs) != 0 {
		t.Fatalf("expected 0 initial HTTP runs, got %d", len(initialSettings.Runs))
	}

	// Phase 1: Normal rollover at fiveReset1 + 35s — upstream reports 100% remaining and next reset +5h.
	fiveReset2 := fiveReset1.Add(5 * time.Hour)
	fixture.mu.Lock()
	fixture.agFiveRemaining = 1.0
	fixture.agFiveResetAt = fiveReset2
	fixture.mu.Unlock()
	now = fiveReset1.Add(35 * time.Second)
	if err := handler.runCredentialWarmupRound(ctx); err != nil {
		t.Fatal(err)
	}
	fixture.mu.Lock()
	if fixture.sends != 1 || fixture.lastModel != "gemini-3.8-flash" {
		t.Fatalf("phase 1 rollover: sends=%d model=%q, want 1 gemini-3.8-flash", fixture.sends, fixture.lastModel)
	}
	fixture.mu.Unlock()
	rolloverSettings := getWarmupSettingsWire(t, caller, baseURL)
	if got5h := rolloverSettings.Next[fiveTaskID]; got5h == nil || *got5h != warmup.FormatISO(fiveReset2.Add(warmup.WINDOW_GRACE)) {
		t.Fatalf("unexpected 5h HTTP next instant after rollover: %v", got5h)
	}
	if gotWeek := rolloverSettings.Next[weekTaskID]; gotWeek == nil || *gotWeek != warmup.FormatISO(weekReset1.Add(warmup.WINDOW_GRACE)) {
		t.Fatalf("unexpected weekly HTTP next instant after 5h rollover: %v", gotWeek)
	}
	if len(rolloverSettings.Runs) != 1 || rolloverSettings.Runs[0].TaskID != fiveTaskID || rolloverSettings.Runs[0].Outcome != "ok" || rolloverSettings.Runs[0].ResetKey != warmup.FormatISO(fiveReset1) {
		t.Fatalf("expected Antigravity 5h HTTP run without firing weekly task (%s), got %+v", weekTaskID, rolloverSettings.Runs)
	}

	// Settle post-send quota reading for cycle 2.
	now = now.Add(65 * time.Second)
	fixture.mu.Lock()
	fixture.agFiveRemaining = 0.99
	fixture.mu.Unlock()
	if err := handler.runCredentialWarmupRound(ctx); err != nil {
		t.Fatal(err)
	}

	// Phase 2: At fiveReset2 + 35s, simulate a transient upstream 500 on quota read: backoff activates for 5m without burning the reset key.
	fixture.mu.Lock()
	fixture.usageHTTPStatus = http.StatusInternalServerError
	readsBeforeFailure := fixture.usageReads
	fixture.mu.Unlock()
	now = fiveReset2.Add(35 * time.Second)
	if err := handler.runCredentialWarmupRound(ctx); err != nil {
		t.Fatal(err)
	}
	now = fiveReset2.Add(95 * time.Second)
	if err := handler.runCredentialWarmupRound(ctx); err != nil {
		t.Fatal(err)
	}
	fixture.mu.Lock()
	// One failed Antigravity quota read tries the 3 regional Cloud Code endpoints, then backs off for 5m.
	if fixture.sends != 1 || fixture.usageReads != readsBeforeFailure+3 {
		t.Fatalf("during 5m backoff: sends=%d usageReads=%d, want 1 and %d", fixture.sends, fixture.usageReads, readsBeforeFailure+3)
	}
	fiveReset3 := fiveReset2.Add(5 * time.Hour)
	fixture.usageHTTPStatus = http.StatusOK
	fixture.agFiveRemaining = 1.0
	fixture.agFiveResetAt = fiveReset3
	fixture.mu.Unlock()

	now = fiveReset2.Add(warmupRefreshBackoff + 40*time.Second)
	if err := handler.runCredentialWarmupRound(ctx); err != nil {
		t.Fatal(err)
	}
	fixture.mu.Lock()
	if fixture.sends != 2 {
		t.Fatalf("after recovery: sends=%d, want 2", fixture.sends)
	}
	fixture.mu.Unlock()

	// Settle post-send quota reading for cycle 3, then simulate an external quota refresh (e.g. RunQuotaAutoRefresh)
	// landing right after fiveReset3 before the warmup round ticks: warmup must still fire.
	now = now.Add(65 * time.Second)
	fixture.mu.Lock()
	fixture.agFiveRemaining = 0.99
	fixture.mu.Unlock()
	if err := handler.runCredentialWarmupRound(ctx); err != nil {
		t.Fatal(err)
	}

	fiveReset4 := fiveReset3.Add(5 * time.Hour)
	now = fiveReset3.Add(40 * time.Second)
	fixture.mu.Lock()
	fixture.agFiveRemaining = 1.0
	fixture.agFiveResetAt = fiveReset4
	fixture.mu.Unlock()
	if handler.refreshWarmupQuota(ctx, client, findWarmupTestFile(t, handler, ctx, "exact-antigravity")) != warmupQuotaRefreshed {
		t.Fatal("external post-reset refresh failed")
	}
	if err := handler.runCredentialWarmupRound(ctx); err != nil {
		t.Fatal(err)
	}
	fixture.mu.Lock()
	if fixture.sends != 3 {
		t.Fatalf("expected external refresh before warmup tick to still fire 5h task, got sends=%d", fixture.sends)
	}
	fixture.mu.Unlock()

	// Settle post-send quota reading for cycle 4, then manually run the 5h task at fiveReset4 + 20s:
	// when a fresh 0%-usage snapshot arrives at fiveReset4 + 30s and the scheduler ticks at +31s,
	// the manual post-reset send must retire fiveReset4 so only 1 CPA send occurs for that boundary.
	now = now.Add(65 * time.Second)
	fixture.mu.Lock()
	fixture.agFiveRemaining = 0.99
	fixture.mu.Unlock()
	if err := handler.runCredentialWarmupRound(ctx); err != nil {
		t.Fatal(err)
	}
	fiveReset5 := fiveReset4.Add(5 * time.Hour)
	now = fiveReset4.Add(20 * time.Second)
	manualResp, err := caller.Post(baseURL+"/api/v1/management/quota/warmup/tasks/"+fiveTaskID+"/run", "application/json", nil)
	if err != nil {
		t.Fatal(err)
	}
	_ = manualResp.Body.Close()
	if manualResp.StatusCode != http.StatusOK {
		t.Fatalf("manual run status=%d, want 200", manualResp.StatusCode)
	}
	fixture.mu.Lock()
	if fixture.sends != 4 {
		t.Fatalf("expected manual post-reset run to send once (total 4), got %d", fixture.sends)
	}
	fixture.agFiveRemaining = 1.0
	fixture.agFiveResetAt = fiveReset5
	fixture.mu.Unlock()
	now = fiveReset4.Add(30 * time.Second)
	if handler.refreshWarmupQuota(ctx, client, findWarmupTestFile(t, handler, ctx, "exact-antigravity")) != warmupQuotaRefreshed {
		t.Fatal("post-manual refresh failed")
	}
	now = fiveReset4.Add(31 * time.Second)
	if err := handler.runCredentialWarmupRound(ctx); err != nil {
		t.Fatal(err)
	}
	fixture.mu.Lock()
	if fixture.sends != 4 {
		t.Fatalf("scheduler resent after post-reset manual send: sends=%d, want 4", fixture.sends)
	}
	fixture.mu.Unlock()

	// Updating only the display Account when AuthIndex stays unchanged must preserve ResetKeys/LastSent,
	// whereas switching Trigger.Window resets marks to the newly selected window's boundary.
	marksBeforeRename, err := handler.repo.ReadWarmupMarks(ctx, "default", fiveTaskID)
	if err != nil || len(marksBeforeRename.ResetKeys) == 0 {
		t.Fatalf("expected non-empty ResetKeys before rename, got %+v (err=%v)", marksBeforeRename, err)
	}
	if _, err := handler.saveWarmupTask(ctx, fiveTaskID, warmup.TaskInput{
		Enabled:   true,
		Provider:  "antigravity",
		AuthIndex: "exact-antigravity",
		Account:   "renamed-display-label",
		Model:     "gemini-3.8-flash",
		Trigger:   warmup.Trigger{Kind: "window", Window: "ag_Gemini Models_gemini-5h"},
	}); err != nil {
		t.Fatal(err)
	}
	marksAfterRename, err := handler.repo.ReadWarmupMarks(ctx, "default", fiveTaskID)
	if err != nil || !reflect.DeepEqual(marksAfterRename.ResetKeys, marksBeforeRename.ResetKeys) || marksAfterRename.LastSent != marksBeforeRename.LastSent {
		t.Fatalf("Account display rename with stable AuthIndex wiped marks: before=%+v after=%+v", marksBeforeRename, marksAfterRename)
	}
	if _, err := handler.saveWarmupTask(ctx, fiveTaskID, warmup.TaskInput{
		Enabled:   true,
		Provider:  "antigravity",
		AuthIndex: "exact-antigravity",
		Account:   "renamed-display-label",
		Model:     "gemini-3.8-flash",
		Trigger:   warmup.Trigger{Kind: "window", Window: "ag_Gemini Models_gemini-week"},
	}); err != nil {
		t.Fatal(err)
	}
	marksAfterWindowSwitch, err := handler.repo.ReadWarmupMarks(ctx, "default", fiveTaskID)
	if err != nil || len(marksAfterWindowSwitch.ResetKeys) != 0 || marksAfterWindowSwitch.LastReset != warmup.FormatISO(weekReset1) {
		t.Fatalf("switching target window did not atomically reset marks to weekly boundary: %+v (err=%v)", marksAfterWindowSwitch, err)
	}

	// Re-enabling a task concurrently with a scheduler ResetKeys update must read-modify-write inside
	// a single SQLite transaction so a newly recorded ResetKey is never overwritten.
	if _, err := handler.saveWarmupTask(ctx, fiveTaskID, warmup.TaskInput{
		Enabled:   false,
		Provider:  "antigravity",
		AuthIndex: "exact-antigravity",
		Account:   "renamed-display-label",
		Model:     "gemini-3.8-flash",
		Trigger:   warmup.Trigger{Kind: "window", Window: "ag_Gemini Models_gemini-week"},
	}); err != nil {
		t.Fatal(err)
	}
	concurrentResetKey := warmup.FormatISO(weekReset1)
	enteredSchedulerTx := make(chan struct{})
	releaseSchedulerTx := make(chan struct{})
	schedulerDone := make(chan error, 1)
	go func() {
		_, txErr := handler.repo.UpdateWarmupMarks(ctx, "default", fiveTaskID, now.UnixMilli(), func(current warmup.TaskMarks) (warmup.TaskMarks, bool, error) {
			close(enteredSchedulerTx)
			<-releaseSchedulerTx
			current.ResetKeys = append(current.ResetKeys, concurrentResetKey)
			return current, true, nil
		})
		schedulerDone <- txErr
	}()
	<-enteredSchedulerTx
	saveDone := make(chan error, 1)
	go func() {
		_, saveErr := handler.saveWarmupTask(ctx, fiveTaskID, warmup.TaskInput{
			Enabled:   true,
			Provider:  "antigravity",
			AuthIndex: "exact-antigravity",
			Account:   "renamed-display-label",
			Model:     "gemini-3.8-flash",
			Trigger:   warmup.Trigger{Kind: "window", Window: "ag_Gemini Models_gemini-week"},
		})
		saveDone <- saveErr
	}()
	// Give saveWarmupTask time to finish catalog/audit work and wait at the single-writer transaction boundary.
	time.Sleep(25 * time.Millisecond)
	close(releaseSchedulerTx)
	if err := <-schedulerDone; err != nil {
		t.Fatalf("concurrent scheduler UpdateWarmupMarks failed: %v", err)
	}
	if err := <-saveDone; err != nil {
		t.Fatalf("concurrent saveWarmupTask failed: %v", err)
	}
	marksAfterConcurrentReenable, err := handler.repo.ReadWarmupMarks(ctx, "default", fiveTaskID)
	if err != nil || !slices.Contains(marksAfterConcurrentReenable.ResetKeys, concurrentResetKey) {
		t.Fatalf("concurrent task re-enable overwrote scheduler ResetKey %q: %+v (err=%v)", concurrentResetKey, marksAfterConcurrentReenable, err)
	}

	// If an intervening save switches the persisted target before another save's transaction runs,
	// WriteWarmupTaskWithMarks must compare against the in-transaction persisted task rather than
	// retaining the intervening target's LastReset.
	enteredTargetTx := make(chan struct{})
	releaseTargetTx := make(chan struct{})
	interveningDone := make(chan error, 1)
	if _, err := handler.saveWarmupTask(ctx, fiveTaskID, warmup.TaskInput{
		Enabled:   true,
		Provider:  "antigravity",
		AuthIndex: "exact-antigravity",
		Account:   "label-before",
		Model:     "gemini-3.8-flash",
		Trigger:   warmup.Trigger{Kind: "window", Window: "ag_Gemini Models_gemini-5h"},
	}); err != nil {
		t.Fatal(err)
	}
	go func() {
		txErr := handler.repo.WriteWarmupTaskWithMarks(ctx, "default", warmup.Task{
			ID:        fiveTaskID,
			Name:      "intervening-weekly",
			Enabled:   true,
			Provider:  "antigravity",
			AuthIndex: "exact-antigravity",
			Account:   "label-before",
			Model:     "gemini-3.8-flash",
			Trigger:   warmup.Trigger{Kind: "window", Window: "ag_Gemini Models_gemini-week"},
			UpdatedAt: warmup.FormatISO(now),
		}, true, now.UnixMilli(), func(_ *warmup.Task, _ warmup.TaskMarks) (*warmup.TaskMarks, error) {
			close(enteredTargetTx)
			<-releaseTargetTx
			weeklyMarks := warmup.TaskMarks{LastReset: warmup.FormatISO(weekReset1)}
			return &weeklyMarks, nil
		})
		interveningDone <- txErr
	}()
	<-enteredTargetTx
	renameSaveDone := make(chan error, 1)
	go func() {
		_, saveErr := handler.saveWarmupTask(ctx, fiveTaskID, warmup.TaskInput{
			Enabled:   true,
			Provider:  "antigravity",
			AuthIndex: "exact-antigravity",
			Account:   "label-after",
			Model:     "gemini-3.8-flash",
			Trigger:   warmup.Trigger{Kind: "window", Window: "ag_Gemini Models_gemini-5h"},
		})
		renameSaveDone <- saveErr
	}()
	time.Sleep(25 * time.Millisecond)
	close(releaseTargetTx)
	if err := <-interveningDone; err != nil {
		t.Fatalf("intervening target switch failed: %v", err)
	}
	if err := <-renameSaveDone; err != nil {
		t.Fatalf("concurrent rename save failed: %v", err)
	}
	marksAfterInterveningTarget, err := handler.repo.ReadWarmupMarks(ctx, "default", fiveTaskID)
	if err != nil || marksAfterInterveningTarget.LastReset != warmup.FormatISO(fiveReset5) {
		t.Fatalf("concurrent save retained intervening weekly LastReset instead of 5h boundary %s: %+v (err=%v)", warmup.FormatISO(fiveReset5), marksAfterInterveningTarget, err)
	}
}

func findWarmupTestFile(t *testing.T, handler *Handler, ctx context.Context, authIndex string) management.AuthFile {
	t.Helper()
	client, err := handler.capabilityClient(ctx)
	if err != nil {
		t.Fatal(err)
	}
	_, files := handler.warmupCatalogWithFiles(ctx, client)
	file, ok := files[authIndex]
	if !ok {
		t.Fatalf("missing test file %q", authIndex)
	}
	return file
}

func postWarmupTaskWire(t *testing.T, caller *http.Client, baseURL string, payload map[string]any) warmup.StateView {
	t.Helper()
	rawPayload, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	resp, err := caller.Post(baseURL+"/api/v1/management/quota/warmup/tasks", "application/json", bytes.NewReader(rawPayload))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("POST /warmup/tasks status=%d, want 201", resp.StatusCode)
	}
	return decodeWarmupStateWire(t, resp)
}

func getWarmupSettingsWire(t *testing.T, caller *http.Client, baseURL string) warmup.StateView {
	t.Helper()
	resp, err := caller.Get(baseURL + "/api/v1/management/quota/warmup/settings")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("GET /warmup/settings status=%d, want 200", resp.StatusCode)
	}
	return decodeWarmupStateWire(t, resp)
}

func decodeWarmupStateWire(t *testing.T, resp *http.Response) warmup.StateView {
	t.Helper()
	var wireMap map[string]any
	var buf bytes.Buffer
	if _, err := buf.ReadFrom(resp.Body); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(buf.Bytes(), &wireMap); err != nil {
		t.Fatalf("invalid warmup settings JSON: %v", err)
	}
	if bytes.Contains(buf.Bytes(), []byte("period_hours")) || bytes.Contains(buf.Bytes(), []byte("periodHours")) {
		t.Fatalf("internal window PeriodHours leaked onto HTTP wire response: %s", buf.String())
	}
	for _, requiredKey := range []string{"tasks", "runs", "next", "timeline"} {
		if _, ok := wireMap[requiredKey]; !ok {
			t.Fatalf("missing required wire key %q in %s", requiredKey, buf.String())
		}
	}
	var state warmup.StateView
	if err := json.Unmarshal(buf.Bytes(), &state); err != nil {
		t.Fatalf("unmarshal warmup StateView wire payload: %v", err)
	}
	return state
}
