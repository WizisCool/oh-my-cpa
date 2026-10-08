package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"reflect"
	"strings"
	"testing"

	"github.com/oh-my-cpa/oh-my-cpa/internal/capability"
	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/gateway"
)

func sourceFixtureTrace() Trace {
	return Trace{ID: "call_usage", Name: "usage_aggregate", Result: capability.Result{
		Status: "success", OperationID: "operation_usage",
		Data: json.RawMessage(`{"from_ms":100,"to_ms":200,"data":{"groups":[{"key":"provider","requests":12,"nested":{"value":7}}]}}`),
	}}
}

func TestDataReferencesDescribeStableSelectableRows(t *testing.T) {
	trace := sourceFixtureTrace()
	sources := findTraceDataSources(trace)
	if len(sources) != 1 || sources[0].CallID != trace.ID || sources[0].Path != "data.groups" || sources[0].Rows != 1 || !reflect.DeepEqual(sources[0].Fields, []string{"key", "requests"}) {
		t.Fatalf("sources: %+v", sources)
	}
	if next := findTraceDataSources(trace); !reflect.DeepEqual(sources, next) {
		t.Fatal("references are not stable")
	}
	conversation := &Conversation{Turns: []Turn{{Traces: []Trace{trace}}}}
	result, raw := renderDisplay(conversation, RENDER_UI, canvasCall(fmt.Sprintf(`{"data_ref":%q}`, sources[0].DataRef), `["key","requests"]`))
	var view View
	if result.Status != "success" || json.Unmarshal(raw, &view) != nil || view.Rows[0]["requests"] != float64(12) || view.Source.CallID != trace.ID || view.Source.DataRef != sources[0].DataRef {
		t.Fatalf("result %+v view %s", result, raw)
	}
	for name, source := range map[string]string{
		"foreign conversation": fmt.Sprintf(`{"data_ref":%q}`, createDataReferenceID("foreign", "data.groups")),
		"operation conflict":   fmt.Sprintf(`{"data_ref":%q,"call_id":"operation_usage"}`, sources[0].DataRef),
		"path conflict":        fmt.Sprintf(`{"data_ref":%q,"path":"data.data.groups"}`, sources[0].DataRef),
		"invalid handle":       `{"data_ref":"made-up"}`,
	} {
		if result, raw := renderDisplay(conversation, RENDER_UI, canvasCall(source, `["key"]`)); result.Status != "error" || raw != nil || result.Detail == "" {
			t.Errorf("%s: %+v", name, result)
		}
	}
}

func TestDataReferencesHandleSQLAndBoundMetadata(t *testing.T) {
	for _, data := range []string{
		`{"columns":["model","requests"],"rows":[["m",1]]}`,
		`{"columns":["model","requests"],"rows":[]}`,
	} {
		sources := findTraceDataSources(Trace{ID: "sql", Name: "database_query", Result: capability.Result{Status: "success", Data: json.RawMessage(data)}})
		if len(sources) != 1 || sources[0].Path != "rows" || !reflect.DeepEqual(sources[0].Fields, []string{"model", "requests"}) {
			t.Fatalf("SQL sources: %+v", sources)
		}
	}
	for _, trace := range []Trace{
		{ID: "sql", Name: "database_query", Result: capability.Result{Status: "success", Data: json.RawMessage(`{"columns":["m","n"],"rows":[[1]]}`)}},
		{ID: "pending", Name: "usage_aggregate", Result: capability.Result{Status: "pending", Data: json.RawMessage(`[{"m":1}]`)}},
		{ID: "error", Name: "usage_aggregate", Result: capability.Result{Status: "error", Data: json.RawMessage(`[{"m":1}]`)}},
		{ID: "canvas", Name: RENDER_UI, Result: capability.Result{Status: "success", Data: json.RawMessage(`[{"m":1}]`)}},
		{ID: "retired", Name: "render_chart", Result: capability.Result{Status: "success", Data: json.RawMessage(`[{"m":1}]`)}},
	} {
		if sources := findTraceDataSources(trace); len(sources) != 0 {
			t.Errorf("invalid source advertised: %+v", sources)
		}
	}
	groups := map[string]any{}
	for index := 0; index < MAX_DATA_SOURCES+10; index++ {
		groups[fmt.Sprintf("group_%02d", index)] = []map[string]any{{"name": "sensitive row value", "requests": index}}
	}
	data, _ := json.Marshal(groups)
	trace := Trace{ID: "many", Name: "fixture", Result: capability.Result{Status: "success", Data: data}}
	sources := findTraceDataSources(trace)
	raw, _ := json.Marshal(sources)
	if len(sources) != MAX_DATA_SOURCES || sources[0].Path != "group_00" || strings.Contains(string(raw), "sensitive row value") {
		t.Fatalf("unbounded or value-bearing metadata: %s", raw)
	}
	oversized := make([]map[string]any, MAX_VIEW_ROWS+1)
	for index := range oversized {
		oversized[index] = map[string]any{"requests": index}
	}
	trace.Result.Data, _ = json.Marshal(oversized)
	if len(findTraceDataSources(trace)) != 0 {
		t.Fatal("an oversized source was advertised as renderable")
	}
}

