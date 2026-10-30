package quota

import (
	"testing"
)

func TestAntigravityPeriodsRequireCompleteFixedDuration(t *testing.T) {
	for _, label := range []string{"15h", "25 hours", "biweekly", "2 weeks", "bimonthly", "quarterly", "monthly", "1m", "1mo", "1 month", "calendar_month", "month", "unknown"} {
		if hours := parseAntigravityWindowHours(label); hours != 0 {
			t.Errorf("unreviewed period %q guessed as %v hours", label, hours)
		}
	}
	for label, expected := range map[string]float64{"5h": 5, "daily": 24, "weekly": 168, "30d": 720} {
		if hours := parseAntigravityWindowHours(label); hours != expected {
			t.Errorf("period %q=%v, want %v", label, hours, expected)
		}
	}
}

func TestAntigravityCommonWindowIdentifiers(t *testing.T) {
	for _, scenario := range []struct {
		identifiers []string
		label       string
		hours       float64
	}{
		{[]string{"5h", "5hour", "5hours", "5 hour", "5_hours", "5-hours", "five_hour", "five-hours", " FIVE  HOURS "}, "5小时限制 (5-Hour)", 5},
		{[]string{"24h", "24hour", "24_hours", "24-hour", "1d", "day", "DAILY"}, "每日限制 (Daily)", 24},
		{[]string{"7d", "7days", "7_days", "7-day", "1w", "week", "WEEKLY"}, "每周限制 (Weekly)", 168},
		{[]string{"30d", "30days", "30_days", "30-day"}, "每月限制 (Monthly)", 720},
		{[]string{"month", "MONTHLY", "1mo", "1month", "1_month", "calendar-month"}, "每月限制 (Monthly)", 0},
	} {
		for _, identifier := range scenario.identifiers {
			t.Run(identifier, func(t *testing.T) {
				if got := translateAntigravityBucketLabel("Plugin", "bucket_0_4", identifier); got != "Plugin · "+scenario.label {
					t.Errorf("label = %q, want %q", got, "Plugin · "+scenario.label)
				}
				if got := parseAntigravityWindowHours(identifier); got != scenario.hours {
					t.Errorf("period = %v, want %v", got, scenario.hours)
				}
			})
		}
	}
}

// Upstream renamed buckets to "<period> Limit Remaining"; the suffix is not
// part of the name, and a name that says nothing falls back to the window.
func TestAntigravityBucketLabelsFollowRenamedBuckets(t *testing.T) {
	for _, scenario := range []struct{ name, window, want string }{
		{"Five Hour Limit Remaining", "5h", "Gemini Models · 5小时限制 (5-Hour)"},
		{"Weekly Limit - Remaining", "weekly", "Gemini Models · 每周限制 (Weekly)"},
		{"Quota", "5h", "Gemini Models · 5小时限制 (5-Hour)"},
		{"Burst Remaining", "unreported", "Gemini Models · Burst"},
		{"Quota", "bimonthly", "Gemini Models · Quota"},
	} {
		if got := translateAntigravityBucketLabel("Gemini Models", scenario.name, scenario.window); got != scenario.want {
			t.Errorf("label(%q, %q) = %q, want %q", scenario.name, scenario.window, got, scenario.want)
		}
	}

	t.Run("plugin window label preserves built-in periods", func(t *testing.T) {
		windows, err := ParseAntigravityUsage([]byte(`{"groups":[
			{"displayName":"Gift plans","buckets":[
				{"window":"ZCODE WEEKEND BUILD · glm-5.3-flash","remainingFraction":0.97,
				 "resetTime":"2026-11-02T01:00:00Z","description":"Models: glm-5.3-flash"}
			]},
			{"displayName":"Gemini Models","buckets":[
				{"displayName":"Weekly Limit Remaining","window":"weekly","remainingFraction":0.6},
				{"displayName":"Five Hour Limit Remaining","window":"5h","remainingFraction":0.9}
			]}
		]}`), 0, 0)
		if err != nil {
			t.Fatal(err)
		}
		want := []struct {
			id, label string
			hours     float64
		}{
			{"ag_Gift plans_bucket_0_0", "Gift plans · ZCODE WEEKEND BUILD · glm-5.3-flash", 0},
			{"ag_Gemini Models_bucket_1_0", "Gemini Models · 5小时限制 (5-Hour)", 5},
			{"ag_Gemini Models_bucket_1_1", "Gemini Models · 每周限制 (Weekly)", 168},
		}
		if len(windows) != len(want) {
			t.Fatalf("windows = %d, want %d", len(windows), len(want))
		}
		for index, expected := range want {
			window := windows[index]
			if window.Label != expected.label {
				t.Errorf("window %d label = %q, want %q", index, window.Label, expected.label)
			}
			if window.ID != expected.id {
				t.Errorf("window %d ID = %q, want %q", index, window.ID, expected.id)
			}
			if window.PeriodHours == nil || *window.PeriodHours != expected.hours {
				t.Errorf("window %d has unexpected period: %+v, want %v hours", index, window, expected.hours)
			}
		}
	})
}

func TestResolveAntigravityPlanNamesTheTier(t *testing.T) {
	if plan := ResolveAntigravityPlan("ultra"); plan.Tier != "elite" || plan.PlanLabel != "Ultra" {
		t.Errorf("plan = %+v, want elite/Ultra", plan)
	}
}
