package capability

import (
	"context"
	"encoding/json"
	"testing"
	"time"
)

func TestLiveExecutionIsNotCrashUncertainty(t *testing.T) {
	executor := newTestExecutor(t)
	entered := make(chan struct{})
	release := make(chan struct{})
	metadata := Metadata{Name: "blocking_write", Description: "Synthetic write", Version: 1, Permission: "write", Risk: "high", Adapters: []string{"agent"}}
	if err := Register(executor.Registry, metadata, func(context.Context, testInput) (Preview, error) { return Preview{Target: "fixture"}, nil }, func(context.Context, testInput, string, string) (testOutput, error) {
		close(entered)
		<-release
		return testOutput{true}, nil
	}); err != nil {
		t.Fatal(err)
	}
	principal := Principal{ID: "console", Adapter: "agent", IsAdmin: true}
	result, err := executor.Invoke(context.Background(), principal, "blocking_write", json.RawMessage(`{"target":"fixture"}`), "")
	if err != nil {
		t.Fatal(err)
	}
	if result.Status != "pending" {
		t.Fatalf("fixture approval not pending:%s", result.Status)
	}
	finished := make(chan Operation, 1)
	failed := make(chan error, 1)
	go func() {
		operation, decisionErr := executor.Decide(context.Background(), principal, result.OperationID, true, "")
		failed <- decisionErr
		finished <- operation
	}()
	select {
	case <-entered:
	case <-time.After(2 * time.Second):
		t.Fatal("execution never started")
	}
	observed, readErr := executor.Get(context.Background(), principal, result.OperationID)
	close(release)
	final := <-finished
	decisionErr := <-failed
	if readErr != nil || decisionErr != nil {
		t.Fatalf("fixture error:%v %v", readErr, decisionErr)
	}
	t.Logf("live_blocked_execution_status=%s final_status=%s", observed.Status, final.Status)
	if observed.Status == "uncertain" {
		t.Error("live in-process operation misreported as a crash-uncertain terminal outcome")
	}
}
