package api

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/auth"
	"github.com/oh-my-cpa/oh-my-cpa/internal/config"
	"github.com/oh-my-cpa/oh-my-cpa/internal/crypto"
	"github.com/oh-my-cpa/oh-my-cpa/internal/domain"
	"github.com/oh-my-cpa/oh-my-cpa/internal/quota"
	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
)

func TestCodexResetPolicyFacade(t *testing.T) {
	account := "codex-reset:" + strings.Repeat("a", 64)
	var writes atomic.Int32
	var status atomic.Int32
	client, base, repo := startDashboardTestServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v8/management/routing/codex-reset-policy" || r.URL.Query().Get("auth_index") != "codex & main" {
			t.Errorf("unexpected upstream call: %s %s", r.Method, r.URL)
			w.WriteHeader(404)
			return
		}
		if r.Method == http.MethodPut {
			writes.Add(1)
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			if len(body) != 3 || body["account_key"] != account || body["enabled"] != true || body["before_expiry_seconds"] != float64(900) {
				t.Errorf("unexpected consent: %#v", body)
			}
		}
		if code := int(status.Load()); code != 0 {
			w.WriteHeader(code)
			_, _ = w.Write([]byte(`{"error":"private-upstream-token"}`))
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"account_key": account, "enabled": false, "before_expiry_seconds": 3600,
			"result": "disabled", "pending": false, "last_reset_at": 1790000000,
			"access_token": "private-upstream-token", "request_id": "private-journal-id",
		})
	})
	endpoint := base + "/omc/api/v1/management/quota/codex-reset-policy?auth_index=codex%20%26%20main"
	resp, body := getJSON(t, client, endpoint)
	if resp.StatusCode != 200 || !bytes.Contains(body, []byte(account)) || bytes.Contains(body, []byte("private-")) {
		t.Fatalf("unsafe or missing projection: %d %s", resp.StatusCode, body)
	}
	for _, payload := range []string{
		`{"enabled":true,"before_expiry_seconds":900}`,
		`{"account_key":"` + account + `","before_expiry_seconds":900}`,
		`{"account_key":"` + account + `","enabled":true,"before_expiry_seconds":59}`,
		`{"account_key":"` + account + `","enabled":true,"before_expiry_seconds":900,"pending":false}`,
	} {
		resp, body = doJSON(t, client, http.MethodPut, endpoint, payload)
		if resp.StatusCode != 400 || writes.Load() != 0 {
			t.Fatalf("invalid consent reached upstream: %d %s", resp.StatusCode, body)
		}
	}
	resp, body = doJSON(t, client, http.MethodPut, endpoint,
		`{"account_key":"`+account+`","enabled":true,"before_expiry_seconds":900}`)
	if resp.StatusCode != 200 || writes.Load() != 1 {
		t.Fatalf("consent not saved: %d %s", resp.StatusCode, body)
	}
	for _, code := range []int{404, 409, 503} {
		status.Store(int32(code))
		resp, body = getJSON(t, client, endpoint)
		want := code
		if code == 404 {
			want = 501
		}
		if resp.StatusCode != want || bytes.Contains(body, []byte("private-upstream-token")) {
			t.Fatalf("unsafe upstream error: %d %s (want %d)", resp.StatusCode, body, want)
		}
	}
	resp, body = getJSON(t, client, strings.Split(endpoint, "?")[0])
	if resp.StatusCode != 400 {
		t.Fatalf("missing credential accepted: %d %s", resp.StatusCode, body)
	}
	if _, err := repo.SQL().Exec("DROP TABLE audit_events"); err != nil {
		t.Fatal(err)
	}
	resp, body = doJSON(t, client, http.MethodPut, endpoint,
		`{"account_key":"`+account+`","enabled":true,"before_expiry_seconds":900}`)
	if resp.StatusCode != 500 || writes.Load() != 1 {
		t.Fatalf("unaudited consent reached CPA: %d %s", resp.StatusCode, body)
	}
}

