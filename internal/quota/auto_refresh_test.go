package quota

import (
	"errors"
	"testing"
	"time"
)

func TestParseAutoRefreshSettingsIsStrict(t *testing.T) {
	valid := map[string]AutoRefreshSettings{
		`{"interval_minutes":0,"refresh_on_reset":true}`:     {IntervalMinutes: 0, IsRefreshOnResetEnabled: true},
		`{"interval_minutes":30,"refresh_on_reset":false}`:   {IntervalMinutes: 30, IsRefreshOnResetEnabled: false},
		`{"interval_minutes":5,"refresh_on_reset":true}`:     {IntervalMinutes: 5, IsRefreshOnResetEnabled: true},
		`{"interval_minutes":1440,"refresh_on_reset":false}`: {IntervalMinutes: 1440},
	}
	for raw, want := range valid {
		got, err := ParseAutoRefreshSettings([]byte(raw))
		if err != nil || got != want {
			t.Fatalf("%s: got %+v err=%v, want %+v", raw, got, err, want)
		}
	}
	for _, raw := range []string{
		``,
		`null`,
		`{}`,
		`{"interval_minutes":30}`,
		`{"refresh_on_reset":true}`,
		`{"interval_minutes":4,"refresh_on_reset":true}`,
		`{"interval_minutes":1441,"refresh_on_reset":true}`,
		`{"interval_minutes":-1,"refresh_on_reset":true}`,
		`{"interval_minutes":"30","refresh_on_reset":true}`,
		`{"interval_minutes":30,"refresh_on_reset":true,"extra":1}`,
		`{"interval_minutes":30,"refresh_on_reset":true}{}`,
	} {
		if _, err := ParseAutoRefreshSettings([]byte(raw)); !errors.Is(err, ErrInvalidAutoRefreshSettings) {
			t.Fatalf("%q: err=%v, want ErrInvalidAutoRefreshSettings", raw, err)
		}
	}
}

func TestResolveAutoRefreshSettingsFallsBackToDefaults(t *testing.T) {
	defaults := DefaultAutoRefreshSettings()
	if defaults.IntervalMinutes != 360 || !defaults.IsRefreshOnResetEnabled {
		t.Fatalf("defaults = %+v, want a six-hour schedule and reset-driven reads on", defaults)
	}
	for _, input := range []struct {
		raw      string
		isStored bool
	}{{"", false}, {`{"interval_minutes":30,"refresh_on_reset":false}`, false}, {"", true}, {`"future"`, true}, {`{}`, true}, {`null`, true}} {
		if got := ResolveAutoRefreshSettings(input.raw, input.isStored); got != defaults {
			t.Fatalf("%+v resolved to %+v, want defaults", input, got)
		}
	}
	// A newer build's extra field, or one field this build cannot honour, must not turn
	// the operator's choice for the other field back into the default.
	for raw, want := range map[string]AutoRefreshSettings{
		`{"interval_minutes":0,"refresh_on_reset":false,"future_field":1}`: {},
		`{"refresh_on_reset":false}`:                                       {IntervalMinutes: 360},
		`{"interval_minutes":3,"refresh_on_reset":false}`:                  {IntervalMinutes: 360},
		`{"interval_minutes":45,"refresh_on_reset":"no"}`:                  {IntervalMinutes: 45, IsRefreshOnResetEnabled: true},
		`{"interval_minutes":"30","refresh_on_reset":true}`:                defaults,
		`{"interval_minutes":15,"refresh_on_reset":null}`:                  {IntervalMinutes: 15, IsRefreshOnResetEnabled: true},
	} {
		if got := ResolveAutoRefreshSettings(raw, true); got != want {
			t.Fatalf("%s resolved to %+v, want %+v", raw, got, want)
		}
	}
	stored := ResolveAutoRefreshSettings(`{"interval_minutes":60,"refresh_on_reset":false}`, true)
	if stored.IntervalMinutes != 60 || stored.IsRefreshOnResetEnabled || !stored.IsEnabled() {
		t.Fatalf("stored = %+v", stored)
	}
	if (AutoRefreshSettings{}).IsEnabled() {
		t.Fatal("both triggers off must not be enabled")
	}
}

