package quota

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/management"
)

const (
	CodexUsageURL               = "https://chatgpt.com/backend-api/wham/usage"
	CodexRedeemCreditURL        = "https://chatgpt.com/backend-api/wham/rate_limits/reset_credits/consume"
	ClaudeProfileURL            = "https://claude.ai/api/account"
	ClaudeUsageBaseURL          = "https://claude.ai/api/organizations"
	ClaudeApiUsageBaseURL       = "https://api.anthropic.com/api/organizations"
	AntigravityQuotaURLAlkali   = "https://alkalimakersuite-pa.clients6.google.com/v1alpha/projects"
	AntigravityQuotaURLCloud    = "https://cloudconsole-pa.clients6.google.com/v1alpha/projects"
	KimiUsageURL                = "https://api.moonshot.cn/v1/users/me/usage"
	XaiBillingMonthlyURL        = "https://x.ai/api/billing/usage/monthly"
	XaiBillingWeeklyURL         = "https://x.ai/api/billing/usage/weekly"
	XaiSubscriptionURL          = "https://api.x.ai/v1/billing/subscription"
)

// AllowedURLPrefixes strictly limits which upstream domains and endpoints may be called via CPA api-call.
var AllowedURLPrefixes = []string{
	"https://chatgpt.com/backend-api/wham/",
	"https://claude.ai/api/",
	"https://api.anthropic.com/api/",
	"https://alkalimakersuite-pa.clients6.google.com/v1alpha/projects/",
	"https://cloudconsole-pa.clients6.google.com/v1alpha/projects/",
	"https://api.moonshot.cn/v1/",
	"https://x.ai/api/billing/",
	"https://api.x.ai/v1/billing/",
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

// NewService creates a new Quota Service.
func NewService(client CPAClient) *Service {
	return &Service{client: client}
}

// DetectProvider maps file Type and Provider to a standard quota provider key.
func DetectProvider(fileType, provider string) string {
	t := strings.ToLower(strings.TrimSpace(fileType))
	p := strings.ToLower(strings.TrimSpace(provider))

	switch {
	case strings.Contains(t, "codex") || strings.Contains(p, "codex") || strings.Contains(t, "chatgpt"):
		return "codex"
	case strings.Contains(t, "claude") || strings.Contains(p, "claude") || strings.Contains(t, "anthropic") || strings.Contains(p, "anthropic"):
		return "claude"
	case strings.Contains(t, "antigravity") || strings.Contains(p, "antigravity") || strings.Contains(t, "gemini") || strings.Contains(p, "gemini"):
		return "antigravity"
	case strings.Contains(t, "kimi") || strings.Contains(p, "kimi") || strings.Contains(t, "moonshot") || strings.Contains(p, "moonshot"):
		return "kimi"
	case strings.Contains(t, "xai") || strings.Contains(p, "xai") || strings.Contains(t, "grok") || strings.Contains(p, "grok"):
		return "xai"
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
	case "claude", "antigravity", "kimi", "xai":
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

// RefreshCredentialQuota performs a live upstream query for a credential and returns normalized quota.
func (s *Service) RefreshCredentialQuota(ctx context.Context, authIndex, name, fileType, provider string, disabled bool, prior *NormalizedQuota) (*NormalizedQuota, error) {
	nowMS := time.Now().UnixMilli()
	stdProvider := DetectProvider(fileType, provider)
	caps := CapabilitiesForProvider(stdProvider)

	result := &NormalizedQuota{
		AuthIndex:    authIndex,
		Name:         name,
		Type:         fileType,
		Provider:     stdProvider,
		Disabled:     disabled,
		ObservedAtMS: nowMS,
		Capabilities: caps,
	}

	// If prior had raw signals or cooldown, preserve them
	if prior != nil {
		result.RawSignals = prior.RawSignals
		result.ActiveCooldown = prior.ActiveCooldown
		result.Plan = prior.Plan
		result.Windows = prior.Windows
		result.ResetCredits = prior.ResetCredits
	}

	if disabled {
		result.Status = "idle"
		EvaluateStatusAndRecommendation(result, nowMS)
		return result, nil
	}

	var fetchErr error

	switch stdProvider {
	case "codex":
		plan, windows, credits, err := s.fetchCodexQuota(ctx, authIndex, nowMS)
		if err != nil {
			fetchErr = err
		} else {
			result.Plan = plan
			result.Windows = windows
			result.ResetCredits = credits
		}

	case "claude":
		plan, windows, extraUsage, err := s.fetchClaudeQuota(ctx, authIndex, nowMS)
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
		windows, err := s.fetchAntigravityQuota(ctx, authIndex, nowMS)
		if err != nil {
			fetchErr = err
		} else {
			result.Windows = windows
			if result.Plan == nil {
				result.Plan = ResolveAntigravityPlan("pro")
			}
		}

	case "kimi":
		windows, err := s.fetchKimiQuota(ctx, authIndex, nowMS)
		if err != nil {
			fetchErr = err
		} else {
			result.Windows = windows
			if result.Plan == nil {
				result.Plan = &QuotaPlan{PlanType: "standard", PlanLabel: "Kimi API", Tier: "standard"}
			}
		}

	case "xai":
		plan, windows, err := s.fetchXaiQuota(ctx, authIndex, nowMS)
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
		// If prior had windows, mark as stale rather than wiping them out!
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

func (s *Service) fetchCodexQuota(ctx context.Context, authIndex string, nowMS int64) (*QuotaPlan, []QuotaWindow, *CodexResetCreditsInfo, error) {
	headers := map[string]string{
		"User-Agent": "ChatGPT/1.2025.0 (Android; 14)",
		"Accept":     "application/json",
	}
	resp, err := s.SafeApiCall(ctx, authIndex, "GET", CodexUsageURL, headers, "")
	if err != nil {
		return nil, nil, nil, err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, nil, nil, fmt.Errorf("HTTP %d: %s", resp.StatusCode, string(resp.Body))
	}

	return ParseCodexUsage(resp.Body, nowMS)
}

func (s *Service) fetchClaudeQuota(ctx context.Context, authIndex string, nowMS int64) (*QuotaPlan, []QuotaWindow, *QuotaExtraUsage, error) {
	headers := map[string]string{
		"Accept": "application/json",
	}
	// Try account profile first for plan
	var plan *QuotaPlan
	profResp, profErr := s.SafeApiCall(ctx, authIndex, "GET", ClaudeProfileURL, headers, "")
	if profErr == nil && profResp.StatusCode == 200 {
		plan = ParseClaudeProfile(profResp.Body)
	}

	// Try organizations usage endpoint
	usageURL := ClaudeUsageBaseURL + "/current/usage"
	usageResp, usageErr := s.SafeApiCall(ctx, authIndex, "GET", usageURL, headers, "")
	if usageErr != nil || usageResp.StatusCode != 200 {
		// Fallback to anthropic api usage endpoint
		usageURL = ClaudeApiUsageBaseURL + "/current/usage"
		usageResp, usageErr = s.SafeApiCall(ctx, authIndex, "GET", usageURL, headers, "")
	}

	if usageErr != nil {
		return plan, nil, nil, usageErr
	}
	if usageResp.StatusCode < 200 || usageResp.StatusCode >= 300 {
		return plan, nil, nil, fmt.Errorf("HTTP %d: %s", usageResp.StatusCode, string(usageResp.Body))
	}

	windows, extraUsage, err := ParseClaudeUsage(usageResp.Body, nowMS)
	if err != nil {
		return plan, nil, nil, err
	}
	return plan, windows, extraUsage, nil
}

func (s *Service) fetchAntigravityQuota(ctx context.Context, authIndex string, nowMS int64) ([]QuotaWindow, error) {
	headers := map[string]string{
		"Content-Type": "application/json",
		"Accept":       "application/json",
	}
	reqData := `{"project":"default"}`

	// Try Alkali MakerSuite first
	targetURL := AntigravityQuotaURLAlkali + "/default:getQuotaSummary"
	resp, err := s.SafeApiCall(ctx, authIndex, "POST", targetURL, headers, reqData)
	if err != nil || resp.StatusCode != 200 {
		// Fallback to CloudConsole
		targetURL = AntigravityQuotaURLCloud + "/default:getQuotaSummary"
		resp, err = s.SafeApiCall(ctx, authIndex, "POST", targetURL, headers, reqData)
	}

	if err != nil {
		return nil, err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("HTTP %d: %s", resp.StatusCode, string(resp.Body))
	}

	return ParseAntigravityUsage(resp.Body, nowMS, 0)
}

func (s *Service) fetchKimiQuota(ctx context.Context, authIndex string, nowMS int64) ([]QuotaWindow, error) {
	headers := map[string]string{
		"Accept": "application/json",
	}
	resp, err := s.SafeApiCall(ctx, authIndex, "GET", KimiUsageURL, headers, "")
	if err != nil {
		return nil, err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("HTTP %d: %s", resp.StatusCode, string(resp.Body))
	}

	return ParseKimiUsage(resp.Body, nowMS)
}

func (s *Service) fetchXaiQuota(ctx context.Context, authIndex string, nowMS int64) (*QuotaPlan, []QuotaWindow, error) {
	headers := map[string]string{
		"Accept": "application/json",
	}
	resp, err := s.SafeApiCall(ctx, authIndex, "GET", XaiBillingMonthlyURL, headers, "")
	if err != nil || resp.StatusCode != 200 {
		resp, err = s.SafeApiCall(ctx, authIndex, "GET", XaiSubscriptionURL, headers, "")
	}

	if err != nil {
		return nil, nil, err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, nil, fmt.Errorf("HTTP %d: %s", resp.StatusCode, string(resp.Body))
	}

	return ParseXaiBilling(resp.Body, nowMS)
}

// RedeemCodexCredit consumes an available rate limit reset credit for a Codex credential.
func (s *Service) RedeemCodexCredit(ctx context.Context, authIndex string) error {
	if s.client == nil {
		return errors.New("CPA client is not configured")
	}
	redeemID := uuid.New().String()
	body := fmt.Sprintf(`{"redeem_request_id":%q}`, redeemID)
	headers := map[string]string{
		"Content-Type": "application/json",
		"Accept":       "application/json",
		"User-Agent":   "ChatGPT/1.2025.0 (Android; 14)",
	}

	resp, err := s.SafeApiCall(ctx, authIndex, "POST", CodexRedeemCreditURL, headers, body)
	if err != nil {
		return fmt.Errorf("redeem codex credit: %w", err)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("redeem failed (HTTP %d): %s", resp.StatusCode, string(resp.Body))
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
