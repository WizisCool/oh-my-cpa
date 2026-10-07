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

// Display tools are the frontend tools of the Agent (ADR 0042, extended by ADR 0071 and ADR 0072):
// a chart, a table, a panel of blocks or a sandboxed canvas the console draws inside the answer. They change nothing, so they never pass through the executor, never
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
	RENDER_CHART  = "render_chart"
	RENDER_TABLE  = "render_table"
	RENDER_VIEW   = "render_view"
	RENDER_CANVAS = "render_canvas"
	SUGGEST_NEXT  = "suggest_next"

	MAX_VIEW_ROWS        = 1000
	MAX_INLINE_ROWS      = 200
	MAX_VIEW_BYTES       = 96 << 10
	MAX_VIEW_TITLE_CHARS = 120
	MAX_VIEW_FIELD_CHARS = 64
	MAX_CHART_SERIES     = 8
	MAX_TABLE_COLUMNS    = 12
	MAX_SOURCE_PATH      = 256

	MAX_VIEW_BLOCKS      = 8
	MAX_BLOCK_ITEMS      = 12
	MAX_BLOCK_TEXT_CHARS = 400
	MAX_ITEM_TEXT_CHARS  = 160
	MAX_ICON_CHARS       = 48

	// A canvas is the model's own markup, stored whole and resent inside the turn's tool call, so
	// both its size and how many one turn draws are bounded.
	MAX_CANVAS_BYTES      = 48 << 10
	MAX_CANVASES_PER_TURN = 2

	MAX_SUGGESTIONS      = 3
	MAX_SUGGESTION_CHARS = 80
)

var CHART_TYPES = []string{"line", "area", "column", "bar", "pie"}

var (
	BLOCK_TYPES   = []string{"stats", "fields", "callout", "steps", "meters", "links"}
	CALLOUT_TONES = []string{"info", "success", "warning", "danger"}
	ITEM_TONES    = []string{"neutral", "success", "warning", "danger"}
	STEP_STATUSES = []string{"done", "active", "pending", "failed"}
	// CONSOLE_ROUTES is the closed set of console pages a links block may point at. A route is a
	// name the console resolves under its own base path, never a URL, so a link can only ever
	// lead somewhere inside this deployment.
	CONSOLE_ROUTES = []string{"dashboard", "usage/events", "quota", "pricing", "api-keys", "ai-providers", "auth-files", "oauth-management", "model-square", "logs", "audit", "config", "playground"}
)

// DataSource points at the rows inside one earlier capability result.
type DataSource struct {
	CallID string `json:"call_id" jsonschema:"The id of a successful capability call earlier in this conversation"`
	Path   string `json:"path,omitempty" jsonschema:"Dot path to the rows inside that call's data, e.g. items, series.points, or rows for a database_query result; empty when the data itself is the array"`
}

type RenderChartInput struct {
	Title   string           `json:"title" jsonschema:"Short chart title that states the metric and its window"`
	Type    string           `json:"type" jsonschema:"line or area for a trend over time; column or bar to compare items; pie for shares of one total"`
	Source  *DataSource      `json:"source,omitempty" jsonschema:"Where the rows come from; preferred over inline"`
	Inline  []map[string]any `json:"inline,omitempty" jsonschema:"Rows you derived yourself, at most 200"`
	X       string           `json:"x" jsonschema:"Field for the category or time axis (the slice label for pie)"`
	Y       []string         `json:"y" jsonschema:"1-8 numeric fields to plot; exactly one for pie"`
	Series  string           `json:"series,omitempty" jsonschema:"Optional field that splits a single y field into one line or bar per value"`
	Unit    string           `json:"unit,omitempty" jsonschema:"Optional unit of the y values, e.g. tokens, USD, ms, %"`
	Stacked bool             `json:"stacked,omitempty" jsonschema:"Stack the series of an area, column or bar chart into one total"`
}

type RenderViewInput struct {
	Title  string      `json:"title" jsonschema:"Short title for the whole view"`
	Blocks []ViewBlock `json:"blocks" jsonschema:"1-8 blocks, drawn top to bottom"`
}