func TestManagementQuotaEndpoints(t *testing.T) {
	const managementKey = "management-secret"

	var cpaResetCalledWith string
	var shouldFailReset bool
	var cpaApiCallCalledWith string
	var cpaConsumeMethod string
	var cpaConsumeHeader map[string]string
	var cpaConsumeBody string

	cpaServer := newFakeCPA(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Header.Get("Authorization") != "Bearer "+managementKey {
			writer.WriteHeader(http.StatusUnauthorized)
			return
		}
		writer.Header().Set("Content-Type", "application/json")

		switch request.URL.Path {
		case "/v8/management/credentials":
			_, _ = writer.Write([]byte(`{
				"files": [
					{
						"id": "file-1",
						"name": "codex-main.json",
						"auth_index": "codex-idx-1",
						"type": "codex",
						"provider": "codex",
						"disabled": false,
						"id_token": {
							"chatgpt_account_id": "acct-e2e",
							"chatgpt_subscription_active_until": 1800000000
						}
					},
					{
						"id": "file-2",
						"name": "claude-team.json",
						"auth_index": "claude-idx-2",
						"type": "claude",
						"provider": "claude",
						"disabled": false
					}
				]
			}`))

		case "/v8/management/routing/cooldown/reset":
			var payload struct {
				AuthIndex string `json:"auth_index"`
			}
			_ = json.NewDecoder(request.Body).Decode(&payload)
			cpaResetCalledWith = payload.AuthIndex
			if shouldFailReset {
				writer.WriteHeader(http.StatusBadGateway)
				_, _ = writer.Write([]byte(`{"error":"private-upstream-diagnostic"}`))
				return
			}
			_, _ = writer.Write([]byte(`{"status":"ok"}`))

		case "/v8/management/requests/api-call":
			var payload struct {
				AuthIndex string            `json:"auth_index"`
				URL       string            `json:"url"`
				Method    string            `json:"method"`
				Header    map[string]string `json:"header"`
				Data      string            `json:"data"`
			}
			_ = json.NewDecoder(request.Body).Decode(&payload)
			_ = cpaApiCallCalledWith
			cpaApiCallCalledWith = payload.URL

			// The consume check must precede the details check and name the real path:
			// the two endpoints share a prefix, so a typo here silently routes the redeem
			// call into the details response and the test passes without exercising it.
			if strings.HasSuffix(payload.URL, "/rate-limit-reset-credits/consume") {
				cpaConsumeMethod = payload.Method
				cpaConsumeHeader = payload.Header
				cpaConsumeBody = payload.Data
				_, _ = writer.Write([]byte(`{
					"status_code": 200,
					"body": {"code": "reset"}
				}`))
			} else if strings.Contains(payload.URL, "rate-limit-reset-credits") {
				_, _ = writer.Write([]byte(`{
					"status_code": 200,
					"body": {
						"available_count": 2,
						"credits": [
							{
								"id": "credit-1",
								"status": "available",
								"reset_type": "codex_rate_limits",
								"granted_at": "1790000000",
								"expires_at": "1810000000"
							},
							{
								"id": "credit-2",
								"status": "available",
								"reset_type": "codex_rate_limits",
								"granted_at": "1790000000",
								"expires_at": "1820000000"
							},
							{
								"id": "credit-3",
								"status": "used",
								"reset_type": "codex_rate_limits",
								"granted_at": "1790000000",
								"expires_at": "1805000000"
							}
						]
					}
				}`))
			} else if strings.Contains(payload.URL, "backend-api/wham/usage") {
				_, _ = writer.Write([]byte(`{
					"status_code": 200,
					"body": {
						"plan_type": "pro",
						"rate_limit": {
							"primary_window": {
								"used_percent": 15,
								"limit_window_seconds": 18000,
								"reset_after_seconds": 3600
							}
						},
						"rate_limit_reset_credits": {
							"available_count": 2,
							"applicable_available_count": 1
						}
					}
				}`))
			} else {
				_, _ = writer.Write([]byte(`{"status_code": 200, "body": {}}`))
			}

		default:
			writer.WriteHeader(http.StatusNotFound)
		}
	}))
	defer cpaServer.Close()

	handler := testHandler(t, "")
	appServer := httptest.NewServer(handler.Router())
	defer appServer.Close()

	// Configure CPA instance
	cipher, err := crypto.New("01234567890123456789012345678901")
	if err != nil {
		t.Fatal(err)
	}
	ciphertext, nonce, err := cipher.Encrypt([]byte(managementKey))
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC().Truncate(time.Second)
	if err := handler.repo.UpsertInstance(context.Background(), domain.CPAInstance{
		ID:                      "default",
		Name:                    "Default",
		BaseURL:                 cpaServer.URL,
		UsageAddr:               strings.TrimPrefix(cpaServer.URL, "http://"),
		ManagementKeyCiphertext: ciphertext,
		ManagementKeyNonce:      nonce,
		CreatedAt:               now,
		UpdatedAt:               now,
	}); err != nil {
		t.Fatal(err)
	}

	client := signedInClient(t, appServer.URL+"/api/auth/login", "management-secret")

	// 1. GET /api/v1/management/quota
	quotaResp, err := client.Get(appServer.URL + "/api/v1/management/quota")
	if err != nil {
		t.Fatalf("GET /api/v1/management/quota failed: %v", err)
	}
	defer quotaResp.Body.Close()

	if quotaResp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", quotaResp.StatusCode)
	}

	var overview quota.QuotaOverviewResponse
	if err := json.NewDecoder(quotaResp.Body).Decode(&overview); err != nil {
		t.Fatalf("decode overview failed: %v", err)
	}

	if overview.Summary.TotalCredentials != 2 {
		t.Fatalf("total credentials = %d, want 2", overview.Summary.TotalCredentials)
	}
	if len(overview.Quotas) != 2 {
		t.Fatalf("len(quotas) = %d, want 2", len(overview.Quotas))
	}

	// 2. POST /api/v1/management/quota/refresh for codex-idx-1
	refResp, err := client.Post(appServer.URL+"/api/v1/management/quota/refresh", "application/json", bytes.NewBufferString(`{"auth_index":"codex-idx-1"}`))
	if err != nil {
		t.Fatalf("POST /refresh failed: %v", err)
	}
	defer refResp.Body.Close()

	if refResp.StatusCode != http.StatusOK {
		t.Fatalf("refresh status = %d, want 200", refResp.StatusCode)
	}

	var refreshResult struct {
		Status string                `json:"status"`
		Quota  quota.NormalizedQuota `json:"quota"`
	}
	if err := json.NewDecoder(refResp.Body).Decode(&refreshResult); err != nil {
		t.Fatalf("decode refresh result failed: %v", err)
	}

	if refreshResult.Quota.Plan == nil || refreshResult.Quota.Plan.Tier != "elite" {
		t.Errorf("plan = %+v, want elite", refreshResult.Quota.Plan)
	}
	if refreshResult.Quota.Plan == nil || refreshResult.Quota.Plan.ExpiresAtMS == nil {
		t.Errorf("plan expiry missing, want id_token fallback: %+v", refreshResult.Quota.Plan)
	}
	if len(refreshResult.Quota.Windows) != 1 || *refreshResult.Quota.Windows[0].UsedPercent != 15.0 {
		t.Errorf("windows = %+v, want 15%% used", refreshResult.Quota.Windows)
	}
	if refreshResult.Quota.ResetCredits == nil || refreshResult.Quota.ResetCredits.AvailableCount != 2 {
		t.Errorf("reset credits = %+v, want 2", refreshResult.Quota.ResetCredits)
	}
	if refreshResult.Quota.ResetCredits == nil || len(refreshResult.Quota.ResetCredits.Credits) != 2 {
		t.Errorf("reset credit rows = %+v, want 2 available credits after filtering", refreshResult.Quota.ResetCredits)
	}

	// Refreshed plan must survive the snapshot round-trip (renewal time persists).
	overviewAfter, err := client.Get(appServer.URL + "/api/v1/management/quota")
	if err != nil {
		t.Fatalf("GET /quota after refresh failed: %v", err)
	}
	defer overviewAfter.Body.Close()
	var overviewAfterBody quota.QuotaOverviewResponse
	if err := json.NewDecoder(overviewAfter.Body).Decode(&overviewAfterBody); err != nil {
		t.Fatalf("decode overview after refresh failed: %v", err)
	}
	for _, item := range overviewAfterBody.Quotas {
		if item.AuthIndex != "codex-idx-1" {
			continue
		}
		if item.Plan == nil || item.Plan.PlanType != "pro" {
			t.Errorf("snapshot plan = %+v, want pro", item.Plan)
		}
		if item.Plan == nil || item.Plan.ExpiresAtMS == nil || *item.Plan.ExpiresAtMS != 1800000000000 {
			t.Errorf("snapshot plan expiry = %+v, want 1800000000000", item.Plan)
		}
		if item.ResetCredits == nil || item.ResetCredits.AvailableCount != 2 {
			t.Errorf("snapshot reset credits = %+v, want 2", item.ResetCredits)
		}
	}

	// 3. POST /api/v1/management/quota/clear-cooldown
	ccResp, err := client.Post(appServer.URL+"/api/v1/management/quota/clear-cooldown", "application/json", bytes.NewBufferString(`{"auth_index":"codex-idx-1"}`))
	if err != nil {
		t.Fatalf("POST /clear-cooldown failed: %v", err)
	}
	defer ccResp.Body.Close()

	if ccResp.StatusCode != http.StatusOK {
		t.Fatalf("clear-cooldown status = %d, want 200", ccResp.StatusCode)
	}
	if cpaResetCalledWith != "codex-idx-1" {
		t.Errorf("cpaResetCalledWith = %q, want codex-idx-1", cpaResetCalledWith)
	}

	// 4. POST /api/v1/management/quota/redeem-credit
	// A spent credit does not clear the gateway cooldown by itself, so redeeming
	// also resets it; the marker is cleared first to prove the redeem step made
	// the call rather than the clear-cooldown step above.
	cpaResetCalledWith = ""
	redeemResp, err := client.Post(appServer.URL+"/api/v1/management/quota/redeem-credit", "application/json", bytes.NewBufferString(`{"auth_index":"codex-idx-1"}`))
	if err != nil {
		t.Fatalf("POST /redeem-credit failed: %v", err)
	}
	defer redeemResp.Body.Close()

	if redeemResp.StatusCode != http.StatusOK {
		t.Fatalf("redeem-credit status = %d, want 200", redeemResp.StatusCode)
	}
	var redeemResult struct {
		Status          string `json:"status"`
		CooldownCleared bool   `json:"cooldown_cleared"`
	}
	if err := json.NewDecoder(redeemResp.Body).Decode(&redeemResult); err != nil {
		t.Fatalf("decode redeem result failed: %v", err)
	}
	if redeemResult.Status != "ok" || !redeemResult.CooldownCleared {
		t.Errorf("redeem result = %+v, want status ok with cooldown cleared", redeemResult)
	}
	if cpaResetCalledWith != "codex-idx-1" {
		t.Errorf("redeem cpaResetCalledWith = %q, want codex-idx-1", cpaResetCalledWith)
	}
	if cpaConsumeMethod != http.MethodPost {
		t.Errorf("consume method = %q, want POST", cpaConsumeMethod)
	}
	if cpaConsumeHeader["Authorization"] != "Bearer $TOKEN$" {
		t.Errorf("consume Authorization = %q, want the CPA credential marker", cpaConsumeHeader["Authorization"])
	}
	if cpaConsumeHeader["Chatgpt-Account-Id"] != "acct-e2e" {
		t.Errorf("consume Chatgpt-Account-Id = %q, want acct-e2e", cpaConsumeHeader["Chatgpt-Account-Id"])
	}
	if !strings.Contains(cpaConsumeBody, "redeem_request_id") {
		t.Errorf("consume body = %q, want a redeem_request_id", cpaConsumeBody)
	}

	// Redemption remains successful when the separate gateway clear fails, but
	// the ordinary response must not expose CPA's raw diagnostic body.
	shouldFailReset = true
	failedClearResp, err := client.Post(appServer.URL+"/api/v1/management/quota/redeem-credit", "application/json", bytes.NewBufferString(`{"auth_index":"codex-idx-1"}`))
	if err != nil {
		t.Fatalf("POST /redeem-credit with failed cooldown clear: %v", err)
	}
	failedClearBody, readErr := io.ReadAll(failedClearResp.Body)
	failedClearResp.Body.Close()
	if readErr != nil {
		t.Fatal(readErr)
	}
	if failedClearResp.StatusCode != http.StatusOK {
		t.Fatalf("failed clear status = %d, want 200", failedClearResp.StatusCode)
	}
	var failedClearResult struct {
		Status          string `json:"status"`
		CooldownCleared bool   `json:"cooldown_cleared"`
		CooldownError   string `json:"cooldown_error"`
	}
	if err := json.Unmarshal(failedClearBody, &failedClearResult); err != nil {
		t.Fatal(err)
	}
	if failedClearResult.Status != "ok" || failedClearResult.CooldownCleared || failedClearResult.CooldownError != "cooldown_clear_failed" {
		t.Fatalf("failed clear result = %+v, want successful redemption with a stable cooldown error", failedClearResult)
	}
	if strings.Contains(string(failedClearBody), "private-upstream-diagnostic") {
		t.Fatal("redemption response exposed the upstream diagnostic")
	}
	shouldFailReset = false

	// 5. GET /api/v1/management/quota/{authIndex}
	detailResp, err := client.Get(appServer.URL + "/api/v1/management/quota/codex-idx-1")
	if err != nil {
		t.Fatalf("GET /quota/codex-idx-1 failed: %v", err)
	}
	defer detailResp.Body.Close()

	if detailResp.StatusCode != http.StatusOK {
		t.Fatalf("detail status = %d, want 200", detailResp.StatusCode)
	}

	var detailResult struct {
		Quota   quota.NormalizedQuota            `json:"quota"`
		History []repository.QuotaSnapshotRecord `json:"history"`
	}
	if err := json.NewDecoder(detailResp.Body).Decode(&detailResult); err != nil {
		t.Fatalf("decode detail failed: %v", err)
	}

	if len(detailResult.History) == 0 {
		t.Errorf("expected snapshot history to be persisted")
	}
}

