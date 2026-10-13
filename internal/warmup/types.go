// Package warmup owns opt-in credential window activation, not entitlement redemption.
package warmup

import (
	"errors"
	"regexp"
	"strings"
)

const (
	FIVE_HOUR_MS           int64 = 5 * 60 * 60 * 1000
	WEEK_MS                int64 = 7 * 24 * 60 * 60 * 1000
	DAILY_SLACK_MS         int64 = 60 * 60 * 1000
	OBSERVATION_MAX_AGE_MS int64 = 5 * 60 * 1000
)

var CLOCK_PATTERN = regexp.MustCompile(`^(?:[01][0-9]|2[0-3]):[0-5][0-9]$`)
var ErrInvalidPolicy = errors.New("invalid_warmup_policy")

type Policy struct {
	ResetMode      string `json:"reset_mode"`
	IsDailyEnabled bool   `json:"daily_enabled"`
	DailyTime      string `json:"daily_time"`
	Model          string `json:"model"`
}

func DefaultPolicy() Policy           { return Policy{ResetMode: "off", DailyTime: "06:00"} }
func (policy Policy) IsEnabled() bool { return policy.ResetMode != "off" || policy.IsDailyEnabled }
func (policy Policy) Validate() error {
	if policy.ResetMode != "off" && policy.ResetMode != "weekly" && policy.ResetMode != "all" {
		return ErrInvalidPolicy
	}
	if !CLOCK_PATTERN.MatchString(policy.DailyTime) || len(policy.Model) > 200 || strings.TrimSpace(policy.Model) != policy.Model || strings.ContainsAny(policy.Model, "\r\n\x00") {
		return ErrInvalidPolicy
	}
	if policy.IsEnabled() && policy.Model == "" {
		return ErrInvalidPolicy
	}
	return nil
}

type Settings struct {
	Providers map[string]Policy   `json:"providers"`
	Models    map[string][]string `json:"models"`
	Timezone  string              `json:"timezone"`
	Revision  string              `json:"revision"`
}
type PolicyWrite struct {
	Provider    string `json:"provider"`
	Policy      Policy `json:"policy"`
	Revision    string `json:"revision"`
	IsConfirmed bool   `json:"confirmed"`
}
type CredentialWrite struct {
	IsInherited bool   `json:"inherit"`
	Policy      Policy `json:"policy"`
	Revision    string `json:"revision"`
	IsConfirmed bool   `json:"confirmed"`
}
type Window struct {
	State       string   `json:"state"`
	UsedPercent *float64 `json:"used_percent,omitempty"`
	ResetAtMS   *int64   `json:"reset_at_ms,omitempty"`
	PeriodMS    int64    `json:"period_ms"`
}
type Observation struct {
	ModelWindows  map[string]Window `json:"model_windows,omitempty"`
	BlockedModels []string          `json:"blocked_models,omitempty"`
	ObservedAtMS  int64             `json:"observed_at_ms"`
	Provider      string            `json:"provider"`
	PaidFallback  string            `json:"paid_fallback"`
	PaidSource    string            `json:"paid_source"`
	FiveHour      Window            `json:"five_hour"`
	Weekly        Window            `json:"weekly"`
	IsBlocked     bool              `json:"blocked"`
}
type Result struct {
	RequestID    string `json:"request_id"`
	Status       string `json:"status"`
	Reason       string `json:"reason,omitempty"`
	Model        string `json:"model"`
	Trigger      string `json:"trigger"`
	StartedAtMS  int64  `json:"started_at_ms"`
	FinishedAtMS int64  `json:"finished_at_ms,omitempty"`
	InputTokens  *int64 `json:"input_tokens,omitempty"`
	OutputTokens *int64 `json:"output_tokens,omitempty"`
}
type ProtocolPause struct {
	Model  string `json:"model"`
	Reason string `json:"reason"`
}

type State struct {
	ProtocolPause      *ProtocolPause `json:"protocol_pause,omitempty"`
	ActivationBasis    *Observation   `json:"activation_basis,omitempty"`
	CredentialID       string         `json:"credential_id,omitempty"`
	Provider           string         `json:"provider,omitempty"`
	Observation        *Observation   `json:"observation,omitempty"`
	Generation         int64          `json:"generation"`
	DailyKey           string         `json:"daily_key,omitempty"`
	LastResult         *Result        `json:"last_result,omitempty"`
	LastCycle          string         `json:"last_cycle,omitempty"`
	NextAttemptMS      int64          `json:"next_attempt_ms,omitempty"`
	Failures           int            `json:"failures,omitempty"`
	VerificationReads  int            `json:"verification_reads,omitempty"`
	VerifiedModel      string         `json:"verified_model,omitempty"`
	IsProtocolVerified bool           `json:"protocol_verified"`
}

// ReadProtocolPause also recognizes state saved before independent refusal evidence existed.
func (state State) ReadProtocolPause() *ProtocolPause {
	if state.ProtocolPause != nil {
		return state.ProtocolPause
	}
	if state.LastResult != nil && (state.LastResult.Reason == "protocol_unsupported" || state.LastResult.Reason == "unexpected_tool") {
		return &ProtocolPause{Model: state.LastResult.Model, Reason: state.LastResult.Reason}
	}
	return nil
}

type Credential struct {
	AuthIndex   string   `json:"auth_index"`
	Provider    string   `json:"provider"`
	Name        string   `json:"name"`
	IsInherited bool     `json:"inherit"`
	Policy      Policy   `json:"policy"`
	Models      []string `json:"models"`
	Timezone    string   `json:"timezone"`
	Revision    string   `json:"revision"`
	NextAtMS    *int64   `json:"next_at_ms,omitempty"`
	Reason      string   `json:"reason,omitempty"`
	State       State    `json:"state"`
}

func IsProvider(provider string) bool { return provider == "codex" || provider == "claude" }
