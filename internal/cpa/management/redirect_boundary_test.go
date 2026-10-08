package management

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

// Unique fixture URLs isolate the process-global version gate cache.
func TestManagementRedirectOriginBoundary(t *testing.T) {
	for _, tlsSource := range []bool{false, true} {
		label := "different-port"
		if tlsSource {
			label = "tls-to-http"
		}
		t.Run(label, func(t *testing.T) {
			const syntheticKey = "fixture-management-synthetic-key"
			var receivedKey atomic.Bool
			var contacted atomic.Bool
			target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				contacted.Store(true)
				receivedKey.Store(r.Header.Get("Authorization") == "Bearer "+syntheticKey)
				_, _ = w.Write([]byte("8"))
			}))
			defer target.Close()
			handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != "/v8/management/config/config-version" {
					t.Errorf("unexpected path %s", r.URL.Path)
				}
				http.Redirect(w, r, target.URL+"/probe-target", http.StatusFound)
			})
			var source *httptest.Server
			if tlsSource {
				source = httptest.NewTLSServer(handler)
			} else {
				source = httptest.NewServer(handler)
			}
			defer source.Close()
			client, err := NewClient(source.URL, syntheticKey, 2*time.Second, tlsSource)
			if err != nil {
				t.Fatal(err)
			}
			defer client.forgetManagementV8()
			supported, probeErr := client.SupportsManagementV8(context.Background())
			t.Logf("redirect target contacted=%v management Authorization forwarded=%v gate_supported=%v probe_error=%v", contacted.Load(), receivedKey.Load(), supported, probeErr)
			if receivedKey.Load() {
				t.Error("fixed-origin invariant violated: management key forwarded outside configured origin")
			}
		})
	}
}
