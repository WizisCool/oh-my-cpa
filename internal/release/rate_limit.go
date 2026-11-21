package release

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
)

const (
	rateLimitMaxBytes = 64 * 1024

	RateLimitStatusValid     = "valid"
	RateLimitStatusAnonymous = "anonymous"
	RateLimitStatusInvalid   = "invalid"
	RateLimitStatusError     = "error"
)

// RateLimitProbe reports the outcome of a live GitHub /rate_limit check.
type RateLimitProbe struct {
	Status        string
	Authenticated bool
	Limit         int
	Remaining     int
	Used          int
	ResetAtMS     *int64
	Message       string
}

// ProbeGitHubRateLimit queries GitHub's free /rate_limit endpoint to verify a
// candidate or configured token and return the active core API rate-limit budget.
// Production callers pass an empty baseURL so requests always target GitHubAPIHost.
func ProbeGitHubRateLimit(ctx context.Context, transport http.RoundTripper, baseURL, token string) RateLimitProbe {
	trimmedBase := strings.TrimRight(strings.TrimSpace(baseURL), "/")
	if trimmedBase == "" {
		trimmedBase = "https://" + GitHubAPIHost
	}
	trimmedToken := strings.TrimSpace(token)

	request, err := http.NewRequestWithContext(ctx, http.MethodGet, trimmedBase+"/rate_limit", nil)
	if err != nil {
		return RateLimitProbe{Status: RateLimitStatusError, Message: "could not construct rate-limit request"}
	}
	request.Header.Set("Accept", "application/vnd.github+json")
	request.Header.Set("User-Agent", userAgent)
	request.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	if trimmedToken != "" {
		request.Header.Set("Authorization", "Bearer "+trimmedToken)
	}

	httpClient := &http.Client{
		Timeout:   requestTimeout,
		Transport: transport,
		// Never forward Authorization headers to a redirect target.
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}

	response, err := httpClient.Do(request)
	if err != nil {
		return RateLimitProbe{Status: RateLimitStatusError, Message: "could not reach GitHub API"}
	}
	defer response.Body.Close()

	if response.StatusCode == http.StatusUnauthorized && trimmedToken != "" {
		return RateLimitProbe{
			Status:        RateLimitStatusInvalid,
			Authenticated: false,
			Message:       "GitHub rejected the token",
		}
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return RateLimitProbe{
			Status:        RateLimitStatusError,
			Authenticated: false,
			Message:       fmt.Sprintf("GitHub API returned status %d", response.StatusCode),
		}
	}

	body, err := io.ReadAll(io.LimitReader(response.Body, rateLimitMaxBytes+1))
	if err != nil || int64(len(body)) > rateLimitMaxBytes {
		return RateLimitProbe{Status: RateLimitStatusError, Message: "unreadable GitHub rate-limit response"}
	}

	var decoded struct {
		Resources struct {
			Core struct {
				Limit     int   `json:"limit"`
				Remaining int   `json:"remaining"`
				Used      int   `json:"used"`
				Reset     int64 `json:"reset"`
			} `json:"core"`
		} `json:"resources"`
	}
	headerLimits := rateLimitFrom(response.Header)
	limit, remaining, used := int(headerLimits.Limit), int(headerLimits.Remaining), 0
	var resetAtMS *int64
	if headerLimits.ResetAtMS > 0 {
		ms := headerLimits.ResetAtMS
		resetAtMS = &ms
	}
	if json.Unmarshal(body, &decoded) == nil && decoded.Resources.Core.Limit > 0 {
		core := decoded.Resources.Core
		limit = core.Limit
		remaining = core.Remaining
		used = core.Used
		if core.Reset > 0 {
			ms := core.Reset * 1000
			resetAtMS = &ms
		}
	}
	if limit <= 0 {
		return RateLimitProbe{
			Status:        RateLimitStatusError,
			Authenticated: false,
			Message:       "GitHub API returned no rate-limit budget",
		}
	}
	if used == 0 && remaining <= limit {
		used = limit - remaining
	}

	status := RateLimitStatusAnonymous
	authenticated := false
	if trimmedToken != "" {
		status = RateLimitStatusValid
		authenticated = true
	}
	return RateLimitProbe{
		Status:        status,
		Authenticated: authenticated,
		Limit:         limit,
		Remaining:     remaining,
		Used:          used,
		ResetAtMS:     resetAtMS,
	}
}
