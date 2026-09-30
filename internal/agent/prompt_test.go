package agent

import (
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
	sections := promptSections(PromptContext{AnchorMS: 1, TimeZone: "Asia/Shanghai", Language: "zh", DisplayTools: []string{RENDER_CHART}})
	if got := sectionNames(sections); got != "identity,approach,data,safety,presentation,context" {
		t.Fatalf("sections %s", got)
	}
	for _, section := range sections {
		if strings.TrimSpace(section.Text) == "" {
			t.Fatalf("empty section %s", section.Name)
		}
	}
	prompt := SystemPrompt(PromptContext{AnchorMS: 1, TimeZone: "Asia/Shanghai", Language: "zh", DisplayTools: []string{RENDER_CHART}})
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
	if strings.Contains(plain, RENDER_CHART) || strings.Contains(plain, RENDER_TABLE) || !strings.Contains(plain, "Markdown tables") {
		t.Fatalf("undeclared display tools in prompt: %s", plain)
	}
	chart := SystemPrompt(PromptContext{AnchorMS: 1, DisplayTools: []string{RENDER_CHART}})
	if !strings.Contains(chart, RENDER_CHART) || strings.Contains(chart, RENDER_TABLE) || !strings.Contains(chart, "call_id") {
		t.Fatalf("chart prompt: %s", chart)
	}
	if strings.Contains(plain, "console language") {
		t.Fatal("language line without a language")
	}
}

func TestPromptMakesVisualizationsSelectiveFinalArtifacts(t *testing.T) {
	prompt := SystemPrompt(PromptContext{AnchorMS: 1, DisplayTools: []string{RENDER_CHART, RENDER_TABLE}})
	for _, phrase := range []string{"final conclusion", "final answer needs", "not progress reports or scratch work", "smallest set", "concise prose"} {
		if !strings.Contains(prompt, phrase) {
			t.Errorf("presentation rules lack %q: %s", phrase, prompt)
		}
	}
	if strings.Contains(prompt, "call render_chart") || strings.Contains(prompt, "call render_table") || strings.Contains(prompt, "more than about five rows") {
		t.Fatalf("display tools are still instructed as defaults: %s", prompt)
	}
}

func TestPromptFitsItsBudget(t *testing.T) {
	prompt := SystemPrompt(PromptContext{AnchorMS: 1, TimeZone: "America/Argentina/ComodRivadavia", Language: "zh-Hant", DisplayTools: []string{RENDER_CHART, RENDER_TABLE}})
	if len(prompt) > MAX_PROMPT_BYTES {
		t.Fatalf("system prompt is %d bytes against %d", len(prompt), MAX_PROMPT_BYTES)
	}
}
