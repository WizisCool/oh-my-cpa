package mcpbridge

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"testing"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/oh-my-cpa/oh-my-cpa/internal/capability"
)

func TestMCPStdioHelper(t *testing.T) {
	if os.Getenv("OMCPA_MCP_TEST_CHILD") != "1" {
		return
	}
	if err := Run(context.Background(), os.Getenv("OMCPA_SERVER_URL"), os.Getenv("OMCPA_CPA_MANAGEMENT_KEY")); err != nil {
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
	if _, err = bridge.Server(context.Background()); err == nil {
		t.Fatal("redirect accepted")
	}
}
