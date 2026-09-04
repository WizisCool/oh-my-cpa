package quota

import (
	"testing"
	"time"
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
