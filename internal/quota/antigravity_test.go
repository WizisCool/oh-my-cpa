package quota

import (
	"testing"
	"time"
)

func TestParseAntigravityUsage(t *testing.T) {
	raw := []byte(`{
		"groups": [
			{
				"displayName": "Gemini models",
				"buckets": [
					{
						"bucketId": "five_hour",
						"displayName": "5 hour limit",
						"window": "5h",
						"remainingFraction": 0.85,
						"resetTime": "2026-01-01T12:00:00Z"
					},
					{
						"bucketId": "daily",
						"displayName": "Daily limit",
						"window": "24h",
						"remainingFraction": 0.50,
						"resetTime": "2026-01-02T00:00:00Z"
					}
				]
			}
		]
	}`)

	nowMS := time.Date(2025, 1, 1, 0, 0, 0, 0, time.UTC).UnixMilli()
	windows, err := ParseAntigravityUsage(raw, nowMS, 0)
	if err != nil {
		t.Fatalf("ParseAntigravityUsage failed: %v", err)
	}

	if len(windows) != 2 {
		t.Fatalf("len(windows) = %d, want 2", len(windows))
	}

	w0 := windows[0]
	if *w0.RemainingPercent != 85.0 || *w0.UsedPercent != 15.0 {
		t.Errorf("w0 percent = rem:%v used:%v, want 85 and 15", w0.RemainingPercent, w0.UsedPercent)
	}
	if w0.PeriodHours == nil || *w0.PeriodHours != 5.0 {
		t.Errorf("w0 period = %v, want 5", w0.PeriodHours)
	}

	w1 := windows[1]
	if *w1.RemainingPercent != 50.0 || *w1.UsedPercent != 50.0 {
		t.Errorf("w1 percent = rem:%v used:%v, want 50 and 50", w1.RemainingPercent, w1.UsedPercent)
	}

	plan := ResolveAntigravityPlan("ultra")
	if plan.Tier != "elite" || plan.PlanLabel != "Ultra" {
		t.Errorf("plan = %+v, want elite/Ultra", plan)
	}
}
