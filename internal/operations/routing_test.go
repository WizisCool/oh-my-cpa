package operations

import (
	"context"
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"

	"github.com/oh-my-cpa/oh-my-cpa/internal/capability"
	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/management"
	appcrypto "github.com/oh-my-cpa/oh-my-cpa/internal/crypto"
	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
)

// The Agent arranges routing through a preview of the exact changes, bound to the
// board revision it was prepared on; approval applies that plan and nothing else.
func TestRoutingApplyPreviewsAndAppliesThePreparedPlan(t *testing.T) {
	ctx := context.Background()
	database, err := repository.Open(ctx, filepath.Join(t.TempDir(), "routing.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	repo := repository.New(database)
	cipher, err := appcrypto.New(strings.Repeat("r", 32))
	if err != nil {
		t.Fatal(err)
	}

	board := NewRoutingBoard(management.RoutingSettings{Strategy: "rr"}, []RoutingMember{
		{Key: "credential:a.json", Kind: ROUTING_MEMBER_CREDENTIAL, ID: "a.json", Name: "Primary", Priority: 0, Weights: []RoutingWeight{{Index: 0}}, KeyCount: 1},
		{Key: "credential:b.json", Kind: ROUTING_MEMBER_CREDENTIAL, ID: "b.json", Name: "Runtime", Priority: 0, Weights: []RoutingWeight{{Index: 0}}, KeyCount: 1, IsRuntimeOnly: true},
	}, nil)
	var applied []NormalizedRoutingPlan
	service := &Service{
		ReadRouting: func(context.Context) (RoutingBoard, error) { return board, nil },
		ApplyRouting: func(_ context.Context, plan NormalizedRoutingPlan) (RoutingOutcome, error) {
			applied = append(applied, plan)
			return RoutingOutcome{IsComplete: true, Results: []RoutingResult{{Key: "credential:a.json", Status: ROUTING_APPLIED}}}, nil
		},
	}
	registry := capability.NewRegistry()
	if err := service.registerRouting(registry); err != nil {
		t.Fatal(err)
	}
	executor := &capability.Executor{Registry: registry, Store: repository.AgentStore{Repo: repo, Cipher: cipher}}
	principal := capability.Principal{ID: "administrator", Adapter: "agent", IsAdmin: true}
	plan := func(revision string, priority int) json.RawMessage {
		raw, _ := json.Marshal(map[string]any{"revision": revision, "members": []any{map[string]any{"key": "credential:a.json", "priority": priority}}})
		return raw
	}

	result, err := executor.Invoke(ctx, principal, "routing_read", json.RawMessage(`{}`), "")
	if err != nil || result.Status != "success" || !strings.Contains(string(result.Data), `"strategy":"round-robin"`) {
		t.Fatalf("read: %+v %v", result, err)
	}

	// A plan that cannot be prepared is refused before anything awaits approval.
	if _, err := executor.Invoke(ctx, principal, "routing_apply", plan("stale", 10), ""); capability.ErrorCode(err) != "resource_conflict" {
		t.Fatalf("stale plan: %v", err)
	}
	if _, err := executor.Invoke(ctx, principal, "routing_apply", plan(board.Revision, 0), ""); capability.ErrorCode(err) != "invalid_parameters" {
		t.Fatalf("no-op plan: %v", err)
	}

	// Effective runtime-only edits must be refused before asking for approval.
	weight, changedWeight, excludedWeight, priority := int64(2), int64(3), int64(0), 10
	for _, test := range []struct {
		name    string
		current *int64
		edit    RoutingMemberEdit
	}{
		{name: "priority", edit: RoutingMemberEdit{Priority: &priority}},
		{name: "set weight", edit: RoutingMemberEdit{Weights: []RoutingWeightEdit{{Index: 0, Weight: &weight}}}},
		{name: "exclude by weight", edit: RoutingMemberEdit{Weights: []RoutingWeightEdit{{Index: 0, Weight: &excludedWeight}}}},
		{name: "change weight", current: &weight, edit: RoutingMemberEdit{Weights: []RoutingWeightEdit{{Index: 0, Weight: &changedWeight}}}},
		{name: "clear weight", current: &weight, edit: RoutingMemberEdit{Weights: []RoutingWeightEdit{{Index: 0}}}},
	} {
		t.Run(test.name, func(t *testing.T) {
			board.Members[1].Weights[0].Weight = test.current
			board.Seal()
			test.edit.Key = "credential:b.json"
			runtimePlan, err := json.Marshal(RoutingPlan{Revision: board.Revision, Members: []RoutingMemberEdit{test.edit}})
			if err != nil {
				t.Fatal(err)
			}
			if res, err := executor.Invoke(ctx, principal, "routing_apply", runtimePlan, ""); err != nil || res.Code != "invalid_parameters" || res.OperationID != "" {
				t.Fatalf("runtime member edit must not await approval: res=%+v err=%v", res, err)
			}
		})
	}
	board.Members[1].Weights[0].Weight = nil
	board.Seal()

	// Unchanged runtime-only values do not block edits on a writable member.
	unchangedPriority := 0
	preparedPlan, err := json.Marshal(RoutingPlan{Revision: board.Revision, Members: []RoutingMemberEdit{
		{Key: "credential:a.json", Priority: &priority, Weights: []RoutingWeightEdit{{Index: 0, Weight: &weight}}},
		{Key: "credential:b.json", Priority: &unchangedPriority, Weights: []RoutingWeightEdit{{Index: 0}}},
	}})
	if err != nil {
		t.Fatal(err)
	}
	result, err = executor.Invoke(ctx, principal, "routing_apply", preparedPlan, "")
	if err != nil || result.Status != "pending" {
		t.Fatalf("plan: %+v %v", result, err)
	}
	if len(applied) != 0 {
		t.Fatal("applied before approval")
	}
	pending, err := executor.Get(ctx, principal, result.OperationID)
	preview, _ := json.Marshal(pending.Preview)
	if err != nil || !strings.Contains(string(preview), `{"field":"priority","from":0,"key":"credential:a.json","name":"Primary","to":10}`) {
		t.Fatalf("preview must name the change: %s %v", preview, err)
	}
	operation, err := executor.Decide(ctx, principal, result.OperationID, true, "")
	if err != nil || operation.Result.Status != "success" {
		t.Fatalf("approval: %+v %v", operation, err)
	}
	if len(applied) != 1 || applied[0].Revision != board.Revision || *applied[0].Members[0].Priority != 10 {
		t.Fatalf("applied = %+v", applied)
	}
}