// ViewBlock is one block of a panel. Every block type shares this one shape, so the schema the
// model is sent stays a few hundred bytes however many block types exist; which fields a type
// reads is enforced in resolveView, and the rest are dropped rather than stored.
type ViewBlock struct {
	Type  string     `json:"type" jsonschema:"stats (headline figures), fields (label/value facts), callout (one highlighted message), steps (ordered stages), meters (shares of a limit) or links (console pages to open)"`
	Title string     `json:"title,omitempty" jsonschema:"Optional heading"`
	Tone  string     `json:"tone,omitempty" jsonschema:"callout: info, success, warning or danger"`
	Text  string     `json:"text,omitempty" jsonschema:"callout: the message"`
	Items []ViewItem `json:"items,omitempty" jsonschema:"1-12 items; every type except callout"`
}

type ViewItem struct {
	Label  string   `json:"label" jsonschema:"What the item is"`
	Value  string   `json:"value,omitempty" jsonschema:"stats, fields, meters: the figure as shown, e.g. 1,204 or $4.20"`
	Delta  string   `json:"delta,omitempty" jsonschema:"stats: change against the previous window, e.g. +12%"`
	Tone   string   `json:"tone,omitempty" jsonschema:"stats, meters: neutral, success, warning or danger"`
	Icon   string   `json:"icon,omitempty" jsonschema:"stats, links: any Lucide icon name (trending-up, key-round, gauge) or brand:<maker> (brand:OpenAI)"`
	Text   string   `json:"text,omitempty" jsonschema:"steps: detail under the label"`
	Status string   `json:"status,omitempty" jsonschema:"steps: done, active, pending or failed"`
	Share  *float64 `json:"share,omitempty" jsonschema:"meters: filled fraction, 0 to 1"`
	Route  string   `json:"route,omitempty" jsonschema:"links: the console page"`
}

type RenderCanvasInput struct {
	Title  string      `json:"title" jsonschema:"Short title that states what the canvas shows"`
	HTML   string      `json:"html" jsonschema:"Body markup with inline style and script, at most 48 KiB. It runs sandboxed with no network: nothing external loads. Theme colours are CSS variables (--bg --surface --fg --fg-2 --muted --border --accent --success --warn --danger --series-1 to --series-6). window.OMC_DATA holds the rows named by source."`
	Source *DataSource `json:"source,omitempty" jsonschema:"Rows to pass in as window.OMC_DATA"`
	Fields []string    `json:"fields,omitempty" jsonschema:"With source: 1-12 fields to pass"`
}

type RenderTableInput struct {
	Title   string           `json:"title" jsonschema:"Short table title that states what the rows are and their window"`
	Source  *DataSource      `json:"source,omitempty" jsonschema:"Where the rows come from; preferred over inline"`
	Inline  []map[string]any `json:"inline,omitempty" jsonschema:"Rows you derived yourself, at most 200"`
	Columns []string         `json:"columns" jsonschema:"1-12 fields to show, in order"`
}

type SuggestNextInput struct {
	Suggestions []string `json:"suggestions" jsonschema:"1-3 questions, at most 80 characters each"`
}

// ChartSpec is how a frozen chart is drawn.
type ChartSpec struct {
	Type    string   `json:"type"`
	X       string   `json:"x"`
	Y       []string `json:"y"`
	Series  string   `json:"series,omitempty"`
	Unit    string   `json:"unit,omitempty"`
	Stacked bool     `json:"stacked,omitempty"`
}

// View is a display call's frozen dataset, stored on its trace and drawn by the console.
type View struct {
	Kind    string           `json:"kind"`
	Title   string           `json:"title"`
	Chart   *ChartSpec       `json:"chart,omitempty"`
	Columns []string         `json:"columns"`
	Rows    []map[string]any `json:"rows"`
	Source  *DataSource      `json:"source,omitempty"`
	// Blocks is a panel's content (ADR 0071): the model's own statements, laid out.
	Blocks []ViewBlock `json:"blocks,omitempty"`
	// HTML is a canvas's markup (ADR 0072), drawn only inside the console's sandboxed frame.
	HTML string `json:"html,omitempty"`
}

