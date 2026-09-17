package quota

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/management"
)

// Official Upstream URLs
const (
	CodexUsageURL              = "https://chatgpt.com/backend-api/wham/usage"
	CodexRedeemCreditURL       = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume"
	CodexResetCreditsURL       = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits"
	ClaudeProfileURL           = "https://api.anthropic.com/api/oauth/profile"
	ClaudeUsageURL             = "https://api.anthropic.com/api/oauth/usage"
	AntigravityQuotaURLDaily   = "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary"
	AntigravityQuotaURLSandbox = "https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:retrieveUserQuotaSummary"
	AntigravityQuotaURLCloud   = "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary"
	KimiUsageURL               = "https://api.kimi.com/coding/v1/usages"
	XaiBillingMonthlyURL       = "https://cli-chat-proxy.grok.com/v1/billing"
	XaiBillingWeeklyURL        = "https://cli-chat-proxy.grok.com/v1/billing?format=credits"
	XaiApiMeURL                = "https://api.x.ai/v1/me"
	XaiApiChatURL              = "https://api.x.ai/v1/chat/completions"
)

// Official upstream headers, plus the model id the xAI paid-account health probe
// sends. The user-agent strings impersonate each vendor's official CLI because
// the quota endpoints reject anything else.
const (
	CodexUserAgent       = "codex-tui/0.149.1 (Mac OS 26.5.2; arm64) iTerm.app/3.6.11 (codex-tui; 0.149.1)"
	AntigravityUserAgent = "antigravity/cli/1.0.13 (aidev_client; os_type=darwin; arch=arm64)"
	XaiGrokClientVersion = "0.2.91"
	XaiGrokUserAgent     = "grok-pager/0.2.91 grok-shell/0.2.91 (macos; aarch64)"
	XaiPaidHealthModel   = "grok-4.5"
)

// AllowedURLPrefixes strictly limits which upstream domains and endpoints may be called via CPA api-call.
var AllowedURLPrefixes = []string{
	"https://chatgpt.com/backend-api/wham/",
	"https://api.anthropic.com/api/oauth/",
	"https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary",
	"https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:retrieveUserQuotaSummary",
	"https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary",
	"https://api.kimi.com/coding/v1/",
	"https://cli-chat-proxy.grok.com/v1/billing",
	"https://api.x.ai/v1/",
	DevinSeatStatusURL,
}

// IsAllowedQuotaURL verifies that a target URL is in the strict quota allowlist.
func IsAllowedQuotaURL(targetURL string) bool {
	parsed, err := url.Parse(strings.TrimSpace(targetURL))
	if err != nil || parsed.Scheme != "https" {
		return false
	}
	for _, prefix := range AllowedURLPrefixes {
		if strings.HasPrefix(targetURL, prefix) {
			return true
		}
	}
	return false
}

// CPAClient defines the subset of CPA management client functions needed by quota service.
type CPAClient interface {
	ApiCall(ctx context.Context, req management.ApiCallRequest) (management.ApiCallResponse, error)
	ResetQuota(ctx context.Context, authIndex string) error
	AuthFiles(ctx context.Context) (management.AuthFilesResponse, error)
}

// Service manages live upstream quota fetching, normalization, and actions.
type Service struct {
	client CPAClient
}

// NewService creates a quota service bound to a CPA management client.
func NewService(client CPAClient) *Service {
	return &Service{client: client}
}

// DetectProvider maps file Type and Provider to a standard quota provider key.
// Note: generic gemini is NOT classified as antigravity!
func DetectProvider(fileType, provider string) string {
	t := strings.ToLower(strings.TrimSpace(fileType))
	p := strings.ToLower(strings.TrimSpace(provider))

	switch {
	case t == "antigravity" || p == "antigravity":
		return "antigravity"
	case strings.Contains(t, "codex") || strings.Contains(p, "codex") || strings.Contains(t, "chatgpt"):
		return "codex"
	case strings.Contains(t, "claude") || strings.Contains(p, "claude") || strings.Contains(t, "anthropic") || strings.Contains(p, "anthropic"):
		return "claude"
	case strings.Contains(t, "kimi") || strings.Contains(p, "kimi") || strings.Contains(t, "moonshot") || strings.Contains(p, "moonshot"):
		return "kimi"
	case strings.Contains(t, "xai") || strings.Contains(p, "xai") || strings.Contains(t, "grok") || strings.Contains(p, "grok"):
		return "xai"
	case strings.Contains(t, "devin") || strings.Contains(p, "devin"):
		return "devin"
	default:
		if t != "" {
			return t
		}
		if p != "" {
			return p
		}
		return "unknown"
	}
}

