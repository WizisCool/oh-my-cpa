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
		if r.URL.Query().Get("output_modalities") != "all" || r.URL.Query().Get("source") != "test" {
			http.Error(w, "missing all-modality filter or existing query parameter", http.StatusBadRequest)
			return
		}
		_, _ = w.Write(body)
	}))
	defer server.Close()
	catalog, err := NewOpenRouterClientWithTransport(server.Client().Transport, server.URL+"?source=test").Fetch(context.Background())
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
		{"gpt-image-2", "openai/gpt-image-2", MatchExact},
		{"gpt-image-2.5-sunburst", "openai/gpt-image-2.5-sunburst", MatchExact},
		{"gpt-image-2.6-flare", "openai/gpt-image-2.6-flare", MatchExact},
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

func TestDecodeOpenRouterImageOutput(t *testing.T) {
	for _, tc := range []struct {
		name, modalities, rates string
		wantOutput              float64
		wantSkipped             bool
	}{
		{"image output rate", `["image"]`, `"completion":"0.000008","image_output":"0.00003"`, 30, false},
		{"image rate without completion", `["image"]`, `"image_output":"0.00003"`, 30, false},
		{"missing image rate", `["image"]`, `"completion":"0.000008"`, 8, false},
		{"explicit zero image rate", `["image"]`, `"completion":"0.000008","image_output":"0"`, 0, false},
		{"invalid image rate", `["image"]`, `"completion":"0.000008","image_output":"-1"`, 8, false},
		{"mixed output retains text rate", `["image","text"]`, `"completion":"0.000015","image_output":"0.00003"`, 15, false},
		{"text output retains completion", `["text"]`, `"completion":"0.000008","image_output":"0.00003"`, 8, false},
		{"legacy modality metadata", `null`, `"completion":"0.000008","image_output":"0.00003"`, 8, false},
		{"unsupported audio output", `["audio"]`, `"completion":"0","audio_output":"0.01"`, 0, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			body := []byte(`{"data":[{"id":"openai/image-model","architecture":{"output_modalities":` + tc.modalities + `},"pricing":{"prompt":"0.000008","input_cache_read":"0.000002",` + tc.rates + `}}]}`)
			models, err := DecodeOpenRouter(body)
			if err != nil {
				t.Fatal(err)
			}
			if tc.wantSkipped {
				if len(models) != 0 {
					t.Fatalf("unsupported output received a token price: %+v", models)
				}
				return
			}
			if len(models) != 1 {
				t.Fatalf("want one priced model, got %+v", models)
			}
			model := models[0]
			if model.CompletionPer1M != tc.wantOutput || model.PromptPricePer1M != 8 || model.CacheReadPer1M != 2 {
				t.Fatalf("rates: %+v, want output %v with input 8 and cache read 2", model, tc.wantOutput)
			}
		})
	}
}

func TestDecodeOpenRouterImageOutputTiers(t *testing.T) {
	models, err := DecodeOpenRouter([]byte(`{"data":[{
		"id":"openai/image-model","architecture":{"output_modalities":["image"]},
		"pricing":{"prompt":"0.000008","completion":"0.000008","image_output":"0.00003","overrides":[
			{"min_prompt_tokens":100,"completion":"0.000016","image_output":"0.00006"},
			{"min_prompt_tokens":200,"completion":"0.000024"},
			{"min_prompt_tokens":300,"image_output":"0"}
		]}
	}]}`))
	if err != nil || len(models) != 1 {
		t.Fatalf("decode image tiers: %+v %v", models, err)
	}
	price := models[0].PriceFor("image-model", MatchExact, 1, 0)
	for _, tc := range []struct {
		input int64
		rate  float64
	}{{0, 30}, {100, 60}, {200, 30}, {300, 0}} {
		quote, err := Quote(price, 1, Tokens{Input: tc.input, Output: 1000}, 0, "")
		if err != nil || quote.Buckets[1].RatePer1M != tc.rate {
			t.Fatalf("input %d: quote %+v %v, want output rate %v", tc.input, quote, err, tc.rate)
		}
	}
}

func TestImageModelDoesNotMatchChatImageSibling(t *testing.T) {
	catalog := loadFixtureCatalog(t)
	chat, ok := catalog.Lookup("openai/gpt-5.4-image-2")
	if !ok {
		t.Fatal("chat image model missing from fixture")
	}
	withoutImage := NewCatalog([]UpstreamModel{chat}, time.Now())
	if match, ok := withoutImage.MatchModel("gpt-image-2"); ok {
		t.Fatalf("image generator matched a chat model: %+v", match)
	}
}
