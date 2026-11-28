package quota

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/management"
)

type mockCPAClient struct {
	apiCallFunc   func(ctx context.Context, req management.ApiCallRequest) (management.ApiCallResponse, error)
	resetQuotaFn  func(ctx context.Context, authIndex string) error
	authFilesFunc func(ctx context.Context) (management.AuthFilesResponse, error)
	pluginsFunc   func(ctx context.Context) ([]management.PluginItem, error)
	pluginQuotaFn func(ctx context.Context, pluginID, authIndex string) (json.RawMessage, error)
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

func (m *mockCPAClient) Plugins(ctx context.Context) ([]management.PluginItem, error) {
	if m.pluginsFunc != nil {
		return m.pluginsFunc(ctx)
	}
	return nil, errors.New("unimplemented")
}

func (m *mockCPAClient) FetchPluginQuota(ctx context.Context, pluginID, authIndex string) (json.RawMessage, error) {
	if m.pluginQuotaFn != nil {
		return m.pluginQuotaFn(ctx, pluginID, authIndex)
	}
	return nil, errors.New("unimplemented")
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
	svc := NewService(client).WithClaudeResetGrantsDelay(0)

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
			PlanLabel: "Pro 200",
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
	quotaAuthErr := &NormalizedQuota{
		Error: "HTTP 401 Unauthorized: token expired",
	}
	EvaluateStatusAndRecommendation(quotaAuthErr, nowMS)
	if quotaAuthErr.Status != "error" || quotaAuthErr.Recommendation.Action != "reauth" || quotaAuthErr.Recommendation.Priority != "critical" {
		t.Errorf("quotaAuthErr = %+v", quotaAuthErr)
	}

	// 4. An auth-looking substring inside an unrelated number or word must stay
	// transient rather than telling the operator to rotate the credential.
	for _, transient := range []string{"request id 14013 timed out", "author service timeout", "40100 bytes read before timeout"} {
		q := &NormalizedQuota{Error: transient}
		EvaluateStatusAndRecommendation(q, nowMS)
		if q.Recommendation.Action != "refresh" {
			t.Errorf("transient %q classified as %+v", transient, q.Recommendation)
		}
	}

	// 5. An expired cooldown must not mask the current window state.
	expiredRecover := nowMS - 1
	remaining := 50.0
	qExpired := &NormalizedQuota{
		ActiveCooldown: &ActiveCooldown{IsActive: true, RecoverAtMS: &expiredRecover},
		Windows:        []QuotaWindow{{RemainingPercent: &remaining}},
	}
	EvaluateStatusAndRecommendation(qExpired, nowMS)
	if qExpired.Status != "healthy" || qExpired.ActiveCooldown.IsActive {
		t.Errorf("expired cooldown still active: %+v", qExpired)
	}
}

const availableCodexResetCreditsJSON = `{"available_count":3,"credits":[
  {"id":"credit-oldest-grant","status":"available","reset_type":"codex_rate_limits","granted_at":"2026-11-13T00:00:00Z","expires_at":"2099-12-13T00:00:00Z"},
  {"id":"credit-earliest-expiry","status":"available","reset_type":"codex_rate_limits","granted_at":"2026-11-25T00:00:00Z","expires_at":"2099-12-03T00:00:00Z"},
  {"id":"credit-latest-expiry","status":"available","reset_type":"codex_rate_limits","granted_at":"2026-11-26T00:00:00Z","expires_at":"2099-12-26T00:00:00Z"}
]}`

func TestRedeemCodexCreditCallsConsumeEndpoint(t *testing.T) {
	var calledURL string
	var calledMethod string
	var calledAuthIndex string
	var calledBody string
	var calledHeaders map[string]string
	var creditRequests []string

	client := &mockCPAClient{
		apiCallFunc: func(ctx context.Context, req management.ApiCallRequest) (management.ApiCallResponse, error) {
			creditRequests = append(creditRequests, req.URL)
			if req.URL == CodexResetCreditsURL {
				if req.Method != http.MethodGet || req.Data != "" || req.AuthIndex != "auth-codex" {
					t.Errorf("credit list request = %+v, want a fresh read for auth-codex", req)
				}
				if req.Header["Chatgpt-Account-Id"] != "acct-openai-123" || req.Header["Authorization"] != management.QuotaTokenPlaceholder {
					t.Errorf("credit list was not scoped to the redemption account: %+v", req.Header)
				}
				return management.ApiCallResponse{StatusCode: 200, Body: json.RawMessage(availableCodexResetCreditsJSON)}, nil
			}
			calledURL = req.URL
			calledMethod = req.Method
			calledAuthIndex = req.AuthIndex
			calledBody = req.Data
			calledHeaders = req.Header
			return management.ApiCallResponse{
				StatusCode: 200,
				Body:       json.RawMessage(`{"code":"reset"}`),
			}, nil
		},
	}

	svc := NewService(client).WithClaudeResetGrantsDelay(0)
	redeemedID, err := svc.RedeemCodexCredit(context.Background(), management.AuthFile{
		AuthIndex: "auth-codex",
		Name:      "codex.json",
		Type:      "codex",
		Provider:  "codex",
		// The consume route must carry the credential's own ChatGPT account, exactly like
		// the read probes, so a credit is spent under the account it was read from.
		IDToken: json.RawMessage(`{"chatgpt_account_id":"acct-openai-123"}`),
	}, "")
	if err != nil {
		t.Fatalf("RedeemCodexCredit error: %v", err)
	}
	if redeemedID != "credit-earliest-expiry" {
		t.Errorf("redeemed credit ID = %q, want credit-earliest-expiry", redeemedID)
	}
	if len(creditRequests) != 2 || creditRequests[0] != CodexResetCreditsURL || creditRequests[1] != CodexRedeemCreditURL {
		t.Fatalf("credit requests = %v, want one fresh list read followed by one consume", creditRequests)
	}

	if calledURL != CodexRedeemCreditURL {
		t.Errorf("calledURL = %q, want %q", calledURL, CodexRedeemCreditURL)
	}
	if calledMethod != http.MethodPost {
		t.Errorf("calledMethod = %q, want POST", calledMethod)
	}
	if calledAuthIndex != "auth-codex" {
		t.Errorf("calledAuthIndex = %q, want auth-codex", calledAuthIndex)
	}
	if calledHeaders["Chatgpt-Account-Id"] != "acct-openai-123" {
		t.Errorf("Chatgpt-Account-Id = %q, want acct-openai-123", calledHeaders["Chatgpt-Account-Id"])
	}
	if calledHeaders["Authorization"] != management.QuotaTokenPlaceholder {
		t.Errorf("Authorization = %q, want the CPA credential marker", calledHeaders["Authorization"])
	}

	var body struct {
		CreditID        string `json:"credit_id"`
		RedeemRequestID string `json:"redeem_request_id"`
	}
	if err := json.Unmarshal([]byte(calledBody), &body); err != nil {
		t.Fatalf("consume body is not JSON: %q", calledBody)
	}
	if _, err := uuid.Parse(body.RedeemRequestID); err != nil {
		t.Errorf("redeem_request_id = %q, want a UUID: %v", body.RedeemRequestID, err)
	}
	if body.CreditID != "credit-earliest-expiry" {
		t.Errorf("credit_id = %q, want the earliest expiry rather than the oldest grant", body.CreditID)
	}
}

// A credential whose account id cannot be resolved still redeems: the account header
// keeps the redemption aligned with the quota reads, it is not a precondition.
func TestRedeemCodexCreditOmitsAccountHeaderWhenUnresolved(t *testing.T) {
	var calledHeaders map[string]string

	client := &mockCPAClient{
		apiCallFunc: func(ctx context.Context, req management.ApiCallRequest) (management.ApiCallResponse, error) {
			calledHeaders = req.Header
			if req.URL == CodexResetCreditsURL {
				return management.ApiCallResponse{StatusCode: 200, Body: json.RawMessage(availableCodexResetCreditsJSON)}, nil
			}
			return management.ApiCallResponse{StatusCode: 200, Body: json.RawMessage(`{"code":"reset"}`)}, nil
		},
	}

	_, err := NewService(client).RedeemCodexCredit(context.Background(), management.AuthFile{
		AuthIndex: "auth-codex",
		Name:      "codex.json",
		Type:      "codex",
		Provider:  "codex",
	}, "")
	if err != nil {
		t.Fatalf("RedeemCodexCredit error: %v", err)
	}
	if _, ok := calledHeaders["Chatgpt-Account-Id"]; ok {
		t.Errorf("Chatgpt-Account-Id = %q, want it omitted", calledHeaders["Chatgpt-Account-Id"])
	}
}

// Only an explicit upstream confirmation spends a credit: a 2xx without a
// reset/already_redeemed code is an unknown outcome, and the operator refreshes
// and decides instead of blindly spending another credit on retry.
func TestRedeemCodexCreditRequiresUpstreamConfirmation(t *testing.T) {
	for _, testCase := range []struct {
		name    string
		body    string
		wantErr bool
	}{
		{name: "reset confirmed", body: `{"code":"reset"}`, wantErr: false},
		{name: "already redeemed", body: `{"code":"already_redeemed"}`, wantErr: false},
		{name: "missing code", body: `{}`, wantErr: true},
		{name: "unconfirmed code", body: `{"code":"pending"}`, wantErr: true},
		{name: "not JSON", body: `reset`, wantErr: true},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			client := &mockCPAClient{
				apiCallFunc: func(ctx context.Context, req management.ApiCallRequest) (management.ApiCallResponse, error) {
					if req.URL == CodexResetCreditsURL {
						return management.ApiCallResponse{StatusCode: 200, Body: json.RawMessage(availableCodexResetCreditsJSON)}, nil
					}
					return management.ApiCallResponse{StatusCode: 200, Body: json.RawMessage(testCase.body)}, nil
				},
			}
			_, err := NewService(client).RedeemCodexCredit(context.Background(), management.AuthFile{
				AuthIndex: "auth-codex",
				Name:      "codex.json",
				Type:      "codex",
				Provider:  "codex",
			}, "")
			if testCase.wantErr && err == nil {
				t.Fatalf("RedeemCodexCredit with body %q succeeded, want an error", testCase.body)
			}
			if !testCase.wantErr && err != nil {
				t.Fatalf("RedeemCodexCredit with body %q failed: %v", testCase.body, err)
			}
		})
	}
}

