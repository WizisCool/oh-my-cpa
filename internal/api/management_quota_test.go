package api

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/crypto"
	"github.com/oh-my-cpa/oh-my-cpa/internal/domain"
	"github.com/oh-my-cpa/oh-my-cpa/internal/quota"
	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
)

func TestManagementQuotaEndpoints(t *testing.T) {
	const managementKey = "management-secret"

	var cpaResetCalledWith string
	var cpaApiCallCalledWith string

	cpaServer := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Header.Get("Authorization") != "Bearer "+managementKey {
			writer.WriteHeader(http.StatusUnauthorized)
			return
		}
		writer.Header().Set("Content-Type", "application/json")

		switch request.URL.Path {
		case "/v0/management/auth-files":
			_, _ = writer.Write([]byte(`{
				"files": [
					{
						"id": "file-1",
						"name": "codex-main.json",
						"auth_index": "codex-idx-1",
						"type": "codex",
						"provider": "codex",
						"disabled": false
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

		case "/v0/management/reset-quota":
			var payload struct {
				AuthIndex string `json:"auth_index"`
			}
			_ = json.NewDecoder(request.Body).Decode(&payload)
			cpaResetCalledWith = payload.AuthIndex
			_, _ = writer.Write([]byte(`{"status":"ok"}`))

		case "/v0/management/api-call":
			var payload struct {
				AuthIndex string `json:"auth_index"`
				URL       string `json:"url"`
			}
			_ = json.NewDecoder(request.Body).Decode(&payload)
			_ = cpaApiCallCalledWith
			cpaApiCallCalledWith = payload.URL

			if strings.Contains(payload.URL, "rate_limits/reset_credits/consume") {
				_, _ = writer.Write([]byte(`{
					"status_code": 200,
					"body": {"status": "ok"}
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

	jar, err := cookiejar.New(nil)
	if err != nil {
		t.Fatal(err)
	}
	client := &http.Client{Jar: jar}

	// Login
	loginResp, err := client.Post(appServer.URL+"/api/auth/login", "application/json", bytes.NewBufferString(`{"password":"management-secret"}`))
	if err != nil {
		t.Fatal(err)
	}
	loginResp.Body.Close()

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
		Status string               `json:"status"`
		Quota  quota.NormalizedQuota `json:"quota"`
	}
	if err := json.NewDecoder(refResp.Body).Decode(&refreshResult); err != nil {
		t.Fatalf("decode refresh result failed: %v", err)
	}

	if refreshResult.Quota.Plan == nil || refreshResult.Quota.Plan.Tier != "elite" {
		t.Errorf("plan = %+v, want elite", refreshResult.Quota.Plan)
	}
	if len(refreshResult.Quota.Windows) != 1 || *refreshResult.Quota.Windows[0].UsedPercent != 15.0 {
		t.Errorf("windows = %+v, want 15%% used", refreshResult.Quota.Windows)
	}
	if refreshResult.Quota.ResetCredits == nil || refreshResult.Quota.ResetCredits.AvailableCount != 2 {
		t.Errorf("reset credits = %+v, want 2", refreshResult.Quota.ResetCredits)
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
	redeemResp, err := client.Post(appServer.URL+"/api/v1/management/quota/redeem-credit", "application/json", bytes.NewBufferString(`{"auth_index":"codex-idx-1"}`))
	if err != nil {
		t.Fatalf("POST /redeem-credit failed: %v", err)
	}
	defer redeemResp.Body.Close()

	if redeemResp.StatusCode != http.StatusOK {
		t.Fatalf("redeem-credit status = %d, want 200", redeemResp.StatusCode)
	}

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
		Quota   quota.NormalizedQuota          `json:"quota"`
		History []repository.QuotaSnapshotRecord `json:"history"`
	}
	if err := json.NewDecoder(detailResp.Body).Decode(&detailResult); err != nil {
		t.Fatalf("decode detail failed: %v", err)
	}

	if len(detailResult.History) == 0 {
		t.Errorf("expected snapshot history to be persisted")
	}
}
