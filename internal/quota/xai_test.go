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

// TestParseCentValAcceptsWrappedAmounts pins the upstream shapes for a credit
// amount: the billing endpoint nests the number under "val" in some responses
// and sends a bare number in others. Both must decode, and the key must stay
// spelled "val" — it is the provider's field name, not ours.
func TestParseCentValAcceptsWrappedAmounts(t *testing.T) {
	cases := []struct {
		name  string
		value any
		want  int64
	}{
		{name: "wrapped val key", value: map[string]any{"val": float64(3450)}, want: 3450},
		{name: "bare number", value: float64(3450), want: 3450},
		{name: "string number", value: "3450", want: 3450},
		{name: "absent", value: nil, want: 0},
		{name: "unusable", value: map[string]any{"value": float64(3450)}, want: 0},
	}
	for _, testCase := range cases {
		if got := parseCentVal(testCase.value); got != testCase.want {
			t.Errorf("%s: parseCentVal(%#v) = %d, want %d", testCase.name, testCase.value, got, testCase.want)
		}
	}
}
