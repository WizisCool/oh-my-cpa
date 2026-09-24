package quota

import (
	"math"
	"testing"
	"time"
)

func TestParseCodexUsageCurrentPayload(t *testing.T) {
	raw := []byte(`{
		"plan_type": "pro",
		"rate_limit": {
			"allowed": true,
			"limit_reached": false,
			"primary_window": {
				"used_percent": 1,
				"limit_window_seconds": 604800,
				"reset_after_seconds": 601888,
				"reset_at": 1785902974
			},
			"secondary_window": null
		},
		"code_review_rate_limit": null,
		"additional_rate_limits": [
			{
				"limit_name": "GPT-5.3-Codex-Spark",
				"metered_feature": "codex_bengalfox",
				"rate_limit": {
					"allowed": true,
					"limit_reached": false,
					"primary_window": {
						"used_percent": 0,
						"limit_window_seconds": 604800,
						"reset_after_seconds": 602111,
						"reset_at": 1785903197
					},
					"secondary_window": null
				}
			}
		],
		"rate_limit_reset_credits": {
			"available_count": 1,
			"applicable_available_count": 0
		}
	}`)

	nowMS := time.Date(2025, 1, 1, 0, 0, 0, 0, time.UTC).UnixMilli()
	plan, windows, credits, err := ParseCodexUsage(raw, nowMS)
	if err != nil {
		t.Fatalf("ParseCodexUsage failed: %v", err)
	}

	if plan.PlanType != "pro" || plan.Tier != "elite" || plan.PlanLabel != "Pro 20x" {
		t.Errorf("plan = %+v, want pro/elite/Pro 20x", plan)
	}

	if len(windows) != 2 {
		t.Fatalf("len(windows) = %d, want 2", len(windows))
	}

	// First window classified as weekly due to 604800s
	w1 := windows[0]
	if w1.ID != "weekly" {
		t.Errorf("w1.ID = %q, want weekly", w1.ID)
	}
	if w1.UsedPercent == nil || *w1.UsedPercent != 1.0 {
		t.Errorf("w1.UsedPercent = %v, want 1.0", w1.UsedPercent)
	}
	if w1.RemainingPercent == nil || *w1.RemainingPercent != 99.0 {
		t.Errorf("w1.RemainingPercent = %v, want 99.0", w1.RemainingPercent)
	}

	// Second window additional
	w2 := windows[1]
	if w2.Model != "GPT-5.3-Codex-Spark" {
		t.Errorf("w2.Model = %q, want GPT-5.3-Codex-Spark", w2.Model)
	}
	if w2.UsedPercent == nil || *w2.UsedPercent != 0.0 {
		t.Errorf("w2.UsedPercent = %v, want 0.0", w2.UsedPercent)
	}
	if w2.RemainingPercent == nil || *w2.RemainingPercent != 100.0 {
		t.Errorf("w2.RemainingPercent = %v, want 100.0", w2.RemainingPercent)
	}

	// Credits
	if credits == nil || credits.AvailableCount != 1 || credits.ApplicableAvailableCount != 0 {
		t.Errorf("credits = %+v, want available: 1, applicable: 0", credits)
	}
}

func TestParseCodexUsageCamelCaseAndClamping(t *testing.T) {
	raw := []byte(`{
		"planType": "plus",
		"rateLimit": {
			"primaryWindow": {
				"usedPercent": 140,
				"limitWindowSeconds": 18000,
				"resetAfterSeconds": 120
			}
		}
	}`)

	nowMS := time.Now().UnixMilli()
	plan, windows, _, err := ParseCodexUsage(raw, nowMS)
	if err != nil {
		t.Fatalf("ParseCodexUsage failed: %v", err)
	}

	if plan.Tier != "standard" || plan.PlanLabel != "Plus" {
		t.Errorf("plan = %+v, want standard/Plus", plan)
	}

	if len(windows) != 1 {
		t.Fatalf("len(windows) = %d, want 1", len(windows))
	}

	w := windows[0]
	if w.ID != "five_hour" {
		t.Errorf("w.ID = %q, want five_hour", w.ID)
	}
	if w.UsedPercent == nil || *w.UsedPercent != 100.0 {
		t.Errorf("w.UsedPercent clamped = %v, want 100.0", w.UsedPercent)
	}
	if w.RemainingPercent == nil || *w.RemainingPercent != 0.0 {
		t.Errorf("w.RemainingPercent clamped = %v, want 0.0", w.RemainingPercent)
	}
	if w.ResetAccuracy != "derived" {
		t.Errorf("w.ResetAccuracy = %q, want derived", w.ResetAccuracy)
	}
}

