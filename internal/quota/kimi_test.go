package quota

import (
	"testing"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/management"
)

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
