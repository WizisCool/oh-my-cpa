package quota

import (
	"fmt"
	"math"
	"testing"
	"time"
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

func TestStandardWindowIdentityNamesCustomDurations(t *testing.T) {
	id, label, kind := standardWindowIdentity(8*3600, "five_hour", "5小时用量上限 (5-Hour)")
	if id != "custom_8h" || label != "8小时用量上限 (8h)" || kind != "custom" {
		t.Fatalf("standardWindowIdentity(8h) = (%q, %q, %q), want (custom_8h, 8小时用量上限 (8h), custom)", id, label, kind)
	}
	id0, label0, kind0 := standardWindowIdentity(0, "five_hour", "5小时用量上限 (5-Hour)")
	if id0 != "five_hour" || label0 != "5小时用量上限 (5-Hour)" || kind0 != "custom" {
		t.Fatalf("standardWindowIdentity(0) = (%q, %q, %q), want fallback", id0, label0, kind0)
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

func TestParseCodexUsagePreservesExactCustomDurationAndCycleRange(t *testing.T) {
	resetAt := time.Date(2026, 10, 21, 20, 0, 0, 0, time.UTC)
	resetSec := resetAt.Unix()
	nowMS := resetAt.Add(-time.Hour).UnixMilli()
	raw := []byte(`{
		"plan_type": "plus",
		"rate_limit": {
			"primary_window": {"used_percent": 15, "limit_window_seconds": 28860, "reset_at": ` + fmt.Sprintf("%d", resetSec) + `},
			"secondary_window": {"used_percent": 10, "limit_window_seconds": 28800, "reset_at": ` + fmt.Sprintf("%d", resetSec) + `}
		}
	}`)
	_, windows, _, err := ParseCodexUsage(raw, nowMS)
	if err != nil {
		t.Fatalf("ParseCodexUsage failed: %v", err)
	}
	if len(windows) != 2 {
		t.Fatalf("expected 2 windows, got %+v", windows)
	}
	win8h1m, win8h := windows[0], windows[1]
	if win8h1m.ID != "custom_8h" || win8h1m.PeriodHours == nil || math.Abs(*win8h1m.PeriodHours-28860.0/3600.0) > 1e-9 {
		t.Fatalf("28860s window = %+v, want exact PeriodHours=28860/3600", win8h1m)
	}
	if !SupportsWindowCapacity("codex", win8h1m) || !SupportsWindowCapacity("codex", win8h) {
		t.Fatalf("expected custom positive codex windows to support capacity")
	}
	fromMS, toMS, reason := WindowCycleRange(win8h1m, nowMS, nowMS)
	wantFrom := resetAt.Add(-28860 * time.Second).UnixMilli()
	if reason != "" || fromMS != wantFrom || toMS != nowMS {
		t.Fatalf("WindowCycleRange(28860s) = [%d, %d) reason=%q, want [%d, %d)", fromMS, toMS, reason, wantFrom, nowMS)
	}
	from8h, _, reason8h := WindowCycleRange(win8h, nowMS, nowMS)
	want8h := resetAt.Add(-8 * time.Hour).UnixMilli()
	if reason8h != "" || from8h != want8h {
		t.Fatalf("WindowCycleRange(28800s) = %d reason=%q, want %d", from8h, reason8h, want8h)
	}
}

func TestParseCodexResetCreditsHandlesNumericTimestampsAndCountFallback(t *testing.T) {
	raw := []byte(`{
		"credits": [
			{
				"id": "cr-sec",
				"status": "available",
				"reset_type": "codex_rate_limits",
				"granted_at": 1775000000,
				"expires_at": 1776000000
			},
			{
				"id": "cr-ms-camel",
				"status": "available",
				"grantedAt": 1775000000123,
				"expiresAt": "1776500000"
			},
			{
				"id": "cr-precedence",
				"status": "available",
				"granted_at": 1775100000,
				"grantedAt": 1700000000,
				"expires_at": "2026-12-01T00:00:00Z",
				"expiresAt": "2020-01-01T00:00:00Z"
			},
			{
				"id": "cr-used",
				"status": "used",
				"expires_at": 1776000000
			}
		]
	}`)
	parsed, err := ParseCodexResetCreditsPayload(raw)
	if err != nil {
		t.Fatalf("ParseCodexResetCreditsPayload failed: %v", err)
	}
	if parsed.AvailableCount != 3 || len(parsed.Credits) != 3 {
		t.Fatalf("parsed = %+v, want available_count=3 derived from 3 redeemable credits", parsed)
	}
	if parsed.Credits[0].GrantedAtMS == nil || *parsed.Credits[0].GrantedAtMS != 1775000000000 {
		t.Fatalf("cr-sec granted_at_ms = %v, want 1775000000000", parsed.Credits[0].GrantedAtMS)
	}
	if parsed.Credits[0].ExpiresAtMS == nil || *parsed.Credits[0].ExpiresAtMS != 1776000000000 {
		t.Fatalf("cr-sec expires_at_ms = %v, want 1776000000000", parsed.Credits[0].ExpiresAtMS)
	}
	if parsed.Credits[1].GrantedAtMS == nil || *parsed.Credits[1].GrantedAtMS != 1775000000123 {
		t.Fatalf("cr-ms-camel granted_at_ms = %v, want 1775000000123", parsed.Credits[1].GrantedAtMS)
	}
	if parsed.Credits[1].ExpiresAtMS == nil || *parsed.Credits[1].ExpiresAtMS != 1776500000000 {
		t.Fatalf("cr-ms-camel expires_at_ms = %v, want 1776500000000", parsed.Credits[1].ExpiresAtMS)
	}
	wantDec := time.Date(2026, 12, 1, 0, 0, 0, 0, time.UTC).UnixMilli()
	if parsed.Credits[2].GrantedAtMS == nil || *parsed.Credits[2].GrantedAtMS != 1775100000000 {
		t.Fatalf("cr-precedence granted_at_ms = %v, want snake_case 1775100000000", parsed.Credits[2].GrantedAtMS)
	}
	if parsed.Credits[2].ExpiresAtMS == nil || *parsed.Credits[2].ExpiresAtMS != wantDec {
		t.Fatalf("cr-precedence expires_at_ms = %v, want snake_case %d", parsed.Credits[2].ExpiresAtMS, wantDec)
	}

	explicitZero, err := ParseCodexResetCreditsPayload([]byte(`{"available_count":0,"availableCount":4,"credits":[]}`))
	if err != nil {
		t.Fatalf("explicit zero failed: %v", err)
	}
	if explicitZero.AvailableCount != 0 || !explicitZero.hasAvailableCount {
		t.Fatalf("explicitZero = %+v, want available_count=0 with hasAvailableCount=true", explicitZero)
	}

	// Supplied but unreadable expiries are excluded so redemption never treats them as undated,
	// while omitted, null, or blank expiries remain accepted as undated credits.
	unreadableExpiry, err := ParseCodexResetCreditsPayload([]byte(`{
		"credits": [
			{"id": "cr-bool-exp", "status": "available", "expires_at": false},
			{"id": "cr-bad-str-exp", "status": "available", "expires_at": "not-a-date"},
			{"id": "cr-neg-exp", "status": "available", "expires_at": -1},
			{"id": "cr-null-exp", "status": "available", "expires_at": null},
			{"id": "cr-blank-exp", "status": "available", "expires_at": "   "},
			{"id": "cr-omitted-exp", "status": "available"}
		]
	}`))
	if err != nil {
		t.Fatalf("unreadableExpiry failed: %v", err)
	}
	if unreadableExpiry.AvailableCount != 3 || len(unreadableExpiry.Credits) != 3 {
		t.Fatalf("unreadableExpiry = %+v, want only the 3 undated credits retained", unreadableExpiry)
	}
	for i, wantID := range []string{"cr-null-exp", "cr-blank-exp", "cr-omitted-exp"} {
		if unreadableExpiry.Credits[i].ID != wantID || unreadableExpiry.Credits[i].ExpiresAtMS != nil {
			t.Fatalf("credit[%d] = %+v, want id=%q with nil ExpiresAtMS", i, unreadableExpiry.Credits[i], wantID)
		}
	}
}
