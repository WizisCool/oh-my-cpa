package quota

import (
	"errors"
	"testing"
	"time"
)

const minuteMS = 60 * 1000

func readingWithReset(observedAtMS int64, resetAtMS int64) *NormalizedQuota {
	return &NormalizedQuota{
		AuthIndex:    "idx",
		Status:       "healthy",
		ObservedAtMS: observedAtMS,
		Windows: []QuotaWindow{{
			ID:               "five_hour",
			Label:            "5h",
			Scope:            "standard",
			RemainingPercent: floatPtr(57),
			ResetAtMS:        &resetAtMS,
		}},
	}
}

func TestReadOutcomeClassifiesWhatAReadProduced(t *testing.T) {
	transport := errors.New("dial tcp: connection refused")
	if isUsable, reason := ReadOutcome(nil, transport); isUsable || reason == "" {
		t.Fatalf("transport failure = %v %q, want unusable with a reason", isUsable, reason)
	}
	if isUsable, _ := ReadOutcome(&NormalizedQuota{Status: "error", Error: "HTTP 401: unauthorized"}, nil); isUsable {
		t.Fatal("an auth failure read is not a usable observation")
	}
	if isUsable, reason := ReadOutcome(&NormalizedQuota{Status: "stale", Error: "HTTP 500: upstream"}, nil); isUsable || reason != "HTTP 500: upstream" {
		t.Fatalf("stale read = %v %q, want unusable carrying the provider's words", isUsable, reason)
	}
	if isUsable, reason := ReadOutcome(&NormalizedQuota{Status: QuotaStatusUnpublished}, nil); !isUsable || reason != "" {
		t.Fatalf("a read that published no window is still a usable observation: %v %q", isUsable, reason)
	}
}

func TestApplyReadingHealthAuthFailureOutranksTheReading(t *testing.T) {
	now := time.Now().UnixMilli()
	q := readingWithReset(now-hourMS, now+4*hourMS)
	attempt := &ReadAttempt{AttemptedAtMS: now, IsFailed: true, Failure: "HTTP 401: token expired"}

	ApplyReadingHealth(q, attempt, true, now)

	if q.Status != "error" {
		t.Fatalf("status = %q, want error", q.Status)
	}
	if q.Recommendation.Action != "reauth" || q.Recommendation.Status != "needs_reauth" {
		t.Fatalf("recommendation = %+v, want the reauth action", q.Recommendation)
	}
	if q.Error != attempt.Failure {
		t.Fatalf("error = %q, want the attempt's reason", q.Error)
	}
	// The previous observation stays on screen: the console shows the old numbers and the failed
	// attempt together, rather than blanking the row or presenting the numbers as today's.
	if observedBefore := attempt.AttemptedAtMS - hourMS; q.ObservedAtMS != observedBefore || len(q.Windows) != 1 {
		t.Fatalf("the previous reading must stay as it was: observed=%d windows=%d", q.ObservedAtMS, len(q.Windows))
	}
}

func TestApplyReadingHealthTransientFailureKeepsTheOldNumbers(t *testing.T) {
	now := time.Now().UnixMilli()
	q := readingWithReset(now-hourMS, now+4*hourMS)
	attempt := &ReadAttempt{AttemptedAtMS: now, IsFailed: true, Failure: "HTTP 500: upstream timeout"}

	ApplyReadingHealth(q, attempt, true, now)

	if q.Status != "stale" {
		t.Fatalf("status = %q, want stale", q.Status)
	}
	if q.Recommendation.Action != "refresh" {
		t.Fatalf("recommendation = %+v, want refresh", q.Recommendation)
	}
	if len(q.Windows) != 1 || q.Windows[0].RemainingPercent == nil {
		t.Fatalf("previous windows must survive a failed read: %+v", q.Windows)
	}
}

