package quota

import (
	"testing"
	"time"
)

func TestParseClaudeUsageAndFable(t *testing.T) {
	modernReset := "2026-07-27T10:00:00.000Z"
	raw := []byte(`{
		"five_hour": {
			"utilization": 25.5,
			"resets_at": "` + modernReset + `"
		},
		"seven_day": {
			"utilization": 80.0,
			"resets_at": "` + modernReset + `"
		},
		"limits": [
			{
				"kind": "weekly_scoped",
				"percent": 64,
				"resets_at": "` + modernReset + `",
				"is_active": true,
				"scope": {
					"model": {
						"id": null,
						"display_name": "Fable"
					}
				}
			}
		],
		"extra_usage": {
			"is_enabled": true,
			"monthly_limit": 5000,
			"used_credits": 2500,
			"utilization": 50.0
		}
	}`)

	nowMS := time.Date(2025, 1, 1, 0, 0, 0, 0, time.UTC).UnixMilli()
	windows, extraUsage, err := ParseClaudeUsage(raw, nowMS)
	if err != nil {
		t.Fatalf("ParseClaudeUsage failed: %v", err)
	}

	if len(windows) != 3 {
		t.Fatalf("len(windows) = %d, want 3", len(windows))
	}

	// 5-hour
	w0 := windows[0]
	if w0.ID != "five_hour" || *w0.UsedPercent != 25.5 || *w0.RemainingPercent != 74.5 {
		t.Errorf("w0 = %+v", w0)
	}

	// seven_day
	w1 := windows[1]
	if w1.ID != "seven_day" || *w1.UsedPercent != 80.0 || *w1.RemainingPercent != 20.0 {
		t.Errorf("w1 = %+v", w1)
	}

	// Fable
	w2 := windows[2]
	if w2.ID != "seven_day_fable" || *w2.UsedPercent != 64.0 || *w2.RemainingPercent != 36.0 {
		t.Errorf("w2 = %+v", w2)
	}

	// Extra usage
	if extraUsage == nil || !extraUsage.IsEnabled || extraUsage.MonthlyLimitCents != 5000 || extraUsage.UsedCreditsCents != 2500 {
		t.Errorf("extraUsage = %+v", extraUsage)
	}
}

func TestParseClaudeProfile(t *testing.T) {
	rawPro := []byte(`{
		"account": { "has_claude_pro": true, "has_claude_max": false },
		"organization": { "rate_limit_tier": "scale" }
	}`)
	planPro := ParseClaudeProfile(rawPro)
	if planPro.PlanType != "pro" || planPro.Tier != "premium" || planPro.PlanLabel != "Claude Pro" {
		t.Errorf("planPro = %+v", planPro)
	}

	rawMax := []byte(`{
		"account": { "has_claude_pro": true, "has_claude_max": true }
	}`)
	planMax := ParseClaudeProfile(rawMax)
	if planMax.PlanType != "max" || planMax.Tier != "elite" || planMax.PlanLabel != "Claude Max" {
		t.Errorf("planMax = %+v", planMax)
	}
}
