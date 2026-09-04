package quota

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/management"
)

type mockCPAClient struct {
	apiCallFunc   func(ctx context.Context, req management.ApiCallRequest) (management.ApiCallResponse, error)
	resetQuotaFn  func(ctx context.Context, authIndex string) error
	authFilesFunc func(ctx context.Context) (management.AuthFilesResponse, error)
}

func (m *mockCPAClient) ApiCall(ctx context.Context, req management.ApiCallRequest) (management.ApiCallResponse, error) {
	if m.apiCallFunc != nil {
		return m.apiCallFunc(ctx, req)
	}
	return management.ApiCallResponse{}, errors.New("unimplemented")
}

func (m *mockCPAClient) ResetQuota(ctx context.Context, authIndex string) error {
	if m.resetQuotaFn != nil {
		return m.resetQuotaFn(ctx, authIndex)
	}
	return nil
}

func (m *mockCPAClient) AuthFiles(ctx context.Context) (management.AuthFilesResponse, error) {
	if m.authFilesFunc != nil {
		return m.authFilesFunc(ctx)
	}
	return management.AuthFilesResponse{}, nil
}

func TestSSRFProtection(t *testing.T) {
	svc := NewService(&mockCPAClient{})

	// Malicious / internal / external arbitrary URLs should all be rejected
	for _, badURL := range []string{
		"http://169.254.169.254/latest/meta-data/",
		"https://evil.attacker.com/steal-token",
		"https://chatgpt.com.attacker.com/api",
		"file:///etc/passwd",
		"http://localhost:8080/admin",
	} {
		_, err := svc.SafeApiCall(context.Background(), "auth-1", "GET", badURL, nil, "")
		if err == nil {
			t.Errorf("expected SSRF error for %q, but got nil", badURL)
		}
	}

	// Allowed URL should pass allowlist check
	if !IsAllowedQuotaURL(CodexUsageURL) {
		t.Errorf("expected %q to be allowed", CodexUsageURL)
	}
}

func TestServiceRefreshPreservesPreviousStateOnTransientError(t *testing.T) {
	client := &mockCPAClient{
		apiCallFunc: func(ctx context.Context, req management.ApiCallRequest) (management.ApiCallResponse, error) {
			return management.ApiCallResponse{}, errors.New("upstream gateway timeout 504")
		},
	}
	svc := NewService(client)

	used := 20.0
	rem := 80.0
	prior := &NormalizedQuota{
		AuthIndex: "auth-1",
		Status:    "healthy",
		Windows: []QuotaWindow{
			{
				ID:               "five_hour",
				Label:            "5-Hour Window",
				UsedPercent:      &used,
				RemainingPercent: &rem,
			},
		},
		Plan: &QuotaPlan{
			PlanType:  "pro",
			PlanLabel: "Pro 20x",
			Tier:      "elite",
		},
	}

	res, err := svc.RefreshCredentialQuota(context.Background(), management.AuthFile{
		AuthIndex: "auth-1",
		Name:      "test.json",
		Type:      "codex",
		Provider:  "codex",
	}, prior)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	// Should mark status as stale and preserve prior windows
	if res.Status != "stale" {
		t.Errorf("status = %q, want stale", res.Status)
	}
	if len(res.Windows) != 1 {
		t.Fatalf("len(windows) = %d, want 1 preserved", len(res.Windows))
	}
	if res.Plan == nil || res.Plan.Tier != "elite" {
		t.Errorf("plan not preserved: %+v", res.Plan)
	}
	if res.Error == "" {
		t.Errorf("expected error message to be captured")
	}
}

