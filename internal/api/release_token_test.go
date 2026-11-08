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

	"gopkg.in/yaml.v3"
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

func TestReleaseTokenFollowsSavedConfigurationWithoutWaitingForTTL(t *testing.T) {
	fixture := &configFixtureCPA{yamlData: configFixtureYAML}
	serve := func(writer http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodGet || !strings.HasSuffix(request.URL.Path, "/config") {
			fixture.serve(writer, request)
			return
		}
		fixture.mu.Lock()
		document := fixture.yamlData
		fixture.mu.Unlock()
		var view map[string]any
		if err := yaml.Unmarshal([]byte(document), &view); err != nil {
			t.Error(err)
			writer.WriteHeader(http.StatusInternalServerError)
			return
		}
		_ = json.NewEncoder(writer).Encode(view)
	}
	var handler *Handler
	client, baseURL, _ := startDashboardTestServerStoring(t, configFixtureYAML, serve, func(h *Handler) { handler = h })
	ctx := context.Background()
	if got := handler.ReleaseToken(ctx); got != "" {
		t.Fatal("initial configuration must have no token")
	}
	for _, token := range []string{"ghp_saved", "ghp_rotated", ""} {
		_, payload := getJSON(t, client, baseURL+"/omc/api/v1/management/config/source")
		var source struct {
			Revision string `json:"revision"`
		}
		if err := json.Unmarshal(payload, &source); err != nil {
			t.Fatal(err)
		}
		document := strings.ReplaceAll(configFixtureYAML, "config-version: 8\n", "")
		if token != "" {
			document = strings.Replace(document, "server:\n", "server:\n    github-token: "+token+"\n", 1)
		}
		body, _ := json.Marshal(map[string]string{"revision": source.Revision, "yaml": document})
		response, payload := doJSON(t, client, http.MethodPut, baseURL+"/omc/api/v1/management/config/source", string(body))
		if response.StatusCode != http.StatusOK {
			t.Fatalf("save configuration: status = %d, body = %s", response.StatusCode, payload)
		}
		if got := handler.ReleaseToken(ctx); got != token {
			t.Fatal("a successful configuration save must immediately replace or clear the cached token")
		}
	}
}
