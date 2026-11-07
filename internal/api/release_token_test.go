package api

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// releaseTokenGateway serves the v8 configuration view and counts the reads of it.
//
// The counter is what makes the cache observable: one sweep's requests must share one
// configuration read, and a token changed in the console must reach the next window.
type releaseTokenGateway struct {
	mutex sync.Mutex
	token string
	fail  bool
	reads atomic.Int64
}

func (g *releaseTokenGateway) serve(writer http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodGet || !strings.HasSuffix(request.URL.Path, "/config") {
		writer.WriteHeader(http.StatusNotFound)
		return
	}
	g.reads.Add(1)
	g.mutex.Lock()
	token, fail := g.token, g.fail
	g.mutex.Unlock()
	if fail {
		writer.WriteHeader(http.StatusInternalServerError)
		return
	}
	server := map[string]any{"host": "127.0.0.1", "port": 8317}
	if token != "" {
		server["github-token"] = token
	}
	_ = json.NewEncoder(writer).Encode(map[string]any{"server": server})
}

func (g *releaseTokenGateway) set(token string, fail bool) {
	g.mutex.Lock()
	defer g.mutex.Unlock()
	g.token, g.fail = token, fail
}

// expire forces the next call to read the gateway again, which is what the passage of the
// cache window would do.
func expireReleaseToken(handler *Handler) {
	handler.releaseToken.mutex.Lock()
	handler.releaseToken.attemptedAt = time.Time{}
	handler.releaseToken.mutex.Unlock()
}

func TestReleaseTokenComesFromTheGatewaysConfiguration(t *testing.T) {
	gateway := &releaseTokenGateway{token: "ghp_gateway_token"}
	var handler *Handler
	startDashboardTestServer(t, gateway.serve, func(h *Handler) { handler = h })
	ctx := context.Background()

	if got := handler.ReleaseToken(ctx); got != "ghp_gateway_token" {
		t.Fatalf("token = %q, want the gateway's configured token", got)
	}
	// The answer is held for the cache window, so one sweep's reads share one read of CPA's
	// configuration rather than asking per request.
	if got := handler.ReleaseToken(ctx); got != "ghp_gateway_token" || gateway.reads.Load() != 1 {
		t.Fatalf("token = %q after %d reads, want the cached answer after one read", got, gateway.reads.Load())
	}

	// A token changed on the configuration panel reaches the next window.
	gateway.set("ghp_rotated", false)
	expireReleaseToken(handler)
	if got := handler.ReleaseToken(ctx); got != "ghp_rotated" {
		t.Fatalf("token after rotation = %q, want ghp_rotated", got)
	}

	// A gateway that cannot be read keeps the previous answer, because dropping it would
	// silently downgrade the release reads to the unauthenticated budget.
	gateway.set("", true)
	expireReleaseToken(handler)
	if got := handler.ReleaseToken(ctx); got != "ghp_rotated" {
		t.Fatalf("token after a failed read = %q, want the previous token", got)
	}
}

func TestReleaseTokenIsEmptyWithoutOneConfigured(t *testing.T) {
	gateway := &releaseTokenGateway{}
	var handler *Handler
	startDashboardTestServer(t, gateway.serve, func(h *Handler) { handler = h })
	if got := handler.ReleaseToken(context.Background()); got != "" {
		t.Fatalf("token = %q, want an empty answer", got)
	}
}
