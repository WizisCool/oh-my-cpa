package quota

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

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
	for _, target := range []string{KimiInternationalUsageURL, "https://api.kimi.ai/coding/v1/me"} {
		if !IsAllowedQuotaURL(target) {
			t.Errorf("Kimi observation endpoint refused: %s", target)
		}
	}
	for _, target := range []string{
		"https://api.kimi.ai/coding/v1/chat/completions",
		"https://api.kimi.ai/coding/v1/me-extra",
		"https://api.kimi.ai/coding/v1/me/extra",
		"https://api.kimi.ai/coding/v1/me/../chat/completions",
		"https://api.kimi.ai/coding/v1/%2e%2e/me",
		"https://api.kimi.ai.attacker.invalid/coding/v1/me",
	} {
		if IsAllowedQuotaURL(target) {
			t.Errorf("unexpected allowed profile target: %s", target)
		}
	}
}

func TestKimiQuotaEnrichesPlanWithoutLosingUsage(t *testing.T) {
	for _, host := range []struct{ provider, usageURL, profileURL string }{
		{"kimi", KimiUsageURL, "https://api.kimi.com/coding/v1/me"},
		{"kimi-ai", KimiInternationalUsageURL, "https://api.kimi.ai/coding/v1/me"},
	} {
		for _, profile := range []struct {
			name, body, label string
			status            int
			err               error
		}{
			{name: "success", status: http.StatusOK, body: `{"user_id":"fixture-user","user_level_name":"  Kimi For Coding  "}`, label: "Kimi For Coding"},
			{name: "string body", status: http.StatusOK, body: `"{\"user_id\":\"fixture-user\",\"user_level_name\":\"Kimi For Coding\"}"`, label: "Kimi For Coding"},
			{name: "transport failure", err: errors.New("profile connection refused")},
			{name: "timeout", err: context.DeadlineExceeded},
			{name: "unauthorized", status: http.StatusUnauthorized},
			{name: "forbidden", status: http.StatusForbidden},
			{name: "missing endpoint", status: http.StatusNotFound},
			{name: "rate limited", status: http.StatusTooManyRequests},
			{name: "server failure", status: http.StatusBadGateway},
			{name: "invalid JSON", status: http.StatusOK, body: `{"user_id":`},
			{name: "missing user", status: http.StatusOK, body: `{"user_level_name":"Unverified"}`},
			{name: "missing name", status: http.StatusOK, body: `{"user_id":"fixture-user"}`},
		} {
			t.Run(host.provider+"/"+profile.name, func(t *testing.T) {
				file := management.AuthFile{AuthIndex: "fixture-kimi", Name: host.provider + ".json", Type: host.provider}
				usageCalls, profileCalls := 0, 0
				client := &mockCPAClient{apiCallFunc: func(ctx context.Context, req management.ApiCallRequest) (management.ApiCallResponse, error) {
					if req.AuthIndex != file.AuthIndex || req.Method != http.MethodGet || req.Header["Authorization"] != "Bearer $TOKEN$" || req.Header["Accept"] != "application/json" || req.Data != "" {
						t.Fatalf("unexpected quota request: %+v", req)
					}
					switch req.URL {
					case host.usageURL:
						usageCalls++
						return management.ApiCallResponse{StatusCode: http.StatusOK, Body: json.RawMessage(`{"usages":{"limit_5h":{"used_ratio":0.25}}}`)}, nil
					case host.profileURL:
						profileCalls++
						if usageCalls != 1 {
							t.Fatal("profile requested before usable quota")
						}
						deadline, hasDeadline := ctx.Deadline()
						if !hasDeadline || time.Until(deadline) > 8*time.Second {
							t.Fatal("optional profile request has no short timeout")
						}
						return management.ApiCallResponse{StatusCode: profile.status, Body: json.RawMessage(profile.body)}, profile.err
					default:
						t.Fatalf("request crossed the selected Kimi host: %s", req.URL)
						return management.ApiCallResponse{}, nil
					}
				}}
				prior := &NormalizedQuota{Plan: &QuotaPlan{PlanType: "standard", PlanLabel: "Previous subscription", Tier: "standard"}}
				reading, err := NewService(client).RefreshCredentialQuota(context.Background(), file, prior)
				if err != nil {
					t.Fatal(err)
				}
				if usageCalls != 1 || profileCalls != 1 {
					t.Fatalf("usage/profile calls = %d/%d, want 1/1", usageCalls, profileCalls)
				}
				if reading.Status != "healthy" || reading.Error != "" || reading.RateLimit != nil || len(reading.Windows) != 1 || reading.Windows[0].UsedPercent == nil || *reading.Windows[0].UsedPercent != 25 {
					t.Fatalf("usable quota was lost: %+v", reading)
				}
				wantLabel := profile.label
				if wantLabel == "" {
					wantLabel = "Kimi Coding API"
				}
				if reading.Plan == nil || reading.Plan.PlanLabel != wantLabel || reading.Plan.PlanType != "standard" || reading.Plan.Tier != "standard" {
					t.Fatalf("plan = %+v, want fresh %q/standard", reading.Plan, wantLabel)
				}
				if prior.Plan.PlanLabel != "Previous subscription" {
					t.Fatal("enrichment mutated the prior observation")
				}
			})
		}
	}
}

