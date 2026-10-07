package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"slices"
	"strings"
	"testing"

	"github.com/oh-my-cpa/oh-my-cpa/internal/capability"
	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/gateway"
)

func displayConversation() *Conversation {
	rows := make([]map[string]any, 0, 3)
	for day := 1; day <= 3; day++ {
		rows = append(rows, map[string]any{"day": fmt.Sprintf("2026-09-0%d", day), "requests": day * 10, "model": "m", "nested": map[string]any{"x": 1}})
	}
	data, _ := json.Marshal(map[string]any{"series": map[string]any{"points": rows}, "total": 60})
	return &Conversation{Turns: []Turn{{Traces: []Trace{
		{ID: "usage", Name: "usage_aggregate", Result: capability.Result{Status: "success", Data: data}},
		{ID: "failed", Name: "usage_aggregate", Result: capability.Result{Status: "error", Code: "timeout"}},
		{ID: "chart", Name: RENDER_CHART, Result: capability.Result{Status: "success", Data: json.RawMessage(`{"rendered":true,"rows":0,"fields":[]}`)}},
	}}}}
}

// TestDisplayFreezesTheReferencedRows: the chart's rows are the capability's rows, projected to the
// named fields, and the model receives only a receipt.
func TestDisplayFreezesTheReferencedRows(t *testing.T) {
	result, raw := renderDisplay(displayConversation(), RENDER_CHART, `{"title":"Requests per day, last 3 days","type":"column","source":{"call_id":"usage","path":"series.points"},"x":"day","y":["requests"],"unit":"requests"}`)
	if result.Status != "success" {
		t.Fatalf("result %+v", result)
	}
	var receipt DisplayReceipt
	if err := json.Unmarshal(result.Data, &receipt); err != nil || !receipt.IsRendered || receipt.Rows != 3 || strings.Join(receipt.Fields, ",") != "day,requests" {
		t.Fatalf("receipt %s", result.Data)
	}
	if strings.Contains(string(result.Data), "2026-09-01") {
		t.Fatal("the model received the rows it referenced")
	}
	var view View
	if err := json.Unmarshal(raw, &view); err != nil {
		t.Fatal(err)
	}
	if view.Kind != "chart" || view.Chart.Type != "column" || len(view.Rows) != 3 || view.Rows[2]["requests"] != float64(30) || view.Rows[0]["model"] != nil || view.Source.CallID != "usage" {
		t.Fatalf("view %s", raw)
	}
}

// TestDisplayReadsPositionalRowsByTheirColumns: a SQL result's rows are arrays beside a column list,
// and a chart references them by column name like any other rows. Rows that do not line up with
// the column list are still refused rather than guessed at.
func TestDisplayReadsPositionalRowsByTheirColumns(t *testing.T) {
	conversation := &Conversation{Turns: []Turn{{Traces: []Trace{
		{ID: "sql", Name: "database_query", Result: capability.Result{Status: "success", Data: json.RawMessage(`{"columns":["model","requests"],"rows":[["a",12],["b",30]],"is_truncated":false}`)}},
		{ID: "ragged", Name: "database_query", Result: capability.Result{Status: "success", Data: json.RawMessage(`{"columns":["model","requests"],"rows":[["a",12],["b"]]}`)}},
	}}}}
	result, raw := renderDisplay(conversation, RENDER_CHART, `{"title":"Requests by model","type":"bar","source":{"call_id":"sql","path":"rows"},"x":"model","y":["requests"]}`)
	var view View
	if result.Status != "success" || json.Unmarshal(raw, &view) != nil || len(view.Rows) != 2 || view.Rows[1]["model"] != "b" || view.Rows[1]["requests"] != float64(30) {
		t.Fatalf("result %+v view %s", result, raw)
	}
	result, _ = renderDisplay(conversation, RENDER_TABLE, `{"title":"Ragged","source":{"call_id":"ragged","path":"rows"},"columns":["model"]}`)
	if result.Status != "error" || result.Code != "invalid_tool_arguments" {
		t.Fatalf("ragged rows were drawn: %+v", result)
	}
}

