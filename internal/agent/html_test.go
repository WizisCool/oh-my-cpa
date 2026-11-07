package agent

import (
	"context"
	"encoding/json"
	"slices"
	"strings"
	"testing"

	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/gateway"
)

// htmlConsole is a console that draws both an interface and a page.
var htmlConsole = []string{PRESENT_OPENUI, PRESENT_HTML}

const htmlDocument = "<!doctype html><html><body><svg viewBox=\"0 0 8 8\"><circle cx=\"4\" cy=\"4\" r=\"3\"/></svg></body></html>"

func htmlCall(id, document string) gateway.ToolCall {
	arguments, _ := json.Marshal(HTMLInput{HTML: document})
	return gateway.ToolCall{ID: id, Type: "function", Function: gateway.ToolFunction{Name: PRESENT_HTML, Arguments: string(arguments)}}
}

// TestPresentHTMLFollowsTheConsoleAndThePresentation: a page is drawn only for a console that said
// it can draw one, and a turn asked for as text is offered neither display tool.
func TestPresentHTMLFollowsTheConsoleAndThePresentation(t *testing.T) {
	for name, test := range map[string]struct {
		input  Input
		offers bool
	}{
		"declaring console": {Input{Message: "q", DisplayTools: htmlConsole}, true},
		"interface only":    {Input{Message: "q", DisplayTools: openUIConsole}, false},
		"undeclared":        {Input{Message: "q"}, false},
		"text":              {Input{Message: "q", DisplayTools: htmlConsole, Present: PRESENT_TEXT}, false},
	} {
		t.Run(name, func(t *testing.T) {
			runtime := newTestRuntime(t)
			var offered []string
			runtime.Client = func(context.Context, string) (ModelClient, error) {
				return modelFunc(func(_ context.Context, _ string, _ []gateway.AgentMessage, tools []gateway.AgentTool, _ func(gateway.Event) error) (gateway.AgentReply, error) {
					offered = toolNames(tools)
					return gateway.AgentReply{Content: "ok"}, nil
				}), nil
			}
			runOnce(t, runtime, test.input)
			if slices.Contains(offered, PRESENT_HTML) != test.offers {
				t.Fatalf("offered %v", offered)
			}
		})
	}
	declarations, _ := json.Marshal(DisplayToolDeclarations(htmlConsole))
	if len(DisplayToolDeclarations(htmlConsole)) != 2 || !strings.Contains(string(declarations), `"name":"present_html"`) || !strings.Contains(string(declarations), `"required":["html"]`) {
		t.Errorf("present_html missing from upstream declarations: %s", declarations)
	}
}

// TestPresentedHTMLDocumentEndsTheTurn: a round that only drew a page is the answer, so no further
// round runs, and the document is kept as the call's arguments for the console to draw.
func TestPresentedHTMLDocumentEndsTheTurn(t *testing.T) {
	runtime := newTestRuntime(t)
	rounds := 0
	runtime.Client = func(context.Context, string) (ModelClient, error) {
		return modelFunc(func(_ context.Context, _ string, _ []gateway.AgentMessage, _ []gateway.AgentTool, _ func(gateway.Event) error) (gateway.AgentReply, error) {
			rounds++
			if rounds == 1 {
				return gateway.AgentReply{Calls: []gateway.ToolCall{htmlCall("page", htmlDocument)}}, nil
			}
			return gateway.AgentReply{Content: "unexpected round"}, nil
		}), nil
	}
	conversation := runOnce(t, runtime, Input{Message: "draw a page", DisplayTools: htmlConsole})
	turn := conversation.Turns[0]
	if rounds != 1 || turn.Status != "success" {
		t.Fatalf("rounds %d status %s", rounds, turn.Status)
	}
	page := turn.Traces[0]
	if page.Name != PRESENT_HTML || string(page.Result.Data) != `{"displayed":true}` || !strings.Contains(page.Arguments, "circle") {
		t.Fatalf("presented page %+v", page)
	}
}

// TestPresentHTMLAcceptsADocumentWhoseEscapingOutgrowsIt: the arguments are JSON, so a document
// dense with quotes and newlines is larger on the wire than its own bytes. The bound is the
// decoded document; a page just under the limit must not be refused for its escaping.
func TestPresentHTMLAcceptsADocumentWhoseEscapingOutgrowsIt(t *testing.T) {
	document := "<!doctype html>" + strings.Repeat("\"\n", (MAX_HTML_DOCUMENT_BYTES-len("<!doctype html>"))/2)
	arguments, _ := json.Marshal(HTMLInput{HTML: document})
	if len(document) > MAX_HTML_DOCUMENT_BYTES || len(arguments) <= MAX_HTML_DOCUMENT_BYTES+1024 {
		t.Fatalf("the case does not exercise escaping: document %d, arguments %d", len(document), len(arguments))
	}
	if result := presentHTML(string(arguments)); result.Status != "success" {
		t.Fatalf("refused a document of %d bytes: %+v", len(document), result)
	}
}

// TestPresentHTMLRefusesAMalformedDocument: the document is the answer, so a call the console could
// not draw comes back as a refusal the model can repair rather than an empty frame.
func TestPresentHTMLRefusesAMalformedDocument(t *testing.T) {
	for name, arguments := range map[string]string{
		"empty":      `{"html":"  "}`,
		"oversized":  `{"html":"` + strings.Repeat("a", MAX_HTML_DOCUMENT_BYTES+1) + `"}`,
		"shape":      `{"document":"<p>x</p>"}`,
		"unreadable": `{"html":`,
	} {
		t.Run(name, func(t *testing.T) {
			result := presentHTML(arguments)
			if result.Status != "error" || result.Code != "invalid_tool_arguments" || result.Detail == "" {
				t.Fatalf("accepted %s: %+v", name, result)
			}
		})
	}
	if result := presentHTML(`{"html":"<p>ok</p>"}`); result.Status != "success" {
		t.Fatalf("refused a page: %+v", result)
	}
}
