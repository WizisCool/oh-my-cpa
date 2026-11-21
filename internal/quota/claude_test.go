package quota

import (
	"testing"
)

func TestParseClaudeResetGrantsRejectsMalformedBlock(t *testing.T) {
	for _, testCase := range []struct {
		name string
		raw  string
	}{
		{name: "missing block", raw: `{}`},
		{name: "missing eligible", raw: `{"cedar_ember":{"grants":[]}}`},
		{name: "bad id", raw: `{"cedar_ember":{"eligible":true,"grants":[{"id":"BAD ID!","resets_total":1,"resets_left":1}]}}`},
		{name: "left exceeds total", raw: `{"cedar_ember":{"eligible":true,"grants":[{"id":"g1","resets_total":1,"resets_left":2}]}}`},
		{name: "float count", raw: `{"cedar_ember":{"eligible":true,"grants":[{"id":"g1","resets_total":1.5,"resets_left":1}]}}`},
		{name: "huge count", raw: `{"cedar_ember":{"eligible":true,"grants":[{"id":"g1","resets_total":1e300,"resets_left":1}]}}`},
		{name: "duplicate id", raw: `{"cedar_ember":{"eligible":true,"grants":[{"id":"g1","resets_total":1,"resets_left":1},{"id":"g1","resets_total":1,"resets_left":1}]}}`},
		{name: "bad timestamp", raw: `{"cedar_ember":{"eligible":true,"grants":[{"id":"g1","resets_total":1,"resets_left":1,"ends_at":"yesterday"}]}}`},
		{name: "non-boolean flag", raw: `{"cedar_ember":{"eligible":true,"grants":[{"id":"g1","resets_total":1,"resets_left":1,"paused":"no"}]}}`},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			if grants := ParseClaudeResetGrants([]byte(testCase.raw)); grants != nil {
				t.Fatalf("ParseClaudeResetGrants = %+v, want nil", grants)
			}
		})
	}
}

