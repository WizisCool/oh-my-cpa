package management

import (
	"context"
	"net"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

func TestClientsReuseConnectionsWithoutSharingCredentials(t *testing.T) {
	var connections atomic.Int64
	var request atomic.Int64
	server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		expected := "Bearer first-key"
		if request.Add(1) == 2 {
			expected = "Bearer second-key"
		}
		if got := r.Header.Get("Authorization"); got != expected {
			t.Errorf("authorization leaked between clients: %q", got)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	server.Config.ConnState = func(_ net.Conn, state http.ConnState) {
		if state == http.StateNew {
			connections.Add(1)
		}
	}
	server.Start()
	defer server.Close()
	for _, key := range []string{"first-key", "second-key"} {
		client, err := NewClient(server.URL, key, time.Second, false)
		if err != nil {
			t.Fatal(err)
		}
		var response map[string]bool
		if err := client.DoJSON(context.Background(), http.MethodGet, "/config", &response); err != nil {
			t.Fatal(err)
		}
	}
	if got := connections.Load(); got != 1 {
		t.Fatalf("new clients opened %d TCP connections; want one reused connection", got)
	}
}

func TestClientTransportTLSPoliciesRemainIsolated(t *testing.T) {
	secure, _ := NewClient("https://example.test", "key", time.Second, false)
	insecure, _ := NewClient("https://example.test", "key", 2*time.Second, true)
	if secure.httpClient.Transport == insecure.httpClient.Transport {
		t.Fatal("TLS policies share transport")
	}
	if secure.httpClient.Transport.(*http.Transport).TLSClientConfig.InsecureSkipVerify {
		t.Fatal("secure client skips verification")
	}
	if !insecure.httpClient.Transport.(*http.Transport).TLSClientConfig.InsecureSkipVerify {
		t.Fatal("operator opt-in lost")
	}
	if secure.httpClient.Timeout != time.Second || insecure.httpClient.Timeout != 2*time.Second {
		t.Fatal("timeouts shared")
	}
}
