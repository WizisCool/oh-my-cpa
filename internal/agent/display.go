package agent

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"unicode/utf8"

	"github.com/google/jsonschema-go/jsonschema"
	"github.com/oh-my-cpa/oh-my-cpa/internal/capability"
	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/gateway"
)

// Display tools are the frontend tools of the Agent (ADR 0042): a chart or a table the console
// draws inside the answer. They change nothing, so they never pass through the executor, never
// prepare an operation and never interrupt a run.
//
// Their data is referenced rather than transcribed. The model names a capability call of this
// conversation and a path to an array inside its result; the server resolves the reference,
// projects the named fields and freezes the rows into the call's trace. The figures a chart shows
// are therefore the figures a capability returned - not the model's retelling of them - and they
// stay the same when the page reloads, whatever the deployment's data has done since. The model
// receives a small receipt instead of the rows, which is what keeps a chart from costing its data
// twice in tokens.
const (
	RENDER_CHART = "render_chart"
	RENDER_TABLE = "render_table"

	MAX_VIEW_ROWS        = 1000
	MAX_INLINE_ROWS      = 200
	MAX_VIEW_BYTES       = 96 << 10
	MAX_VIEW_TITLE_CHARS = 120
	MAX_VIEW_FIELD_CHARS = 64
	MAX_CHART_SERIES     = 8
	MAX_TABLE_COLUMNS    = 12
	MAX_SOURCE_PATH      = 256
)

var CHART_TYPES = []string{"line", "area", "column", "bar", "pie"}

// DataSource points at an array of objects inside one earlier capability result.
type DataSource struct {
	CallID string `json:"call_id" jsonschema:"The id of a successful capability call earlier in this conversation"`
	Path   string `json:"path,omitempty" jsonschema:"Dot path to an array of objects inside that call's data, e.g. items or series.points; empty when the data itself is the array"`
}

type RenderChartInput struct {
	Title  string           `json:"title" jsonschema:"Short chart title that states the metric and its window"`
	Type   string           `json:"type" jsonschema:"line or area for a trend over time; column or bar to compare items; pie for shares of one total"`
	Source *DataSource      `json:"source,omitempty" jsonschema:"Where the rows come from; preferred over inline"`
	Inline []map[string]any `json:"inline,omitempty" jsonschema:"Rows you derived yourself, at most 200; only when no capability result holds them"`
	X      string           `json:"x" jsonschema:"Field for the category or time axis (the slice label for pie)"`
	Y      []string         `json:"y" jsonschema:"1-8 numeric fields to plot; exactly one for pie"`
	Series string           `json:"series,omitempty" jsonschema:"Optional field that splits a single y field into one line or bar per value"`
	Unit   string           `json:"unit,omitempty" jsonschema:"Optional unit of the y values, e.g. tokens, USD, ms, %"`
}

type RenderTableInput struct {
	Title   string           `json:"title" jsonschema:"Short table title that states what the rows are and their window"`
	Source  *DataSource      `json:"source,omitempty" jsonschema:"Where the rows come from; preferred over inline"`
	Inline  []map[string]any `json:"inline,omitempty" jsonschema:"Rows you derived yourself, at most 200; only when no capability result holds them"`
	Columns []string         `json:"columns" jsonschema:"1-12 fields to show, in order"`
}

// ChartSpec is how a frozen chart is drawn.
type ChartSpec struct {
	Type   string   `json:"type"`
	X      string   `json:"x"`
	Y      []string `json:"y"`
	Series string   `json:"series,omitempty"`
	Unit   string   `json:"unit,omitempty"`
}

// View is a display call's frozen dataset, stored on its trace and drawn by the console.
type View struct {
	Kind    string           `json:"kind"`
	Title   string           `json:"title"`
	Chart   *ChartSpec       `json:"chart,omitempty"`
	Columns []string         `json:"columns"`
	Rows    []map[string]any `json:"rows"`
	Source  *DataSource      `json:"source,omitempty"`
}

// DisplayReceipt is all the model learns from a display call: that it rendered, and the shape of
// what it drew, so it can refer to the chart without the rows coming back to it.
type DisplayReceipt struct {
	IsRendered bool     `json:"rendered"`
	Rows       int      `json:"rows"`
	Fields     []string `json:"fields"`
}

