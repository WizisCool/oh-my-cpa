package quota

import (
	"fmt"
	"math"
	"testing"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/management"
)

// A plan without a weekly limit reports only its ratio pools, and those pools are the whole reading:
// decoding the counted limits alone reported such an account as having no quota at all.
func TestParseKimiUsageDecodesTheRatioPools(t *testing.T) {
	raw := []byte(`{
		"limits": [{
			"window": {"duration": 300, "timeUnit": "TIME_UNIT_MINUTE"},
			"detail": {"limit": "200", "used": "139", "resetTime": "2099-09-27T00:30:34Z"}
		}],
		"usages": {"limit_month_total": {"used_ratio": 0.2529, "reset_time": "2099-10-22T00:00:00Z"}}
	}`)

	nowMS := time.Date(2099, 10, 1, 0, 0, 0, 0, time.UTC).UnixMilli()
	windows, err := ParseKimiUsage(raw, nowMS)
	if err != nil {
		t.Fatalf("ParseKimiUsage failed: %v", err)
	}
	if len(windows) != 2 {
		t.Fatalf("len(windows) = %d, want the counted limit and the monthly pool", len(windows))
	}

	monthly := windows[1]
	if monthly.ID != "kimi_ratio_limit_month_total" || monthly.Kind != "monthly" {
		t.Errorf("monthly = %+v", monthly)
	}
	// The share is compared with a tolerance: it is a product of a floating-point ratio, and the
	// remaining side is a subtraction from 100, so neither is exactly the decimal it prints as.
	used, remaining := -1.0, -1.0
	if monthly.UsedPercent != nil {
		used = *monthly.UsedPercent
	}
	if monthly.RemainingPercent != nil {
		remaining = *monthly.RemainingPercent
	}
	if math.Abs(used-25.29) > 1e-9 || math.Abs(remaining-74.71) > 1e-9 {
		t.Errorf("percentages = %v / %v, want the 0–1 share read as a share", used, remaining)
	}
	// A pool states the share alone, so the window must not invent counts for the tooltips.
	if monthly.Used != nil || monthly.Limit != nil {
		t.Errorf("a ratio pool must not carry counts: %+v", monthly)
	}
	if monthly.PeriodHours == nil || *monthly.PeriodHours != 720 {
		t.Errorf("PeriodHours = %v, want 720", monthly.PeriodHours)
	}
	if monthly.ResetAtMS == nil || *monthly.ResetAtMS != time.Date(2099, 10, 22, 0, 0, 0, 0, time.UTC).UnixMilli() || monthly.ResetAccuracy != "exact" {
		t.Errorf("reset = %v / %q", monthly.ResetAtMS, monthly.ResetAccuracy)
	}
}

// A counted limit describes its period in absolute terms, so a pool for the same period must not
// become a second, contradicting window for one limit.
func TestParseKimiUsageKeepsTheCountedReadingForAPeriodItAlreadyDescribes(t *testing.T) {
	raw := []byte(`{
		"limits": [{"window": {"duration": 300, "timeUnit": "TIME_UNIT_MINUTE"}, "detail": {"limit": "200", "used": "139"}}],
		"usages": {"limit_5h": {"used_ratio": 0.9}, "limit_week": {"used_ratio": 0.4}}
	}`)

	windows, err := ParseKimiUsage(raw, time.Now().UnixMilli())
	if err != nil {
		t.Fatalf("ParseKimiUsage failed: %v", err)
	}
	if len(windows) != 2 {
		t.Fatalf("len(windows) = %d, want the counted five-hour window beside the weekly pool", len(windows))
	}
	if windows[0].ID != "kimi_0" || windows[0].Kind != "custom" {
		t.Errorf("the counted limit must stand: %+v", windows[0])
	}
	if windows[1].Kind != "weekly" || windows[1].UsedPercent == nil || math.Abs(*windows[1].UsedPercent-40) > 1e-9 {
		t.Errorf("weekly pool = %+v", windows[1])
	}
}

