package warmup

import (
	"encoding/json"
	"testing"
	"time"
)

func idleObservation(now time.Time) Observation {
	return Observation{Provider: "claude", ObservedAtMS: now.UnixMilli(), PaidFallback: "disabled", FiveHour: Window{State: "idle", PeriodMS: FIVE_HOUR_MS}, Weekly: Window{State: "idle", PeriodMS: WEEK_MS}}
}
func TestWarmupDecisions(t *testing.T) {
	policy := Policy{ResetMode: "all", IsDailyEnabled: true, DailyTime: "06:00", Model: "haiku"}
	for _, scenario := range []struct {
		name                    string
		hour, minute            int
		isManual                bool
		wantTrigger, wantReason string
	}{
		{"midnight reset fits", 0, 0, false, "reset", ""},
		{"02 reset held", 2, 0, false, "", "waiting_daily"},
		{"daily start", 6, 0, false, "daily", ""},
		{"catchup", 6, 40, false, "daily", ""},
		{"catchup boundary", 7, 0, false, "daily", ""},
		{"missed catchup", 7, 1, false, "reset", ""},
		{"manual bypasses calendar", 2, 0, true, "manual", ""},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			now := time.Date(2026, 10, 13, scenario.hour, scenario.minute, 0, 0, time.UTC)
			observation := idleObservation(now)
			trigger, reason, _, _ := Decide(policy, State{Observation: &observation}, now, scenario.isManual)
			if trigger != scenario.wantTrigger || reason != scenario.wantReason {
				t.Fatalf("%q %q", trigger, reason)
			}
		})
	}
	now := time.Date(2026, 10, 13, 6, 0, 0, 0, time.UTC)
	observation := idleObservation(now)
	observation.FiveHour.State = "active"
	used := float64(0)
	observation.FiveHour.UsedPercent = &used
	trigger, reason, _, _ := Decide(policy, State{Observation: &observation}, now, false)
	if trigger != "" || reason != "already_active" {
		t.Fatalf("running daily window: %q %q", trigger, reason)
	}
	policy.IsDailyEnabled = false
	policy.ResetMode = "off"
	trigger, reason, _, _ = Decide(policy, State{Observation: &observation}, now, false)
	if trigger != "" || reason != "disabled" {
		t.Fatal("off consumed")
	}
}
func TestStrictPaidFallbackAndQuotaProtection(t *testing.T) {
	now := time.Now()
	policy := DefaultPolicy()
	policy.Model = "haiku"
	for _, scenario := range []struct {
		name   string
		mutate func(*Observation)
		reason string
	}{
		{"paid enabled", func(observation *Observation) { observation.PaidFallback = "enabled" }, "paid_usage_enabled"},
		{"paid unknown", func(observation *Observation) { observation.PaidFallback = "unknown" }, "paid_usage_unknown"},
		{"stale", func(observation *Observation) { observation.ObservedAtMS = now.Add(-6 * time.Minute).UnixMilli() }, "quota_unknown"},
		{"future", func(observation *Observation) { observation.ObservedAtMS = now.Add(time.Minute).UnixMilli() }, "quota_unknown"},
		{"unknown window", func(observation *Observation) { observation.Weekly.State = "unknown" }, "quota_unknown"},
		{"blocked", func(observation *Observation) { observation.IsBlocked = true }, "quota_exhausted"},
		{"weekly exhausted", func(observation *Observation) {
			observation.Weekly.State = "active"
			used := float64(100)
			observation.Weekly.UsedPercent = &used
		}, "quota_exhausted"},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			observation := idleObservation(now)
			scenario.mutate(&observation)
			if reason := Eligibility(policy, &observation, now.UnixMilli()); reason != scenario.reason {
				t.Fatalf("%s", reason)
			}
		})
	}
}
func TestObservationNullMissingAndBillingTriState(t *testing.T) {
	now := time.Now()
	reset := now.Add(4 * time.Hour).Format(time.RFC3339)
	fixtures := []struct{ provider, raw, paid, five string }{
		{"claude", `{"five_hour":null,"seven_day":null,"extra_usage":{"is_enabled":false}}`, "disabled", "idle"},
		{"claude", `{"extra_usage":{"is_enabled":false}}`, "disabled", "unknown"},
		{"claude", `{"five_hour":null,"seven_day":null}`, "unknown", "idle"},
		{"claude", `{"five_hour":null,"seven_day":null,"extra_usage":{"is_enabled":null}}`, "unknown", "idle"},
		{"claude", `{"five_hour":null,"seven_day":null,"extra_usage":{"is_enabled":true}}`, "enabled", "idle"},
		{"claude", `{"five_hour":{"utilization":0,"resets_at":"` + reset + `"},"seven_day":null,"extra_usage":{"is_enabled":false}}`, "disabled", "active"},
		{"codex", `{"rate_limit":{"primary_window":{"used_percent":0,"limit_window_seconds":18000,"reset_at":null},"secondary_window":{"used_percent":0,"limit_window_seconds":604800,"reset_at":null}},"credits":{"has_credits":false,"unlimited":false,"balance":"0"}}`, "disabled", "idle"},
		{"codex", `{"rate_limit":{},"credits":{"balance":0,"unlimited":false}}`, "unknown", "unknown"},
		{"codex", `{"credits":{"has_credits":true,"unlimited":false,"balance":"0"}}`, "enabled", "unknown"},
		{"codex", `{"credits":{"has_credits":false,"unlimited":true,"balance":0}}`, "enabled", "unknown"},
	}
	for _, fixture := range fixtures {
		observation := ParseObservation(fixture.provider, []byte(fixture.raw), now.UnixMilli())
		if observation.PaidFallback != fixture.paid || observation.FiveHour.State != fixture.five {
			t.Fatalf("%s: %+v", fixture.raw, observation)
		}
	}
}
func TestCycleEvidenceAndDurableDedup(t *testing.T) {
	now := time.Now()
	observation := idleObservation(now)
	state := State{Observation: &observation, Generation: 3, LastCycle: "cycle/3"}
	policy := DefaultPolicy()
	policy.ResetMode = "all"
	policy.Model = "haiku"
	trigger, _, _, _ := Decide(policy, state, now, false)
	if trigger != "" {
		t.Fatal("duplicate cycle")
	}
	before := observation
	before.FiveHour.State = "active"
	before.ObservedAtMS--
	state.Observation = &before
	state = Reconcile(state, observation)
	if state.Generation != 4 {
		t.Fatal("reset generation missing")
	}
	trigger, _, _, _ = Decide(policy, state, now, false)
	if trigger != "reset" {
		t.Fatal("new reset ignored")
	}
	raw, _ := json.Marshal(state)
	var restored State
	_ = json.Unmarshal(raw, &restored)
	if restored.Generation != state.Generation || restored.LastCycle != state.LastCycle {
		t.Fatal("restart loses dedup")
	}
}
func TestCalendarAndDST(t *testing.T) {
	location, err := time.LoadLocation("America/New_York")
	if err != nil {
		t.Fatal(err)
	}
	for _, now := range []time.Time{time.Date(2026, 3, 8, 1, 0, 0, 0, location), time.Date(2026, 11, 1, 0, 0, 0, 0, location)} {
		next := NextDailyStart("06:00", now)
		if next.Hour() != 6 || next.Location() != location || !next.After(now) {
			t.Fatalf("%v", next)
		}
	}
	first := time.Date(2026, 11, 1, 1, 30, 0, 0, location)
	second := first.Add(time.Hour)
	if DailyKey("01:30", first) != DailyKey("01:30", second) {
		t.Fatal("DST duplicate daily key")
	}
	missing := DailyStart("02:30", time.Date(2026, 3, 8, 4, 0, 0, 0, location))
	if missing.Hour() != 3 {
		t.Fatalf("missing hour: %v", missing)
	}
}
func TestPolicyValidation(t *testing.T) {
	policy := DefaultPolicy()
	if policy.Validate() != nil {
		t.Fatal("default invalid")
	}
	for _, mutate := range []func(*Policy){func(policy *Policy) { policy.DailyTime = "24:00" }, func(policy *Policy) { policy.ResetMode = "bad" }, func(policy *Policy) { policy.IsDailyEnabled = true }, func(policy *Policy) { policy.Model = "token\nheader" }} {
		invalid := policy
		mutate(&invalid)
		if invalid.Validate() == nil {
			t.Fatal("invalid policy accepted")
		}
	}
}

