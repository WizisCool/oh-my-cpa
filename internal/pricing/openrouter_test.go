package pricing

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"
)

func loadFixtureCatalog(t *testing.T) Catalog {
	t.Helper()
	body, err := os.ReadFile("testdata/openrouter_models.json")
	if err != nil {
		t.Fatal(err)
	}
	models, err := DecodeOpenRouter(body)
	if err != nil {
		t.Fatal(err)
	}
	return NewCatalog(models, time.Unix(0, 0))
}

func TestDecodeOpenRouter(t *testing.T) {
	catalog := loadFixtureCatalog(t)
	for _, skipped := range []string{"openrouter/auto", "anthropic/claude-opus-5.5:batch", "qwen/qwen3.8-27b:free"} {
		if _, ok := catalog.Lookup(skipped); ok {
			t.Fatalf("%s must be skipped", skipped)
		}
	}
	opus, ok := catalog.Lookup("anthropic/claude-opus-5.5")
	if !ok {
		t.Fatal("opus missing")
	}
	// "0.000004" per token is exactly 4 per 1M.
	if opus.PromptPricePer1M != 4 || opus.CompletionPer1M != 20 || opus.CacheReadPer1M != 0.2 || opus.CacheWritePer1M != 5 {
		t.Fatalf("per-token rates not scaled exactly: %+v", opus)
	}
	if opus.Author != "anthropic" || opus.CanonicalSlug != "anthropic/claude-opus-5.5-20260921" {
		t.Fatalf("identity: %+v", opus)
	}
	// OpenRouter omits cache write for GLM: it is billed at the prompt rate.
	glm, _ := catalog.Lookup("z-ai/glm-5.3")
	if glm.CacheWritePer1M != glm.PromptPricePer1M || glm.CacheReadPer1M != 0.26 {
		t.Fatalf("missing cache write must fall back to the prompt rate: %+v", glm)
	}
	sonnet, _ := catalog.Lookup("anthropic/claude-sonnet-4.5")
	if len(sonnet.Tiers) != 1 || sonnet.Tiers[0].MinPromptTokens != 200_000 || *sonnet.Tiers[0].PromptPricePer1M != 6 {
		t.Fatalf("long-context override: %+v", sonnet.Tiers)
	}
	hy3, _ := catalog.Lookup("tencent/hy3")
	if len(hy3.Tiers) != 2 || !hy3.Tiers[0].HasWindow() || !hy3.Tiers[1].HasWindow() {
		t.Fatalf("time windows: %+v", hy3.Tiers)
	}
	// Tencent publishes no cache write; each window inherits its own prompt rate.
	for _, tier := range hy3.Tiers {
		if tier.CacheWritePer1M == nil || *tier.CacheWritePer1M != *tier.PromptPricePer1M {
			t.Fatalf("tier cache write must follow the tier prompt rate: %+v", tier)
		}
	}
	// The Gemini override lists no cache write while the base does: it inherits.
	gemini, _ := catalog.Lookup("google/gemini-2.5-pro")
	if gemini.Tiers[0].CacheWritePer1M != nil {
		t.Fatalf("an override must not invent a rate the base publishes: %+v", gemini.Tiers[0])
	}
}

