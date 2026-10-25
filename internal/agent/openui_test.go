package agent

import (
	"context"
	"encoding/json"
	"slices"
	"strings"
	"testing"

	"github.com/oh-my-cpa/oh-my-cpa/internal/capability"
	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/gateway"
)

func openUICall(id, name, program string) gateway.ToolCall {
	arguments, _ := json.Marshal(OpenUIInput{UI: program})
	return gateway.ToolCall{ID: id, Type: "function", Function: gateway.ToolFunction{Name: name, Arguments: string(arguments)}}
}

func toolNames(tools []gateway.AgentTool) []string {
	names := make([]string, 0, len(tools))
	for _, tool := range tools {
		names = append(names, tool.Function.Name)
	}
	return names
}

func runOnce(t *testing.T, runtime *Runtime, input Input) Conversation {
	t.Helper()
	current, err := runtime.Current(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	input.ConversationID, input.Revision, input.Model, input.Fingerprint = current.ID, current.Revision, "fixture", "key"
	if err := runtime.Run(context.Background(), input, func(Event) error { return nil }); err != nil {
		t.Fatal(err)
	}
	conversation, err := runtime.Current(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	return conversation
}

// TestOpenUIToolsFollowTheConsoleAndThePresentation: the OpenUI tools are offered to a console that
// renders them, and withdrawn - prompt_openui included - from a console that declared nothing and
// from a turn the operator asked for as text, so the model is never handed a tool it was told
// nothing about.
func TestOpenUIToolsFollowTheConsoleAndThePresentation(t *testing.T) {
	for name, test := range map[string]struct {
		input  Input
		offers bool
	}{
		"openui console": {Input{Message: "q", DisplayTools: openUIConsole}, true},
		"undeclared":     {Input{Message: "q"}, false},
		"text":           {Input{Message: "q", DisplayTools: openUIConsole, Present: PRESENT_TEXT}, false},
	} {
		t.Run(name, func(t *testing.T) {
			runtime := newTestRuntime(t)
			if err := RegisterPromptOpenUI(runtime.Executor.Registry); err != nil {
				t.Fatal(err)
			}
			var offered []string
			runtime.Client = func(context.Context, string) (ModelClient, error) {
				return modelFunc(func(_ context.Context, _ string, _ []gateway.AgentMessage, tools []gateway.AgentTool, _ func(gateway.Event) error) (gateway.AgentReply, error) {
					offered = toolNames(tools)
					return gateway.AgentReply{Content: "ok"}, nil
				}), nil
			}
			runOnce(t, runtime, test.input)
			if slices.Contains(offered, PRESENT_OPENUI) != test.offers || slices.Contains(offered, PROMPT_OPENUI) != test.offers {
				t.Fatalf("offered %v", offered)
			}
		})
	}
	runtime := newTestRuntime(t)
	current, _ := runtime.Current(context.Background())
	for _, present := range []string{"ui", "canvas", "markdown"} {
		err := runtime.Run(context.Background(), Input{ConversationID: current.ID, Revision: current.Revision, Message: "q", Model: "fixture", Fingerprint: "key", DisplayTools: openUIConsole, Present: present}, func(Event) error { return nil })
		if err == nil || err.Error() != "invalid_parameters" {
			t.Errorf("retired presentation %q accepted: %v", present, err)
		}
	}
}

// TestPresentedAnswerEndsTheTurn: a round that only presents an interface is the answer, so no
// further round runs; a round that also read something, or whose program was refused, goes back to
// the model with the results.
func TestPresentedAnswerEndsTheTurn(t *testing.T) {
	program := "root = Card([t])\nt = TextContent(\"Twelve requests\")"
	for name, test := range map[string]struct {
		first  []gateway.ToolCall
		rounds int
	}{
		"presentation alone": {[]gateway.ToolCall{openUICall("answer", PRESENT_OPENUI, program)}, 1},
		"beside a read":      {[]gateway.ToolCall{{ID: "read", Type: "function", Function: gateway.ToolFunction{Name: "fixture_read", Arguments: `{}`}}, openUICall("answer", PRESENT_OPENUI, program)}, 2},
		"refused program":    {[]gateway.ToolCall{openUICall("answer", PRESENT_OPENUI, "  ")}, 2},
	} {
		t.Run(name, func(t *testing.T) {
			runtime := newTestRuntime(t)
			if err := capability.Register(runtime.Executor.Registry, capability.Metadata{Name: "fixture_read", Description: "Read", Version: 1, Permission: "read", Risk: "low", Adapters: []string{"agent"}}, nil, func(context.Context, struct{}, string, string) (struct{}, error) {
				return struct{}{}, nil
			}); err != nil {
				t.Fatal(err)
			}
			rounds := 0
			runtime.Client = func(context.Context, string) (ModelClient, error) {
				return modelFunc(func(_ context.Context, _ string, messages []gateway.AgentMessage, _ []gateway.AgentTool, _ func(gateway.Event) error) (gateway.AgentReply, error) {
					rounds++
					if rounds == 1 {
						return gateway.AgentReply{Calls: test.first}, nil
					}
					return gateway.AgentReply{Content: messages[len(messages)-1].Content}, nil
				}), nil
			}
			conversation := runOnce(t, runtime, Input{Message: "how many?", DisplayTools: openUIConsole})
			turn := conversation.Turns[0]
			if rounds != test.rounds || turn.Status != "success" {
				t.Fatalf("rounds %d status %s", rounds, turn.Status)
			}
			answer := turn.Traces[len(turn.Traces)-1]
			if test.rounds == 1 && (string(answer.Result.Data) != `{"displayed":true}` || !strings.Contains(answer.Arguments, "Twelve requests")) {
				t.Fatalf("presented answer %+v", answer)
			}
			if name == "refused program" && (answer.Result.Status != "error" || !strings.Contains(answer.Result.Detail, "OpenUI Lang program")) {
				t.Fatalf("refusal %+v", answer.Result)
			}
		})
	}
}

// TestPromptOpenUIWaitsForTheSubmittedForm: prompt_openui stops the turn on the operator like any
// question; the form's submission is checked and becomes the call's result, and the turn goes on.
func TestPromptOpenUIWaitsForTheSubmittedForm(t *testing.T) {
	runtime := newTestRuntime(t)
	if err := RegisterPromptOpenUI(runtime.Executor.Registry); err != nil {
		t.Fatal(err)
	}
	rounds := 0
	var resumed string
	runtime.Client = func(context.Context, string) (ModelClient, error) {
		return modelFunc(func(_ context.Context, _ string, messages []gateway.AgentMessage, _ []gateway.AgentTool, _ func(gateway.Event) error) (gateway.AgentReply, error) {
			rounds++
			if rounds == 1 {
				return gateway.AgentReply{Calls: []gateway.ToolCall{openUICall("form", PROMPT_OPENUI, "root = Card([f])\nf = Form(\"window\", b, [])\nb = Buttons([Button(\"Go\")])")}}, nil
			}
			resumed = messages[len(messages)-1].Content
			return gateway.AgentReply{Content: "Using the last 7 days."}, nil
		}), nil
	}
	conversation := runOnce(t, runtime, Input{Message: "usage", DisplayTools: openUIConsole})
	turn := conversation.Turns[0]
	if turn.Status != "pending" || turn.Traces[0].Result.Status != "pending" {
		t.Fatalf("the form did not wait: %+v", turn)
	}
	operationID := turn.Traces[0].Result.OperationID
	for _, invalid := range []string{`{"type":"open_url","message":"x","params":{}}`, `{"type":"continue_conversation","message":"","params":{}}`, `{"type":"continue_conversation","message":"x","params":{},"extra":1}`} {
		if _, err := runtime.Executor.Decide(context.Background(), PRINCIPAL, operationID, true, invalid); err == nil {
			t.Errorf("accepted %s", invalid)
		}
	}
	submitted := `{"type":"continue_conversation","message":"Last 7 days","params":{},"formName":"window","formState":{"days":{"value":"7","componentType":"select"}}}`
	if _, err := runtime.Executor.Decide(context.Background(), PRINCIPAL, operationID, true, submitted); err != nil {
		t.Fatal(err)
	}
	conversation = runOnce(t, runtime, Input{Resume: []string{operationID}, DisplayTools: openUIConsole})
	if conversation.Turns[0].Status != "success" || rounds != 2 || !strings.Contains(resumed, `"message":"Last 7 days"`) || !strings.Contains(resumed, `"formName":"window"`) {
		t.Fatalf("the submission did not reach the model: %s", resumed)
	}
}
