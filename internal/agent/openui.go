package agent

import (
	"bytes"
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"
	"unicode/utf8"

	"github.com/google/jsonschema-go/jsonschema"
	"github.com/oh-my-cpa/oh-my-cpa/internal/capability"
	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/gateway"
)

// The Agent answers in OpenUI: the model writes an OpenUI Lang program into the official
// assistant-ui integration's tools, and the console renders it with the official OpenUI renderer.
//
//   - present_openui is the answer itself. It changes nothing, so it never reaches the executor: the
//     runtime checks the program's size, records the call, and a round that called only it ends
//     the turn, as the integration's own runtime policy does.
//   - prompt_openui is a form the turn waits on. It is a capability with an `answer` human input,
//     so the wait, the reply and its audit go through the same executor path every other question
//     to the operator does.
//
// The instructions that teach the language are generated from the official library by
// `pnpm openui:prompt` and embedded here, so the server, not the browser, owns what the model is told.
const (
	PRESENT_OPENUI = "present_openui"
	PROMPT_OPENUI  = "prompt_openui"
	// DATA_ROWS is the OpenUI Query tool that reads rows an earlier capability call returned. It is
	// served by the console's data-rows endpoint, never offered to the model as a function tool.
	DATA_ROWS = "data_rows"

	// MAX_OPENUI_PROGRAM_BYTES bounds one program. It is stored whole in its trace and resent in
	// the turn's history, so the bound is a payload boundary rather than a limit on an answer's
	// ambition: the official dashboards examples are a few kilobytes.
	MAX_OPENUI_PROGRAM_BYTES = 64 << 10
	// MAX_OPENUI_ANSWER_BYTES bounds what a submitted form returns to the model.
	MAX_OPENUI_ANSWER_BYTES  = 16 << 10
	MAX_OPENUI_MESSAGE_CHARS = 2000

	MAX_VIEW_ROWS        = 1000
	MAX_VIEW_FIELD_CHARS = 64
	MAX_SOURCE_FIELDS    = 12
	MAX_SOURCE_PATH      = 256
)

//go:embed openui/openui.json
var generatedOpenUI []byte

// generatedIntegration is the generated half of the integration: the official instructions for
// OMC's prompt options and the official tool descriptions.
type generatedIntegration struct {
	Instructions         string `json:"instructions"`
	PresentDescription   string `json:"present_description"`
	PromptDescription    string `json:"prompt_description"`
	ParameterDescription string `json:"parameter_description"`
}

var openUI = func() generatedIntegration {
	var generated generatedIntegration
	if err := json.Unmarshal(generatedOpenUI, &generated); err != nil || generated.Instructions == "" {
		panic("internal/agent/openui/openui.json is missing or malformed; run pnpm openui:prompt")
	}
	return generated
}()

// OpenUIInput is both tools' arguments: the program, as the official toolkit declares it.
type OpenUIInput struct {
	UI string `json:"ui"`
}

// OpenUIAction is what a submitted prompt_openui form returns: the official integration's action
// result, checked here because the browser that posts it is not the model that asked.
type OpenUIAction struct {
	Type      string         `json:"type"`
	Message   string         `json:"message"`
	Params    map[string]any `json:"params"`
	FormState map[string]any `json:"formState,omitempty"`
	FormName  string         `json:"formName,omitempty"`
}

// RETIRED_PRESENTATION_TOOLS are the display tools of the generative UI OpenUI replaced. A stored
// conversation may still name them: their calls changed nothing and their data is a receipt, which
// is what replacing a turn and listing data sources need to know about them.
var RETIRED_PRESENTATION_TOOLS = map[string]bool{"render_ui": true, "render_view": true, "render_canvas": true, "render_chart": true, "render_table": true}

// isPresentationCall reports whether a stored trace drew rather than read or changed anything.
func isPresentationCall(name string) bool {
	return name == PRESENT_OPENUI || RETIRED_PRESENTATION_TOOLS[name]
}

// DisplayToolNames is the set of display tools a run request may declare: what the console says it
// can draw. A console that declares none gets the Markdown prompt.
func DisplayToolNames() map[string]bool {
	return map[string]bool{PRESENT_OPENUI: true}
}

func openUIParameters() *jsonschema.Schema {
	return &jsonschema.Schema{
		Type:                 "object",
		Properties:           map[string]*jsonschema.Schema{"ui": {Type: "string", Description: openUI.ParameterDescription}},
		Required:             []string{"ui"},
		AdditionalProperties: &jsonschema.Schema{Not: &jsonschema.Schema{}},
	}
}

