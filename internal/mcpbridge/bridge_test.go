package mcpbridge

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/oh-my-cpa/oh-my-cpa/internal/capability"
)

func TestMCPStdioHelper(t *testing.T) {
	if os.Getenv("OMCPA_MCP_TEST_CHILD") != "1" {
		return
	}
	if err := Run(context.Background(), os.Getenv("OMCPA_SERVER_URL"), os.Getenv("OMCPA_CPA_MANAGEMENT_KEY"), "v-test"); err != nil {
		os.Exit(2)
	}
	os.Exit(0)
}
func TestMCPStdioDiscoveryAndCall(t *testing.T) {
	registry := capability.NewRegistry()
	err := capability.Register(registry, capability.Metadata{Name: "fixture_read", Description: "Read fixture", Version: 1, Permission: "read", Risk: "low", Adapters: []string{"mcp"}}, nil, func(context.Context, struct{}, string, string) (struct{}, error) { return struct{}{}, nil })
	if err != nil {
		t.Fatal(err)
	}
	upstream := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Header.Get("Authorization") != "Bearer fixture-token" {
			t.Error("missing scoped bearer")
		}
		switch request.URL.Path {
		case "/omc/api/v1/capabilities":
			json.NewEncoder(writer).Encode(map[string]any{"capabilities": registry.List(capability.Principal{Adapter: "mcp", IsAdmin: true})})
		case "/omc/api/v1/capabilities/invoke":
			var input struct {
				Name      string          `json:"name"`
				Arguments json.RawMessage `json:"arguments"`
			}
			if json.NewDecoder(request.Body).Decode(&input) != nil || input.Name != "fixture_read" || string(input.Arguments) != "{}" {
				t.Error("invalid adapter call")
			}
			json.NewEncoder(writer).Encode(capability.Result{Status: "success", Data: json.RawMessage(`{"count":7}`)})
		default:
			t.Errorf("unexpected path %s", request.URL.Path)
			writer.WriteHeader(404)
		}
	}))
	defer upstream.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestMCPStdioHelper$")
	command.Env = append(os.Environ(), "OMCPA_MCP_TEST_CHILD=1", "OMCPA_SERVER_URL="+upstream.URL+"/omc", "OMCPA_CPA_MANAGEMENT_KEY=fixture-token")
	client := mcp.NewClient(&mcp.Implementation{Name: "test", Version: "1"}, nil)
	session, err := client.Connect(ctx, &mcp.CommandTransport{Command: command}, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer session.Close()
	tools, err := session.ListTools(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(tools.Tools) != 2 {
		t.Fatalf("catalog: %+v", tools.Tools)
	}
	result, err := session.CallTool(ctx, &mcp.CallToolParams{Name: "fixture_read", Arguments: map[string]any{}})
	if err != nil || result.IsError || len(result.Content) == 0 {
		t.Fatalf("call: %+v %v", result, err)
	}
}
func TestMCPTransportSecurity(t *testing.T) {
	for _, address := range []string{"http://example.org/omc", "https://user:pass@example.org/omc", "file:///etc/passwd", "https://example.org?token=secret"} {
		if _, err := New(address, "token"); err == nil {
			t.Errorf("accepted %s", address)
		}
	}
	destination := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { t.Error("followed redirect") }))
	defer destination.Close()
	redirect := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		http.Redirect(writer, request, destination.URL, 307)
	}))
	defer redirect.Close()
	bridge, err := New(redirect.URL, "token")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = bridge.Server(context.Background(), "v-test"); err == nil {
		t.Fatal("redirect accepted")
	}
}

type fixtureBackend struct {
	result     capability.Result
	err        error
	operations []capability.Operation
	reads      int
}

func (backend *fixtureBackend) Catalog(context.Context) ([]*capability.Definition, error) {
	registry := capability.NewRegistry()
	err := capability.Register(registry, capability.Metadata{Name: "fixture_write", Description: "Write fixture", Version: 1, Permission: "destructive", Risk: "high", Adapters: []string{"mcp"}}, func(context.Context, struct{}) (capability.Preview, error) { return capability.Preview{}, nil }, func(context.Context, struct{}, string, string) (struct{}, error) { return struct{}{}, nil })
	return registry.List(capability.Principal{Adapter: "mcp", IsAdmin: true}), err
}
func (backend *fixtureBackend) Invoke(context.Context, string, json.RawMessage) (capability.Result, error) {
	return backend.result, backend.err
}
func (backend *fixtureBackend) Operation(context.Context, string) (capability.Operation, error) {
	operation := backend.operations[min(backend.reads, len(backend.operations)-1)]
	backend.reads++
	return operation, nil
}

