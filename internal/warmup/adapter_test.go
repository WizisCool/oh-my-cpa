package warmup

import (
	"context"
	"testing"

	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/management"
)

func TestSendDelegatesToCPAVerify(t *testing.T) {
	file := management.AuthFile{Name: "claude.json", AuthIndex: "exact-credential"}

	// The call point goes out whole: CPA strips the credential's own prefix and resolves an OAuth
	// alias itself, and an alias may contain a slash.
	var gotName, gotIndex, gotModel string
	okOutcome := Send(context.Background(), func(_ context.Context, name, authIndex, model string) (bool, error) {
		gotName, gotIndex, gotModel = name, authIndex, model
		return true, nil
	}, file, " team/claude-fast ")
	if okOutcome.Status != "ok" || gotName != "claude.json" || gotIndex != "exact-credential" || gotModel != "team/claude-fast" {
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

	// A request CPA may have run without its answer arriving is uncertain; one the gateway refused
	// before sending it is a plain failure.
	noAnswer := Send(context.Background(), func(_ context.Context, _, _, _ string) (bool, error) {
		return false, management.ErrCredentialOutcomeUnknown
	}, file, "claude-haiku-4-5")
	if noAnswer.Status != "unknown" || noAnswer.Reason != "no_answer" {
		t.Fatalf("noAnswer = %+v", noAnswer)
	}
	refused := Send(context.Background(), func(_ context.Context, _, _, _ string) (bool, error) {
		return false, management.ErrManagementV8Required
	}, file, "claude-haiku-4-5")
	if refused.Status != "failed" {
		t.Fatalf("refused = %+v", refused)
	}
}

func TestParseObservationPreservesIdleAndActiveWindows(t *testing.T) {
	obs := ParseObservation("claude", []byte(`{"five_hour":null,"seven_day":{"utilization":15,"resets_at":"2026-04-15T00:00:00Z"}}`), 1_770_000_000_000)
	if obs.FiveHour.State != "idle" || obs.Weekly.State != "active" {
		t.Fatalf("unexpected claude observation: %+v", obs)
	}
}