// CapabilitiesForProvider returns supported operations for a provider.
func CapabilitiesForProvider(provider string) QuotaCapabilities {
	p := strings.ToLower(provider)
	switch p {
	case "codex":
		return QuotaCapabilities{
			RefreshSupported:       true,
			ClearCooldownSupported: true,
			ResetCreditSupported:   true,
		}
	case "claude", "antigravity", "kimi", "xai", "devin":
		return QuotaCapabilities{
			RefreshSupported:       true,
			ClearCooldownSupported: true,
			ResetCreditSupported:   false,
		}
	default:
		return QuotaCapabilities{
			RefreshSupported:       false,
			ClearCooldownSupported: true,
			ResetCreditSupported:   false,
		}
	}
}

// SafeApiCall wraps CPA ApiCall with SSRF check and error handling.
func (s *Service) SafeApiCall(ctx context.Context, authIndex, method, targetURL string, headers map[string]string, data string) (management.ApiCallResponse, error) {
	if s.client == nil {
		return management.ApiCallResponse{}, errors.New("CPA client is not configured")
	}
	if !IsAllowedQuotaURL(targetURL) {
		return management.ApiCallResponse{}, fmt.Errorf("target URL %q is not in the quota allowlist", targetURL)
	}

	req := management.ApiCallRequest{
		AuthIndex: authIndex,
		Method:    method,
		URL:       targetURL,
		Header:    headers,
		Data:      data,
	}

	return s.client.ApiCall(ctx, req)
}

// sanitizeError keeps the operator-facing text short. CPA error bodies are not a
// stable contract, so the JSON `message` is preferred and the bare status is the
// fallback.
func sanitizeError(statusCode int, rawBody []byte) string {
	if statusCode == 0 {
		return "request failed"
	}
	bodyStr := string(rawBody)
	if strings.Contains(bodyStr, "message") {
		var errObj struct {
			Message string `json:"message"`
			Error   any    `json:"error"`
		}
		if err := json.Unmarshal(rawBody, &errObj); err == nil {
			if errObj.Message != "" {
				return fmt.Sprintf("HTTP %d: %s", statusCode, errObj.Message)
			}
			if msgStr, ok := errObj.Error.(string); ok && msgStr != "" {
				return fmt.Sprintf("HTTP %d: %s", statusCode, msgStr)
			}
		}
	}
	return fmt.Sprintf("HTTP %d", statusCode)
}

func resolveAntigravityProjectID(file management.AuthFile) string {
	if pid := strings.TrimSpace(file.ProjectID); pid != "" {
		return pid
	}
	if file.Quota != nil {
		if pid, ok := file.Quota["project_id"].(string); ok && strings.TrimSpace(pid) != "" {
			return strings.TrimSpace(pid)
		}
	}
	return ""
}

func resolveCodexAccountID(file management.AuthFile) string {
	// Prefer the ChatGPT account id from CPA-projected id_token claims. The
	// auth-file Account column holds the login email, which the usage
	// endpoint ignores (but does not reject), so a wrong-looking id must
	// never shadow the real claim.
	if accountID := file.CodexChatgptAccountID(); accountID != "" {
		return accountID
	}
	if acc := strings.TrimSpace(file.Account); acc != "" {
		return acc
	}
	if file.Quota != nil {
		if aid, ok := file.Quota["account_id"].(string); ok && strings.TrimSpace(aid) != "" {
			return strings.TrimSpace(aid)
		}
	}
	return ""
}