func TestSlidingIdleBoundaryIsNotAZeroUsageGuess(t *testing.T) {
	now := time.Now()
	zero := float64(0)
	first := idleObservation(now)
	first.FiveHour.State = "active"
	first.FiveHour.UsedPercent = &zero
	reset := now.UnixMilli() + FIVE_HOUR_MS
	first.FiveHour.ResetAtMS = &reset
	later := first
	later.ObservedAtMS += 60000
	shifted := reset + 60000
	later.FiveHour.ResetAtMS = &shifted
	reconciled := Reconcile(State{Observation: &first}, later)
	if reconciled.Observation.FiveHour.State != "idle" {
		t.Fatal("sliding unused window not detected")
	}
	fixed := later
	fixed.FiveHour.ResetAtMS = &reset
	reconciled = Reconcile(State{Observation: &first}, fixed)
	if reconciled.Observation.FiveHour.State != "active" {
		t.Fatal("running zero-use fixed window treated idle")
	}
}

func TestModelScopedExhaustionDoesNotActivateAnExcludedFamily(t *testing.T) {
	now := time.Now()
	observation := ParseObservation("claude", []byte(`{"five_hour":null,"seven_day":null,"seven_day_sonnet":{"utilization":100,"resets_at":"2099-01-01T00:00:00Z"},"extra_usage":{"is_enabled":false}}`), now.UnixMilli())
	policy := DefaultPolicy()
	policy.Model = "claude-sonnet-test"
	if reason := Eligibility(policy, &observation, now.UnixMilli()); reason != "quota_exhausted" {
		t.Fatalf("%s", reason)
	}
	policy.Model = "claude-haiku-test"
	if reason := Eligibility(policy, &observation, now.UnixMilli()); reason != "" {
		t.Fatalf("unrelated family blocked %s", reason)
	}
}

