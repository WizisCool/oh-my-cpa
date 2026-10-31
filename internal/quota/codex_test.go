package quota

import (
	"math"
	"testing"
)

// float64(math.MaxInt64) rounds up to 2^63, one past the largest int64, so the
// upper bound has to be inclusive: a value of exactly 2^63 used to pass the guard
// and then convert to a negative int64.
func TestToInt64RejectsTheRoundedMaxInt64Boundary(t *testing.T) {
	const twoToTheSixtyThree = 9223372036854775808.0

	if got, ok := toInt64(twoToTheSixtyThree); ok {
		t.Fatalf("toInt64(2^63) = %d, want it rejected", got)
	}

	largest := math.Nextafter(twoToTheSixtyThree, 0)
	got, ok := toInt64(largest)
	if !ok {
		t.Fatalf("toInt64(%v) was rejected", largest)
	}
	if got < 0 {
		t.Fatalf("toInt64(%v) = %d, want a positive value", largest, got)
	}

	minimum, ok := toInt64(-twoToTheSixtyThree)
	if !ok || minimum != math.MinInt64 {
		t.Fatalf("toInt64(-2^63) = %d, %v; want %d, true", minimum, ok, int64(math.MinInt64))
	}

	for _, value := range []any{math.NaN(), math.Inf(1), math.Inf(-1)} {
		if got, ok := toInt64(value); ok {
			t.Fatalf("toInt64(%v) = %d, want it rejected", value, got)
		}
	}
}

// A window shorter than an hour is named in minutes. Rounded to hours it reads as "0小时",
// which is not a period at all - and a provider that meters a short window would have it
// described as no window.
func TestWindowPeriodNameKeepsShortWindowsReadable(t *testing.T) {
	for _, one := range []struct {
		seconds float64
		want    string
	}{
		{seconds: 90, want: "2分钟"},
		{seconds: 600, want: "10分钟"},
		{seconds: 1800, want: "30分钟"},
		{seconds: FiveHourSeconds, want: "5小时"},
		{seconds: DailySeconds, want: "每日"},
		{seconds: WeeklySeconds, want: "每周"},
		{seconds: MonthlySeconds, want: "每月"},
		{seconds: 0, want: ""},
	} {
		if got := windowPeriodName(one.seconds); got != one.want {
			t.Errorf("windowPeriodName(%v) = %q, want %q", one.seconds, got, one.want)
		}
	}
}

func TestResolveCodexPlanTierNamesCurrentPlans(t *testing.T) {
	cases := []struct {
		planType  string
		wantTier  string
		wantLabel string
	}{
		{"pro", "elite", "Pro 200"},
		{"promax", "elite", "Pro 500"},
		{"pro-max", "elite", "Pro 500"},
		{"pro_max", "elite", "Pro 500"},
		{"  ProMax  ", "elite", "Pro 500"},
		{"  PRO-MAX  ", "elite", "Pro 500"},
		{"  Pro_Max  ", "elite", "Pro 500"},
		{"ProLite", "premium", "Pro 100"},
		{"pro-lite", "premium", "Pro 100"},
		{"pro_lite", "premium", "Pro 100"},
		{"self_serve_business_prolite", "premium", "Business Premium"},
		{"plus", "standard", "Plus"},
		{"team", "standard", "Team"},
		{"free", "free", "Free"},
		{" future_plan ", "standard", "Future_plan"},
		{"promax_future", "standard", "Promax_future"},
		{"", "unknown", "未知套餐"},
	}
	for _, tc := range cases {
		tier, label := resolveCodexPlanTier(tc.planType)
		if tier != tc.wantTier || label != tc.wantLabel {
			t.Errorf("resolveCodexPlanTier(%q) = %q/%q, want %q/%q", tc.planType, tier, label, tc.wantTier, tc.wantLabel)
		}
	}
}

func TestParseCodexUsageReadsAccountCredits(t *testing.T) {
	cases := []struct {
		name    string
		credits string
		want    *QuotaCredits
	}{
		{"string balance", `{"has_credits":true,"unlimited":false,"balance":" 12.50 "}`, &QuotaCredits{Balance: "12.50"}},
		{"numeric balance", `{"unlimited":false,"balance":7}`, &QuotaCredits{Balance: "7"}},
		{"zero balance is a reading", `{"unlimited":false,"balance":"0"}`, &QuotaCredits{Balance: "0"}},
		{"unlimited", `{"unlimited":true,"balance":null}`, &QuotaCredits{IsUnlimited: true}},
		{"no balance stated", `{"has_credits":false,"unlimited":false}`, nil},
		{"malformed balance", `{"unlimited":false,"balance":"-3"}`, nil},
		{"non-decimal balance", `{"unlimited":false,"balance":"1e3"}`, nil},
		{"absent", `null`, nil},
	}
	for _, tc := range cases {
		raw := []byte(`{"plan_type":"plus","credits":` + tc.credits + `}`)
		plan, _, _, err := ParseCodexUsage(raw, 0)
		if err != nil {
			t.Fatalf("%s: ParseCodexUsage failed: %v", tc.name, err)
		}
		got := plan.Credits
		if (got == nil) != (tc.want == nil) || (got != nil && *got != *tc.want) {
			t.Errorf("%s: credits = %+v, want %+v", tc.name, got, tc.want)
		}
	}
}

func TestParseCodexUsagePreservesProMaxIdentity(t *testing.T) {
	for _, rawType := range []string{"promax", "pro-max", "pro_max", "  ProMax  "} {
		t.Run(rawType, func(t *testing.T) {
			for _, field := range []string{"plan_type", "planType"} {
				raw := []byte(`{"` + field + `":"` + rawType + `"}`)
				plan, _, _, err := ParseCodexUsage(raw, 1_800_000_000_000)
				if err != nil {
					t.Fatal(err)
				}
				if plan.PlanType != rawType || plan.PlanLabel != "Pro 500" || plan.Tier != "elite" {
					t.Fatalf("%s plan = %+v, want raw identity %q and Pro 500/elite", field, plan, rawType)
				}
			}
		})
	}
}
