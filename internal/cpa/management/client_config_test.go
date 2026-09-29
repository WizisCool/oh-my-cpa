package management

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"
)

// configGateway records the configuration requests a client sends and serves a
// stored file of the given layout.
type configGateway struct {
	mu       sync.Mutex
	stored   string
	requests []string
	bodies   map[string]string
	answer   func(method, path string) (int, string)
}

func (g *configGateway) handler() http.Handler {
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		body, _ := io.ReadAll(request.Body)
		g.mu.Lock()
		defer g.mu.Unlock()
		key := request.Method + " " + request.URL.EscapedPath()
		g.requests = append(g.requests, key)
		if g.bodies == nil {
			g.bodies = map[string]string{}
		}
		g.bodies[key] = string(body)
		if g.answer != nil {
			if status, answer := g.answer(request.Method, request.URL.Path); status != 0 {
				writer.WriteHeader(status)
				_, _ = writer.Write([]byte(answer))
				return
			}
		}
		if request.Method == http.MethodGet && request.URL.Path == "/v0/management/config.yaml" {
			_, _ = writer.Write([]byte(g.stored))
			return
		}
		_, _ = writer.Write([]byte(`{"status":"ok","config-version":8}`))
	})
}

func (g *configGateway) sent() []string {
	g.mu.Lock()
	defer g.mu.Unlock()
	return append([]string(nil), g.requests...)
}

type recordingBackup struct {
	documents []string
	err       error
}

func (b *recordingBackup) KeepLegacyConfig(_ context.Context, _ string, storedYAML string) error {
	b.documents = append(b.documents, storedYAML)
	return b.err
}

func newConfigClient(t *testing.T, gateway *configGateway) *Client {
	t.Helper()
	server := newV8Server(gateway.handler())
	t.Cleanup(server.Close)
	client, err := NewClient(server.URL, "management-secret", time.Second, false)
	if err != nil {
		t.Fatal(err)
	}
	return client
}

func TestApplyConfigChangesSendsOnlyTheChangedSettings(t *testing.T) {
	gateway := &configGateway{stored: "config-version: 8\n"}
	client := newConfigClient(t, gateway)
	err := client.ApplyConfigChanges(context.Background(), []ConfigChange{
		{Path: []string{"routing", "retry", "request-retry"}, Value: 0},
		{Path: []string{"observability", "logs", "debug"}, Value: true},
		{Path: []string{"access", "api-keys"}, Value: []string{"k1"}},
		{Path: []string{"plugins", "configs", "demo plugin"}, Value: map[string]any{"level": "info"}},
		{Path: []string{"requests", "streaming", "keepalive-seconds"}, Remove: true},
	})
	if err != nil {
		t.Fatal(err)
	}
	want := []string{
		"GET /v0/management/config.yaml",
		"PATCH /v8/management/config",
		"PUT /v8/management/config/plugins/configs/demo%20plugin",
		"DELETE /v8/management/config/requests/streaming/keepalive-seconds",
	}
	if got := gateway.sent(); strings.Join(got, "|") != strings.Join(want, "|") {
		t.Fatalf("requests = %v, want %v", got, want)
	}
	// Scalars and lists are merged into one PATCH, so CPA validates them together;
	// a zero value is sent, not dropped.
	var merged map[string]any
	if err := json.Unmarshal([]byte(gateway.bodies["PATCH /v8/management/config"]), &merged); err != nil {
		t.Fatal(err)
	}
	encoded, _ := json.Marshal(merged)
	if string(encoded) != `{"access":{"api-keys":["k1"]},"observability":{"logs":{"debug":true}},"routing":{"retry":{"request-retry":0}}}` {
		t.Fatalf("PATCH body = %s", encoded)
	}
	// A mapping is replaced on its own path: merging it would keep removed keys.
	if body := gateway.bodies["PUT /v8/management/config/plugins/configs/demo%20plugin"]; body != `{"level":"info"}` {
		t.Fatalf("PUT body = %s", body)
	}
}

func TestApplyConfigChangesToleratesRemovingAnAbsentKey(t *testing.T) {
	gateway := &configGateway{stored: "config-version: 8\n", answer: func(method, _ string) (int, string) {
		if method == http.MethodDelete {
			return http.StatusNotFound, `{"error":"not_found"}`
		}
		return 0, ""
	}}
	client := newConfigClient(t, gateway)
	if err := client.ApplyConfigChanges(context.Background(), []ConfigChange{{Path: []string{"requests", "proxy-url"}, Remove: true}}); err != nil {
		t.Fatalf("removing an absent key: %v", err)
	}
}

