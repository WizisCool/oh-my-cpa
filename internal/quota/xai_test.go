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

	if len(windows) != 1 {
		t.Fatalf("len(windows) = %d, want only the credit window", len(windows))
	}

	w0 := windows[0]
	if w0.ID != "xai_credit_usage" || *w0.UsedPercent != 34.5 || *w0.RemainingPercent != 65.5 {
		t.Errorf("w0 = %+v", w0)
	}

	if len(plan.UsageBreakdown) != 1 || plan.UsageBreakdown[0].Name != "grok-2" || *plan.UsageBreakdown[0].SharePercent != 20.0 {
		t.Errorf("breakdown = %+v", plan.UsageBreakdown)
	}
}

// A SuperGrok subscription publishes its window in the credits document and nothing in the metered
// ledger. Reading the ledger alone is what reported these accounts as having no usage at all, so
// the pair has to yield the credits reading and keep the ledger's own figures beside it.
func TestParseXaiBillingDocumentsCombinesTheCreditsAndLedgerDocuments(t *testing.T) {
	credits := []byte(`{
		"config": {
			"credit_usage_percent": 28.5,
			"current_period": {
				"type": "USAGE_PERIOD_TYPE_WEEKLY",
				"start": "2026-09-17T13:32:42.093205+00:00",
				"end": "2026-09-24T13:32:42.093205+00:00"
			},
			"product_usage": [{"product": "grok-4", "usage_percent": 31.2}]
		}
	}`)
	ledger := []byte(`{"config": {"monthly_limit": {"val": 20000}, "used": {"val": 5700}}}`)

	nowMS := time.Date(2026, 9, 20, 3, 0, 0, 0, time.UTC).UnixMilli()
	plan, windows, err := ParseXaiBillingDocuments(credits, ledger, nowMS)
	if err != nil {
		t.Fatalf("ParseXaiBillingDocuments failed: %v", err)
	}
	if len(windows) != 1 {
		t.Fatalf("len(windows) = %d, want the credits document's window", len(windows))
	}
	if len(plan.UsageBreakdown) != 1 || plan.UsageBreakdown[0].Name != "grok-4" {
		t.Errorf("breakdown = %+v, want the credits document's product", plan.UsageBreakdown)
	}

	credit := windows[0]
	if credit.ID != "xai_credit_usage" || credit.UsedPercent == nil || *credit.UsedPercent != 28.5 {
		t.Errorf("credit window = %+v", credit)
	}
	// The period and the reset come from the document that stated them. Upstream writes fractional
	// seconds with an explicit offset, and an instant the parser rejects costs the window its reset.
	if credit.PeriodHours == nil || *credit.PeriodHours != 168 {
		t.Errorf("PeriodHours = %v, want the 168 hours the payload spans", credit.PeriodHours)
	}
	wantReset := time.Date(2026, 9, 24, 13, 32, 42, 93*int(time.Millisecond), time.UTC).UnixMilli()
	if credit.ResetAtMS == nil || *credit.ResetAtMS != wantReset || credit.ResetAccuracy != "exact" {
		t.Errorf("reset = %v / %q, want %d exact", credit.ResetAtMS, credit.ResetAccuracy, wantReset)
	}

	// The ledger describes the account rather than the window, so it arrives as extra usage.
	if plan.ExtraUsage == nil || plan.ExtraUsage.MonthlyLimitCents != 20000 || plan.ExtraUsage.UsedCreditsCents != 5700 {
		t.Errorf("extra usage = %+v", plan.ExtraUsage)
	}
}

