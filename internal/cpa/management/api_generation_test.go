package management

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// generationGateway models the route trees of the two CPA generations.
type generationGateway struct {
	mu       sync.Mutex
	hasV8    bool
	probeErr int // status the probe answers when non-zero
	paths    []string
}

func (g *generationGateway) serve(writer http.ResponseWriter, request *http.Request) {
	g.mu.Lock()
	g.paths = append(g.paths, request.Method+" "+request.URL.Path)
	hasV8, probeErr := g.hasV8, g.probeErr
	g.mu.Unlock()
	writer.Header().Set("Content-Type", "application/json")
	if strings.HasPrefix(request.URL.Path, "/v8/") && !hasV8 {
		http.NotFound(writer, request)
		return
	}
	switch request.URL.Path {
	case "/v8/management/config/config-version":
		if probeErr != 0 {
			writer.WriteHeader(probeErr)
			return
		}
		_, _ = writer.Write([]byte("8"))
	case "/v8/management/observability/usage/queue", "/v0/management/usage-queue":
		_, _ = writer.Write([]byte(`[{"model":"gpt"}]`))
	case "/v0/management/logs":
		_, _ = writer.Write([]byte(`{"lines":["v0 line"]}`))
	case "/v0/management/request-log-by-id/req-1":
		_, _ = writer.Write([]byte("raw log"))
	default:
		http.NotFound(writer, request)
	}
}

func (g *generationGateway) seen() []string {
	g.mu.Lock()
	defer g.mu.Unlock()
	return append([]string(nil), g.paths...)
}

func newGenerationClient(t *testing.T, gateway *generationGateway) *Client {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(gateway.serve))
	t.Cleanup(server.Close)
	client, err := NewClient(server.URL, "management-secret", time.Second, false)
	if err != nil {
		t.Fatal(err)
	}
	return client
}

func TestV8GatewayServesOperationsOnGroupedRoutes(t *testing.T) {
	gateway := &generationGateway{hasV8: true}
	client := newGenerationClient(t, gateway)

	if hasV8, err := client.SupportsManagementV8(context.Background()); err != nil || !hasV8 {
		t.Fatalf("SupportsManagementV8 = %v, %v", hasV8, err)
	}
	records, _, err := client.UsageQueue(context.Background(), 5)
	if err != nil || len(records) != 1 {
		t.Fatalf("UsageQueue = %v, %v", records, err)
	}
	if _, _, err := client.UsageQueue(context.Background(), 5); err != nil {
		t.Fatal(err)
	}
	seen := gateway.seen()
	want := []string{
		"GET /v8/management/config/config-version",
		"GET /v8/management/observability/usage/queue",
		"GET /v8/management/observability/usage/queue",
	}
	if strings.Join(seen, "|") != strings.Join(want, "|") {
		t.Fatalf("requests = %v, want %v (one probe, then v8 routes only)", seen, want)
	}
}

func TestV7GatewayKeepsV0Routes(t *testing.T) {
	gateway := &generationGateway{}
	client := newGenerationClient(t, gateway)

	if _, _, err := client.UsageQueue(context.Background(), 1); err != nil {
		t.Fatal(err)
	}
	if _, _, err := client.UsageQueue(context.Background(), 1); err != nil {
		t.Fatal(err)
	}
	for _, path := range gateway.seen()[1:] {
		if strings.HasPrefix(path, "GET /v8/") {
			t.Fatalf("a v7 gateway must be probed once and then served on v0, got %v", gateway.seen())
		}
	}
	if client.PreferredAPIGeneration(context.Background()) != APIGenerationV0 {
		t.Fatal("a v7 gateway must prefer v0")
	}
}

// An operation whose v8 route is missing falls back to v0 and forgets the probe
// answer, so a gateway rolled back behind the same URL is re-probed.
func TestMissingV8RouteFallsBackToV0(t *testing.T) {
	gateway := &generationGateway{hasV8: true}
	client := newGenerationClient(t, gateway)

	page, _, err := client.Logs(context.Background(), LogsQuery{})
	if err != nil || len(page.Lines) != 1 || page.Lines[0] != "v0 line" {
		t.Fatalf("Logs = %+v, %v", page, err)
	}
	data, _, err := client.DownloadRequestLog(context.Background(), "req-1")
	if err != nil || string(data) != "raw log" {
		t.Fatalf("DownloadRequestLog = %q, %v", data, err)
	}
	seen := strings.Join(gateway.seen(), "|")
	for _, want := range []string{"GET /v8/management/observability/logs", "GET /v0/management/logs", "GET /v8/management/observability/logs/requests/req-1", "GET /v0/management/request-log-by-id/req-1"} {
		if !strings.Contains(seen, want) {
			t.Fatalf("expected %s in %s", want, seen)
		}
	}
	if strings.Count(seen, "config-version") != 2 {
		t.Fatalf("a missing v8 route must invalidate the probe answer: %s", seen)
	}
}

func TestProbeRejectsCatchAllAndDoesNotCacheFailures(t *testing.T) {
	catchAll := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		_, _ = writer.Write([]byte(`{}`))
	}))
	defer catchAll.Close()
	client, err := NewClient(catchAll.URL, "management-secret", time.Second, false)
	if err != nil {
		t.Fatal(err)
	}
	if hasV8, err := client.SupportsManagementV8(context.Background()); err != nil || hasV8 {
		t.Fatalf("a 2xx that is not config-version 8 must not count as v8: %v %v", hasV8, err)
	}

	gateway := &generationGateway{hasV8: true, probeErr: http.StatusUnauthorized}
	flaky := newGenerationClient(t, gateway)
	if _, err := flaky.SupportsManagementV8(context.Background()); err == nil {
		t.Fatal("an unauthorized probe is not an answer")
	}
	gateway.mu.Lock()
	gateway.probeErr = 0
	gateway.mu.Unlock()
	if hasV8, err := flaky.SupportsManagementV8(context.Background()); err != nil || !hasV8 {
		t.Fatalf("a failed probe must not be cached: %v %v", hasV8, err)
	}
}

func TestOperationRoutesCoverBothGenerations(t *testing.T) {
	for operation, route := range OPERATION_ROUTES {
		if !strings.HasPrefix(route.V0, "/") || !strings.HasPrefix(route.V8, "/") || route.V0 == route.V8 {
			t.Errorf("%s has an incomplete route pair %+v", operation, route)
		}
	}
}
