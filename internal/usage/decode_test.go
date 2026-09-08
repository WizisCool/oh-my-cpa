package usage

import (
	"encoding/json"

	"github.com/oh-my-cpa/oh-my-cpa/internal/crypto"
	"strings"
	"testing"
	"time"
)

func TestClassifyPassesRealUsageRecords(t *testing.T) {
	raw := `{"request_id":"abc","model":"gemini-2.5-pro","tokens":{"total_tokens":7}}`
	if got := Classify(raw); got.IsControl {
		t.Fatalf("real record classified as control: %+v", got)
	}
	// Whitespace and key order must not defeat the fast path.
	if got := Classify(`  { "tokens" : {} , "request_id" : "x" } `); got.IsControl {
		t.Fatalf("spaced real record classified as control: %+v", got)
	}
}

func TestClassifyRecognisesControlMessages(t *testing.T) {
	cases := []struct {
		raw            string
		supportRefresh bool
		refresh        bool
	}{
		{`{"support_refresh":true}`, true, false},
		{`{"refresh":true}`, true, true},
		{`  {"refresh" : true }  `, true, true},
	}
	for _, entry := range cases {
		got := Classify(entry.raw)
		if !got.IsControl || got.SupportRefresh != entry.supportRefresh || got.Refresh != entry.refresh {
			t.Fatalf("Classify(%q) = %+v, want control support=%v refresh=%v",
				entry.raw, got, entry.supportRefresh, entry.refresh)
		}
	}
}

func TestClassifyRejectsLooseControlLookalikes(t *testing.T) {
	for _, raw := range []string{
		`{"refresh":false}`,
		`{"refresh":"true"}`,
		`{"refresh":true,"extra":1}`,
		`{"unknown":true}`,
		`[]`,
		`{"refresh":true} trailing`,
		`not json`,
	} {
		if got := Classify(raw); got.IsControl {
			t.Fatalf("Classify(%q) reported control, want passthrough", raw)
		}
	}
}

func TestDecodeEventMapsFieldsAndNormalizes(t *testing.T) {
	raw := `{
		"timestamp":"2026-08-31T12:00:00.5Z",
		"latency_ms":1234,
		"ttft_ms":87,
		"source":"sk-local",
		"auth_index":"auth-1",
		"client_ip":"10.0.0.5",
		"x_forwarded_for":"",
		"user_agent":"codex-cli/0.46",
		"tokens":{"input_tokens":100,"output_tokens":40,"reasoning_tokens":12,
			"cached_tokens":0,"cache_read_tokens":8,"cache_read_tokens_present":true,
			"cache_creation_tokens":3,"total_tokens":150},
		"failed":false,
		"generate":true,
		"provider":"gemini",
		"executor_type":"GeminiExecutor",
		"model":"gemini-2.5-pro",
		"alias":"  pro  ",
		"endpoint":"",
		"auth_type":"api_key",
		"api_key":"sk-secret",
		"request_id":"  req-123  ",
		"reasoning_effort":"high",
		"service_tier":"priority"
	}`
	event, err := DecodeEvent(raw, "default", time.Unix(0, 0))
	if err != nil {
		t.Fatal(err)
	}
	if event.RequestID != "req-123" || event.EventKey != "req-123" {
		t.Fatalf("request id not trimmed: %+v", event)
	}
	if event.APIGroupKey == "sk-secret" || event.APIGroupKey != "[redacted]" || event.APIGroupLabel != "api_key" {
		t.Fatalf("api group key must be redacted and labeled, got key=%q label=%q", event.APIGroupKey, event.APIGroupLabel)
	}
	if event.AuthType != "apikey" {
		t.Fatalf("auth_type not normalized: %q", event.AuthType)
	}
	if event.ModelAlias == nil || *event.ModelAlias != "pro" {
		t.Fatalf("alias not trimmed: %+v", event.ModelAlias)
	}
	if event.Source != "[redacted]" {
		t.Fatalf("source must not be persisted in plaintext: %q", event.Source)
	}
	if event.XForwardedFor != nil {
		t.Fatalf("blank x_forwarded_for should be nil, got %q", *event.XForwardedFor)
	}
	if event.TimestampMS != time.Date(2026, 8, 31, 12, 0, 0, 500_000_000, time.UTC).UnixMilli() {
		t.Fatalf("timestamp mismatch: %d", event.TimestampMS)
	}
	if event.TotalTokens != 150 || event.CacheReadTokens != 8 || event.ReasoningTokens != 12 {
		t.Fatalf("tokens mapped wrong: %+v", event)
	}
	if event.TTFTMS == nil || *event.TTFTMS != 87 {
		t.Fatalf("ttft not mapped: %+v", event.TTFTMS)
	}
	if !event.Generate || event.Failed {
		t.Fatalf("flags wrong: %+v", event)
	}
}