func TestRecommendationEngine(t *testing.T) {
	nowMS := time.Now().UnixMilli()

	// 1. Cooldown active
	q1 := &NormalizedQuota{
		ActiveCooldown: &ActiveCooldown{
			IsActive: true,
			Reason:   "HTTP 429 Too Many Requests",
		},
	}
	EvaluateStatusAndRecommendation(q1, nowMS)
	if q1.Status != "cooldown" || q1.Recommendation.Action != "clear_cooldown" || q1.Recommendation.Priority != "high" {
		t.Errorf("q1 = %+v", q1)
	}

	// 2. Exhausted with Codex credits available
	used100 := 100.0
	rem0 := 0.0
	q2 := &NormalizedQuota{
		Windows: []QuotaWindow{
			{UsedPercent: &used100, RemainingPercent: &rem0},
		},
		ResetCredits: &CodexResetCreditsInfo{
			AvailableCount: 1,
		},
	}
	EvaluateStatusAndRecommendation(q2, nowMS)
	if q2.Status != "exhausted" || q2.Recommendation.Action != "redeem_credit" || q2.Recommendation.Status != "credits_available" {
		t.Errorf("q2 = %+v", q2)
	}

	// 3. Auth failure
	q3 := &NormalizedQuota{
		Error: "HTTP 401 Unauthorized: token expired",
	}
	EvaluateStatusAndRecommendation(q3, nowMS)
	if q3.Status != "error" || q3.Recommendation.Action != "reauth" || q3.Recommendation.Priority != "critical" {
		t.Errorf("q3 = %+v", q3)
	}
}

func TestRedeemCodexCreditCallsConsumeEndpoint(t *testing.T) {
	var calledURL string
	var calledBody string

	client := &mockCPAClient{
		apiCallFunc: func(ctx context.Context, req management.ApiCallRequest) (management.ApiCallResponse, error) {
			calledURL = req.URL
			calledBody = req.Data
			return management.ApiCallResponse{
				StatusCode: 200,
				Body:       json.RawMessage(`{"status":"ok"}`),
			}, nil
		},
	}

	svc := NewService(client)
	err := svc.RedeemCodexCredit(context.Background(), "auth-codex")
	if err != nil {
		t.Fatalf("RedeemCodexCredit error: %v", err)
	}

	if calledURL != CodexRedeemCreditURL {
		t.Errorf("calledURL = %q, want %q", calledURL, CodexRedeemCreditURL)
	}
	if !containsStr(calledBody, "redeem_request_id") {
		t.Errorf("calledBody missing redeem_request_id: %s", calledBody)
	}
}

