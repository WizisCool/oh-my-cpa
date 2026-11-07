package agent

import (
	"encoding/json"
	"strings"

	"github.com/google/jsonschema-go/jsonschema"
	"github.com/oh-my-cpa/oh-my-cpa/internal/capability"
	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/gateway"
)

// The Agent can answer with a page as well as with an interface: the model writes one HTML
// document and the console draws it in a sandboxed frame. OpenUI stays the answer for questions
// about the deployment; present_html is for the times the operator asks for a page itself - a
// drawing, a hand-built chart, a small tool - which no component language expresses.
//
// Like present_openui it changes nothing, so it never reaches the executor: the runtime checks the
// document, records the call, and a round that called only display tools ends the turn.
const (
	PRESENT_HTML = "present_html"

	// MAX_HTML_DOCUMENT_BYTES bounds one document. It is stored whole in its trace and resent with
	// the turn's history, so the bound is a payload boundary like the OpenUI program's: a
	// single-file page with its styles, script and inline images fits inside it.
	MAX_HTML_DOCUMENT_BYTES = 64 << 10
)

// PRESENT_HTML_DESCRIPTION is what the model is told the tool is for. The frame has no network
// access, so an asset the document points at would arrive empty; the description says so before
// the model writes one.
const PRESENT_HTML_DESCRIPTION = "Draw a complete HTML document as the answer, in a sandboxed frame in the conversation. Use it when the operator asks for a web page, an HTML or SVG drawing, or a self-contained interactive page. Pass one complete document and inline its styles, scripts and images (data: URLs): the frame loads no remote assets. Do not also write the document as text."

// HTMLInput is the tool's arguments: the document, as the tool declares it.
type HTMLInput struct {
	HTML string `json:"html"`
}

func htmlParameters() *jsonschema.Schema {
	return &jsonschema.Schema{
		Type:                 "object",
		Properties:           map[string]*jsonschema.Schema{"html": {Type: "string", Description: "A complete HTML document of at most 64 KiB."}},
		Required:             []string{"html"},
		AdditionalProperties: &jsonschema.Schema{Not: &jsonschema.Schema{}},
	}
}

// readHTMLDocument decodes the tool's arguments. The document is drawn by the browser, which
// fences it; here only its presence and size are checked, because those are what the stored trace
// and the next round's history have to carry.
//
// The arguments are JSON, so the raw text can be larger than the document it carries: a quote or a
// newline costs two bytes, and a `\uXXXX` escape costs six. The pre-check bounds that worst case so
// a valid document is never refused for its escaping; the decoded length below is the limit.
func readHTMLDocument(arguments string) (string, error) {
	var input HTMLInput
	decoder := json.NewDecoder(strings.NewReader(arguments))
	decoder.DisallowUnknownFields()
	if len(arguments) > MAX_HTML_DOCUMENT_BYTES*6+1024 || decoder.Decode(&input) != nil {
		return "", refuse("arguments must be {\"html\": \"<complete HTML document>\"}")
	}
	if strings.TrimSpace(input.HTML) == "" || len(input.HTML) > MAX_HTML_DOCUMENT_BYTES {
		return "", refuse("html must be a nonempty document of at most %d bytes", MAX_HTML_DOCUMENT_BYTES)
	}
	return input.HTML, nil
}

// presentHTML resolves one present_html call. Its result is the same acknowledgement present_openui
// returns: rendering happens in the browser, so this is not a rendering acknowledgement.
func presentHTML(arguments string) capability.Result {
	if _, err := readHTMLDocument(arguments); err != nil {
		return capability.Result{Status: "error", Code: capability.ErrorCode(err), Detail: capability.ErrorDetail(err)}
	}
	return capability.Result{Status: "success", Data: json.RawMessage(`{"displayed":true}`)}
}

// presentDisplay resolves a display call by the tool that made it. Every display tool is the
// answer itself and changes nothing.
func presentDisplay(name, arguments string) capability.Result {
	if name == PRESENT_HTML {
		return presentHTML(arguments)
	}
	return presentOpenUI(arguments)
}

// DisplayToolNames is the set of display tools a run request may declare: what the console says it
// can draw. A console that declares none gets the Markdown prompt.
func DisplayToolNames() map[string]bool {
	return map[string]bool{PRESENT_OPENUI: true, PRESENT_HTML: true}
}

// DisplayToolDeclarations projects the declared display tools into the model's tool list, in a
// fixed order so the catalogue reads the same on every round.
func DisplayToolDeclarations(declared []string) []gateway.AgentTool {
	tools := make([]gateway.AgentTool, 0, 2)
	if contains(declared, PRESENT_OPENUI) {
		tools = append(tools, gateway.AgentTool{Type: "function", Function: gateway.ToolDefinition{Name: PRESENT_OPENUI, Description: openUI.PresentDescription, Parameters: openUIParameters()}})
	}
	if contains(declared, PRESENT_HTML) {
		tools = append(tools, gateway.AgentTool{Type: "function", Function: gateway.ToolDefinition{Name: PRESENT_HTML, Description: PRESENT_HTML_DESCRIPTION, Parameters: htmlParameters()}})
	}
	return tools
}