const (
	RENDER_CHART_DESCRIPTION = "Draw a chart inside your answer. Use it for a trend over time or a comparison across more than a few items. Reference a capability result with source {call_id, path} instead of copying numbers; the console draws the rows that call returned. After the chart, state the conclusion in one or two sentences; do not repeat the numbers it shows."
	RENDER_TABLE_DESCRIPTION = "Draw a table inside your answer, for more than about five rows or more than three columns. Reference a capability result with source {call_id, path} instead of copying rows. The operator can sort it and copy it as CSV; summarise what matters in a sentence rather than restating it."
)

type displayTool struct {
	name        string
	description string
	schema      *jsonschema.Schema
	resolved    *jsonschema.Resolved
}

var displayTools = func() map[string]*displayTool {
	chart, err := jsonschema.For[RenderChartInput](nil)
	if err != nil {
		panic(err)
	}
	// Enumerated here rather than in a struct tag: the schema inference reads descriptions from
	// tags but has no enum syntax, and a model offered the closed set picks from it.
	types := make([]any, 0, len(CHART_TYPES))
	for _, chartType := range CHART_TYPES {
		types = append(types, chartType)
	}
	chart.Properties["type"].Enum = types
	table, err := jsonschema.For[RenderTableInput](nil)
	if err != nil {
		panic(err)
	}
	tools := map[string]*displayTool{
		RENDER_CHART: {name: RENDER_CHART, description: RENDER_CHART_DESCRIPTION, schema: chart},
		RENDER_TABLE: {name: RENDER_TABLE, description: RENDER_TABLE_DESCRIPTION, schema: table},
	}
	for _, tool := range tools {
		if tool.resolved, err = tool.schema.Resolve(nil); err != nil {
			panic(err)
		}
	}
	return tools
}()

// DisplayToolNames is the set of display tools a run request may declare.
func DisplayToolNames() map[string]bool {
	names := map[string]bool{}
	for name := range displayTools {
		names[name] = true
	}
	return names
}

// DisplayToolDeclarations projects the declared display tools into the model's tool list, in a
// fixed order so the catalogue is stable between rounds.
func DisplayToolDeclarations(declared []string) []gateway.AgentTool {
	var tools []gateway.AgentTool
	for _, name := range []string{RENDER_CHART, RENDER_TABLE} {
		if !contains(declared, name) {
			continue
		}
		tool := displayTools[name]
		tools = append(tools, gateway.AgentTool{Type: "function", Function: gateway.ToolDefinition{Name: tool.name, Description: tool.description, Parameters: tool.schema}})
	}
	return tools
}

func contains(values []string, value string) bool {
	for _, item := range values {
		if item == value {
			return true
		}
	}
	return false
}

// displayFailure is a refusal the model can act on: the code says what kind, the detail which
// field of its own request to change. Nothing in the detail quotes stored data.
type displayFailure struct {
	code   string
	detail string
}

func (failure displayFailure) Error() string         { return failure.code }
func (failure displayFailure) FailureDetail() string { return failure.detail }

func refuse(format string, args ...any) error {
	return displayFailure{code: "invalid_tool_arguments", detail: fmt.Sprintf(format, args...)}
}

// renderDisplay resolves one display call against the conversation. It returns the result the
// model receives and the frozen view; a refusal is an ordinary error result, so the model can
// correct its reference in the next round.
func renderDisplay(conversation *Conversation, name, arguments string) (capability.Result, json.RawMessage) {
	view, err := resolveDisplay(conversation, name, arguments)
	if err != nil {
		return capability.Result{Status: "error", Code: capability.ErrorCode(err), Detail: capability.ErrorDetail(err)}, nil
	}
	raw, err := json.Marshal(view)
	if err != nil || len(raw) > MAX_VIEW_BYTES {
		return capability.Result{Status: "error", Code: "tool_result_too_large", Detail: "the referenced rows are too large to draw; aggregate them first"}, nil
	}
	receipt, _ := json.Marshal(DisplayReceipt{IsRendered: true, Rows: len(view.Rows), Fields: view.Columns})
	return capability.Result{Status: "success", Data: receipt}, raw
}

