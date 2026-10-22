package pricing

import (
	"strings"
	"testing"
)

// The issue's synthetic rate card: priority doubles every rate.
func priorityPrice() ModelPrice {
	return ModelPrice{Model: "m", PromptPricePer1M: 2, CompletionPer1M: 10, CacheReadPer1M: 0.2, CacheWritePer1M: 2.5, PriceMultiplier: 1,
		Tiers: []PriceTier{{ServiceTiers: []string{"priority"}, PromptPricePer1M: ptr(4.0), CompletionPer1M: ptr(20.0), CacheReadPer1M: ptr(0.4), CacheWritePer1M: ptr(5.0)}}}
}

func TestQuotePriorityLane(t *testing.T) {
	tokens := Tokens{Input: 1_000, Output: 100}
	for _, test := range []struct {
		name, tier string
		wantNanos  int64
		wantTier   bool
	}{
		{"default", "default", 3_000_000, false},
		{"none", "", 3_000_000, false},
		{"priority", "priority", 6_000_000, true},
		{"spelling", " Priority ", 6_000_000, true},
		{"unknown", "flex", 3_000_000, false},
	} {
		breakdown, err := Quote(priorityPrice(), 1, tokens, 0, test.tier)
		if err != nil || breakdown.TotalNanos != test.wantNanos || (breakdown.TierIndex != nil) != test.wantTier {
			t.Errorf("%s: %+v %v", test.name, breakdown, err)
		}
	}
	cached, _ := Quote(priorityPrice(), 1, Tokens{Input: 1_000_000, CacheRead: 500_000, CacheWrite: 100_000}, 0, "priority")
	if want := int64((400_000*4 + 500_000*0.4 + 100_000*5) * 1000); cached.TotalNanos != want {
		t.Fatalf("priority cache rates: %d, want %d", cached.TotalNanos, want)
	}
}

func TestQuoteServiceTierInheritsAndZeroes(t *testing.T) {
	price := priorityPrice()
	price.Tiers = []PriceTier{{ServiceTiers: []string{"priority"}, CompletionPer1M: ptr(0.0)}}
	breakdown, err := Quote(price, 1, Tokens{Input: 1_000, Output: 100}, 0, "priority")
	// Input inherits the base 2/M; an explicit zero completion is free, not inherited.
	if err != nil || breakdown.TotalNanos != 2_000_000 {
		t.Fatalf("partial override: %+v %v", breakdown, err)
	}
}

func TestSelectTierServiceTierRanking(t *testing.T) {
	tiers := []PriceTier{
		{MinPromptTokens: 200_000, PromptPricePer1M: ptr(4.0)},
		{ServiceTiers: []string{"priority", "fast"}, PromptPricePer1M: ptr(5.0)},
		{ServiceTiers: []string{"priority"}, MinPromptTokens: 200_000, PromptPricePer1M: ptr(9.0)},
	}
	for _, test := range []struct {
		name  string
		input int64
		tier  string
		want  int
	}{
		{"short default", 10, "default", -1},
		{"long default", 300_000, "default", 0},
		{"short priority", 10, "priority", 1},
		{"short fast shares the lane", 10, "fast", 1},
		{"long priority takes the combined tier", 300_000, "priority", 2},
		// Without a combined tier the lane outranks the threshold: one tier, never a stack.
		{"long fast stays on its lane", 300_000, "fast", 1},
	} {
		index, ok := SelectTier(tiers, test.input, 0, test.tier)
		if !ok {
			index = -1
		}
		if index != test.want {
			t.Errorf("%s: selected %d, want %d", test.name, index, test.want)
		}
	}
}

func TestBilledServiceTier(t *testing.T) {
	for _, test := range []struct{ response, requested, tier, source string }{
		{"priority", "auto", "priority", ServiceTierFromResponse},
		{"default", "priority", "default", ServiceTierFromResponse},
		{"", "Priority", "priority", ServiceTierFromRequest},
		{"auto", "priority", "priority", ServiceTierFromRequest},
		{"", "auto", "", ""},
		{"  ", "", "", ""},
	} {
		tier, source := BilledServiceTier(test.response, test.requested)
		if tier != test.tier || source != test.source {
			t.Errorf("BilledServiceTier(%q, %q) = %q %q, want %q %q", test.response, test.requested, tier, source, test.tier, test.source)
		}
	}
}

