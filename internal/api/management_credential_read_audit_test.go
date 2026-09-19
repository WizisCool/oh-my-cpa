package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestWriteAuditFailureContract(t *testing.T) {
	recorder := httptest.NewRecorder()
	writeAuditFailure(recorder, "audit log failure; credential reveal aborted")
	if recorder.Code != http.StatusInternalServerError {
		t.Fatalf("writeAuditFailure status = %d, want 500", recorder.Code)
	}
	var payload map[string]string
	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
		t.Fatalf("writeAuditFailure body is not JSON: %v (%s)", err, recorder.Body.String())
	}
	if payload["error"] != "audit log failure; credential reveal aborted" || payload["code"] != auditWriteFailedCode {
		t.Fatalf("writeAuditFailure body = %#v, want the audit failure error and code %q", payload, auditWriteFailedCode)
	}
}

// Credential-bearing list reads are audited only when the caller asks for the
// values, and the audit write is part of serving the response. A masked list is a
// metadata read, not a credential reveal, so it must remain unaudited and usable
// while the audit store is unhealthy.
func TestCredentialRevealReadsAreAuditedFailClosed(t *testing.T) {
	fixture := newProviderTestFixture(t)
	ctx := context.Background()

	auditCount := func(action string) int {
		t.Helper()
		events, err := fixture.handler.repo.ListAuditEvents(ctx, 100)
		if err != nil {
			t.Fatalf("list audit events: %v", err)
		}
		count := 0
		for _, event := range events {
			if event.Action == action {
				count++
			}
		}
		return count
	}

	for _, path := range []string{
		"/omc/api/v1/management/api-keys",
		"/omc/api/v1/management/providers",
	} {
		resp, payload := getJSON(t, fixture.client, fixture.baseURL+path)
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("masked read %s status = %d body %s", path, resp.StatusCode, payload)
		}
	}
	if got := auditCount("api_key.reveal"); got != 0 {
		t.Fatalf("masked client-key reads recorded %d reveal events, want 0", got)
	}
	if got := auditCount("provider.reveal_keys"); got != 0 {
		t.Fatalf("masked provider reads recorded %d reveal events, want 0", got)
	}

	resp, payload := getJSON(t, fixture.client, fixture.baseURL+"/omc/api/v1/management/api-keys?include_keys=true")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("client key reveal status = %d body %s", resp.StatusCode, payload)
	}
	resp, payload = getJSON(t, fixture.client, fixture.baseURL+"/omc/api/v1/management/providers?include_keys=true")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("provider key reveal status = %d body %s", resp.StatusCode, payload)
	}

	events, err := fixture.handler.repo.ListAuditEvents(ctx, 100)
	if err != nil {
		t.Fatalf("list audit events: %v", err)
	}
	byAction := make(map[string]struct {
		targetType string
		targetID   string
		details    map[string]any
	})
	for _, event := range events {
		byAction[event.Action] = struct {
			targetType string
			targetID   string
			details    map[string]any
		}{targetType: event.TargetType, targetID: event.TargetID, details: event.Details}
	}
	clientReveal, hasClientReveal := byAction["api_key.reveal"]
	if !hasClientReveal || clientReveal.targetType != "client_api_key" || clientReveal.targetID != "list" {
		t.Fatalf("client key reveal audit = %#v, want target client_api_key/list", clientReveal)
	}
	if got, hasKeyCount := clientReveal.details["key_count"].(float64); !hasKeyCount || got != 2 {
		t.Fatalf("client key reveal audit key_count = %#v, want 2", clientReveal.details["key_count"])
	}
	providerReveal, hasProviderReveal := byAction["provider.reveal_keys"]
	if !hasProviderReveal || providerReveal.targetType != "provider" || providerReveal.targetID != "list" {
		t.Fatalf("provider key reveal audit = %#v, want target provider/list", providerReveal)
	}
	if got, hasKeyCount := providerReveal.details["key_count"].(float64); !hasKeyCount || got != 5 {
		t.Fatalf("provider key reveal audit key_count = %#v, want 5", providerReveal.details["key_count"])
	}
	if got, hasProviderCount := providerReveal.details["provider_count"].(float64); !hasProviderCount || got != 5 {
		t.Fatalf("provider key reveal audit provider_count = %#v, want 5", providerReveal.details["provider_count"])
	}

	if _, err := fixture.handler.repo.SQL().Exec("DROP TABLE audit_events"); err != nil {
		t.Fatalf("drop audit_events: %v", err)
	}
	for _, path := range []string{
		"/omc/api/v1/management/api-keys?include_keys=true",
		"/omc/api/v1/management/providers?include_keys=true",
	} {
		resp, payload := getJSON(t, fixture.client, fixture.baseURL+path)
		if resp.StatusCode != http.StatusInternalServerError {
			t.Fatalf("reveal %s with an unhealthy audit store status = %d, want 500", path, resp.StatusCode)
		}
		var refusal struct {
			Error string `json:"error"`
			Code  string `json:"code"`
		}
		if err := json.Unmarshal(payload, &refusal); err != nil {
			t.Fatalf("reveal %s refusal is not JSON: %v", path, err)
		}
		if !strings.Contains(refusal.Error, "audit") || refusal.Code != auditWriteFailedCode {
			t.Fatalf("reveal %s refusal = %#v, want an audit error with code %q", path, refusal, auditWriteFailedCode)
		}
		for secretIndex, secret := range []string{
			"sk-original-key-1",
			"sk-codex-secret-key-9999",
			"sk-provider-secret-key-1234",
		} {
			if strings.Contains(string(payload), secret) {
				t.Fatalf("reveal %s leaked credential %d while the audit write failed", path, secretIndex)
			}
		}
	}
}
