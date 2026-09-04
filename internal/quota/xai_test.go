package quota

import (
	"testing"
	"time"
)

func TestParseXaiBilling(t *testing.T) {
	raw := []byte(`{
		"config": {
			"credit_usage_percent": 34.5,
			"monthly_limit": 10000,
			"used": 3450,
			"billing_period_end": "2026-02-01T00:00:00Z",
			"product_usage": [
				{
					"product": "grok-2",
					"usage_percent": 20.0
				}
			]
		}
	}`)

	nowMS := time.Date(2025, 1, 1, 0, 0, 0, 0, time.UTC).UnixMilli()
	plan, windows, err := ParseXaiBilling(raw, nowMS)
	if err != nil {
		t.Fatalf("ParseXaiBilling failed: %v", err)
	}

	if plan.PlanType != "paid" || plan.ExtraUsage == nil || plan.ExtraUsage.MonthlyLimitCents != 10000 || plan.ExtraUsage.UsedCreditsCents != 3450 {
		t.Errorf("plan = %+v", plan)
	}

	if len(windows) != 2 {
		t.Fatalf("len(windows) = %d, want 2", len(windows))
	}

	w0 := windows[0]
	if w0.ID != "xai_credit_usage" || *w0.UsedPercent != 34.5 || *w0.RemainingPercent != 65.5 {
		t.Errorf("w0 = %+v", w0)
	}

	w1 := windows[1]
	if w1.Model != "grok-2" || *w1.UsedPercent != 20.0 {
		t.Errorf("w1 = %+v", w1)
	}
}
