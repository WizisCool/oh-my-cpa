package api

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"testing"

	"github.com/oh-my-cpa/oh-my-cpa/internal/warmup"
)

// Codex reports an unused window with a reset that slides with every read.
// After a warmup the reset freezes at the send time, which trails the first
// read by however long admission and the upstream call took.
func TestWarmupActivationTellsSlidingFromFrozenCodexWindow(t *testing.T) {
	const firstReadMS int64 = 1_770_000_000_000
	window := func(state string, resetMS, period int64) warmup.Window {
		zero := float64(0)
		return warmup.Window{State: state, UsedPercent: &zero, ResetAtMS: &resetMS, PeriodMS: period}
	}
	observation := func(observedMS int64, five, week warmup.Window) *warmup.Observation {
		return &warmup.Observation{Provider: "codex", ObservedAtMS: observedMS, PaidFallback: "disabled", FiveHour: five, Weekly: week}
	}
	before := observation(firstReadMS,
		window("idle", firstReadMS+warmup.FIVE_HOUR_MS, warmup.FIVE_HOUR_MS),
		window("active", firstReadMS+3*24*60*60*1000, warmup.WEEK_MS))
	for _, scenario := range []struct {
		name        string
		sendDelayMS int64
		laterMS     int64
		isActivated bool
	}{
		{"frozen after a slow send", 4_000, 60_000, true},
		{"frozen after an instant send", 0, 60_000, true},
		{"still sliding", 60_000, 60_000, false},
		{"read too soon to tell", 2_000, 10_000, false},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			afterMS := firstReadMS + scenario.laterMS
			after := observation(afterMS,
				window("active", firstReadMS+scenario.sendDelayMS+warmup.FIVE_HOUR_MS, warmup.FIVE_HOUR_MS),
				before.Weekly)
			if got := isWarmupActivated(before, after); got != scenario.isActivated {
				t.Fatalf("activated=%v, want %v", got, scenario.isActivated)
			}
		})
	}
}

// A second manual click while the first run is still confirming must not send
// again, and must not cut the first run's confirmation short.
func TestWarmupSecondClickLeavesPendingRunConfirming(t *testing.T) {
	fixture := &warmupFixture{isActivationDelayed: true}
	handler := newWarmupHandler(t, fixture)
	caller, baseURL := warmupHTTPClient(t, handler)
	route := baseURL + "/api/v1/management/quota/warmup/credentials/exact-claude"
	response, err := caller.Get(route)
	if err != nil {
		t.Fatal(err)
	}
	var credential struct {
		Revision string `json:"revision"`
	}
	_ = json.NewDecoder(response.Body).Decode(&credential)
	_ = response.Body.Close()
	run := func(requestID string) (int, warmup.Result) {
		t.Helper()
		body, _ := json.Marshal(map[string]any{"request_id": requestID, "revision": credential.Revision, "confirmed": true})
		response, err := caller.Post(route+"/run", "application/json", bytes.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		var result warmup.Result
		_ = json.NewDecoder(response.Body).Decode(&result)
		return response.StatusCode, result
	}
	if status, first := run("manual-first-click"); status != http.StatusOK || first.Status != "pending" || first.Reason != "activation_pending" {
		t.Fatalf("first: %d %+v", status, first)
	}
	if status, second := run("manual-second-click"); status != http.StatusOK || second.Status != "skipped" || second.Reason != "activation_pending" {
		t.Fatalf("second: %d %+v", status, second)
	}
	state, err := handler.repo.ReadWarmupState(context.Background(), "default", "exact-claude")
	if err != nil || state.LastResult == nil || state.LastResult.Status != "pending" || state.LastResult.RequestID != "manual-first-click" {
		t.Fatalf("pending run was rewritten: %+v %v", state.LastResult, err)
	}
	fixture.mu.Lock()
	defer fixture.mu.Unlock()
	if fixture.sends != 1 {
		t.Fatalf("sent %d", fixture.sends)
	}
}