func TestParseClaudeProfilePlans(t *testing.T) {
	for _, testCase := range []struct {
		name      string
		raw       string
		wantType  string
		wantLabel string
		wantTier  string
	}{
		{
			name:      "team org with default_raven",
			raw:       `{"account":{"has_claude_pro":false,"has_claude_max":false},"organization":{"organization_type":"claude_team","seat_tier":"team_standard","rate_limit_tier":"default_raven"}}`,
			wantType:  "team",
			wantLabel: "Claude Team",
			wantTier:  "standard",
		},
		{
			name:      "team org with 5x seat rate_limit_tier resolves to Claude Team Premium",
			raw:       `{"account":{"has_claude_pro":false,"has_claude_max":false},"organization":{"organization_type":"claude_team","seat_tier":"team_tier_1","rate_limit_tier":"default_claude_max_5x"}}`,
			wantType:  "team_premium",
			wantLabel: "Claude Team Premium",
			wantTier:  "elite",
		},
		{
			name:      "team org with 20x seat rate_limit_tier resolves to Claude Team Premium",
			raw:       `{"account":{"has_claude_pro":false,"has_claude_max":false},"organization":{"organization_type":"claude_team","seat_tier":"team_tier_2","rate_limit_tier":"default_claude_max_20x"}}`,
			wantType:  "team_premium",
			wantLabel: "Claude Team Premium",
			wantTier:  "elite",
		},
		{
			name:      "team org with team_premium seat_tier resolves to Claude Team Premium",
			raw:       `{"account":{"has_claude_pro":false,"has_claude_max":false},"organization":{"organization_type":"claude_team","seat_tier":"team_premium","rate_limit_tier":"default_raven"}}`,
			wantType:  "team_premium",
			wantLabel: "Claude Team Premium",
			wantTier:  "elite",
		},
		{
			name:      "team org outranks personal consumer account flags",
			raw:       `{"account":{"has_claude_pro":true,"has_claude_max":true},"organization":{"organization_type":"claude_team","subscription_status":"active","rate_limit_tier":"default_raven"}}`,
			wantType:  "team",
			wantLabel: "Claude Team",
			wantTier:  "standard",
		},
		{
			name:      "team premium org outranks personal consumer max flags",
			raw:       `{"account":{"has_claude_pro":true,"has_claude_max":true},"organization":{"organization_type":"claude_team","subscription_status":"active","rate_limit_tier":"default_claude_max_5x"}}`,
			wantType:  "team_premium",
			wantLabel: "Claude Team Premium",
			wantTier:  "elite",
		},
		{
			name:      "personal max account with 5x rate_limit_tier stays Claude Max",
			raw:       `{"account":{"has_claude_pro":false,"has_claude_max":true},"organization":{"organization_type":"claude_max","subscription_status":"active","rate_limit_tier":"default_claude_max_5x"}}`,
			wantType:  "max",
			wantLabel: "Claude Max",
			wantTier:  "elite",
		},
		{
			name:      "personal max account with 20x rate_limit_tier resolves to Claude Ultra",
			raw:       `{"account":{"has_claude_pro":false,"has_claude_max":true},"organization":{"organization_type":"claude_max","subscription_status":"active","rate_limit_tier":" DEFAULT_CLAUDE_MAX_20X "}}`,
			wantType:  "ultra",
			wantLabel: "Claude Ultra",
			wantTier:  "elite",
		},
		{
			name:      "personal ultra org and tier resolve to Claude Ultra",
			raw:       `{"account":{"has_claude_pro":false,"has_claude_max":true},"organization":{"organization_type":"claude_ultra","subscription_status":"active"}}`,
			wantType:  "ultra",
			wantLabel: "Claude Ultra",
			wantTier:  "elite",
		},
		{
			name:      "default_claude_ultra rate_limit_tier resolves to Claude Ultra",
			raw:       `{"account":{"has_claude_pro":false,"has_claude_max":false},"organization":{"rate_limit_tier":"default_claude_ultra"}}`,
			wantType:  "ultra",
			wantLabel: "Claude Ultra",
			wantTier:  "elite",
		},
		{
			name:      "canceled team org falls back to personal consumer plan",
			raw:       `{"account":{"has_claude_pro":true,"has_claude_max":false},"organization":{"organization_type":"claude_team","subscription_status":"canceled","rate_limit_tier":"default_raven"}}`,
			wantType:  "pro",
			wantLabel: "Claude Pro",
			wantTier:  "premium",
		},
		{
			name:      "canceled org ignores default_claude_max_20x rate_limit_tier",
			raw:       `{"account":{"has_claude_pro":false,"has_claude_max":false},"organization":{"organization_type":"claude_team","subscription_status":"canceled","rate_limit_tier":"default_claude_max_20x"}}`,
			wantType:  "free",
			wantLabel: "Free",
			wantTier:  "free",
		},
		{
			name:      "inactive team org without consumer plan falls back to free",
			raw:       `{"account":{"has_claude_pro":false,"has_claude_max":false},"organization":{"organization_type":"claude_team","subscription_status":"inactive","rate_limit_tier":"default_raven"}}`,
			wantType:  "free",
			wantLabel: "Free",
			wantTier:  "free",
		},
		{
			name:      "consumer account max outranks claude_pro org type",
			raw:       `{"account":{"has_claude_pro":true,"has_claude_max":true},"organization":{"organization_type":"claude_pro","subscription_status":"active"}}`,
			wantType:  "max",
			wantLabel: "Claude Max",
			wantTier:  "elite",
		},
		{
			name:      "consumer free flags with claude_pro org type and default_claude_ai stay free",
			raw:       `{"account":{"has_claude_pro":false,"has_claude_max":false},"organization":{"organization_type":"claude_pro","subscription_status":"active","rate_limit_tier":"default_claude_ai"}}`,
			wantType:  "free",
			wantLabel: "Free",
			wantTier:  "free",
		},
		{
			name:      "enterprise org with default_raven",
			raw:       `{"account":{"has_claude_pro":false,"has_claude_max":false},"organization":{"organization_type":"claude_enterprise","rate_limit_tier":"default_raven"}}`,
			wantType:  "enterprise",
			wantLabel: "Claude Enterprise",
			wantTier:  "elite",
		},
		{
			name:      "org type resolves max without account flags or multiplier",
			raw:       `{"organization":{"organization_type":" CLAUDE_MAX "}}`,
			wantType:  "max",
			wantLabel: "Claude Max",
			wantTier:  "elite",
		},
		{
			name:      "org type with 20x rate_limit_tier resolves ultra without account flags",
			raw:       `{"organization":{"organization_type":" CLAUDE_MAX ","rate_limit_tier":"default_claude_max_20x"}}`,
			wantType:  "ultra",
			wantLabel: "Claude Ultra",
			wantTier:  "elite",
		},
		{
			name:      "org type resolves pro without account flags",
			raw:       `{"organization":{"organization_type":"claude_pro"}}`,
			wantType:  "pro",
			wantLabel: "Claude Pro",
			wantTier:  "premium",
		},
		{
			name:      "seat_tier fallback identifies team standard without organization_type",
			raw:       `{"account":{"has_claude_pro":false,"has_claude_max":false},"organization":{"seat_tier":"team_standard","rate_limit_tier":"default_raven"}}`,
			wantType:  "team",
			wantLabel: "Claude Team",
			wantTier:  "standard",
		},
		{
			name:      "seat_tier fallback with 5x rate_limit_tier identifies team premium",
			raw:       `{"account":{"has_claude_pro":false,"has_claude_max":false},"organization":{"seat_tier":"team_tier_1","rate_limit_tier":"default_claude_max_5x"}}`,
			wantType:  "team_premium",
			wantLabel: "Claude Team Premium",
			wantTier:  "elite",
		},
		{
			name:      "default_claude_max_5x fallback without org type or team seat resolves to Claude Max",
			raw:       `{"account":{"has_claude_pro":false,"has_claude_max":false},"organization":{"rate_limit_tier":"default_claude_max_5x"}}`,
			wantType:  "max",
			wantLabel: "Claude Max",
			wantTier:  "elite",
		},
		{
			name:      "seat_tier fallback identifies enterprise even with default_raven",
			raw:       `{"account":{"has_claude_pro":false,"has_claude_max":false},"organization":{"seat_tier":"enterprise_usage_based","rate_limit_tier":"default_raven"}}`,
			wantType:  "enterprise",
			wantLabel: "Claude Enterprise",
			wantTier:  "elite",
		},
		{
			name:      "enterprise_usage_based rate_limit_tier fallback identifies enterprise",
			raw:       `{"account":{"has_claude_pro":false,"has_claude_max":false},"organization":{"rate_limit_tier":"enterprise_usage_based"}}`,
			wantType:  "enterprise",
			wantLabel: "Claude Enterprise",
			wantTier:  "elite",
		},
		{
			name:      "default_raven fallback without organization_type",
			raw:       `{"account":{"has_claude_pro":false,"has_claude_max":false},"organization":{"rate_limit_tier":" DEFAULT_RAVEN "}}`,
			wantType:  "team",
			wantLabel: "Claude Team",
			wantTier:  "standard",
		},
		{
			name:      "default_raven_enterprise fallback without organization_type",
			raw:       `{"organization":{"rate_limit_tier":"default_raven_enterprise"}}`,
			wantType:  "enterprise",
			wantLabel: "Claude Enterprise",
			wantTier:  "elite",
		},
		{
			name:      "unrecognized organization_type still falls back to account flags",
			raw:       `{"account":{"has_claude_pro":true,"has_claude_max":false},"organization":{"organization_type":"personal","rate_limit_tier":"scale"}}`,
			wantType:  "pro",
			wantLabel: "Claude Pro",
			wantTier:  "premium",
		},
		{
			name:      "unrecognized rate_limit_tier keeps fallback behavior",
			raw:       `{"account":{"has_claude_pro":false,"has_claude_max":false},"organization":{"rate_limit_tier":"scale"}}`,
			wantType:  "scale",
			wantLabel: "scale",
			wantTier:  "standard",
		},
		{
			name:      "invalid json falls back to free",
			raw:       `{`,
			wantType:  "free",
			wantLabel: "Free",
			wantTier:  "free",
		},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			got := ParseClaudeProfile([]byte(testCase.raw))
			if got == nil || got.PlanType != testCase.wantType || got.PlanLabel != testCase.wantLabel || got.Tier != testCase.wantTier {
				t.Fatalf("ParseClaudeProfile(%s) = %+v, want %q/%q/%q", testCase.raw, got, testCase.wantType, testCase.wantLabel, testCase.wantTier)
			}
		})
	}
}
