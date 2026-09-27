package capability

import (
	"context"
	"encoding/json"
	"errors"
	"path/filepath"
	"strings"
	"testing"
	"time"

	appcrypto "github.com/oh-my-cpa/oh-my-cpa/internal/crypto"
	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
)

func newTestExecutor(t *testing.T) *Executor {
	t.Helper()
	database, err := repository.Open(context.Background(), filepath.Join(t.TempDir(), "agent.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { database.Close() })
	cipher, err := appcrypto.New("01234567890123456789012345678901")
	if err != nil {
		t.Fatal(err)
	}
	return &Executor{Registry: NewRegistry(), Store: repository.AgentStore{Repo: repository.New(database), Cipher: cipher}}
}

func TestWriteFailureAfterCommitIsUncertain(t *testing.T) {
	for _, failure := range []string{"output_limit", "timeout", "cancelled"} {
		t.Run(failure, func(t *testing.T) {
			executor := newTestExecutor(t)
			metadata := Metadata{Name: "test_write", Description: "Write", Version: 1, Permission: "write", Risk: "low", Adapters: []string{"agent"}}
			calls := 0
			err := Register(executor.Registry, metadata, nil, func(context.Context, testInput, string, string) (string, error) {
				calls++
				switch failure {
				case "timeout":
					return "", context.DeadlineExceeded
				case "cancelled":
					return "", context.Canceled
				default:
					return strings.Repeat("x", MAX_PAYLOAD_BYTES+1), nil
				}
			})
			if err != nil {
				t.Fatal(err)
			}
			principal := Principal{ID: "console", Adapter: "agent", IsAdmin: true}
			result, err := executor.Invoke(context.Background(), principal, "test_write", json.RawMessage(`{"target":"resource"}`), "")
			if err != nil || result.Status != "uncertain" || calls != 1 || len(result.Data) != 0 {
				t.Fatalf("result: %+v %v", result, err)
			}
			operation, err := executor.Get(context.Background(), principal, result.OperationID)
			if err != nil || operation.Status != "uncertain" {
				t.Fatalf("receipt: %+v %v", operation, err)
			}
		})
	}
}

func TestOAuthDecisionClaimsBeforeCancelAndPreservesPending(t *testing.T) {
	executor := newTestExecutor(t)
	ctx := context.Background()
	principal := Principal{ID: "console", Adapter: "agent", IsAdmin: true}
	metadata := Metadata{Name: "oauth_test", Description: "Connect", Version: 1, Permission: "write", Risk: "high", HumanInput: "oauth", Adapters: []string{"agent"}}
	err := Register(executor.Registry, metadata, func(context.Context, testInput) (Preview, error) { return Preview{Target: "provider"}, nil }, func(context.Context, testInput, string, string) (testOutput, error) { return testOutput{true}, nil })
	if err != nil {
		t.Fatal(err)
	}
	result, err := executor.Invoke(ctx, principal, "oauth_test", json.RawMessage(`{"target":"provider"}`), "")
	if err != nil {
		t.Fatal(err)
	}
	cancellations := 0
	executor.VerifyHuman = func(ctx context.Context, operation Operation, approve bool) error {
		if approve {
			return errors.New("confirmation_pending")
		}
		var stored Operation
		if _, err := executor.Store.Load(ctx, "operation", operation.ID, &stored); err != nil {
			t.Fatal(err)
		}
		if stored.Status != "executing" {
			t.Fatalf("cancel ran before claim: %s", stored.Status)
		}
		cancellations++
		return errors.New("remote outcome unknown")
	}
	if _, err := executor.Decide(ctx, principal, result.OperationID, true, "", ""); err == nil || err.Error() != "confirmation_pending" {
		t.Fatalf("approval: %v", err)
	}
	pending, err := executor.Get(ctx, principal, result.OperationID)
	if err != nil || pending.Status != "pending" {
		t.Fatalf("lost pending: %+v %v", pending, err)
	}
	operation, err := executor.Decide(ctx, principal, result.OperationID, false, "", "")
	if err != nil || operation.Status != "uncertain" {
		t.Fatalf("cancel: %+v %v", operation, err)
	}
	if _, err := executor.Decide(ctx, principal, result.OperationID, false, "", ""); err != nil || cancellations != 1 {
		t.Fatalf("replayed cancellation: %d %v", cancellations, err)
	}
}

func TestDecisionAuditFailureDoesNotVerifyOAuth(t *testing.T) {
	executor := newTestExecutor(t)
	ctx := context.Background()
	principal := Principal{ID: "console", Adapter: "agent", IsAdmin: true}
	metadata := Metadata{Name: "oauth_test", Description: "Connect", Version: 1, Permission: "write", Risk: "high", HumanInput: "oauth", Adapters: []string{"agent"}}
	if err := Register(executor.Registry, metadata, func(context.Context, testInput) (Preview, error) { return Preview{Target: "provider"}, nil }, func(context.Context, testInput, string, string) (testOutput, error) { return testOutput{true}, nil }); err != nil {
		t.Fatal(err)
	}
	result, err := executor.Invoke(ctx, principal, "oauth_test", json.RawMessage(`{"target":"provider"}`), "")
	if err != nil {
		t.Fatal(err)
	}
	executor.VerifyHuman = func(context.Context, Operation, bool) error { t.Fatal("OAuth callback ran without audit"); return nil }
	// Keep operation storage valid while failing just the write-ahead audit.
	if _, err := executor.Store.Repo.SQL().ExecContext(ctx, `CREATE TRIGGER fail_agent_audit BEFORE INSERT ON audit_events BEGIN SELECT RAISE(FAIL, 'audit unavailable'); END`); err != nil {
		t.Fatal(err)
	}
	_, err = executor.Decide(ctx, principal, result.OperationID, true, "", "")
	if err == nil || err.Error() != "audit_write_failed" {
		t.Fatalf("decision: %v", err)
	}
}

func TestInvocationAdmissionBound(t *testing.T) {
	executor := newTestExecutor(t)
	executor.admissionOnce.Do(func() { executor.admission = make(chan struct{}, 16) })
	for i := 0; i < 16; i++ {
		executor.admission <- struct{}{}
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if _, err := executor.Invoke(ctx, Principal{}, "unused", json.RawMessage(`{}`), ""); err == nil || err.Error() != "agent_busy" {
		t.Fatalf("admission: %v", err)
	}
}
