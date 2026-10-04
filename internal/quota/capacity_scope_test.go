package quota

import "testing"

func TestSelectWindowUsageMatchesMeteredFamilies(t *testing.T) {
	groups := []ModelWindowUsage{
		{Model: "anthropic/claude-sonnet-4-5-20250929", Usage: WindowUsage{Requests: 2, PricedRequests: 1, Tokens: 100, CostNanos: 1000}},
		{Model: "claude-3-5-sonnet-20241022", Usage: WindowUsage{Requests: 1, PricedRequests: 1, Tokens: 50, CostNanos: 500}},
		{Model: "claude-opus-4-1", Usage: WindowUsage{Requests: 8, PricedRequests: 8, Tokens: 800, CostNanos: 8000}},
		{Model: "gemini-3-pro-preview", Usage: WindowUsage{Requests: 4, PricedRequests: 4, Tokens: 400, CostNanos: 4000}},
		{Model: "gpt-5(high)", Usage: WindowUsage{Requests: 5, PricedRequests: 5, Tokens: 500, CostNanos: 5000}},
	}
	cases := []struct {
		name     string
		window   QuotaWindow
		requests int64
		tokens   int64
	}{
		{"legacy Sonnet family", QuotaWindow{ID: "seven_day_sonnet", Scope: "model", Model: "claude-3-5-sonnet"}, 3, 150},
		{"Gemini group", QuotaWindow{Scope: "group", ModelFamilies: []string{"gemini"}}, 4, 400},
		{"external models group", QuotaWindow{Scope: "group", ModelFamilies: []string{"claude", "gpt"}}, 16, 1450},
		{"exact dated release", QuotaWindow{Scope: "model", Model: "claude-sonnet-4-5"}, 2, 100},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			actual, reason := SelectWindowUsage(testCase.window, groups)
			if reason != "" || actual.Requests != testCase.requests || actual.Tokens != testCase.tokens {
				t.Fatalf("usage=%+v reason=%q", actual, reason)
			}
		})
	}
}

func TestSelectWindowUsageFailsClosed(t *testing.T) {
	window := QuotaWindow{Scope: "group", ModelFamilies: []string{"gemini"}}
	groups := []ModelWindowUsage{{Model: "gemini-3-pro", Usage: WindowUsage{Requests: 1, Tokens: 100}}, {Model: "fast-alias", Usage: WindowUsage{Requests: 1, Tokens: 100}}}
	if actual, reason := SelectWindowUsage(window, groups); reason != CapacityReasonScopeUnknown || actual.Requests != 0 {
		t.Fatalf("partial scope accepted: %+v %q", actual, reason)
	}
	for _, window := range []QuotaWindow{{Scope: "group"}, {Scope: "model"}, {Scope: "group", ModelFamilies: []string{"gemini", "unreviewed-family"}}} {
		if _, reason := SelectWindowUsage(window, nil); reason != CapacityReasonScopeUnknown {
			t.Fatalf("unknown scope accepted: %+v", window)
		}
	}
	if actual, reason := SelectWindowUsage(QuotaWindow{Scope: "model", Model: "claude-sonnet-4-5"}, []ModelWindowUsage{{Model: "claude-sonnet-4-50", Usage: WindowUsage{Requests: 1}}}); reason != "" || actual.Requests != 0 {
		t.Fatal("exact identity expanded by prefix")
	}
	if families := AntigravityModelFamilies("Gemini and future models"); len(families) != 0 {
		t.Fatal("partial group name was guessed")
	}
}
