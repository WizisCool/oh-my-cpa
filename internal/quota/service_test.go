package quota

import (
	"context"
	"encoding/json"
	"errors"
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

	res, err := svc.RefreshCredentialQuota(context.Background(), "auth-1", "test.json", "codex", "codex", false, prior)
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