func TestDecodeEventRequiresRequestID(t *testing.T) {
	if _, err := DecodeEvent(`{"model":"x"}`, "default", time.Now()); err == nil {
		t.Fatal("payload without request_id unexpectedly accepted")
	}
	if _, err := DecodeEvent(`{"request_id":"   "}`, "default", time.Now()); err == nil {
		t.Fatal("blank request_id unexpectedly accepted")
	}
	if _, err := DecodeEvent(`{not json`, "default", time.Now()); err == nil {
		t.Fatal("malformed json unexpectedly accepted")
	}
}

func TestDecodeEventBackfillsMissingTimestamp(t *testing.T) {
	observed := time.Date(2026, 8, 31, 10, 30, 0, 0, time.UTC)
	event, err := DecodeEvent(`{"request_id":"r1","model":"m"}`, "default", observed)
	if err != nil {
		t.Fatal(err)
	}
	if event.TimestampMS != observed.UnixMilli() {
		t.Fatalf("timestamp not backfilled to pop time: %d", event.TimestampMS)
	}
	// A record without a usable timestamp would be invisible to every windowed
	// dashboard query, so this fallback is load bearing.
}

func TestDecodeEventDefaultsModelAndGroup(t *testing.T) {
	event, err := DecodeEvent(`{"request_id":"r1"}`, "default", time.Unix(0, 0))
	if err != nil {
		t.Fatal(err)
	}
	if event.Model != "unknown" || event.APIGroupKey != "unknown" {
		t.Fatalf("defaults not applied: model=%q group=%q", event.Model, event.APIGroupKey)
	}
}

func TestDecodeEventInfersTotalWhenAbsent(t *testing.T) {
	event, err := DecodeEvent(`{"request_id":"r1","tokens":{"input_tokens":60,"output_tokens":15}}`,
		"default", time.Unix(0, 0))
	if err != nil {
		t.Fatal(err)
	}
	if event.TotalTokens != 75 {
		t.Fatalf("total should fall back to input+output, got %d", event.TotalTokens)
	}
}

func TestDecodeEventTreatsWebsocketWarmupAsNonGenerating(t *testing.T) {
	// Older CPA builds omit "generate"; a successful zero-token websocket call
	// is a warm-up and must not inflate token averages.
	event, err := DecodeEvent(`{"request_id":"r1","executor_type":"CodexWebsocketsExecutor"}`,
		"default", time.Unix(0, 0))
	if err != nil {
		t.Fatal(err)
	}
	if event.Generate {
		t.Fatal("zero-token websocket warm-up should decode as generate=false")
	}
	// With tokens present the same executor is a real generation.
	event, err = DecodeEvent(`{"request_id":"r2","executor_type":"CodexWebsocketsExecutor",
		"tokens":{"output_tokens":5}}`, "default", time.Unix(0, 0))
	if err != nil {
		t.Fatal(err)
	}
	if !event.Generate {
		t.Fatal("websocket call that produced tokens must keep generate=true")
	}
	// A failed call is not a warm-up either.
	event, err = DecodeEvent(`{"request_id":"r3","executor_type":"CodexWebsocketsExecutor","failed":true}`,
		"default", time.Unix(0, 0))
	if err != nil {
		t.Fatal(err)
	}
	if !event.Generate {
		t.Fatal("failed websocket call must keep generate=true")
	}
}