func TestCanvasErrorsExplainSessionFailureModes(t *testing.T) {
	trace := sourceFixtureTrace()
	conversation := &Conversation{Turns: []Turn{{Traces: []Trace{trace}}}}
	for name, test := range map[string]struct{ arguments, detail string }{
		"nested fields":    {`{"title":"usage","html":"<div></div>","source":{"call_id":"call_usage","fields":["requests"]}}`, "put fields at the top level"},
		"operation id":     {canvasCall(`{"call_id":"operation_usage","path":"data.groups"}`, `["requests"]`), `tool-call id is "call_usage"`},
		"envelope path":    {canvasCall(`{"call_id":"call_usage","path":"data.data.groups"}`, `["requests"]`), "path starts inside result.data"},
		"wrong field type": {canvasCall(`{"call_id":"call_usage","path":"data.groups"}`, `[123]`), "arguments.fields[0] must have type string"},
		"missing html":     {`{"title":"usage"}`, "arguments.html is required"},
		"html type":        {`{"title":"usage","html":{"private":"never echo this value"}}`, "arguments.html must have type string"},
	} {
		result, view := renderDisplay(conversation, RENDER_UI, test.arguments)
		if result.Status != "error" || view != nil || !strings.Contains(result.Detail, test.detail) || strings.Contains(result.Detail, "never echo this value") {
			t.Errorf("%s: %+v", name, result)
		}
	}
	failure := Trace{ID: "bad", Name: RENDER_UI, Result: capability.Result{Status: "error", Code: "invalid_tool_arguments", Detail: "fields must be top-level"}}
	conversation.Turns[0].Traces = append(conversation.Turns[0].Traces, failure, failure)
	raw, err := buildModelToolResult(conversation, failure)
	if err != nil || !strings.Contains(string(raw), `"data_sources"`) || !strings.Contains(string(raw), `"recovery"`) || strings.Contains(string(raw), `"key":"provider"`) {
		t.Fatalf("repair feedback %s: %v", raw, err)
	}
}