func TestApplyReadingHealthIgnoresAnAttemptOlderThanTheReading(t *testing.T) {
	now := time.Now().UnixMilli()
	q := readingWithReset(now-minuteMS, now+4*hourMS)
	attempt := &ReadAttempt{AttemptedAtMS: now - hourMS, IsFailed: true, Failure: "HTTP 401: token expired"}

	ApplyReadingHealth(q, attempt, true, now)

	if q.Status != "healthy" {
		t.Fatalf("status = %q, want the reading that is newer than the failed attempt", q.Status)
	}
	if q.Error != "" {
		t.Fatalf("error = %q, want none", q.Error)
	}
}

func TestApplyReadingHealthLeavesCooldownAndDisabledAlone(t *testing.T) {
	now := time.Now().UnixMilli()
	attempt := &ReadAttempt{AttemptedAtMS: now, IsFailed: true, Failure: "HTTP 401: token expired"}

	cooldown := readingWithReset(now-hourMS, now+4*hourMS)
	cooldown.ActiveCooldown = &ActiveCooldown{IsActive: true, Reason: "rate limited"}
	cooldown.Status = "cooldown"
	ApplyReadingHealth(cooldown, attempt, true, now)
	if cooldown.Status != "cooldown" {
		t.Fatalf("status = %q, want the cooldown that is blocking traffic now", cooldown.Status)
	}

	disabled := readingWithReset(now-hourMS, now+4*hourMS)
	disabled.Disabled = true
	disabled.Status = "idle"
	ApplyReadingHealth(disabled, attempt, true, now)
	if disabled.Status != "idle" {
		t.Fatalf("status = %q, want idle", disabled.Status)
	}
}

func TestApplyReadingHealthFlagsAReadingThatOutlivedItsReset(t *testing.T) {
	now := time.Now().UnixMilli()
	reset := now - 2*hourMS
	q := readingWithReset(now-3*hourMS, reset)

	ApplyReadingHealth(q, &ReadAttempt{AttemptedAtMS: now - 3*hourMS}, true, now)

	if q.Status != "stale" {
		t.Fatalf("status = %q, want stale: a boundary the reading announced has passed unseen", q.Status)
	}
	if q.Recommendation.Action != "refresh" {
		t.Fatalf("recommendation = %+v, want refresh", q.Recommendation)
	}
	if q.Error != "" {
		t.Fatalf("error = %q, want none: nothing failed, the reading is simply old", q.Error)
	}
}

func TestApplyReadingHealthDoesNotFlagAFreshReadingOfAnEndedCycle(t *testing.T) {
	now := time.Now().UnixMilli()
	// Upstream still serves the cycle that ended a minute ago; a read taken now describes it
	// accurately, and flagging it would flicker the console at every rollover.
	q := readingWithReset(now-1000, now-minuteMS)

	ApplyReadingHealth(q, nil, true, now)

	if q.Status != "healthy" {
		t.Fatalf("status = %q, want healthy", q.Status)
	}
}

func TestApplyReadingHealthReportsAFailedFirstRead(t *testing.T) {
	// The console has never read this credential, so the caller has no observation to present and
	// stamps the row with the request's own instant. The attempt is still the newest fact there is.
	now := time.Now().UnixMilli()
	unread := &NormalizedQuota{AuthIndex: "idx", Status: "idle", ObservedAtMS: now, Windows: []QuotaWindow{}}

	ApplyReadingHealth(unread, &ReadAttempt{AttemptedAtMS: now, IsFailed: true, Failure: "HTTP 401: token expired"}, false, now)

	if unread.Status != "error" {
		t.Fatalf("status = %q, want error: a failed first read is not 'never read'", unread.Status)
	}
	if unread.Recommendation.Action != "reauth" {
		t.Fatalf("recommendation = %+v, want the reauth action", unread.Recommendation)
	}
	if unread.Error != "HTTP 401: token expired" {
		t.Fatalf("error = %q, want the provider's reason", unread.Error)
	}
}

