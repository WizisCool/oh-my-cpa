package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestPluginHostScriptPathname(t *testing.T) {
	for _, pair := range []struct{ input, expected string }{
		{`const provider = location.pathname.split('/')[4];`, `const provider = __omcPluginHostLocation.pathname.split('/')[4];`},
		{`const provider = window.location.pathname.split('/')[4];`, `const provider = __omcPluginHostLocation.pathname.split('/')[4];`},
		{`const provider = document.location.pathname.split('/')[4];`, `const provider = __omcPluginHostLocation.pathname.split('/')[4];`},
		{`const provider = self.location.pathname.split('/')[4];`, `const provider = __omcPluginHostLocation.pathname.split('/')[4];`},
		{`const provider = globalThis.location.pathname.split('/')[4];`, `const provider = __omcPluginHostLocation.pathname.split('/')[4];`},
		{`const provider = window['location']['pathname'].split('/')[4];`, `const provider = __omcPluginHostLocation['pathname'].split('/')[4];`},
		{"const provider = `${window.location.pathname}`;", "const provider = `${__omcPluginHostLocation.pathname}`;"},
		{`location.pathname = '/v0/resource/plugins/example/other';`, `__omcPluginHostLocation.pathname = '/v0/resource/plugins/example/other';`},
	} {
		output, err := hostPluginScript([]byte(pair.input))
		if err != nil {
			t.Fatal(err)
		}
		if string(output) != pair.expected {
			t.Errorf("adapted %s: got %s, want %s", pair.input, output, pair.expected)
		}
	}
}

func TestPluginHostScriptPreservesUnrelatedCode(t *testing.T) {
	for _, input := range []string{
		`const example = 'window.location.pathname';`,
		`const example = /location.pathname/;`,
		"// location.pathname\nconst answer = 42;",
		"const example = `location.pathname`;",
		`const custom = other.location.pathname;`,
		`function example(location) { return location.pathname; }`,
		`function example(window) { return window.location.pathname; }`,
		`const location = {pathname: 'custom'}; location.pathname;`,
		`const path = location.href;`,
		`with (custom) { location.pathname; }`,
		`window.location["'pathname'"];`,
	} {
		output, err := hostPluginScript([]byte(input))
		if err != nil {
			t.Fatal(err)
		}
		if string(output) != input {
			t.Errorf("unrelated code changed: %s -> %s", input, output)
		}
	}
}

func TestPluginHostDocumentAdaptsOnlyExecutableScripts(t *testing.T) {
	input := `<html><head><script type="application/json">{"code":"location.pathname"}</script><script>const inline = window.location.pathname;</script><script type="module">export const modulePath = location.pathname;</script><script src="/v0/resource/plugins/example/app.js"></script></head></html>`
	output, err := hostPluginDocument([]byte(input), "/omc/api/v1/plugin-host")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(output), `<script type="application/json">{"code":"location.pathname"}</script>`) {
		t.Fatalf("JSON script changed: %s", output)
	}
	if strings.Count(string(output), "= __omcPluginHostLocation.pathname") != 2 {
		t.Fatalf("inline/module pathname not adapted: %s", output)
	}
	if !strings.Contains(string(output), `src="/omc/api/v1/plugin-host/v0/resource/plugins/example/app.js"`) {
		t.Fatalf("external script not rebased: %s", output)
	}
}

func TestPluginHostRefusesUnparseablePathnameScripts(t *testing.T) {
	if _, err := hostPluginScript([]byte(`const path = location.pathname; function {`)); !errors.Is(err, errPluginHostAdaptation) {
		t.Fatalf("parse refusal must exclude source snippets: %v", err)
	}
}

func TestPluginHostScriptPreservesSharedInputBuffer(t *testing.T) {
	for _, script := range []string{`const path = window.location.pathname;`, `const text = "location.pathname";`, `const path = location.pathname; function {`} {
		document := []byte(script + "</script><p>unchanged</p>")
		_, _ = hostPluginScript(document[:len(script)])
		if string(document) != script+"</script><p>unchanged</p>" {
			t.Fatalf("script parsing changed the HTML buffer: %q", document)
		}
	}
}

func TestPluginHostInlineScriptPreservesMarkup(t *testing.T) {
	input := []byte(`<html data-label='a &amp; b'><head><script type="application/ld+json">{"text":"window.location.pathname"}</script></head><body><p>&lt;location.pathname&gt;</p></body></html>`)
	output, err := hostPluginInlineScripts(input)
	if err != nil || string(output) != string(input) {
		t.Fatalf("markup changed: %s, %v", output, err)
	}
}

func TestPluginHostScriptTypes(t *testing.T) {
	for _, scriptType := range []string{"text/ecmascript", "application/ecmascript", "text/jscript", "text/javascript1.5", " TEXT/JAVASCRIPT "} {
		input := []byte(`<script type="` + scriptType + `">const path = location.pathname;</script>`)
		output, err := hostPluginInlineScripts(input)
		if err != nil || !strings.Contains(string(output), "__omcPluginHostLocation") {
			t.Fatalf("executable %q was not adapted: %s, %v", scriptType, output, err)
		}
	}
	for _, scriptType := range []string{"application/json", "importmap", "text/javascript; charset=utf-8", " module ", " "} {
		input := []byte(`<script type="` + scriptType + `">const path = location.pathname;</script>`)
		output, err := hostPluginInlineScripts(input)
		if err != nil || string(output) != string(input) {
			t.Fatalf("non-executable %q was changed: %s, %v", scriptType, output, err)
		}
	}
	if !isRebasedPluginText(pluginHostMediaType(http.Header{"Content-Type": {"text/ecmascript; charset=utf-8"}})) {
		t.Fatal("HTTP script MIME parameters prevented adaptation")
	}
}

func TestPluginHostAdaptationRefusal(t *testing.T) {
	writer := httptest.NewRecorder()
	writePluginHostError(writer, fmt.Errorf("synthetic private source excerpt: %w", errPluginHostAdaptation))
	var body map[string]any
	if err := json.Unmarshal(writer.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if writer.Code != http.StatusBadGateway || len(body) != 2 || body["code"] != "plugin_adaptation_refused" || body["error"] != "plugin page could not be adapted" {
		t.Fatalf("adaptation refusal: status=%d, body=%s", writer.Code, writer.Body.String())
	}
}

func TestPluginHostLegacyScriptLanguage(t *testing.T) {
	for _, attribute := range []string{`language="JavaScript"`, `language="ecmascript"`, `type="module"`, `type=""`} {
		output, err := hostPluginInlineScripts([]byte(`<script ` + attribute + `>const path = location.pathname;</script>`))
		if err != nil || !strings.Contains(string(output), "__omcPluginHostLocation") {
			t.Fatalf("executable %s was not adapted: %s, %v", attribute, output, err)
		}
	}
}
