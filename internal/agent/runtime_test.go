package agent

import (
	"context"
	"encoding/json"
	"errors"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/oh-my-cpa/oh-my-cpa/internal/capability"
	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/gateway"
	appcrypto "github.com/oh-my-cpa/oh-my-cpa/internal/crypto"
	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
)

type modelFunc func(context.Context, string, []gateway.AgentMessage, []gateway.AgentTool, func(gateway.Event) error) (gateway.AgentReply, error)

func (fn modelFunc) StreamAgent(ctx context.Context, model string, _ string, messages []gateway.AgentMessage, tools []gateway.AgentTool, emit func(gateway.Event) error) (gateway.AgentReply, error) {
	return fn(ctx, model, messages, tools, emit)
}
func newTestRuntime(t *testing.T) *Runtime {
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
	store := repository.AgentStore{Repo: repository.New(database), Cipher: cipher}
	return &Runtime{Store: store, Executor: &capability.Executor{Store: store, Registry: capability.NewRegistry()}, Slots: make(chan struct{}, 4)}
}

// TestRuntimeDeclaresEveryCapabilityFromTheFirstRound pins the property that removed a whole
// model round-trip per action: the tool list a model is offered is the registry itself, on the
// first round, without a discovery call in between. A regression here is not a cosmetic one -
// it puts a round trip back in front of every capability the agent uses.
func TestRuntimeDeclaresEveryCapabilityFromTheFirstRound(t *testing.T) {
	runtime := newTestRuntime(t)
	for _, name := range []string{"fixture_first", "fixture_second"} {
		if err := capability.Register(runtime.Executor.Registry, capability.Metadata{Name: name, Description: "fixture", Version: 1, Permission: "read", Risk: "low", Adapters: []string{"agent"}}, nil, func(context.Context, struct{}, string, string) (struct{}, error) {
			return struct{}{}, nil
		}); err != nil {
			t.Fatal(err)
		}
	}
	runtime.Client = func(context.Context, string) (ModelClient, error) {
		return modelFunc(func(_ context.Context, _ string, _ []gateway.AgentMessage, tools []gateway.AgentTool, _ func(gateway.Event) error) (gateway.AgentReply, error) {
			names := make([]string, 0, len(tools))
			for _, tool := range tools {
				names = append(names, tool.Function.Name)
			}
			sort.Strings(names)
			if len(names) != 2 || names[0] != "fixture_first" || names[1] != "fixture_second" {
				t.Fatalf("first-round tools: %v", names)
			}
			return gateway.AgentReply{Content: "ok"}, nil
		}), nil
	}
	err := runtime.Run(context.Background(), Input{Message: "hi", Model: "fixture", Fingerprint: "key"}, func(Event) error { return nil })
	if err != nil {
		t.Fatal(err)
	}
}

// TestRuntimeResolvesTheClientOncePerTurn counts the resolutions because each one is a CPA key
// list read, and a five-round turn used to pay for five of them.
func TestRuntimeResolvesTheClientOncePerTurn(t *testing.T) {
	runtime := newTestRuntime(t)
	if err := capability.Register(runtime.Executor.Registry, capability.Metadata{Name: "fixture_read", Description: "fixture", Version: 1, Permission: "read", Risk: "low", Adapters: []string{"agent"}}, nil, func(context.Context, struct{}, string, string) (struct{}, error) {
		return struct{}{}, nil
	}); err != nil {
		t.Fatal(err)
	}
	resolutions := 0
	rounds := 0
	runtime.Client = func(context.Context, string) (ModelClient, error) {
		resolutions++
		return modelFunc(func(context.Context, string, []gateway.AgentMessage, []gateway.AgentTool, func(gateway.Event) error) (gateway.AgentReply, error) {
			rounds++
			if rounds <= 3 {
				return gateway.AgentReply{Calls: []gateway.ToolCall{{ID: string(rune('a' + rounds)), Type: "function", Function: gateway.ToolFunction{Name: "fixture_read", Arguments: `{}`}}}}, nil
			}
			return gateway.AgentReply{Content: "done"}, nil
		}), nil
	}
	err := runtime.Run(context.Background(), Input{Message: "count", Model: "fixture", Fingerprint: "key"}, func(Event) error { return nil })
	if err != nil {
		t.Fatal(err)
	}
	if resolutions != 1 || rounds != 4 {
		t.Fatalf("resolutions=%d rounds=%d", resolutions, rounds)
	}
}