// DisplayToolDeclarations projects the declared display tools into the model's tool list.
func DisplayToolDeclarations(declared []string) []gateway.AgentTool {
	if !contains(declared, PRESENT_OPENUI) {
		return nil
	}
	return []gateway.AgentTool{{Type: "function", Function: gateway.ToolDefinition{Name: PRESENT_OPENUI, Description: openUI.PresentDescription, Parameters: openUIParameters()}}}
}

func contains(values []string, value string) bool {
	for _, item := range values {
		if item == value {
			return true
		}
	}
	return false
}

// toolFailure is a refusal the model can act on: the code says what kind, the detail which part of
// its own request to change. Nothing in the detail quotes stored data.
type toolFailure struct {
	code   string
	detail string
}

func (failure toolFailure) Error() string         { return failure.code }
func (failure toolFailure) FailureDetail() string { return failure.detail }

func refuse(format string, args ...any) error {
	return toolFailure{code: "invalid_tool_arguments", detail: fmt.Sprintf(format, args...)}
}

// readProgram decodes either tool's arguments. The program itself is checked by the renderer,
// which reports what it dropped; here only its presence and size are, because those are what the
// stored trace and the next round's history have to carry.
func readProgram(arguments string) (string, error) {
	var input OpenUIInput
	decoder := json.NewDecoder(strings.NewReader(arguments))
	decoder.DisallowUnknownFields()
	if len(arguments) > MAX_OPENUI_PROGRAM_BYTES+1024 || decoder.Decode(&input) != nil {
		return "", refuse("arguments must be {\"ui\": \"<OpenUI Lang program>\"}")
	}
	if strings.TrimSpace(input.UI) == "" || len(input.UI) > MAX_OPENUI_PROGRAM_BYTES {
		return "", refuse("ui must be a nonempty OpenUI Lang program of at most %d bytes", MAX_OPENUI_PROGRAM_BYTES)
	}
	return input.UI, nil
}

// presentOpenUI resolves one present_openui call. Its result is the official integration's own,
// so a replayed conversation reads the way assistant-ui expects.
func presentOpenUI(arguments string) capability.Result {
	if _, err := readProgram(arguments); err != nil {
		return capability.Result{Status: "error", Code: capability.ErrorCode(err), Detail: capability.ErrorDetail(err)}
	}
	return capability.Result{Status: "success", Data: json.RawMessage(`{"displayed":true}`)}
}

// isFinalPresentation ends a presentation-only round once its programs have been accepted for
// delivery. Rendering happens in the browser; this is not a rendering acknowledgement. A round
// that also read something, or whose program was refused, needs another round.
func isFinalPresentation(turn *Turn, calls []gateway.ToolCall) bool {
	if len(calls) == 0 {
		return false
	}
	for _, call := range calls {
		if call.Function.Name != PRESENT_OPENUI {
			return false
		}
		index := -1
		for position := range turn.Traces {
			if turn.Traces[position].ID == call.ID {
				index = position
			}
		}
		if index < 0 || turn.Traces[index].Result.Status != "success" {
			return false
		}
	}
	return true
}

// RegisterPromptOpenUI adds the official human tool as a capability. It is offered to the built-in
// Agent only: an external MCP client cannot render this console's forms.
func RegisterPromptOpenUI(registry *capability.Registry) error {
	metadata := capability.Metadata{Name: PROMPT_OPENUI, Description: openUI.PromptDescription, Version: 1, Permission: "read", Risk: "low", HumanInput: "answer", Adapters: []string{"agent"}}
	return capability.Register(registry, metadata, func(_ context.Context, input OpenUIInput) (capability.Preview, error) {
		if strings.TrimSpace(input.UI) == "" || len(input.UI) > MAX_OPENUI_PROGRAM_BYTES {
			return capability.Preview{}, refuse("ui must be a nonempty OpenUI Lang program of at most %d bytes", MAX_OPENUI_PROGRAM_BYTES)
		}
		return capability.Preview{Target: PROMPT_OPENUI}, nil
	}, func(_ context.Context, _ OpenUIInput, _, answer string) (OpenUIAction, error) {
		return readOpenUIAction(answer)
	})
}

// readOpenUIAction checks a submitted form. Everything in it is the operator's input to the model,
// so it is bounded and shaped, never interpreted.
func readOpenUIAction(raw string) (OpenUIAction, error) {
	var action OpenUIAction
	decoder := json.NewDecoder(strings.NewReader(raw))
	decoder.DisallowUnknownFields()
	if len(raw) > MAX_OPENUI_ANSWER_BYTES || decoder.Decode(&action) != nil || action.Type != "continue_conversation" {
		return OpenUIAction{}, errors.New("invalid_answer")
	}
	action.Message = strings.TrimSpace(action.Message)
	if utf8.RuneCountInString(action.Message) > MAX_OPENUI_MESSAGE_CHARS || action.Message == "" && len(action.FormState) == 0 {
		return OpenUIAction{}, errors.New("invalid_answer")
	}
	if action.Params == nil {
		action.Params = map[string]any{}
	}
	return action, nil
}