func TestQuotaSnapshotRoundTripsResetGrants(t *testing.T) {
	handler := capacityTestHandler(t)
	ctx := context.Background()
	nowMS := time.Now().UnixMilli()
	persisted := &quota.NormalizedQuota{
		AuthIndex:    "claude-idx-9",
		Provider:     "claude",
		Status:       "healthy",
		ObservedAtMS: nowMS,
		ResetGrants: []quota.ClaudeResetGrant{{
			ID: "grant-1", Label: "five_hour", ResetsTotal: 2, ResetsLeft: 1,
			EndsAtMS: func() *int64 { ends := nowMS + 3600000; return &ends }(),
		}},
	}
	if err := handler.persistNormalizedQuotaSnapshot(ctx, persisted); err != nil {
		t.Fatalf("persist snapshot: %v", err)
	}
	restored := handler.loadPriorNormalizedQuota(ctx, "claude-idx-9")
	if restored == nil {
		t.Fatal("snapshot missing after persist")
	}
	if len(restored.ResetGrants) != 1 || restored.ResetGrants[0].ID != "grant-1" || restored.ResetGrants[0].ResetsLeft != 1 {
		t.Fatalf("grants after roundtrip = %+v, want the persisted grant", restored.ResetGrants)
	}
}

func TestQuotaOverviewAdvertisesPluginRefresh(t *testing.T) {
	const managementKey = "management-secret"
	cpaServer := newFakeCPA(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Header.Get("Authorization") != "Bearer "+managementKey {
			writer.WriteHeader(http.StatusUnauthorized)
			return
		}
		writer.Header().Set("Content-Type", "application/json")
		if request.URL.Path == "/v8/management/credentials" {
			_, _ = writer.Write([]byte(`{"files": [{
				"id": "file-plugin-1", "name": "review.json", "auth_index": "plugin-idx-1",
				"type": "codebuddy", "provider": "codebuddy", "disabled": false,
				"supports_quota": true, "quota_provider": "codebuddy"
			}]}`))
			return
		}
		_, _ = writer.Write([]byte(`{}`))
	}))
	defer cpaServer.Close()

	handler := testHandler(t, "")
	appServer := httptest.NewServer(handler.Router())
	defer appServer.Close()

	cipher, err := crypto.New("01234567890123456789012345678901")
	if err != nil {
		t.Fatal(err)
	}
	ciphertext, nonce, err := cipher.Encrypt([]byte(managementKey))
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC().Truncate(time.Second)
	if err := handler.repo.UpsertInstance(context.Background(), domain.CPAInstance{
		ID: "default", Name: "Default", BaseURL: cpaServer.URL,
		UsageAddr:               strings.TrimPrefix(cpaServer.URL, "http://"),
		ManagementKeyCiphertext: ciphertext, ManagementKeyNonce: nonce,
		CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}

	client := signedInClient(t, appServer.URL+"/api/auth/login", "management-secret")

	quotaResp, err := client.Get(appServer.URL + "/api/v1/management/quota")
	if err != nil {
		t.Fatalf("GET overview failed: %v", err)
	}
	defer quotaResp.Body.Close()
	if quotaResp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", quotaResp.StatusCode)
	}
	var overview quota.QuotaOverviewResponse
	if err := json.NewDecoder(quotaResp.Body).Decode(&overview); err != nil {
		t.Fatalf("decode overview failed: %v", err)
	}
	if len(overview.Quotas) != 1 {
		t.Fatalf("len(quotas) = %d, want 1", len(overview.Quotas))
	}
	if !overview.Quotas[0].Capabilities.RefreshSupported {
		t.Fatalf("plugin credential capabilities = %+v, want refresh supported",
			overview.Quotas[0].Capabilities)
	}
}

