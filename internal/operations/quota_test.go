package operations

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/oh-my-cpa/oh-my-cpa/internal/quota"
)

func TestSafeQuotaIncludesSubscriptionWithoutRawSignals(t *testing.T) {
	isActive := false
	value := &quota.NormalizedQuota{AuthIndex: "fixture-meta", Provider: "meta", Plan: &quota.QuotaPlan{PlanType: "meta", PlanLabel: "Muse Pro", Tier: "unknown", IsSubscriptionActive: &isActive}, RawSignals: map[string]string{"dca_token": "synthetic-private-token"}}
	safe := SafeQuota(value)
	if safe.Plan == nil || safe.Plan.PlanLabel != "Muse Pro" || safe.Plan.IsSubscriptionActive == nil || *safe.Plan.IsSubscriptionActive {
		t.Fatalf("subscription missing: %+v", safe)
	}
	encoded, err := json.Marshal(safe)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(encoded), "synthetic-private-token") || strings.Contains(string(encoded), "raw_signals") {
		t.Fatalf("unsafe agent result: %s", encoded)
	}
	if SafeQuota(&quota.NormalizedQuota{}).Plan != nil {
		t.Fatal("fabricated plan for unobserved credential")
	}
}