func TestServiceAllProvidersContract(t *testing.T) {
	calledURLs := make(map[string]bool)
	calledHeaders := make(map[string]map[string]string)

	client := &mockCPAClient{
		apiCallFunc: func(ctx context.Context, req management.ApiCallRequest) (management.ApiCallResponse, error) {
			calledURLs[req.URL] = true
			calledHeaders[req.URL] = req.Header

			switch {
			case strings.Contains(req.URL, "retrieveUserQuotaSummary"):
				return management.ApiCallResponse{
					StatusCode: 200,
					Body:       json.RawMessage(`{"groups":[{"displayName":"Gemini models","buckets":[{"bucketId":"5h","window":"5h","remainingFraction":0.8}]}]}`),
				}, nil
			case strings.Contains(req.URL, "oauth/profile"):
				return management.ApiCallResponse{
					StatusCode: 200,
					Body:       json.RawMessage(`{"account":{"has_claude_pro":true}}`),
				}, nil
			case strings.Contains(req.URL, "oauth/usage"):
				return management.ApiCallResponse{
					StatusCode: 200,
					Body:       json.RawMessage(`{"five_hour":{"utilization":30}}`),
				}, nil
			case strings.Contains(req.URL, "backend-api/wham/usage"):
				return management.ApiCallResponse{
					StatusCode: 200,
					Body:       json.RawMessage(`{"plan_type":"pro","rate_limit":{"primary_window":{"used_percent":20}}}`),
				}, nil
			case strings.Contains(req.URL, "coding/v1/usages"):
				return management.ApiCallResponse{
					StatusCode: 200,
					Body:       json.RawMessage(`{"limits":[{"name":"daily","used":10,"limit":100}]}`),
				}, nil
			case strings.Contains(req.URL, "cli-chat-proxy.grok.com"):
				return management.ApiCallResponse{
					StatusCode: 200,
					Body:       json.RawMessage(`{"config":{"credit_usage_percent":40}}`),
				}, nil
			default:
				return management.ApiCallResponse{StatusCode: 404}, nil
			}
		},
	}

	svc := NewService(client)

	// 1. Antigravity
	agFile := management.AuthFile{
		AuthIndex: "ag-1",
		Name:      "antigravity.json",
		Type:      "antigravity",
		Provider:  "antigravity",
		ProjectID: "my-gcp-project",
	}
	agRes, err := svc.RefreshCredentialQuota(context.Background(), agFile, nil)
	if err != nil || agRes.Status != "healthy" || len(agRes.Windows) == 0 {
		t.Fatalf("antigravity refresh failed: %v, res: %+v", err, agRes)
	}
	if !calledURLs[AntigravityQuotaURLDaily] {
		t.Errorf("expected Antigravity URL to be called")
	}

	// 2. Claude
	claudeFile := management.AuthFile{
		AuthIndex: "cl-1",
		Name:      "claude.json",
		Type:      "claude",
		Provider:  "claude",
	}
	clRes, err := svc.RefreshCredentialQuota(context.Background(), claudeFile, nil)
	if err != nil || clRes.Status != "healthy" || len(clRes.Windows) == 0 {
		t.Fatalf("claude refresh failed: %v, res: %+v", err, clRes)
	}
	if !calledURLs[ClaudeUsageURL] || !calledURLs[ClaudeProfileURL] {
		t.Errorf("expected Claude URLs to be called")
	}

	// 3. Codex
	codexFile := management.AuthFile{
		AuthIndex: "cx-1",
		Name:      "codex.json",
		Type:      "codex",
		Provider:  "codex",
		Account:   "acc-openai-123",
	}
	cxRes, err := svc.RefreshCredentialQuota(context.Background(), codexFile, nil)
	if err != nil || cxRes.Status != "healthy" || len(cxRes.Windows) == 0 {
		t.Fatalf("codex refresh failed: %v, res: %+v", err, cxRes)
	}
	if !calledURLs[CodexUsageURL] {
		t.Errorf("expected Codex URL to be called")
	}
	if calledHeaders[CodexUsageURL]["Openai-Account-Id"] != "acc-openai-123" {
		t.Errorf("expected Openai-Account-Id header on codex call")
	}

	// 4. Kimi
	kimiFile := management.AuthFile{
		AuthIndex: "km-1",
		Name:      "kimi.json",
		Type:      "kimi",
		Provider:  "kimi",
	}
	kmRes, err := svc.RefreshCredentialQuota(context.Background(), kimiFile, nil)
	if err != nil || kmRes.Status != "healthy" || len(kmRes.Windows) == 0 {
		t.Fatalf("kimi refresh failed: %v, res: %+v", err, kmRes)
	}
	if !calledURLs[KimiUsageURL] {
		t.Errorf("expected Kimi URL to be called")
	}

	// 5. xAI
	xaiFile := management.AuthFile{
		AuthIndex: "xa-1",
		Name:      "xai.json",
		Type:      "xai",
		Provider:  "xai",
	}
	xaRes, err := svc.RefreshCredentialQuota(context.Background(), xaiFile, nil)
	if err != nil || xaRes.Status != "healthy" || len(xaRes.Windows) == 0 {
		t.Fatalf("xai refresh failed: %v, res: %+v", err, xaRes)
	}
	if !calledURLs[XaiBillingMonthlyURL] {
		t.Errorf("expected xAI billing URL to be called")
	}
}

func containsStr(s, sub string) bool {
	return len(s) >= len(sub) && (s == sub || len(sub) == 0 || (len(s) > 0 && len(sub) > 0 && stringContains(s, sub)))
}

func stringContains(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}
