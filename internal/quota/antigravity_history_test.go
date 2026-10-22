package quota

import (
	"encoding/json"
	"testing"
	"time"
)

func TestParseAntigravityUsageMatchesPersistedWindowHistory(t *testing.T) {
	// These IDs were stored after the original five-hour/weekly sort, even
	// though the provider returned the weekly bucket first.
	const snapshot = `[
		{"id":"ag_Gemini Models_bucket_0_0","scope":"group","model_families":["gemini"],"used_percent":10,"period_hours":5,"reset_at_ms":1792731600000},
		{"id":"ag_Gemini Models_bucket_0_1","scope":"group","model_families":["gemini"],"used_percent":40,"period_hours":168,"reset_at_ms":1793232000000,"has_incomplete_history":true}
	]`
	var storedWindows []QuotaWindow
	if err := json.Unmarshal([]byte(snapshot), &storedWindows); err != nil {
		t.Fatal(err)
	}
	observedAtMS := time.Date(2026, 10, 23, 1, 0, 0, 0, time.UTC).UnixMilli()
	windows, err := ParseAntigravityUsage([]byte(`{"groups":[{"displayName":"Gemini Models","buckets":[
		{"window":"weekly","remainingFraction":0.6,"resetTime":"2026-10-29T00:00:00Z"},
		{"window":"5h","remainingFraction":0.9,"resetTime":"2026-10-23T05:00:00Z"}
	]}]}`), observedAtMS, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(windows) != 2 {
		t.Fatalf("windows = %d, want two persisted windows", len(windows))
	}
	history := []ObservedWindows{{ObservedAtMS: observedAtMS - 60_000, Windows: storedWindows}}
	for windowIndex, window := range windows {
		if window.ID != storedWindows[windowIndex].ID {
			t.Errorf("window %d changed identity: %q, want %q", windowIndex, window.ID, storedWindows[windowIndex].ID)
		}
		fromMS, toMS, reason := WindowCycleRange(window, observedAtMS, observedAtMS)
		if reason != "" {
			t.Fatalf("window %q has no valid cycle: %s", window.ID, reason)
		}
		if HasWindowCycleReset(window, history, fromMS, toMS) {
			t.Errorf("window %q borrowed reset evidence from another period", window.ID)
		}
		if got := HasIncompleteWindowHistory(window, history, fromMS, toMS); got != storedWindows[windowIndex].HasIncompleteHistory {
			t.Errorf("window %q borrowed another period's evidence gap: %v", window.ID, got)
		}
	}

	storedWindows[0].HasMidCycleReset = true
	for windowIndex, window := range windows {
		if got := HasWindowCycleReset(window, history, observedAtMS-60_000, observedAtMS); got != (windowIndex == 0) {
			t.Errorf("window %q lost or borrowed retained reset evidence: %v", window.ID, got)
		}
	}
}

func TestParseAntigravityUsageKeepsPersistedPreviousCycleReference(t *testing.T) {
	observedAtMS := time.Date(2026, 10, 23, 1, 0, 0, 0, time.UTC).UnixMilli()
	windows, err := ParseAntigravityUsage([]byte(`{"groups":[{"displayName":"Gemini Models","buckets":[
		{"window":"weekly","remainingFraction":0.6,"resetTime":"2026-10-29T00:00:00Z"},
		{"window":"5h","remainingFraction":0.9,"resetTime":"2026-10-23T05:00:00Z"}
	]}]}`), observedAtMS, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(windows) != 2 {
		t.Fatalf("windows = %d, want two quota windows", len(windows))
	}
	previous := QuotaWindow{
		ID: "ag_Gemini Models_bucket_0_0", Scope: "group", ModelFamilies: []string{"gemini"},
		UsedPercent: floatPtr(40), PeriodHours: floatPtr(5), ResetAccuracy: "exact",
		ResetAtMS: int64Ptr(observedAtMS - hourMS),
	}
	previousAtMS := observedAtMS - 2*hourMS
	history := []ObservedWindows{{ObservedAtMS: previousAtMS, Windows: []QuotaWindow{previous}}}
	actual, actualAtMS, hasPrevious := PreviousWindowObservation(windows[0], history, observedAtMS, observedAtMS)
	if !hasPrevious || actual.ID != previous.ID || actualAtMS != previousAtMS || actual.UsedPercent == nil || *actual.UsedPercent != 40 {
		t.Fatalf("persisted previous cycle lost: window=%+v at=%d found=%v", actual, actualAtMS, hasPrevious)
	}
}
