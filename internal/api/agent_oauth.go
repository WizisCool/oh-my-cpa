package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/oh-my-cpa/oh-my-cpa/internal/agent"
	"github.com/oh-my-cpa/oh-my-cpa/internal/capability"
	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
)

func (h *Handler) startAgentOAuth(writer http.ResponseWriter, request *http.Request) {
	if request.Header.Get("Origin") == "" || !sameOrigin(request) || request.Header.Get("Authorization") != "" {
		writePlaygroundError(writer, 403, "capability_forbidden")
		return
	}
	if !h.readyAgent(writer) {
		return
	}
	id := chi.URLParam(request, "id")
	operation, err := h.agent.executor.Get(request.Context(), agent.PRINCIPAL, id)
	if err != nil || operation.Status != "pending" || operation.HumanInput != "oauth" {
		writePlaygroundError(writer, 409, "resource_conflict")
		return
	}
	var input struct {
		Provider string `json:"provider"`
	}
	if json.Unmarshal(operation.Arguments, &input) != nil {
		writePlaygroundError(writer, 400, "invalid_parameters")
		return
	}
	h.agent.oauthMu.Lock()
	defer h.agent.oauthMu.Unlock()
	// The same operation never starts a second authorization flow on a repeated click.
	flow, exists := h.agent.oauth[id]
	if !exists {
		if _, err := h.repo.RecordAuditEvent(request.Context(), repository.AuditEvent{Action: "capability.oauth_start", TargetType: "capability_operation", TargetID: id, Result: "attempt", SourceSummary: "agent"}); err != nil {
			writePlaygroundError(writer, 500, "audit_write_failed")
			return
		}
		client, err := h.capabilityClient(request.Context())
		if err != nil {
			writePlaygroundError(writer, 503, "capability_unavailable")
			return
		}
		flow, err = client.OAuthAuthURL(request.Context(), input.Provider)
		parsed, parseErr := url.Parse(flow.URL)
		if err != nil || parseErr != nil || parsed.Scheme != "https" || parsed.Host == "" || parsed.User != nil || flow.State == "" {
			writePlaygroundError(writer, 502, "operation_failed")
			return
		}
		h.agent.oauth[id] = flow
	}
	writeJSON(writer, 200, map[string]any{"url": flow.URL, "user_code": flow.UserCode, "flow": flow.Flow, "expires_at_ms": operation.ExpiresAtMS})
}
func (h *Handler) verifyAgentOAuth(ctx context.Context, operation capability.Operation, approve bool) error {
	h.agent.oauthMu.Lock()
	defer h.agent.oauthMu.Unlock()
	flow, exists := h.agent.oauth[operation.ID]
	if !exists || flow.State == "" {
		if !approve {
			return nil
		}
		return errors.New("capability_unavailable")
	}
	client, err := h.capabilityClient(ctx)
	if err != nil {
		return err
	}
	if !approve {
		result, err := client.CancelOAuthSession(ctx, flow.State)
		if err != nil || !result.Cancelled {
			return errors.New("operation_outcome_unknown")
		}
		delete(h.agent.oauth, operation.ID)
		return nil
	}
	if operation.ExpiresAtMS <= time.Now().UnixMilli() {
		return errors.New("resource_conflict")
	}
	status, err := client.OAuthStatus(ctx, flow.State)
	if err != nil {
		return err
	}
	if normalizeOAuthStatus(status.Status) != "ok" {
		return errors.New("confirmation_pending")
	}
	// Keep the flow until the operation is durably finished; maintenance prunes it.
	return nil
}