func TestRuntimeReadAndAuthoritativeHistory(t *testing.T) {
	runtime := newTestRuntime(t)
	calls := 0
	executions := 0
	err := capability.Register(runtime.Executor.Registry, capability.Metadata{Name: "fixture_read", Description: "fixture", Version: 1, Permission: "read", Risk: "low", Adapters: []string{"agent"}}, nil, func(context.Context, struct{}, string, string) (struct {
		Count int `json:"count"`
	}, error) {
		executions++
		return struct {
			Count int `json:"count"`
		}{7}, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	runtime.Client = func(context.Context, string) (ModelClient, error) {
		return modelFunc(func(ctx context.Context, _ string, messages []gateway.AgentMessage, tools []gateway.AgentTool, emit func(gateway.Event) error) (gateway.AgentReply, error) {
			calls++
			if messages[0].Role != "system" {
				t.Fatal("missing server system prompt")
			}
			if calls == 1 {
				if len(tools) != 1 || tools[0].Function.Name != "fixture_read" {
					t.Fatalf("first-round tools: %+v", tools)
				}
				return gateway.AgentReply{Calls: []gateway.ToolCall{{ID: "read", Type: "function", Function: gateway.ToolFunction{Name: "fixture_read", Arguments: `{}`}}}}, nil
			}
			if len(messages) < 4 || messages[len(messages)-1].Role != "tool" {
				t.Fatal("missing trusted tool result")
			}
			return gateway.AgentReply{Content: "Seven requests"}, nil
		}), nil
	}
	var final Conversation
	err = runtime.Run(context.Background(), Input{Message: "count", Model: "fixture", Fingerprint: "key"}, func(event Event) error {
		if event.Conversation != nil {
			final = *event.Conversation
		}
		return nil
	})
	if err != nil || calls != 2 || executions != 1 || len(final.Turns) != 1 || final.Turns[0].Status != "success" {
		t.Fatalf("run: %+v %d %d %v", final, calls, executions, err)
	}
	current, err := runtime.Current(context.Background())
	if err != nil || current.Revision != final.Revision {
		t.Fatalf("persisted state: %+v %v", current, err)
	}
	if err = runtime.Run(context.Background(), Input{Message: "stale", Model: "fixture", Fingerprint: "key"}, func(Event) error { return nil }); !errors.Is(err, repository.ErrAgentConflict) {
		t.Fatalf("stale revision accepted %v", err)
	}
}
func TestRuntimePendingReleasesSlotsAndResumes(t *testing.T) {
	runtime := newTestRuntime(t)
	executions := 0
	err := capability.Register(runtime.Executor.Registry, capability.Metadata{Name: "fixture_write", Description: "fixture", Version: 1, Permission: "write", Risk: "high", Adapters: []string{"agent"}}, func(context.Context, struct{}) (capability.Preview, error) {
		return capability.Preview{Target: "resource", Revision: "v1"}, nil
	}, func(context.Context, struct{}, string, string) (struct{}, error) {
		executions++
		return struct{}{}, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	rounds := 0
	runtime.Client = func(context.Context, string) (ModelClient, error) {
		return modelFunc(func(context.Context, string, []gateway.AgentMessage, []gateway.AgentTool, func(gateway.Event) error) (gateway.AgentReply, error) {
			rounds++
			if rounds == 1 {
				return gateway.AgentReply{Calls: []gateway.ToolCall{{ID: "write", Type: "function", Function: gateway.ToolFunction{Name: "fixture_write", Arguments: `{}`}}}}, nil
			}
			return gateway.AgentReply{Content: "Updated"}, nil
		}), nil
	}
	input := Input{Message: "update", Model: "fixture", Fingerprint: "key"}
	if err = runtime.Run(context.Background(), input, func(Event) error { return nil }); err != nil {
		t.Fatal(err)
	}
	current, err := runtime.Current(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if current.Turns[0].Status != "pending" || len(runtime.Slots) != 0 || executions != 0 {
		t.Fatal("pending state invalid")
	}
	operationID := current.Turns[0].Traces[0].Result.OperationID
	if _, err = runtime.Executor.Decide(context.Background(), PRINCIPAL, operationID, true, "", ""); err != nil {
		t.Fatal(err)
	}
	input.ConversationID = current.ID
	input.Revision = current.Revision
	input.Message = ""
	if err = runtime.Run(context.Background(), input, func(Event) error { return nil }); err != nil {
		t.Fatal(err)
	}
	current, err = runtime.Current(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if executions != 1 || current.Turns[0].Status != "success" {
		raw, _ := json.Marshal(current)
		t.Fatalf("resume %s", raw)
	}
}

// TestRuntimeRecordsTheTurnInTheOrderItHappened pins the transcript's order: a model may reason,
// say something, call a capability, reason again and answer, and the stored parts - and the events
// a browser rebuilds them from - follow that order rather than grouping by kind. Reasoning never
// reaches the reply or the messages the next round is built from.
func TestRuntimeRecordsTheTurnInTheOrderItHappened(t *testing.T) {
	runtime := newTestRuntime(t)
	if err := capability.Register(runtime.Executor.Registry, capability.Metadata{Name: "fixture_read", Description: "fixture", Version: 1, Permission: "read", Risk: "low", Adapters: []string{"agent"}}, nil, func(context.Context, struct{}, string, string) (struct{}, error) {
		return struct{}{}, nil
	}); err != nil {
		t.Fatal(err)
	}
	rounds := 0
	runtime.Client = func(context.Context, string) (ModelClient, error) {
		return modelFunc(func(_ context.Context, _ string, messages []gateway.AgentMessage, _ []gateway.AgentTool, emit func(gateway.Event) error) (gateway.AgentReply, error) {
			rounds++
			for _, message := range messages {
				if strings.Contains(message.Content, "plan") {
					t.Fatalf("reasoning leaked into the model context: %+v", message)
				}
			}
			for _, event := range []gateway.Event{{Type: "thought", Content: "plan "}, {Type: "thought", Content: string(rune('0' + rounds))}} {
				if err := emit(event); err != nil {
					return gateway.AgentReply{}, err
				}
			}
			if rounds == 1 {
				if err := emit(gateway.Event{Type: "delta", Content: "checking"}); err != nil {
					return gateway.AgentReply{}, err
				}
				return gateway.AgentReply{Content: "checking", Calls: []gateway.ToolCall{{ID: "call", Type: "function", Function: gateway.ToolFunction{Name: "fixture_read", Arguments: `{}`}}}}, nil
			}
			if err := emit(gateway.Event{Type: "delta", Content: "answer"}); err != nil {
				return gateway.AgentReply{}, err
			}
			return gateway.AgentReply{Content: "answer"}, nil
		}), nil
	}
	var order []string
	var final *Conversation
	err := runtime.Run(context.Background(), Input{Message: "why", Model: "fixture", Fingerprint: "key", ReasoningEffort: "high"}, func(event Event) error {
		if event.Type != "state" {
			order = append(order, event.Type)
		}
		if event.Conversation != nil {
			final = event.Conversation
		}
		return nil
	})
	if err != nil || final == nil {
		t.Fatalf("run: %v", err)
	}
	turn := final.Turns[len(final.Turns)-1]
	want := []Part{
		{Type: "thought", Content: "plan 1"},
		{Type: "text", Content: "checking"},
		{Type: "tool", TraceID: "call"},
		{Type: "thought", Content: "plan 2"},
		{Type: "text", Content: "answer"},
	}
	if len(turn.Parts) != len(want) {
		t.Fatalf("parts %+v", turn.Parts)
	}
	for index := range want {
		if turn.Parts[index] != want[index] {
			t.Fatalf("part %d = %+v, want %+v", index, turn.Parts[index], want[index])
		}
	}
	if strings.Join(order, ",") != "thought,thought,delta,tool,thought,thought,delta" {
		t.Fatalf("event order %v", order)
	}
	if turn.Reply != "checking\n\nanswer" || final.ReasoningEffort != "high" {
		t.Fatalf("reply %q effort %q", turn.Reply, final.ReasoningEffort)
	}
}

// TestRuntimeResetKeepsTheTarget: a new conversation replaces the transcript, never the key,
// model and effort the operator chose.
func TestRuntimeResetKeepsTheTarget(t *testing.T) {
	runtime := newTestRuntime(t)
	runtime.Client = func(context.Context, string) (ModelClient, error) {
		return modelFunc(func(context.Context, string, []gateway.AgentMessage, []gateway.AgentTool, func(gateway.Event) error) (gateway.AgentReply, error) {
			return gateway.AgentReply{Content: "ok"}, nil
		}), nil
	}
	if err := runtime.Run(context.Background(), Input{Message: "hi", Model: "fixture", Fingerprint: "key", ReasoningEffort: "low"}, func(Event) error { return nil }); err != nil {
		t.Fatal(err)
	}
	current, err := runtime.Current(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if err = runtime.Reset(context.Background(), current.Revision); err != nil {
		t.Fatal(err)
	}
	reset, err := runtime.Current(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(reset.Turns) != 0 || reset.Model != "fixture" || reset.Fingerprint != "key" || reset.ReasoningEffort != "low" || reset.ID == current.ID {
		t.Fatalf("reset conversation %+v", reset)
	}
}

func TestRuntimeRefusesAnUnsafeEffortLevel(t *testing.T) {
	runtime := newTestRuntime(t)
	err := runtime.Run(context.Background(), Input{Message: "hi", Model: "fixture", Fingerprint: "key", ReasoningEffort: "high\r\nX-Injected: 1"}, func(Event) error { return nil })
	if err == nil || err.Error() != "invalid_parameters" {
		t.Fatalf("err = %v", err)
	}
}
