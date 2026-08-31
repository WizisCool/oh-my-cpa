package management

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestClientUsesManagementAuthorizationAndDecodesResponses(t *testing.T) {
	const key = "management-secret"
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/v0/management/codex-api-key" {
			t.Fatalf("request path = %q", request.URL.Path)
		}
		if got := request.Header.Get("Authorization"); got != "Bearer "+key {
			t.Fatalf("authorization = %q", got)
		}
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write([]byte(`{"codex-api-key":[{"api-key":"secret","auth-index":"a1","base-url":"https://api.example.test"}]}`))
	}))
	defer server.Close()

	client, err := NewClient(server.URL, key, time.Second, false)
	if err != nil {
		t.Fatal(err)
	}
	response, err := client.CodexAPIKeys(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(response.Entries) != 1 || response.Entries[0].AuthIndex != "a1" {
		t.Fatalf("decoded response = %#v", response)
	}
	if !client.ManagementKeyPresent() {
		t.Fatal("management key should be present")
	}
}

func TestClientDoesNotLeakKeyInHTTPError(t *testing.T) {
	const key = "management-secret"
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.WriteHeader(http.StatusUnauthorized)
		_, _ = writer.Write([]byte(`{"error":"management-secret was rejected"}`))
	}))
	defer server.Close()
	client, err := NewClient(server.URL, key, time.Second, false)
	if err != nil {
		t.Fatal(err)
	}
	_, err = client.AuthFiles(context.Background())
	if err == nil {
		t.Fatal("expected authorization error")
	}
	if strings.Contains(err.Error(), key) || !strings.Contains(err.Error(), "[redacted]") {
		t.Fatalf("error leaked management key or failed to redact echo: %v", err)
	}
}

func TestNewClientValidatesURLAndKey(t *testing.T) {
	for _, test := range []struct {
		name string
		base string
		key  string
	}{
		{name: "missing url", base: "", key: "secret"},
		{name: "bad scheme", base: "ftp://example.test", key: "secret"},
		{name: "userinfo", base: "http://user:password@example.test", key: "secret"},
		{name: "missing key", base: "http://example.test", key: ""},
	} {
		t.Run(test.name, func(t *testing.T) {
			if _, err := NewClient(test.base, test.key, time.Second, false); err == nil {
				t.Fatal("expected validation error")
			}
		})
	}
}