// A quantity written into the key is read as the duration it states, so a longer number is not read
// as a shorter period and a seven-day spelling is a week rather than a day.
func TestParseKimiUsageReadsQuantitiesInRatioPoolKeys(t *testing.T) {
	cases := []struct {
		key      string
		wantKind string
	}{
		{key: "limit_5h", wantKind: "five_hour"},
		{key: "limit_15h", wantKind: ""},
		{key: "limit_7d", wantKind: "weekly"},
		{key: "limit_7day", wantKind: "weekly"},
		{key: "limit_week", wantKind: "weekly"},
		{key: "limit_day", wantKind: "daily"},
	}
	for _, testCase := range cases {
		raw := []byte(fmt.Sprintf(`{"usages": {%q: {"used_ratio": 0.5}}}`, testCase.key))
		windows, err := ParseKimiUsage(raw, time.Now().UnixMilli())
		if err != nil {
			t.Fatalf("%s: ParseKimiUsage failed: %v", testCase.key, err)
		}
		if len(windows) != 1 {
			t.Fatalf("%s: len(windows) = %d, want 1", testCase.key, len(windows))
		}
		if windows[0].Kind != testCase.wantKind {
			t.Errorf("%s: kind = %q, want %q", testCase.key, windows[0].Kind, testCase.wantKind)
		}
	}
}

// A key that names no known period keeps its own name rather than being filed under a period it
// does not describe.
func TestParseKimiUsageKeepsAnUnknownPoolKey(t *testing.T) {
	raw := []byte(`{"usages": {"limit_second": {"used_ratio": 0.5}}}`)

	windows, err := ParseKimiUsage(raw, time.Now().UnixMilli())
	if err != nil {
		t.Fatalf("ParseKimiUsage failed: %v", err)
	}
	if len(windows) != 1 {
		t.Fatalf("len(windows) = %d, want 1", len(windows))
	}
	if windows[0].Kind != "" || windows[0].Label != "limit_second" || windows[0].PeriodHours != nil {
		t.Errorf("window = %+v, want the key kept as an unnamed window", windows[0])
	}
}

// A pool key names the period it meters, including the ones a plan does not always publish. The
// period comes from the key, so the window can be ordered and localized like any other.
func TestParseKimiUsageNamesRatioPoolPeriods(t *testing.T) {
	raw := []byte(`{"usages": {"limit_day": {"used_ratio": 0.5}, "limit_5h": {"used_ratio": 0.25}, "limit_week": {"used_ratio": 0.1}}}`)

	windows, err := ParseKimiUsage(raw, time.Now().UnixMilli())
	if err != nil {
		t.Fatalf("ParseKimiUsage failed: %v", err)
	}
	hoursByKind := make(map[string]float64, len(windows))
	for _, window := range windows {
		if window.PeriodHours == nil {
			t.Fatalf("window %q carries no period", window.ID)
		}
		hoursByKind[window.Kind] = *window.PeriodHours
	}
	for kind, wantHours := range map[string]float64{"daily": 24, "five_hour": 5, "weekly": 168} {
		if hoursByKind[kind] != wantHours {
			t.Errorf("kind %q = %v hours, want %v", kind, hoursByKind[kind], wantHours)
		}
	}
}

// The period a key names in words beats the vague "total" qualifier a monthly pool carries, so a
// total described as daily stays daily while a total that names no period is the monthly pool.
func TestParseKimiUsageReadsTotalQualifierByNamedPeriod(t *testing.T) {
	cases := []struct {
		key      string
		wantKind string
	}{
		{key: "limit_month_total", wantKind: "monthly"},
		{key: "limit_total", wantKind: "monthly"},
		{key: "limit_day_total", wantKind: "daily"},
		{key: "limit_week_total", wantKind: "weekly"},
	}
	for _, testCase := range cases {
		raw := []byte(fmt.Sprintf(`{"usages": {%q: {"used_ratio": 0.5}}}`, testCase.key))
		windows, err := ParseKimiUsage(raw, time.Now().UnixMilli())
		if err != nil {
			t.Fatalf("%s: ParseKimiUsage failed: %v", testCase.key, err)
		}
		if len(windows) != 1 {
			t.Fatalf("%s: len(windows) = %d, want 1", testCase.key, len(windows))
		}
		if windows[0].Kind != testCase.wantKind {
			t.Errorf("%s: kind = %q, want %q", testCase.key, windows[0].Kind, testCase.wantKind)
		}
	}
}

