// Package mcpbridge maps the capability registry to MCP tools for external agents.
//
// One server definition serves two transports: OMC's own Streamable HTTP endpoint, which
// reaches the executor in-process, and the `oh-my-cpa mcp` stdio process, which reaches it
// through the capability HTTP endpoints. Neither carries business logic or approval policy.
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
	"regexp"
	"strings"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/oh-my-cpa/oh-my-cpa/internal/capability"
)

// OPERATION_STATUS_TOOL is the one tool the bridge adds to the registry's own; the registry
// reserves the name.
const OPERATION_STATUS_TOOL = "omc_operation_status"

// MAX_STATUS_WAIT_SECONDS stays under the idle timeout reverse proxies apply by default (60s),
// so a wait for the operator ends as an answer rather than as a dropped connection.
const MAX_STATUS_WAIT_SECONDS = 30

// statusPollInterval is a variable so the wait test does not sleep for real seconds.
var statusPollInterval = 2 * time.Second

const SERVER_INSTRUCTIONS = `Oh My CPA (OMC) is the control plane of a CLIProxyAPI deployment. These tools read and change it.

Results are JSON envelopes with a "status":
- "success": "data" holds the result.
- "error": "code" names the refusal and "detail", when present, says what to change. Correct the arguments and call again.
- "pending": the change is prepared but not applied. Only the operator can approve it, in the OMC console at the link returned with the result. Give the operator that link, then call omc_operation_status with the operation_id (wait_seconds lets one call wait for the decision). Never report a pending change as done.
- "rejected": the operator denied it. Do not prepare it again unless asked.
- "uncertain": the change may or may not have been applied. Read the current state before deciding anything; never retry blindly.

Secrets and OAuth sign-ins are entered by the operator in the console while approving. Never ask for a credential in conversation and never put one in tool arguments.
Lists are paged and aggregates are bounded; follow the offset or cursor a result returns instead of assuming it is complete.`

// Backend is where a tool call goes: the executor in-process, or OMC's capability endpoints.
// Errors are stable snake_case codes, returned to the agent as the tool's error text.
type Backend interface {
	Catalog(ctx context.Context) ([]*capability.Definition, error)
	Invoke(ctx context.Context, name string, arguments json.RawMessage) (capability.Result, error)
	Operation(ctx context.Context, id string) (capability.Operation, error)
}

type Options struct {
	// Version is the OMC build the server reports to the client.
	Version string
	// ConsoleURL returns the console address, base path included, that the operator opens to
	// decide an operation. An empty value leaves the link out of a pending result.
	ConsoleURL func(*mcp.CallToolRequest) string
}

type operationStatusInput struct {
	OperationID string `json:"operation_id" jsonschema:"the operation_id of a pending result"`
	WaitSeconds int    `json:"wait_seconds,omitempty" jsonschema:"seconds to wait for the operator's decision before answering, 0 to 30; 0 answers immediately"`
}

var operationIDPattern = regexp.MustCompile(`^[0-9a-f]{48}$`)

// NewServer declares every capability the backend offers as an MCP tool.
//
// The catalog is read once: the registry is fixed at OMC startup, so a server built from it is
// valid for the life of the process that serves it.
func NewServer(ctx context.Context, backend Backend, options Options) (*mcp.Server, error) {
	catalog, err := backend.Catalog(ctx)
	if err != nil {
		return nil, err
	}
	server := mcp.NewServer(&mcp.Implementation{Name: "oh-my-cpa", Title: "Oh My CPA", Version: options.Version}, &mcp.ServerOptions{Instructions: SERVER_INSTRUCTIONS})
	approvalLink := func(request *mcp.CallToolRequest, operationID string) string {
		if options.ConsoleURL == nil {
			return ""
		}
		base := strings.TrimRight(options.ConsoleURL(request), "/")
		if base == "" {
			return ""
		}
		return base + "/agent?operation=" + operationID
	}
	// OMC is a closed system: no tool reaches an arbitrary external target.
	isOpenWorld := false
	for _, definition := range catalog {
		isDestructive := definition.Permission == "destructive"
		annotations := &mcp.ToolAnnotations{ReadOnlyHint: definition.Permission == "read", DestructiveHint: &isDestructive, OpenWorldHint: &isOpenWorld}
		server.AddTool(&mcp.Tool{Name: definition.Name, Description: definition.Description, InputSchema: definition.InputSchema, OutputSchema: definition.ResultSchema(), Annotations: annotations}, func(ctx context.Context, request *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			arguments := request.Params.Arguments
			// A client may omit the arguments of a tool that takes none.
			if len(arguments) == 0 {
				arguments = json.RawMessage(`{}`)
			}
			result, err := backend.Invoke(ctx, definition.Name, arguments)
			if err != nil {
				return failure(err), nil
			}
			return receipt(result, approvalLink(request, result.OperationID)), nil
		})
	}
	mcp.AddTool(server, &mcp.Tool{Name: OPERATION_STATUS_TOOL, Description: "Read the state of an operation that returned status \"pending\": still pending, or its outcome once the operator has decided. Approval itself happens only in the OMC console.", Annotations: &mcp.ToolAnnotations{ReadOnlyHint: true, OpenWorldHint: &isOpenWorld}}, func(ctx context.Context, request *mcp.CallToolRequest, input operationStatusInput) (*mcp.CallToolResult, any, error) {
		if !operationIDPattern.MatchString(input.OperationID) {
			return failure(errors.New("invalid_operation_id")), nil, nil
		}
		if input.WaitSeconds < 0 || input.WaitSeconds > MAX_STATUS_WAIT_SECONDS {
			return failure(errors.New("invalid_wait_seconds")), nil, nil
		}
		operation, err := awaitOperation(ctx, backend, input.OperationID, time.Duration(input.WaitSeconds)*time.Second)
		if err != nil {
			return failure(err), nil, nil
		}
		raw, _ := json.Marshal(operation)
		result := &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: string(raw)}}, StructuredContent: operation}
		if operation.Status == "pending" {
			if link := approvalLink(request, operation.ID); link != "" {
				result.Content = append(result.Content, &mcp.TextContent{Text: "Operator approval: " + link})
			}
		}
		return result, nil, nil
	})
	return server, nil
}

