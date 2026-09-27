package capability

import (
	"context"
	"encoding/json"
	"path/filepath"
	"testing"
	"time"

	appcrypto "github.com/oh-my-cpa/oh-my-cpa/internal/crypto"
	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
)

type testInput struct {
	Target string `json:"target"`
}
type testOutput struct {
	IsUpdated bool `json:"is_updated"`
}

func testMetadata() Metadata {
	return Metadata{Name: "test_action", Description: "Test action", Version: 1, Permission: "destructive", Risk: "high", Adapters: []string{"agent", "mcp"}}
}
func TestRegistrySchemaAndDiscovery(t *testing.T) {
	registry := NewRegistry()
	metadata := testMetadata()
	prepare := func(context.Context, testInput) (Preview, error) {
		return Preview{Target: "resource", Revision: "v1", Challenge: "resource"}, nil
	}
	execute := func(context.Context, testInput, string, string) (testOutput, error) { return testOutput{true}, nil }
	if err := Register(registry, metadata, prepare, execute); err != nil {
		t.Fatal(err)
	}
	if err := Register(registry, metadata, prepare, execute); err == nil {
		t.Fatal("duplicate accepted")
	}
	principal := Principal{ID: "test", Adapter: "agent", IsAdmin: true}
	definition, err := registry.Lookup(metadata.Name, principal)
	if err != nil {
		t.Fatal(err)
	}
	for _, raw := range []string{`{"target":"x","approved":true}`, `{"target":4}`, `{}`, `[]`, `{"target":"x"} {}`, `null`} {
		if _, err := definition.Validate(json.RawMessage(raw)); err == nil {
			t.Errorf("accepted %s", raw)
		}
	}
	if _, err := definition.Validate(json.RawMessage(`{"target":"x"}`)); err != nil {
		t.Fatal(err)
	}
	if _, err := definition.ValidateOutput(map[string]any{"is_updated": "wrong"}); err == nil {
		t.Fatal("invalid output accepted")
	}
	if len(registry.List(Principal{Adapter: "mcp"})) != 0 {
		t.Fatal("ungranted discovery")
	}
	if len(registry.List(Principal{Adapter: "mcp", Allowed: map[string]bool{metadata.Name: true}})) != 1 {
		t.Fatal("adapter discovery differs")
	}
	metadata.Name = "unsafe"
	metadata.Risk = "low"
	if err := Register(registry, metadata, prepare, execute); err == nil {
		t.Fatal("unconfirmed destructive action")
	}
}
func TestExecutorConfirmationReplayAndRevocation(t *testing.T) {
	ctx := context.Background()
	database, err := repository.Open(ctx, filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	cipher, err := appcrypto.New("01234567890123456789012345678901")
	if err != nil {
		t.Fatal(err)
	}
	registry := NewRegistry()
	calls := 0
	isAllowed := true
	err = Register(registry, testMetadata(), func(context.Context, testInput) (Preview, error) {
		return Preview{Target: "resource", Revision: "v1", Challenge: "resource"}, nil
	}, func(_ context.Context, _ testInput, revision, _ string) (testOutput, error) {
		if revision != "v1" {
			t.Fatal("lost revision")
		}
		calls++
		return testOutput{true}, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	executor := Executor{Registry: registry, Store: repository.AgentStore{Repo: repository.New(database), Cipher: cipher}, Authorize: func(context.Context, string, string) bool { return isAllowed }}
	principal := Principal{ID: "external", Adapter: "mcp", Allowed: map[string]bool{"test_action": true}}
	result, err := executor.Invoke(ctx, principal, "test_action", json.RawMessage(`{"target":"resource"}`), "")
	if err != nil || result.Status != "pending" || calls != 0 {
		t.Fatalf("prepare: %+v %v", result, err)
	}
	if _, err = executor.Get(ctx, Principal{ID: "other", Adapter: "mcp", Allowed: principal.Allowed}, result.OperationID); err == nil {
		t.Fatal("cross principal read")
	}
	if _, err = executor.Decide(ctx, principal, result.OperationID, true, "resource", ""); err == nil {
		t.Fatal("external approval")
	}
	admin := Principal{ID: "administrator", Adapter: "agent", IsAdmin: true}
	if _, err = executor.Decide(ctx, admin, result.OperationID, true, "wrong", ""); err == nil {
		t.Fatal("challenge bypass")
	}
	isAllowed = false
	if _, err = executor.Decide(ctx, admin, result.OperationID, true, "resource", ""); err == nil {
		t.Fatal("revoked grant executed")
	}
	isAllowed = true
	operation, err := executor.Decide(ctx, admin, result.OperationID, true, "resource", "")
	if err != nil || operation.Status != "success" || calls != 1 {
		t.Fatalf("execute: %+v %v", operation, err)
	}
	if _, err = executor.Decide(ctx, admin, result.OperationID, true, "resource", ""); err != nil || calls != 1 {
		t.Fatal("replayed execution")
	}
	result, err = executor.Invoke(ctx, principal, "test_action", json.RawMessage(`{"target":"resource"}`), "")
	if err != nil {
		t.Fatal(err)
	}
	operation, err = executor.Get(ctx, admin, result.OperationID)
	if err != nil {
		t.Fatal(err)
	}
	operation.ExpiresAtMS = time.Now().Add(-time.Minute).UnixMilli()
	if _, err = executor.Store.Save(ctx, "operation", operation.ID, operation.revision, time.Now().Add(time.Hour), operation); err != nil {
		t.Fatal(err)
	}
	operation, err = executor.Decide(ctx, admin, operation.ID, true, "resource", "")
	if err != nil || operation.Status != "expired" || calls != 1 {
		t.Fatal("expired execution")
	}
}