func TestApplyReadingHealthDoesNotCallAnUnreadCredentialStale(t *testing.T) {
	// "Stale" says a snapshot on screen has outlived its boundary. With no snapshot there is
	// nothing to call out of date, so a retryable failure is an error with a refresh hint.
	now := time.Now().UnixMilli()
	unread := &NormalizedQuota{AuthIndex: "idx", Status: "idle", ObservedAtMS: now, Windows: []QuotaWindow{}}

	ApplyReadingHealth(unread, &ReadAttempt{AttemptedAtMS: now, IsFailed: true, Failure: "HTTP 500: upstream timeout"}, false, now)

	if unread.Status != "error" {
		t.Fatalf("status = %q, want error", unread.Status)
	}
	if unread.Recommendation.Action != "refresh" {
		t.Fatalf("recommendation = %+v, want refresh", unread.Recommendation)
	}
}

func TestApplyReadingHealthKeepsAFailedAttemptOlderThanItsReadingIgnored(t *testing.T) {
	// A stored observation newer than the recorded attempt is the console's current answer, even
	// when the attempt beside it failed: the write that would have been newer already happened.
	now := time.Now().UnixMilli()
	q := readingWithReset(now-minuteMS, now+4*hourMS)
	ApplyReadingHealth(q, &ReadAttempt{AttemptedAtMS: now - 2*hourMS, IsFailed: true, Failure: "HTTP 401: token expired"}, true, now)
	if q.Status != "healthy" || q.Error != "" {
		t.Fatalf("status = %q error = %q, want the newer reading", q.Status, q.Error)
	}
}

func TestApplyReadingHealthDoesNotOverrideExhaustionWithAge(t *testing.T) {
	now := time.Now().UnixMilli()
	q := readingWithReset(now-3*hourMS, now-2*hourMS)
	q.Status = "exhausted"
	q.Windows[0].RemainingPercent = floatPtr(0)

	ApplyReadingHealth(q, nil, true, now)

	if q.Status != "exhausted" {
		t.Fatalf("status = %q, want exhausted: it is what stops the credential", q.Status)
	}
}

func TestHasRestoredCapacityNeedsAFreshReadWithRoomStatedInEveryWindow(t *testing.T) {
	startedAtMS := time.Now().UnixMilli()
	if !HasRestoredCapacity(readingWithReset(startedAtMS, startedAtMS+60*minuteMS), startedAtMS) {
		t.Fatal("a fresh read with room left is restored capacity")
	}
	if HasRestoredCapacity(readingWithReset(startedAtMS-minuteMS, startedAtMS+60*minuteMS), startedAtMS) {
		t.Fatal("a reading older than the read replays previous numbers")
	}
	exhausted := readingWithReset(startedAtMS, startedAtMS+60*minuteMS)
	exhausted.Windows = append(exhausted.Windows, QuotaWindow{ID: "weekly", RemainingPercent: floatPtr(0)})
	if HasRestoredCapacity(exhausted, startedAtMS) {
		t.Fatal("one used-up window keeps the credential without capacity")
	}
	unstated := readingWithReset(startedAtMS, startedAtMS+60*minuteMS)
	unstated.Windows = append(unstated.Windows, QuotaWindow{ID: "weekly"})
	if HasRestoredCapacity(unstated, startedAtMS) {
		t.Fatal("a window with no stated remainder could be the used-up one")
	}
	disabled := readingWithReset(startedAtMS, startedAtMS+60*minuteMS)
	disabled.Disabled = true
	if HasRestoredCapacity(disabled, startedAtMS) {
		t.Fatal("a disabled credential is never read upstream")
	}
	stale := readingWithReset(startedAtMS, startedAtMS+60*minuteMS)
	stale.Status, stale.Error = "stale", "HTTP 500: upstream"
	if HasRestoredCapacity(stale, startedAtMS) {
		t.Fatal("a failed read is not restored capacity")
	}
	if HasRestoredCapacity(&NormalizedQuota{Status: QuotaStatusUnpublished, ObservedAtMS: startedAtMS}, startedAtMS) {
		t.Fatal("a read that published no window says nothing about capacity")
	}
	if HasRestoredCapacity(nil, startedAtMS) {
		t.Fatal("no reading is not restored capacity")
	}
}
