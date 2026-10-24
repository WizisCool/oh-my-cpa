package agent

import (
	"encoding/json"
	"strings"
	"testing"
)

func sectionNames(sections []PromptSection) string {
	names := make([]string, 0, len(sections))
	for _, section := range sections {
		names = append(names, section.Name)
	}
	return strings.Join(names, ",")
}

// ownPromptBytes is the size of OMC's own sections: everything but the generated OpenUI
// instructions, which are the official library's and are bounded separately.
func ownPromptBytes(context PromptContext) int {
	size := 0
	for _, section := range promptSections(context) {
		if section.Text != openUI.Instructions {
			size += len(section.Text) + 2
		}
	}
	return size
}

var openUIConsole = []string{PRESENT_OPENUI}

// TestPromptSectionsAreOrderedAndComplete pins the prompt's structure: each concern in its own
// section, in a fixed order, so a presentation change cannot land in the safety rules.
func TestPromptSectionsAreOrderedAndComplete(t *testing.T) {
	context := PromptContext{AnchorMS: 1, TimeZone: "Asia/Shanghai", Language: "zh", DisplayTools: openUIConsole}
	sections := promptSections(context)
	if got := sectionNames(sections); got != "identity,approach,data,safety,wording,presentation,context" {
		t.Fatalf("sections %s", got)
	}
	for _, section := range sections {
		if strings.TrimSpace(section.Text) == "" {
			t.Fatalf("empty section %s", section.Name)
		}
	}
	prompt := SystemPrompt(context)
	for _, rule := range []string{"untrusted data", "NOT executed", "`rejected`", "`uncertain`", "prompt_openui", "database_query", "window", "Asia/Shanghai", "Simplified Chinese", "1970-01-01T00:00:00Z"} {
		if !strings.Contains(prompt, rule) {
			t.Errorf("prompt lacks %q", rule)
		}
	}
}

// TestPromptTeachesOpenUIOnlyToAConsoleThatRendersIt: the default answer is the official OpenUI
// instructions; a console that declared nothing, or a turn asked for as text, gets Markdown and is
// never told about a tool it does not have.
func TestPromptTeachesOpenUIOnlyToAConsoleThatRendersIt(t *testing.T) {
	openui := SystemPrompt(PromptContext{AnchorMS: 1, DisplayTools: openUIConsole})
	if !strings.Contains(openui, openUI.Instructions) || !strings.Contains(openui, "root = Card(") || !strings.Contains(openui, `Query("data_rows"`) || strings.Contains(openui, "Markdown tables") {
		t.Fatal("the default prompt does not carry the generated OpenUI instructions")
	}
	for name, context := range map[string]PromptContext{
		"undeclared": {AnchorMS: 1},
		"text":       {AnchorMS: 1, DisplayTools: openUIConsole, Present: PRESENT_TEXT},
	} {
		prompt := SystemPrompt(context)
		if strings.Contains(prompt, PRESENT_OPENUI) || strings.Contains(prompt, PROMPT_OPENUI) || !strings.Contains(prompt, "Markdown tables") {
			t.Errorf("%s prompt: %s", name, prompt)
		}
	}
	if strings.Contains(SystemPrompt(PromptContext{AnchorMS: 1}), "console language") {
		t.Fatal("language line without a language")
	}
}

// TestPromptAsksForAReadableAnswer: figures and names are written for the operator - in the
// console's own token style - rather than as the fields and identifiers a result carries.
func TestPromptAsksForAReadableAnswer(t *testing.T) {
	prompt := SystemPrompt(PromptContext{AnchorMS: 1})
	for _, phrase := range []string{"display name", "alias", "auth indexes", "failed requests", "K, M and B", "$0.0042", "2.4 s", "percentages", "never epoch numbers"} {
		if !strings.Contains(prompt, phrase) {
			t.Errorf("wording rules lack %q", phrase)
		}
	}
	if chinese := SystemPrompt(PromptContext{AnchorMS: 1, TokenStyle: "zh"}); !strings.Contains(chinese, "亿") || strings.Contains(chinese, "K, M and B") {
		t.Fatalf("the Chinese token scale is not stated: %s", chinese)
	}
	if full := SystemPrompt(PromptContext{AnchorMS: 1, TokenStyle: "full"}); !strings.Contains(full, "in full") {
		t.Fatal("the full token style is not stated")
	}
}

// TestPromptFitsItsBudget: OMC's own sections fit their per-round budget in the fullest context a
// console can ask for, and the generated OpenUI instructions stay near the size they were adopted at.
// Growth past either is a change to look at, not a limit a running turn meets.
func TestPromptFitsItsBudget(t *testing.T) {
	for style := range TOKEN_STYLES {
		context := PromptContext{AnchorMS: 1, Model: strings.Repeat("m", 512), ReasoningEffort: "xhigh", TimeZone: "America/Argentina/ComodRivadavia", Language: "zh-Hant", TokenStyle: style, DisplayTools: openUIConsole}
		if size := ownPromptBytes(context); size > MAX_PROMPT_BYTES {
			t.Fatalf("OMC's sections are %d bytes against %d", size, MAX_PROMPT_BYTES)
		}
	}
	if len(openUI.Instructions) > 112<<10 {
		t.Fatalf("generated OpenUI instructions grew to %d bytes; check the catalogue and prompt options", len(openUI.Instructions))
	}
}

func TestPromptStatesDomainWindowAndConfiguredModel(t *testing.T) {
	prompt := SystemPrompt(PromptContext{AnchorMS: 1, Model: "codex-auto-review", ReasoningEffort: "high", DisplayTools: openUIConsole})
	for _, phrase := range []string{"client-requested model name", "[from_ms,to_ms)", "timestamp_ms < to_ms", "pricing and token-bucket evidence", `"model":"codex-auto-review"`, `"reasoning_effort":"high"`, "actual upstream identity is unverified"} {
		if !strings.Contains(prompt, phrase) {
			t.Errorf("missing %q", phrase)
		}
	}
}

func TestPromptBoundsEscapedIdentityMetadata(t *testing.T) {
	context := PromptContext{AnchorMS: 1, Model: strings.Repeat("\x01", 512), ReasoningEffort: "high", TimeZone: "America/Argentina/ComodRivadavia", Language: "zh-Hant", TokenStyle: "zh", DisplayTools: openUIConsole}
	if size := ownPromptBytes(context); size > MAX_PROMPT_BYTES || !strings.Contains(SystemPrompt(context), "identity metadata was omitted") {
		t.Fatalf("escaped identity is unbounded: %d bytes", size)
	}
}

// The model learns the tools it can call, not the UI transport's implementation history.
func TestModelInstructionsDescribeAvailableCapabilities(t *testing.T) {
	declarations, _ := json.Marshal(DisplayToolDeclarations(openUIConsole))
	own := SystemPrompt(PromptContext{AnchorMS: 1})
	for _, phrase := range []string{"older clients", "old client", "new client", "legacy", "compatibility", "旧客户端", "新客户端", "render_ui", "canvas"} {
		if strings.Contains(strings.ToLower(own+string(declarations)), phrase) {
			t.Errorf("model instructions contain %q", phrase)
		}
	}
	if len(DisplayToolDeclarations(openUIConsole)) != 1 || !strings.Contains(string(declarations), `"name":"present_openui"`) || !strings.Contains(string(declarations), `"required":["ui"]`) {
		t.Errorf("present_openui missing from upstream declarations: %s", declarations)
	}
}
