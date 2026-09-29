package management

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// generationGateway models a gateway with or without the /v8/management tree.
type generationGateway struct {
	mu       sync.Mutex
	hasV8    bool
	disabled bool // no management secret: every management path answers 404
	probeErr int  // status the probe answers when non-zero
	paths    []string
}

func (g *generationGateway) serve(writer http.ResponseWriter, request *http.Request) {
	g.mu.Lock()
	g.paths = append(g.paths, request.Method+" "+request.URL.Path)
	hasV8, disabled, probeErr := g.hasV8, g.disabled, g.probeErr
	g.mu.Unlock()
	writer.Header().Set("Content-Type", "application/json")
	if disabled || strings.HasPrefix(request.URL.Path, "/v8/") && !hasV8 {
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
	case "/v0/management/debug":
		_, _ = writer.Write([]byte(`{"debug":false}`))
	case "/v8/management/observability/usage/queue":
		_, _ = writer.Write([]byte(`[{"model":"gpt"}]`))
	case "/v0/management/usage-queue", "/v0/management/api-keys":
		_, _ = writer.Write([]byte(`{"api-keys":["k"]}`))
	default:
		http.NotFound(writer, request)
	}
}

func (g *generationGateway) seen() []string {
	g.mu.Lock()
	defer g.mu.Unlock()
	return append([]string(nil), g.paths...)
}

func (g *generationGateway) set(hasV8 bool) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.hasV8 = hasV8
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

func TestV8GatewayIsProbedOnceAndServedOnV8Routes(t *testing.T) {
	gateway := &generationGateway{hasV8: true}
	client := newGenerationClient(t, gateway)

	if status := client.ManagementAPI(context.Background()); status != ManagementAPIV8 {
		t.Fatalf("ManagementAPI = %s", status)
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

// A gateway older than v8 is refused before any operation reaches it, v0 reads
// included, so the console reports one fact instead of a scatter of 404s.
func TestPreV8GatewayIsRefusedBeforeAnyRequest(t *testing.T) {
	gateway := &generationGateway{}
	client := newGenerationClient(t, gateway)

	if _, _, err := client.UsageQueue(context.Background(), 1); !errors.Is(err, ErrManagementV8Required) {
		t.Fatalf("UsageQueue err = %v, want ErrManagementV8Required", err)
	}
	if _, err := client.ClientAPIKeys(context.Background()); !errors.Is(err, ErrManagementV8Required) {
		t.Fatalf("ClientAPIKeys err = %v, want ErrManagementV8Required", err)
	}
	if status := client.ManagementAPI(context.Background()); status != ManagementAPIUnsupported {
		t.Fatalf("ManagementAPI = %s", status)
	}
	want := "GET /v8/management/config/config-version|GET /v0/management/debug"
	if seen := strings.Join(gateway.seen(), "|"); seen != want {
		t.Fatalf("only the probes may reach a pre-v8 gateway, got %v", seen)
	}
}

// A gateway with no management secret answers 404 on both trees. That is not a
// pre-v8 gateway, so it must not be reported as one needing an upgrade.
func TestGatewayWithoutManagementIsNotReportedAsPreV8(t *testing.T) {
	gateway := &generationGateway{hasV8: true, disabled: true}
	client := newGenerationClient(t, gateway)

	if status := client.ManagementAPI(context.Background()); status != ManagementAPIDisabled {
		t.Fatalf("ManagementAPI = %s, want disabled", status)
	}
	if _, _, err := client.UsageQueue(context.Background(), 1); !errors.Is(err, ErrManagementDisabled) {
		t.Fatalf("UsageQueue err = %v, want ErrManagementDisabled", err)
	}
	want := "GET /v8/management/config/config-version|GET /v0/management/debug"
	if seen := strings.Join(gateway.seen(), "|"); seen != want {
		t.Fatalf("only the probes may reach a gateway without management, got %v", seen)
	}
}

// While the probe gets no answer, gated requests go straight through instead of
// each paying another probe first; the health status keeps re-asking.
func TestUndecidedProbeIsNotRepeatedPerRequest(t *testing.T) {
	gateway := &generationGateway{hasV8: true, probeErr: http.StatusServiceUnavailable}
	client := newGenerationClient(t, gateway)

	for range 3 {
		if _, _, err := client.UsageQueue(context.Background(), 1); err != nil {
			t.Fatal(err)
		}
	}
	if count := strings.Count(strings.Join(gateway.seen(), "|"), "config-version"); count != 1 {
		t.Fatalf("gated requests re-probed an undecided gateway: %v", gateway.seen())
	}
	gateway.mu.Lock()
	gateway.probeErr = 0
	gateway.mu.Unlock()
	if status := client.ManagementAPI(context.Background()); status != ManagementAPIV8 {
		t.Fatalf("the health status must re-probe inside the undecided window, got %s", status)
	}
}

// A v8 route answering "missing" drops the cached answer, so a gateway rolled
// back behind the same URL is re-probed and then refused by the gate.
func TestMissingV8RouteForcesReprobe(t *testing.T) {
	gateway := &generationGateway{hasV8: true}
	client := newGenerationClient(t, gateway)

	if _, _, err := client.UsageQueue(context.Background(), 1); err != nil {
		t.Fatal(err)
	}
	gateway.set(false)
	if _, _, err := client.UsageQueue(context.Background(), 1); !IsMissingCapability(err) {
		t.Fatalf("the first call after a rollback reports the missing route, got %v", err)
	}
	if _, _, err := client.UsageQueue(context.Background(), 1); !errors.Is(err, ErrManagementV8Required) {
		t.Fatalf("the next call must be refused by a fresh probe, got %v", err)
	}
	if count := strings.Count(strings.Join(gateway.seen(), "|"), "config-version"); count != 2 {
		t.Fatalf("expected a re-probe after the missing route, saw %d probes: %v", count, gateway.seen())
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
	if status := flaky.ManagementAPI(context.Background()); status != ManagementAPIUnknown {
		t.Fatalf("an unauthorized probe is not an answer, got %s", status)
	}
	// An undecided probe lets the request through, so it fails with its own cause.
	var httpErr *HTTPError
	if _, _, err := flaky.UsageQueue(context.Background(), 1); errors.Is(err, ErrManagementV8Required) || errors.As(err, &httpErr) && httpErr.StatusCode == http.StatusUnauthorized {
		t.Fatalf("an undecided probe must not block the request: %v", err)
	}
	gateway.mu.Lock()
	gateway.probeErr = 0
	gateway.mu.Unlock()
	if hasV8, err := flaky.SupportsManagementV8(context.Background()); err != nil || !hasV8 {
		t.Fatalf("a failed probe must not be cached: %v %v", hasV8, err)
	}
}

// The v0 tree is addressed only through client_v0.go; every other request path
// names /v8/management.
func TestOnlyDeclaredReadsUseV0(t *testing.T) {
	gateway := &generationGateway{hasV8: true}
	client := newGenerationClient(t, gateway)
	_, _ = client.AuthFiles(context.Background())
	_, _, _ = client.Logs(context.Background(), LogsQuery{})
	_, _ = client.RequestErrorLogs(context.Background())
	_, _, _ = client.LatestVersion(context.Background())
	_, _ = client.PluginList(context.Background())
	_, _ = client.PluginStore(context.Background())
	_, _ = client.OAuthStatus(context.Background(), "state-1")
	_ = client.ResetQuota(context.Background(), "idx-1")
	for _, path := range gateway.seen() {
		if !strings.Contains(path, " /v8/management/") {
			t.Errorf("%s left the v8 tree", path)
		}
	}
}
