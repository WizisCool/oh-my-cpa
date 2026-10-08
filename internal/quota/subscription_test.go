package quota

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"testing"

	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/management"
)

func TestParseAntigravitySubscription(t *testing.T) {
	for _, test := range []struct{ name, payload, planType, tier string }{
		{"free", `{"currentTier":{"id":"free-tier"}}`, "free", "free"},
		{"paid wins", `{"currentTier":{"id":"free-tier"},"paidTier":{"id":"g1-ultra-tier"}}`, "ultra", "elite"},
		{"snake case", `{"paid_tier":{"id":"g1-ultra-lite-tier"}}`, "ultra-lite", "premium"},
		{"pro", `{"currentTier":{"id":"g1-pro-tier"}}`, "pro", "standard"},
		{"future tier", `{"currentTier":{"id":"future-tier","name":"Future plan"}}`, "unknown", "unknown"},
		{"no tier", `{}`, "", ""},
		{"invalid", `[]`, "", ""},
	} {
		t.Run(test.name, func(t *testing.T) {
			plan := ParseAntigravitySubscription([]byte(test.payload))
			if test.planType == "" {
				if plan != nil {
					t.Fatalf("unexpected plan: %+v", plan)
				}
				return
			}
			if plan == nil || plan.PlanType != test.planType || plan.Tier != test.tier {
				t.Fatalf("plan = %+v", plan)
			}
			if test.name == "future tier" && plan.PlanLabel != "Future plan" {
				t.Fatalf("unknown tier label = %q", plan.PlanLabel)
			}
		})
	}
}

func TestParseXaiSubscription(t *testing.T) {
	for _, test := range []struct{ name, user, settings, label, tier string }{
		{"display wins", `{"subscriptionTier":"SUPERGROK_HEAVY"}`, `{"subscription_tier_display":"SuperGrok Heavy"}`, "SuperGrok Heavy", "elite"},
		{"snake case", `{"subscription_tier":"supergrok"}`, `{}`, "supergrok", "premium"},
		{"settings only", `not-json`, `{"subscriptionTierDisplay":"Premium"}`, "Premium", "premium"},
		{"unknown label", `{"subscriptionTier":"future"}`, `{}`, "future", "standard"},
		{"missing", `{}`, `{}`, "", ""},
		{"invalid types", `{"subscriptionTier":123}`, `[]`, "", ""},
	} {
		t.Run(test.name, func(t *testing.T) {
			plan := ParseXaiSubscription([]byte(test.user), []byte(test.settings))
			if test.label == "" {
				if plan != nil {
					t.Fatalf("unexpected plan: %+v", plan)
				}
				return
			}
			if plan == nil || plan.PlanLabel != test.label || plan.Tier != test.tier {
				t.Fatalf("plan = %+v", plan)
			}
		})
	}
}

