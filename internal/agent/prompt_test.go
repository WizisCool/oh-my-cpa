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

// TestPromptSectionsAreOrderedAndComplete pins the prompt's structure: each concern in its own
// section, in a fixed order, so a presentation change cannot land in the safety rules.
func TestPromptSectionsAreOrderedAndComplete(t *testing.T) {
	sections := promptSections(PromptContext{AnchorMS: 1, TimeZone: "Asia/Shanghai", Language: "zh", DisplayTools: []string{RENDER_UI}})
	if got := sectionNames(sections); got != "identity,approach,data,safety,wording,presentation,context" {
		t.Fatalf("sections %s", got)
	}
	for _, section := range sections {
		if strings.TrimSpace(section.Text) == "" {
			t.Fatalf("empty section %s", section.Name)
		}
	}
	prompt := SystemPrompt(PromptContext{AnchorMS: 1, TimeZone: "Asia/Shanghai", Language: "zh", DisplayTools: []string{RENDER_UI}})
	for _, rule := range []string{"untrusted data", "NOT executed", "`rejected`", "`uncertain`", "ask_question", "database_query", "window", "Asia/Shanghai", "Simplified Chinese", "1970-01-01T00:00:00Z"} {
		if !strings.Contains(prompt, rule) {
			t.Errorf("prompt lacks %q", rule)
		}
	}
}

// TestPromptMentionsOnlyTheDisplayToolsItWasGiven: a model told to call a tool it does not have
// either fails the call or apologises for it, so the presentation rules follow the declaration.
func TestPromptMentionsOnlyTheDisplayToolsItWasGiven(t *testing.T) {
	plain := SystemPrompt(PromptContext{AnchorMS: 1})
	if strings.Contains(plain, RENDER_UI) || strings.Contains(plain, RENDER_VIEW) || !strings.Contains(plain, "Markdown tables") {
		t.Fatalf("undeclared display tools in prompt: %s", plain)
	}
	canvas := SystemPrompt(PromptContext{AnchorMS: 1, DisplayTools: []string{RENDER_UI}})
	if !strings.Contains(canvas, RENDER_UI) || strings.Contains(canvas, RENDER_VIEW) || !strings.Contains(canvas, "call_id") {
		t.Fatalf("canvas prompt: %s", canvas)
	}
	if strings.Contains(plain, "console language") {
		t.Fatal("language line without a language")
	}
	// A turn asked for as text is told about no display, whatever the console declared.
	text := SystemPrompt(PromptContext{AnchorMS: 1, DisplayTools: []string{RENDER_UI}, Present: PRESENT_TEXT})
	if strings.Contains(text, RENDER_UI) || strings.Contains(text, RENDER_VIEW) {
		t.Fatalf("text prompt: %s", text)
	}
}

func TestPromptLetsTheModelSelectIntelligentUI(t *testing.T) {
	prompt := SystemPrompt(PromptContext{AnchorMS: 1, DisplayTools: []string{RENDER_UI}})
	for _, phrase := range []string{"Draw without being asked", "OMC.diagram", "never repeat its numbers", "Local interactions", "OMC.compose", "custom_icons_list", "OMC.chart", "custom layouts and interaction logic", "drawn where you call render_ui", "frame none", "inline component", "frame card", "before html", "filters, forms, calculators"} {
		if !strings.Contains(prompt, phrase) {
			t.Errorf("presentation rules lack %q: %s", phrase, prompt)
		}
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

func TestPromptFitsItsBudget(t *testing.T) {
	// The fullest prompt a console can ask for still fits the per-round budget.
	for style := range TOKEN_STYLES {
		prompt := SystemPrompt(PromptContext{AnchorMS: 1, TimeZone: "America/Argentina/ComodRivadavia", Language: "zh-Hant", TokenStyle: style, DisplayTools: []string{RENDER_UI, SUGGEST_NEXT}, Present: PRESENT_CANVAS})
		if len(prompt) > MAX_PROMPT_BYTES {
			t.Fatalf("system prompt is %d bytes against %d", len(prompt), MAX_PROMPT_BYTES)
		}
		t.Logf("%s: %d bytes", style, len(prompt))
	}
}

func TestPromptStatesDomainWindowAndConfiguredModel(t *testing.T) {
	prompt := SystemPrompt(PromptContext{AnchorMS: 1, Model: "codex-auto-review", ReasoningEffort: "high", DisplayTools: []string{RENDER_UI}})
	for _, phrase := range []string{"client-requested model name", "[from_ms,to_ms)", "timestamp_ms < to_ms", "pricing and token-bucket evidence", "source {data_ref}", "not operation_id", "does not verify browser rendering", `"model":"codex-auto-review"`, `"reasoning_effort":"high"`, "actual upstream identity is unverified"} {
		if !strings.Contains(prompt, phrase) {
			t.Errorf("missing %q", phrase)
		}
	}
	full := SystemPrompt(PromptContext{AnchorMS: 1, Model: strings.Repeat("m", 512), ReasoningEffort: "xhigh", TimeZone: "America/Argentina/ComodRivadavia", Language: "zh-Hant", TokenStyle: "zh", DisplayTools: []string{RENDER_UI, SUGGEST_NEXT}, Present: PRESENT_CANVAS})
	if len(full) > MAX_PROMPT_BYTES {
		t.Fatalf("full prompt: %d bytes exceeds %d", len(full), MAX_PROMPT_BYTES)
	}
}

func TestPromptBoundsEscapedIdentityMetadata(t *testing.T) {
	prompt := SystemPrompt(PromptContext{AnchorMS: 1, Model: strings.Repeat("\x01", 512), ReasoningEffort: "high", TimeZone: "America/Argentina/ComodRivadavia", Language: "zh-Hant", TokenStyle: "zh", DisplayTools: []string{RENDER_UI, SUGGEST_NEXT}, Present: PRESENT_CANVAS})
	if len(prompt) > MAX_PROMPT_BYTES || !strings.Contains(prompt, "identity metadata was omitted") {
		t.Fatalf("escaped identity is unbounded: %d bytes", len(prompt))
	}
}

// The model learns the tools it can call, not the UI transport's implementation history.
func TestModelInstructionsDescribeAvailableCapabilities(t *testing.T) {
	for _, tool := range []string{RENDER_UI} {
		prompt := SystemPrompt(PromptContext{AnchorMS: 1, DisplayTools: []string{tool}})
		declarations, _ := json.Marshal(DisplayToolDeclarations([]string{tool}))
		for _, phrase := range []string{"older clients", "old client", "new client", "legacy", "compatibility", "deprecated", "旧客户端", "新客户端", "旧户"} {
			if strings.Contains(strings.ToLower(prompt+string(declarations)), phrase) {
				t.Errorf("model instructions contain %q", phrase)
			}
		}
		if !strings.Contains(prompt, tool) || strings.Contains(prompt, RENDER_CANVAS) || strings.Contains(prompt, RENDER_VIEW) {
			t.Errorf("prompt does not reflect declared tool %s: %s", tool, prompt)
		}
		if len(DisplayToolDeclarations([]string{tool})) != 1 || !strings.Contains(string(declarations), `"name":"render_ui"`) {
			t.Errorf("UI tool missing from upstream declarations: %s", declarations)
		}
	}
}