func TestRedeemCodexCreditRejectsUnreadableOrUnusableBankWithoutConsuming(t *testing.T) {
	for _, testCase := range []struct {
		name    string
		status  int
		body    string
		wantErr error
	}{
		{name: "read unavailable", status: http.StatusServiceUnavailable, body: `{}`, wantErr: ErrCodexResetCreditBankUnreadable},
		{name: "invalid response", status: http.StatusOK, body: `not json`, wantErr: ErrCodexResetCreditBankUnreadable},
		{name: "count without ids", status: http.StatusOK, body: `{"available_count":3}`, wantErr: ErrNoEligibleCodexResetCredit},
		{name: "empty bank", status: http.StatusOK, body: `{"available_count":0,"credits":[]}`, wantErr: ErrNoEligibleCodexResetCredit},
		{name: "expired card", status: http.StatusOK, body: `{"available_count":1,"credits":[{"id":"expired","status":"available","expires_at":"2000-01-01T00:00:00Z"}]}`, wantErr: ErrNoEligibleCodexResetCredit},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			consumeCalls := 0
			client := &mockCPAClient{apiCallFunc: func(ctx context.Context, req management.ApiCallRequest) (management.ApiCallResponse, error) {
				if req.URL == CodexResetCreditsURL && req.Method == http.MethodGet {
					return management.ApiCallResponse{StatusCode: testCase.status, Body: json.RawMessage(testCase.body)}, nil
				}
				consumeCalls++
				return management.ApiCallResponse{StatusCode: http.StatusOK, Body: json.RawMessage(`{"code":"reset"}`)}, nil
			}}
			_, err := NewService(client).RedeemCodexCredit(context.Background(), management.AuthFile{AuthIndex: "auth-codex"}, "")
			if !errors.Is(err, testCase.wantErr) || consumeCalls != 0 {
				t.Fatalf("unusable credit bank: err=%v (want %v) consume calls=%d, want rejection without consumption", err, testCase.wantErr, consumeCalls)
			}
		})
	}
}

func TestRedeemCodexCreditSkipsUnusableCardsAndOrdersByExpiryThenGrant(t *testing.T) {
	// Padded whitespace on the winning credit verifies selection normalizes
	// status/ID the same way parseCodexResetCreditsSummary does.
	const bank = `{"available_count":5,"credits":[
        {"id":"undated","status":"available","granted_at":"2020-01-01T00:00:00Z"},
        {"id":"expired","status":"available","expires_at":"2000-01-01T00:00:00Z"},
        {"id":"clock-expired","status":"available","expires_at":"2098-01-01T00:00:00Z"},
        {"id":"spent","status":"used","expires_at":"2098-01-01T00:00:00Z"},
        {"id":"wrong-reset-type","status":"available","reset_type":"other","expires_at":"2098-01-01T00:00:00Z"},
        {"id":"later-grant","status":"available","granted_at":"2026-11-26T00:00:00Z","expires_at":"2099-01-01T00:00:00Z"},
        {"id":" earlier-grant ","status":" available ","granted_at":"2026-11-13T00:00:00Z","expires_at":"2099-01-01T00:00:00Z"}
    ]}`
	consumeCalls := 0
	client := &mockCPAClient{apiCallFunc: func(ctx context.Context, req management.ApiCallRequest) (management.ApiCallResponse, error) {
		if req.URL == CodexResetCreditsURL {
			return management.ApiCallResponse{StatusCode: http.StatusOK, Body: json.RawMessage(bank)}, nil
		}
		consumeCalls++
		var body struct {
			CreditID string `json:"credit_id"`
		}
		if err := json.Unmarshal([]byte(req.Data), &body); err != nil {
			t.Fatal(err)
		}
		if body.CreditID != "earlier-grant" {
			t.Errorf("credit_id = %q, want earliest eligible expiry and then earliest grant", body.CreditID)
		}
		return management.ApiCallResponse{StatusCode: http.StatusOK, Body: json.RawMessage(`{"code":"reset"}`)}, nil
	}}
	// A card that still appears valid to wall time has expired under this clock.
	svc := NewServiceWithClock(client, func() time.Time {
		return time.Date(2098, time.December, 31, 0, 0, 0, 0, time.UTC)
	})
	if redeemedID, err := svc.RedeemCodexCredit(context.Background(), management.AuthFile{AuthIndex: "auth-codex"}, ""); err != nil {
		t.Fatal(err)
	} else if redeemedID != "earlier-grant" {
		t.Errorf("redeemed credit ID = %q, want earlier-grant", redeemedID)
	}
	if consumeCalls != 1 {
		t.Fatalf("consume calls = %d, want exactly one", consumeCalls)
	}
}

