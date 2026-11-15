package pricing

import (
	"testing"
	"time"
)

func TestCatalogMatchMetadata(t *testing.T) {
	catalog := NewCatalog([]UpstreamModel{
		{ID: "openai/gpt-5", Author: "openai", ContextLength: 400_000},
		{ID: "anthropic/claude-sonnet-4.5", CanonicalSlug: "anthropic/claude-4.5-sonnet-20250929", Author: "anthropic", ContextLength: 1_000_000},
		{ID: "openai/gpt-5.4-mini", Author: "openai", ContextLength: 400_000},
		{ID: "openai/gpt-5.1", Author: "openai", ContextLength: 400_000},
		{ID: "vendor/model", Author: "vendor", ContextLength: 128_000},
		{ID: "vendor/model-high", Author: "vendor", ContextLength: 256_000},
		{ID: "vendor/model-thinking-v2", CanonicalSlug: "vendor/model-thinking", Author: "vendor", ContextLength: 196_000},
		{ID: "a-vendor/shared-model", Author: "a-vendor", ContextLength: 64_000},
		{ID: "z-vendor/shared-model", Author: "z-vendor", ContextLength: 200_000},
		{ID: "vendor/online", Author: "vendor", ContextLength: 32_000},
	}, time.Now())

	cases := []struct {
		identity string
		wantID   string
	}{
		{"openai/gpt-5", "openai/gpt-5"},
		{"gpt-5", "openai/gpt-5"},
		{"gpt-5:free", "openai/gpt-5"},
		{"gpt-5:online", "openai/gpt-5"},
		{"gpt-5-high:online", "openai/gpt-5"},
		{"openai/gpt-5:free", "openai/gpt-5"},
		{"openai/gpt-5:online", "openai/gpt-5"},
		{"relay/gpt-5:online", "openai/gpt-5"},
		{"relay/gpt-5-high:online", "openai/gpt-5"},
		{"openai:gpt-5", "openai/gpt-5"},
		{"openai:gpt-5-high", "openai/gpt-5"},
		{"relay:gpt-5:online", "openai/gpt-5"},
		{"relay:gpt-5-high:online", "openai/gpt-5"},
		{"gpt-5-high:free", "openai/gpt-5"},
		{"relay/claude-sonnet-4-5-high", "anthropic/claude-sonnet-4.5"},
		{"claude-sonnet-4-5-thinking", "anthropic/claude-sonnet-4.5"},
		{"gpt-5.4-mini-xhigh", "openai/gpt-5.4-mini"},
		{"GPT-5.4-MINI-LOW", "openai/gpt-5.4-mini"},
		{"model-high", "vendor/model-high"},
		{"relay/model-high", "vendor/model-high"},
		{"model-thinking", "vendor/model-thinking-v2"},
		{"vendor/model-thinking", "vendor/model-thinking-v2"},
		{"vendor/model-thinking:online", "vendor/model-thinking-v2"},
		{"openai:model-thinking", "vendor/model-thinking-v2"},
		{"relay:online", "vendor/online"},
		{"relay/z-vendor/shared-model", "z-vendor/shared-model"},
	}
	for _, tc := range cases {
		got, ok := catalog.MatchMetadata(tc.identity)
		if !ok || got.ID != tc.wantID {
			t.Fatalf("MatchMetadata(%q) = (%q, %v), want (%q, true)", tc.identity, got.ID, ok, tc.wantID)
		}
	}

	// Billing MatchModel remains strict on tags and reasoning suffixes.
	for _, strictMiss := range []string{"gpt-5:free", "relay/claude-sonnet-4-5-high", "gpt-5.4-mini-xhigh"} {
		if match, ok := catalog.MatchModel(strictMiss); ok {
			t.Fatalf("billing MatchModel(%q) unexpectedly matched %q", strictMiss, match.Model.ID)
		}
	}

	// Read-only metadata lookup never strips multiple suffixes or guesses versions.
	for _, miss := range []string{"", "   ", "model-low-high", "gpt-5.10", "totally-unknown"} {
		if got, ok := catalog.MatchMetadata(miss); ok {
			t.Fatalf("MatchMetadata(%q) unexpectedly matched %q", miss, got.ID)
		}
	}
}