func TestDecodeEventHonoursExplicitGenerateFalse(t *testing.T) {
	event, err := DecodeEvent(`{"request_id":"r1","generate":false,"tokens":{"output_tokens":9}}`,
		"default", time.Unix(0, 0))
	if err != nil {
		t.Fatal(err)
	}
	if event.Generate {
		t.Fatal("explicit generate=false must be preserved")
	}
}

func TestDecodeErrorEventMapsQuotaAndSchedules(t *testing.T) {
	raw := `{
		"timestamp":"2026-08-31T09:00:00Z",
		"provider":"gemini","model":"gemini-2.5-pro","auth_id":"a1","auth_index":"auth-9",
		"status_code":429,"body":"resource exhausted","code":"rate_limit",
		"retryable":true,
		"auth_status":{"status":3,"status_message":"cooldown","disabled":false,"unavailable":true,
			"next_retry_after":"2026-08-31T09:05:00Z",
			"quota":{"exceeded":true,"reason":"daily","next_recover_at":"2026-08-31T16:00:00Z","backoff_level":2}}
	}`
	event, err := DecodeErrorEvent(raw, "default", time.Unix(0, 0))
	if err != nil {
		t.Fatal(err)
	}
	if event.StatusCode != 429 || !event.Retryable || event.QuotaReason != "daily" {
		t.Fatalf("error fields wrong: %+v", event)
	}
	if !event.QuotaExceeded || event.BackoffLevel != 2 || !event.AuthUnavailable {
		t.Fatalf("quota state wrong: %+v", event)
	}
	if event.NextRetryAfterMS == nil || *event.NextRetryAfterMS != time.Date(2026, 8, 31, 9, 5, 0, 0, time.UTC).UnixMilli() {
		t.Fatalf("next_retry_after wrong: %+v", event.NextRetryAfterMS)
	}
	if event.NextRecoverAtMS == nil || *event.NextRecoverAtMS == 0 {
		t.Fatalf("next_recover_at wrong: %+v", event.NextRecoverAtMS)
	}
	if !strings.HasPrefix(event.EventKey, "err-") || len(event.EventKey) != 4+24 {
		t.Fatalf("event key not derived from hash: %q", event.EventKey)
	}
	// The key must be stable so re-delivery cannot create duplicate rows.
	again, err := DecodeErrorEvent(raw, "default", time.Unix(0, 0))
	if err != nil || again.EventKey != event.EventKey {
		t.Fatalf("event key unstable: %q vs %q", event.EventKey, again.EventKey)
	}
}

func TestDecodeErrorEventWithoutQuotaBlock(t *testing.T) {
	event, err := DecodeErrorEvent(`{"status_code":500,"body":"boom"}`, "default",
		time.Date(2026, 8, 31, 8, 0, 0, 0, time.UTC))
	if err != nil {
		t.Fatal(err)
	}
	if event.TimestampMS != time.Date(2026, 8, 31, 8, 0, 0, 0, time.UTC).UnixMilli() {
		t.Fatalf("missing timestamp not backfilled: %d", event.TimestampMS)
	}
	if event.NextRecoverAtMS != nil || event.QuotaExceeded {
		t.Fatalf("absent quota block decoded as set: %+v", event)
	}
}

