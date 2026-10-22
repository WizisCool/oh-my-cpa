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

func TestParseAntigravityUsageKeepsSnapshotBucketIdentities(t *testing.T) {
	const raw = `{"groups":[{"displayName":"Plugin","buckets":[
		{"window":"monthly","remainingFraction":0.125},
		{"window":"FIVE_WINDOW","remainingFraction":0.25},
		{"bucketId":"upstream-week","bucket_id":"ignored","window":"WEEK_WINDOW","remainingFraction":0.375},
		{"bucket_id":"upstream-day","window":"daily","remainingFraction":0.5},
		{"window":"WEEK_WINDOW","remainingFraction":0.625},
		{"window":"burst","remainingFraction":0.75}
	]},{"displayName":"Other","buckets":[{"window":"monthly","remainingFraction":0.875}]}]}`
	sourceRemaining := []float64{12.5, 25, 37.5, 50, 62.5, 75, 87.5}
	for _, scenario := range []struct {
		name, fiveHour, weekly string
		wantIDs                []string
		sourceOrder            []int
	}{
		{"unrecognized", "unreported-five", "unreported-week", []string{
			"ag_Plugin_bucket_0_0", "ag_Plugin_bucket_0_1", "ag_Plugin_upstream-week", "ag_Plugin_upstream-day", "ag_Plugin_bucket_0_4", "ag_Plugin_bucket_0_5", "ag_Other_bucket_1_0",
		}, []int{0, 1, 2, 3, 4, 5, 6}},
		{"canonical", "5h", "weekly", []string{
			"ag_Plugin_bucket_0_0", "ag_Plugin_upstream-week", "ag_Plugin_bucket_0_2", "ag_Plugin_bucket_0_3", "ag_Plugin_upstream-day", "ag_Plugin_bucket_0_5", "ag_Other_bucket_1_0",
		}, []int{1, 2, 4, 0, 3, 5, 6}},
		{"established aliases", " FIVE-HOUR ", " 7 DaYs ", []string{
			"ag_Plugin_bucket_0_0", "ag_Plugin_upstream-week", "ag_Plugin_bucket_0_2", "ag_Plugin_bucket_0_3", "ag_Plugin_upstream-day", "ag_Plugin_bucket_0_5", "ag_Other_bucket_1_0",
		}, []int{1, 2, 4, 0, 3, 5, 6}},
		{"aliases", "FIVE-HOURS", "7_days", []string{
			"ag_Plugin_bucket_0_1", "ag_Plugin_upstream-week", "ag_Plugin_bucket_0_4", "ag_Plugin_bucket_0_0", "ag_Plugin_upstream-day", "ag_Plugin_bucket_0_5", "ag_Other_bucket_1_0",
		}, []int{1, 2, 4, 0, 3, 5, 6}},
		{"mixed", "FIVE-HOURS", "weekly", []string{
			"ag_Plugin_bucket_0_3", "ag_Plugin_upstream-week", "ag_Plugin_bucket_0_1", "ag_Plugin_bucket_0_2", "ag_Plugin_upstream-day", "ag_Plugin_bucket_0_5", "ag_Other_bucket_1_0",
		}, []int{1, 2, 4, 0, 3, 5, 6}},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			payload := strings.NewReplacer("FIVE_WINDOW", scenario.fiveHour, "WEEK_WINDOW", scenario.weekly).Replace(raw)
			windows, err := ParseAntigravityUsage([]byte(payload), 0, 0)
			if err != nil {
				t.Fatal(err)
			}
			if len(windows) != len(scenario.wantIDs) {
				t.Fatalf("windows = %d, want %d", len(windows), len(scenario.wantIDs))
			}
			for windowIndex, window := range windows {
				if window.ID != scenario.wantIDs[windowIndex] {
					t.Errorf("windows[%d].ID = %q, want the persisted identity %q", windowIndex, window.ID, scenario.wantIDs[windowIndex])
				}
				if window.RemainingPercent == nil || *window.RemainingPercent != sourceRemaining[scenario.sourceOrder[windowIndex]] {
					t.Errorf("windows[%d] lost its source bucket's quota value: %+v", windowIndex, window)
				}
			}
		})
	}
}