func TestOpenRouterClientFetch(t *testing.T) {
	body, err := os.ReadFile("testdata/openrouter_models.json")
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write(body)
	}))
	defer server.Close()
	catalog, err := NewOpenRouterClientWithTransport(server.Client().Transport, server.URL).Fetch(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := catalog.Lookup("xiaomi/mimo-v2.5"); !ok {
		t.Fatal("fetched catalog is not indexed")
	}
	failing := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "down", http.StatusBadGateway)
	}))
	defer failing.Close()
	if _, err := NewOpenRouterClientWithTransport(failing.Client().Transport, failing.URL).Fetch(context.Background()); err == nil {
		t.Fatal("HTTP failure accepted")
	}
	empty := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"data":[]}`))
	}))
	defer empty.Close()
	if _, err := NewOpenRouterClientWithTransport(empty.Client().Transport, empty.URL).Fetch(context.Background()); err == nil {
		t.Fatal("an empty price list was accepted")
	}
}

func TestMatchOpenRouter(t *testing.T) {
	catalog := loadFixtureCatalog(t)
	cases := []struct {
		model, want, kind string
	}{
		{"claude-opus-5.5", "anthropic/claude-opus-5.5", MatchExact},
		{"anthropic/claude-opus-5.5", "anthropic/claude-opus-5.5", MatchExact},
		{"openai:gpt-6-sol", "openai/gpt-6-sol", MatchExact},
		{"claude-opus-5.5-20260921", "anthropic/claude-opus-5.5", MatchCanonical},
		{"claude-opus-5-5", "anthropic/claude-opus-5.5", MatchNormalized},
		// Different word order in the canonical slug: the date-stripped id wins.
		{"claude-sonnet-4-5-20250929", "anthropic/claude-sonnet-4.5", MatchDateStripped},
		// An exact id beats a dated sibling whose canonical slug strips to it.
		{"deepseek-v4-flash", "deepseek/deepseek-v4-flash", MatchExact},
		{"qwen3.8-max", "qwen/qwen3.8-max-0902", MatchDateStripped},
		{"GLM-5.3 Flash", "z-ai/glm-5.3-flash", MatchNormalized},
		{"claude-opus-latest", "~anthropic/claude-opus-latest", MatchAlias},
	}
	for _, tc := range cases {
		match, ok := catalog.MatchModel(tc.model)
		if !ok || match.Model.ID != tc.want || match.Kind != tc.kind {
			t.Fatalf("%s → %+v (%v), want %s/%s", tc.model, match.Model.ID, match.Kind, tc.want, tc.kind)
		}
	}
	for _, unmatched := range []string{"gpt-5.4-mini-high", "free", "batch", "totally-unknown"} {
		if match, ok := catalog.MatchModel(unmatched); ok {
			t.Fatalf("%s must not match, got %s", unmatched, match.Model.ID)
		}
	}
}

func TestStripDateSuffixKeepsYearMonthCodes(t *testing.T) {
	for in, want := range map[string]string{
		"claude-sonnet-4-5-20250929": "claude-sonnet-4-5",
		"gpt-5-2025-08-07":           "gpt-5",
		"command-a-plus-05-2026":     "command-a-plus",
		"qwen3.8-max-0902":           "qwen3.8-max",
		"qwen3-coder-2507":           "qwen3-coder-2507",
		"model-9999":                 "model-9999",
	} {
		if got := stripDateSuffix(in); got != want {
			t.Fatalf("stripDateSuffix(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestSuggestResemblingModels(t *testing.T) {
	catalog := loadFixtureCatalog(t)
	suggestions := catalog.Suggest("gpt-5.4-mini-high", 3)
	if len(suggestions) == 0 || suggestions[0].ID != "openai/gpt-5.4-mini" {
		t.Fatalf("suggestions: %+v", suggestions)
	}
	for _, suggestion := range catalog.Suggest("claude-opus-5.5-thinking", 5) {
		if suggestion.Author != "anthropic" {
			t.Fatalf("suggested another family's model: %s", suggestion.ID)
		}
	}
	if got := catalog.Suggest("zz", 3); len(got) != 0 {
		t.Fatalf("a two-letter name must not suggest anything: %+v", got)
	}
}

func TestMatchingKeepsNumericVersionBoundaries(t *testing.T) {
	catalog := NewCatalog([]UpstreamModel{{ID: "openai/gpt-5.1", Author: "openai"}}, time.Now())
	for _, name := range []string{"GPT 5 1", "gpt-5-1", "relay:gpt-5.1"} {
		if matched, ok := catalog.MatchModel(name); !ok || matched.Model.ID != "openai/gpt-5.1" {
			t.Fatalf("%s: %+v, %v", name, matched, ok)
		}
	}
	for _, name := range []string{"gpt-51", "gpt-5.10", "gpt-5.1-high"} {
		if matched, ok := catalog.MatchModel(name); ok {
			t.Fatalf("%s incorrectly matched %+v", name, matched)
		}
	}
}

func TestReasoningSuggestionPrefersResolvedCanonicalBase(t *testing.T) {
	catalog := NewCatalog([]UpstreamModel{
		{ID: "anthropic/claude-sonnet-4.5", CanonicalSlug: "anthropic/claude-4-5-sonnet-20250929", Author: "anthropic"},
		{ID: "anthropic/claude-4-5-sonnet-other", Author: "anthropic"},
	}, time.Now())
	for _, name := range []string{"claude-4-5-sonnet-high", "claude-4-5-sonnet(medium)", "relay/claude-4-5-sonnet-thinking"} {
		suggestions := catalog.Suggest(name, 3)
		if len(suggestions) == 0 || suggestions[0].ID != "anthropic/claude-sonnet-4.5" {
			t.Fatalf("%s: %+v", name, suggestions)
		}
		if matched, ok := catalog.MatchModel(name); ok {
			t.Fatalf("effort must stay a suggestion: %+v", matched)
		}
	}
}
