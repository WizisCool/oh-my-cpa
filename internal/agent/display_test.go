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
		{ID: "drawn", Name: RENDER_UI, Result: capability.Result{Status: "error", Code: "invalid_tool_arguments"}},
		{ID: "chart", Name: "render_chart", Result: capability.Result{Status: "success", Data: json.RawMessage(`{"rendered":true,"rows":0,"fields":[]}`)}},
	}}}}
}

func canvasCall(source, fields string) string {
	return `{"title":"Requests per day, last 3 days","html":"<div id=\"c\"></div>","source":` + source + `,"fields":` + fields + `}`
}

// TestDisplayFreezesTheReferencedRows: a canvas's rows are the capability's rows, projected to the
// named fields, and the model receives only a receipt.
func TestDisplayFreezesTheReferencedRows(t *testing.T) {
	result, raw := renderDisplay(displayConversation(), RENDER_UI, canvasCall(`{"call_id":"usage","path":"series.points"}`, `["day","requests"]`))
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
	if view.Kind != "ui" || len(view.Rows) != 3 || view.Rows[2]["requests"] != float64(30) || view.Rows[0]["model"] != nil || view.Source.CallID != "usage" {
		t.Fatalf("view %s", raw)
	}
}

// TestDisplayReadsPositionalRowsByTheirColumns: a SQL result's rows are arrays beside a column list,
// and a canvas references them by column name like any other rows. Rows that do not line up with
// the column list are still refused rather than guessed at.
func TestDisplayReadsPositionalRowsByTheirColumns(t *testing.T) {
	conversation := &Conversation{Turns: []Turn{{Traces: []Trace{
		{ID: "sql", Name: "database_query", Result: capability.Result{Status: "success", Data: json.RawMessage(`{"columns":["model","requests"],"rows":[["a",12],["b",30]],"is_truncated":false}`)}},
		{ID: "ragged", Name: "database_query", Result: capability.Result{Status: "success", Data: json.RawMessage(`{"columns":["model","requests"],"rows":[["a",12],["b"]]}`)}},
	}}}}
	result, raw := renderDisplay(conversation, RENDER_UI, canvasCall(`{"call_id":"sql","path":"rows"}`, `["model","requests"]`))
	var view View
	if result.Status != "success" || json.Unmarshal(raw, &view) != nil || len(view.Rows) != 2 || view.Rows[1]["model"] != "b" || view.Rows[1]["requests"] != float64(30) {
		t.Fatalf("result %+v view %s", result, raw)
	}
	result, _ = renderDisplay(conversation, RENDER_UI, canvasCall(`{"call_id":"ragged","path":"rows"}`, `["model"]`))
	if result.Status != "error" || result.Code != "invalid_tool_arguments" {
		t.Fatalf("ragged rows were drawn: %+v", result)
	}
}