func TestParseCodexUsageRejectsNonFiniteNumbersAndHonoursLimitReached(t *testing.T) {
	raw := []byte(`{
		"plan_type": "pro",
		"rate_limit": {
			"allowed": true,
			"limit_reached": false,
			"primary_window": {
				"used_percent": "NaN",
				"limit_window_seconds": 18000
			}
		},
		"code_review_rate_limit": {
			"allowed": false,
			"primary_window": {
				"used_percent": 10,
				"limit_window_seconds": 18000
			}
		}
	}`)

	_, windows, _, err := ParseCodexUsage(raw, time.Now().UnixMilli())
	if err != nil {
		t.Fatalf("ParseCodexUsage failed: %v", err)
	}
	if len(windows) != 2 {
		t.Fatalf("len(windows) = %d, want 2", len(windows))
	}
	if windows[0].UsedPercent != nil {
		t.Fatalf("non-finite used_percent = %v, want it omitted", windows[0].UsedPercent)
	}
	if windows[1].ID != "code_review_5h" {
		t.Fatalf("code-review window id = %q, want code_review_5h", windows[1].ID)
	}
	if windows[1].UsedPercent == nil || *windows[1].UsedPercent != 100 {
		t.Fatalf("limit-reached code-review used_percent = %v, want 100", windows[1].UsedPercent)
	}
}

func TestParseCodexResetCreditsPayload(t *testing.T) {
	raw := []byte(`{
		"available_count": 3,
		"applicable_available_count": 1,
		"credits": [
			{
				"id": "credit-1",
				"status": "available",
				"reset_type": "codex_rate_limits",
				"granted_at": "1790000000",
				"expires_at": "1810000000"
			},
			{
				"id": "credit-2",
				"status": "used",
				"reset_type": "codex_rate_limits",
				"granted_at": "1790000000",
				"expires_at": "1805000000"
			},
			{
				"id": "credit-3",
				"status": "available",
				"reset_type": "sponsor_perk",
				"granted_at": "1790000000",
				"expires_at": "1820000000"
			},
			{
				"id": "credit-4",
				"status": "available",
				"grantedAt": "1790000000",
				"expiresAt": "1830000000"
			}
		]
	}`)

	info, err := ParseCodexResetCreditsPayload(raw)
	if err != nil {
		t.Fatalf("ParseCodexResetCreditsPayload returned error: %v", err)
	}
	if info.AvailableCount != 3 {
		t.Errorf("AvailableCount = %d, want 3", info.AvailableCount)
	}
	if info.ApplicableAvailableCount != 1 {
		t.Errorf("ApplicableAvailableCount = %d, want 1", info.ApplicableAvailableCount)
	}
	// Only codex_rate_limits + available credits survive: credit-1 and credit-4.
	if len(info.Credits) != 2 {
		t.Fatalf("len(credits) = %d, want 2", len(info.Credits))
	}
	first := info.Credits[0]
	if first.ID != "credit-1" || first.ExpiresAtMS == nil || *first.ExpiresAtMS != 1810000000000 {
		t.Errorf("first credit = %+v, want credit-1 expiring at 1810000000000", first)
	}
	if second := info.Credits[1]; second.ID != "credit-4" {
		t.Errorf("second credit = %+v, want credit-4 (camelCase fallback)", second)
	}
}

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