func TestQuotaSnapshotRoundTripsPlanLabelsWithoutRewritingHistory(t *testing.T) {
	for _, test := range []struct{ provider, planType, label, tier string }{
		{"kimi", "standard", "Kimi For Coding", "standard"},
		{"codex", "pro_max", "Pro 500", "elite"},
	} {
		t.Run(test.provider, func(t *testing.T) {
			handler := capacityTestHandler(t)
			ctx := context.Background()
			prior := &quota.NormalizedQuota{AuthIndex: "fixture-plan", Provider: test.provider, Status: "healthy", ObservedAtMS: 1_800_000_000_000, Plan: &quota.QuotaPlan{PlanType: test.planType, PlanLabel: "Previous label", Tier: test.tier}}
			if err := handler.persistNormalizedQuotaSnapshot(ctx, prior); err != nil {
				t.Fatal(err)
			}
			current := &quota.NormalizedQuota{AuthIndex: prior.AuthIndex, Provider: test.provider, Status: "healthy", ObservedAtMS: prior.ObservedAtMS + 1, Plan: &quota.QuotaPlan{PlanType: test.planType, PlanLabel: test.label, Tier: test.tier}}
			if err := handler.persistNormalizedQuotaSnapshot(ctx, current); err != nil {
				t.Fatal(err)
			}
			restored := handler.loadPriorNormalizedQuota(ctx, prior.AuthIndex)
			if restored == nil || restored.Plan == nil || restored.Plan.PlanType != test.planType || restored.Plan.PlanLabel != test.label || restored.Plan.Tier != test.tier {
				t.Fatalf("plan was not preserved: %+v", restored)
			}
			history, err := handler.repo.GetQuotaSnapshotHistory(ctx, prior.AuthIndex, 10)
			if err != nil || len(history) != 2 {
				t.Fatalf("history count = %d, err = %v", len(history), err)
			}
			if oldPlan := planFromSnapshot(history[1]); oldPlan == nil || oldPlan.PlanLabel != "Previous label" {
				t.Fatalf("historical plan was rewritten: %+v", oldPlan)
			}
		})
	}
}