// TestDisplayRefusesAReferenceItCannotHonour lists every reference the server must not draw. Each
// refusal is an ordinary error result with a detail the model can act on.
func TestDisplayRefusesAReferenceItCannotHonour(t *testing.T) {
	points := `{"call_id":"usage","path":"series.points"}`
	cases := map[string]string{
		"unknown call":    canvasCall(`{"call_id":"missing"}`, `["day"]`),
		"failed call":     canvasCall(`{"call_id":"failed"}`, `["day"]`),
		"display source":  canvasCall(`{"call_id":"drawn"}`, `["day"]`),
		"retired display": canvasCall(`{"call_id":"chart"}`, `["day"]`),
		"not an array":    canvasCall(`{"call_id":"usage","path":"total"}`, `["day"]`),
		"bad path":        canvasCall(`{"call_id":"usage","path":"series.missing"}`, `["day"]`),
		"root object":     canvasCall(`{"call_id":"usage"}`, `["day"]`),
		"missing field":   canvasCall(points, `["tokens"]`),
		"nested field":    canvasCall(points, `["nested"]`),
		"repeated field":  canvasCall(points, `["day","day"]`),
		"no fields":       canvasCall(points, `[]`),
		"blank title":     `{"title":" ","html":"<p>x</p>"}`,
		"unknown field":   `{"title":"t","html":"<p>x</p>","color":"red"}`,
		"retired tool":    `{"title":"t","type":"line","source":` + points + `,"x":"day","y":["requests"]}`,
	}
	for name, arguments := range cases {
		tool := RENDER_UI
		if name == "retired tool" {
			tool = "render_chart"
		}
		result, view := renderDisplay(displayConversation(), tool, arguments)
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
	if result, _ := renderDisplay(conversation, RENDER_UI, canvasCall(`{"call_id":"big"}`, `["a"]`)); result.Status != "error" || !strings.Contains(result.Detail, "aggregate") {
		t.Fatalf("row budget %+v", result)
	}
}

// TestRuntimeOffersDisplayToolsOnlyWhenDeclared: the model sees render_canvas only on a run whose
// console declared it, and a declared display call is resolved without the executor.
func TestRuntimeOffersDisplayToolsOnlyWhenDeclared(t *testing.T) {
	runtime := newTestRuntime(t)
	registerFixtureRows(t, runtime)
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
				return gateway.AgentReply{Calls: []gateway.ToolCall{drawFixtureRows("draw")}}, nil
			}
			if last := messages[len(messages)-1]; last.Role != "tool" || strings.Contains(last.Content, "d1") {
				t.Fatalf("model received %+v", last)
			}
			return gateway.AgentReply{Content: "Flat."}, nil
		}), nil
	}
	var final *Conversation
	if err := runtime.Run(context.Background(), Input{Message: "chart", Model: "fixture", Fingerprint: "key", DisplayTools: []string{RENDER_UI}}, func(event Event) error {
		if event.Type == "finished" {
			final = event.Conversation
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if strings.Join(offered[0], ",") != "fixture_rows,render_ui" {
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
				if tool.Function.Name == RENDER_UI {
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

func registerFixtureRows(t *testing.T, runtime *Runtime) {
	t.Helper()
	if err := capability.Register(runtime.Executor.Registry, capability.Metadata{Name: "fixture_rows", Description: "fixture", Version: 1, Permission: "read", Risk: "low", Adapters: []string{"agent"}}, nil, func(context.Context, struct{}, string, string) (struct {
		Items []map[string]any `json:"items"`
	}, error) {
		return struct {
			Items []map[string]any `json:"items"`
		}{Items: []map[string]any{{"day": "d1", "count": 3}}}, nil
	}); err != nil {
		t.Fatal(err)
	}
}

func drawFixtureRows(id string) gateway.ToolCall {
	return gateway.ToolCall{ID: id, Type: "function", Function: gateway.ToolFunction{Name: RENDER_UI, Arguments: `{"title":"Count","html":"<div id=\"c\"></div><script>OMC.chart('#c',{type:'line',x:'day',y:['count']})</script>","source":{"call_id":"rows","path":"items"},"fields":["day","count"]}`}}
}

// Presentation preferences narrow available tools without forcing an artificial model round.
func TestRuntimeHoldsATurnToThePresentationItWasAskedFor(t *testing.T) {
	declared := []string{RENDER_UI, SUGGEST_NEXT}
	run := func(t *testing.T, present string, reply func(round int, messages []gateway.AgentMessage) gateway.AgentReply) (*Conversation, [][]string) {
		runtime := newTestRuntime(t)
		registerFixtureRows(t, runtime)
		var offered [][]string
		runtime.Client = func(context.Context, string) (ModelClient, error) {
			return modelFunc(func(_ context.Context, _ string, messages []gateway.AgentMessage, tools []gateway.AgentTool, _ func(gateway.Event) error) (gateway.AgentReply, error) {
				names := []string{}
				for _, tool := range tools {
					if tool.Function.Name != "fixture_rows" {
						names = append(names, tool.Function.Name)
					}
				}
				offered = append(offered, names)
				return reply(len(offered), messages), nil
			}), nil
		}
		var final *Conversation
		if err := runtime.Run(context.Background(), Input{Message: "ask", Model: "fixture", Fingerprint: "key", DisplayTools: declared, Present: present}, func(event Event) error {
			if event.Type == "finished" {
				final = event.Conversation
			}
			return nil
		}); err != nil {
			t.Fatal(err)
		}
		return final, offered
	}
	t.Run("model selects presentation", func(t *testing.T) {
		final, offered := run(t, "", func(int, []gateway.AgentMessage) gateway.AgentReply {
			return gateway.AgentReply{Content: "Three requests."}
		})
		if len(offered) != 1 || final.Turns[0].Status != "success" || strings.Join(offered[0], ",") != "render_ui,suggest_next" {
			t.Fatalf("offered %v", offered)
		}
	})
	t.Run("UI preference does not force an extra round", func(t *testing.T) {
		final, offered := run(t, PRESENT_UI, func(int, []gateway.AgentMessage) gateway.AgentReply {
			return gateway.AgentReply{Content: "Plain answer fits."}
		})
		if len(offered) != 1 || final.Turns[0].Status != "success" {
			t.Fatalf("rounds %d", len(offered))
		}
	})
	t.Run("text", func(t *testing.T) {
		_, offered := run(t, PRESENT_TEXT, func(_ int, messages []gateway.AgentMessage) gateway.AgentReply {
			if strings.Contains(messages[0].Content, "render_canvas") || !strings.Contains(messages[0].Content, "text only") {
				t.Fatal("the text prompt still describes a display")
			}
			return gateway.AgentReply{Content: "Plain."}
		})
		if len(offered) != 1 || strings.Join(offered[0], ",") != "suggest_next" {
			t.Fatalf("offered %v", offered)
		}
	})
	runtime := newTestRuntime(t)
	for name, input := range map[string]Input{
		"unknown presentation":           {Message: "x", Present: "poster", DisplayTools: declared},
		"canvas the console cannot draw": {Message: "x", Present: PRESENT_CANVAS, DisplayTools: []string{SUGGEST_NEXT}},
		"ui the console cannot draw":     {Message: "x", Present: PRESENT_UI, DisplayTools: []string{SUGGEST_NEXT}},
		"unknown token style":            {Message: "x", TokenStyle: "roman"},
	} {
		input.Model, input.Fingerprint = "fixture", "key"
		if err := runtime.Run(context.Background(), input, func(Event) error { return nil }); err == nil || err.Error() != "invalid_parameters" {
			t.Errorf("%s: %v", name, err)
		}
	}
}

func TestDisplayDeclarationsFitTheirShare(t *testing.T) {
	raw, err := json.Marshal(DisplayToolDeclarations([]string{RENDER_UI, SUGGEST_NEXT}))
	if err != nil {
		t.Fatal(err)
	}
	// Display tools ride on the same schema budget as the registry; they are allowed a small,
	// fixed share of it so adding them never pushes a real capability out.
	if len(raw) > 8<<10 {
		t.Fatalf("display declarations are %d bytes", len(raw))
	}
	if !strings.Contains(string(raw), `"name":"render_ui"`) || strings.Contains(string(raw), "render_view") || strings.Contains(string(raw), "render_canvas") {
		t.Fatalf("the declarations are not the current set: %s", raw)
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
		"beside real work":  {[]string{SUGGEST_NEXT, RENDER_UI}, []gateway.ToolCall{suggest(`{"suggestions":["Stale?"]}`), {ID: "canvas", Type: "function", Function: gateway.ToolFunction{Name: RENDER_UI, Arguments: `{"title":"t","html":"<p>x</p>"}`}}}, 2, nil},
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

// Stored display names cannot create a new artifact or enter the model catalogue.
func TestIntelligentUIIsTheOnlyDisplayDeclaration(t *testing.T) {
	for _, name := range []string{RENDER_VIEW, RENDER_CANVAS, "render_chart", "render_table"} {
		if DisplayToolNames()[name] || len(DisplayToolDeclarations([]string{name})) != 0 {
			t.Fatalf("retired display offered: %s", name)
		}
		if result, view := renderDisplay(displayConversation(), name, `{}`); result.Status != "error" || view != nil {
			t.Fatalf("retired display executed: %s %+v", name, result)
		}
	}
}

// TestCanvasFreezesItsMarkupAndRows: the markup is stored as written beside the referenced rows,
// the model gets a receipt, and a turn's canvases are counted.
func TestCanvasFreezesItsMarkupAndRows(t *testing.T) {
	conversation := displayConversation()
	markup := `<svg viewBox=\"0 0 10 10\"><circle r=\"4\"/></svg><script>document.title=OMC.rows.length</script>`
	result, raw := renderDisplay(conversation, RENDER_UI, `{"title":"Flow","html":"`+markup+`","source":{"call_id":"usage","path":"series.points"},"fields":["day","requests"]}`)
	if result.Status != "success" || strings.Contains(string(result.Data), "circle") {
		t.Fatalf("result %+v", result)
	}
	var view View
	if err := json.Unmarshal(raw, &view); err != nil {
		t.Fatal(err)
	}
	if view.Kind != "ui" || !strings.Contains(view.HTML, "<script>") || len(view.Rows) != 3 || view.Rows[0]["model"] != nil {
		t.Fatalf("view %s", raw)
	}
	if result, _ := renderDisplay(conversation, RENDER_UI, `{"title":"t","html":"<p>x</p>","fields":["day"]}`); result.Status != "error" {
		t.Fatal("fields without a source was accepted")
	}
	if result, _ := renderDisplay(conversation, RENDER_UI, `{"title":"t","html":"`+strings.Repeat("x", MAX_CANVAS_BYTES+1)+`"}`); result.Status != "error" {
		t.Fatal("an oversized canvas was accepted")
	}
	last := &conversation.Turns[len(conversation.Turns)-1]
	for index := 0; index < 5; index++ {
		last.Traces = append(last.Traces, Trace{ID: fmt.Sprint("canvas", index), Name: RENDER_UI, Result: capability.Result{Status: "success"}})
	}
	if result, _ := renderDisplay(conversation, RENDER_UI, `{"title":"t","html":"<p>x</p>"}`); result.Status != "success" {
		t.Fatalf("additional UI was refused: %+v", result)
	}
}

func TestIntelligentUICarriesDeclaredArtworkAndData(t *testing.T) {
	conversation := displayConversation()
	result, raw := renderDisplay(conversation, RENDER_UI, `{"title":"Explore usage","html":"<button>Filter</button><span data-omc-icon=\"gauge\"></span>","icons":["gauge","brand:OpenAI","custom:0123456789abcdef0123456789abcdef"],"source":{"call_id":"usage","path":"series.points"},"fields":["day","requests"]}`)
	var view View
	if result.Status != "success" || json.Unmarshal(raw, &view) != nil || view.Kind != "ui" || len(view.Icons) != 3 || len(view.Rows) != 3 {
		t.Fatalf("view %s result %+v", raw, result)
	}
	// The frame is the model's choice; a card is stored as absence and anything else is refused.
	for frame, stored := range map[string]string{"none": "none", "card": ""} {
		result, raw := renderDisplay(conversation, RENDER_UI, `{"title":"t","html":"<p>x</p>","frame":"`+frame+`"}`)
		var framed View
		if result.Status != "success" || json.Unmarshal(raw, &framed) != nil || framed.Frame != stored {
			t.Fatalf("frame %q stored as %q: %+v", frame, framed.Frame, result)
		}
	}
	if result, _ := renderDisplay(conversation, RENDER_UI, `{"title":"t","html":"<p>x</p>","frame":"glass"}`); result.Status != "error" {
		t.Fatalf("unknown frame accepted: %+v", result)
	}
	for _, input := range []string{`{"title":"t","html":"<p>x</p>","icons":[""]}`, `{"title":"t","html":"<p>x</p>","icons":["` + strings.Repeat("x", MAX_ICON_CHARS+1) + `"]}`} {
		if result, _ := renderDisplay(conversation, RENDER_UI, input); result.Status != "error" {
			t.Fatalf("invalid icons accepted: %+v", result)
		}
	}
}

func TestDisplayFrameIsValidatedAndFrozen(t *testing.T) {
	for _, testCase := range []struct {
		name        string
		frame       string
		storedFrame string
		isValid     bool
	}{
		{name: "default inline component", storedFrame: FRAME_NONE, isValid: true},
		{name: "explicit card", frame: FRAME_CARD, isValid: true},
		{name: "frameless", frame: FRAME_NONE, storedFrame: FRAME_NONE, isValid: true},
		{name: "unknown frame", frame: "floating"},
		{name: "wrong casing", frame: "None"},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			arguments, err := json.Marshal(map[string]string{"title": "Inline status", "html": "<p>Ready</p>", "frame": testCase.frame})
			if err != nil {
				t.Fatal(err)
			}
			result, raw := renderDisplay(displayConversation(), RENDER_UI, string(arguments))
			if !testCase.isValid {
				if result.Status != "error" || result.Code != "invalid_tool_arguments" || raw != nil || !strings.Contains(result.Detail, "frame") {
					t.Fatalf("invalid frame was not explained: %+v, %s", result, raw)
				}
				return
			}
			var view View
			if result.Status != "success" || json.Unmarshal(raw, &view) != nil || view.Frame != testCase.storedFrame {
				t.Fatalf("frame was not frozen: %+v, %s", result, raw)
			}
			if testCase.storedFrame == "" && strings.Contains(string(raw), `"frame"`) {
				t.Fatalf("explicit card should retain the absent-field storage contract: %s", raw)
			}
		})
	}
}