func TestRedeemCodexCreditHonorsExplicitCreditIDAndFailsClosedWhenUnavailable(t *testing.T) {
	t.Run("redeems explicitly requested non-earliest credit", func(t *testing.T) {
		var sentCreditID string
		client := &mockCPAClient{apiCallFunc: func(ctx context.Context, req management.ApiCallRequest) (management.ApiCallResponse, error) {
			if req.URL == CodexResetCreditsURL {
				return management.ApiCallResponse{StatusCode: http.StatusOK, Body: json.RawMessage(availableCodexResetCreditsJSON)}, nil
			}
			var body struct {
				CreditID string `json:"credit_id"`
			}
			if err := json.Unmarshal([]byte(req.Data), &body); err != nil {
				t.Fatal(err)
			}
			sentCreditID = body.CreditID
			return management.ApiCallResponse{StatusCode: http.StatusOK, Body: json.RawMessage(`{"code":"reset"}`)}, nil
		}}
		redeemedID, err := NewService(client).RedeemCodexCredit(context.Background(), management.AuthFile{AuthIndex: "auth-codex"}, " credit-latest-expiry ")
		if err != nil {
			t.Fatalf("RedeemCodexCredit error: %v", err)
		}
		if sentCreditID != "credit-latest-expiry" || redeemedID != "credit-latest-expiry" {
			t.Fatalf("sent=%q returned=%q, want credit-latest-expiry", sentCreditID, redeemedID)
		}
	})

	for _, tc := range []struct {
		name      string
		requested string
	}{
		{name: "unknown id", requested: "credit-missing"},
		{name: "spent card", requested: "spent"},
		{name: "expired card", requested: "expired"},
	} {
		t.Run("refuses "+tc.name+" without falling back", func(t *testing.T) {
			const bank = `{"available_count":2,"credits":[
				{"id":"valid-earliest","status":"available","expires_at":"2099-01-01T00:00:00Z"},
				{"id":"spent","status":"used","expires_at":"2099-02-01T00:00:00Z"},
				{"id":"expired","status":"available","expires_at":"2000-01-01T00:00:00Z"}
			]}`
			consumeCalls := 0
			client := &mockCPAClient{apiCallFunc: func(ctx context.Context, req management.ApiCallRequest) (management.ApiCallResponse, error) {
				if req.URL == CodexResetCreditsURL {
					return management.ApiCallResponse{StatusCode: http.StatusOK, Body: json.RawMessage(bank)}, nil
				}
				consumeCalls++
				return management.ApiCallResponse{StatusCode: http.StatusOK, Body: json.RawMessage(`{"code":"reset"}`)}, nil
			}}
			redeemedID, err := NewService(client).RedeemCodexCredit(context.Background(), management.AuthFile{AuthIndex: "auth-codex"}, tc.requested)
			if !errors.Is(err, ErrRequestedCodexResetCreditUnavailable) || redeemedID != "" || consumeCalls != 0 {
				t.Fatalf("requested %q: id=%q err=%v consumeCalls=%d, want ErrRequestedCodexResetCreditUnavailable with 0 consumes", tc.requested, redeemedID, err, consumeCalls)
			}
		})
	}
}

