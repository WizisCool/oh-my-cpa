package management

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

func TestCredentialRecoverySummaryBoundsEvidence(t *testing.T) {
	var source CredentialRecoverySummary
	if err := json.Unmarshal([]byte(`{"requires_sign_in":false,"renewal_state":"SYNTHETIC-SECRET","recovery_stage":"https://provider.test/?code=PRIVATE-CODE","access_token_expires_at":"2026-11-01T10:00:00+02:00","next_refresh_after":"SYNTHETIC-SECRET","inference_verified":false,"refresh_error":{"code":"SYNTHETIC-SECRET","http_status":999,"message":"PRIVATE-CODE","profile":{"access_token":"SYNTHETIC-SECRET"}},"next_action":"SYNTHETIC-SECRET"}`), &source); err != nil {
		t.Fatal(err)
	}
	safe := source.SafeRecoverySummary()
	if safe.RefreshError == nil || safe.RefreshError.Code != "refresh_failed" || safe.RefreshError.HTTPStatus != 0 {
		t.Fatalf("unsafe refresh error: %+v", safe.RefreshError)
	}
	if source.RecoverySupported() || safe.RenewalState != "" || safe.RecoveryStage != "" || safe.AccessTokenExpiresAt != "2026-11-01T08:00:00Z" || safe.NextRefreshAfter != "" || safe.NextAction != "" {
		t.Fatalf("unsafe evidence: %+v", safe)
	}
	raw, err := json.Marshal(safe)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), "SYNTHETIC-SECRET") || strings.Contains(string(raw), "PRIVATE-CODE") || strings.Contains(string(raw), "999") || !strings.Contains(string(raw), `"inference_verified":false`) || strings.Contains(string(raw), "renewal_verified") {
		t.Fatalf("unsafe/unknown evidence: %s", raw)
	}
	raw, err = json.Marshal(CredentialRecoverySummary{}.SafeRecoverySummary())
	if err != nil || string(raw) != "{}" {
		t.Fatalf("missing evidence became healthy: %s %v", raw, err)
	}
}

func TestCredentialRecoverySummaryRefreshErrors(t *testing.T) {
	for _, test := range []struct {
		name, code, wantCode string
		status, wantStatus   int
	}{
		{"existing", "invalid_grant", "invalid_grant", 401, 401},
		{"outcome unknown", "refresh_outcome_unknown", "refresh_outcome_unknown", 502, 502},
		{"status lower bound", "refresh_outcome_unknown", "refresh_outcome_unknown", 400, 400},
		{"status upper bound", "refresh_outcome_unknown", "refresh_outcome_unknown", 599, 599},
		{"status below bound", "refresh_outcome_unknown", "refresh_outcome_unknown", 399, 0},
		{"status above bound", "refresh_outcome_unknown", "refresh_outcome_unknown", 600, 0},
		{"unrecognized", "new_provider_error", "refresh_failed", 503, 503},
		{"secret bearing", "refresh_outcome_unknown SYNTHETIC-SECRET", "refresh_failed", 401, 401},
	} {
		t.Run(test.name, func(t *testing.T) {
			source := CredentialRecoverySummary{RefreshError: &CredentialRefreshError{Code: test.code, HTTPStatus: test.status}}
			safe := source.SafeRecoverySummary()
			if safe.RefreshError == nil || safe.RefreshError.Code != test.wantCode || safe.RefreshError.HTTPStatus != test.wantStatus {
				t.Fatalf("refresh error: got %+v, want %s / %d", safe.RefreshError, test.wantCode, test.wantStatus)
			}
			if source.RefreshError.Code != test.code || source.RefreshError.HTTPStatus != test.status {
				t.Fatal("sanitizing the projection mutated the source")
			}
		})
	}
}

func TestCredentialErrorsPreserveCancellationWithoutRequestDetails(t *testing.T) {
	for _, cause := range []error{context.Canceled, context.DeadlineExceeded} {
		wrapped := &url.Error{Op: "POST", URL: "https://cpa.example.test/?state=PRIVATE-STATE", Err: cause}
		safe := safeCredentialError(wrapped)
		if !errors.Is(safe, cause) || safe != cause || strings.Contains(safe.Error(), "PRIVATE-STATE") {
			t.Fatalf("lost safe cancellation identity for %v: %v", cause, safe)
		}
	}
}

