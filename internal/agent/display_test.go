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
	raw, err := json.Marshal(DisplayToolDeclarations([]string{RENDER_CHART, RENDER_TABLE, RENDER_VIEW, RENDER_CANVAS, SUGGEST_NEXT}))
	if err != nil {
		t.Fatal(err)
	}
	// Display tools ride on the same schema budget as the registry; they are allowed a small,
	// fixed share of it so adding them never pushes a real capability out.
	if len(raw) > 8<<10 {
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

// TestPanelKeepsOnlyWhatEachBlockReads: a panel is validated block by block, and a field a block
// type does not read is dropped rather than frozen into the view.
func TestPanelKeepsOnlyWhatEachBlockReads(t *testing.T) {
	result, raw := renderDisplay(displayConversation(), RENDER_VIEW, `{"title":"Last 24 hours","blocks":[
		{"type":"stats","items":[{"label":"Requests","value":"1,204","delta":"+12%","tone":"success","icon":"trending-up","route":"dashboard"}]},
		{"type":"callout","text":"  Two credentials\n are cooling down. ","items":[{"label":"ignored"}]},
		{"type":"steps","items":[{"label":"Check quota","status":"done"},{"label":"Rotate key"}]},
		{"type":"meters","items":[{"label":"Daily budget","value":"$8 of $10","share":0.8,"tone":"warning"}]},
		{"type":"links","items":[{"label":"Open quota","route":"quota","icon":"brand:OpenAI"}]}
	]}`)
	if result.Status != "success" {
		t.Fatalf("result %+v", result)
	}
	var receipt DisplayReceipt
	if err := json.Unmarshal(result.Data, &receipt); err != nil || receipt.Blocks != 5 {
		t.Fatalf("receipt %s", result.Data)
	}
	var view View
	if err := json.Unmarshal(raw, &view); err != nil {
		t.Fatal(err)
	}
	stats, callout, steps := view.Blocks[0].Items[0], view.Blocks[1], view.Blocks[2].Items
	if view.Kind != "panel" || stats.Route != "" || stats.Icon != "trending-up" || stats.Delta != "+12%" {
		t.Fatalf("stats %+v", stats)
	}
	if callout.Tone != "info" || callout.Text != "Two credentials are cooling down." || len(callout.Items) != 0 {
		t.Fatalf("callout %+v", callout)
	}
	if steps[0].Status != "done" || steps[1].Status != "pending" || *view.Blocks[3].Items[0].Share != 0.8 || view.Blocks[4].Items[0].Route != "quota" {
		t.Fatalf("view %s", raw)
	}
}

// TestPanelRefusesWhatTheConsoleCannotDraw: each refusal names the block and item at fault, and a
// link can only name a console page - never a URL.
func TestPanelRefusesWhatTheConsoleCannotDraw(t *testing.T) {
	for name, arguments := range map[string]string{
		"no blocks":        `{"title":"t","blocks":[]}`,
		"unknown type":     `{"title":"t","blocks":[{"type":"marquee","items":[{"label":"a"}]}]}`,
		"unknown field":    `{"title":"t","blocks":[{"type":"fields","items":[{"label":"a","value":"b","href":"https://example.com"}]}]}`,
		"url as route":     `{"title":"t","blocks":[{"type":"links","items":[{"label":"a","route":"https://example.com"}]}]}`,
		"icon markup":      `{"title":"t","blocks":[{"type":"stats","items":[{"label":"a","value":"1","icon":"<svg onload=x>"}]}]}`,
		"share over one":   `{"title":"t","blocks":[{"type":"meters","items":[{"label":"a","share":1.5}]}]}`,
		"empty callout":    `{"title":"t","blocks":[{"type":"callout"}]}`,
		"stats sans value": `{"title":"t","blocks":[{"type":"stats","items":[{"label":"a"}]}]}`,
	} {
		if result, view := renderDisplay(displayConversation(), RENDER_VIEW, arguments); result.Status != "error" || view != nil {
			t.Errorf("%s: accepted %s", name, arguments)
		}
	}
	result, _ := renderDisplay(displayConversation(), RENDER_VIEW, `{"title":"t","blocks":[{"type":"fields","items":[{"label":"a","value":"b"},{"label":"","value":"c"}]}]}`)
	if !strings.Contains(result.Detail, "block 0: item 1") {
		t.Fatalf("detail %q", result.Detail)
	}
}

// TestCanvasFreezesItsMarkupAndRows: the markup is stored as written beside the referenced rows,
// the model gets a receipt, and a turn's canvases are counted.
func TestCanvasFreezesItsMarkupAndRows(t *testing.T) {
	conversation := displayConversation()
	markup := `<svg viewBox=\"0 0 10 10\"><circle r=\"4\"/></svg><script>document.title=OMC_DATA.length</script>`
	result, raw := renderDisplay(conversation, RENDER_CANVAS, `{"title":"Flow","html":"`+markup+`","source":{"call_id":"usage","path":"series.points"},"fields":["day","requests"]}`)
	if result.Status != "success" || strings.Contains(string(result.Data), "circle") {
		t.Fatalf("result %+v", result)
	}
	var view View
	if err := json.Unmarshal(raw, &view); err != nil {
		t.Fatal(err)
	}
	if view.Kind != "canvas" || !strings.Contains(view.HTML, "<script>") || len(view.Rows) != 3 || view.Rows[0]["model"] != nil {
		t.Fatalf("view %s", raw)
	}
	if result, _ := renderDisplay(conversation, RENDER_CANVAS, `{"title":"t","html":"<p>x</p>","fields":["day"]}`); result.Status != "error" {
		t.Fatal("fields without a source was accepted")
	}
	if result, _ := renderDisplay(conversation, RENDER_CANVAS, `{"title":"t","html":"`+strings.Repeat("x", MAX_CANVAS_BYTES+1)+`"}`); result.Status != "error" {
		t.Fatal("an oversized canvas was accepted")
	}
	last := &conversation.Turns[len(conversation.Turns)-1]
	for index := 0; index < MAX_CANVASES_PER_TURN; index++ {
		last.Traces = append(last.Traces, Trace{ID: fmt.Sprint("canvas", index), Name: RENDER_CANVAS, Result: capability.Result{Status: "success"}})
	}
	if result, _ := renderDisplay(conversation, RENDER_CANVAS, `{"title":"t","html":"<p>x</p>"}`); result.Status != "error" || !strings.Contains(result.Detail, "at most") {
		t.Fatalf("a third canvas was accepted: %+v", result)
	}
}

// TestStackedChartsNeedSeveralSeries: stacking one series, a line or a pie has nothing to stack.
func TestStackedChartsNeedSeveralSeries(t *testing.T) {
	base := `"title":"t","source":{"call_id":"usage","path":"series.points"},"x":"day"`
	if result, raw := renderDisplay(displayConversation(), RENDER_CHART, `{`+base+`,"type":"column","y":["requests"],"series":"model","stacked":true}`); result.Status != "success" || !strings.Contains(string(raw), `"stacked":true`) {
		t.Fatalf("result %+v view %s", result, raw)
	}
	for _, arguments := range []string{
		`{` + base + `,"type":"column","y":["requests"],"stacked":true}`,
		`{` + base + `,"type":"line","y":["requests"],"series":"model","stacked":true}`,
	} {
		if result, _ := renderDisplay(displayConversation(), RENDER_CHART, arguments); result.Status != "error" {
			t.Errorf("accepted %s", arguments)
		}
	}
}
