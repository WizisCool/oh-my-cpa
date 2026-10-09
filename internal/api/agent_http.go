package api

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/oh-my-cpa/oh-my-cpa/internal/agent"
	"github.com/oh-my-cpa/oh-my-cpa/internal/agui"
	"github.com/oh-my-cpa/oh-my-cpa/internal/capability"
)

// mcpPrincipal is the authority of a caller holding the management key: every capability
// declared for the mcp adapter, and never approval.
func (h *Handler) mcpPrincipal() capability.Principal {
	principal := capability.Principal{ID: h.auth.CapabilityIdentity(), Adapter: "mcp", Allowed: map[string]bool{}}
	for _, definition := range h.agent.executor.Registry.List(capability.Principal{Adapter: "mcp", IsAdmin: true}) {
		principal.Allowed[definition.Name] = true
	}
	return principal
}
func (h *Handler) capabilityPrincipal(request *http.Request) (capability.Principal, bool) {
	if authorization := request.Header.Get("Authorization"); authorization != "" {
		if h.cfg.IsDemoMode || !strings.HasPrefix(authorization, "Bearer ") || len(authorization) > 8192 || h.auth == nil || !h.auth.KeyMatches(strings.TrimPrefix(authorization, "Bearer ")) {
			return capability.Principal{}, false
		}
		if h.ensureAgent() != nil {
			return capability.Principal{}, false
		}
		return h.mcpPrincipal(), true
	}
	return agent.PRINCIPAL, h.auth != nil && h.auth.Valid(request)
}