// A verify request that may have reached CPA is not a refusal a caller can repeat: a connection
// dropped before the answer, or a 2xx answer that cannot be read, is uncertain. A connection never
// made is a plain failure. Neither carries the gateway's address.
func TestVerifyAuthFileSeparatesUnansweredRequestsFromRefusals(t *testing.T) {
	gateway := func(answer func(http.ResponseWriter)) string {
		server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
			if request.URL.Path == "/v8/management"+MANAGEMENT_V8_PROBE_ENDPOINT {
				_, _ = writer.Write([]byte("8"))
				return
			}
			answer(writer)
		}))
		t.Cleanup(server.Close)
		return server.URL
	}
	dropped := gateway(func(writer http.ResponseWriter) {
		if connection, _, err := writer.(http.Hijacker).Hijack(); err == nil {
			_ = connection.Close()
		}
	})
	unreadable := gateway(func(writer http.ResponseWriter) { _, _ = writer.Write([]byte("<html>")) })
	closed := httptest.NewServer(http.NotFoundHandler())
	unreachable := closed.URL
	closed.Close()

	for _, test := range []struct {
		name        string
		baseURL     string
		isUncertain bool
	}{
		{"dropped", dropped, true},
		{"unreadable", unreadable, true},
		{"unreachable", unreachable, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			client, err := NewClient(test.baseURL, "management-key", 5*time.Second, false)
			if err != nil {
				t.Fatal(err)
			}
			_, err = client.VerifyAuthFile(context.Background(), "claude.json", "exact-claude", "claude-haiku-4-5")
			if err == nil || errors.Is(err, ErrCredentialOutcomeUnknown) != test.isUncertain || strings.Contains(err.Error(), "127.0.0.1") {
				t.Fatalf("verify error = %v, want uncertain %t", err, test.isUncertain)
			}
		})
	}
}

func TestVerifyAuthFileDistinguishesVerificationNotApplied409(t *testing.T) {
	for _, test := range []struct {
		name               string
		status             int
		body               string
		wantNotApplied     bool
		wantHTTPStatusCode int
	}{
		{
			name:           "cpa_error_prefix",
			status:         http.StatusConflict,
			body:           `{"status":"error","verified":false,"error":"verification_not_applied: upstream completed the verification request, but the credential is still cooling down or disabled; OPAQUE-SECRET","credential":{"access_token":"OPAQUE-SECRET"}}`,
			wantNotApplied: true,
		},
		{
			name:           "explicit_code_field",
			status:         http.StatusConflict,
			body:           `{"status":"error","verified":false,"code":"verification_not_applied","error":"OPAQUE-SECRET"}`,
			wantNotApplied: true,
		},
		{
			name:               "other_409_superseded",
			status:             http.StatusConflict,
			body:               `{"status":"error","verified":false,"error":"credential_superseded: credential was replaced OPAQUE-SECRET"}`,
			wantNotApplied:     false,
			wantHTTPStatusCode: http.StatusConflict,
		},
		{
			name:               "non_409_with_matching_code",
			status:             http.StatusBadGateway,
			body:               `{"code":"verification_not_applied","error":"verification_not_applied: OPAQUE-SECRET"}`,
			wantNotApplied:     false,
			wantHTTPStatusCode: http.StatusBadGateway,
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
				if request.URL.Path == "/v8/management"+MANAGEMENT_V8_PROBE_ENDPOINT {
					_, _ = writer.Write([]byte("8"))
					return
				}
				writer.Header().Set("Content-Type", "application/json")
				writer.WriteHeader(test.status)
				_, _ = writer.Write([]byte(test.body))
			}))
			t.Cleanup(server.Close)

			client, err := NewClient(server.URL, "management-key", 5*time.Second, false)
			if err != nil {
				t.Fatal(err)
			}
			verified, err := client.VerifyAuthFile(context.Background(), "claude.json", "exact-claude", "claude-haiku-4-5")
			if verified || err == nil {
				t.Fatalf("VerifyAuthFile = (%v, %v), want false and error", verified, err)
			}
			if strings.Contains(err.Error(), "OPAQUE-SECRET") {
				t.Fatalf("verify error leaked upstream detail: %v", err)
			}
			if errors.Is(err, ErrVerificationNotApplied) != test.wantNotApplied {
				t.Fatalf("errors.Is(err, ErrVerificationNotApplied) = %v, want %v (err=%v)", errors.Is(err, ErrVerificationNotApplied), test.wantNotApplied, err)
			}
			if !test.wantNotApplied {
				var httpErr *HTTPError
				if !errors.As(err, &httpErr) || httpErr.StatusCode != test.wantHTTPStatusCode || httpErr.Body != "" {
					t.Fatalf("sanitized HTTP error = %#v, want status %d with empty body", httpErr, test.wantHTTPStatusCode)
				}
			}
		})
	}
}