func TestDisplayTableAcceptsInlineRows(t *testing.T) {
	result, raw := renderDisplay(displayConversation(), RENDER_TABLE, `{"title":"Derived shares","inline":[{"name":"a","share":0.25},{"name":"b","share":0.75}],"columns":["name","share"]}`)
	if result.Status != "success" || !strings.Contains(string(raw), `"share":0.75`) || !strings.Contains(string(raw), `"kind":"table"`) {
		t.Fatalf("result %+v view %s", result, raw)
	}
}

// TestDisplayRefusesAReferenceItCannotHonour lists every reference the server must not draw. Each
// refusal is an ordinary error result with a detail the model can act on.
func TestDisplayRefusesAReferenceItCannotHonour(t *testing.T) {
	many := make([]string, 0, MAX_INLINE_ROWS+1)
	for index := 0; index <= MAX_INLINE_ROWS; index++ {
		many = append(many, `{"a":1}`)
	}
	cases := map[string]string{
		"unknown call":   `{"title":"t","type":"line","source":{"call_id":"missing"},"x":"day","y":["requests"]}`,
		"failed call":    `{"title":"t","type":"line","source":{"call_id":"failed"},"x":"day","y":["requests"]}`,
		"display source": `{"title":"t","type":"line","source":{"call_id":"chart"},"x":"day","y":["requests"]}`,
		"not an array":   `{"title":"t","type":"line","source":{"call_id":"usage","path":"total"},"x":"day","y":["requests"]}`,
		"bad path":       `{"title":"t","type":"line","source":{"call_id":"usage","path":"series.missing"},"x":"day","y":["requests"]}`,
		"root object":    `{"title":"t","type":"line","source":{"call_id":"usage"},"x":"day","y":["requests"]}`,
		"missing field":  `{"title":"t","type":"line","source":{"call_id":"usage","path":"series.points"},"x":"day","y":["tokens"]}`,
		"nested field":   `{"title":"t","type":"line","source":{"call_id":"usage","path":"series.points"},"x":"day","y":["nested"]}`,
		"non-numeric y":  `{"title":"t","type":"line","source":{"call_id":"usage","path":"series.points"},"x":"requests","y":["day"]}`,
		"unknown type":   `{"title":"t","type":"radar","source":{"call_id":"usage","path":"series.points"},"x":"day","y":["requests"]}`,
		"pie two y":      `{"title":"t","type":"pie","source":{"call_id":"usage","path":"series.points"},"x":"day","y":["requests","requests2"]}`,
		"both sources":   `{"title":"t","type":"line","source":{"call_id":"usage","path":"series.points"},"inline":[{"day":"x","requests":1}],"x":"day","y":["requests"]}`,
		"no source":      `{"title":"t","type":"line","x":"day","y":["requests"]}`,
		"blank title":    `{"title":" ","type":"line","source":{"call_id":"usage","path":"series.points"},"x":"day","y":["requests"]}`,
		"unknown field":  `{"title":"t","type":"line","source":{"call_id":"usage","path":"series.points"},"x":"day","y":["requests"],"color":"red"}`,
		"inline budget":  `{"title":"t","type":"line","inline":[` + strings.Join(many, ",") + `],"x":"a","y":["a2"]}`,
	}
	for name, arguments := range cases {
		result, view := renderDisplay(displayConversation(), RENDER_CHART, arguments)
		if result.Status != "error" || view != nil || result.Code == "" {
			t.Errorf("%s: %+v", name, result)
		}
	}
	rows := make([]map[string]any, MAX_VIEW_ROWS+1)
	for index := range rows {
		rows[index] = map[string]any{"a": index}
	}
	data, _ := json.Marshal(rows)
	conversation := &Conversation{Turns: []Turn{{Traces: []Trace{{ID: "big", Name: "x", Result: capability.Result{Status: "success", Data: data}}}}}}
	if result, _ := renderDisplay(conversation, RENDER_TABLE, `{"title":"t","source":{"call_id":"big"},"columns":["a"]}`); result.Status != "error" || !strings.Contains(result.Detail, "aggregate") {
		t.Fatalf("row budget %+v", result)
	}
}