// authenticateBearer admits a request that presents the management key as a bearer token,
// spending the sign-in throttle on a wrong one so the key cannot be guessed faster here than
// on the login form.
func (h *Handler) authenticateBearer(writer http.ResponseWriter, request *http.Request) bool {
	ip := resolveClientIP(request, h.trustedProxies)
	if h.limiter != nil && h.limiter.isLocked(ip) {
		writePlaygroundError(writer, 429, "authentication_rate_limited")
		return false
	}
	if _, ok := h.capabilityPrincipal(request); !ok {
		if h.limiter != nil {
			h.limiter.recordFailure(ip)
		}
		writePlaygroundError(writer, 401, "authentication_required")
		return false
	}
	return true
}
func (h *Handler) requireConsoleOrCapability(next http.Handler) http.Handler {
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		prefix := strings.TrimRight(h.cfg.BasePath, "/") + "/api/v1/capabilities"
		if request.Header.Get("Authorization") != "" && (request.URL.Path == prefix || strings.HasPrefix(request.URL.Path, prefix+"/")) {
			if h.authenticateBearer(writer, request) {
				next.ServeHTTP(writer, request)
			}
			return
		}
		h.requireAuthentication(next).ServeHTTP(writer, request)
	})
}
func readAgentInput(writer http.ResponseWriter, request *http.Request, value any) bool {
	request.Body = http.MaxBytesReader(writer, request.Body, 64<<10)
	decoder := json.NewDecoder(request.Body)
	decoder.DisallowUnknownFields()
	if decoder.Decode(value) != nil || decoder.Decode(new(any)) != io.EOF {
		writePlaygroundError(writer, 400, "invalid_parameters")
		return false
	}
	return true
}
func (h *Handler) readyAgent(writer http.ResponseWriter) bool {
	writer.Header().Set("Cache-Control", "no-store")
	if err := h.ensureAgent(); err != nil {
		writePlaygroundError(writer, 503, "capability_unavailable")
		return false
	}
	return true
}
func (h *Handler) listCapabilities(writer http.ResponseWriter, request *http.Request) {
	if !h.readyAgent(writer) {
		return
	}
	principal, ok := h.capabilityPrincipal(request)
	if !ok && !h.cfg.IsDemoMode {
		writePlaygroundError(writer, 401, "authentication_required")
		return
	}
	if h.cfg.IsDemoMode {
		principal = agent.PRINCIPAL
	}
	writeJSON(writer, 200, map[string]any{"capabilities": h.agent.executor.Registry.List(principal)})
}
func (h *Handler) invokeCapability(writer http.ResponseWriter, request *http.Request) {
	if !h.readyAgent(writer) {
		return
	}
	principal, ok := h.capabilityPrincipal(request)
	if !ok {
		writePlaygroundError(writer, 401, "authentication_required")
		return
	}
	var input struct {
		Name      string          `json:"name"`
		Arguments json.RawMessage `json:"arguments"`
	}
	if !readAgentInput(writer, request, &input) {
		return
	}
	result, err := h.agent.executor.Invoke(request.Context(), principal, input.Name, input.Arguments, "")
	if err != nil {
		writePlaygroundError(writer, 400, capability.ErrorCode(err))
		return
	}
	writeJSON(writer, 200, result)
}
func (h *Handler) getCapabilityOperation(writer http.ResponseWriter, request *http.Request) {
	if !h.readyAgent(writer) {
		return
	}
	principal, ok := h.capabilityPrincipal(request)
	if !ok {
		writePlaygroundError(writer, 401, "authentication_required")
		return
	}
	operation, err := h.agent.executor.Get(request.Context(), principal, chi.URLParam(request, "id"))
	if err != nil {
		writePlaygroundError(writer, 404, "operation_not_found")
		return
	}
	writeJSON(writer, 200, operation)
}
func (h *Handler) decideAgentOperation(writer http.ResponseWriter, request *http.Request) {
	// Approvals require an actual browser origin, unlike ordinary script-compatible APIs.
	if request.Header.Get("Origin") == "" || !sameOrigin(request) || request.Header.Get("Authorization") != "" {
		writePlaygroundError(writer, 403, "capability_forbidden")
		return
	}
	if !h.readyAgent(writer) {
		return
	}
	// One decision: allow or deny. A secret or an answer rides along only when the operation asks
	// for one, and never both.
	var input struct {
		Approve bool            `json:"approve"`
		Secret  string          `json:"secret"`
		Answer  json.RawMessage `json:"answer"`
	}
	if !readAgentInput(writer, request, &input) {
		return
	}
	humanInput := input.Secret
	if len(input.Answer) > 0 && string(input.Answer) != "null" {
		if humanInput != "" {
			writePlaygroundError(writer, 400, "invalid_parameters")
			return
		}
		humanInput = string(input.Answer)
	}
	operation, err := h.agent.executor.Decide(request.Context(), agent.PRINCIPAL, chi.URLParam(request, "id"), input.Approve, humanInput)
	if err != nil {
		writePlaygroundError(writer, 409, capability.ErrorCode(err))
		return
	}
	writeJSON(writer, 200, operation)
}
func (h *Handler) currentAgent(writer http.ResponseWriter, request *http.Request) {
	if !h.readyAgent(writer) {
		return
	}
	conversation, err := h.agent.runtime.Current(request.Context())
	if err != nil {
		writePlaygroundError(writer, 500, "session_unavailable")
		return
	}
	projected := agentConversationForConsole(&conversation)
	if run := h.browserRuns.find("agent", ""); run != nil {
		run.mu.Lock()
		if !run.isDone {
			projected.ActiveRunID = run.id
		}
		run.mu.Unlock()
	}
	writeJSON(writer, 200, projected)
}
func (h *Handler) resetAgent(writer http.ResponseWriter, request *http.Request) {
	if !h.readyAgent(writer) {
		return
	}
	var input struct {
		Revision int64 `json:"revision"`
	}
	if !readAgentInput(writer, request, &input) {
		return
	}
	if err := h.agent.runtime.Reset(request.Context(), input.Revision); err != nil {
		writePlaygroundError(writer, 409, capability.ErrorCode(err))
		return
	}
	h.currentAgent(writer, request)
}

// agentForwardedProps is the OMC part of a run request: the stored revision the client last saw,
// and the key, model and effort to run with. Decoded as strictly as the envelope around it.
type agentForwardedProps struct {
	Revision        int64  `json:"revision"`
	Model           string `json:"model"`
	Fingerprint     string `json:"client_key_fingerprint"`
	ReasoningEffort string `json:"reasoning_effort,omitempty"`
	// Endpoint names the inference endpoint a new message is sent to; absent is Chat Completions.
	Endpoint string `json:"endpoint,omitempty"`
	// ReplaceTurn is the newest turn a retried or edited message takes the place of.
	ReplaceTurn string `json:"replace_turn,omitempty"`
	// Present is the presentation a composer command asked this message's answer to take.
	Present string `json:"present,omitempty"`
}

// The context entries a run may carry (ADR 0041): the console's reading language, which the prompt
// uses as the reply language's default, and how the console writes token counts, so an answer
// writes them the way the pages beside it do. Anything else is refused.
const (
	AGENT_CONTEXT_LANGUAGE    = "console_language"
	AGENT_CONTEXT_TOKEN_STYLE = "console_token_style"
)

