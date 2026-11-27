package api

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/oh-my-cpa/oh-my-cpa/internal/config"
	"github.com/oh-my-cpa/oh-my-cpa/internal/mcpbridge"
)

type bearerTransport struct{ key string }

func (transport bearerTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	request = request.Clone(request.Context())
	request.Header.Set("Authorization", "Bearer "+transport.key)
	// A caller cannot choose where its approval link points.
	request.Header.Set(MCP_CONSOLE_URL_HEADER, "https://attacker.example")
	return http.DefaultTransport.RoundTrip(request)
}

func TestRemoteMCPServesTheRegistryToAManagementKeyHolder(t *testing.T) {
	fixture := newProviderTestFixture(t)
	endpoint := fixture.baseURL + "/omc/api/mcp"
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	initialize := `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"test","version":"1"}}}`
	post := func(client *http.Client, authorization string) (int, string) {
		request, _ := http.NewRequestWithContext(ctx, "POST", endpoint, strings.NewReader(initialize))
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("Accept", "application/json, text/event-stream")
		if authorization != "" {
			request.Header.Set("Authorization", authorization)
		}
		response, err := client.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		body, _ := io.ReadAll(response.Body)
		return response.StatusCode, string(body)
	}
	// fixture.client carries a signed-in console session: a cookie is not an MCP credential.
	if status, body := post(fixture.client, ""); status != 401 {
		t.Fatalf("session cookie accepted: %d %s", status, body)
	}
	if status, _ := post(&http.Client{}, "Bearer incorrect"); status != 401 {
		t.Fatalf("wrong key accepted: %d", status)
	}

	client := mcp.NewClient(&mcp.Implementation{Name: "test", Version: "1"}, nil)
	session, err := client.Connect(ctx, &mcp.StreamableClientTransport{Endpoint: endpoint, HTTPClient: &http.Client{Transport: bearerTransport{key: "management-secret-value"}}, DisableStandaloneSSE: true}, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer session.Close()
	if info := session.InitializeResult(); info.ServerInfo.Version != fixture.handler.cfg.Version || info.Instructions == "" {
		t.Fatalf("server identity: %+v", info)
	}
	names := map[string]*mcp.Tool{}
	for tool, err := range session.Tools(ctx, nil) {
		if err != nil {
			t.Fatal(err)
		}
		names[tool.Name] = tool
	}
	if names["keys_list"] == nil || !names["keys_list"].Annotations.ReadOnlyHint || names[mcpbridge.OPERATION_STATUS_TOOL] == nil {
		t.Fatalf("catalog: %d tools", len(names))
	}
	if destructive := names["keys_delete"]; destructive == nil || destructive.Annotations.DestructiveHint == nil || !*destructive.Annotations.DestructiveHint {
		t.Fatal("destructive capability is not annotated")
	}
	for _, agentOnly := range []string{"ask_question", "database_query", "database_schema"} {
		if names[agentOnly] != nil {
			t.Fatalf("%s offered over MCP", agentOnly)
		}
	}

	read, err := session.CallTool(ctx, &mcp.CallToolParams{Name: "keys_list"})
	if err != nil || read.IsError || !strings.Contains(read.Content[0].(*mcp.TextContent).Text, `"status":"success"`) {
		t.Fatalf("read: %+v %v", read, err)
	}
	prepared, err := session.CallTool(ctx, &mcp.CallToolParams{Name: "keys_create", Arguments: map[string]any{}})
	if err != nil || prepared.IsError || len(prepared.Content) != 2 {
		t.Fatalf("prepare: %+v %v", prepared, err)
	}
	link := prepared.Content[1].(*mcp.TextContent).Text
	if !strings.HasPrefix(link, "Operator approval: "+fixture.baseURL+"/omc/authorize/") {
		t.Fatalf("approval link: %s", link)
	}
	if structured, _ := json.Marshal(prepared.StructuredContent); !strings.Contains(string(structured), `"approval_url":"`+strings.TrimPrefix(link, "Operator approval: ")+`"`) {
		t.Fatalf("structured result lacks the approval link: %s", structured)
	}
	operationID := link[strings.LastIndex(link, "/")+1:]
	status, err := session.CallTool(ctx, &mcp.CallToolParams{Name: mcpbridge.OPERATION_STATUS_TOOL, Arguments: map[string]any{"operation_id": operationID}})
	if err != nil || status.IsError || !strings.Contains(status.Content[0].(*mcp.TextContent).Text, `"status":"pending"`) {
		t.Fatalf("status: %+v %v", status, err)
	}
	refused, err := session.CallTool(ctx, &mcp.CallToolParams{Name: "requests_get", Arguments: map[string]any{"unknown": true}})
	if err != nil || !refused.IsError || refused.Content[0].(*mcp.TextContent).Text != "invalid_tool_arguments" {
		t.Fatalf("refusal: %+v %v", refused, err)
	}
}

// An agent on the server often reaches OMC by an address the operator's browser cannot open
// (loopback, a container name), so a configured public address is the one the link names.
func TestApprovalLinkPrefersThePublicAddress(t *testing.T) {
	request, _ := http.NewRequest("POST", "http://127.0.0.1:8080/omc/api/mcp", nil)
	h := &Handler{cfg: config.Config{BasePath: "/omc/"}}
	if got := h.consoleURL(request); got != "http://127.0.0.1:8080/omc" {
		t.Fatalf("request address: %s", got)
	}
	h.cfg.PublicURL = "https://omc.example.com/ignored"
	if got := h.consoleURL(request); got != "https://omc.example.com/omc" {
		t.Fatalf("public address: %s", got)
	}
	h.cfg.PublicURL = "omc.example.com"
	if got := h.consoleURL(request); got != "http://127.0.0.1:8080/omc" {
		t.Fatalf("an address without a scheme was used: %s", got)
	}
}