func connectFixture(t *testing.T, backend Backend) *mcp.ClientSession {
	t.Helper()
	server, err := NewServer(context.Background(), backend, Options{Version: "v-test", ConsoleURL: func(*mcp.CallToolRequest) string { return "https://omc.example/omc/" }})
	if err != nil {
		t.Fatal(err)
	}
	serverTransport, clientTransport := mcp.NewInMemoryTransports()
	if _, err = server.Connect(context.Background(), serverTransport, nil); err != nil {
		t.Fatal(err)
	}
	session, err := mcp.NewClient(&mcp.Implementation{Name: "test", Version: "1"}, nil).Connect(context.Background(), clientTransport, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { session.Close() })
	return session
}

func texts(result *mcp.CallToolResult) []string {
	values := []string{}
	for _, content := range result.Content {
		values = append(values, content.(*mcp.TextContent).Text)
	}
	return values
}

func TestPendingResultCarriesTheApprovalLinkAndRefusalsKeepTheirCode(t *testing.T) {
	operationID := "0123456789abcdef0123456789abcdef0123456789abcdef"
	backend := &fixtureBackend{result: capability.Result{Status: "pending", OperationID: operationID}}
	session := connectFixture(t, backend)
	result, err := session.CallTool(context.Background(), &mcp.CallToolParams{Name: "fixture_write"})
	if err != nil || result.IsError {
		t.Fatalf("prepare: %+v %v", result, err)
	}
	if got := texts(result); len(got) != 2 || got[1] != "Operator approval: https://omc.example/omc/agent?operation="+operationID {
		t.Fatalf("approval link: %v", got)
	}
	backend.result, backend.err = capability.Result{}, errors.New("capability_forbidden")
	result, err = session.CallTool(context.Background(), &mcp.CallToolParams{Name: "fixture_write"})
	if err != nil || !result.IsError || texts(result)[0] != "capability_forbidden" {
		t.Fatalf("refusal: %+v %v", result, err)
	}
	backend.result, backend.err = capability.Result{Status: "uncertain", Code: "operation_outcome_unknown"}, nil
	if result, err = session.CallTool(context.Background(), &mcp.CallToolParams{Name: "fixture_write"}); err != nil || !result.IsError {
		t.Fatalf("uncertain outcome reported as success: %+v %v", result, err)
	}
}

func TestOperationStatusWaitsForTheDecision(t *testing.T) {
	operationID := "0123456789abcdef0123456789abcdef0123456789abcdef"
	backend := &fixtureBackend{operations: []capability.Operation{{ID: operationID, Status: "pending"}, {ID: operationID, Status: "success"}}}
	previousInterval := statusPollInterval
	statusPollInterval = time.Millisecond
	defer func() { statusPollInterval = previousInterval }()
	session := connectFixture(t, backend)
	status := func(arguments map[string]any) *mcp.CallToolResult {
		t.Helper()
		result, err := session.CallTool(context.Background(), &mcp.CallToolParams{Name: OPERATION_STATUS_TOOL, Arguments: arguments})
		if err != nil {
			t.Fatal(err)
		}
		return result
	}
	immediate := status(map[string]any{"operation_id": operationID})
	if got := texts(immediate); immediate.IsError || backend.reads != 1 || len(got) != 2 || !strings.Contains(got[0], `"status":"pending"`) {
		t.Fatalf("immediate read: %v after %d reads", got, backend.reads)
	}
	backend.reads = 0
	waited := status(map[string]any{"operation_id": operationID, "wait_seconds": 5})
	if got := texts(waited); waited.IsError || backend.reads != 2 || len(got) != 1 || !strings.Contains(got[0], `"status":"success"`) {
		t.Fatalf("waited read: %v after %d reads", got, backend.reads)
	}
	for _, arguments := range []map[string]any{{"operation_id": "../capabilities"}, {"operation_id": operationID, "wait_seconds": MAX_STATUS_WAIT_SECONDS + 1}} {
		if refused := status(arguments); !refused.IsError {
			t.Fatalf("accepted %v", arguments)
		}
	}
}

func TestBridgeRepeatsOnlyOMCRefusalCodes(t *testing.T) {
	body := `{"code":"capability_unavailable"}`
	upstream := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.WriteHeader(503)
		writer.Write([]byte(body))
	}))
	defer upstream.Close()
	bridge, err := New(upstream.URL, "token")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = bridge.Catalog(context.Background()); err == nil || err.Error() != "capability_unavailable" {
		t.Fatalf("code lost: %v", err)
	}
	body = `<html>upstream secret-looking page</html>`
	if _, err = bridge.Catalog(context.Background()); err == nil || err.Error() != "omc_request_refused" {
		t.Fatalf("foreign body repeated: %v", err)
	}
}