func TestSubscriptionRequestsAndIndependentFailures(t *testing.T) {
	for _, provider := range []string{"antigravity", "xai"} {
		for _, hasSubscriptionFailure := range []bool{false, true} {
			t.Run(provider+map[bool]string{true: " failed", false: " live"}[hasSubscriptionFailure], func(t *testing.T) {
				calls := map[string]management.ApiCallRequest{}
				client := &mockCPAClient{apiCallFunc: func(ctx context.Context, request management.ApiCallRequest) (management.ApiCallResponse, error) {
					calls[request.URL] = request
					body := ""
					switch request.URL {
					case AntigravityQuotaURLDaily:
						body = `{"groups":[{"displayName":"Gemini models","buckets":[{"bucketId":"five","remainingFraction":0.7,"window":"5h"}]}]}`
					case XaiBillingWeeklyURL:
						// The credits document is the subscription's own window, and it is the only one that
						// publishes a percentage for a subscription account. Its instants carry fractional
						// seconds, as upstream's do.
						body = `{"config":{"creditUsagePercent":30,"currentPeriod":{"type":"USAGE_PERIOD_TYPE_WEEKLY","start":"2026-09-17T13:32:42.093205+00:00","end":"2026-09-24T13:32:42.093205+00:00"}}}`
					case XaiBillingMonthlyURL:
						body = `{"config":{"monthlyLimit":{"val":10000},"used":{"val":3000}}}`
					case AntigravitySubscriptionURL:
						if request.Method != http.MethodPost || request.Data != `{"metadata":{"ideType":"ANTIGRAVITY"}}` {
							t.Fatalf("unexpected subscription shape: %+v", request)
						}
						body = `{"paidTier":{"id":"g1-ultra-tier"}}`
					case XaiSubscriptionURL:
						if request.Method != http.MethodGet || request.Data != "" {
							t.Fatalf("unexpected user shape: %+v", request)
						}
						body = `{"subscriptionTier":"SUPERGROK_HEAVY"}`
					case XaiSettingsURL:
						body = `{"subscription_tier_display":"SuperGrok Heavy"}`
					default:
						t.Fatalf("unexpected target %q", request.URL)
					}
					if hasSubscriptionFailure && (request.URL == AntigravitySubscriptionURL || request.URL == XaiSubscriptionURL || request.URL == XaiSettingsURL) {
						return management.ApiCallResponse{}, errors.New("synthetic transport failure")
					}
					return management.ApiCallResponse{StatusCode: 200, Body: json.RawMessage(body)}, nil
				}}
				file := management.AuthFile{AuthIndex: "quota-fixture", Type: provider, ProjectID: "fixture-project"}
				result, err := NewService(client).RefreshCredentialQuota(context.Background(), file, nil)
				if err != nil || result.Error != "" || len(result.Windows) != 1 {
					t.Fatalf("quota lost on supplemental probe: %+v %v", result, err)
				}
				if result.Plan == nil {
					t.Fatal("missing plan")
				}
				if !hasSubscriptionFailure && result.Plan.Tier != "elite" {
					t.Fatalf("live tier missing: %+v", result.Plan)
				}
				if provider == "antigravity" && hasSubscriptionFailure && result.Plan.Tier != "unknown" {
					t.Fatalf("invented Antigravity plan: %+v", result.Plan)
				}
				if provider == "xai" && (result.Plan.ExtraUsage == nil || result.Plan.ExtraUsage.UsedCreditsCents != 3000) {
					t.Fatalf("billing details lost: %+v", result.Plan)
				}
				if provider == "xai" {
					// The window comes from the credits document, and its period is the one that document
					// states: reading the ledger alone reported this account as having no window at all.
					window := result.Windows[0]
					if window.ID != "xai_credit_usage" || window.UsedPercent == nil || *window.UsedPercent != 30 {
						t.Fatalf("credit window = %+v, want the credits document's reading", window)
					}
					if window.PeriodHours == nil || *window.PeriodHours != 168 {
						t.Fatalf("period = %v, want the 168 hours the payload states", window.PeriodHours)
					}
					if window.ResetAtMS == nil || window.ResetAccuracy != "exact" {
						t.Fatalf("reset = %+v, want the fractional-second instant decoded", window)
					}
				}
				for _, request := range calls {
					if request.AuthIndex != file.AuthIndex || request.Header["Authorization"] != management.QuotaTokenPlaceholder {
						t.Fatalf("credential substitution missing: %+v", request)
					}
				}
			})
		}
	}
}

func TestAdditionalQuotaEndpointBoundaries(t *testing.T) {
	for _, endpoint := range []string{MetaUsageURL, XaiSubscriptionURL, XaiSettingsURL, AntigravitySubscriptionURL} {
		if !IsAllowedQuotaURL(endpoint) {
			t.Errorf("endpoint refused: %s", endpoint)
		}
		baseURL := strings.Split(endpoint, "?")[0]
		for _, suffix := range []string{"/extra", "-extra", "/../admin", "/%2e%2e/admin"} {
			if IsAllowedQuotaURL(baseURL + suffix) {
				t.Errorf("expanded endpoint allowed: %s", baseURL+suffix)
			}
		}
	}
	if IsAllowedQuotaURL("https://api.meta.ai/muse-code/chat") || IsAllowedQuotaURL("https://api.meta.ai.attacker.invalid/muse-code/key") {
		t.Fatal("Meta allowlist widened beyond its endpoint")
	}
}