func TestRefreshCredentialQuotaAttachesClaudeResetGrants(t *testing.T) {
	// The grants read is supplementary: it must use the grant program's query
	// on the same usage endpoint, and its failure must not fail the refresh.
	// No test here spends anything; the claim path does not exist.
	var grantsURL string
	var grantsHeaders map[string]string
	client := &mockCPAClient{
		apiCallFunc: func(ctx context.Context, req management.ApiCallRequest) (management.ApiCallResponse, error) {
			switch {
			case strings.Contains(req.URL, "cedar_ember"):
				grantsURL = req.URL
				grantsHeaders = req.Header
				return management.ApiCallResponse{StatusCode: 200, Body: json.RawMessage(
					`{"cedar_ember":{"eligible":true,"grants":[{"id":"grant-9","label":"Weekly","resets_total":3,"resets_left":2,"ends_at":"2026-10-09T00:00:00Z"}]}}`)}, nil
			case strings.Contains(req.URL, "oauth/usage"):
				return management.ApiCallResponse{StatusCode: 200, Body: json.RawMessage(`{"five_hour":{"utilization":30}}`)}, nil
			case strings.Contains(req.URL, "oauth/profile"):
				return management.ApiCallResponse{StatusCode: 200, Body: json.RawMessage(`{"account":{"has_claude_pro":true}}`)}, nil
			}
			return management.ApiCallResponse{}, errors.New("unimplemented")
		},
	}
	result, err := NewService(client).WithClaudeResetGrantsDelay(0).RefreshCredentialQuota(context.Background(), management.AuthFile{
		AuthIndex: "auth-claude",
		Name:      "claude.json",
		Type:      "claude",
		Provider:  "claude",
	}, nil)
	if err != nil {
		t.Fatalf("RefreshCredentialQuota error: %v", err)
	}
	if !strings.Contains(grantsURL, "cedar_ember=1") || !strings.Contains(grantsURL, "skip_spend=1") {
		t.Fatalf("grants URL = %q, want the grant program query", grantsURL)
	}
	// Without a Claude Code identity the program reports every account as
	// ineligible with no grants, so the display would stay empty.
	if grantsHeaders["User-Agent"] != ClaudeCLIUserAgent || grantsHeaders["x-app"] != "cli" {
		t.Fatalf("grants headers = %v, want the Claude Code client identity", grantsHeaders)
	}
	if len(result.ResetGrants) != 1 || result.ResetGrants[0].ID != "grant-9" || result.ResetGrants[0].ResetsLeft != 2 {
		t.Fatalf("reset grants = %+v, want the weekly grant", result.ResetGrants)
	}
	if len(result.Windows) == 0 {
		t.Fatal("grants read must not displace the quota windows")
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

	svc := NewService(client).WithClaudeResetGrantsDelay(0)

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
	if calledHeaders[CodexUsageURL]["Chatgpt-Account-Id"] != "acc-openai-123" {
		t.Errorf("expected Chatgpt-Account-Id header on codex call, got %q", calledHeaders[CodexUsageURL]["Chatgpt-Account-Id"])
	}
	if calledHeaders[CodexUsageURL]["Authorization"] != "Bearer $TOKEN$" {
		t.Errorf("expected CPA credential marker on codex call, got %q", calledHeaders[CodexUsageURL]["Authorization"])
	}
	if calledHeaders[AntigravityQuotaURLDaily]["Authorization"] != "Bearer $TOKEN$" {
		t.Errorf("expected CPA credential marker on antigravity call, got %q", calledHeaders[AntigravityQuotaURLDaily]["Authorization"])
	}
	if calledHeaders[ClaudeUsageURL]["Authorization"] != "Bearer $TOKEN$" {
		t.Errorf("expected CPA credential marker on claude call, got %q", calledHeaders[ClaudeUsageURL]["Authorization"])
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
	if calledHeaders[KimiUsageURL]["Authorization"] != "Bearer $TOKEN$" {
		t.Errorf("expected CPA credential marker on kimi call, got %q", calledHeaders[KimiUsageURL]["Authorization"])
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
	// The credits document is the one that carries a subscription's own window, so a read that
	// skipped it left every SuperGrok credential looking like it had no usage.
	if !calledURLs[XaiBillingWeeklyURL] {
		t.Errorf("expected xAI credits URL to be called")
	}
	if calledHeaders[XaiBillingMonthlyURL]["Authorization"] != "Bearer $TOKEN$" {
		t.Errorf("expected CPA credential marker on xai call, got %q", calledHeaders[XaiBillingMonthlyURL]["Authorization"])
	}
}

const codexUsageFixture = `{
	"plan_type": "plus",
	"rate_limit": {
		"allowed": true,
		"limit_reached": false,
		"primary_window": {"used_percent": 12, "limit_window_seconds": 18000, "reset_after_seconds": 3600},
		"secondary_window": {"used_percent": 4, "limit_window_seconds": 604800, "reset_after_seconds": 86400}
	}
}`

// codexAuthFileWithStaleSnapshot models the reported defect: OpenAI minted a
// fresh id_token on 2026-09-16 that still carried the subscription window last
// checked on 2026-07-29 (ending 2026-08-29), while the account's live
// subscription had already rolled on to 2026-09-29.
func codexAuthFileWithStaleSnapshot() management.AuthFile {
	return management.AuthFile{
		AuthIndex: "auth-codex-1",
		Name:      "codex-ac9a73f2-example.json",
		Type:      "codex",
		Provider:  "codex",
		IDToken: json.RawMessage(`{
			"chatgpt_account_id": "dc47fe6f-9039-4023-9826-c8dcb4712c70",
			"plan_type": "plus",
			"chatgpt_subscription_active_start": "2026-07-29T14:02:31+00:00",
			"chatgpt_subscription_active_until": "2026-08-29T14:02:31+00:00"
		}`),
	}
}

func TestCodexRenewalPrefersLiveSubscriptionOverStaleSnapshot(t *testing.T) {
	var subscriptionURL string
	client := &mockCPAClient{
		apiCallFunc: func(ctx context.Context, req management.ApiCallRequest) (management.ApiCallResponse, error) {
			switch {
			case strings.HasPrefix(req.URL, CodexSubscriptionURL):
				subscriptionURL = req.URL
				return management.ApiCallResponse{
					StatusCode: 200,
					Body:       json.RawMessage(`{"plan_type":"plus","active_start":"2026-08-29T14:02:31Z","active_until":"2026-09-29T14:02:31Z","billing_period":"monthly","will_renew":true}`),
				}, nil
			case req.URL == CodexUsageURL:
				return management.ApiCallResponse{StatusCode: 200, Body: json.RawMessage(codexUsageFixture)}, nil
			default:
				return management.ApiCallResponse{StatusCode: 200, Body: json.RawMessage(`{"available_count":0,"credits":[]}`)}, nil
			}
		},
	}

	res, err := NewService(client).RefreshCredentialQuota(context.Background(), codexAuthFileWithStaleSnapshot(), nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if res.Plan == nil {
		t.Fatal("plan is nil")
	}

	if !strings.Contains(subscriptionURL, "account_id=dc47fe6f-9039-4023-9826-c8dcb4712c70") {
		t.Errorf("subscription probe URL = %q, want the credential's account id", subscriptionURL)
	}

	// The reported symptom was the 2026-08-29 snapshot surfacing as the renewal
	// date. The live window must win.
	wantStart := time.Date(2026, 8, 29, 14, 2, 31, 0, time.UTC).UnixMilli()
	want := time.Date(2026, 9, 29, 14, 2, 31, 0, time.UTC).UnixMilli()
	if res.Plan.StartsAtMS == nil || *res.Plan.StartsAtMS != wantStart {
		t.Errorf("StartsAtMS = %v, want the live %d", res.Plan.StartsAtMS, wantStart)
	}
	if res.Plan.ExpiresAtMS == nil || *res.Plan.ExpiresAtMS != want {
		t.Errorf("ExpiresAtMS = %v, want the live %d", res.Plan.ExpiresAtMS, want)
	}
	if res.Plan.ExpiresSource != PlanSourceLiveSubscription {
		t.Errorf("ExpiresSource = %q, want %q", res.Plan.ExpiresSource, PlanSourceLiveSubscription)
	}
	if res.Plan.BillingPeriod != BillingPeriodMonthly {
		t.Errorf("BillingPeriod = %q, want %q", res.Plan.BillingPeriod, BillingPeriodMonthly)
	}
	if res.Plan.IsAutoRenewing == nil || !*res.Plan.IsAutoRenewing {
		t.Errorf("IsAutoRenewing = %v, want true", res.Plan.IsAutoRenewing)
	}
}

func TestCodexRenewalFallsBackToTaggedSnapshotWhenProbeFails(t *testing.T) {
	client := &mockCPAClient{
		apiCallFunc: func(ctx context.Context, req management.ApiCallRequest) (management.ApiCallResponse, error) {
			switch {
			case strings.HasPrefix(req.URL, CodexSubscriptionURL):
				return management.ApiCallResponse{StatusCode: 503, Body: json.RawMessage(`{"error":"temporarily unavailable"}`)}, nil
			case req.URL == CodexUsageURL:
				return management.ApiCallResponse{StatusCode: 200, Body: json.RawMessage(codexUsageFixture)}, nil
			default:
				return management.ApiCallResponse{StatusCode: 200, Body: json.RawMessage(`{"available_count":0,"credits":[]}`)}, nil
			}
		},
	}

	res, err := NewService(client).RefreshCredentialQuota(context.Background(), codexAuthFileWithStaleSnapshot(), nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	// The snapshot is still shown, but tagged so the console renders it as a
	// lower bound instead of a verified renewal date.
	// The snapshot label must not be left behind by a parser that described a
	// different instant: here the plan had no expiry, so no label can survive.
	wantStart := time.Date(2026, 7, 29, 14, 2, 31, 0, time.UTC).UnixMilli()
	want := time.Date(2026, 8, 29, 14, 2, 31, 0, time.UTC).UnixMilli()
	if res.Plan == nil || res.Plan.ExpiresAtMS == nil || *res.Plan.ExpiresAtMS != want {
		t.Fatalf("plan = %+v, want the snapshot expiry %d", res.Plan, want)
	}
	if res.Plan.StartsAtMS == nil || *res.Plan.StartsAtMS != wantStart {
		t.Errorf("StartsAtMS = %v, want the snapshot start %d", res.Plan.StartsAtMS, wantStart)
	}
	if res.Plan.ExpiresLabel != "" {
		t.Errorf("ExpiresLabel = %q, want empty for a snapshot bound", res.Plan.ExpiresLabel)
	}
	if res.Plan.ExpiresSource != PlanSourceCredentialSnapshot {
		t.Errorf("ExpiresSource = %q, want %q", res.Plan.ExpiresSource, PlanSourceCredentialSnapshot)
	}
}

// The subscription endpoint answers 400 without account_id, so an unresolvable
// account must skip the probe rather than issue a call that cannot succeed.
func TestCodexRenewalSkipsProbeWithoutAccountID(t *testing.T) {
	var probed bool
	client := &mockCPAClient{
		apiCallFunc: func(ctx context.Context, req management.ApiCallRequest) (management.ApiCallResponse, error) {
			if strings.HasPrefix(req.URL, CodexSubscriptionURL) {
				probed = true
			}
			if req.URL == CodexUsageURL {
				return management.ApiCallResponse{StatusCode: 200, Body: json.RawMessage(codexUsageFixture)}, nil
			}
			return management.ApiCallResponse{StatusCode: 200, Body: json.RawMessage(`{"available_count":0,"credits":[]}`)}, nil
		},
	}

	file := codexAuthFileWithStaleSnapshot()
	file.IDToken = json.RawMessage(`{"plan_type":"plus","chatgpt_subscription_active_until":"2026-08-29T14:02:31+00:00"}`)

	res, err := NewService(client).RefreshCredentialQuota(context.Background(), file, nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if probed {
		t.Error("subscription endpoint was called without an account id")
	}
	if res.Plan == nil || res.Plan.ExpiresSource != PlanSourceCredentialSnapshot {
		t.Errorf("plan = %+v, want a tagged snapshot fallback", res.Plan)
	}
}

// The subscription endpoint joins the allowlist, so the guarantee that matters is
// that the entry cannot be used to reach another host or another endpoint.
func TestCodexSubscriptionAllowlistEntryIsHostBound(t *testing.T) {
	if !IsAllowedQuotaURL(CodexSubscriptionURL) {
		t.Fatalf("%q is not allowed", CodexSubscriptionURL)
	}
	if !IsAllowedQuotaURL(CodexSubscriptionURL + "?account_id=dc47fe6f") {
		t.Fatalf("%q with a query is not allowed", CodexSubscriptionURL)
	}

	for _, badURL := range []string{
		"https://chatgpt.com.attacker.test/backend-api/subscriptions",
		"https://chatgpt.com:8443/backend-api/subscriptions",
		"http://chatgpt.com/backend-api/subscriptions",
		"https://evil.test/backend-api/subscriptions",
	} {
		if IsAllowedQuotaURL(badURL) {
			t.Errorf("IsAllowedQuotaURL(%q) = true, want false", badURL)
		}
	}
}

// Every allowlist entry that names a single endpoint must stop at a path boundary,
// and no entry may be walked onto a different path by a traversal segment. Each case
// here was admitted by the previous raw-prefix comparison. Entries ending in "/"
// (wham/, api/oauth/, coding/v1/) are families and deliberately admit sub-paths, so
// they are not listed here.
func TestAllowlistEntriesEndAtAPathBoundary(t *testing.T) {
	for _, badURL := range []string{
		CodexSubscriptionURL + "-extra",
		CodexSubscriptionURL + "/extra",
		DevinSeatStatusURL + "Extra",
		DevinSeatStatusURL + "/extra",
		AntigravityQuotaURLDaily + "Extra",
		"https://chatgpt.com/backend-api/wham/usage/../subscriptions",
		"https://chatgpt.com/backend-api/wham/./usage",
		"https://api.kimi.com/coding/v1/../secrets",
	} {
		if IsAllowedQuotaURL(badURL) {
			t.Errorf("IsAllowedQuotaURL(%q) = true, want false", badURL)
		}
	}

	// The legitimate reads the quota service issues must all still pass: a family
	// entry with a sub-path, and a single-endpoint entry with a query.
	for _, goodURL := range []string{
		CodexUsageURL,
		CodexResetCreditsURL,
		CodexRedeemCreditURL,
		CodexSubscriptionURL + "?account_id=abc",
		ClaudeUsageURL,
		ClaudeProfileURL,
		KimiUsageURL,
		XaiBillingMonthlyURL,
		XaiBillingWeeklyURL,
		XaiApiMeURL,
		AntigravityQuotaURLDaily,
		AntigravityQuotaURLSandbox,
		AntigravityQuotaURLCloud,
		DevinSeatStatusURL,
	} {
		if !IsAllowedQuotaURL(goodURL) {
			t.Errorf("IsAllowedQuotaURL(%q) = false, want true", goodURL)
		}
	}
}

const codexUsageWithSubscription = `{
	"plan_type": "plus",
	"subscription_active_until": "2026-10-15T00:00:00Z",
	"rate_limit": {
		"allowed": true,
		"limit_reached": false,
		"primary_window": {"used_percent": 12, "limit_window_seconds": 18000, "reset_after_seconds": 3600}
	}
}`

// The usage payload carries its own subscription field for some accounts. The
// authoritative endpoint must still be probed: it reports the current billing
// window, while the usage value has no verified provenance.
func TestCodexRenewalProbesEvenWhenUsageSuppliesAnExpiry(t *testing.T) {
	var probed bool
	client := &mockCPAClient{
		apiCallFunc: func(ctx context.Context, req management.ApiCallRequest) (management.ApiCallResponse, error) {
			switch {
			case strings.HasPrefix(req.URL, CodexSubscriptionURL):
				probed = true
				return management.ApiCallResponse{
					StatusCode: 200,
					Body:       json.RawMessage(`{"active_until":"2026-09-29T14:02:31Z","will_renew":true}`),
				}, nil
			case req.URL == CodexUsageURL:
				return management.ApiCallResponse{StatusCode: 200, Body: json.RawMessage(codexUsageWithSubscription)}, nil
			default:
				return management.ApiCallResponse{StatusCode: 200, Body: json.RawMessage(`{"available_count":0,"credits":[]}`)}, nil
			}
		},
	}

	res, err := NewService(client).RefreshCredentialQuota(context.Background(), codexAuthFileWithStaleSnapshot(), nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !probed {
		t.Error("the subscription endpoint was skipped because the usage payload carried an expiry")
	}

	want := time.Date(2026, 9, 29, 14, 2, 31, 0, time.UTC).UnixMilli()
	if res.Plan == nil || res.Plan.ExpiresAtMS == nil || *res.Plan.ExpiresAtMS != want {
		t.Fatalf("plan = %+v, want the subscription endpoint's %d", res.Plan, want)
	}
	if res.Plan.ExpiresSource != PlanSourceLiveSubscription {
		t.Errorf("ExpiresSource = %q, want %q", res.Plan.ExpiresSource, PlanSourceLiveSubscription)
	}
	// The parser derived a label from the usage payload's own 2026-10-15 expiry. It
	// describes that instant, not this one, so it must not survive the replacement.
	if res.Plan.ExpiresLabel != "" {
		t.Errorf("ExpiresLabel = %q, want it cleared with the instant it described", res.Plan.ExpiresLabel)
	}
}

// With the probe unavailable, a usage-supplied expiry is kept but must not claim a
// live subscription read, and must not be relabelled as the id_token snapshot it
// did not come from.
func TestCodexRenewalKeepsUsageExpiryUnlabeledWhenProbeFails(t *testing.T) {
	client := &mockCPAClient{
		apiCallFunc: func(ctx context.Context, req management.ApiCallRequest) (management.ApiCallResponse, error) {
			switch {
			case strings.HasPrefix(req.URL, CodexSubscriptionURL):
				return management.ApiCallResponse{StatusCode: 503, Body: json.RawMessage(`{"error":"unavailable"}`)}, nil
			case req.URL == CodexUsageURL:
				return management.ApiCallResponse{StatusCode: 200, Body: json.RawMessage(codexUsageWithSubscription)}, nil
			default:
				return management.ApiCallResponse{StatusCode: 200, Body: json.RawMessage(`{"available_count":0,"credits":[]}`)}, nil
			}
		},
	}

	res, err := NewService(client).RefreshCredentialQuota(context.Background(), codexAuthFileWithStaleSnapshot(), nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	want := time.Date(2026, 10, 15, 0, 0, 0, 0, time.UTC).UnixMilli()
	if res.Plan == nil || res.Plan.ExpiresAtMS == nil || *res.Plan.ExpiresAtMS != want {
		t.Fatalf("plan = %+v, want the usage payload's %d", res.Plan, want)
	}
	if res.Plan.ExpiresSource != "" {
		t.Errorf("ExpiresSource = %q, want it unset: the value is live-read but not from the subscription endpoint", res.Plan.ExpiresSource)
	}
}

// A read that succeeded without publishing a window is not a credential nobody has read. The
// marker travels on the observation so the console can say what happened instead of asking for the
// read that just came back empty.
func TestUnpublishedReadingIsNotAnUnreadCredential(t *testing.T) {
	nowMS := time.Now().UnixMilli()

	marked := &NormalizedQuota{Status: QuotaStatusUnpublished}
	EvaluateStatusAndRecommendation(marked, nowMS)
	if marked.Status != QuotaStatusUnpublished || marked.Recommendation.Status != QuotaStatusUnpublished {
		t.Fatalf("status = %q / %q, want the empty reading preserved", marked.Status, marked.Recommendation.Status)
	}
	if marked.Recommendation.Action == "refresh" {
		t.Errorf("an empty reading must not be re-requested: %+v", marked.Recommendation)
	}

	// Without the marker nothing distinguishes the credential from an unread one, and that reading
	// still asks for a refresh.
	unread := &NormalizedQuota{}
	EvaluateStatusAndRecommendation(unread, nowMS)
	if unread.Status != "idle" || unread.Recommendation.Action != "refresh" {
		t.Fatalf("unread = %q / %+v, want idle asking for a refresh", unread.Status, unread.Recommendation)
	}

	// The marker is not sticky: a later read that carries a window is graded on its own terms.
	remaining := 90.0
	recovered := &NormalizedQuota{Status: QuotaStatusUnpublished, Windows: []QuotaWindow{{RemainingPercent: &remaining}}}
	EvaluateStatusAndRecommendation(recovered, nowMS)
	if recovered.Status != "healthy" {
		t.Fatalf("status = %q, want healthy", recovered.Status)
	}
}

func TestRefreshMarksAReadThatPublishedNoWindow(t *testing.T) {
	client := &mockCPAClient{apiCallFunc: func(ctx context.Context, req management.ApiCallRequest) (management.ApiCallResponse, error) {
		// A provider that answers, and publishes no window in the document it answers with.
		return management.ApiCallResponse{StatusCode: 200, Body: json.RawMessage(`{"config":{}}`)}, nil
	}}

	result, err := NewService(client).RefreshCredentialQuota(context.Background(), management.AuthFile{
		AuthIndex: "xai-empty",
		Name:      "xai-empty.json",
		Type:      "xai",
		Provider:  "xai",
	}, nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.Status != QuotaStatusUnpublished {
		t.Fatalf("status = %q, want %q", result.Status, QuotaStatusUnpublished)
	}
	if len(result.Windows) != 0 || result.Error != "" {
		t.Fatalf("result = %+v, want an empty reading without an error", result)
	}
}

// Balances and extra usage come from the usage read: a failed profile read must
// not drop them along with the plan label it would have supplied.
func TestRefreshClaudeKeepsBalancesWithoutAProfile(t *testing.T) {
	client := &mockCPAClient{apiCallFunc: func(ctx context.Context, req management.ApiCallRequest) (management.ApiCallResponse, error) {
		if strings.Contains(req.URL, "oauth/usage") && !strings.Contains(req.URL, "cedar_ember") {
			return management.ApiCallResponse{StatusCode: 200, Body: json.RawMessage(`{"five_hour":{"utilization":30},"iguana_necktie":{"utilization":10,"limit_dollars":50,"used_dollars":5,"remaining_dollars":45,"resets_at":null},"extra_usage":{"is_enabled":false}}`)}, nil
		}
		return management.ApiCallResponse{StatusCode: 500}, nil
	}}
	result, err := NewService(client).WithClaudeResetGrantsDelay(0).RefreshCredentialQuota(context.Background(), management.AuthFile{AuthIndex: "cl-2", Name: "claude.json", Type: "claude", Provider: "claude"}, nil)
	if err != nil {
		t.Fatalf("RefreshCredentialQuota error: %v", err)
	}
	if result.Plan == nil || result.Plan.PlanLabel != "" || len(result.Plan.Balances) != 1 || result.Plan.ExtraUsage == nil {
		t.Fatalf("plan = %+v, want an unlabelled plan carrying the balance and extra usage", result.Plan)
	}
}

func TestCodexResetCreditsErrorSurfacingAndAccountIDGuards(t *testing.T) {
	if got := resolveCodexAccountID(management.AuthFile{Account: "owner@example.com"}); got != "" {
		t.Fatalf("resolveCodexAccountID(email) = %q, want empty", got)
	}
	if got := resolveCodexAccountID(management.AuthFile{
		Account: "owner@example.com",
		Quota:   map[string]any{"account_id": "acct-from-quota"},
	}); got != "acct-from-quota" {
		t.Fatalf("resolveCodexAccountID(email+quota) = %q, want acct-from-quota", got)
	}

	// Dedicated endpoint error with no usage credits still surfaces an error struct.
	errClient := &mockCPAClient{apiCallFunc: func(ctx context.Context, req management.ApiCallRequest) (management.ApiCallResponse, error) {
		return management.ApiCallResponse{StatusCode: http.StatusForbidden, Body: json.RawMessage(`{"message":"forbidden"}`)}, nil
	}}
	gotErr := NewService(errClient).fetchCodexResetCredits(context.Background(), management.AuthFile{AuthIndex: "cx-err"}, nil, nil)
	if gotErr == nil || !strings.Contains(gotErr.Error, "HTTP 403") {
		t.Fatalf("dedicated 403 with nil usageCredits = %+v, want Error containing HTTP 403", gotErr)
	}

	// Dedicated endpoint error preserves usageCredits count while surfacing the error.
	gotFallback := NewService(errClient).fetchCodexResetCredits(context.Background(), management.AuthFile{AuthIndex: "cx-err"}, nil, &CodexResetCreditsInfo{AvailableCount: 2})
	if gotFallback == nil || gotFallback.AvailableCount != 2 || !strings.Contains(gotFallback.Error, "HTTP 403") {
		t.Fatalf("dedicated 403 with usageCredits = %+v, want count=2 and HTTP 403 error", gotFallback)
	}

	// Dedicated endpoint omitting available_count with numeric timestamps derives count from credits.
	numericClient := &mockCPAClient{apiCallFunc: func(ctx context.Context, req management.ApiCallRequest) (management.ApiCallResponse, error) {
		return management.ApiCallResponse{
			StatusCode: http.StatusOK,
			Body:       json.RawMessage(`{"credits":[{"id":"c1","status":"available","expires_at":1776000000},{"id":"c2","status":"available","expires_at":1777000000}]}`),
		}, nil
	}}
	gotNumeric := NewService(numericClient).fetchCodexResetCredits(context.Background(), management.AuthFile{AuthIndex: "cx-num"}, nil, nil)
	if gotNumeric == nil || gotNumeric.AvailableCount != 2 || len(gotNumeric.Credits) != 2 || gotNumeric.Error != "" {
		t.Fatalf("numeric credits without available_count = %+v, want count=2 and 2 credits", gotNumeric)
	}
}

func TestRefreshClaudeResetGrantsPreservesPriorOnFailureAndSpacesRequest(t *testing.T) {
	priorGrants := []ClaudeResetGrant{{ID: "grant-keep", Label: "Weekly", ResetsTotal: 2, ResetsLeft: 1}}
	rem := 70.0
	prior := &NormalizedQuota{
		AuthIndex:   "cl-keep",
		Provider:    "claude",
		Windows:     []QuotaWindow{{ID: "five_hour", RemainingPercent: &rem}},
		ResetGrants: priorGrants,
	}

	var usageAt, grantsAt time.Time
	client := &mockCPAClient{apiCallFunc: func(ctx context.Context, req management.ApiCallRequest) (management.ApiCallResponse, error) {
		switch {
		case strings.Contains(req.URL, "cedar_ember"):
			grantsAt = time.Now()
			return management.ApiCallResponse{StatusCode: http.StatusTooManyRequests, Body: json.RawMessage(`{"error":"rate_limited"}`)}, nil
		case strings.Contains(req.URL, "oauth/usage"):
			usageAt = time.Now()
			return management.ApiCallResponse{StatusCode: http.StatusOK, Body: json.RawMessage(`{"five_hour":{"utilization":20}}`)}, nil
		case strings.Contains(req.URL, "oauth/profile"):
			return management.ApiCallResponse{StatusCode: http.StatusOK, Body: json.RawMessage(`{"account":{"has_claude_pro":true}}`)}, nil
		}
		return management.ApiCallResponse{StatusCode: http.StatusNotFound}, nil
	}}

	svc := NewService(client)
	if svc.claudeGrantsDelay != DefaultClaudeResetGrantsDelay {
		t.Fatalf("default claudeGrantsDelay = %v, want %v", svc.claudeGrantsDelay, DefaultClaudeResetGrantsDelay)
	}
	const shortDelay = 25 * time.Millisecond
	file := management.AuthFile{AuthIndex: "cl-keep", Name: "claude.json", Type: "claude", Provider: "claude"}
	res, err := svc.WithClaudeResetGrantsDelay(shortDelay).RefreshCredentialQuota(context.Background(), file, prior)
	if err != nil {
		t.Fatalf("RefreshCredentialQuota error: %v", err)
	}
	if len(res.ResetGrants) != 1 || res.ResetGrants[0].ID != "grant-keep" {
		t.Fatalf("ResetGrants = %+v, want prior grant preserved on 429", res.ResetGrants)
	}
	if res.ResetGrantsError != ClaudeResetGrantsErrorRateLimited {
		t.Fatalf("ResetGrantsError = %q, want %q", res.ResetGrantsError, ClaudeResetGrantsErrorRateLimited)
	}
	if gap := grantsAt.Sub(usageAt); gap < shortDelay-5*time.Millisecond {
		t.Fatalf("gap between usage and grants = %v, want at least ~%v", gap, shortDelay)
	}

	// Deferred and stale readings also preserve prior ResetGrants and ResetGrantsError.
	deferred := svc.DeferredReading(file, res, time.Now().Add(time.Minute))
	if len(deferred.ResetGrants) != 1 || deferred.ResetGrants[0].ID != "grant-keep" || deferred.ResetGrantsError != ClaudeResetGrantsErrorRateLimited {
		t.Fatalf("DeferredReading lost reset grants: %+v", deferred)
	}

	// Context cancellation aborts the grants delay immediately.
	cancelCtx, cancel := context.WithCancel(context.Background())
	go func() {
		time.Sleep(15 * time.Millisecond)
		cancel()
	}()
	start := time.Now()
	_, errCode := NewService(client).WithClaudeResetGrantsDelay(5*time.Second).fetchClaudeResetGrants(cancelCtx, file)
	if errCode != ClaudeResetGrantsErrorUpstream || time.Since(start) > time.Second {
		t.Fatalf("canceled grants delay returned (%q, %v), want immediate upstream_error", errCode, time.Since(start))
	}
}

func TestRefreshClaudeResetGrantsWithGateState(t *testing.T) {
	file := management.AuthFile{AuthIndex: "cl-gate", Name: "claude.json", Type: "claude", Provider: "claude"}
	rem := 70.0
	stalePrior := &NormalizedQuota{
		AuthIndex:           "cl-gate",
		Provider:            "claude",
		Windows:             []QuotaWindow{{ID: "five_hour", RemainingPercent: &rem}},
		ResetGrants:         []ClaudeResetGrant{{ID: "old-grant", ResetsTotal: 2, ResetsLeft: 1, Clears: []string{"five_hour"}}},
		ResetGrantsObserved: true,
		ResetGrantsError:    ClaudeResetGrantsErrorRateLimited,
	}

	grantsCalls := 0
	client := &mockCPAClient{apiCallFunc: func(ctx context.Context, req management.ApiCallRequest) (management.ApiCallResponse, error) {
		switch {
		case strings.Contains(req.URL, "cedar_ember"):
			grantsCalls++
			return management.ApiCallResponse{StatusCode: http.StatusTooManyRequests, Body: json.RawMessage(`{"error":"rate_limited"}`)}, nil
		case strings.Contains(req.URL, "oauth/usage"):
			return management.ApiCallResponse{StatusCode: http.StatusOK, Body: json.RawMessage(`{"five_hour":{"utilization":20}}`)}, nil
		case strings.Contains(req.URL, "oauth/profile"):
			return management.ApiCallResponse{StatusCode: http.StatusOK, Body: json.RawMessage(`{"account":{"has_claude_pro":true}}`)}, nil
		}
		return management.ApiCallResponse{StatusCode: http.StatusNotFound}, nil
	}}
	svc := NewService(client).WithClaudeResetGrantsDelay(0)

	// Fresh gate state overrides stale prior grants/error and skips upstream grants.
	endsAtMS := int64(1776000000000)
	cached := &ClaudeResetGrantsState{
		Grants:   []ClaudeResetGrant{{ID: "grant-1", ResetsTotal: 2, ResetsLeft: 1, EndsAtMS: &endsAtMS, Clears: []string{"five_hour"}}},
		Observed: true,
	}
	res, err := svc.RefreshCredentialQuotaWith(context.Background(), file, stalePrior, ReadOptions{
		IsClaudeProfileFresh:     true,
		IsClaudeResetGrantsFresh: true,
		ClaudeResetGrants:        cached,
	})
	if err != nil {
		t.Fatalf("RefreshCredentialQuotaWith error: %v", err)
	}
	if grantsCalls != 0 {
		t.Fatalf("grantsCalls = %d, want 0 when fresh", grantsCalls)
	}
	if len(res.ResetGrants) != 1 || res.ResetGrants[0].ID != "grant-1" || !res.ResetGrantsObserved || res.ResetGrantsError != "" {
		t.Fatalf("fresh cached result = grants:%+v observed:%v err:%q, want grant-1", res.ResetGrants, res.ResetGrantsObserved, res.ResetGrantsError)
	}
	// Mutating the returned grant must not mutate the gate's cached copy.
	*res.ResetGrants[0].EndsAtMS = 0
	res.ResetGrants[0].Clears[0] = "mutated"
	if *cached.Grants[0].EndsAtMS != 1776000000000 || cached.Grants[0].Clears[0] != "five_hour" {
		t.Fatalf("cached grant mutated through returned reading: %+v", cached.Grants[0])
	}

	// Fresh confirmed empty gate state overrides stale nonempty prior and also works with nil prior.
	for name, prior := range map[string]*NormalizedQuota{"stale prior": stalePrior, "nil prior": nil} {
		emptyRes, err := svc.RefreshCredentialQuotaWith(context.Background(), file, prior, ReadOptions{
			IsClaudeProfileFresh:     prior != nil,
			IsClaudeResetGrantsFresh: true,
			ClaudeResetGrants:        &ClaudeResetGrantsState{Grants: []ClaudeResetGrant{}, Observed: true},
		})
		if err != nil {
			t.Fatalf("%s: RefreshCredentialQuotaWith error: %v", name, err)
		}
		if len(emptyRes.ResetGrants) != 0 || !emptyRes.ResetGrantsObserved || emptyRes.ResetGrantsError != "" {
			t.Fatalf("%s: empty cached result = grants:%+v observed:%v err:%q, want observed empty list", name, emptyRes.ResetGrants, emptyRes.ResetGrantsObserved, emptyRes.ResetGrantsError)
		}
	}
	if grantsCalls != 0 {
		t.Fatalf("grantsCalls after fresh empty reads = %d, want 0", grantsCalls)
	}

	// On a failed re-fetch, an observed gate state (even empty) supersedes an older stale prior.
	failedRes, err := svc.RefreshCredentialQuotaWith(context.Background(), file, stalePrior, ReadOptions{
		IsClaudeProfileFresh:     true,
		IsClaudeResetGrantsFresh: false,
		ClaudeResetGrants:        &ClaudeResetGrantsState{Grants: []ClaudeResetGrant{}, Observed: true},
	})
	if err != nil {
		t.Fatalf("failed re-fetch error: %v", err)
	}
	if grantsCalls != 1 {
		t.Fatalf("grantsCalls = %d, want 1", grantsCalls)
	}
	if len(failedRes.ResetGrants) != 0 || !failedRes.ResetGrantsObserved || failedRes.ResetGrantsError != ClaudeResetGrantsErrorRateLimited {
		t.Fatalf("failed re-fetch result = grants:%+v observed:%v err:%q, want observed empty list with rate_limited", failedRes.ResetGrants, failedRes.ResetGrantsObserved, failedRes.ResetGrantsError)
	}

	// When primary usage fails on a queued refresh whose prior carried an obsolete grants list/error,
	// fresh gate state keeps grants, observed status, and error paired from the same observation
	// while preserving stale status and ObservedAtMS.
	priorObservedAtMS := int64(1775000000000)
	stalePrior.ObservedAtMS = priorObservedAtMS
	usageFailClient := &mockCPAClient{apiCallFunc: func(ctx context.Context, req management.ApiCallRequest) (management.ApiCallResponse, error) {
		if strings.Contains(req.URL, "oauth/usage") {
			return management.ApiCallResponse{StatusCode: http.StatusInternalServerError, Body: json.RawMessage(`{"error":"server_error"}`)}, nil
		}
		return management.ApiCallResponse{StatusCode: http.StatusOK, Body: json.RawMessage(`{"account":{"has_claude_pro":true}}`)}, nil
	}}
	usageFailSvc := NewService(usageFailClient).WithClaudeResetGrantsDelay(0)

	usageFailedRes, err := usageFailSvc.RefreshCredentialQuotaWith(context.Background(), file, stalePrior, ReadOptions{
		IsClaudeProfileFresh:     true,
		IsClaudeResetGrantsFresh: true,
		ClaudeResetGrants:        &ClaudeResetGrantsState{Grants: []ClaudeResetGrant{{ID: "grant-1"}}, Observed: true, Error: ""},
	})
	if err != nil {
		t.Fatalf("usage failure error: %v", err)
	}
	if usageFailedRes.Status != "stale" || usageFailedRes.ObservedAtMS != priorObservedAtMS ||
		!usageFailedRes.ResetGrantsObserved || len(usageFailedRes.ResetGrants) != 1 || usageFailedRes.ResetGrants[0].ID != "grant-1" ||
		usageFailedRes.ResetGrantsError != "" {
		t.Fatalf("usage failure result = status:%q observed_at_ms:%d grants:%+v observed:%v err:%q, want stale at %d with grant-1 and empty error",
			usageFailedRes.Status, usageFailedRes.ObservedAtMS, usageFailedRes.ResetGrants, usageFailedRes.ResetGrantsObserved, usageFailedRes.ResetGrantsError, priorObservedAtMS)
	}

	// Observed empty gate state also prevents old-grant from reappearing when primary usage fails.
	usageFailedEmptyRes, err := usageFailSvc.RefreshCredentialQuotaWith(context.Background(), file, stalePrior, ReadOptions{
		IsClaudeProfileFresh:     true,
		IsClaudeResetGrantsFresh: true,
		ClaudeResetGrants:        &ClaudeResetGrantsState{Grants: []ClaudeResetGrant{}, Observed: true, Error: ""},
	})
	if err != nil {
		t.Fatalf("usage failure empty-grants error: %v", err)
	}
	if usageFailedEmptyRes.Status != "stale" || usageFailedEmptyRes.ObservedAtMS != priorObservedAtMS ||
		!usageFailedEmptyRes.ResetGrantsObserved || len(usageFailedEmptyRes.ResetGrants) != 0 ||
		usageFailedEmptyRes.ResetGrantsError != "" {
		t.Fatalf("usage failure empty result = status:%q observed_at_ms:%d grants:%+v observed:%v err:%q, want stale at %d with observed empty grants",
			usageFailedEmptyRes.Status, usageFailedEmptyRes.ObservedAtMS, usageFailedEmptyRes.ResetGrants, usageFailedEmptyRes.ResetGrantsObserved, usageFailedEmptyRes.ResetGrantsError, priorObservedAtMS)
	}

	// A failure-only gate state (Observed: false) retains prior observed grants while surfacing the gate error.
	priorWithoutErr := *stalePrior
	priorWithoutErr.ResetGrantsError = ""
	usageFailedCooldownRes, err := usageFailSvc.RefreshCredentialQuotaWith(context.Background(), file, &priorWithoutErr, ReadOptions{
		IsClaudeProfileFresh:     true,
		IsClaudeResetGrantsFresh: true,
		ClaudeResetGrants:        &ClaudeResetGrantsState{Observed: false, Error: ClaudeResetGrantsErrorRateLimited},
	})
	if err != nil {
		t.Fatalf("usage failure cooldown error: %v", err)
	}
	if usageFailedCooldownRes.Status != "stale" || usageFailedCooldownRes.ObservedAtMS != priorObservedAtMS ||
		!usageFailedCooldownRes.ResetGrantsObserved || len(usageFailedCooldownRes.ResetGrants) != 1 || usageFailedCooldownRes.ResetGrants[0].ID != "old-grant" ||
		usageFailedCooldownRes.ResetGrantsError != ClaudeResetGrantsErrorRateLimited {
		t.Fatalf("usage failure cooldown result = status:%q observed_at_ms:%d grants:%+v observed:%v err:%q, want stale at %d retaining old-grant with rate_limited",
			usageFailedCooldownRes.Status, usageFailedCooldownRes.ObservedAtMS, usageFailedCooldownRes.ResetGrants, usageFailedCooldownRes.ResetGrantsObserved, usageFailedCooldownRes.ResetGrantsError, priorObservedAtMS)
	}

	// Even past the fetch TTL (IsClaudeResetGrantsFresh: false), an observed gate result supersedes
	// an older prior snapshot when primary usage fails.
	usageFailedPostTTLRes, err := usageFailSvc.RefreshCredentialQuotaWith(context.Background(), file, stalePrior, ReadOptions{
		IsClaudeProfileFresh:     true,
		IsClaudeResetGrantsFresh: false,
		ClaudeResetGrants:        &ClaudeResetGrantsState{Grants: []ClaudeResetGrant{}, Observed: true, Error: ""},
	})
	if err != nil {
		t.Fatalf("usage failure post-TTL error: %v", err)
	}
	if usageFailedPostTTLRes.Status != "stale" || usageFailedPostTTLRes.ObservedAtMS != priorObservedAtMS ||
		!usageFailedPostTTLRes.ResetGrantsObserved || len(usageFailedPostTTLRes.ResetGrants) != 0 ||
		usageFailedPostTTLRes.ResetGrantsError != "" {
		t.Fatalf("usage failure post-TTL result = status:%q observed_at_ms:%d grants:%+v observed:%v err:%q, want stale at %d with observed empty grants",
			usageFailedPostTTLRes.Status, usageFailedPostTTLRes.ObservedAtMS, usageFailedPostTTLRes.ResetGrants, usageFailedPostTTLRes.ResetGrantsObserved, usageFailedPostTTLRes.ResetGrantsError, priorObservedAtMS)
	}
}