func TestAuthFileHasClearedCredentialCooldown(t *testing.T) {
	now := time.Date(2026, 11, 27, 15, 0, 0, 0, time.UTC)
	boolPtr := func(value bool) *bool { return &value }

	for _, test := range []struct {
		name string
		file AuthFile
		want bool
	}{
		{
			name: "active_available_no_retry",
			file: AuthFile{Status: "active", Disabled: false, Unavailable: false},
			want: true,
		},
		{
			name: "active_with_expired_retry",
			file: AuthFile{Status: "active", NextRetryAfter: now.Add(-time.Second).Format(time.RFC3339)},
			want: true,
		},
		{
			name: "active_with_model_only_quota_blocked",
			file: AuthFile{Status: "active", CredentialRecoverySummary: CredentialRecoverySummary{RecoveryStage: "quota_blocked"}},
			want: true,
		},
		{
			name: "active_with_future_retry",
			file: AuthFile{Status: "active", NextRetryAfter: now.Add(time.Minute).Format(time.RFC3339)},
			want: false,
		},
		{
			name: "active_with_malformed_retry",
			file: AuthFile{Status: "active", NextRetryAfter: "not-a-timestamp"},
			want: false,
		},
		{
			name: "error_unavailable_cooling",
			file: AuthFile{Status: "error", Unavailable: true, NextRetryAfter: now.Add(time.Hour).Format(time.RFC3339)},
			want: false,
		},
		{
			name: "disabled",
			file: AuthFile{Status: "active", Disabled: true},
			want: false,
		},
		{
			name: "requires_sign_in",
			file: AuthFile{Status: "active", CredentialRecoverySummary: CredentialRecoverySummary{RequiresSignIn: boolPtr(true)}},
			want: false,
		},
		{
			name: "sparse_missing_status",
			file: AuthFile{Name: "codex.json", AuthIndex: "idx-1"},
			want: false,
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			if got := test.file.HasClearedCredentialCooldown(now); got != test.want {
				t.Fatalf("HasClearedCredentialCooldown = %v, want %v", got, test.want)
			}
		})
	}

	for _, test := range []struct {
		name string
		raw  string
		want bool
	}{
		{
			name: "json_explicit_unavailable_false",
			raw:  `{"status":"active","disabled":false,"unavailable":false}`,
			want: true,
		},
		{
			name: "json_omitted_unavailable",
			raw:  `{"status":"active","disabled":false}`,
			want: false,
		},
		{
			name: "json_null_unavailable",
			raw:  `{"status":"active","disabled":false,"unavailable":null}`,
			want: false,
		},
		{
			name: "json_explicit_unavailable_true",
			raw:  `{"status":"active","disabled":false,"unavailable":true}`,
			want: false,
		},
		{
			name: "json_disabled_vetoes_active",
			raw:  `{"status":"active","disabled":true,"unavailable":false}`,
			want: false,
		},
		{
			name: "json_future_retry_vetoes_active",
			raw:  `{"status":"active","disabled":false,"unavailable":false,"next_retry_after":"2026-11-27T15:05:00Z"}`,
			want: false,
		},
		{
			name: "json_numeric_past_retry_tolerant",
			raw:  fmt.Sprintf(`{"status":"active","disabled":false,"unavailable":false,"next_retry_after":%d,"quota_blocked":"unknown"}`, now.Add(-time.Minute).Unix()),
			want: true,
		},
		{
			name: "json_numeric_future_retry_vetoes_active",
			raw:  fmt.Sprintf(`{"status":"active","disabled":false,"unavailable":false,"next_retry_after":%d}`, now.Add(time.Minute).Unix()),
			want: false,
		},
		{
			name: "json_object_retry_tolerant_and_conservative",
			raw:  `{"status":"active","disabled":false,"unavailable":false,"next_retry_after":{"seconds":60}}`,
			want: false,
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			var decoded AuthFile
			if err := json.Unmarshal([]byte(test.raw), &decoded); err != nil {
				t.Fatalf("Unmarshal(%s): %v", test.raw, err)
			}
			if got := decoded.HasClearedCredentialCooldown(now); got != test.want {
				t.Fatalf("decoded HasClearedCredentialCooldown = %v, want %v (file=%+v)", got, test.want, decoded)
			}
		})
	}
}
