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
		fmt.Fprint(w, `{"files":[{"name":"codex.json","provider":"codex","siwc_bind_supported":true,"use_siwc":true,"siwc_bound":true,"siwc_expires_at":"2026-10-21T00:00:00Z","metadata":{"siwc":{"access_token":"SYNTHETIC-TOKEN"}}}]}`)
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
	if !strings.Contains(string(body), `"siwc_bind_supported":true`) || !strings.Contains(string(body), `"siwc_bound":true`) || !strings.Contains(string(body), `"use_siwc":true`) || !strings.Contains(string(body), `"siwc_expires_at":"2026-10-21T00:00:00Z"`) || strings.Contains(string(body), "SYNTHETIC-TOKEN") {
		t.Fatalf("credential projection: %s", body)
	}
}