// RefreshCredentialQuota performs a live upstream query using full AuthFile metadata.
func (s *Service) RefreshCredentialQuota(ctx context.Context, file management.AuthFile, prior *NormalizedQuota) (*NormalizedQuota, error) {
	nowMS := time.Now().UnixMilli()
	authIndex := strings.TrimSpace(file.AuthIndex)
	stdProvider := DetectProvider(file.Type, file.Provider)
	caps := CapabilitiesForProvider(stdProvider)

	result := &NormalizedQuota{
		AuthIndex:    authIndex,
		Name:         file.Name,
		Type:         file.Type,
		Provider:     stdProvider,
		Disabled:     file.Disabled,
		ObservedAtMS: nowMS,
		Capabilities: caps,
	}

	if prior != nil {
		result.RawSignals = prior.RawSignals
		result.ActiveCooldown = prior.ActiveCooldown
		result.Plan = prior.Plan
		result.Windows = prior.Windows
		result.ResetCredits = prior.ResetCredits
	}

	if file.Disabled {
		result.Status = "idle"
		EvaluateStatusAndRecommendation(result, nowMS)
		return result, nil
	}

	var fetchErr error

	switch stdProvider {
	case "codex":
		plan, windows, credits, err := s.fetchCodexQuota(ctx, file, nowMS)
		if err != nil {
			fetchErr = err
		} else {
			result.Plan = plan
			result.Windows = windows
			result.ResetCredits = credits
		}

	case "claude":
		plan, windows, extraUsage, err := s.fetchClaudeQuota(ctx, file, nowMS)
		if err != nil {
			fetchErr = err
		} else {
			if plan != nil {
				plan.ExtraUsage = extraUsage
				result.Plan = plan
			}
			result.Windows = windows
		}

	case "antigravity":
		windows, err := s.fetchAntigravityQuota(ctx, file, nowMS)
		if err != nil {
			fetchErr = err
		} else {
			result.Windows = windows
			if result.Plan == nil {
				result.Plan = ResolveAntigravityPlan("pro")
			}
		}

	case "kimi":
		windows, err := s.fetchKimiQuota(ctx, file, nowMS)
		if err != nil {
			fetchErr = err
		} else {
			result.Windows = windows
			if result.Plan == nil {
				result.Plan = &QuotaPlan{PlanType: "standard", PlanLabel: "Kimi Coding API", Tier: "standard"}
			}
		}

	case "xai":
		plan, windows, err := s.fetchXaiQuota(ctx, file, nowMS)
		if err != nil {
			fetchErr = err
		} else {
			result.Plan = plan
			result.Windows = windows
		}

	case "devin":
		plan, windows, err := s.fetchDevinQuota(ctx, file, nowMS)
		if err != nil {
			fetchErr = err
		} else {
			result.Plan = plan
			result.Windows = windows
		}

	default:
		fetchErr = fmt.Errorf("provider %q does not support live quota refresh", stdProvider)
	}

	if fetchErr != nil {
		result.Error = fetchErr.Error()
		if prior != nil && len(prior.Windows) > 0 {
			result.Status = "stale"
			result.Windows = prior.Windows
			result.Plan = prior.Plan
			result.ResetCredits = prior.ResetCredits
		} else {
			result.Status = "error"
		}
	}

	EvaluateStatusAndRecommendation(result, nowMS)
	return result, nil
}

func (s *Service) fetchCodexQuota(ctx context.Context, file management.AuthFile, nowMS int64) (*QuotaPlan, []QuotaWindow, *CodexResetCreditsInfo, error) {
	// CPA substitutes "Bearer $TOKEN$" with the stored OAuth access token
	// for auth_index (see management.QuotaTokenPlaceholder). Without the
	// marker CPA forwards the request with no credential and every OAuth
	// refresh fails with 401.
	headers := management.WithQuotaCredential(map[string]string{
		"Content-Type": "application/json",
		"User-Agent":   CodexUserAgent,
		"Accept":       "application/json",
	})
	if accountID := resolveCodexAccountID(file); accountID != "" {
		headers["Chatgpt-Account-Id"] = accountID
	}

	resp, err := s.SafeApiCall(ctx, file.AuthIndex, "GET", CodexUsageURL, headers, "")
	if err != nil {
		return nil, nil, nil, err
	}
	normBody, err := resp.NormalizedBody()
	if err != nil {
		return nil, nil, nil, err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, nil, nil, errors.New(sanitizeError(resp.StatusCode, normBody))
	}

	plan, windows, credits, err := ParseCodexUsage(normBody, nowMS)
	if err != nil {
		return nil, nil, nil, err
	}

	// The usage payload omits subscription expiry for most accounts, so fall
	// back to the CPA-projected id_token claim (CPAMC's renewal source).
	if plan != nil && plan.ExpiresAtMS == nil {
		if untilMS, ok := file.CodexSubscriptionActiveUntil(); ok && untilMS > 0 {
			plan.ExpiresAtMS = &untilMS
		}
	}

	credits = s.fetchCodexResetCredits(ctx, file, headers, credits)
	return plan, windows, credits, nil
}