func TestParseCodexSubscription(t *testing.T) {
	until, shouldRenew, ok := ParseCodexSubscription([]byte(`{
		"plan_type": "plus",
		"active_start": "2026-08-29T14:02:31Z",
		"active_until": "2026-09-29T14:02:31Z",
		"will_renew": true
	}`))
	if !ok {
		t.Fatal("ParseCodexSubscription rejected a well-formed payload")
	}
	want := time.Date(2026, 9, 29, 14, 2, 31, 0, time.UTC).UnixMilli()
	if until != want {
		t.Errorf("until = %d, want %d", until, want)
	}
	if shouldRenew == nil || !*shouldRenew {
		t.Errorf("shouldRenew = %v, want true", shouldRenew)
	}

	// A response without a usable window must be reported as absent so the
	// caller keeps its previous source instead of overwriting it with zero.
	for _, raw := range []string{
		`{"active_until": null}`,
		`{"active_until": ""}`,
		`{}`,
		`not json`,
	} {
		if _, _, ok := ParseCodexSubscription([]byte(raw)); ok {
			t.Errorf("ParseCodexSubscription(%s) = ok, want rejected", raw)
		}
	}
}

// A model-scoped limit is named from the period upstream metered. Codex moves the same
// reserve limit between windows, so a label that hardcodes "5小时" would contradict the
// payload: the live account reported `gpt-reserve` under a weekly primary window.
func TestParseCodexUsageNamesModelLimitsByTheirOwnPeriod(t *testing.T) {
	raw := []byte(`{
		"plan_type": "plus",
		"rate_limit": {
			"primary_window": {"used_percent": 0, "limit_window_seconds": 18000, "reset_after_seconds": 3600}
		},
		"additional_rate_limits": [
			{
				"limit_name": "gpt-reserve",
				"rate_limit": {
					"primary_window": {"used_percent": 0, "limit_window_seconds": 604800, "reset_after_seconds": 86400}
				}
			},
			{
				"limit_name": "o-series",
				"rate_limit": {
					"primary_window": {"used_percent": 10, "limit_window_seconds": 18000, "reset_after_seconds": 3600}
				}
			}
		],
		"code_review_rate_limit": {
			"primary_window": {"used_percent": 5, "limit_window_seconds": 18000}
		}
	}`)

	_, windows, _, err := ParseCodexUsage(raw, time.Now().UnixMilli())
	if err != nil {
		t.Fatalf("ParseCodexUsage failed: %v", err)
	}

	labels := make(map[string]string)
	for _, window := range windows {
		labels[window.ID] = window.Label
	}

	if got := labels["addl_0_p"]; got != "gpt-reserve 每周配额" {
		t.Errorf("weekly reserve label = %q, want %q", got, "gpt-reserve 每周配额")
	}
	if got := labels["addl_1_p"]; got != "o-series 5小时配额" {
		t.Errorf("five-hour model label = %q, want %q", got, "o-series 5小时配额")
	}
	if got := labels["code_review_5h"]; got != "代码审查 5小时配额" {
		t.Errorf("code-review label = %q, want %q", got, "代码审查 5小时配额")
	}
	if got := labels["five_hour"]; got != "5小时用量上限 (5-Hour)" {
		t.Errorf("standard five-hour label = %q, want the standard wording", got)
	}
}

// A window whose size the payload omits cannot be named from its period, so the label the
// caller supplied for that slot stands: an empty or truncated label would lose the only
// description the window has.
func TestParseCodexUsageKeepsSlotLabelWhenWindowSizeIsMissing(t *testing.T) {
	raw := []byte(`{
		"plan_type": "plus",
		"code_review_rate_limit": {
			"primary_window": {"used_percent": 5},
			"secondary_window": {"used_percent": 9}
		},
		"additional_rate_limits": [
			{"limit_name": "o-series", "rate_limit": {"primary_window": {"used_percent": 3}}}
		]
	}`)

	_, windows, _, err := ParseCodexUsage(raw, time.Now().UnixMilli())
	if err != nil {
		t.Fatalf("ParseCodexUsage failed: %v", err)
	}
	labels := make(map[string]string)
	for _, window := range windows {
		labels[window.ID] = window.Label
	}
	if labels["code_review_5h"] != "代码审查 5小时配额" {
		t.Errorf("code-review five-hour label = %q, want the slot wording back", labels["code_review_5h"])
	}
	if labels["code_review_weekly"] != "代码审查 每周配额" {
		t.Errorf("code-review weekly label = %q, want the slot wording back", labels["code_review_weekly"])
	}
	if labels["addl_0_p"] != "o-series" {
		t.Errorf("model label = %q, want the model name alone rather than a guessed slot", labels["addl_0_p"])
	}
}