// DisplayReceipt is all the model learns from a display call: that it rendered, and the shape of
// what it drew, so it can refer to the chart without the rows coming back to it.
type DisplayReceipt struct {
	IsRendered bool     `json:"rendered"`
	Rows       int      `json:"rows"`
	Fields     []string `json:"fields"`
	Blocks     int      `json:"blocks,omitempty"`
}

// The descriptions say only what each tool is for. Referencing rows by source is stated on the
// source field and in the system prompt's presentation section, as is how to write the answer
// around a display; repeating either here would spend the schema budget on every round to say
// it twice.
const (
	RENDER_CHART_DESCRIPTION  = "Draw a chart inside your answer, for a trend over time or a comparison across more than a few items."
	SUGGEST_NEXT_DESCRIPTION  = "Offer follow-up questions with your final answer text, never with another tool; ends the turn."
	RENDER_TABLE_DESCRIPTION  = "Draw a table inside your answer, for more than about five rows or more than three columns. The operator can sort it and copy it as CSV."
	RENDER_VIEW_DESCRIPTION   = "Draw a panel of blocks inside your answer: headline figures, facts, a highlighted message, ordered stages, shares of a limit, links to console pages."
	RENDER_CANVAS_DESCRIPTION = "Draw your own HTML, SVG and script inside your answer, for a visual no other display tool can express."
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
	chart.Properties["type"].Enum = enumOf(CHART_TYPES)
	table, err := jsonschema.For[RenderTableInput](nil)
	if err != nil {
		panic(err)
	}
	suggest, err := jsonschema.For[SuggestNextInput](nil)
	if err != nil {
		panic(err)
	}
	view, err := jsonschema.For[RenderViewInput](nil)
	if err != nil {
		panic(err)
	}
	block := view.Properties["blocks"].Items
	block.Properties["type"].Enum = enumOf(BLOCK_TYPES)
	block.Properties["items"].Items.Properties["route"].Enum = enumOf(CONSOLE_ROUTES)
	canvas, err := jsonschema.For[RenderCanvasInput](nil)
	if err != nil {
		panic(err)
	}
	tools := map[string]*displayTool{
		SUGGEST_NEXT:  {name: SUGGEST_NEXT, description: SUGGEST_NEXT_DESCRIPTION, schema: suggest},
		RENDER_CHART:  {name: RENDER_CHART, description: RENDER_CHART_DESCRIPTION, schema: chart},
		RENDER_TABLE:  {name: RENDER_TABLE, description: RENDER_TABLE_DESCRIPTION, schema: table},
		RENDER_VIEW:   {name: RENDER_VIEW, description: RENDER_VIEW_DESCRIPTION, schema: view},
		RENDER_CANVAS: {name: RENDER_CANVAS, description: RENDER_CANVAS_DESCRIPTION, schema: canvas},
	}
	for _, tool := range tools {
		if tool.resolved, err = tool.schema.Resolve(nil); err != nil {
			panic(err)
		}
	}
	return tools
}()

func enumOf(values []string) []any {
	enum := make([]any, 0, len(values))
	for _, value := range values {
		enum = append(enum, value)
	}
	return enum
}

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
	for _, name := range []string{RENDER_CHART, RENDER_TABLE, RENDER_VIEW, RENDER_CANVAS, SUGGEST_NEXT} {
		if !contains(declared, name) {
			continue
		}
		tool := displayTools[name]
		tools = append(tools, gateway.AgentTool{Type: "function", Function: gateway.ToolDefinition{Name: tool.name, Description: tool.description, Parameters: tool.schema}})
	}
	return tools
}

// takeSuggestions separates suggest_next from a round's calls.
//
// It is a note on the answer rather than a call the turn makes: it has no result worth a model
// round, so it never becomes a trace, a pending call or a stored tool call, and the calls that
// remain are the ones the turn runs. The last well-formed call wins, and a malformed one is
// dropped without a refusal, because nothing is left to read one.
func takeSuggestions(declared []string, calls []gateway.ToolCall) ([]gateway.ToolCall, []string) {
	if !contains(declared, SUGGEST_NEXT) {
		return calls, nil
	}
	var suggestions []string
	remaining := make([]gateway.ToolCall, 0, len(calls))
	for _, call := range calls {
		if call.Function.Name != SUGGEST_NEXT {
			remaining = append(remaining, call)
			continue
		}
		if parsed := parseSuggestions(call.Function.Arguments); parsed != nil {
			suggestions = parsed
		}
	}
	return remaining, suggestions
}

