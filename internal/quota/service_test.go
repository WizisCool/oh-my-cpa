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

func TestRedeemCodexCreditCallsConsumeEndpoint(t *testing.T) {
	var calledURL string
	var calledMethod string
	var calledAuthIndex string
	var calledBody string
	var calledHeaders map[string]string

	client := &mockCPAClient{
		apiCallFunc: func(ctx context.Context, req management.ApiCallRequest) (management.ApiCallResponse, error) {
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

	svc := NewService(client)
	err := svc.RedeemCodexCredit(context.Background(), management.AuthFile{
		AuthIndex: "auth-codex",
		Name:      "codex.json",
		Type:      "codex",
		Provider:  "codex",
		// The consume route must carry the credential's own ChatGPT account, exactly like
		// the read probes, so a credit is spent under the account it was read from.
		IDToken: json.RawMessage(`{"chatgpt_account_id":"acct-openai-123"}`),
	})
	if err != nil {
		t.Fatalf("RedeemCodexCredit error: %v", err)
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
		RedeemRequestID string `json:"redeem_request_id"`
	}
	if err := json.Unmarshal([]byte(calledBody), &body); err != nil {
		t.Fatalf("consume body is not JSON: %q", calledBody)
	}
	if _, err := uuid.Parse(body.RedeemRequestID); err != nil {
		t.Errorf("redeem_request_id = %q, want a UUID: %v", body.RedeemRequestID, err)
	}
}

// A credential whose account id cannot be resolved still redeems: the account header
// keeps the redemption aligned with the quota reads, it is not a precondition.
func TestRedeemCodexCreditOmitsAccountHeaderWhenUnresolved(t *testing.T) {
	var calledHeaders map[string]string

	client := &mockCPAClient{
		apiCallFunc: func(ctx context.Context, req management.ApiCallRequest) (management.ApiCallResponse, error) {
			calledHeaders = req.Header
			return management.ApiCallResponse{StatusCode: 200, Body: json.RawMessage(`{"code":"reset"}`)}, nil
		},
	}

	err := NewService(client).RedeemCodexCredit(context.Background(), management.AuthFile{
		AuthIndex: "auth-codex",
		Name:      "codex.json",
		Type:      "codex",
		Provider:  "codex",
	})
	if err != nil {
		t.Fatalf("RedeemCodexCredit error: %v", err)
	}
	if _, ok := calledHeaders["Chatgpt-Account-Id"]; ok {
		t.Errorf("Chatgpt-Account-Id = %q, want it omitted", calledHeaders["Chatgpt-Account-Id"])
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
					Body:       json.RawMessage(`{"plan_type":"plus","active_until":"2026-09-29T14:02:31Z","will_renew":true}`),
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
	want := time.Date(2026, 9, 29, 14, 2, 31, 0, time.UTC).UnixMilli()
	if res.Plan.ExpiresAtMS == nil || *res.Plan.ExpiresAtMS != want {
		t.Errorf("ExpiresAtMS = %v, want the live %d", res.Plan.ExpiresAtMS, want)
	}
	if res.Plan.ExpiresSource != PlanSourceLiveSubscription {
		t.Errorf("ExpiresSource = %q, want %q", res.Plan.ExpiresSource, PlanSourceLiveSubscription)
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
	want := time.Date(2026, 8, 29, 14, 2, 31, 0, time.UTC).UnixMilli()
	if res.Plan == nil || res.Plan.ExpiresAtMS == nil || *res.Plan.ExpiresAtMS != want {
		t.Fatalf("plan = %+v, want the snapshot expiry %d", res.Plan, want)
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