// TestRuntimeOffersDisplayToolsOnlyWhenDeclared: the model sees render_chart only on a run whose
// console declared it, and a declared display call is resolved without the executor.
func TestRuntimeOffersDisplayToolsOnlyWhenDeclared(t *testing.T) {
	runtime := newTestRuntime(t)
	if err := capability.Register(runtime.Executor.Registry, capability.Metadata{Name: "fixture_rows", Description: "fixture", Version: 1, Permission: "read", Risk: "low", Adapters: []string{"agent"}}, nil, func(context.Context, struct{}, string, string) (struct {
		Items []map[string]any `json:"items"`
	}, error) {
		return struct {
			Items []map[string]any `json:"items"`
		}{Items: []map[string]any{{"day": "d1", "count": 3}}}, nil
	}); err != nil {
		t.Fatal(err)
	}
	var offered [][]string
	rounds := 0
	runtime.Client = func(context.Context, string) (ModelClient, error) {
		return modelFunc(func(_ context.Context, _ string, messages []gateway.AgentMessage, tools []gateway.AgentTool, _ func(gateway.Event) error) (gateway.AgentReply, error) {
			rounds++
			names := []string{}
			for _, tool := range tools {
				names = append(names, tool.Function.Name)
			}
			offered = append(offered, names)
			switch rounds {
			case 1:
				return gateway.AgentReply{Calls: []gateway.ToolCall{{ID: "rows", Type: "function", Function: gateway.ToolFunction{Name: "fixture_rows", Arguments: `{}`}}}}, nil
			case 2:
				return gateway.AgentReply{Calls: []gateway.ToolCall{{ID: "draw", Type: "function", Function: gateway.ToolFunction{Name: RENDER_CHART, Arguments: `{"title":"Count","type":"line","source":{"call_id":"rows","path":"items"},"x":"day","y":["count"]}`}}}}, nil
			}
			if last := messages[len(messages)-1]; last.Role != "tool" || strings.Contains(last.Content, "d1") {
				t.Fatalf("model received %+v", last)
			}
			return gateway.AgentReply{Content: "Flat."}, nil
		}), nil
	}
	var final *Conversation
	if err := runtime.Run(context.Background(), Input{Message: "chart", Model: "fixture", Fingerprint: "key", DisplayTools: []string{RENDER_CHART}}, func(event Event) error {
		if event.Type == "finished" {
			final = event.Conversation
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if strings.Join(offered[0], ",") != "fixture_rows,render_chart" {
		t.Fatalf("offered %v", offered[0])
	}
	draw := final.Turns[0].Traces[1]
	if draw.Result.Status != "success" || !strings.Contains(string(draw.View), `"d1"`) {
		t.Fatalf("display trace %+v", draw)
	}
	runtime2 := newTestRuntime(t)
	runtime2.Client = func(context.Context, string) (ModelClient, error) {
		return modelFunc(func(_ context.Context, _ string, _ []gateway.AgentMessage, tools []gateway.AgentTool, _ func(gateway.Event) error) (gateway.AgentReply, error) {
			for _, tool := range tools {
				if tool.Function.Name == RENDER_CHART {
					t.Fatal("undeclared display tool offered")
				}
			}
			return gateway.AgentReply{Content: "ok"}, nil
		}), nil
	}
	if err := runtime2.Run(context.Background(), Input{Message: "hi", Model: "fixture", Fingerprint: "key"}, func(Event) error { return nil }); err != nil {
		t.Fatal(err)
	}
}

func TestDisplayDeclarationsFitTheirShare(t *testing.T) {
	raw, err := json.Marshal(DisplayToolDeclarations([]string{RENDER_CHART, RENDER_TABLE}))
	if err != nil {
		t.Fatal(err)
	}
	// Display tools ride on the same schema budget as the registry; they are allowed a small,
	// fixed share of it so adding them never pushes a real capability out.
	if len(raw) > 4<<10 {
		t.Fatalf("display declarations are %d bytes", len(raw))
	}
	if !strings.Contains(string(raw), `"enum":["line","area","column","bar","pie"]`) {
		t.Fatalf("chart type is not enumerated: %s", raw)
	}
}

// TestSuggestionsEndTheTurnWithoutBecomingACall: suggest_next beside the final answer is recorded on
// the turn and costs no further model round, no trace and no stored tool call - a stored call
// without a result would make the next turn's history invalid upstream. Offered beside real work,
// it is dropped: the answer it would follow does not exist yet.
func TestSuggestionsEndTheTurnWithoutBecomingACall(t *testing.T) {
	suggest := func(arguments string) gateway.ToolCall {
		return gateway.ToolCall{ID: "next", Type: "function", Function: gateway.ToolFunction{Name: SUGGEST_NEXT, Arguments: arguments}}
	}
	for name, test := range map[string]struct {
		declared []string
		first    []gateway.ToolCall
		rounds   int
		want     []string
	}{
		"beside the answer": {[]string{SUGGEST_NEXT}, []gateway.ToolCall{suggest(`{"suggestions":["  Compare with  last week ","Compare with last week","","By model?"]}`)}, 1, []string{"Compare with last week", "By model?"}},
		"malformed":         {[]string{SUGGEST_NEXT}, []gateway.ToolCall{suggest(`{"suggestions":"all of them"}`)}, 1, nil},
		"too long":          {[]string{SUGGEST_NEXT}, []gateway.ToolCall{suggest(`{"suggestions":["` + strings.Repeat("长", MAX_SUGGESTION_CHARS+1) + `"]}`)}, 1, nil},
		"beside real work":  {[]string{SUGGEST_NEXT, RENDER_TABLE}, []gateway.ToolCall{suggest(`{"suggestions":["Stale?"]}`), {ID: "table", Type: "function", Function: gateway.ToolFunction{Name: RENDER_TABLE, Arguments: `{"title":"t","inline":[{"a":1}],"columns":["a"]}`}}}, 2, nil},
	} {
		t.Run(name, func(t *testing.T) {
			runtime := newTestRuntime(t)
			rounds := 0
			runtime.Client = func(context.Context, string) (ModelClient, error) {
				return modelFunc(func(context.Context, string, []gateway.AgentMessage, []gateway.AgentTool, func(gateway.Event) error) (gateway.AgentReply, error) {
					if rounds++; rounds == 1 {
						return gateway.AgentReply{Content: "answer", Calls: test.first}, nil
					}
					return gateway.AgentReply{Content: "done"}, nil
				}), nil
			}
			var final *Conversation
			if err := runtime.Run(context.Background(), Input{Message: "ask", Model: "fixture", Fingerprint: "key", DisplayTools: test.declared}, func(event Event) error {
				if event.Type == "tool_call" && event.Trace.Name == SUGGEST_NEXT {
					t.Fatal("suggest_next was announced as a call")
				}
				if event.Type == "finished" {
					final = event.Conversation
				}
				return nil
			}); err != nil {
				t.Fatal(err)
			}
			turn := final.Turns[0]
			if rounds != test.rounds || turn.Status != "success" || !slices.Equal(turn.Suggestions, test.want) {
				t.Fatalf("rounds %d status %q suggestions %q", rounds, turn.Status, turn.Suggestions)
			}
			for _, message := range turn.Messages {
				for _, call := range message.ToolCalls {
					if call.Function.Name == SUGGEST_NEXT {
						t.Fatalf("suggest_next was stored as a tool call: %+v", message)
					}
				}
			}
		})
	}
}
