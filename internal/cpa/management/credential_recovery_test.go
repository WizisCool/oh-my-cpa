package management

import (
	"context"
	"encoding/json"
	"errors"
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