// A pool states a share, so a payload that states the percentage itself must not be scaled into
// thousands of percent.
func TestParseKimiRatioPercentAcceptsEitherScale(t *testing.T) {
	cases := []struct {
		name     string
		value    any
		want     float64
		hasShare bool
	}{
		{name: "fraction", value: 0.25, want: 25, hasShare: true},
		{name: "fraction at the whole", value: 1.0, want: 100, hasShare: true},
		{name: "string fraction", value: "0.5", want: 50, hasShare: true},
		{name: "percentage", value: 25, want: 25, hasShare: true},
		{name: "negative share", hasShare: false},
		{name: "absent share", hasShare: false},
	}
	for _, testCase := range cases {
		got, hasShare := kimiRatioPercent(testCase.value)
		if hasShare != testCase.hasShare || (hasShare && got != testCase.want) {
			t.Errorf("%s: kimiRatioPercent(%#v) = %v, %v; want %v, %v", testCase.name, testCase.value, got, hasShare, testCase.want, testCase.hasShare)
		}
	}
	if _, ok := kimiRatioPercent(-0.1); ok {
		t.Error("a negative share is not a reading")
	}
}

func TestParseKimiUsage(t *testing.T) {
	raw := []byte(`{
		"limits": [
			{
				"name": "daily_limit",
				"title": "每日限额",
				"scope": "moonshot-v1-8k",
				"used": 150,
				"limit": 1000,
				"duration": 24,
				"timeUnit": "hours",
				"resetIn": 3600
			}
		]
	}`)

	nowMS := time.Date(2025, 1, 1, 0, 0, 0, 0, time.UTC).UnixMilli()
	windows, err := ParseKimiUsage(raw, nowMS)
	if err != nil {
		t.Fatalf("ParseKimiUsage failed: %v", err)
	}

	if len(windows) != 1 {
		t.Fatalf("len(windows) = %d, want 1", len(windows))
	}

	w := windows[0]
	if w.Label != "每日限额" || w.Model != "moonshot-v1-8k" {
		t.Errorf("w label/model = %q / %q", w.Label, w.Model)
	}
	if w.UsedPercent == nil || *w.UsedPercent != 15.0 {
		t.Errorf("w.UsedPercent = %v, want 15.0", w.UsedPercent)
	}
	if w.RemainingPercent == nil || *w.RemainingPercent != 85.0 {
		t.Errorf("w.RemainingPercent = %v, want 85.0", w.RemainingPercent)
	}
	if w.PeriodHours == nil || *w.PeriodHours != 24.0 {
		t.Errorf("w.PeriodHours = %v, want 24.0", w.PeriodHours)
	}
	if w.ResetAtMS == nil || *w.ResetAtMS != nowMS+3600*1000 {
		t.Errorf("w.ResetAtMS = %v, want %v", w.ResetAtMS, nowMS+3600*1000)
	}
}

// A kimi.ai token must be read from kimi.ai and a kimi.com token from kimi.com:
// the two are separate account systems.
func TestKimiUsageHostFollowsTheCredentialDomain(t *testing.T) {
	cases := []struct {
		file management.AuthFile
		want string
	}{
		{management.AuthFile{Name: "kimi-user.json", Type: "kimi", Provider: "kimi"}, KimiUsageURL},
		{management.AuthFile{Name: "kimi-ai-user.json", Type: "kimi-ai", Provider: "kimi-ai"}, KimiInternationalUsageURL},
		{management.AuthFile{Name: "renamed.json", Type: "kimi_ai"}, KimiInternationalUsageURL},
		{management.AuthFile{Name: "kimi.ai-user.json", Type: "kimi", Provider: "kimi"}, KimiInternationalUsageURL},
		{management.AuthFile{Name: "moonshot.json", Type: "moonshot"}, KimiUsageURL},
	}
	for _, tc := range cases {
		if got := kimiUsageURLFor(tc.file); got != tc.want {
			t.Errorf("%+v reads %s, want %s", tc.file, got, tc.want)
		}
	}
	if !IsAllowedQuotaURL(KimiInternationalUsageURL) || IsAllowedQuotaURL("https://api.kimi.ai/coding/v1/chat/completions") {
		t.Fatal("the allowlist must admit the kimi.ai usage endpoint and nothing else on that host")
	}
}