// fetchCodexResetCredits queries the dedicated rate-limit-reset-credits
// endpoint, which lists individual credit expiries that the usage payload
// omits. CPAMC precedence: dedicated available_count first, usage payload as
// fallback; the richer credits list wins; applicable counts prefer usage.
func (s *Service) fetchCodexResetCredits(ctx context.Context, file management.AuthFile, headers map[string]string, usageCredits *CodexResetCreditsInfo) *CodexResetCreditsInfo {
	creditsHeaders := map[string]string{
		"Content-Type": "application/json",
		"User-Agent":   CodexUserAgent,
		"Accept":       "application/json",
		"OpenAI-Beta":  "codex-1",
		"Originator":   "Codex Desktop",
	}
	for key, value := range headers {
		if key != "Content-Type" {
			creditsHeaders[key] = value
		}
	}

	resp, err := s.SafeApiCall(ctx, file.AuthIndex, "GET", CodexResetCreditsURL, creditsHeaders, "")
	if err != nil {
		return usageCredits
	}
	normBody, err := resp.NormalizedBody()
	if err != nil || resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return usageCredits
	}
	dedicated, err := ParseCodexResetCreditsPayload(normBody)
	if err != nil || dedicated == nil {
		return usageCredits
	}

	if usageCredits == nil {
		return dedicated
	}

	merged := &CodexResetCreditsInfo{
		AvailableCount:           usageCredits.AvailableCount,
		ApplicableAvailableCount: usageCredits.ApplicableAvailableCount,
		Credits:                  usageCredits.Credits,
		Error:                    usageCredits.Error,
	}
	if dedicated.AvailableCount > 0 {
		merged.AvailableCount = dedicated.AvailableCount
	} else if merged.AvailableCount == 0 && len(dedicated.Credits) > 0 {
		merged.AvailableCount = len(dedicated.Credits)
	}
	if len(dedicated.Credits) > 0 {
		merged.Credits = dedicated.Credits
	}
	if merged.ApplicableAvailableCount == 0 {
		merged.ApplicableAvailableCount = dedicated.ApplicableAvailableCount
	}
	return merged
}

func (s *Service) fetchClaudeQuota(ctx context.Context, file management.AuthFile, nowMS int64) (*QuotaPlan, []QuotaWindow, *QuotaExtraUsage, error) {
	headers := management.WithQuotaCredential(map[string]string{
		"Accept":         "application/json",
		"Content-Type":   "application/json",
		"anthropic-beta": "oauth-2025-04-20",
	})

	var plan *QuotaPlan
	profResp, profErr := s.SafeApiCall(ctx, file.AuthIndex, "GET", ClaudeProfileURL, headers, "")
	if profErr == nil && profResp.StatusCode == 200 {
		if normProf, err := profResp.NormalizedBody(); err == nil {
			plan = ParseClaudeProfile(normProf)
		}
	}

	usageResp, usageErr := s.SafeApiCall(ctx, file.AuthIndex, "GET", ClaudeUsageURL, headers, "")
	if usageErr != nil {
		return plan, nil, nil, usageErr
	}
	normUsage, err := usageResp.NormalizedBody()
	if err != nil {
		return plan, nil, nil, err
	}
	if usageResp.StatusCode < 200 || usageResp.StatusCode >= 300 {
		return plan, nil, nil, errors.New(sanitizeError(usageResp.StatusCode, normUsage))
	}

	windows, extraUsage, err := ParseClaudeUsage(normUsage, nowMS)
	if err != nil {
		return plan, nil, nil, err
	}
	return plan, windows, extraUsage, nil
}

func (s *Service) fetchAntigravityQuota(ctx context.Context, file management.AuthFile, nowMS int64) ([]QuotaWindow, error) {
	projectID := resolveAntigravityProjectID(file)
	if projectID == "" {
		return nil, errors.New("antigravity auth file missing project_id")
	}

	headers := management.WithQuotaCredential(map[string]string{
		"Content-Type": "application/json",
		"Accept":       "application/json",
		"User-Agent":   AntigravityUserAgent,
	})
	reqData := fmt.Sprintf(`{"project":%q}`, projectID)

	urls := []string{
		AntigravityQuotaURLDaily,
		AntigravityQuotaURLSandbox,
		AntigravityQuotaURLCloud,
	}

	var lastErr error
	for _, targetURL := range urls {
		resp, err := s.SafeApiCall(ctx, file.AuthIndex, "POST", targetURL, headers, reqData)
		if err != nil {
			lastErr = err
			continue
		}
		normBody, bErr := resp.NormalizedBody()
		if bErr != nil {
			lastErr = bErr
			continue
		}
		if resp.StatusCode >= 200 && resp.StatusCode < 300 {
			return ParseAntigravityUsage(normBody, nowMS, 0)
		}
		lastErr = errors.New(sanitizeError(resp.StatusCode, normBody))
	}

	if lastErr != nil {
		return nil, lastErr
	}
	return nil, errors.New("antigravity quota query failed")
}

