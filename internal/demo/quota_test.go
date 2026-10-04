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
	repo, now, _ := seededDatabase(t)
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
	if len(windows) != 1 || len(windows[0].ModelFamilies) != 1 || windows[0].ModelFamilies[0] != "gemini" {
		t.Fatalf("unresolved demo group=%+v", windows)
	}
	windows = nil
	if err := json.Unmarshal([]byte(latest["auth-codex-02"].WindowsJSON), &windows); err != nil {
		t.Fatal(err)
	}
	records, err := repo.GetQuotaSnapshotHistory(ctx, "auth-codex-02", 50)
	if err != nil {
		t.Fatal(err)
	}
	history := []quota.ObservedWindows{}
	for _, record := range records {
		var observed []quota.QuotaWindow
		if err := json.Unmarshal([]byte(record.WindowsJSON), &observed); err != nil {
			t.Fatal(err)
		}
		history = append(history, quota.ObservedWindows{ObservedAtMS: record.ObservedAtMS, Windows: observed})
	}
	previous, observedAtMS, ok := quota.PreviousWindowObservation(windows[0], history, latest["auth-codex-02"].ObservedAtMS, now.UnixMilli())
	if !ok {
		t.Fatal("demo has no adjacent previous-cycle observation")
	}
	fromMS, toMS, reason := quota.WindowCycleRange(previous, observedAtMS, observedAtMS)
	usage, err := repo.QueryCredentialWindowUsage(ctx, "auth-codex-02", fromMS, toMS)
	if err != nil || reason != "" || usage.Requests == 0 {
		t.Fatalf("demo previous reading has no real usage: %+v %q %v", usage, reason, err)
	}
}

func TestSeedQuotaObservationsWrapSnapshotFailure(t *testing.T) {
	repo, now, _ := seededDatabase(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	err := seedQuotaObservations(ctx, repo, now)
	if !errors.Is(err, context.Canceled) || !strings.Contains(err.Error(), "save quota snapshot for auth-codex-01") {
		t.Fatalf("seed failure must identify the credential and preserve cancellation: %v", err)
	}
}

func TestSaveDemoQuotaSnapshotWrapMarshalFailure(t *testing.T) {
	usedPercent := math.NaN()
	err := saveDemoQuotaSnapshot(context.Background(), nil, "auth-test", "codex", []quota.QuotaWindow{{UsedPercent: &usedPercent}}, 1)
	var marshalError *json.UnsupportedValueError
	if !errors.As(err, &marshalError) || !strings.Contains(err.Error(), "marshal quota snapshot for auth-test") {
		t.Fatalf("marshal failure must identify the credential and preserve its cause: %v", err)
	}
}