func TestRuntimeKeepsReferencesPrivateAndUsesThemAfterCompaction(t *testing.T) {
	runtime := newTestRuntime(t)
	executions := 0
	type fixtureData struct {
		Items []map[string]any `json:"items"`
	}
	if err := capability.Register(runtime.Executor.Registry, capability.Metadata{Name: "fixture_rows", Description: "Rows", Version: 1, Permission: "read", Risk: "low", Adapters: []string{"agent"}}, nil, func(context.Context, struct{}, string, string) (fixtureData, error) {
		executions++
		return fixtureData{Items: []map[string]any{{"key": "provider", "requests": 12, "note": "private-value-only-in-raw-result"}}}, nil
	}); err != nil {
		t.Fatal(err)
	}
	rounds := 0
	var reference DataReference
	runtime.Client = func(context.Context, string) (ModelClient, error) {
		return modelFunc(func(_ context.Context, _ string, messages []gateway.AgentMessage, _ []gateway.AgentTool, _ func(gateway.Event) error) (gateway.AgentReply, error) {
			rounds++
			switch rounds {
			case 1:
				return gateway.AgentReply{Calls: []gateway.ToolCall{{ID: "call_rows", Type: "function", Function: gateway.ToolFunction{Name: "fixture_rows", Arguments: `{}`}}}}, nil
			case 2:
				var result struct {
					DataSources []DataReference `json:"data_sources"`
				}
				if err := json.Unmarshal([]byte(messages[len(messages)-1].Content), &result); err != nil || len(result.DataSources) != 1 {
					t.Fatalf("model result: %+v, %v, %s", result, err, messages[len(messages)-1].Content)
				}
				reference = result.DataSources[0]
				return gateway.AgentReply{Content: "Twelve requests in the recorded window."}, nil
			case 3:
				serialized, _ := json.Marshal(messages)
				if strings.Contains(string(serialized), "private-value-only-in-raw-result") || strings.Contains(string(serialized), `"role":"tool"`) || !strings.Contains(string(serialized), reference.DataRef) {
					t.Fatalf("completed raw history was replayed or provenance lost: %s", serialized)
				}
				return gateway.AgentReply{Calls: []gateway.ToolCall{{ID: "draw", Type: "function", Function: gateway.ToolFunction{Name: RENDER_UI, Arguments: canvasCall(fmt.Sprintf(`{"data_ref":%q}`, reference.DataRef), `["key","requests"]`)}}}}, nil
			default:
				return gateway.AgentReply{Content: "Here is the same recorded data."}, nil
			}
		}), nil
	}
	for _, message := range []string{"count", "plot the same result"} {
		current, err := runtime.Current(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		if err := runtime.Run(context.Background(), Input{ConversationID: current.ID, Revision: current.Revision, Message: message, Model: "fixture", Fingerprint: "key", DisplayTools: []string{RENDER_UI}}, func(event Event) error {
			if event.Type == "tool_result" && strings.Contains(event.Content, "data_sources") {
				t.Fatal("private source metadata leaked into console events")
			}
			return nil
		}); err != nil {
			t.Fatal(err)
		}
	}
	conversation, err := runtime.Current(context.Background())
	if err != nil || executions != 1 || rounds != 4 || conversation.Turns[1].Traces[0].Result.Status != "success" || !strings.Contains(string(conversation.Turns[1].Traces[0].View), `"requests":12`) {
		t.Fatalf("compacted follow-up: %+v executions %d rounds %d error %v", conversation, executions, rounds, err)
	}
	if !strings.Contains(conversation.Turns[0].Messages[2].Content, "private-value-only-in-raw-result") {
		t.Fatal("compaction altered authoritative stored messages")
	}
}

func TestCompletedHistoryPreservesOperationRefusalsAndImages(t *testing.T) {
	turn := Turn{User: "change it", Reply: "The operation was declined.", Images: []gateway.AgentImage{{ID: "image"}}, Traces: []Trace{
		{Name: "fixture_write", Result: capability.Result{Status: "rejected", OperationID: "operation_declined"}},
		{Name: "fixture_write", Result: capability.Result{Status: "uncertain", OperationID: "operation_unknown"}},
	}}
	messages := buildCompletedTurnMessages(turn, nil)
	raw, _ := json.Marshal(messages)
	if len(messages[0].Images) != 1 || !strings.Contains(string(raw), "operation_declined") || !strings.Contains(string(raw), "uncertain") {
		t.Fatalf("safety evidence or image lost: %s", raw)
	}
}

// A turn that settled badly still tells the next question what it did: a write that ran before the
// upstream failed, before a Stop, or before the run was found stale must not vanish from the
// history, or the model can propose the same change again and never answer "did it apply?".
func TestCompletedHistoryCarriesTheWritesOfAnUnsuccessfulTurn(t *testing.T) {
	for _, status := range []string{"error", "interrupted"} {
		t.Run(status, func(t *testing.T) {
			runtime := newTestRuntime(t)
			if err := capability.Register(runtime.Executor.Registry, capability.Metadata{Name: "fixture_write", Description: "Write", Version: 1, Permission: "write", Risk: "low", Adapters: []string{"agent"}}, nil, func(context.Context, struct{}, string, string) (struct{}, error) {
				return struct{}{}, nil
			}); err != nil {
				t.Fatal(err)
			}
			conversation := &Conversation{ID: "conversation", Model: "fixture", Fingerprint: "key", Turns: []Turn{
				{ID: "previous", User: "disable the provider", Reply: "It is disabled.", Status: status, Traces: []Trace{
					{ID: "write", Name: "fixture_write", Result: capability.Result{Status: "success", OperationID: "operation_done"}},
				}},
			}}
			if err := runtime.save(context.Background(), conversation); err != nil {
				t.Fatal(err)
			}
			var sent []gateway.AgentMessage
			runtime.Client = func(context.Context, string) (ModelClient, error) {
				return modelFunc(func(_ context.Context, _ string, messages []gateway.AgentMessage, _ []gateway.AgentTool, _ func(gateway.Event) error) (gateway.AgentReply, error) {
					sent = messages
					return gateway.AgentReply{Content: "It was applied."}, nil
				}), nil
			}
			if err := runtime.Run(context.Background(), Input{ConversationID: conversation.ID, Revision: conversation.Revision, Message: "did it apply?", Model: "fixture", Fingerprint: "key"}, func(Event) error { return nil }); err != nil {
				t.Fatal(err)
			}
			raw, _ := json.Marshal(sent)
			if !strings.Contains(string(raw), "operation_done") || !strings.Contains(string(raw), "disable the provider") {
				t.Fatalf("a %s turn's write was dropped from later context: %s", status, raw)
			}
		})
	}
}

func TestCompletedHistoryPrioritizesDisplayedSourcesAndBoundsOutcomes(t *testing.T) {
	trace := sourceFixtureTrace()
	turn := Turn{User: "count", Reply: "Twelve requests.", Traces: []Trace{trace}}
	view, _ := json.Marshal(View{Source: &DataSource{CallID: trace.ID, Path: "data.groups"}})
	turn.Traces = append(turn.Traces, Trace{Name: RENDER_UI, Result: capability.Result{Status: "success"}, View: view})
	for index := 0; index < MAX_DATA_SOURCES+3; index++ {
		other := sourceFixtureTrace()
		other.ID = fmt.Sprintf("other_%d", index)
		turn.Traces = append(turn.Traces, other, Trace{Name: "fixture_write", Result: capability.Result{Status: "uncertain", OperationID: fmt.Sprintf("operation_%d", index)}})
	}
	messages := buildCompletedTurnMessages(turn, nil)
	if !strings.Contains(messages[1].Content, createDataReferenceID(trace.ID, "data.groups")) || !strings.Contains(messages[1].Content, `"has_omitted_outcomes":true`) || strings.Count(messages[1].Content, `"operation_id"`) != MAX_DATA_SOURCES {
		t.Fatalf("unbounded outcomes or displayed source lost: %s", messages[1].Content)
	}
}