func TestParseAntigravityUsageKeepsSourceOrderWithinNormalizedPeriods(t *testing.T) {
	windows, err := ParseAntigravityUsage([]byte(`{"groups":[{"displayName":"Plugin","buckets":[
		{"window":"five-hours","remainingFraction":0.125},
		{"window":"5h","remainingFraction":0.25},
		{"window":"7-days","remainingFraction":0.375},
		{"window":"weekly","remainingFraction":0.5}
	]}]}`), 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	wantIDs := []string{"ag_Plugin_bucket_0_2", "ag_Plugin_bucket_0_0", "ag_Plugin_bucket_0_3", "ag_Plugin_bucket_0_1"}
	if len(windows) != len(wantIDs) {
		t.Fatalf("windows = %d, want %d", len(windows), len(wantIDs))
	}
	for windowIndex, window := range windows {
		if window.ID != wantIDs[windowIndex] || window.RemainingPercent == nil || *window.RemainingPercent != float64(windowIndex+1)*12.5 {
			t.Errorf("windows[%d] changed display order or identity: %+v", windowIndex, window)
		}
	}
}

func TestAntigravityCapacityScopeAndUnknownPeriod(t *testing.T) {
	windows, err := ParseAntigravityUsage([]byte(`{"groups":[{"displayName":"Gemini models","buckets":[{"bucketId":"five","window":"5h","remainingFraction":0.8,"resetTime":"2026-01-01T17:00:00Z"}]},{"displayName":"Gemini and future models","buckets":[{"bucketId":"future","window":"unreported","remainingFraction":0.8,"resetTime":"2026-01-01T17:00:00Z"}]}]}`), 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(windows) != 2 || len(windows[0].ModelFamilies) != 1 || windows[0].ModelFamilies[0] != "gemini" || len(windows[1].ModelFamilies) != 0 || *windows[1].PeriodHours != 0 {
		t.Fatalf("scope or period guessed: %+v", windows)
	}
}

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

func TestParsePluginMonthlyQuotaLabelWithoutBucketMetadata(t *testing.T) {
	for _, window := range []string{"monthly", "month", " Monthly "} {
		t.Run(window, func(t *testing.T) {
			raw := []byte(`{"groups":[{"displayName":"Cline Pass","buckets":[
				{"window":"5h","remainingFraction":1},
				{"window":"7d","remainingFraction":0.41},
				{"window":"` + window + `","remainingFraction":0.25,"resetTime":"2026-10-26T00:11:00Z"},
				{"displayName":"Burst budget","window":"burst","remainingFraction":0.5},
				{"displayName":"Image credits","window":"images","remainingFraction":0.75}
			]}]}`)
			windows, err := ParseAntigravityUsage(raw, 0, 0)
			if err != nil {
				t.Fatal(err)
			}
			if len(windows) != 5 {
				t.Fatalf("windows = %+v, want all five quota windows", windows)
			}
			monthly := windows[2]
			if monthly.Label != "Cline Pass · 每月限制 (Monthly)" {
				t.Errorf("monthly label = %q, want the named monthly limit", monthly.Label)
			}
			if monthly.PeriodHours == nil || *monthly.PeriodHours != 0 {
				t.Errorf("calendar month acquired a fixed duration: %v", monthly.PeriodHours)
			}
			if monthly.RemainingPercent == nil || *monthly.RemainingPercent != 25 || monthly.ResetAtMS == nil || *monthly.ResetAtMS != time.Date(2026, 10, 26, 0, 11, 0, 0, time.UTC).UnixMilli() {
				t.Fatalf("monthly quota values changed: %+v", monthly)
			}
			if windows[3].Label != "Cline Pass · Burst budget" || windows[4].Label != "Cline Pass · Image credits" {
				t.Fatalf("later custom window names changed: %q, %q", windows[3].Label, windows[4].Label)
			}
		})
	}
}
