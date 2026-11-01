package management

import (
	"context"
	"errors"
	"net/http"
	"time"
)

// CredentialRecoverySummary keeps absent evidence distinct from a confirmed false.
// It deliberately has no upstream free-form messages, account metadata or events.
type CredentialRecoverySummary struct {
	RequiresSignIn       *bool                   `json:"requires_sign_in,omitempty"`
	RenewalState         string                  `json:"renewal_state,omitempty"`
	RecoveryStage        string                  `json:"recovery_stage,omitempty"`
	AccessTokenExpiresAt string                  `json:"access_token_expires_at,omitempty"`
	NextRefreshAfter     string                  `json:"next_refresh_after,omitempty"`
	Adopted              *bool                   `json:"adopted,omitempty"`
	InferenceVerified    *bool                   `json:"inference_verified,omitempty"`
	RenewalVerified      *bool                   `json:"renewal_verified,omitempty"`
	RefreshError         *CredentialRefreshError `json:"refresh_error,omitempty"`
	NextAction           string                  `json:"next_action,omitempty"`
}

type CredentialRefreshError struct {
	Code       string `json:"code,omitempty"`
	HTTPStatus int    `json:"http_status,omitempty"`
}

func (s CredentialRecoverySummary) SafeRecoverySummary() CredentialRecoverySummary {
	switch s.RenewalState {
	case "sign_in_required", "expired_sign_in_required", "retry_scheduled", "awaiting_first_renewal", "renewal_verified":
	default:
		s.RenewalState = ""
	}
	switch s.RecoveryStage {
	case "sign_in_required", "quota_blocked", "loaded", "inference_verified", "renewal_verified":
	default:
		s.RecoveryStage = ""
	}
	s.AccessTokenExpiresAt = recoveryInstant(s.AccessTokenExpiresAt)
	s.NextRefreshAfter = recoveryInstant(s.NextRefreshAfter)
	if s.NextAction != "sign_in" {
		s.NextAction = ""
	}
	if s.RefreshError != nil {
		safe := *s.RefreshError
		// Codes are a closed vocabulary, not an arbitrary provider error or token.
		switch safe.Code {
		case "invalid_grant", "refresh_token_reused", "refresh_token_expired", "refresh_token_invalidated", "token_expired", "invalid_rapt", "invalid_refresh_token", "refresh_failed":
		default:
			safe.Code = "refresh_failed"
		}
		if safe.HTTPStatus < 400 || safe.HTTPStatus > 599 {
			safe.HTTPStatus = 0
		}
		s.RefreshError = &safe
	}
	return s
}

// RecoverySupported uses the lifecycle evidence introduced with targeted OAuth.
// Older gateways accepted auth-url while ignoring unknown selectors: never try
// that route without evidence that account pinning is understood.
func (s CredentialRecoverySummary) RecoverySupported() bool {
	return s.RequiresSignIn != nil && s.SafeRecoverySummary().RenewalState != ""
}

func recoveryInstant(raw string) string {
	instant, err := time.Parse(time.RFC3339, raw)
	if err != nil || instant.Unix() <= 0 {
		return ""
	}
	return instant.UTC().Format(time.RFC3339)
}

// VerifyAuthFile decodes only the outcome, never CPA's nested credential body.
func (c *Client) VerifyAuthFile(ctx context.Context, name, authIndex, model string) (bool, error) {
	var outcome struct {
		Verified bool `json:"verified"`
	}
	payload := struct {
		Name      string `json:"name,omitempty"`
		AuthIndex string `json:"auth_index,omitempty"`
		Model     string `json:"model,omitempty"`
	}{name, authIndex, model}
	if err := c.doJSONBody(ctx, http.MethodPost, "/credentials/verify", payload, &outcome); err != nil {
		return false, safeCredentialError(err)
	}
	return outcome.Verified, nil
}

// Credential and OAuth failures may quote tokens, callback codes or profiles.
// Keep their HTTP status class, never the body or transport URL, across the adapter.
func safeCredentialError(err error) error {
	var upstream *HTTPError
	if errors.As(err, &upstream) {
		return &HTTPError{StatusCode: upstream.StatusCode}
	}
	if errors.Is(err, ErrManagementV8Required) || errors.Is(err, ErrManagementDisabled) {
		return err
	}
	return errors.New("CPA credential operation failed")
}