func parseSuggestions(arguments string) []string {
	var input SuggestNextInput
	if len(arguments) > capability.MAX_PAYLOAD_BYTES || strictUnmarshal([]byte(arguments), &input) != nil {
		return nil
	}
	var suggestions []string
	for _, suggestion := range input.Suggestions {
		suggestion = strings.Join(strings.Fields(suggestion), " ")
		if suggestion == "" || utf8.RuneCountInString(suggestion) > MAX_SUGGESTION_CHARS || contains(suggestions, suggestion) {
			continue
		}
		if suggestions = append(suggestions, suggestion); len(suggestions) == MAX_SUGGESTIONS {
			break
		}
	}
	return suggestions
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
	receipt, _ := json.Marshal(DisplayReceipt{IsRendered: true, Rows: len(view.Rows), Fields: view.Columns, Blocks: len(view.Blocks)})
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
	switch name {
	case RENDER_CHART:
		var input RenderChartInput
		if err := strictUnmarshal(generic, &input); err != nil {
			return View{}, err
		}
		return resolveChart(conversation, input)
	case RENDER_VIEW:
		var input RenderViewInput
		if err := strictUnmarshal(generic, &input); err != nil {
			return View{}, err
		}
		return resolveView(input)
	case RENDER_CANVAS:
		var input RenderCanvasInput
		if err := strictUnmarshal(generic, &input); err != nil {
			return View{}, err
		}
		return resolveCanvas(conversation, input)
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
	if input.Stacked && (input.Type == "line" || input.Type == "pie" || (input.Series == "" && len(input.Y) < 2)) {
		return View{}, refuse("stacked needs an area, column or bar chart with a series field or several y fields")
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
	view.Chart = &ChartSpec{Type: input.Type, X: input.X, Y: input.Y, Series: input.Series, Unit: strings.TrimSpace(input.Unit), Stacked: input.Stacked}
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

// resolveView checks a panel and keeps, for each block, only the fields its type reads.
//
// A panel's figures are the model's own statements, exactly as the sentences of its answer are:
// they are laid out, not resolved against a capability result. Rows that must be the capability's
// own figures belong in a chart or a table, which reference their source (ADR 0071).
func resolveView(input RenderViewInput) (View, error) {
	title, err := viewTitle(input.Title)
	if err != nil {
		return View{}, err
	}
	if len(input.Blocks) == 0 || len(input.Blocks) > MAX_VIEW_BLOCKS {
		return View{}, refuse("blocks must hold 1-%d blocks", MAX_VIEW_BLOCKS)
	}
	blocks := make([]ViewBlock, 0, len(input.Blocks))
	for index, block := range input.Blocks {
		kept, err := resolveBlock(block)
		if err != nil {
			return View{}, refuse("block %d: %s", index, capability.ErrorDetail(err))
		}
		blocks = append(blocks, kept)
	}
	return View{Kind: "panel", Title: title, Columns: []string{}, Rows: []map[string]any{}, Blocks: blocks}, nil
}

func resolveBlock(block ViewBlock) (ViewBlock, error) {
	if !contains(BLOCK_TYPES, block.Type) {
		return ViewBlock{}, refuse("type must be one of %s", strings.Join(BLOCK_TYPES, ", "))
	}
	kept := ViewBlock{Type: block.Type, Title: viewText(block.Title)}
	if utf8.RuneCountInString(kept.Title) > MAX_VIEW_TITLE_CHARS {
		return ViewBlock{}, refuse("title must be at most %d characters", MAX_VIEW_TITLE_CHARS)
	}
	if block.Type == "callout" {
		kept.Tone, kept.Text = block.Tone, viewText(block.Text)
		if kept.Tone == "" {
			kept.Tone = "info"
		}
		if !contains(CALLOUT_TONES, kept.Tone) {
			return ViewBlock{}, refuse("tone must be one of %s", strings.Join(CALLOUT_TONES, ", "))
		}
		if kept.Text == "" || utf8.RuneCountInString(kept.Text) > MAX_BLOCK_TEXT_CHARS {
			return ViewBlock{}, refuse("a callout needs text of 1-%d characters", MAX_BLOCK_TEXT_CHARS)
		}
		return kept, nil
	}
	if len(block.Items) == 0 || len(block.Items) > MAX_BLOCK_ITEMS {
		return ViewBlock{}, refuse("a %s block needs 1-%d items", block.Type, MAX_BLOCK_ITEMS)
	}
	for index, item := range block.Items {
		resolved, err := resolveItem(block.Type, item)
		if err != nil {
			return ViewBlock{}, refuse("item %d: %s", index, capability.ErrorDetail(err))
		}
		kept.Items = append(kept.Items, resolved)
	}
	return kept, nil
}

func resolveItem(blockType string, item ViewItem) (ViewItem, error) {
	kept := ViewItem{Label: viewText(item.Label)}
	if kept.Label == "" || utf8.RuneCountInString(kept.Label) > MAX_VIEW_FIELD_CHARS {
		return ViewItem{}, refuse("label must be 1-%d characters", MAX_VIEW_FIELD_CHARS)
	}
	value := viewText(item.Value)
	if utf8.RuneCountInString(value) > MAX_ITEM_TEXT_CHARS {
		return ViewItem{}, refuse("value must be at most %d characters", MAX_ITEM_TEXT_CHARS)
	}
	tone := item.Tone
	if tone != "" && !contains(ITEM_TONES, tone) {
		return ViewItem{}, refuse("tone must be one of %s", strings.Join(ITEM_TONES, ", "))
	}
	switch blockType {
	case "stats":
		if value == "" {
			return ViewItem{}, refuse("a stats item needs a value")
		}
		kept.Value, kept.Tone, kept.Delta = value, tone, viewText(item.Delta)
		if utf8.RuneCountInString(kept.Delta) > 24 {
			return ViewItem{}, refuse("delta must be at most 24 characters")
		}
		icon, err := viewIcon(item.Icon)
		if err != nil {
			return ViewItem{}, err
		}
		kept.Icon = icon
	case "fields":
		if value == "" {
			return ViewItem{}, refuse("a fields item needs a value")
		}
		kept.Value = value
	case "steps":
		kept.Text, kept.Status = viewText(item.Text), item.Status
		if utf8.RuneCountInString(kept.Text) > MAX_ITEM_TEXT_CHARS {
			return ViewItem{}, refuse("text must be at most %d characters", MAX_ITEM_TEXT_CHARS)
		}
		if kept.Status == "" {
			kept.Status = "pending"
		}
		if !contains(STEP_STATUSES, kept.Status) {
			return ViewItem{}, refuse("status must be one of %s", strings.Join(STEP_STATUSES, ", "))
		}
	case "meters":
		if item.Share == nil || *item.Share < 0 || *item.Share > 1 {
			return ViewItem{}, refuse("a meters item needs share between 0 and 1")
		}
		kept.Value, kept.Tone, kept.Share = value, tone, item.Share
	case "links":
		if !contains(CONSOLE_ROUTES, item.Route) {
			return ViewItem{}, refuse("route must be one of %s", strings.Join(CONSOLE_ROUTES, ", "))
		}
		kept.Route = item.Route
		icon, err := viewIcon(item.Icon)
		if err != nil {
			return ViewItem{}, err
		}
		kept.Icon = icon
	}
	return kept, nil
}

// viewIcon checks an icon reference's shape and nothing else. Which names exist is the console's
// knowledge - the whole Lucide set and the maker marks, both of which grow without this package
// changing - so an unknown name is drawn as a neutral mark there instead of failing the view here.
func viewIcon(icon string) (string, error) {
	icon = strings.TrimSpace(icon)
	if len(icon) > MAX_ICON_CHARS {
		return "", refuse("icon must be at most %d characters", MAX_ICON_CHARS)
	}
	for _, char := range icon {
		isAllowed := char == '-' || char == ':' || char == '.' || char == '_' ||
			(char >= '0' && char <= '9') || (char >= 'a' && char <= 'z') || (char >= 'A' && char <= 'Z')
		if !isAllowed {
			return "", refuse("icon is a Lucide name such as trending-up, or brand:<maker>")
		}
	}
	return icon, nil
}

func viewText(text string) string {
	return strings.Join(strings.Fields(text), " ")
}

func viewTitle(title string) (string, error) {
	title = strings.TrimSpace(title)
	if title == "" || utf8.RuneCountInString(title) > MAX_VIEW_TITLE_CHARS {
		return "", refuse("title must be 1-%d characters", MAX_VIEW_TITLE_CHARS)
	}
	return title, nil
}

// resolveCanvas freezes a canvas: the model's markup as written, and the rows it asked to read.
//
// The markup is not sanitised, because nothing here could do so reliably and the console does not
// depend on it: a canvas is only ever drawn inside a sandboxed frame with no origin and no network
// (ADR 0072). What is bounded here is cost - its size, and how many one turn may draw.
func resolveCanvas(conversation *Conversation, input RenderCanvasInput) (View, error) {
	title, err := viewTitle(input.Title)
	if err != nil {
		return View{}, err
	}
	if strings.TrimSpace(input.HTML) == "" || len(input.HTML) > MAX_CANVAS_BYTES {
		return View{}, refuse("html must be 1-%d bytes", MAX_CANVAS_BYTES)
	}
	if len(conversation.Turns) > 0 {
		drawn := 0
		for _, trace := range conversation.Turns[len(conversation.Turns)-1].Traces {
			if trace.Name == RENDER_CANVAS && trace.Result.Status == "success" {
				drawn++
			}
		}
		if drawn >= MAX_CANVASES_PER_TURN {
			return View{}, refuse("a turn draws at most %d canvases", MAX_CANVASES_PER_TURN)
		}
	}
	view := View{Title: title, Columns: []string{}, Rows: []map[string]any{}}
	switch {
	case input.Source != nil:
		if len(input.Fields) == 0 || len(input.Fields) > MAX_TABLE_COLUMNS {
			return View{}, refuse("fields must name 1-%d fields of the source rows", MAX_TABLE_COLUMNS)
		}
		if view, err = resolveRows(conversation, title, input.Source, nil, input.Fields); err != nil {
			return View{}, err
		}
	case len(input.Fields) > 0:
		return View{}, refuse("fields needs a source")
	}
	view.Kind, view.HTML = "canvas", input.HTML
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
			return View{}, refuse("row %d is not an object; path must lead to rows of objects, or to positional rows beside a columns list", index)
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
//
// Rows are objects, or positional arrays beside a `columns` list naming their fields - the shape
// `database_query` returns, and the most flexible source a chart can have - which are read into
// objects here so the rest of resolution sees one shape.
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
	var parent map[string]any
	if source.Path != "" {
		for _, segment := range strings.Split(source.Path, ".") {
			object, ok := current.(map[string]any)
			if !ok || segment == "" {
				return nil, refuse("path %q does not lead through objects in call %q", source.Path, source.CallID)
			}
			parent = object
			if current, ok = object[segment]; !ok {
				return nil, refuse("path %q: no field %q in call %q", source.Path, segment, source.CallID)
			}
		}
	}
	rows, ok := current.([]any)
	if !ok {
		return nil, refuse("path %q in call %q is not an array", source.Path, source.CallID)
	}
	return positionalRows(rows, parent), nil
}

// positionalRows reads rows that are arrays into objects keyed by the sibling `columns` list. Rows
// that are already objects, or arrays with no usable column list, are returned unchanged and meet
// the ordinary "not an object" refusal.
func positionalRows(rows []any, parent map[string]any) []any {
	names, ok := parent["columns"].([]any)
	if !ok || len(rows) == 0 {
		return rows
	}
	if _, isPositional := rows[0].([]any); !isPositional {
		return rows
	}
	columns := make([]string, len(names))
	for index, name := range names {
		text, isText := name.(string)
		if !isText {
			return rows
		}
		columns[index] = text
	}
	objects := make([]any, len(rows))
	for index, row := range rows {
		values, isPositional := row.([]any)
		if !isPositional || len(values) != len(columns) {
			return rows
		}
		object := make(map[string]any, len(columns))
		for position, column := range columns {
			object[column] = values[position]
		}
		objects[index] = object
	}
	return objects
}
