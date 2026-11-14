package management

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"regexp"
)

// CodexResetConsent contains only operator-editable fields, never the debit journal.
type CodexResetConsent struct {
	AccountKey          string `json:"account_key"`
	Enabled             *bool  `json:"enabled"`
	BeforeExpirySeconds int    `json:"before_expiry_seconds"`
}

// CodexResetPolicy is an allowlisted view of CPA's persistent reset policy.
type CodexResetPolicy struct {
	AccountKey          string `json:"account_key"`
	Enabled             *bool  `json:"enabled"`
	BeforeExpirySeconds int    `json:"before_expiry_seconds"`
	Pending             *bool  `json:"pending"`
	Result              string `json:"result"`
	NextCheckAt         int64  `json:"next_check_at"`
	LastCheckedAt       int64  `json:"last_checked_at"`
	LastResetAt         int64  `json:"last_reset_at"`
}

var codexResetAccountKey = regexp.MustCompile(`^codex-reset:[a-f0-9]{64}$`)

func (c CodexResetConsent) Valid() bool {
	return codexResetAccountKey.MatchString(c.AccountKey) && c.Enabled != nil && c.BeforeExpirySeconds >= 60 && c.BeforeExpirySeconds <= 86400
}

func (c *Client) CodexResetPolicy(ctx context.Context, authIndex string, consent *CodexResetConsent) (CodexResetPolicy, error) {
	endpoint := "/routing/codex-reset-policy?auth_index=" + url.QueryEscape(authIndex)
	var state CodexResetPolicy
	var err error
	if consent == nil {
		err = c.DoJSON(ctx, http.MethodGet, endpoint, &state)
	} else {
		err = c.doJSONBody(ctx, http.MethodPut, endpoint, consent, &state)
	}
	if err != nil {
		return CodexResetPolicy{}, err
	}
	if !codexResetAccountKey.MatchString(state.AccountKey) || state.Enabled == nil || state.Pending == nil || state.BeforeExpirySeconds < 60 || state.BeforeExpirySeconds > 86400 ||
		state.NextCheckAt < 0 || state.LastCheckedAt < 0 || state.LastResetAt < 0 {
		return CodexResetPolicy{}, errors.New("invalid Codex reset policy response")
	}
	if consent != nil && state.AccountKey != consent.AccountKey {
		return CodexResetPolicy{}, errors.New("Codex reset policy identity changed")
	}
	switch state.Result {
	case "disabled", "waiting", "not_eligible", "read_failed", "identity_changed", "unknown", "cooldown_pending", "reset", "no_credit", "nothing_to_reset":
	default:
		state.Result = "unknown"
	}
	return state, nil
}