func TestPayloadKeepsUnknownFieldsAndCachePresence(t *testing.T) {
	// CPA adds fields over versions; decoding must not break, and the
	// present-flag must survive so a real zero is not confused with absence.
	var payload Payload
	raw := `{"request_id":"r1","brand_new_field":{"a":1},
		"tokens":{"cache_read_tokens":0,"cache_read_tokens_present":true}}`
	if err := json.Unmarshal([]byte(raw), &payload); err != nil {
		t.Fatal(err)
	}
	if !payload.Tokens.CacheReadTokensPresent || payload.Tokens.CacheReadTokens != 0 {
		t.Fatalf("cache presence flag lost: %+v", payload.Tokens)
	}
}

func TestDecodeEventWithFingerprinterUsesStableCredentialFingerprint(t *testing.T) {
	cipher, err := crypto.New("01234567890123456789012345678901")
	if err != nil {
		t.Fatal(err)
	}
	apiKey := "fixture-" + "credential-val-123"
	raw := `{"request_id":"r1","api_key":"` + apiKey + `","source":"` + apiKey + `","provider":"openai","endpoint":"https://user:pass@example.test/v1?token=` + apiKey + `#fragment","client_ip":"10.20.30.40","x_forwarded_for":"10.20.30.41, 192.0.2.9","user_agent":"codex-cli/0.46 (fixture)"}`
	event, err := DecodeEventWithFingerprinter(raw, "default", time.Unix(0, 0), cipher)
	if err != nil {
		t.Fatal(err)
	}
	if event.APIGroupLabel != "api_key" || event.APIGroupKey == apiKey || !strings.HasPrefix(event.APIGroupKey, "hmac:") {
		t.Fatalf("group identity = key=%q label=%q", event.APIGroupKey, event.APIGroupLabel)
	}
	if event.Source == apiKey || !strings.HasPrefix(event.Source, "hmac:") {
		t.Fatalf("source identity = %q", event.Source)
	}
	if event.Endpoint != "https://example.test/v1" {
		t.Fatalf("endpoint = %q", event.Endpoint)
	}
	if event.ClientIP == nil || *event.ClientIP != "10.20.30.0/24" {
		t.Fatalf("client IP = %v", event.ClientIP)
	}
	if event.XForwardedFor == nil || *event.XForwardedFor != "10.20.30.0/24" {
		t.Fatalf("forwarded-for = %v", event.XForwardedFor)
	}
	if event.UserAgent == nil || *event.UserAgent != "codex-cli/0.46" {
		t.Fatalf("user agent = %v", event.UserAgent)
	}
	// The display mask keeps the key recognisable without storing or exposing
	// it: the raw value must never survive decoding.
	if event.APIKeyMask != "fixture-xxxxxxx-123" {
		t.Fatalf("api key mask = %q", event.APIKeyMask)
	}
	if strings.Contains(event.APIKeyMask, apiKey) || strings.Contains(event.APIKeyMask, "credential-val") {
		t.Fatalf("api key mask leaks the key: %q", event.APIKeyMask)
	}
}

func TestDecodeEventWithoutAPIKeyHasNoMask(t *testing.T) {
	event, err := DecodeEvent(`{"request_id":"r2","provider":"openai"}`, "default", time.Unix(0, 0))
	if err != nil {
		t.Fatal(err)
	}
	if event.APIKeyMask != "" {
		t.Fatalf("mask for a keyless record = %q", event.APIKeyMask)
	}
	if event.APIGroupLabel != "provider" {
		t.Fatalf("group label = %q", event.APIGroupLabel)
	}
}

func TestDecodeErrorEventRedactsBody(t *testing.T) {
	secret := "fixture-error-token"
	raw := `{"status_code":502,"body":"Authorization: Bearer ` + secret + `; proxy=https://u:p@example.test/?token=` + secret + `","auth_status":{"status_message":"token=` + secret + `"}}`
	event, err := DecodeErrorEvent(raw, "default", time.Unix(0, 0))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(event.Body, secret) || strings.Contains(event.Body, "u:p") {
		t.Fatalf("error body contains secret: %q", event.Body)
	}
	if strings.Contains(event.AuthStatus, secret) {
		t.Fatalf("auth status contains secret: %q", event.AuthStatus)
	}
}