func TestApplyConfigChangesRefusesAmbiguousPaths(t *testing.T) {
	client := newConfigClient(t, &configGateway{stored: "config-version: 8\n"})
	for _, changes := range [][]ConfigChange{
		{{Path: nil, Value: 1}},
		{{Path: []string{"routing", ""}, Value: 1}},
		{{Path: []string{"routing/retry"}, Value: 1}},
		{{Path: []string{"routing"}, Value: 1}, {Path: []string{"routing", "strategy"}, Value: "x"}},
		{{Path: []string{"a", "b"}, Value: 1}, {Path: []string{"a", "b"}, Remove: true}},
	} {
		if err := client.ApplyConfigChanges(context.Background(), changes); !errors.Is(err, ErrInvalidConfigChange) {
			t.Errorf("%v: err = %v, want ErrInvalidConfigChange", changes, err)
		}
	}
}

func TestFirstV8WriteKeepsTheLegacyFileFirst(t *testing.T) {
	legacy := "port: 8317\ndebug: false\n"
	gateway := &configGateway{stored: legacy}
	client := newConfigClient(t, gateway)
	backup := &recordingBackup{}
	client.WithConfigBackup(backup)
	if err := client.UpdateConfigScalar(context.Background(), "debug", true); err != nil {
		t.Fatal(err)
	}
	if len(backup.documents) != 1 || backup.documents[0] != legacy {
		t.Fatalf("backup = %q", backup.documents)
	}
	if got := gateway.sent(); len(got) != 2 || got[0] != "GET /v0/management/config.yaml" || got[1] != "PATCH /v8/management/config" {
		t.Fatalf("requests = %v", got)
	}
}

func TestLegacyFileIsNotConvertedWithoutABackup(t *testing.T) {
	for name, backup := range map[string]ConfigBackup{
		"no store":      nil,
		"store failure": &recordingBackup{err: errors.New("disk full")},
	} {
		t.Run(name, func(t *testing.T) {
			gateway := &configGateway{stored: "port: 8317\n"}
			client := newConfigClient(t, gateway).WithConfigBackup(backup)
			err := client.UpdateConfigYAML(context.Background(), "config-version: 8\n")
			if !errors.Is(err, ErrConfigBackupUnavailable) {
				t.Fatalf("err = %v, want ErrConfigBackupUnavailable", err)
			}
			for _, request := range gateway.sent() {
				if !strings.HasPrefix(request, "GET ") {
					t.Fatalf("a write was sent without a backup: %v", gateway.sent())
				}
			}
		})
	}
}

func TestConfigScalarsApplyCPARuntimeDefaults(t *testing.T) {
	gateway := &configGateway{answer: func(method, path string) (int, string) {
		if method == http.MethodGet && path == "/v8/management/config" {
			return http.StatusOK, `{"routing":{"retry":{"request-retry":2}},"access":{"api-keys":["a","b"]}}`
		}
		return 0, ""
	}}
	client := newConfigClient(t, gateway)
	scalars, err := client.ConfigScalars(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	// The v8 view omits what the file omits; the two non-zero runtime defaults
	// are what CPA runs with then.
	if scalars.RequestRetry != 2 || !scalars.WSAuth || scalars.ErrorLogsMaxFiles != 10 || scalars.RoutingStrategy != "round-robin" {
		t.Fatalf("scalars = %#v", scalars)
	}
	keys, err := client.ClientAPIKeys(context.Background())
	if err != nil || strings.Join(keys, ",") != "a,b" {
		t.Fatalf("client keys = %v, %v", keys, err)
	}
}

func TestIsConfigRejectedReadsCPAsExplanation(t *testing.T) {
	rejected := &HTTPError{StatusCode: http.StatusBadRequest, Body: `{"error":"invalid_config","message":"legacy field debug is not accepted by v8; use observability.logs.debug"}`}
	if reason, ok := IsConfigRejected(rejected); !ok || !strings.Contains(reason, "observability.logs.debug") {
		t.Fatalf("reason = %q, %v", reason, ok)
	}
	// A value of the wrong type is refused with 422 and the same body.
	mistyped := &HTTPError{StatusCode: http.StatusUnprocessableEntity, Body: `{"error":"invalid_config","message":"parse config payload: cannot unmarshal !!str into []config.PayloadRule"}`}
	if reason, ok := IsConfigRejected(mistyped); !ok || !strings.Contains(reason, "PayloadRule") {
		t.Fatalf("reason = %q, %v", reason, ok)
	}
	for _, err := range []error{
		&HTTPError{StatusCode: http.StatusBadRequest, Body: `{"error":"other"}`},
		&HTTPError{StatusCode: http.StatusInternalServerError, Body: `{"error":"invalid_config"}`},
		errors.New("connection refused"),
	} {
		if _, ok := IsConfigRejected(err); ok {
			t.Errorf("%v is not a configuration rejection", err)
		}
	}
}
