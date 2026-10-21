package operations

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/capability"
	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/management"
	"github.com/oh-my-cpa/oh-my-cpa/internal/crypto"
)

func TestAgentCredentialReadProjectsSIWCSummariesOnly(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v8/management/config/config-version" {
			fmt.Fprint(w, "8")
			return
		}
		fmt.Fprint(w, `{"files":[{"name":"codex.json","provider":"codex","siwc_bind_supported":true,"use_siwc":true,"siwc_status":"invalid","siwc_bound":true,"siwc_expires_at":"2026-10-21T00:00:00Z","metadata":{"siwc":{"access_token":"SYNTHETIC-TOKEN"}}}]}`)
	}))
	defer server.Close()
	client, err := management.NewClient(server.URL, "synthetic-management", time.Second, false)
	if err != nil {
		t.Fatal(err)
	}
	cipher, err := crypto.New("01234567890123456789012345678901")
	if err != nil {
		t.Fatal(err)
	}
	service := &Service{Cipher: cipher, Client: func(context.Context) (*management.Client, error) { return client, nil }}
	registry := capability.NewRegistry()
	if err := service.registerOAuth(registry); err != nil {
		t.Fatal(err)
	}
	definition, err := registry.Lookup("oauth_credentials_list", capability.Principal{Adapter: "agent", IsAdmin: true})
	if err != nil {
		t.Fatal("credential read missing")
	}
	value, err := definition.Execute(context.Background(), json.RawMessage(`{}`), "", "")
	if err != nil {
		t.Fatal(err)
	}
	body, _ := json.Marshal(value)
	if !strings.Contains(string(body), `"siwc_status":"invalid"`) || !strings.Contains(string(body), `"siwc_bind_supported":true`) || !strings.Contains(string(body), `"siwc_bound":true`) || !strings.Contains(string(body), `"use_siwc":true`) || !strings.Contains(string(body), `"siwc_expires_at":"2026-10-21T00:00:00Z"`) || strings.Contains(string(body), "SYNTHETIC-TOKEN") {
		t.Fatalf("credential projection: %s", body)
	}
}

func TestAgentSIWCUseSwitchPreviewRejectsOtherFamilies(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v8/management/config/config-version" {
			fmt.Fprint(w, "8")
			return
		}
		fmt.Fprint(w, `{"files":[{"name":"codex.json","auth_index":"cx","provider":"codex","use_siwc":true,"siwc_bound":true,"siwc_status":"valid"},{"name":"vertex.json","auth_index":"vx","provider":"vertex"},{"name":"unbound.json","auth_index":"empty","provider":"codex","siwc_bound":false}]}`)
	}))
	defer server.Close()
	client, err := management.NewClient(server.URL, "synthetic-management", time.Second, false)
	if err != nil {
		t.Fatal(err)
	}
	cipher, err := crypto.New("01234567890123456789012345678901")
	if err != nil {
		t.Fatal(err)
	}
	service := &Service{Cipher: cipher, Client: func(context.Context) (*management.Client, error) { return client, nil }, NormalizeCredentialFields: func(fields map[string]any) (map[string]any, error) { return fields, nil }}
	registry := capability.NewRegistry()
	if err := service.registerOAuth(registry); err != nil {
		t.Fatal(err)
	}
	definition, err := registry.Lookup("oauth_set_credential_fields", capability.Principal{Adapter: "mcp", IsAdmin: true})
	if err != nil || definition.Prepare == nil || definition.Risk != "high" {
		t.Fatalf("confirmed edit missing: %+v %v", definition, err)
	}
	preview, err := definition.Prepare(context.Background(), json.RawMessage(`{"name":"codex.json","auth_index":"cx","fields":{"use_siwc":false}}`))
	if err != nil || preview.Revision == "" {
		t.Fatalf("Codex switch preview: %+v %v", preview, err)
	}
	if _, err = definition.Prepare(context.Background(), json.RawMessage(`{"name":"vertex.json","auth_index":"vx","fields":{"use_siwc":false}}`)); err == nil {
		t.Fatal("non-Codex toggle reached confirmation")
	}
	if _, err = definition.Prepare(context.Background(), json.RawMessage(`{"name":"unbound.json","auth_index":"empty","fields":{"use_siwc":true}}`)); err == nil {
		t.Fatal("unbound activation reached confirmation")
	}
	if _, err = definition.Prepare(context.Background(), json.RawMessage(`{"name":"unbound.json","auth_index":"empty","fields":{"use_siwc":false}}`)); err != nil {
		t.Fatalf("unbound deactivation preview: %v", err)
	}

}

func TestSIWCPolicyTargetRequiresBindingForActivation(t *testing.T) {
	file := management.AuthFile{Provider: "codex"}
	if management.CredentialPolicyFieldsApplicable(file, map[string]any{"use_siwc": true}) {
		t.Fatal("unbound activation is applicable")
	}
	if !management.CredentialPolicyFieldsApplicable(file, map[string]any{"use_siwc": false}) {
		t.Fatal("missing material prevents deactivation")
	}
}
