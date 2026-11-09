package api

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"
)

// A plugin page written for CPAMC reads the management credential from browser
// storage. The console can only mirror it there if it can read it, so this read
// exists; it is a credential reveal and answers only when its audit was written.
func TestCPACredentialRevealServesTheStoredKeyAndAuditsIt(t *testing.T) {
	client, baseURL, repo, _ := startPluginTestServer(t)

	response, body := doJSON(t, client, http.MethodGet, baseURL+"/omc/api/v1/management/cpa-credential", "")
	if response.StatusCode != http.StatusOK {
		t.Fatalf("cpa credential status = %d body %s", response.StatusCode, body)
	}
	if cache := response.Header.Get("Cache-Control"); cache != "no-store" {
		t.Fatalf("cpa credential cache-control = %q, want no-store", cache)
	}
	var payload map[string]string
	if err := json.Unmarshal(body, &payload); err != nil {
		t.Fatalf("cpa credential body: %v (%s)", err, body)
	}
	if payload["management_key"] != "cpa-secret-key" {
		t.Fatalf("cpa credential = %#v, want the stored gateway key", payload)
	}

	events, err := repo.ListAuditEvents(context.Background(), 100)
	if err != nil {
		t.Fatalf("list audit events: %v", err)
	}
	audited := false
	for _, event := range events {
		if event.Action != "cpa_credential.reveal" {
			continue
		}
		audited = true
		if event.TargetType != "cpa_instance" || event.TargetID != "default" || event.Result != "success" {
			t.Fatalf("cpa credential audit = %#v, want the default instance as a successful reveal", event)
		}
	}
	if !audited {
		t.Fatalf("cpa credential reveal recorded no audit event")
	}

	// The console session is the only caller this read is for.
	anonymous := &http.Client{}
	refused, refusedBody := doJSON(t, anonymous, http.MethodGet, baseURL+"/omc/api/v1/management/cpa-credential", "")
	if refused.StatusCode != http.StatusUnauthorized {
		t.Fatalf("unauthenticated cpa credential status = %d body %s", refused.StatusCode, refusedBody)
	}
}