// awaitOperation reads an operation, re-reading it while it is pending and the wait lasts.
func awaitOperation(ctx context.Context, backend Backend, id string, wait time.Duration) (capability.Operation, error) {
	deadline := time.Now().Add(wait)
	for {
		operation, err := backend.Operation(ctx, id)
		if err != nil || operation.Status != "pending" || time.Until(deadline) < statusPollInterval {
			return operation, err
		}
		select {
		case <-ctx.Done():
			return operation, nil
		case <-time.After(statusPollInterval):
		}
	}
}

func failure(err error) *mcp.CallToolResult {
	return &mcp.CallToolResult{IsError: true, Content: []mcp.Content{&mcp.TextContent{Text: err.Error()}}}
}

func receipt(value capability.Result, approvalLink string) *mcp.CallToolResult {
	raw, _ := json.Marshal(value)
	result := &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: string(raw)}}, StructuredContent: value}
	result.IsError = value.Status == "error" || value.Status == "uncertain"
	if value.Status == "pending" && approvalLink != "" {
		result.Content = append(result.Content, &mcp.TextContent{Text: "Operator approval: " + approvalLink})
	}
	return result
}

// NewHTTPHandler serves a server over MCP's Streamable HTTP transport.
//
// It is stateless and answers in plain JSON: no tool needs a server-initiated message, so there
// is no session to keep in memory, to lose on restart, or to pin a client to one process.
// The SDK's DNS-rebinding guard is off because it refuses every request a same-host reverse
// proxy forwards under the public hostname - the documented deployment - and the caller's
// bearer credential, which a rebound browser page does not hold, is what protects the endpoint.
func NewHTTPHandler(getServer func(*http.Request) *mcp.Server) http.Handler {
	return mcp.NewStreamableHTTPHandler(getServer, &mcp.StreamableHTTPOptions{Stateless: true, JSONResponse: true, DisableLocalhostProtection: true})
}

// Bridge is the Backend of the stdio process: OMC's capability endpoints, authenticated with
// the management key.
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

var errorCodePattern = regexp.MustCompile(`^[a-z][a-z0-9_]{0,63}$`)

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
	payload, err := io.ReadAll(io.LimitReader(response.Body, 1<<20+1))
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		// OMC's refusals carry a stable code the agent can act on. Anything else in the body
		// - a proxy's error page, say - is not repeated to the model.
		var refusal struct {
			Code string `json:"code"`
		}
		if err == nil && json.Unmarshal(payload, &refusal) == nil && errorCodePattern.MatchString(refusal.Code) {
			return errors.New(refusal.Code)
		}
		return errors.New("omc_request_refused")
	}
	if err != nil || len(payload) > 1<<20 {
		return errors.New("response_too_large")
	}
	if json.Unmarshal(payload, output) != nil {
		return errors.New("invalid_response")
	}
	return nil
}

func (bridge *Bridge) Catalog(ctx context.Context) ([]*capability.Definition, error) {
	var catalog struct {
		Capabilities []*capability.Definition `json:"capabilities"`
	}
	err := bridge.request(ctx, http.MethodGet, "/capabilities", nil, &catalog)
	return catalog.Capabilities, err
}

func (bridge *Bridge) Invoke(ctx context.Context, name string, arguments json.RawMessage) (capability.Result, error) {
	var result capability.Result
	err := bridge.request(ctx, http.MethodPost, "/capabilities/invoke", map[string]any{"name": name, "arguments": arguments}, &result)
	return result, err
}

func (bridge *Bridge) Operation(ctx context.Context, id string) (capability.Operation, error) {
	var operation capability.Operation
	err := bridge.request(ctx, http.MethodGet, "/capabilities/operations/"+id, nil, &operation)
	return operation, err
}

// Server builds the MCP server the stdio process serves.
func (bridge *Bridge) Server(ctx context.Context, version string) (*mcp.Server, error) {
	return NewServer(ctx, bridge, Options{Version: version, ConsoleURL: func(*mcp.CallToolRequest) string { return bridge.base }})
}

func Run(ctx context.Context, serverURL, managementKey, version string) error {
	bridge, err := New(serverURL, managementKey)
	if err != nil {
		return err
	}
	server, err := bridge.Server(ctx, version)
	if err != nil {
		return err
	}
	return server.Run(ctx, &mcp.StdioTransport{})
}
