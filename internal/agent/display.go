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

// render_ui is the Agent's model-selected presentation tool (ADR 0073, 0085, 0087):
// sandboxed markup and local interactions drawn inside the answer. It changes nothing, so it
// never passes through the executor, never prepares an operation and never interrupts a run.
//
// A canvas's data is referenced rather than transcribed. The model names a capability call of this
// conversation and a path to an array inside its result; the server resolves the reference,
// projects the named fields and freezes the rows into the call's trace. The figures a canvas plots
// are therefore the figures a capability returned - not the model's retelling of them - and they
// stay the same when the page reloads, whatever the deployment's data has done since. The model
// receives a small receipt instead of the rows, which is what keeps a chart from costing its data
// twice in tokens.
const (
	RENDER_VIEW   = "render_view"
	RENDER_CANVAS = "render_canvas"
	RENDER_UI     = "render_ui"
	FRAME_CARD    = "card"
	FRAME_NONE    = "none"
	SUGGEST_NEXT  = "suggest_next"

	MAX_VIEW_ROWS        = 1000
	MAX_VIEW_BYTES       = 96 << 10
	MAX_VIEW_TITLE_CHARS = 120
	MAX_VIEW_FIELD_CHARS = 64
	MAX_CANVAS_FIELDS    = 12
	MAX_SOURCE_PATH      = 256

	MAX_ICON_CHARS = 48

	// A canvas is the model's own markup, stored whole and resent inside the turn's tool call, so
	// its payload size is validated independently of how long the investigation runs.
	MAX_CANVAS_BYTES = 48 << 10
	// JSON escaping and the surrounding tool arguments add a small amount of
	// overhead beyond the HTML allowance. This is a payload boundary, not a
	// limit on a run or conversation.
	MAX_UI_ARGUMENT_BYTES = 128 << 10

	MAX_SUGGESTIONS      = 3
	MAX_SUGGESTION_CHARS = 80
)

// RETIRED_DISPLAY_TOOLS are display tools a stored conversation may still name. They
// are no longer offered, but a trace of one is still a call that changed nothing and
// whose data is a receipt, which is what the rules about replacing a turn and referencing rows ask.
var RETIRED_DISPLAY_TOOLS = map[string]bool{"render_chart": true, "render_table": true, RENDER_VIEW: true, RENDER_CANVAS: true}

// isDisplayCall reports whether a stored trace was a display call, current or retired.
func isDisplayCall(name string) bool {
	return displayTools[name] != nil || RETIRED_DISPLAY_TOOLS[name]
}

// DataSource points at the rows inside one earlier capability result.
type DataSource struct {
	DataRef string `json:"data_ref,omitempty" jsonschema:"Copy a data_ref from data_sources in a tool result; use this alone instead of call_id and path"`
	CallID  string `json:"call_id,omitempty" jsonschema:"Tool-call trace id, not operation_id; prefer data_ref"`
	Path    string `json:"path,omitempty" jsonschema:"Path rooted at result.data, e.g. data.groups for usage_aggregate or rows for database_query; not data.data.groups"`
}

// ViewBlock preserves stored panel content so existing conversations remain readable.
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

