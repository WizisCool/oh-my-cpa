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
}

func TestResolveAntigravityPlanNamesTheTier(t *testing.T) {
	if plan := ResolveAntigravityPlan("ultra"); plan.Tier != "elite" || plan.PlanLabel != "Ultra" {
		t.Errorf("plan = %+v, want elite/Ultra", plan)
	}
}
