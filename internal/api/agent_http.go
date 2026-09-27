package api

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/oh-my-cpa/oh-my-cpa/internal/agent"
	"github.com/oh-my-cpa/oh-my-cpa/internal/capability"
)

func (h *Handler) capabilityPrincipal(request *http.Request) (capability.Principal, bool) {
	if authorization := request.Header.Get("Authorization"); authorization != "" {
		if h.cfg.IsDemoMode || !strings.HasPrefix(authorization, "Bearer ") || len(authorization) > 8192 || h.auth == nil || !h.auth.KeyMatches(strings.TrimPrefix(authorization, "Bearer ")) {
			return capability.Principal{}, false
		}
		if h.ensureAgent() != nil {
			return capability.Principal{}, false
		}
		principal := capability.Principal{ID: h.auth.CapabilityIdentity(), Adapter: "mcp", Allowed: map[string]bool{}}
		for _, definition := range h.agent.executor.Registry.List(capability.Principal{Adapter: "mcp", IsAdmin: true}) {
			principal.Allowed[definition.Name] = true
		}
		return principal, true
	}
	return agent.PRINCIPAL, h.auth != nil && h.auth.Valid(request)
}
func (h *Handler) requireConsoleOrCapability(next http.Handler) http.Handler {
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		prefix := strings.TrimRight(h.cfg.BasePath, "/") + "/api/v1/capabilities"
		if request.Header.Get("Authorization") != "" && (request.URL.Path == prefix || strings.HasPrefix(request.URL.Path, prefix+"/")) {
			ip := resolveClientIP(request, h.trustedProxies)
			if h.limiter != nil && h.limiter.isLocked(ip) {
				writePlaygroundError(writer, 429, "authentication_rate_limited")
				return
			}
			if _, ok := h.capabilityPrincipal(request); !ok {
				if h.limiter != nil {
					h.limiter.recordFailure(ip)
				}
				writePlaygroundError(writer, 401, "authentication_required")
				return
			}
			next.ServeHTTP(writer, request)
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
	var input struct {
		Approve   bool   `json:"approve"`
		Challenge string `json:"challenge"`
		Secret    string `json:"secret"`
	}
	if !readAgentInput(writer, request, &input) {
		return
	}
	operation, err := h.agent.executor.Decide(request.Context(), agent.PRINCIPAL, chi.URLParam(request, "id"), input.Approve, input.Challenge, input.Secret)
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
	writeJSON(writer, 200, conversation)
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
func (h *Handler) runAgent(writer http.ResponseWriter, request *http.Request) {
	if !h.readyAgent(writer) {
		return
	}
	var input agent.Input
	if !readAgentInput(writer, request, &input) {
		return
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
				_, err := io.WriteString(writer, ": keepalive\n\n")
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
	emit := func(event agent.Event) error {
		streamMu.Lock()
		defer streamMu.Unlock()
		_ = controller.SetWriteDeadline(time.Now().Add(30 * time.Second))
		raw, err := json.Marshal(event)
		if err != nil {
			return err
		}
		if _, err = writer.Write(append(append([]byte("data: "), raw...), []byte("\n\n")...)); err != nil {
			return err
		}
		return controller.Flush()
	}
	if err := h.agent.runtime.Run(streamCtx, input, emit); err != nil {
		_ = emit(agent.Event{Type: "error", Content: capability.ErrorCode(err)})
	}
}