type RenderUIInput struct {
	Icons  []string    `json:"icons,omitempty" jsonschema:"Icon references used by OMC.icon or data-omc-icon: any Lucide name, brand:OpenAI, or custom:<id> from custom_icons_list or provider icon_id. Declare every icon used so artwork is embedded offline."`
	Title  string      `json:"title" jsonschema:"Short title for this interactive UI"`
	HTML   string      `json:"html" jsonschema:"Body markup with inline style and script, at most 48 KiB. It runs sandboxed with no network: nothing external loads. Theme colours are CSS variables (--bg --surface --fg --fg-2 --muted --border --accent --success --warn --danger --series-1 to --series-6). The page provides OMC.rows (the rows named by source); OMC.chart(target, {type, x, y, series, stacked, unit, rows}) with type line, area, column, bar or pie, x a field, y a list of numeric fields, and series a field that splits one y; OMC.table(target, {columns: [{field, label, unit}], rows}); OMC.diagram(target, {nodes: [{id, label, note, detail, tone, icon}], edges: [{from, to, label}]}) lays out an architecture, flow or topology and lets a node be picked to read its detail and connections; OMC.fmt(value, unit); OMC.icon(name, size) returns a DOM icon; data-omc-icon on a span mounts it automatically; OMC.compose(message) offers a follow-up draft for operator review, never executes operations. Use local controls, filters, forms and calculators when useful. Layout: the frame is about 720px wide on a desktop and 320px on a phone, its height follows the content up to 16384px. frame none supplies no padding, card ground or visible title; frame card supplies those. Use natural document height, not vh, fixed page height or a vertically scrolling page wrapper. Add no page margin or duplicate heading. Size everything to the frame: widths in %, fr or minmax() that fall to one column below 560px, no fixed width over 300px, at most three columns, no redundant nested cards, text 12px or larger, and a wide table inside an overflow-x:auto block. Compose from the frame's classes before writing CSS: omc-stack, omc-row, omc-grid (columns that fit themselves), omc-card, omc-stat (small label, b value, span note), omc-badge and omc-callout (data-tone success, warn, danger or accent), omc-kv on a dl, omc-field (a label holding an input and an output), and omc-tabs inside a data-omc-tabs block whose buttons carry data-tab and whose panels carry data-panel. Use OMC.diagram for anything with parts and connections rather than a grid of boxes; hand-drawn SVG needs a viewBox and width 100%. target is a CSS selector, unit is tokens, usd, ms, percent, bytes, time or number, and rows defaults to OMC.rows."`
	Source *DataSource `json:"source,omitempty" jsonschema:"Rows to pass in as OMC.rows"`
	Fields []string    `json:"fields,omitempty" jsonschema:"With source: 1-12 fields to pass"`
	Frame  string      `json:"frame,omitempty" jsonschema:"none (default): an inline component on the conversation with no border, ground or title bar. card: a titled, bordered figure. Put frame before html so its streaming preview uses the same presentation"`
}

type SuggestNextInput struct {
	Suggestions []string `json:"suggestions" jsonschema:"1-3 questions, at most 80 characters each"`
}

// View is a display call's frozen dataset, stored on its trace and drawn by the console.
type View struct {
	Kind    string           `json:"kind"`
	Title   string           `json:"title"`
	Columns []string         `json:"columns"`
	Rows    []map[string]any `json:"rows"`
	Source  *DataSource      `json:"source,omitempty"`
	// Blocks is a panel's content (ADR 0079): the model's own statements, laid out.
	Blocks []ViewBlock `json:"blocks,omitempty"`
	// HTML is a canvas's markup (ADR 0072), drawn only inside the console's sandboxed frame.
	HTML  string   `json:"html,omitempty"`
	Icons []string `json:"icons,omitempty"`
	// Frame is how the console sets the view into the answer (ADR 0082); empty means a card.
	Frame string `json:"frame,omitempty"`
}

// DisplayReceipt is all the model learns from a display call: that it rendered, and the shape of
// what it drew, so it can refer to what it drew without the rows coming back to it.
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
	SUGGEST_NEXT_DESCRIPTION = "Offer follow-up questions with your final answer text, never with another tool; ends the turn."
	RENDER_UI_DESCRIPTION    = "Compose an inline interactive component inside your answer using local HTML, SVG and script, reusable controls, icons and optional OMC charts or tables. Choose controls and layout that help the operator explore, compare, calculate or plan. OMC.compose offers a reviewed follow-up draft."
)

type displayTool struct {
	name        string
	description string
	schema      *jsonschema.Schema
	resolved    *jsonschema.Resolved
}