func (s *Service) fetchKimiQuota(ctx context.Context, file management.AuthFile, nowMS int64) ([]QuotaWindow, error) {
	headers := management.WithQuotaCredential(map[string]string{
		"Accept": "application/json",
	})
	resp, err := s.SafeApiCall(ctx, file.AuthIndex, "GET", KimiUsageURL, headers, "")
	if err != nil {
		return nil, err
	}
	normBody, err := resp.NormalizedBody()
	if err != nil {
		return nil, err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, errors.New(sanitizeError(resp.StatusCode, normBody))
	}

	return ParseKimiUsage(normBody, nowMS)
}

// fetchXaiQuota prefers the free billing endpoint; the paid-account health probe
// is the fallback for credentials the billing endpoint does not recognise.
func (s *Service) fetchXaiQuota(ctx context.Context, file management.AuthFile, nowMS int64) (*QuotaPlan, []QuotaWindow, error) {
	headers := management.WithQuotaCredential(map[string]string{
		"x-xai-token-auth":      "xai-grok-cli",
		"x-grok-client-version": XaiGrokClientVersion,
		"user-agent":            XaiGrokUserAgent,
		"Accept":                "*/*",
	})

	resp, err := s.SafeApiCall(ctx, file.AuthIndex, "GET", XaiBillingMonthlyURL, headers, "")
	if err == nil && resp.StatusCode == 200 {
		if normBody, bErr := resp.NormalizedBody(); bErr == nil {
			return ParseXaiBilling(normBody, nowMS)
		}
	}

	paidHeaders := management.WithQuotaCredential(map[string]string{
		"Accept": "application/json",
	})
	meResp, meErr := s.SafeApiCall(ctx, file.AuthIndex, "GET", XaiApiMeURL, paidHeaders, "")
	if meErr == nil && meResp.StatusCode == 200 {
		plan := &QuotaPlan{
			PlanType:  "paid",
			PlanLabel: "xAI API Paid",
			Tier:      "standard",
		}
		return plan, []QuotaWindow{}, nil
	}

	if resp.StatusCode != 0 {
		normBody, _ := resp.NormalizedBody()
		return nil, nil, errors.New(sanitizeError(resp.StatusCode, normBody))
	}
	if err != nil {
		return nil, nil, err
	}
	return nil, nil, errors.New("xAI quota fetch failed")
}

// fetchDevinQuota reads a Devin credential's seat status.
//
// The request is a POST whose body carries CPA's credential marker: Devin's seat
// API authenticates from the `apiKey` request field rather than a header, so the
// token is substituted inside the payload by CPA and never reaches this process.
func (s *Service) fetchDevinQuota(ctx context.Context, file management.AuthFile, nowMS int64) (*QuotaPlan, []QuotaWindow, error) {
	body, err := BuildDevinQuotaRequestBody()
	if err != nil {
		return nil, nil, err
	}
	headers := map[string]string{
		"Content-Type":             "application/json",
		"Connect-Protocol-Version": DevinConnectProtocolVersion,
	}

	resp, err := s.SafeApiCall(ctx, file.AuthIndex, http.MethodPost, DevinSeatStatusURL, headers, body)
	if err != nil {
		return nil, nil, err
	}
	normBody, err := resp.NormalizedBody()
	if err != nil {
		return nil, nil, err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, nil, errors.New(sanitizeError(resp.StatusCode, normBody))
	}
	return ParseDevinSeatStatus(normBody, nowMS)
}

// RedeemCodexCredit consumes an available rate limit reset credit for a Codex credential.
func (s *Service) RedeemCodexCredit(ctx context.Context, authIndex string) error {
	if s.client == nil {
		return errors.New("CPA client is not configured")
	}
	redeemID := uuid.New().String()
	body := fmt.Sprintf(`{"redeem_request_id":%q}`, redeemID)
	headers := management.WithQuotaCredential(map[string]string{
		"Content-Type": "application/json",
		"Accept":       "application/json",
		"User-Agent":   CodexUserAgent,
	})

	resp, err := s.SafeApiCall(ctx, authIndex, "POST", CodexRedeemCreditURL, headers, body)
	if err != nil {
		return fmt.Errorf("redeem codex credit: %w", err)
	}
	normBody, err := resp.NormalizedBody()
	if err != nil {
		return err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return errors.New(sanitizeError(resp.StatusCode, normBody))
	}
	return nil
}

// ClearCPACooldown resets the CPA error cooldown for an auth_index.
func (s *Service) ClearCPACooldown(ctx context.Context, authIndex string) error {
	if s.client == nil {
		return errors.New("CPA client is not configured")
	}
	return s.client.ResetQuota(ctx, authIndex)
}