func TestBatchQuotaRefreshPreservesEmptyQuotasAndTotal(t *testing.T) {
	fakeCPA := newFakeCPA(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		if strings.HasPrefix(request.URL.Path, "/v8/management/credentials") {
			_, _ = writer.Write([]byte(`{"files":[]}`))
			return
		}
		_, _ = writer.Write([]byte(`{}`))
	}))
	t.Cleanup(fakeCPA.Close)

	db, err := repository.Open(context.Background(), fmt.Sprintf("file:mem_quota_empty_batch_%d?mode=memory&cache=shared", time.Now().UnixNano()))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	repo := repository.New(db)
	cipher, err := crypto.New("01234567890123456789012345678901")
	if err != nil {
		t.Fatal(err)
	}
	ciphertext, nonce, err := cipher.Encrypt([]byte("cpa-management-secret"))
	if err != nil {
		t.Fatal(err)
	}
	if err := repo.UpsertInstance(context.Background(), domain.CPAInstance{
		ID:                      "default",
		Name:                    "Default",
		BaseURL:                 fakeCPA.URL,
		ManagementKeyCiphertext: ciphertext,
		ManagementKeyNonce:      nonce,
		CreatedAt:               time.Now().UTC(),
		UpdatedAt:               time.Now().UTC(),
	}); err != nil {
		t.Fatal(err)
	}
	authManager, err := auth.New("app-admin-secret", "", "")
	if err != nil {
		t.Fatal(err)
	}
	handler := NewHandler(config.Config{BasePath: "", CPA: config.CPAConfig{BaseURL: fakeCPA.URL, ManagementKey: "app-admin-secret"}}, repo, cipher, nil, authManager)
	appServer := httptest.NewServer(handler.Router())
	t.Cleanup(appServer.Close)

	client := signedInClient(t, appServer.URL+"/api/auth/login", "app-admin-secret")
	resp, err := client.Post(appServer.URL+"/api/v1/management/quota/refresh", "application/json", bytes.NewBufferString(`{"auth_indexes":["unknown-idx-1","unknown-idx-2"]}`))
	if err != nil {
		t.Fatalf("POST /quota/refresh failed: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	var rawBody bytes.Buffer
	if _, err := rawBody.ReadFrom(resp.Body); err != nil {
		t.Fatal(err)
	}
	const want = `{"status":"ok","quotas":[],"total":0}`
	if strings.TrimSpace(rawBody.String()) != want {
		t.Fatalf("body = %s, want %s", strings.TrimSpace(rawBody.String()), want)
	}
}