var displayTools = func() map[string]*displayTool {
	suggest, err := jsonschema.For[SuggestNextInput](nil)
	if err != nil {
		panic(err)
	}
	ui, err := jsonschema.For[RenderUIInput](nil)
	if err != nil {
		panic(err)
	}
	tools := map[string]*displayTool{
		SUGGEST_NEXT: {name: SUGGEST_NEXT, description: SUGGEST_NEXT_DESCRIPTION, schema: suggest},
		RENDER_UI:    {name: RENDER_UI, description: RENDER_UI_DESCRIPTION, schema: ui},
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
	return map[string]bool{RENDER_UI: true, SUGGEST_NEXT: true}
}

// DisplayToolDeclarations projects the declared display tools into the model's tool list, in a
// fixed order so the catalogue is stable between rounds.
func DisplayToolDeclarations(declared []string) []gateway.AgentTool {
	var tools []gateway.AgentTool
	for _, name := range []string{RENDER_UI, SUGGEST_NEXT} {
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
	// Allow JSON escaping of the declared HTML payload while bounding one tool argument.
	if len(arguments) > MAX_UI_ARGUMENT_BYTES {
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
	if json.Unmarshal(generic, &plain) != nil {
		return View{}, refuse("arguments must be a JSON object matching %s", name)
	}
	if err := tool.resolved.Validate(plain); err != nil {
		if detail := describeArgumentFailure(tool.schema, plain, "arguments"); detail != "" {
			return View{}, refuse("%s", detail)
		}
		return View{}, refuse("the arguments do not match the %s schema; check the declared field types", name)
	}
	if name == RENDER_UI {
		var input RenderUIInput
		if err := strictUnmarshal(generic, &input); err != nil {
			return View{}, err
		}
		return resolveUI(conversation, input)
	}
	return View{}, errors.New("capability_forbidden")
}

func strictUnmarshal(raw []byte, target any) error {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if decoder.Decode(target) != nil {
		return refuse("unknown or malformed field")
	}
	return nil
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
			return "", refuse("icon is a Lucide name such as trending-up, brand:<maker>, or custom:<id>")
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

// resolveUI freezes a canvas: the model's markup as written, and the rows it asked to read.
//
// The markup is not sanitised, because nothing here could do so reliably and the console does not
// depend on it: a canvas is only ever drawn inside a sandboxed frame with no origin and no network
// (ADR 0072). Payload validation protects the display boundary, not a task budget.
func resolveUI(conversation *Conversation, input RenderUIInput) (View, error) {
	title, err := viewTitle(input.Title)
	if err != nil {
		return View{}, err
	}
	if strings.TrimSpace(input.HTML) == "" || len(input.HTML) > MAX_CANVAS_BYTES {
		return View{}, refuse("html must be 1-%d bytes", MAX_CANVAS_BYTES)
	}
	for _, icon := range input.Icons {
		if reference, err := viewIcon(icon); err != nil || reference == "" {
			return View{}, refuse("icons must be nonempty references of at most %d characters", MAX_ICON_CHARS)
		}
	}
	if input.Frame != "" && input.Frame != FRAME_CARD && input.Frame != FRAME_NONE {
		return View{}, refuse("frame must be %s or %s", FRAME_CARD, FRAME_NONE)
	}
	view := View{Title: title, Columns: []string{}, Rows: []map[string]any{}}
	switch {
	case input.Source != nil:
		if len(input.Fields) == 0 || len(input.Fields) > MAX_CANVAS_FIELDS {
			return View{}, refuse("fields must name 1-%d fields of the source rows; put fields beside source and copy names from data_sources.fields", MAX_CANVAS_FIELDS)
		}
		if view, err = resolveRows(conversation, title, input.Source, input.Fields); err != nil {
			return View{}, err
		}
	case len(input.Fields) > 0:
		return View{}, refuse("fields needs a source")
	}
	view.Kind, view.HTML, view.Icons = "ui", input.HTML, input.Icons
	// Freeze the inline default explicitly; absent frame on an earlier stored view still means card.
	if input.Frame != FRAME_CARD {
		view.Frame = FRAME_NONE
	}
	return view, nil
}

// resolveRows reads the rows a display call references and keeps only the named fields, which must
// exist and hold scalars.
func resolveRows(conversation *Conversation, title string, source *DataSource, fields []string) (View, error) {
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
	resolved, err := resolveDataReference(conversation, *source)
	if err != nil {
		return View{}, err
	}
	source = &resolved
	rows, err := referencedRows(conversation, *source)
	if err != nil {
		return View{}, err
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
// `database_query` returns, and the most flexible source a canvas can have - which are read into
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
		for _, turn := range conversation.Turns {
			for _, candidate := range turn.Traces {
				if candidate.Result.OperationID == source.CallID && candidate.Result.Status == "success" && !isDisplayCall(candidate.Name) {
					return nil, refuse("source.call_id names an operation_id; the tool-call id is %q. Prefer source {data_ref} from data_sources", candidate.ID)
				}
			}
		}
		return nil, refuse("no capability call %q in this conversation; choose source {data_ref} from data_sources", source.CallID)
	}
	if isDisplayCall(trace.Name) || trace.Result.Status != "success" || len(trace.Result.Data) == 0 {
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
				return nil, refuse("source.path %q has no field %q in call %q; path starts inside result.data (usage_aggregate: data.groups). Prefer source {data_ref}", source.Path, segment, source.CallID)
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