func TestWarmupRetryStillHonoursDailyPriority(t *testing.T) {
	now := time.Date(2026, 10, 13, 1, 5, 0, 0, time.UTC)
	observation := idleObservation(now)
	policy := Policy{Model: "haiku", ResetMode: "all", IsDailyEnabled: true, DailyTime: "06:00"}
	state := State{Observation: &observation, Failures: 1, LastResult: &Result{Status: "failed", Reason: "rate_limited", Trigger: "reset"}}
	trigger, reason, _, _ := Decide(policy, state, now, false)
	if trigger != "" || reason != "waiting_daily" {
		t.Fatalf("retry crossed start: %s %s", trigger, reason)
	}
}

func TestFableWarmupRequiresAvailableModelScopedQuota(t *testing.T) {
	now := time.Date(2026, 10, 13, 9, 0, 0, 0, time.UTC)
	for _, scenario := range []struct {
		name, modelLimits, wantReason string
	}{
		{"modern object", `"iguana_necktie":{"utilization":0,"resets_at":null},"limits":{}`, "quota_unknown"},
		{"modern string", `"iguana_necktie":{"utilization":0,"resets_at":null},"limits":"invalid"`, "quota_unknown"},
		{"modern null", `"iguana_necktie":{"utilization":0,"resets_at":null},"limits":null`, "quota_unknown"},
		{"legacy exhausted", `"iguana_necktie":{"utilization":100,"resets_at":"2026-11-05T07:59:00Z"}`, "quota_exhausted"},
		{"modern exhausted", `"limits":[{"percent":100,"resets_at":"2026-11-05T07:59:00Z","scope":{"model":{"display_name":"Fable 5"}}}]`, "quota_exhausted"},
		{"modern malformed", `"limits":[{"percent":"invalid","resets_at":"2026-11-05T07:59:00Z","scope":{"model":{"display_name":"Fable"}}}]`, "quota_unknown"},
		{"modern overrides legacy", `"iguana_necktie":{"utilization":0,"resets_at":null},"limits":[{"percent":100,"resets_at":"2026-11-05T07:59:00Z","scope":{"model":{"display_name":"Fable"}}}]`, "quota_exhausted"},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			raw := `{"five_hour":null,"seven_day":{"utilization":0,"resets_at":"2026-10-20T05:00:00Z"},"extra_usage":{"is_enabled":false},` + scenario.modelLimits + `}`
			observation := ParseObservation("claude", []byte(raw), now.UnixMilli())
			policy := DefaultPolicy()
			policy.Model = "claude-fable-5"
			if reason := Eligibility(policy, &observation, now.UnixMilli()); reason != scenario.wantReason {
				t.Fatalf("Fable eligibility = %q; want %q", reason, scenario.wantReason)
			}
			policy.Model = "claude-haiku-4-5-20251001"
			if reason := Eligibility(policy, &observation, now.UnixMilli()); reason != "" {
				t.Fatalf("unrelated Haiku quota blocked: %s", reason)
			}
		})
	}
}