func resolveDisplay(conversation *Conversation, name, arguments string) (View, error) {
	tool := displayTools[name]
	if tool == nil {
		return View{}, errors.New("capability_forbidden")
	}
	if len(arguments) > capability.MAX_PAYLOAD_BYTES {
		return View{}, errors.New("tool_input_too_large")
	}
	var value any
	decoder := json.NewDecoder(strings.NewReader(arguments))
	decoder.UseNumber()
	if decoder.Decode(&value) != nil {
		return View{}, errors.New("invalid_tool_arguments")
	}
	generic, err := json.Marshal(value)
	if err != nil {
		return View{}, errors.New("invalid_tool_arguments")
	}
	var plain any
	if json.Unmarshal(generic, &plain) != nil || tool.resolved.Validate(plain) != nil {
		return View{}, refuse("the arguments do not match the %s schema", name)
	}
	if name == RENDER_CHART {
		var input RenderChartInput
		if err := strictUnmarshal(generic, &input); err != nil {
			return View{}, err
		}
		return resolveChart(conversation, input)
	}
	var input RenderTableInput
	if err := strictUnmarshal(generic, &input); err != nil {
		return View{}, err
	}
	return resolveTable(conversation, input)
}

func strictUnmarshal(raw []byte, target any) error {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if decoder.Decode(target) != nil {
		return refuse("unknown or malformed field")
	}
	return nil
}

func resolveChart(conversation *Conversation, input RenderChartInput) (View, error) {
	if !contains(CHART_TYPES, input.Type) {
		return View{}, refuse("type must be one of %s", strings.Join(CHART_TYPES, ", "))
	}
	if len(input.Y) == 0 || len(input.Y) > MAX_CHART_SERIES {
		return View{}, refuse("y must name 1-%d fields", MAX_CHART_SERIES)
	}
	if input.Type == "pie" && (len(input.Y) != 1 || input.Series != "") {
		return View{}, refuse("a pie takes exactly one y field and no series")
	}
	if input.Series != "" && len(input.Y) != 1 {
		return View{}, refuse("series splits a single y field; name one y field or drop series")
	}
	if utf8.RuneCountInString(input.Unit) > 16 {
		return View{}, refuse("unit must be at most 16 characters")
	}
	fields := append([]string{input.X}, input.Y...)
	if input.Series != "" {
		fields = append(fields, input.Series)
	}
	view, err := resolveRows(conversation, input.Title, input.Source, input.Inline, fields)
	if err != nil {
		return View{}, err
	}
	for _, row := range view.Rows {
		for _, field := range input.Y {
			switch row[field].(type) {
			case json.Number, nil:
			default:
				return View{}, refuse("y field %q must be numeric", field)
			}
		}
	}
	view.Kind = "chart"
	view.Chart = &ChartSpec{Type: input.Type, X: input.X, Y: input.Y, Series: input.Series, Unit: strings.TrimSpace(input.Unit)}
	return view, nil
}

func resolveTable(conversation *Conversation, input RenderTableInput) (View, error) {
	if len(input.Columns) == 0 || len(input.Columns) > MAX_TABLE_COLUMNS {
		return View{}, refuse("columns must name 1-%d fields", MAX_TABLE_COLUMNS)
	}
	view, err := resolveRows(conversation, input.Title, input.Source, input.Inline, input.Columns)
	if err != nil {
		return View{}, err
	}
	view.Kind = "table"
	return view, nil
}

