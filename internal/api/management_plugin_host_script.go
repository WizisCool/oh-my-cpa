package api

import (
	"bytes"
	"errors"
	"io"
	"strings"

	"github.com/tdewolff/parse/v2"
	"github.com/tdewolff/parse/v2/js"
	"golang.org/x/net/html"
)

var errPluginHostAdaptation = errors.New("plugin page could not be adapted")

// Keep the browser's native pathname and the frame inside the console mount.
// Scope-aware token replacement preserves comments, formatting and source-map
// coordinates while leaving examples, regexes and locally bound objects intact.
func hostPluginScript(body []byte) ([]byte, error) {
	if !bytes.Contains(body, []byte("location")) || !bytes.Contains(body, []byte("pathname")) {
		return body, nil
	}
	input := parse.NewInputBytes(body)
	defer input.Restore()
	tree, err := js.Parse(input, js.Options{})
	if err != nil {
		// Parser errors can quote source containing secrets; never surface their text.
		return nil, errPluginHostAdaptation
	}
	visitor := &pluginPathnameVisitor{pathnames: make(map[*byte]struct{})}
	js.Walk(visitor, tree)
	if len(visitor.pathnames) == 0 {
		return body, nil
	}
	// Literal token slices borrow the parser's input. Match their addresses back
	// to that buffer without reprinting the AST or changing source-map positions.
	source := input.Bytes()
	output := bytes.Clone(source)
	remaining := len(visitor.pathnames)
	for offset := range source {
		if _, hasPathname := visitor.pathnames[&source[offset]]; !hasPathname {
			continue
		}
		copy(output[offset:], "_omcPath")
		remaining--
		if remaining == 0 {
			return output, nil
		}
	}
	return nil, errPluginHostAdaptation
}

type pluginPathnameVisitor struct{ pathnames map[*byte]struct{} }

func (v *pluginPathnameVisitor) Enter(node js.INode) js.IVisitor {
	if _, isWith := node.(*js.WithStmt); isWith {
		// A with binding is resolved dynamically, not by the parser's lexical scope.
		return nil
	}
	switch member := node.(type) {
	case *js.DotExpr:
		if pluginMemberName(member.Y) == "pathname" && isPluginPageLocation(member.X) {
			v.recordPathname(member.Y)
		}
	case *js.IndexExpr:
		if pluginMemberName(member.Y) == "pathname" && isPluginPageLocation(member.X) {
			v.recordPathname(member.Y)
		}
	}
	return v
}

func (v *pluginPathnameVisitor) Exit(js.INode) {}

func (v *pluginPathnameVisitor) recordPathname(expression js.IExpr) {
	literal, _ := pluginMemberLiteral(expression)
	data := literal.Data
	if literal.TokenType == js.StringToken {
		data = data[1 : len(data)-1]
	}
	v.pathnames[&data[0]] = struct{}{}
}

func pluginMemberLiteral(expression js.IExpr) (js.LiteralExpr, bool) {
	switch value := expression.(type) {
	case js.LiteralExpr:
		return value, true
	case *js.LiteralExpr:
		return *value, true
	}
	return js.LiteralExpr{}, false
}

func pluginMemberName(expression js.IExpr) string {
	literal, isLiteral := pluginMemberLiteral(expression)
	if !isLiteral {
		return ""
	}
	if literal.TokenType == js.StringToken {
		return string(literal.Data[1 : len(literal.Data)-1])
	}
	if literal.TokenType == js.IdentifierToken {
		return string(literal.Data)
	}
	return ""
}

func isPluginGlobal(expression js.IExpr, name string) bool {
	variable, ok := expression.(*js.Var)
	if !ok {
		return false
	}
	for variable.Link != nil {
		variable = variable.Link
	}
	return variable.Decl == js.NoDecl && string(variable.Data) == name
}

func isPluginPageLocation(expression js.IExpr) bool {
	if group, ok := expression.(*js.GroupExpr); ok {
		return isPluginPageLocation(group.X)
	}
	if isPluginGlobal(expression, "location") {
		return true
	}
	var object js.IExpr
	switch member := expression.(type) {
	case *js.DotExpr:
		if pluginMemberName(member.Y) != "location" {
			return false
		}
		object = member.X
	case *js.IndexExpr:
		if pluginMemberName(member.Y) != "location" {
			return false
		}
		object = member.X
	default:
		return false
	}
	for _, name := range []string{"window", "self", "globalThis", "document"} {
		if isPluginGlobal(object, name) {
			return true
		}
	}
	return false
}

// Tokenizing HTML preserves the plugin's markup verbatim, including script data
// and its attribute quoting. Only executable script text needs JavaScript parsing.
func hostPluginInlineScripts(body []byte) ([]byte, error) {
	tokenizer := html.NewTokenizer(bytes.NewReader(body))
	var output bytes.Buffer
	isScript := false
	for {
		tokenType := tokenizer.Next()
		if tokenType == html.ErrorToken {
			if errors.Is(tokenizer.Err(), io.EOF) {
				return output.Bytes(), nil
			}
			return nil, errPluginHostAdaptation
		}
		raw := tokenizer.Raw()
		if tokenType == html.StartTagToken {
			token := tokenizer.Token()
			if token.Data == "script" {
				scriptType := "text/javascript"
				language := ""
				hasType := false
				hasSource := false
				for _, attribute := range token.Attr {
					if attribute.Key == "type" && !hasType {
						scriptType = attribute.Val
						hasType = true
					}
					if attribute.Key == "language" && language == "" {
						language = attribute.Val
					}
					if attribute.Key == "src" {
						hasSource = true
					}
				}
				if !hasType && language != "" {
					scriptType = "text/" + language
				} else if hasType && scriptType == "" {
					scriptType = "text/javascript"
				}
				isScript = !hasSource && (strings.EqualFold(scriptType, "module") || isPluginJavaScriptType(strings.ToLower(strings.Trim(scriptType, " \t\n\f\r"))))
			}
		} else if tokenType == html.EndTagToken {
			token := tokenizer.Token()
			if token.Data == "script" {
				isScript = false
			}
		} else if tokenType == html.TextToken && isScript {
			adapted, err := hostPluginScript(raw)
			if err != nil {
				return nil, err
			}
			raw = adapted
		}
		output.Write(raw)
	}
}

// Match JavaScript MIME type essence values, as script[type] does in browsers.
// Unlike an HTTP Content-Type, a script type with MIME parameters is data.
func isPluginJavaScriptType(mediaType string) bool {
	switch mediaType {
	case "application/ecmascript", "application/javascript", "application/x-ecmascript", "application/x-javascript",
		"text/ecmascript", "text/javascript", "text/javascript1.0", "text/javascript1.1", "text/javascript1.2",
		"text/javascript1.3", "text/javascript1.4", "text/javascript1.5", "text/jscript", "text/livescript",
		"text/x-ecmascript", "text/x-javascript":
		return true
	}
	return false
}
