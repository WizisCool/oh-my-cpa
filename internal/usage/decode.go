// Package usage decodes CPA usage and error payloads into storable events.
//
// The wire format mirrors CLIProxyAPI's internal/redisqueue payloads: one JSON
// object per queued record, plus two control notifications that carry no
// request data.
package usage

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/security"
)

// ErrMissingRequestID rejects payloads that cannot be attributed to a request.
// CPA always sets it; a blank value means an unexpected or truncated record.
var ErrMissingRequestID = errors.New("usage payload is missing request_id")

// Control kinds reported by Classify.
const (
	ControlNone = iota
	ControlSupportRefresh
	ControlRefresh
)

// Classification tells the ingest runner whether a raw message is real data or
// a CPA notification.
type Classification struct {
	// IsControl marks messages that must never become usage events.
	IsControl bool
	// SupportRefresh records that CPA announced refresh notifications, which
	// lets the runner trust later refresh messages as genuine.
	SupportRefresh bool
	// Refresh signals that CPA-side configuration or credentials changed, so
	// metadata caches should be re-read.
	Refresh bool
}

// Classify inspects a raw payload without decoding the whole thing.
//
// Real usage records always contain "request_id", so that substring test is the
// hot path. Only the rare remainder pays for a strict single-field parse; a
// loose check would let malformed records masquerade as control traffic.
func Classify(raw string) Classification {
	if strings.Contains(raw, `"request_id"`) {
		return Classification{}
	}
	key, value, ok := singleBoolField(raw)
	if !ok {
		return Classification{}
	}
	switch key {
	case "support_refresh":
		if value {
			return Classification{IsControl: true, SupportRefresh: true}
		}
	case "refresh":
		if value {
			return Classification{IsControl: true, SupportRefresh: true, Refresh: true}
		}
	}
	return Classification{}
}

