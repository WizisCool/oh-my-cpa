// Package mcpbridge is a management-key authenticated HTTP to stdio transport adapter.
package mcpbridge

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/oh-my-cpa/oh-my-cpa/internal/capability"
)

type Bridge struct {
	base          string
	managementKey string
	client        *http.Client
}

func New(serverURL, managementKey string) (*Bridge, error) {
	parsed, err := url.Parse(serverURL)
	if err != nil || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" || managementKey == "" || strings.ContainsAny(managementKey, "\r\n") {
		return nil, errors.New("invalid_mcp_configuration")
	}
	address := net.ParseIP(parsed.Hostname())
	isLoopback := strings.EqualFold(parsed.Hostname(), "localhost") || address != nil && address.IsLoopback()
	if parsed.Scheme != "https" && !(parsed.Scheme == "http" && isLoopback) {
		return nil, errors.New("mcp_requires_https")
	}
	return &Bridge{base: strings.TrimRight(serverURL, "/"), managementKey: managementKey, client: &http.Client{Timeout: 125 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return errors.New("redirect_forbidden") }}}, nil
}
func (bridge *Bridge) request(ctx context.Context, method, path string, input, output any) error {
	raw, err := json.Marshal(input)
	if err != nil {
		return err
	}
	request, err := http.NewRequestWithContext(ctx, method, bridge.base+"/api/v1"+path, bytes.NewReader(raw))
	if err != nil {
		return errors.New("invalid_request")
	}
	request.Header.Set("Authorization", "Bearer "+bridge.managementKey)
	request.Header.Set("Content-Type", "application/json")
	response, err := bridge.client.Do(request)
	if err != nil {
		return errors.New("omc_unavailable")
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return errors.New("omc_request_refused")
	}
	payload, err := io.ReadAll(io.LimitReader(response.Body, 1<<20+1))
	if err != nil || len(payload) > 1<<20 {
		return errors.New("response_too_large")
	}
	if json.Unmarshal(payload, output) != nil {
		return errors.New("invalid_response")
	}
	return nil
}
func (bridge *Bridge) Server(ctx context.Context) (*mcp.Server, error) {
	var catalog struct {
		Capabilities []capability.Definition `json:"capabilities"`
	}
	if err := bridge.request(ctx, http.MethodGet, "/capabilities", nil, &catalog); err != nil {
		return nil, err
	}
	server := mcp.NewServer(&mcp.Implementation{Name: "oh-my-cpa", Version: "1"}, nil)
	for _, definition := range catalog.Capabilities {
		isDestructive := definition.Permission == "destructive"
		server.AddTool(&mcp.Tool{Name: definition.Name, Description: definition.Description, InputSchema: definition.InputSchema, OutputSchema: definition.ResultSchema(), Annotations: &mcp.ToolAnnotations{ReadOnlyHint: definition.Permission == "read", DestructiveHint: &isDestructive}}, func(ctx context.Context, request *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			var result capability.Result
			err := bridge.request(ctx, http.MethodPost, "/capabilities/invoke", map[string]any{"name": definition.Name, "arguments": request.Params.Arguments}, &result)
			return bridge.result(result, err), nil
		})
	}
	mcp.AddTool(server, &mcp.Tool{Name: "omc_operation_status", Description: "Read an OMC operation receipt. Approvals must be completed by the operator in OMC."}, func(ctx context.Context, _ *mcp.CallToolRequest, input struct {
		OperationID string `json:"operation_id"`
	}) (*mcp.CallToolResult, any, error) {
		if len(input.OperationID) != 48 || strings.Trim(input.OperationID, "0123456789abcdef") != "" {
			return bridge.result(nil, errors.New("invalid_operation_id")), nil, nil
		}
		var operation capability.Operation
		err := bridge.request(ctx, http.MethodGet, "/capabilities/operations/"+input.OperationID, nil, &operation)
		return bridge.result(operation, err), nil, nil
	})
	return server, nil
}
func (bridge *Bridge) result(value any, err error) *mcp.CallToolResult {
	if err != nil {
		return &mcp.CallToolResult{IsError: true, Content: []mcp.Content{&mcp.TextContent{Text: err.Error()}}}
	}
	raw, _ := json.Marshal(value)
	result := &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: string(raw)}}, StructuredContent: value}
	if receipt, ok := value.(capability.Result); ok {
		result.IsError = receipt.Status == "error" || receipt.Status == "uncertain"
		if receipt.Status == "pending" {
			result.Content = append(result.Content, &mcp.TextContent{Text: "Operator approval: " + bridge.base + "/agent?operation=" + receipt.OperationID})
		}
	}
	return result
}
func Run(ctx context.Context, serverURL, managementKey string) error {
	bridge, err := New(serverURL, managementKey)
	if err != nil {
		return err
	}
	server, err := bridge.Server(ctx)
	if err != nil {
		return err
	}
	return server.Run(ctx, &mcp.StdioTransport{})
}
