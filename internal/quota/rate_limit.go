package quota

import (
	"errors"
	"fmt"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/management"
)

// RETRY_AFTER_MAX bounds how long one Retry-After header can hold reads back. A provider that
// names an absurd delay, or a clock-skewed HTTP date far in the future, must not silence a
// credential for longer than the reset-driven retry window could ever use.
const RETRY_AFTER_MAX = time.Hour

// RateLimitSignal is an upstream refusal to answer because the caller asked too often.
//
// It is not a quota reading: a 429 from the usage endpoint says nothing about the credential's
// windows, only that the next read has to wait. RetryAfter is zero when the provider named no
// delay, and the caller then chooses its own backoff.
type RateLimitSignal struct {
	StatusCode int
	RetryAfter time.Duration
}

// ClaudeResetGrantsState pairs a provider gate's remembered reset-grants result
// with its observed status and error code so queued or retrying reads carry the
// newest grant observation rather than an older prior snapshot.
type ClaudeResetGrantsState struct {
	Grants   []ClaudeResetGrant
	Observed bool
	Error    string
}

// CloneClaudeResetGrants returns a deep copy of grants so cached gate state and
// callers never share mutable slice or pointer fields.
func CloneClaudeResetGrants(grants []ClaudeResetGrant) []ClaudeResetGrant {
	if grants == nil {
		return nil
	}
	cloned := make([]ClaudeResetGrant, len(grants))
	for i, grant := range grants {
		if grant.EndsAtMS != nil {
			endsAtMS := *grant.EndsAtMS
			grant.EndsAtMS = &endsAtMS
		}
		grant.Clears = slices.Clone(grant.Clears)
		cloned[i] = grant
	}
	return cloned
}

// ReadOptions names the supplementary reads a refresh may leave out because the caller holds a
// recent answer for them. The zero value reads everything.
type ReadOptions struct {
	// IsClaudeProfileFresh reuses the prior reading's plan instead of reading the profile.
	IsClaudeProfileFresh bool
	// IsClaudeResetGrantsFresh carries the cached reset grants instead of listing them.
	IsClaudeResetGrantsFresh bool
	// ClaudeResetGrants is the gate's last known grant state for this credential. When
	// IsClaudeResetGrantsFresh is true it is reused directly; when false it serves as the
	// fallback preserved on a failed grants read, superseding an older prior snapshot.
	ClaudeResetGrants *ClaudeResetGrantsState
}

// RateLimitedError is a read the provider refused with a rate limit. Its text is the same
// "HTTP 429..." the console has always shown, so a reading's error is unchanged; the signal
// rides beside it for the caller that schedules the next read.
type RateLimitedError struct {
	Signal  RateLimitSignal
	Message string
}

func (e *RateLimitedError) Error() string { return e.Message }

// rateLimitOf reports a rate-limited response and the delay it asked for, or nil.
func rateLimitOf(resp management.ApiCallResponse, now time.Time) *RateLimitSignal {
	if resp.StatusCode != http.StatusTooManyRequests {
		return nil
	}
	return &RateLimitSignal{StatusCode: resp.StatusCode, RetryAfter: ParseRetryAfter(resp.Header, now)}
}

// rateLimitedErrorOf turns a rate-limited response into the read's error.
func rateLimitedErrorOf(resp management.ApiCallResponse, now time.Time) error {
	signal := rateLimitOf(resp, now)
	if signal == nil {
		return nil
	}
	body, _ := resp.NormalizedBody()
	return &RateLimitedError{Signal: *signal, Message: sanitizeError(resp.StatusCode, body)}
}

// ParseRetryAfter reads a Retry-After header as either delta-seconds or an HTTP date.
//
// The header map has been through CPA's JSON relay, so its key casing is whatever the upstream
// sent. A missing, malformed or past value is zero; a value beyond RETRY_AFTER_MAX is clamped.
func ParseRetryAfter(header map[string][]string, now time.Time) time.Duration {
	value := ""
	for key, values := range header {
		if strings.EqualFold(key, "Retry-After") && len(values) > 0 {
			value = strings.TrimSpace(values[0])
			break
		}
	}
	if value == "" {
		return 0
	}
	var delay time.Duration
	if seconds, err := strconv.ParseInt(value, 10, 64); err == nil {
		if seconds <= 0 {
			return 0
		}
		if seconds > int64(RETRY_AFTER_MAX/time.Second) {
			return RETRY_AFTER_MAX
		}
		delay = time.Duration(seconds) * time.Second
	} else if instant, err := http.ParseTime(value); err == nil {
		delay = instant.Sub(now)
	} else {
		return 0
	}
	return min(max(delay, 0), RETRY_AFTER_MAX)
}

// RateLimitOfError extracts the signal a rate-limited read carried, or nil.
func RateLimitOfError(err error) *RateLimitSignal {
	var rateLimited *RateLimitedError
	if errors.As(err, &rateLimited) {
		signal := rateLimited.Signal
		return &signal
	}
	return nil
}

// DeferredReading answers a read the caller did not send because the provider is still asking
// it to wait: the previous numbers marked stale, with the wait as the reason. Nothing went
// upstream, so the reading is flagged and its caller records no attempt.
func (s *Service) DeferredReading(file management.AuthFile, prior *NormalizedQuota, retryAt time.Time) *NormalizedQuota {
	now := s.Now()
	result := newReading(file, prior, now.UnixMilli())
	wait := max(retryAt.Sub(now).Round(time.Second), time.Second)
	applyReadFailure(result, prior, fmt.Errorf("HTTP %d: rate limited upstream, next read in %s", http.StatusTooManyRequests, wait))
	result.RateLimit = nil
	result.IsDeferred = true
	EvaluateStatusAndRecommendation(result, now.UnixMilli())
	return result
}
