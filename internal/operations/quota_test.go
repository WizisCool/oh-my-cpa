package operations

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/oh-my-cpa/oh-my-cpa/internal/quota"
)

func TestSafeQuotaIncludesSubscriptionWithoutRawSignals(t *testing.T) {
	isActive := false
	for _, plan := range []*quota.QuotaPlan{
		{PlanType: "meta", PlanLabel: "Muse Pro", Tier: "unknown", IsSubscriptionActive: &isActive},
		{PlanType: "standard", PlanLabel: "Kimi For Coding", Tier: "standard"},
		{PlanType: "pro_max", PlanLabel: "Pro 500", Tier: "elite"},
	} {
		t.Run(plan.PlanLabel, func(t *testing.T) {
			value := &quota.NormalizedQuota{AuthIndex: "fixture-plan", Plan: plan, RawSignals: map[string]string{"dca_token": "synthetic-private-token"}}
			safe := SafeQuota(value)
			if safe.Plan == nil || safe.Plan.PlanType != plan.PlanType || safe.Plan.PlanLabel != plan.PlanLabel || safe.Plan.Tier != plan.Tier {
				t.Fatalf("subscription missing: %+v", safe)
			}
			if plan.IsSubscriptionActive == nil {
				if safe.Plan.IsSubscriptionActive != nil {
					t.Fatal("subscription activity was inferred")
				}
			} else if safe.Plan.IsSubscriptionActive == nil || *safe.Plan.IsSubscriptionActive != *plan.IsSubscriptionActive {
				t.Fatal("subscription activity was not preserved")
			}
			encoded, err := json.Marshal(safe)
			if err != nil {
				t.Fatal(err)
			}
			if strings.Contains(string(encoded), "synthetic-private-token") || strings.Contains(string(encoded), "raw_signals") {
				t.Fatalf("unsafe agent result: %s", encoded)
			}
		})
	}
	if SafeQuota(&quota.NormalizedQuota{}).Plan != nil {
		t.Fatal("fabricated plan for unobserved credential")
	}
}
