package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/oh-my-cpa/oh-my-cpa/internal/capability"
	"github.com/oh-my-cpa/oh-my-cpa/internal/mcpbridge"
)

// MCP_CONSOLE_URL_HEADER carries the console address of the request being served to the tool
// handlers, which see the request's headers but not its host. serveMCP overwrites whatever the
// caller sent under this name.
const MCP_CONSOLE_URL_HEADER = "X-Omc-Console-Url"

// executorBackend is the in-process side of the MCP endpoint: the same executor calls the
// capability HTTP endpoints make, without a second HTTP hop.
type executorBackend struct{ handler *Handler }

func (backend executorBackend) Catalog(context.Context) ([]*capability.Definition, error) {
	h := backend.handler
	return h.agent.executor.Registry.List(capability.Principal{Adapter: "mcp", IsAdmin: true}), nil
}
func (backend executorBackend) Invoke(ctx context.Context, name string, arguments json.RawMessage) (capability.Result, error) {
	h := backend.handler
	result, err := h.agent.executor.Invoke(ctx, h.mcpPrincipal(), name, arguments, "")
	if err != nil {
		return result, errors.New(capability.ErrorCode(err))
	}
	return result, nil
}
func (backend executorBackend) Operation(ctx context.Context, id string) (capability.Operation, error) {
	h := backend.handler
	operation, err := h.agent.executor.Get(ctx, h.mcpPrincipal(), id)
	if err != nil {
		return operation, errors.New("operation_not_found")
	}
	return operation, nil
}

// consoleURL is the address the caller reached this console at, base path included. It is
// only ever returned to that same authenticated caller, as the approval link.
func (h *Handler) consoleURL(request *http.Request) string {
	scheme := "http"
	if request.TLS != nil {
		scheme = "https"
	} else if forwarded := strings.TrimSpace(strings.Split(request.Header.Get("X-Forwarded-Proto"), ",")[0]); forwarded == "https" {
		scheme = forwarded
	}
	return scheme + "://" + request.Host + strings.TrimRight(h.cfg.BasePath, "/")
}

func (h *Handler) mcpHandler() (http.Handler, error) {
	h.agent.mcpMu.Lock()
	defer h.agent.mcpMu.Unlock()
	if h.agent.mcp != nil {
		return h.agent.mcp, nil
	}
	server, err := mcpbridge.NewServer(context.Background(), executorBackend{handler: h}, mcpbridge.Options{Version: h.cfg.Version, ConsoleURL: func(request *mcp.CallToolRequest) string {
		if request.Extra == nil {
			return ""
		}
		return request.Extra.Header.Get(MCP_CONSOLE_URL_HEADER)
	}})
	if err != nil {
		return nil, err
	}
	h.agent.mcp = mcpbridge.NewHTTPHandler(func(*http.Request) *mcp.Server { return server })
	return h.agent.mcp, nil
}

// MCPJSONRPCRequestDTO describes a JSON-RPC 2.0 request or notification sent to the Streamable HTTP MCP endpoint.
type MCPJSONRPCRequestDTO struct {
	JSONRPC string `json:"jsonrpc"`
	ID      any    `json:"id,omitempty"`
	Method  string `json:"method"`
	Params  any    `json:"params,omitempty"`
}

// MCPJSONRPCErrorDTO describes a JSON-RPC 2.0 error object returned by the MCP endpoint.
type MCPJSONRPCErrorDTO struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
	Data    any    `json:"data,omitempty"`
}

// MCPJSONRPCResponseDTO describes a JSON-RPC 2.0 response envelope returned by POST /mcp.
type MCPJSONRPCResponseDTO struct {
	JSONRPC string              `json:"jsonrpc"`
	ID      any                 `json:"id,omitempty"`
	Result  any                 `json:"result,omitempty"`
	Error   *MCPJSONRPCErrorDTO `json:"error,omitempty"`
}

// @Summary Call Streamable HTTP MCP endpoint
// @Description Invoke Oh My CPA capabilities via JSON-RPC 2.0 over Streamable HTTP. Clients must send Content-Type: application/json and Accept: application/json, text/event-stream; notifications return 202 with an empty body.
// @Tags MCP
// @Accept json
// @Produce json,text/event-stream
// @Security BearerAuth
// @Param body body MCPJSONRPCRequestDTO true "JSON-RPC 2.0 request or notification"
// @Success 200 {object} MCPJSONRPCResponseDTO
// @Success 202 {string} string "Accepted (JSON-RPC notification or response)"
// @Failure 400 {string} string "Missing or invalid Accept header or malformed JSON-RPC payload"
// @Failure 401 {object} ErrorResponseDTO
// @Failure 415 {string} string "Unsupported Media Type (Content-Type must be application/json)"
// @Failure 429 {object} ErrorResponseDTO
// @Failure 503 {object} ErrorResponseDTO
// @Router /mcp [post]
func (h *Handler) serveMCPPost(writer http.ResponseWriter, request *http.Request) {
	h.serveMCP(writer, request)
}

// @Summary Open Streamable HTTP MCP event stream
// @Description Stateless Streamable HTTP MCP endpoint; SSE GET streams are disabled and authenticated requests with Accept: text/event-stream receive 405 Method Not Allowed (Allow: POST).
// @Tags MCP
// @Produce text/event-stream
// @Security BearerAuth
// @Failure 400 {string} string "Missing text/event-stream in Accept header"
// @Failure 401 {object} ErrorResponseDTO
// @Failure 405 {string} string "Method not allowed in stateless MCP mode (Allow: POST)"
// @Failure 429 {object} ErrorResponseDTO
// @Failure 503 {object} ErrorResponseDTO
// @Router /mcp [get]
func (h *Handler) serveMCPGet(writer http.ResponseWriter, request *http.Request) {
	h.serveMCP(writer, request)
}

// @Summary Close Streamable HTTP MCP session
// @Description Terminate a Streamable HTTP MCP session when an Mcp-Session-Id header is provided (no-op 204 in stateless mode).
// @Tags MCP
// @Produce json
// @Security BearerAuth
// @Param Mcp-Session-Id header string true "MCP session identifier"
// @Success 204 {string} string "Session closed"
// @Failure 400 {string} string "Missing Mcp-Session-Id header"
// @Failure 401 {object} ErrorResponseDTO
// @Failure 429 {object} ErrorResponseDTO
// @Failure 503 {object} ErrorResponseDTO
// @Router /mcp [delete]
func (h *Handler) serveMCPDelete(writer http.ResponseWriter, request *http.Request) {
	h.serveMCP(writer, request)
}

// serveMCP is the capability registry as a Streamable HTTP MCP endpoint.
//
// It accepts the management key as a bearer token and nothing else: a session cookie is not
// an MCP credential, so a page open in the operator's browser cannot drive the endpoint.
func (h *Handler) serveMCP(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	if request.Header.Get("Authorization") == "" {
		writer.Header().Set("WWW-Authenticate", `Bearer realm="oh-my-cpa"`)
		writePlaygroundError(writer, 401, "authentication_required")
		return
	}
	if !h.authenticateBearer(writer, request) {
		return
	}
	handler, err := h.mcpHandler()
	if err != nil {
		writePlaygroundError(writer, 503, "capability_unavailable")
		return
	}
	request.Header.Set(MCP_CONSOLE_URL_HEADER, h.consoleURL(request))
	handler.ServeHTTP(writer, request)
}
