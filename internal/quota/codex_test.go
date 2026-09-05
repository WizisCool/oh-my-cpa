package quota

import (
	"testing"
	"time"
)

func TestParseCodexUsageCurrentPayload(t *testing.T) {
	raw := []byte(`{
		"plan_type": "pro",
		"rate_limit": {
			"allowed": true,
			"limit_reached": false,
			"primary_window": {
				"used_percent": 1,
				"limit_window_seconds": 604800,
				"reset_after_seconds": 601888,
				"reset_at": 1785902974
			},
			"secondary_window": null
		},
		"code_review_rate_limit": null,
		"additional_rate_limits": [
			{
				"limit_name": "GPT-5.3-Codex-Spark",
				"metered_feature": "codex_bengalfox",
				"rate_limit": {
					"allowed": true,
					"limit_reached": false,
					"primary_window": {
						"used_percent": 0,
						"limit_window_seconds": 604800,
						"reset_after_seconds": 602111,
						"reset_at": 1785903197
					},
					"secondary_window": null
				}
			}
		],
		"rate_limit_reset_credits": {
			"available_count": 1,
			"applicable_available_count": 0
		}
	}`)

	nowMS := time.Date(2025, 1, 1, 0, 0, 0, 0, time.UTC).UnixMilli()
	plan, windows, credits, err := ParseCodexUsage(raw, nowMS)
	if err != nil {
		t.Fatalf("ParseCodexUsage failed: %v", err)
	}

	if plan.PlanType != "pro" || plan.Tier != "elite" || plan.PlanLabel != "Pro 20x" {
		t.Errorf("plan = %+v, want pro/elite/Pro 20x", plan)
	}

	if len(windows) != 2 {
		t.Fatalf("len(windows) = %d, want 2", len(windows))
	}

	// First window classified as weekly due to 604800s
	w1 := windows[0]
	if w1.ID != "weekly" {
		t.Errorf("w1.ID = %q, want weekly", w1.ID)
	}
	if w1.UsedPercent == nil || *w1.UsedPercent != 1.0 {
		t.Errorf("w1.UsedPercent = %v, want 1.0", w1.UsedPercent)
	}
	if w1.RemainingPercent == nil || *w1.RemainingPercent != 99.0 {
		t.Errorf("w1.RemainingPercent = %v, want 99.0", w1.RemainingPercent)
	}

	// Second window additional
	w2 := windows[1]
	if w2.Model != "GPT-5.3-Codex-Spark" {
		t.Errorf("w2.Model = %q, want GPT-5.3-Codex-Spark", w2.Model)
	}
	if w2.UsedPercent == nil || *w2.UsedPercent != 0.0 {
		t.Errorf("w2.UsedPercent = %v, want 0.0", w2.UsedPercent)
	}
	if w2.RemainingPercent == nil || *w2.RemainingPercent != 100.0 {
		t.Errorf("w2.RemainingPercent = %v, want 100.0", w2.RemainingPercent)
	}

	// Credits
	if credits == nil || credits.AvailableCount != 1 || credits.ApplicableAvailableCount != 0 {
		t.Errorf("credits = %+v, want available: 1, applicable: 0", credits)
	}
}

func TestParseCodexUsageCamelCaseAndClamping(t *testing.T) {
	raw := []byte(`{
		"planType": "plus",
		"rateLimit": {
			"primaryWindow": {
				"usedPercent": 140,
				"limitWindowSeconds": 18000,
				"resetAfterSeconds": 120
			}
		}
	}`)

	nowMS := time.Now().UnixMilli()
	plan, windows, _, err := ParseCodexUsage(raw, nowMS)
	if err != nil {
		t.Fatalf("ParseCodexUsage failed: %v", err)
	}

	if plan.Tier != "standard" || plan.PlanLabel != "Plus" {
		t.Errorf("plan = %+v, want standard/Plus", plan)
	}

	if len(windows) != 1 {
		t.Fatalf("len(windows) = %d, want 1", len(windows))
	}

	w := windows[0]
	if w.ID != "five_hour" {
		t.Errorf("w.ID = %q, want five_hour", w.ID)
	}
	if w.UsedPercent == nil || *w.UsedPercent != 100.0 {
		t.Errorf("w.UsedPercent clamped = %v, want 100.0", w.UsedPercent)
	}
	if w.RemainingPercent == nil || *w.RemainingPercent != 0.0 {
		t.Errorf("w.RemainingPercent clamped = %v, want 0.0", w.RemainingPercent)
	}
	if w.ResetAccuracy != "derived" {
		t.Errorf("w.ResetAccuracy = %q, want derived", w.ResetAccuracy)
	}
}

func TestParseCodexResetCreditsPayload(t *testing.T) {
	raw := []byte(`{
		"available_count": 3,
		"applicable_available_count": 1,
		"credits": [
			{
				"id": "credit-1",
				"status": "available",
				"reset_type": "codex_rate_limits",
				"granted_at": "1790000000",
				"expires_at": "1810000000"
			},
			{
				"id": "credit-2",
				"status": "used",
				"reset_type": "codex_rate_limits",
				"granted_at": "1790000000",
				"expires_at": "1805000000"
			},
			{
				"id": "credit-3",
				"status": "available",
				"reset_type": "sponsor_perk",
				"granted_at": "1790000000",
				"expires_at": "1820000000"
			},
			{
				"id": "credit-4",
				"status": "available",
				"grantedAt": "1790000000",
				"expiresAt": "1830000000"
			}
		]
	}`)

	info, err := ParseCodexResetCreditsPayload(raw)
	if err != nil {
		t.Fatalf("ParseCodexResetCreditsPayload returned error: %v", err)
	}
	if info.AvailableCount != 3 {
		t.Errorf("AvailableCount = %d, want 3", info.AvailableCount)
	}
	if info.ApplicableAvailableCount != 1 {
		t.Errorf("ApplicableAvailableCount = %d, want 1", info.ApplicableAvailableCount)
	}
	// Only codex_rate_limits + available credits survive: credit-1 and credit-4.
	if len(info.Credits) != 2 {
		t.Fatalf("len(credits) = %d, want 2", len(info.Credits))
	}
	first := info.Credits[0]
	if first.ID != "credit-1" || first.ExpiresAtMS == nil || *first.ExpiresAtMS != 1810000000000 {
		t.Errorf("first credit = %+v, want credit-1 expiring at 1810000000000", first)
	}
	if second := info.Credits[1]; second.ID != "credit-4" {
		t.Errorf("second credit = %+v, want credit-4 (camelCase fallback)", second)
	}
}
