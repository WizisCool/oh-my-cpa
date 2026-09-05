package quota

import (
	"strings"
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

func TestParseAntigravityUsageOrdersFiveHourFirst(t *testing.T) {
	raw := []byte(`{
		"groups": [
			{
				"displayName": "Gemini Models",
				"buckets": [
					{ "bucketId": "gem-week", "displayName": "Weekly Limit", "window": "weekly", "remainingFraction": 0.51, "resetTime": "2026-01-08T04:00:00Z" },
					{ "bucketId": "gem-5h", "displayName": "Five Hour Limit", "window": "5h", "remainingFraction": 1.0, "resetTime": "2026-01-01T17:00:00Z" }
				]
			},
			{
				"displayName": "Claude and GPT models",
				"buckets": [
					{ "bucketId": "ag-week", "displayName": "Weekly Limit", "window": "weekly", "remainingFraction": 1.0, "resetTime": "2026-01-09T04:00:00Z" },
					{ "bucketId": "ag-5h", "displayName": "Five Hour Limit", "window": "5h", "remainingFraction": 1.0, "resetTime": "2026-01-01T17:00:00Z" }
				]
			}
		]
	}`)

	nowMS := time.Date(2025, 1, 1, 0, 0, 0, 0, time.UTC).UnixMilli()
	windows, err := ParseAntigravityUsage(raw, nowMS, 0)
	if err != nil {
		t.Fatalf("ParseAntigravityUsage failed: %v", err)
	}
	if len(windows) != 4 {
		t.Fatalf("len(windows) = %d, want 4", len(windows))
	}

	// Within each group the 5-hour window must lead the weekly one, while
	// group blocks stay contiguous (Gemini before Claude and GPT).
	type expectation struct {
		labelContains string
		periodHours   float64
	}
	want := []expectation{
		{"Gemini Models", 5},
		{"Gemini Models", 168},
		{"Claude and GPT models", 5},
		{"Claude and GPT models", 168},
	}
	for i, exp := range want {
		w := windows[i]
		if !strings.Contains(w.Label, exp.labelContains) {
			t.Errorf("windows[%d].Label = %q, want group %q", i, w.Label, exp.labelContains)
		}
		if w.PeriodHours == nil || *w.PeriodHours != exp.periodHours {
			t.Errorf("windows[%d].PeriodHours = %v, want %v", i, w.PeriodHours, exp.periodHours)
		}
	}
}
