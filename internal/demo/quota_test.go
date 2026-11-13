package demo

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strings"
	"testing"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/quota"
)

func TestSeedQuotaObservationsIncludeScopedAndPreviousCycles(t *testing.T) {
	repo, _, _ := seededDatabase(t)
	ctx := context.Background()
	latest, err := repo.GetLatestQuotaSnapshots(ctx, []string{"auth-codex-01", "auth-codex-02", "auth-claude-01", "auth-antigravity-01"})
	if err != nil {
		t.Fatal(err)
	}
	if len(latest) != 4 {
		t.Fatalf("observed credentials=%d", len(latest))
	}
	var windows []quota.QuotaWindow
	if err := json.Unmarshal([]byte(latest["auth-antigravity-01"].WindowsJSON), &windows); err != nil {
		t.Fatal(err)
	}
	// Three families, one bucket each for the weekly-only one: the shape that proves a group's
	// single reading reaches a column of its own instead of being read as a second plan window.
	families := make([][]string, 0, len(windows))
	for _, window := range windows {
		families = append(families, window.ModelFamilies)
	}
	want := [][]string{{"gemini"}, {"gemini"}, {"claude", "gpt"}, {"claude", "gpt"}, {"gemini-4-argon"}}
	if len(families) != len(want) {
		t.Fatalf("demo antigravity windows=%d, families=%v", len(windows), families)
	}
	for index, family := range families {
		if strings.Join(family, ",") != strings.Join(want[index], ",") {
			t.Fatalf("demo antigravity window %d families=%v, want %v", index, family, want[index])
		}
	}
	// A family the capacity estimate cannot classify withholds the whole reading, so the names
	// must resolve to known capacity families rather than merely being recorded.
	if _, reason := quota.SelectWindowUsage(windows[len(windows)-1], nil); reason != "" {
		t.Fatalf("demo weekly-only family is not a known capacity family: %q", reason)
	}
	primary := latest["auth-codex-01"]
	observationWindows := []quota.QuotaWindow{}
	if err := json.Unmarshal([]byte(primary.WindowsJSON), &observationWindows); err != nil {
		t.Fatal(err)
	}
	primaryCycles, err := repo.LoadCapacityCycles(ctx, "auth-codex-01")
	if err != nil {
		t.Fatal(err)
	}
	hasForecast := false
	for _, window := range observationWindows {
		forecasts, _ := quota.BuildModelForecasts(window, nil, primary.ObservedAtMS, primaryCycles[quota.CapacityWindowKey("codex", window)])
		hasForecast = hasForecast || len(forecasts) > 0
	}
	if !hasForecast {
		t.Fatalf("demo direct model sample missing: %+v", primaryCycles)
	}

	windows = nil
	if err := json.Unmarshal([]byte(latest["auth-codex-02"].WindowsJSON), &windows); err != nil {
		t.Fatal(err)
	}
	// Retained consumption remains inspectable independently of current forecasts.
	cycles, err := repo.LoadCapacityCycles(ctx, "auth-codex-02")
	if err != nil {
		t.Fatal(err)
	}
	evidence := cycles[quota.CapacityWindowKey("codex", windows[0])]
	if len(evidence) != 2 || len(evidence[1].Points) == 0 || evidence[1].Points[0].Requests == 0 {
		t.Fatalf("demo previous cycle has no recorded evidence: %+v", evidence)
	}
	forecasts, _ := quota.BuildModelForecasts(windows[0], nil, latest["auth-codex-02"].ObservedAtMS, evidence)
	for _, forecast := range forecasts {
		if forecast.FromMS < evidence[0].CycleStartMS() {
			t.Fatalf("previous cycle supplied a forecast: %+v", forecast)
		}
	}
}

func TestSeedQuotaObservationsWrapCancellation(t *testing.T) {
	repo, now, _ := seededDatabase(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	err := seedQuotaObservations(ctx, repo, now)
	if !errors.Is(err, context.Canceled) || !strings.Contains(err.Error(), "for auth-codex-01") {
		t.Fatalf("seed failure must identify the credential and preserve cancellation: %v", err)
	}
}

func TestSaveDemoQuotaSnapshotWrapMarshalFailure(t *testing.T) {
	usedPercent := math.NaN()
	err := saveDemoQuotaSnapshot(context.Background(), nil, "auth-test", "codex", nil, []quota.QuotaWindow{{UsedPercent: &usedPercent}}, 1)
	var marshalError *json.UnsupportedValueError
	if !errors.As(err, &marshalError) || !strings.Contains(err.Error(), "marshal quota snapshot for auth-test") {
		t.Fatalf("marshal failure must identify the credential and preserve its cause: %v", err)
	}
}

func TestModelQuotaCheckpointsAllowOverlappingWindows(t *testing.T) {
	repo, now, _ := seededDatabase(t)
	ctx := context.Background()
	latest, err := repo.GetLatestQuotaSnapshots(ctx, []string{"auth-codex-01"})
	if err != nil {
		t.Fatal(err)
	}
	var windows []quota.QuotaWindow
	if err := json.Unmarshal([]byte(latest["auth-codex-01"].WindowsJSON), &windows); err != nil {
		t.Fatal(err)
	}
	for index := range 5 {
		at := now.Add(-time.Hour).UnixMilli() + int64(index)
		if _, err := repo.SQL().ExecContext(ctx, `INSERT INTO usage_events (instance_id,event_key,api_group_key,auth_index,model,timestamp_ms,created_at_ms,total_tokens)
			VALUES ('default', ?, 'group', 'auth-overlap', 'gpt-6.1-sol', ?, ?, 100)`, fmt.Sprintf("overlap-%d", index), at, at); err != nil {
			t.Fatal(err)
		}
	}
	for _, window := range windows {
		if err := seedModelQuotaObservations(ctx, repo, "auth-overlap", "codex", nil, window, now.UnixMilli()); err != nil {
			t.Fatalf("overlapping window %s: %v", window.ID, err)
		}
	}
	if err := saveDemoQuotaSnapshot(ctx, repo, "auth-overlap", "codex", nil, windows, now.UnixMilli()); err != nil {
		t.Fatal(err)
	}
}