// MAX_AGENT_RUN_BYTES bounds a run request: the message's text and its images.
const MAX_AGENT_RUN_BYTES = 128<<10 + agui.MAX_MESSAGE_IMAGES*(agui.MAX_IMAGE_BYTES/3*4+1024)

// agentImage serves one image of the current conversation to the page that shows it. The bytes
// are the operator's own upload, already validated as an image of the declared type; they are
// served as that type only, never sniffed, and sandboxed so opening one directly runs nothing.
func (h *Handler) agentImage(writer http.ResponseWriter, request *http.Request) {
	if !h.readyAgent(writer) {
		return
	}
	url, err := h.agent.runtime.Image(request.Context(), chi.URLParam(request, "id"))
	header, encoded, _ := strings.Cut(url, ",")
	content, decodeErr := base64.StdEncoding.DecodeString(encoded)
	if err != nil || decodeErr != nil || len(content) == 0 {
		writePlaygroundError(writer, 404, "resource_not_found")
		return
	}
	writer.Header().Set("Content-Type", strings.TrimSuffix(strings.TrimPrefix(header, "data:"), ";base64"))
	writer.Header().Set("X-Content-Type-Options", "nosniff")
	// An image never changes under its identifier, and the identifier dies with its turn.
	writer.Header().Set("Cache-Control", "private, max-age=86400, immutable")
	writer.Header().Set("Content-Security-Policy", "default-src 'none'; style-src 'none'; sandbox")
	writer.Header().Set("Content-Length", strconv.Itoa(len(content)))
	writer.WriteHeader(200)
	_, _ = writer.Write(content)
}

// runAgent serves one Agent run as an AG-UI event stream (ADR 0041).
//
// A request the runtime refuses before it persisted the turn still gets a stream, but one without
// RUN_STARTED: the browser reads that as "not accepted" and hands the message back to the
// composer, instead of losing it behind an HTTP 200 that looked like acceptance.
func (h *Handler) runAgent(writer http.ResponseWriter, request *http.Request) {
	if !h.readyAgent(writer) {
		return
	}
	// A message may be 48 KiB of text whose line breaks and quotes double in JSON, beside four
	// images of five megabytes each in base64.
	request.Body = http.MaxBytesReader(writer, request.Body, MAX_AGENT_RUN_BYTES)
	wire, err := agui.DecodeRunInput(request.Body, agui.Limits{Tools: agent.DisplayToolNames(), Context: map[string]bool{AGENT_CONTEXT_LANGUAGE: true, AGENT_CONTEXT_TOKEN_STYLE: true}})
	var props agentForwardedProps
	if err == nil {
		decoder := json.NewDecoder(bytes.NewReader(wire.ForwardedProps))
		decoder.DisallowUnknownFields()
		if len(wire.ForwardedProps) == 0 || decoder.Decode(&props) != nil || decoder.Decode(new(any)) != io.EOF {
			err = agui.ErrInvalidInput
		}
	}
	if err != nil {
		if errors.Is(err, agui.ErrRequestTooLarge) {
			writePlaygroundError(writer, http.StatusRequestEntityTooLarge, "request_too_large")
		} else {
			writePlaygroundError(writer, http.StatusBadRequest, "invalid_parameters")
		}
		return
	}
	input := agent.Input{
		ConversationID:  wire.ThreadID,
		Revision:        props.Revision,
		Message:         wire.Message,
		Fingerprint:     props.Fingerprint,
		Model:           props.Model,
		ReasoningEffort: props.ReasoningEffort,
		Endpoint:        props.Endpoint,
		Language:        wire.Context[AGENT_CONTEXT_LANGUAGE],
		ReplaceTurn:     props.ReplaceTurn,
		Present:         props.Present,
		TokenStyle:      wire.Context[AGENT_CONTEXT_TOKEN_STYLE],
		DisplayTools:    wire.Tools,
	}
	for _, image := range wire.Images {
		input.Images = append(input.Images, "data:"+image.MediaType+";base64,"+image.Data)
	}
	for _, entry := range wire.Resume {
		input.Resume = append(input.Resume, entry.InterruptID)
	}
	writer.Header().Set("Content-Type", "text/event-stream")
	writer.Header().Set("X-Accel-Buffering", "no")
	controller := http.NewResponseController(writer)
	streamCtx, cancel := context.WithCancel(request.Context())
	defer cancel()
	var streamMu sync.Mutex
	stop := make(chan struct{})
	stopped := make(chan struct{})
	go func() {
		defer close(stopped)
		ticker := time.NewTicker(15 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-stop:
				return
			case <-request.Context().Done():
				return
			case <-ticker.C:
				streamMu.Lock()
				_ = controller.SetWriteDeadline(time.Now().Add(30 * time.Second))
				_, err := io.WriteString(writer, agui.KEEPALIVE)
				if err == nil {
					err = controller.Flush()
				}
				streamMu.Unlock()
				if err != nil {
					cancel()
					return
				}
			}
		}
	}()
	defer func() { close(stop); <-stopped }()
	translator := agui.NewTranslator(wire.RunID, func(event agui.Event) error {
		streamMu.Lock()
		defer streamMu.Unlock()
		_ = controller.SetWriteDeadline(time.Now().Add(30 * time.Second))
		if err := agui.WriteEvent(writer, event); err != nil {
			return err
		}
		return controller.Flush()
	})
	if err := h.agent.runtime.Run(streamCtx, input, func(event agent.Event) error {
		return translateAgentEvent(translator, input.Model, event)
	}); err != nil {
		_ = translator.Error(capability.ErrorCode(err), nil)
	}
}