// resolveRows reads the rows a display call names - from a referenced result or inline - and keeps
// only the named fields, which must exist and hold scalars.
func resolveRows(conversation *Conversation, title string, source *DataSource, inline []map[string]any, fields []string) (View, error) {
	title = strings.TrimSpace(title)
	if title == "" || utf8.RuneCountInString(title) > MAX_VIEW_TITLE_CHARS {
		return View{}, refuse("title must be 1-%d characters", MAX_VIEW_TITLE_CHARS)
	}
	seen := map[string]bool{}
	for _, field := range fields {
		if field == "" || utf8.RuneCountInString(field) > MAX_VIEW_FIELD_CHARS || seen[field] {
			return View{}, refuse("field names must be distinct and 1-%d characters", MAX_VIEW_FIELD_CHARS)
		}
		seen[field] = true
	}
	var rows []any
	switch {
	case source != nil && inline != nil:
		return View{}, refuse("give either source or inline, not both")
	case source != nil:
		found, err := referencedRows(conversation, *source)
		if err != nil {
			return View{}, err
		}
		rows = found
	case inline != nil:
		if len(inline) > MAX_INLINE_ROWS {
			return View{}, refuse("inline holds at most %d rows; reference a capability result instead", MAX_INLINE_ROWS)
		}
		// Inline rows arrive as decoded maps; re-read them with number preservation so a value
		// is drawn exactly as the model wrote it.
		raw, _ := json.Marshal(inline)
		decoder := json.NewDecoder(bytes.NewReader(raw))
		decoder.UseNumber()
		if decoder.Decode(&rows) != nil {
			return View{}, errors.New("invalid_tool_arguments")
		}
	default:
		return View{}, refuse("give source {call_id, path} or inline rows")
	}
	if len(rows) > MAX_VIEW_ROWS {
		return View{}, refuse("the array holds %d rows, more than %d; aggregate it first", len(rows), MAX_VIEW_ROWS)
	}
	present := map[string]bool{}
	projected := make([]map[string]any, 0, len(rows))
	for index, item := range rows {
		row, ok := item.(map[string]any)
		if !ok {
			return View{}, refuse("row %d is not an object; path must lead to an array of objects", index)
		}
		kept := make(map[string]any, len(fields))
		for _, field := range fields {
			value, exists := row[field]
			if !exists {
				continue
			}
			switch value.(type) {
			case string, json.Number, bool, nil:
			default:
				return View{}, refuse("field %q holds nested data; choose a scalar field", field)
			}
			present[field] = true
			kept[field] = value
		}
		projected = append(projected, kept)
	}
	for _, field := range fields {
		if len(rows) > 0 && !present[field] {
			return View{}, refuse("no row has a field %q", field)
		}
	}
	return View{Title: title, Columns: fields, Rows: projected, Source: source}, nil
}

// referencedRows finds the array a source names. Only a successful capability call of this
// conversation qualifies: a failed or pending call has no data to show, and a display call's own
// data is a receipt, not rows.
func referencedRows(conversation *Conversation, source DataSource) ([]any, error) {
	if source.CallID == "" || len(source.Path) > MAX_SOURCE_PATH {
		return nil, refuse("source.call_id is required and source.path is at most %d characters", MAX_SOURCE_PATH)
	}
	var trace *Trace
	for turnIndex := len(conversation.Turns) - 1; turnIndex >= 0 && trace == nil; turnIndex-- {
		for traceIndex := range conversation.Turns[turnIndex].Traces {
			if candidate := &conversation.Turns[turnIndex].Traces[traceIndex]; candidate.ID == source.CallID {
				trace = candidate
				break
			}
		}
	}
	if trace == nil {
		return nil, refuse("no capability call %q in this conversation", source.CallID)
	}
	if displayTools[trace.Name] != nil || trace.Result.Status != "success" || len(trace.Result.Data) == 0 {
		return nil, refuse("call %q has no successful capability result to draw", source.CallID)
	}
	var data any
	decoder := json.NewDecoder(bytes.NewReader(trace.Result.Data))
	decoder.UseNumber()
	if decoder.Decode(&data) != nil {
		return nil, refuse("call %q has no readable result", source.CallID)
	}
	current := data
	if source.Path != "" {
		for _, segment := range strings.Split(source.Path, ".") {
			object, ok := current.(map[string]any)
			if !ok || segment == "" {
				return nil, refuse("path %q does not lead through objects in call %q", source.Path, source.CallID)
			}
			if current, ok = object[segment]; !ok {
				return nil, refuse("path %q: no field %q in call %q", source.Path, segment, source.CallID)
			}
		}
	}
	rows, ok := current.([]any)
	if !ok {
		return nil, refuse("path %q in call %q is not an array", source.Path, source.CallID)
	}
	return rows, nil
}
