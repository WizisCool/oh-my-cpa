package quota

import (
	"fmt"
	"testing"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/management"
)

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

// A unit on its own is not a period. A key saying "hour" does not state this family's five-hour
// window, so reading it as one would both invent a period and take the five-hour slot from a pool
// that really is five hours; the spellings that do state five hours keep their kind.
func TestParseKimiUsageLeavesABareHourKeyUnclassified(t *testing.T) {
	cases := []struct {
		key      string
		wantKind string
	}{
		{key: "limit_hour", wantKind: ""},
		{key: "limit_hourly", wantKind: ""},
		{key: "limit_fivehour", wantKind: "five_hour"},
		{key: "limit_5h", wantKind: "five_hour"},
		{key: "limit_5hour", wantKind: "five_hour"},
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