// DataRows is what the data_rows Query tool returns: the rows a data reference names, projected to
// the scalar fields its data_sources entry listed.
type DataRows struct {
	Rows   []map[string]any `json:"rows"`
	Fields []string         `json:"fields"`
}

// ReadDataRows resolves a data reference against the current conversation. The rows are the ones
// the capability call returned and the stored trace still holds, so a chart reads the same figures
// on every reload whatever the deployment's data has done since.
//
// A slow query's rows are reachable here too, and deliberately: the console withholds a
// database_query receipt's raw payload (`agentTraceForConsole`), while a data_rows reference
// carries only the scalar fields the trace's own data_sources listed, which is what lets an
// interface plot a query the model already read. What must never happen is a Query() call to
// database_query itself; `OpenUITools` leaves it out for that reason.
func (r *Runtime) ReadDataRows(ctx context.Context, dataRef string) (DataRows, error) {
	conversation, err := r.Current(ctx)
	if err != nil {
		return DataRows{}, err
	}
	for turnIndex := len(conversation.Turns) - 1; turnIndex >= 0; turnIndex-- {
		for _, trace := range conversation.Turns[turnIndex].Traces {
			for _, source := range findTraceDataSources(trace) {
				if source.DataRef != dataRef {
					continue
				}
				rows, err := projectRows(trace, source)
				if err != nil {
					return DataRows{}, err
				}
				return DataRows{Rows: rows, Fields: source.Fields}, nil
			}
		}
	}
	return DataRows{}, refuse("data_ref is unavailable in this conversation; copy one from a current data_sources entry")
}

// projectRows reads the array a source names and keeps its listed fields.
func projectRows(trace Trace, source DataReference) ([]map[string]any, error) {
	var data any
	decoder := json.NewDecoder(bytes.NewReader(trace.Result.Data))
	decoder.UseNumber()
	if decoder.Decode(&data) != nil {
		return nil, refuse("the referenced result is unreadable")
	}
	current := data
	var parent map[string]any
	if source.Path != "" {
		for _, segment := range strings.Split(source.Path, ".") {
			object, ok := current.(map[string]any)
			if !ok {
				return nil, refuse("the referenced path no longer leads to rows")
			}
			parent, current = object, object[segment]
		}
	}
	array, ok := current.([]any)
	if !ok {
		return nil, refuse("the referenced path no longer leads to rows")
	}
	rows := make([]map[string]any, 0, len(array))
	for _, item := range positionalRows(array, parent) {
		row, ok := item.(map[string]any)
		if !ok {
			return nil, refuse("the referenced rows are not objects")
		}
		kept := make(map[string]any, len(source.Fields))
		for _, field := range source.Fields {
			if value, exists := row[field]; exists {
				kept[field] = value
			}
		}
		rows = append(rows, kept)
	}
	return rows, nil
}

// positionalRows reads rows that are arrays into objects keyed by the sibling `columns` list - the
// shape database_query returns. Rows that are already objects, or arrays with no usable column
// list, are returned unchanged.
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

// OpenUITool is one capability an OpenUI program may name in a Query or Mutation, as the prompt
// generator and the console's tool provider read it.
type OpenUITool struct {
	Name         string             `json:"name"`
	Description  string             `json:"description"`
	Permission   string             `json:"permission"`
	InputSchema  *jsonschema.Schema `json:"input_schema"`
	OutputSchema *jsonschema.Schema `json:"output_schema"`
}

// OpenUITools is the part of the registry a rendered interface may call through the console's
// capability endpoint. A capability that waits on private operator input (a secret, an OAuth flow,
// an answer) is left out, because only the conversation's own cards collect those; so is
// database_query, whose rows stay out of the console and reach an interface only projected, by a
// data_rows reference.
func OpenUITools(definitions []*capability.Definition) []OpenUITool {
	tools := make([]OpenUITool, 0, len(definitions))
	for _, definition := range definitions {
		if definition.HumanInput != "" || definition.Name == "database_query" || !slices.Contains(definition.Adapters, "agent") {
			continue
		}
		tools = append(tools, OpenUITool{Name: definition.Name, Description: definition.Description, Permission: definition.Permission, InputSchema: definition.InputSchema, OutputSchema: definition.OutputSchema})
	}
	return tools
}