func TestAutoRefreshTrigger(t *testing.T) {
	const nowMS = int64(10_000_000_000)
	minute := time.Minute.Milliseconds()
	resetOnly := AutoRefreshSettings{IsRefreshOnResetEnabled: true}
	intervalOnly := AutoRefreshSettings{IntervalMinutes: 30}
	both := AutoRefreshSettings{IntervalMinutes: 30, IsRefreshOnResetEnabled: true}
	read := func(observedAgoMS int64, resetsAgoMS ...int64) AutoRefreshCandidate {
		candidate := AutoRefreshCandidate{Provider: "codex", IsSupported: true, LastObservedAtMS: nowMS - observedAgoMS}
		for _, ago := range resetsAgoMS {
			candidate.ResetAtMS = append(candidate.ResetAtMS, nowMS-ago)
		}
		return candidate
	}

	cases := []struct {
		name      string
		settings  AutoRefreshSettings
		candidate AutoRefreshCandidate
		want      string
	}{
		{"reset passed beyond grace after the reading", resetOnly, read(3*60*minute, 2*minute), AutoRefreshTriggerReset},
		{"reset inside the grace waits", resetOnly, read(3*60*minute, minute/2), AutoRefreshTriggerNone},
		{"reset still ahead", resetOnly, read(10*minute, -60*minute), AutoRefreshTriggerNone},
		{"reading already after the reset", resetOnly, read(minute/2, 5*minute), AutoRefreshTriggerNone},
		{"one passed reset among future ones", resetOnly, read(3*60*minute, -7*24*60*minute, 2*minute), AutoRefreshTriggerReset},
		{"never read is not reset-driven", resetOnly, AutoRefreshCandidate{Provider: "codex", IsSupported: true}, AutoRefreshTriggerNone},
		{"reset trigger off", intervalOnly, read(10*minute, 2*minute), AutoRefreshTriggerNone},
		{"interval elapsed", intervalOnly, read(31 * minute), AutoRefreshTriggerInterval},
		{"reading stamped after its tick is due on the tick that ends the interval", intervalOnly, read(30*minute - 5_000), AutoRefreshTriggerInterval},
		{"interval not elapsed", intervalOnly, read(29 * minute), AutoRefreshTriggerNone},
		{"never read is due on schedule", intervalOnly, AutoRefreshCandidate{Provider: "claude", IsSupported: true}, AutoRefreshTriggerInterval},
		{"reset wins over interval", both, read(31*minute, 2*minute), AutoRefreshTriggerReset},
		{"disabled credential", both, func() AutoRefreshCandidate { c := read(31*minute, 2*minute); c.IsDisabled = true; return c }(), AutoRefreshTriggerNone},
		{"unsupported provider", both, func() AutoRefreshCandidate { c := read(31*minute, 2*minute); c.IsSupported = false; return c }(), AutoRefreshTriggerNone},
		{"meta is never read on its own", both, func() AutoRefreshCandidate { c := read(31*minute, 2*minute); c.Provider = "meta"; return c }(), AutoRefreshTriggerNone},
		{"failed reset attempt is not repeated", both, func() AutoRefreshCandidate {
			c := read(3*60*minute, 2*minute)
			c.LastAttemptAtMS = nowMS - minute/2
			return c
		}(), AutoRefreshTriggerNone},
		{"failed attempt delays the interval", intervalOnly, func() AutoRefreshCandidate {
			c := read(60 * minute)
			c.LastAttemptAtMS = nowMS - 10*minute
			return c
		}(), AutoRefreshTriggerNone},
		{"failed reset read is retried after the backoff", resetOnly, func() AutoRefreshCandidate {
			c := read(3*60*minute, 20*minute)
			c.LastAttemptAtMS = nowMS - 15*minute
			return c
		}(), AutoRefreshTriggerReset},
		{"failed reset read is not retried inside the backoff", resetOnly, func() AutoRefreshCandidate {
			c := read(3*60*minute, 20*minute)
			c.LastAttemptAtMS = nowMS - 5*minute
			return c
		}(), AutoRefreshTriggerNone},
		{"failed reset read stops after the retry window", resetOnly, func() AutoRefreshCandidate {
			c := read(5*60*minute, 2*60*minute)
			c.LastAttemptAtMS = nowMS - 30*minute
			return c
		}(), AutoRefreshTriggerNone},
		{"attempt before a later reset still allows it", resetOnly, func() AutoRefreshCandidate {
			c := read(3*60*minute, 2*minute)
			c.LastAttemptAtMS = nowMS - 60*minute
			return c
		}(), AutoRefreshTriggerReset},
	}
	for _, tc := range cases {
		if got := AutoRefreshTrigger(tc.settings, tc.candidate, nowMS); got != tc.want {
			t.Errorf("%s: trigger = %q, want %q", tc.name, got, tc.want)
		}
	}
}

func TestWindowResetTimesSkipsUnstatedResets(t *testing.T) {
	reset := int64(42)
	zero := int64(0)
	got := WindowResetTimes([]QuotaWindow{{ID: "a", ResetAtMS: &reset}, {ID: "b"}, {ID: "c", ResetAtMS: &zero}})
	if len(got) != 1 || got[0] != reset {
		t.Fatalf("resets = %v, want [42]", got)
	}
}
