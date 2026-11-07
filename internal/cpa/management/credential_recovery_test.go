package management

import (
	"context"
	"encoding/json"
	"errors"
	"net/url"
	"strings"
	"testing"
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
