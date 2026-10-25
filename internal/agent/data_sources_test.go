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
	runtime := newTestRuntime(t)
	if err := runtime.save(context.Background(), &Conversation{ID: "conversation", Turns: []Turn{{Traces: []Trace{trace}}}}); err != nil {
		t.Fatal(err)
	}
	rows, err := runtime.ReadDataRows(context.Background(), sources[0].DataRef)
	raw, _ := json.Marshal(rows)
	if err != nil || string(raw) != `{"rows":[{"key":"provider","requests":12}],"fields":["key","requests"]}` {
		t.Fatalf("rows %s: %v", raw, err)
	}
	for name, reference := range map[string]string{
		"foreign conversation": createDataReferenceID("foreign", "data.groups"),
		"invalid handle":       "made-up",
	} {
		if _, err := runtime.ReadDataRows(context.Background(), reference); capability.ErrorDetail(err) == "" {
			t.Errorf("%s: %v", name, err)
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
		{ID: "presented", Name: PRESENT_OPENUI, Result: capability.Result{Status: "success", Data: json.RawMessage(`[{"m":1}]`)}},
		{ID: "canvas", Name: "render_ui", Result: capability.Result{Status: "success", Data: json.RawMessage(`[{"m":1}]`)}},
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

// TestDataRowsReadPositionalSQLRowsByTheirColumns: a SQL result's rows are arrays beside a column
// list, and an interface reads them by column name like any other rows.
func TestDataRowsReadPositionalSQLRowsByTheirColumns(t *testing.T) {
	trace := Trace{ID: "sql", Name: "database_query", Result: capability.Result{Status: "success", Data: json.RawMessage(`{"columns":["model","requests"],"rows":[["m",1],["n",2]]}`)}}
	runtime := newTestRuntime(t)
	if err := runtime.save(context.Background(), &Conversation{ID: "conversation", Turns: []Turn{{Traces: []Trace{trace}}}}); err != nil {
		t.Fatal(err)
	}
	rows, err := runtime.ReadDataRows(context.Background(), findTraceDataSources(trace)[0].DataRef)
	raw, _ := json.Marshal(rows)
	if err != nil || string(raw) != `{"rows":[{"model":"m","requests":1},{"model":"n","requests":2}],"fields":["model","requests"]}` {
		t.Fatalf("rows %s: %v", raw, err)
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
				program := fmt.Sprintf("root = Card([chart])\nusage = Query(\"data_rows\", {data_ref: \"%s\"}, {rows: []})\nchart = BarChart(usage.rows.key, [Series(\"Requests\", usage.rows.requests)])", reference.DataRef)
				arguments, _ := json.Marshal(OpenUIInput{UI: program})
				return gateway.AgentReply{Calls: []gateway.ToolCall{{ID: "draw", Type: "function", Function: gateway.ToolFunction{Name: PRESENT_OPENUI, Arguments: string(arguments)}}}}, nil
			default:
				t.Fatal("a presented answer was followed by another round")
				return gateway.AgentReply{}, nil
			}
		}), nil
	}
	for _, message := range []string{"count", "plot the same result"} {
		current, err := runtime.Current(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		if err := runtime.Run(context.Background(), Input{ConversationID: current.ID, Revision: current.Revision, Message: message, Model: "fixture", Fingerprint: "key", DisplayTools: []string{PRESENT_OPENUI}}, func(event Event) error {
			if event.Type == "tool_result" && strings.Contains(event.Content, "data_sources") {
				t.Fatal("private source metadata leaked into console events")
			}
			return nil
		}); err != nil {
			t.Fatal(err)
		}
	}
	conversation, err := runtime.Current(context.Background())
	if err != nil || executions != 1 || rounds != 3 || conversation.Turns[1].Status != "success" || conversation.Turns[1].Traces[0].Result.Status != "success" || !strings.Contains(conversation.Turns[1].Traces[0].Arguments, reference.DataRef) {
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

// TestCompletedHistoryReplaysPresentedInterfacesAndBoundsOutcomes: a settled turn's interface is
// replayed as the call it was, with its result, and the reference it reads is kept ahead of the
// others when the list is cut.
func TestCompletedHistoryReplaysPresentedInterfacesAndBoundsOutcomes(t *testing.T) {
	trace := sourceFixtureTrace()
	reference := createDataReferenceID(trace.ID, "data.groups")
	turn := Turn{User: "count", Traces: []Trace{}}
	for index := 0; index < MAX_DATA_SOURCES+3; index++ {
		other := sourceFixtureTrace()
		other.ID = fmt.Sprintf("other_%d", index)
		turn.Traces = append(turn.Traces, other, Trace{Name: "fixture_write", Result: capability.Result{Status: "uncertain", OperationID: fmt.Sprintf("operation_%d", index)}})
	}
	program, _ := json.Marshal(OpenUIInput{UI: "root = Card([t])\nrows = Query(\"data_rows\", {data_ref: \"" + reference + "\"}, {rows: []})\nt = TextContent(\"Twelve\")"})
	turn.Traces = append(turn.Traces, trace, Trace{ID: "answer", Name: PRESENT_OPENUI, Arguments: string(program), Result: capability.Result{Status: "success", Data: json.RawMessage(`{"displayed":true}`)}})
	messages := buildCompletedTurnMessages(turn, nil)
	if len(messages) != 3 || len(messages[1].ToolCalls) != 1 || messages[1].ToolCalls[0].Function.Arguments != string(program) || messages[2].Role != "tool" || messages[2].ToolCallID != "answer" {
		t.Fatalf("presented interface not replayed as its call: %+v", messages)
	}
	if !strings.Contains(messages[1].Content, `"data_sources":[{"data_ref":"`+reference) || !strings.Contains(messages[1].Content, `"has_omitted_outcomes":true`) || strings.Count(messages[1].Content, `"operation_id"`) != MAX_DATA_SOURCES {
		t.Fatalf("unbounded outcomes or the interface's source lost: %s", messages[1].Content)
	}
}