// translateAgentEvent maps one runtime event onto the wire. It is the only code that knows both
// vocabularies, so the runtime stays free of any protocol and the protocol package free of OMC.
func translateAgentEvent(translator *agui.Translator, model string, event agent.Event) error {
	switch event.Type {
	case "started":
		return translator.Started(event.ConversationID, map[string]any{"turn_id": event.TurnID})
	case "retry":
		turn := event.Conversation.Turns[len(event.Conversation.Turns)-1]
		return translator.Custom("omc.upstream_retry", map[string]any{"retry": event.Attempt, "failure": event.Failure, "parts": turn.Parts})
	case "round":
		return translator.Step(event.Round)
	case "thought":
		return translator.Reasoning(event.Round, event.Content)
	case "text":
		return translator.Text(event.Round, event.Content)
	case "tool_call":
		return translator.ToolCall(event.Trace.ID, event.Trace.Name, event.Trace.Arguments, map[string]any{"started_at_ms": event.Trace.StartedMS})
	case "tool_result":
		metadata := map[string]any{}
		if event.Trace.StartedMS > 0 {
			metadata["started_at_ms"] = event.Trace.StartedMS
		}
		if event.Trace.EndedMS > 0 {
			metadata["ended_at_ms"] = event.Trace.EndedMS
		}
		if len(event.Trace.View) > 0 {
			metadata["view"] = event.Trace.View
		}
		content := event.Content
		if event.Trace.Name == "database_query" {
			delete(metadata, "view")
			trace := agentTraceForConsole(*event.Trace)
			receipt, err := json.Marshal(trace.Result)
			if err != nil {
				return err
			}
			content = string(receipt)
		}
		return translator.ToolResult(event.Trace.ID, content, metadata)
	case "finished":
		conversation := event.Conversation
		if err := translator.Snapshot(agentConversationForConsole(conversation)); err != nil {
			return err
		}
		turn := conversation.Turns[len(conversation.Turns)-1]
		var usage []agui.TokenUsage
		if turn.Usage != nil {
			usage = []agui.TokenUsage{{Model: model, InputTokens: turn.Usage.InputTokens, OutputTokens: turn.Usage.OutputTokens, TotalTokens: turn.Usage.TotalTokens}}
		}
		if turn.Status == "error" {
			return translator.Error(turn.Code, usage)
		}
		interrupts := make([]agui.Interrupt, 0, len(event.Interrupts))
		for _, pending := range event.Interrupts {
			interrupt := agui.Interrupt{ID: pending.OperationID, Reason: pending.Reason, ToolCallID: pending.TraceID, Metadata: map[string]any{"capability": pending.Capability}}
			if pending.Permission != "" {
				interrupt.Metadata["permission"] = pending.Permission
			}
			if pending.ExpiresAtMS > 0 {
				interrupt.ExpiresAt = time.UnixMilli(pending.ExpiresAtMS).UTC().Format(time.RFC3339)
			}
			interrupts = append(interrupts, interrupt)
		}
		return translator.Finished(interrupts, usage)
	}
	return nil
}