func TestResolveServiceTier(t *testing.T) {
	for _, test := range []struct {
		name, provider, executor, requested, response, tier, source string
	}{
		{"codex priority", "codex", "", "priority", "default", "priority", ServiceTierFromRequest},
		{"codex fast", "codex", "", "fast", "auto", "fast", ServiceTierFromRequest},
		{"normalized identity", " CoDeX\t", "", " Priority ", "default", "priority", ServiceTierFromRequest},
		{"codex HTTP executor", "custom", "CodexExecutor", "priority", "default", "priority", ServiceTierFromRequest},
		{"codex websocket executor", "custom", "CodexWebsocketsExecutor", "priority", "default", "priority", ServiceTierFromRequest},
		{"explicit default", "codex", "", "default", "priority", "default", ServiceTierFromRequest},
		{"auto is not fast evidence", "codex", "", "auto", "priority", "", ServiceTierFromRequest},
		{"no outbound evidence", "codex", "", "auto", "default", "", ServiceTierFromRequest},
		{"missing client metadata", "codex", "", "", "priority", "priority", ServiceTierFromResponse},
		{"other provider downgrade", "openai", "OpenAIExecutor", "priority", "default", "default", ServiceTierFromResponse},
		{"provider display name", "my-codex", "", "priority", "default", "default", ServiceTierFromResponse},
		{"other provider unreported", "claude", "", "fast", "auto", "fast", ServiceTierFromRequest},
		{"no tier", "codex", "", "", "auto", "", ""},
	} {
		t.Run(test.name, func(t *testing.T) {
			tier, source := ResolveServiceTier(test.provider, test.executor, test.response, test.requested, "")
			if tier != test.tier || source != test.source {
				t.Fatalf("resolved %q from %q, want %q from %q", tier, source, test.tier, test.source)
			}
		})
	}
}

func TestServiceTierValidationAndEncoding(t *testing.T) {
	for name, tiers := range map[string][]PriceTier{
		"auto":       {{ServiceTiers: []string{"auto"}}},
		"empty name": {{ServiceTiers: []string{" "}}},
		"bad char":   {{ServiceTiers: []string{"pri ority"}}},
		"too long":   {{ServiceTiers: []string{strings.Repeat("p", 65)}}},
	} {
		if err := ValidateTiers(tiers); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
	if err := ValidateTiers([]PriceTier{{ServiceTiers: []string{"priority"}}}); err != nil {
		t.Fatalf("a service tier alone is a condition: %v", err)
	}
	encoded, err := EncodeTiers([]PriceTier{
		{ServiceTiers: []string{"Priority", "fast", "priority"}, PromptPricePer1M: ptr(4.0)},
		{MinPromptTokens: 200_000, PromptPricePer1M: ptr(3.0)},
	})
	want := `[{"min_prompt_tokens":200000,"prompt_price_per_1m":3},{"service_tiers":["fast","priority"],"prompt_price_per_1m":4}]`
	if err != nil || encoded != want {
		t.Fatalf("encoded %s %v, want %s", encoded, err, want)
	}
	// A price without service tiers stores the text it always did, so no version is minted.
	plain, _ := EncodeTiers([]PriceTier{{UTCStart: ptr(1600), UTCEnd: ptr(0), PromptPricePer1M: ptr(0.5)}, {MinPromptTokens: 200_000}})
	if plain != `[{"utc_start":1600,"utc_end":0,"prompt_price_per_1m":0.5},{"min_prompt_tokens":200000}]` {
		t.Fatalf("plain tiers respelled: %s", plain)
	}
}

func TestResolveOutboundServiceTier(t *testing.T) {
	for _, test := range []struct{ name, provider, executor, requested, response, effective, tier, source string }{
		{"server upgrade", "codex", "", "auto", "default", "priority", "priority", "outbound"},
		{"server downgrade", "codex", "", "priority", "default", "default", "default", "outbound"},
		{"server auto", "codex", "", "priority", "priority", "auto", "", "outbound"},
		{"normalized outbound", " CoDeX ", "", "auto", "default", " Priority\t", "priority", "outbound"},
		{"HTTP executor", "custom", "CodexExecutor", "auto", "default", "priority", "priority", "outbound"},
		{"websocket executor", "custom", "CodexWebsocketsExecutor", "priority", "priority", "default", "default", "outbound"},
		{"unreported", "codex", "", "priority", "default", "", "priority", "request"},
		{"blank outbound", "codex", "", "priority", "default", " \t", "priority", "request"},
		{"unreported client metadata", "codex", "", "", "priority", "", "priority", "response"},
		{"other provider", "openai", "OpenAIExecutor", "priority", "default", "priority", "default", "response"},
		{"future tier", "codex", "", "priority", "default", "flex", "flex", "outbound"},
	} {
		t.Run(test.name, func(t *testing.T) {
			tier, source := ResolveServiceTier(test.provider, test.executor, test.response, test.requested, test.effective)
			if tier != test.tier || source != test.source {
				t.Fatalf("resolved %q from %q, want %q from %q", tier, source, test.tier, test.source)
			}
		})
	}
}
