package capability

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"sync"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
)

type Result struct {
	Status      string          `json:"status"`
	Data        json.RawMessage `json:"data,omitempty"`
	Code        string          `json:"code,omitempty"`
	OperationID string          `json:"operation_id,omitempty"`
	Invalidates []string        `json:"invalidates,omitempty"`
}
type Operation struct {
	ID          string          `json:"id"`
	PrincipalID string          `json:"principal_id"`
	Adapter     string          `json:"adapter"`
	SessionID   string          `json:"session_id,omitempty"`
	Capability  string          `json:"capability"`
	Version     int             `json:"version"`
	Arguments   json.RawMessage `json:"arguments"`
	Preview     Preview         `json:"preview"`
	Status      string          `json:"status"`
	ExpiresAtMS int64           `json:"expires_at_ms"`
	HumanInput  string          `json:"human_input,omitempty"`
	Result      Result          `json:"result"`
	revision    int64
}
type Executor struct {
	Registry      *Registry
	Store         repository.AgentStore
	Authorize     func(context.Context, string, string) bool
	VerifyHuman   func(context.Context, Operation, bool) error
	mu            sync.Mutex
	admissionOnce sync.Once
	admission     chan struct{}
}

func NewID() string {
	var value [24]byte
	if _, err := rand.Read(value[:]); err != nil {
		panic(err)
	}
	return hex.EncodeToString(value[:])
}
func (e *Executor) isAllowed(ctx context.Context, p Principal, name string) bool {
	return p.Allows(name) && (p.IsAdmin || e.Authorize != nil && e.Authorize(ctx, p.ID, name))
}
func (e *Executor) Invoke(ctx context.Context, p Principal, name string, raw json.RawMessage, sessionID string) (Result, error) {
	e.admissionOnce.Do(func() { e.admission = make(chan struct{}, 16) })
	select {
	case e.admission <- struct{}{}:
		defer func() { <-e.admission }()
	default:
		return Result{}, errors.New("agent_busy")
	}
	ctx, cancel := context.WithTimeout(ctx, 120*time.Second)
	defer cancel()
	definition, err := e.Registry.Lookup(name, p)
	if err != nil || !e.isAllowed(ctx, p, name) {
		return Result{}, errors.New("capability_forbidden")
	}
	canonical, err := definition.Validate(raw)
	if err != nil {
		return Result{}, err
	}
	if definition.Risk == "high" {
		preview, err := definition.Prepare(ctx, canonical)
		if err != nil {
			return Result{}, err
		}
		previewJSON, err := json.Marshal(preview)
		if err != nil || len(previewJSON) > MAX_PAYLOAD_BYTES {
			return Result{}, errors.New("tool_result_too_large")
		}
		operation := Operation{ID: NewID(), PrincipalID: p.ID, Adapter: p.Adapter, SessionID: sessionID, Capability: name, Version: definition.Version, Arguments: canonical, Preview: preview, Status: "pending", ExpiresAtMS: time.Now().Add(10 * time.Minute).UnixMilli(), HumanInput: definition.HumanInput}
		if definition.Permission == "destructive" && preview.Challenge == "" {
			return Result{}, errors.New("invalid_confirmation")
		}
		if err := e.audit(ctx, p, name, operation.ID, "prepared"); err != nil {
			return Result{}, err
		}
		if _, err := e.Store.Save(ctx, "operation", operation.ID, 0, time.Now().Add(7*24*time.Hour), operation); err != nil {
			return Result{}, err
		}
		return Result{Status: "pending", OperationID: operation.ID}, nil
	}
	if definition.Permission == "read" {
		return e.execute(ctx, p, definition, canonical, "", "", NewID()), nil
	}
	operation := Operation{ID: NewID(), PrincipalID: p.ID, Adapter: p.Adapter, SessionID: sessionID, Capability: name, Version: definition.Version, Arguments: canonical, Status: "executing", ExpiresAtMS: time.Now().Add(7 * 24 * time.Hour).UnixMilli()}
	revision, err := e.Store.Save(ctx, "operation", operation.ID, 0, time.Now().Add(7*24*time.Hour), operation)
	if err != nil {
		return Result{}, err
	}
	finishCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 120*time.Second)
	defer cancel()
	operation.Result = e.execute(finishCtx, p, definition, canonical, "", "", operation.ID)
	operation.Status = operation.Result.Status
	if _, err = e.Store.Save(finishCtx, "operation", operation.ID, revision, time.Now().Add(7*24*time.Hour), operation); err != nil {
		return Result{Status: "uncertain", Code: "operation_outcome_unknown", OperationID: operation.ID}, nil
	}
	return operation.Result, nil
}
func (e *Executor) Get(ctx context.Context, p Principal, id string) (Operation, error) {
	var operation Operation
	revision, err := e.Store.Load(ctx, "operation", id, &operation)
	if err != nil {
		return operation, errors.New("operation_not_found")
	}
	if !p.IsAdmin && operation.PrincipalID != p.ID {
		return Operation{}, errors.New("operation_not_found")
	}
	if !p.IsAdmin && !e.isAllowed(ctx, p, operation.Capability) {
		return Operation{}, errors.New("capability_forbidden")
	}
	operation.revision = revision
	if operation.Status == "pending" && operation.ExpiresAtMS <= time.Now().UnixMilli() {
		operation.Status = "expired"
	}
	// An executing record is never replayed after a crash: its remote commit may have succeeded.
	if operation.Status == "executing" {
		operation.Status = "uncertain"
		operation.Result = Result{Status: "uncertain", Code: "operation_outcome_unknown", OperationID: id}
	}
	return operation, nil
}
func (e *Executor) Decide(ctx context.Context, admin Principal, id string, approve bool, challenge, secret string) (Operation, error) {
	if !admin.IsAdmin || admin.Adapter != "agent" {
		return Operation{}, errors.New("capability_forbidden")
	}
	if !e.mu.TryLock() {
		return Operation{}, errors.New("agent_busy")
	}
	defer e.mu.Unlock()
	operation, err := e.Get(ctx, admin, id)
	if err != nil {
		return operation, err
	}
	if operation.Status != "pending" {
		return operation, nil
	}
	caller := Principal{ID: operation.PrincipalID, Adapter: operation.Adapter, IsAdmin: operation.Adapter == "agent", Allowed: map[string]bool{operation.Capability: true}}
	definition, err := e.Registry.Lookup(operation.Capability, caller)
	if err != nil || definition.Version != operation.Version || !e.isAllowed(ctx, caller, operation.Capability) {
		return operation, errors.New("capability_forbidden")
	}
	if approve && operation.Preview.Challenge != "" && challenge != operation.Preview.Challenge {
		return operation, errors.New("confirmation_mismatch")
	}
	if approve && definition.HumanInput == "secret" && (len(secret) == 0 || len(secret) > 8192) {
		return operation, errors.New("secret_required")
	}
	if definition.HumanInput == "oauth" && e.VerifyHuman == nil {
		return operation, errors.New("capability_unavailable")
	}
	if err := e.auditDetails(ctx, admin, operation.Capability, id, "decision", map[string]any{"operation_principal_id": operation.PrincipalID, "operation_adapter": operation.Adapter}); err != nil {
		return operation, err
	}
	// Approval verification is read-only and leaves an unfinished flow pending.
	// Cancellation can mutate CPA, so it runs only after the operation is claimed.
	if approve && definition.HumanInput == "oauth" {
		if err := e.VerifyHuman(ctx, operation, true); err != nil {
			return operation, err
		}
	}
	operation.Status = "executing"
	operation.revision, err = e.Store.Save(ctx, "operation", id, operation.revision, time.Now().Add(7*24*time.Hour), operation)
	if err != nil {
		return operation, err
	}
	// A disconnected approval tab cannot interrupt recording a claimed mutation.
	finishCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 120*time.Second)
	defer cancel()
	if approve {
		operation.Result = e.execute(finishCtx, caller, definition, operation.Arguments, operation.Preview.Revision, secret, id)
	} else {
		operation.Result = Result{Status: "rejected", OperationID: id}
		if definition.HumanInput == "oauth" {
			if err := e.VerifyHuman(finishCtx, operation, false); err != nil {
				operation.Result = Result{Status: "uncertain", Code: "operation_outcome_unknown", OperationID: id}
			}
		}
		if err := e.audit(finishCtx, admin, operation.Capability, id, operation.Result.Status); err != nil {
			operation.Result = Result{Status: "uncertain", Code: "audit_write_failed", OperationID: id}
		}
	}
	operation.Status = operation.Result.Status
	if _, err = e.Store.Save(finishCtx, "operation", id, operation.revision, time.Now().Add(7*24*time.Hour), operation); err != nil {
		return operation, errors.New("operation_outcome_unknown")
	}
	return operation, nil
}
func (e *Executor) execute(ctx context.Context, p Principal, definition *Definition, args json.RawMessage, revision, secret, id string) Result {
	result := Result{Status: "error", OperationID: id}
	if err := e.audit(ctx, p, definition.Name, id, "attempt"); err != nil {
		result.Code = "audit_write_failed"
		return result
	}
	value, err := definition.Execute(ctx, args, revision, secret)
	if err != nil {
		result.Code = ErrorCode(err)
		if definition.Permission != "read" && (result.Code == "operation_failed" || result.Code == "cancelled" || result.Code == "timeout") {
			result.Code = "operation_outcome_unknown"
		}
		if result.Code == "provider_commit_partial" {
			result.Status = "partial"
		}
		if result.Code == "operation_outcome_unknown" {
			result.Status = "uncertain"
		}
	} else {
		result.Data, err = definition.ValidateOutput(value)
		if err != nil {
			result.Code = ErrorCode(err)
			if definition.Permission != "read" {
				result.Status = "uncertain"
			}
		} else {
			result.Status = "success"
			result.Invalidates = definition.Invalidates
		}
	}
	if err := e.audit(ctx, p, definition.Name, id, result.Status); err != nil {
		result.Status = "uncertain"
		result.Code = "audit_write_failed"
	}
	return result
}
func (e *Executor) audit(ctx context.Context, p Principal, name, id, status string) error {
	return e.auditDetails(ctx, p, name, id, status, nil)
}

