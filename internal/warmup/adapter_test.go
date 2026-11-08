package warmup

import (
	"context"
	"testing"

	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/management"
)

func TestSendDelegatesToCPAVerify(t *testing.T) {
	file := management.AuthFile{Name: "claude.json", AuthIndex: "exact-credential"}

	var gotName, gotIndex, gotModel string
	okOutcome := Send(context.Background(), func(_ context.Context, name, authIndex, model string) (bool, error) {
		gotName, gotIndex, gotModel = name, authIndex, model
		return true, nil
	}, file, "anthropic/claude-haiku-4-5")
	if okOutcome.Status != "ok" || gotName != "claude.json" || gotIndex != "exact-credential" || gotModel != "claude-haiku-4-5" {
		t.Fatalf("okOutcome = %+v (%s %s %s)", okOutcome, gotName, gotIndex, gotModel)
	}

	rateLimited := Send(context.Background(), func(_ context.Context, _, _, _ string) (bool, error) {
		return false, &management.HTTPError{StatusCode: 429}
	}, file, "claude-haiku-4-5")
	if rateLimited.Status != "failed" || rateLimited.Reason != "HTTP 429" {
		t.Fatalf("rateLimited = %+v", rateLimited)
	}

	timedOut := Send(context.Background(), func(_ context.Context, _, _, _ string) (bool, error) {
		return false, context.DeadlineExceeded
	}, file, "claude-haiku-4-5")
	if timedOut.Status != "unknown" || timedOut.Reason != "timeout" {
		t.Fatalf("timedOut = %+v", timedOut)
	}
}

func TestParseObservationPreservesIdleAndActiveWindows(t *testing.T) {
	obs := ParseObservation("claude", []byte(`{"five_hour":null,"seven_day":{"utilization":15,"resets_at":"2026-04-15T00:00:00Z"}}`), 1_770_000_000_000)
	if obs.FiveHour.State != "idle" || obs.Weekly.State != "active" {
		t.Fatalf("unexpected claude observation: %+v", obs)
	}
}