func TestKimiQuotaPreservesUsageFailureAndEmptySemantics(t *testing.T) {
	for _, test := range []struct {
		name, body, status string
		code               int
		err                error
		wantProfile        bool
	}{
		{name: "transport", err: errors.New("usage connection refused"), status: "stale"},
		{name: "HTTP error", code: http.StatusUnauthorized, status: "error"},
		{name: "invalid usage", code: http.StatusOK, body: `{"usages":`, status: "stale"},
		{name: "empty reading", code: http.StatusOK, body: `{}`, status: QuotaStatusUnpublished, wantProfile: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			profileCalls := 0
			client := &mockCPAClient{apiCallFunc: func(ctx context.Context, req management.ApiCallRequest) (management.ApiCallResponse, error) {
				if req.URL == KimiUsageURL {
					return management.ApiCallResponse{StatusCode: test.code, Body: json.RawMessage(test.body)}, test.err
				}
				if req.URL != "https://api.kimi.com/coding/v1/me" {
					t.Fatalf("unexpected request: %s", req.URL)
				}
				profileCalls++
				return management.ApiCallResponse{StatusCode: http.StatusOK, Body: json.RawMessage(`{"user_id":"fixture-user","user_level_name":"Current subscription"}`)}, nil
			}}
			usedPercent := 25.0
			prior := &NormalizedQuota{Plan: &QuotaPlan{PlanType: "standard", PlanLabel: "Previous subscription", Tier: "standard"}, Windows: []QuotaWindow{{ID: "prior-window", UsedPercent: &usedPercent}}}
			reading, err := NewService(client).RefreshCredentialQuota(context.Background(), management.AuthFile{AuthIndex: "fixture-kimi", Type: "kimi"}, prior)
			if err != nil || reading.Status != test.status {
				t.Fatalf("reading = %+v, err = %v, want %s", reading, err, test.status)
			}
			if test.wantProfile {
				if profileCalls != 1 || len(reading.Windows) != 0 || reading.Plan.PlanLabel != "Current subscription" {
					t.Fatalf("empty usage was replaced with prior windows: %+v", reading)
				}
			} else if profileCalls != 0 || reading.Plan.PlanLabel != "Previous subscription" || len(reading.Windows) != 1 || reading.Windows[0].ID != "prior-window" {
				t.Fatalf("failed usage lost the prior reading: %+v", reading)
			}
		})
	}
}

func TestParseKimiPlanNameProjectsOnlyVerifiedSanitizedNames(t *testing.T) {
	for _, test := range []struct{ name, payload, want string }{
		{"display name", `{"user_id":"fixture-user","user_level_name":"  Kimi For Coding  ","access_token":"synthetic-private-token"}`, "Kimi For Coding"},
		{"no user", `{"user_level_name":"Unverified"}`, ""},
		{"blank user", `{"user_id":" ","user_level_name":"Unverified"}`, ""},
		{"non-string user", `{"user_id":123,"user_level_name":"Unverified"}`, ""},
		{"no name", `{"user_id":"fixture-user"}`, ""},
		{"blank name", `{"user_id":"fixture-user","user_level_name":" \n\t "}`, ""},
		{"non-string name", `{"user_id":"fixture-user","user_level_name":123}`, ""},
		{"invalid JSON", `{"user_id":`, ""},
		{"array", `[]`, ""},
		{"null", `null`, ""},
		{"control characters", `{"user_id":"fixture-user","user_level_name":"Coding\u0000 \n\t Pro\u202e"}`, "Coding Pro"},
		{"obfuscated secret", `{"user_id":"fixture-user","user_level_name":"Coding Bear\u202eer synthetic-private-token"}`, "Coding Bearer [redacted]"},
		{"secret redaction", `{"user_id":"fixture-user","user_level_name":"Coding Bearer synthetic-private-token"}`, "Coding Bearer [redacted]"},
	} {
		t.Run(test.name, func(t *testing.T) {
			if got := parseKimiPlanName([]byte(test.payload)); got != test.want {
				t.Fatalf("plan name = %q, want %q", got, test.want)
			}
		})
	}
	for _, name := range []string{strings.Repeat("a", 300), strings.Repeat("套餐", 100), strings.Repeat("a", 255) + "套餐"} {
		raw, err := json.Marshal(map[string]string{"user_id": "fixture-user", "user_level_name": name})
		if err != nil {
			t.Fatal(err)
		}
		got := parseKimiPlanName(raw)
		if got == "" || len(got) > 256 || !utf8.ValidString(got) || !strings.HasPrefix(name, got) {
			t.Fatalf("unbounded or invalid UTF-8 name: %q", got)
		}
	}
}