// auditDetails records who acted and, for a decision, which request it decided.
// Arguments and results are never recorded: they can carry business data or secrets.
func (e *Executor) auditDetails(ctx context.Context, p Principal, name, id, status string, extra map[string]any) error {
	details := map[string]any{"principal_id": p.ID, "adapter": p.Adapter}
	for key, value := range extra {
		details[key] = value
	}
	_, err := e.Store.Repo.RecordAuditEvent(ctx, repository.AuditEvent{Action: "capability." + name, TargetType: "capability_operation", TargetID: id, Result: status, SourceSummary: p.Adapter, Details: details})
	if err != nil {
		return errors.New("audit_write_failed")
	}
	return nil
}
func ErrorCode(err error) string {
	if err == nil {
		return ""
	}
	code := err.Error()
	switch code {
	case "provider_commit_partial", "agent_busy", "agent_revision_conflict", "confirmation_pending", "confirmation_mismatch", "invalid_tool_arguments", "invalid_tool_result", "tool_input_too_large", "tool_result_too_large", "capability_forbidden", "resource_conflict", "resource_missing", "invalid_window", "invalid_parameters", "operation_outcome_unknown", "capability_unavailable", "audit_write_failed", "write_busy", "secret_required":
		return code
	}
	if errors.Is(err, context.Canceled) {
		return "cancelled"
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return "timeout"
	}
	return "operation_failed"
}