// singleBoolField accepts only an object with exactly one boolean field, so
// `{"refresh":true,"other":1}` is treated as data rather than a control.
func singleBoolField(raw string) (string, bool, bool) {
	trimmed := strings.TrimSpace(raw)
	if !strings.HasPrefix(trimmed, "{") || !strings.HasSuffix(trimmed, "}") {
		return "", false, false
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal([]byte(trimmed), &fields); err != nil || len(fields) != 1 {
		return "", false, false
	}
	for key, value := range fields {
		if strings.TrimSpace(string(value)) != "true" {
			return key, false, true
		}
		return key, true, true
	}
	return "", false, false
}

// TokenStats mirrors CPA's token accounting block.
//
// CacheReadPresent distinguishes a genuine zero from an older CPA build that
// omitted the field entirely; collapsing the two would misreport cache hits.
type TokenStats struct {
	InputTokens            int64 `json:"input_tokens"`
	OutputTokens           int64 `json:"output_tokens"`
	ReasoningTokens        int64 `json:"reasoning_tokens"`
	CachedTokens           int64 `json:"cached_tokens"`
	CacheReadTokens        int64 `json:"cache_read_tokens"`
	CacheReadTokensPresent bool  `json:"cache_read_tokens_present"`
	CacheCreationTokens    int64 `json:"cache_creation_tokens"`
	TotalTokens            int64 `json:"total_tokens"`
}

// Payload is one CPA usage record as published to the queue.
type Payload struct {
	Timestamp           time.Time       `json:"timestamp"`
	LatencyMS           int64           `json:"latency_ms"`
	TTFTMS              *int64          `json:"ttft_ms"`
	Source              string          `json:"source"`
	AuthIndex           string          `json:"auth_index"`
	ClientIP            *string         `json:"client_ip"`
	XForwardedFor       *string         `json:"x_forwarded_for"`
	UserAgent           *string         `json:"user_agent"`
	Tokens              TokenStats      `json:"tokens"`
	Failed              bool            `json:"failed"`
	Generate            *bool           `json:"generate"`
	Provider            string          `json:"provider"`
	ExecutorType        string          `json:"executor_type"`
	Model               string          `json:"model"`
	Alias               *string         `json:"alias"`
	Endpoint            string          `json:"endpoint"`
	AuthType            string          `json:"auth_type"`
	APIKey              string          `json:"api_key"`
	RequestID           string          `json:"request_id"`
	ReasoningEffort     string          `json:"reasoning_effort"`
	ServiceTier         string          `json:"service_tier"`
	ResponseServiceTier string          `json:"response_service_tier,omitempty"`
	AccountingVersion   int             `json:"accounting_version"`
	ResponseHeaders     json.RawMessage `json:"response_headers,omitempty"`
}

// Event is the decoded row for usage_events.
type Event struct {
	InstanceID    string
	EventKey      string
	APIGroupKey   string
	APIGroupLabel string
	// APIKeyMask is the display mask of the client key CPA published. It is not
	// an identity: grouping, filtering and credential binding all use
	// APIGroupKey, because two different keys can share a mask.
	APIKeyMask          string
	Provider            string
	Endpoint            string
	AuthType            string
	RequestID           string
	ClientIP            *string
	XForwardedFor       *string
	UserAgent           *string
	Model               string
	ModelAlias          *string
	ReasoningEffort     string
	ServiceTier         string
	ResponseServiceTier string
	ExecutorType        string
	TimestampMS         int64
	Source              string
	AuthIndex           string
	Failed              bool
	Generate            bool
	LatencyMS           int64
	TTFTMS              *int64
	InputTokens         int64
	OutputTokens        int64
	ReasoningTokens     int64
	CachedTokens        int64
	CacheReadTokens     int64
	CacheCreationTokens int64
	TotalTokens         int64
}

// DecodeEvent converts a raw queue message into an Event.
//
// observedAt is the pop time and backfills a missing/zero record timestamp: a
// record without a usable timestamp would otherwise be invisible to every
// time-windowed dashboard query.
func DecodeEvent(raw string, instanceID string, observedAt time.Time) (Event, error) {
	return DecodeEventWithFingerprinter(raw, instanceID, observedAt, nil)
}

// DecodeEventWithFingerprinter decodes a queue record while ensuring values that
// can identify a client credential are either keyed or replaced by a marker.
func DecodeEventWithFingerprinter(raw string, instanceID string, observedAt time.Time, fingerprinter security.Fingerprinter) (Event, error) {
	var payload Payload
	if err := json.Unmarshal([]byte(raw), &payload); err != nil {
		return Event{}, fmt.Errorf("decode usage payload: %w", err)
	}
	requestID := boundedSafe(payload.RequestID, 256)
	if requestID == "" {
		return Event{}, ErrMissingRequestID
	}

	timestamp := payload.Timestamp
	if timestamp.IsZero() {
		timestamp = observedAt
	}
	groupKey, groupLabel := apiGroupIdentity(payload, fingerprinter)
	event := Event{
		InstanceID:    boundedSafe(instanceID, 256),
		EventKey:      requestID,
		APIGroupKey:   groupKey,
		APIGroupLabel: groupLabel,
		// Display-only: the recognisable mask of the client key CPA published.
		// Identity stays the keyed fingerprint in APIGroupKey; the mask never
		// reaches the fingerprint or the binding logic.
		APIKeyMask:          security.MaskSecret(payload.APIKey),
		Provider:            boundedSafe(payload.Provider, 256),
		Endpoint:            security.PublicEndpoint(payload.Endpoint),
		AuthType:            normalizeAuthType(payload.AuthType),
		RequestID:           requestID,
		ClientIP:            maskPointer(payload.ClientIP, security.MaskIP),
		XForwardedFor:       maskPointer(payload.XForwardedFor, security.MaskForwardedFor),
		UserAgent:           security.MinimizeUserAgent(valueOf(payload.UserAgent)),
		Model:               orUnknown(boundedSafe(payload.Model, 256)),
		ModelAlias:          cleanBoundedString(payload.Alias, 256),
		ReasoningEffort:     boundedSafe(payload.ReasoningEffort, 128),
		ServiceTier:         boundedSafe(payload.ServiceTier, 128),
		ResponseServiceTier: boundedSafe(payload.ResponseServiceTier, 128),
		ExecutorType:        boundedSafe(payload.ExecutorType, 128),
		TimestampMS:         timestamp.UnixMilli(),
		Source:              security.FingerprintOrRedacted(fingerprinter, "usage-source", payload.Source),
		AuthIndex:           boundedSafe(payload.AuthIndex, 256),
		Failed:              payload.Failed,
		// Older CPA builds have no generate flag. Only a successful websocket
		// executor call with no tokens at all counts as a warm-up.
		Generate:            generate(payload.Generate, payload.Failed, payload.ExecutorType, payload.Tokens),
		LatencyMS:           nonNegative(payload.LatencyMS),
		TTFTMS:              nonNegativePointer(payload.TTFTMS),
		InputTokens:         nonNegative(payload.Tokens.InputTokens),
		OutputTokens:        nonNegative(payload.Tokens.OutputTokens),
		ReasoningTokens:     nonNegative(payload.Tokens.ReasoningTokens),
		CachedTokens:        nonNegative(payload.Tokens.CachedTokens),
		CacheReadTokens:     nonNegative(payload.Tokens.CacheReadTokens),
		CacheCreationTokens: nonNegative(payload.Tokens.CacheCreationTokens),
		TotalTokens:         totalTokens(payload.Tokens),
	}
	return event, nil
}

// ErrorPayload is one CPA credential error notification.
type ErrorPayload struct {
	Timestamp  time.Time `json:"timestamp"`
	Provider   string    `json:"provider"`
	Model      string    `json:"model"`
	AuthID     string    `json:"auth_id"`
	AuthIndex  string    `json:"auth_index"`
	StatusCode int       `json:"status_code"`
	Body       string    `json:"body"`
	Code       string    `json:"code"`
	Retryable  bool      `json:"retryable"`
	AuthStatus struct {
		// CPA reports this as a numeric status enum; only the message and the
		// boolean flags carry meaning for storage. json.RawMessage keeps a
		// future format change here from rejecting the whole record.
		Status         json.RawMessage `json:"status"`
		StatusMessage  string          `json:"status_message"`
		Disabled       bool            `json:"disabled"`
		Unavailable    bool            `json:"unavailable"`
		NextRetryAfter *time.Time      `json:"next_retry_after"`
		Quota          *struct {
			Exceeded      bool       `json:"exceeded"`
			Reason        string     `json:"reason"`
			NextRecoverAt *time.Time `json:"next_recover_at"`
			BackoffLevel  int        `json:"backoff_level"`
		} `json:"quota"`
	} `json:"auth_status"`
}

// ErrorEvent is the decoded row for error_events.
type ErrorEvent struct {
	InstanceID       string
	EventKey         string
	RequestID        string
	Provider         string
	Model            string
	AuthID           string
	AuthIndex        string
	StatusCode       int
	Code             string
	Body             string
	Retryable        bool
	AuthStatus       string
	AuthDisabled     bool
	AuthUnavailable  bool
	QuotaExceeded    bool
	QuotaReason      string
	NextRetryAfterMS *int64
	NextRecoverAtMS  *int64
	BackoffLevel     int
	TimestampMS      int64
}

// DecodeErrorEvent converts a raw errors-channel message into an ErrorEvent.
// Error notifications carry no request id, so the hash keys the row instead.
func DecodeErrorEvent(raw string, instanceID string, observedAt time.Time) (ErrorEvent, error) {
	return DecodeErrorEventWithFingerprinter(raw, instanceID, observedAt, nil)
}

// DecodeErrorEventWithFingerprinter keeps the error event key stable without
// deriving it from an exposed raw payload digest when a keyed service exists.
func DecodeErrorEventWithFingerprinter(raw string, instanceID string, observedAt time.Time, fingerprinter security.Fingerprinter) (ErrorEvent, error) {
	var payload ErrorPayload
	if err := json.Unmarshal([]byte(raw), &payload); err != nil {
		return ErrorEvent{}, fmt.Errorf("decode error event: %w", err)
	}
	timestamp := payload.Timestamp
	if timestamp.IsZero() {
		timestamp = observedAt
	}
	eventKey := "err-" + Hash(security.RedactPayload(raw))[:24]
	if fingerprinted, err := security.Fingerprint(fingerprinter, "error-event", raw); err == nil && strings.HasPrefix(fingerprinted, "hmac:") && len(fingerprinted) >= len("hmac:")+24 {
		eventKey = "err-" + fingerprinted[len("hmac:"):len("hmac:")+24]
	}
	event := ErrorEvent{
		InstanceID:      boundedSafe(instanceID, 256),
		EventKey:        eventKey,
		Provider:        boundedSafe(payload.Provider, 256),
		Model:           boundedSafe(payload.Model, 256),
		AuthID:          boundedSafe(payload.AuthID, 256),
		AuthIndex:       boundedSafe(payload.AuthIndex, 256),
		StatusCode:      payload.StatusCode,
		Code:            boundedSafe(payload.Code, 256),
		Body:            security.RedactText(strings.TrimSpace(payload.Body)),
		Retryable:       payload.Retryable,
		AuthStatus:      security.RedactText(boundedSafe(payload.AuthStatus.StatusMessage, 512)),
		AuthDisabled:    payload.AuthStatus.Disabled,
		AuthUnavailable: payload.AuthStatus.Unavailable,
		TimestampMS:     timestamp.UnixMilli(),
	}
	if payload.AuthStatus.NextRetryAfter != nil {
		value := payload.AuthStatus.NextRetryAfter.UnixMilli()
		event.NextRetryAfterMS = &value
	}
	if quota := payload.AuthStatus.Quota; quota != nil {
		event.QuotaExceeded = quota.Exceeded
		event.QuotaReason = security.RedactText(boundedSafe(quota.Reason, 512))
		event.BackoffLevel = quota.BackoffLevel
		if quota.NextRecoverAt != nil {
			value := quota.NextRecoverAt.UnixMilli()
			event.NextRecoverAtMS = &value
		}
	}
	return event, nil
}

// Hash identifies a raw message for diagnostics and inbox dedupe reporting.
func Hash(raw string) string {
	sum := sha256.Sum256([]byte(raw))
	return hex.EncodeToString(sum[:])
}

func apiGroupIdentity(payload Payload, fingerprinter security.Fingerprinter) (string, string) {
	if apiKey := trim(payload.APIKey); apiKey != "" {
		return security.FingerprintOrRedacted(fingerprinter, "usage-api-key", apiKey), "api_key"
	}
	if provider := boundedSafe(payload.Provider, 256); provider != "" {
		return provider, "provider"
	}
	if endpoint := security.PublicEndpoint(payload.Endpoint); endpoint != "" {
		return endpoint, "endpoint"
	}
	return "unknown", "unknown"
}

// apiGroupKey is retained for package-local callers and always returns a safe
// value, never the payload API key.
func apiGroupKey(payload Payload) string {
	key, _ := apiGroupIdentity(payload, nil)
	return key
}

// normalizeAuthType matches CPA's stored vocabulary where api keys are "apikey".
func normalizeAuthType(value string) string {
	trimmed := strings.ToLower(trim(value))
	if trimmed == "api_key" {
		return "apikey"
	}
	return trimmed
}

func generate(flag *bool, failed bool, executorType string, tokens TokenStats) bool {
	if flag != nil {
		return *flag
	}
	if !failed && strings.EqualFold(trim(executorType), "CodexWebsocketsExecutor") && tokensAllZero(tokens) {
		return false
	}
	return true
}

func tokensAllZero(tokens TokenStats) bool {
	return tokens.InputTokens == 0 && tokens.OutputTokens == 0 &&
		tokens.ReasoningTokens == 0 && tokens.CachedTokens == 0 &&
		tokens.CacheReadTokens == 0 && tokens.CacheCreationTokens == 0 &&
		tokens.TotalTokens == 0
}

// totalTokens falls back to input+output when a CPA build reports neither a
// total nor a consistent one, so the dashboard never under-counts silently.
func totalTokens(tokens TokenStats) int64 {
	if tokens.TotalTokens > 0 {
		return tokens.TotalTokens
	}
	if sum := tokens.InputTokens + tokens.OutputTokens; sum > 0 {
		return sum
	}
	return 0
}

func orUnknown(value string) string {
	if trimmed := trim(value); trimmed != "" {
		return trimmed
	}
	return "unknown"
}

func cleanString(value *string) *string {
	if value == nil {
		return nil
	}
	trimmed := strings.TrimSpace(*value)
	if trimmed == "" {
		return nil
	}
	return &trimmed
}

func boundedSafe(value string, limit int) string {
	value = security.RedactText(value)
	value = strings.TrimSpace(value)
	if limit > 0 && len([]rune(value)) > limit {
		value = string([]rune(value)[:limit])
	}
	return value
}

func valueOf(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func cleanBoundedString(value *string, limit int) *string {
	if value == nil {
		return nil
	}
	cleaned := boundedSafe(*value, limit)
	if cleaned == "" {
		return nil
	}
	return &cleaned
}

func maskPointer(value *string, mask func(string) *string) *string {
	if value == nil {
		return nil
	}
	return mask(*value)
}

func nonNegative(value int64) int64 {
	if value < 0 {
		return 0
	}
	return value
}

func nonNegativePointer(value *int64) *int64 {
	if value == nil {
		return nil
	}
	cleaned := nonNegative(*value)
	return &cleaned
}

func trim(value string) string { return strings.TrimSpace(value) }