// A document that states no period keeps the weekly window the CLI's own reading assumes, so either
// document alone still yields a window.
func TestParseXaiBillingDocumentsReadsASingleDocument(t *testing.T) {
	ledger := []byte(`{"config": {"credit_usage_percent": 42, "billing_period_end": "2026-10-01T00:00:00Z"}}`)

	plan, windows, err := ParseXaiBillingDocuments(nil, ledger, time.Now().UnixMilli())
	if err != nil || plan == nil {
		t.Fatalf("ledger-only read failed: %v %+v", err, plan)
	}
	if len(windows) != 1 || windows[0].UsedPercent == nil || *windows[0].UsedPercent != 42 {
		t.Fatalf("windows = %+v", windows)
	}
	if windows[0].PeriodHours == nil || *windows[0].PeriodHours != 168 {
		t.Errorf("PeriodHours = %v, want the weekly assumption for a document without a period", windows[0].PeriodHours)
	}
}

func TestParseXaiBillingDocumentsNeedsAConfigInOneDocument(t *testing.T) {
	plan, windows, err := ParseXaiBillingDocuments([]byte(`{}`), []byte(`{"config": null}`), time.Now().UnixMilli())
	if err == nil || plan != nil || windows != nil {
		t.Fatalf("plan/windows/err = %+v / %+v / %v, want nothing but an error", plan, windows, err)
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

// A product's share is a part of the credit usage, not a limit of its own. As a
// window, a product carrying 96% of the traffic would read as nearly exhausted
// and push the credential's recommendation to a warning it does not deserve.
func TestParseXaiBillingReadsProductsAsAShareOfUsage(t *testing.T) {
	raw := []byte(`{"config": {"credit_usage_percent": 10, "product_usage": [
		{"product": "grok-4", "usage_percent": 96},
		{"product": "grok-4-fast"},
		{"product": "grok-3", "usage_percent": "not-a-number"}
	]}}`)
	nowMS := time.Date(2026, 9, 20, 3, 0, 0, 0, time.UTC).UnixMilli()
	plan, windows, err := ParseXaiBilling(raw, nowMS)
	if err != nil {
		t.Fatalf("ParseXaiBilling failed: %v", err)
	}
	if len(windows) != 1 || windows[0].ID != "xai_credit_usage" {
		t.Fatalf("windows = %+v, want only the credit window", windows)
	}
	reading := &NormalizedQuota{Plan: plan, Windows: windows}
	EvaluateStatusAndRecommendation(reading, nowMS)
	if reading.Status != "healthy" {
		t.Errorf("status = %q, want healthy at 10%% used", reading.Status)
	}
	breakdown := plan.UsageBreakdown
	if len(breakdown) != 3 || breakdown[0].Name != "grok-4" || breakdown[0].SharePercent == nil || *breakdown[0].SharePercent != 96 {
		t.Fatalf("breakdown = %+v, want all three products with grok-4 at 96%%", breakdown)
	}
	// A product without a readable share is listed as unavailable, not hidden.
	if breakdown[1].SharePercent != nil || breakdown[2].SharePercent != nil {
		t.Errorf("breakdown = %+v, want no share for the unreadable products", breakdown)
	}
}

// A ledger stating a zero cap says pay-as-you-go is off; a document stating no
// cap says nothing about it.
func TestParseXaiBillingReportsPayAsYouGoOff(t *testing.T) {
	nowMS := time.Date(2026, 9, 20, 3, 0, 0, 0, time.UTC).UnixMilli()
	plan, _, err := ParseXaiBilling([]byte(`{"config": {"monthly_limit": {"val": 0}, "used": {"val": 0}}}`), nowMS)
	if err != nil || plan.ExtraUsage == nil || plan.ExtraUsage.IsEnabled {
		t.Fatalf("zero cap: plan = %+v, %v; want extra usage reported off", plan, err)
	}
	for _, document := range []string{`{"config": {"credit_usage_percent": 5}}`, `{"config": {"monthly_limit": {"value": 0}}}`, `{"config": {"monthly_limit": "unlimited"}}`} {
		plan, _, err = ParseXaiBilling([]byte(document), nowMS)
		if err != nil || plan.ExtraUsage != nil {
			t.Fatalf("%s: plan = %+v, %v; want no extra usage claim from an absent or unreadable cap", document, plan, err)
		}
	}
}
