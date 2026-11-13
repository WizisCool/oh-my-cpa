package demo

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"strings"
	"testing"

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
	hasCapacity := false
	for _, window := range observationWindows {
		cap, _ := quota.EstimateWindowCapacity(window, nil, primary.ObservedAtMS, primary.ObservedAtMS, nil, primaryCycles[quota.CapacityWindowKey("codex", window)])
		hasCapacity = hasCapacity || cap != nil
	}
	if !hasCapacity {
		t.Fatalf("demo direct window capacity missing: %+v", primaryCycles)
	}

	windows = nil
	if err := json.Unmarshal([]byte(latest["auth-codex-02"].WindowsJSON), &windows); err != nil {
		t.Fatal(err)
	}
	cycles, err := repo.LoadCapacityCycles(ctx, "auth-codex-02")
	if err != nil {
		t.Fatal(err)
	}
	evidence := cycles[quota.CapacityWindowKey("codex", windows[0])]
	if len(evidence) != 2 || len(evidence[1].Points) == 0 || evidence[1].Points[0].Requests == 0 {
		t.Fatalf("demo previous cycle has no recorded evidence: %+v", evidence)
	}
	if cap, reason := quota.EstimateWindowCapacity(windows[0], nil, latest["auth-codex-02"].ObservedAtMS, latest["auth-codex-02"].ObservedAtMS, nil, evidence); cap == nil || reason != "" {
		t.Fatalf("demo secondary capacity missing: cap=%+v reason=%q", cap, reason)
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
