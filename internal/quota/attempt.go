package quota

import "github.com/oh-my-cpa/oh-my-cpa/internal/security"

// ReadAttempt is the last time somebody tried to read a credential's quota, as the console
// needs it: when, and the provider's own reason when the try produced no reading.
//
// It is not a reading. A failed try leaves the stored observation alone, so keeping the try
// beside it is what lets a page say "refreshed three minutes ago, failed with 401" instead of
// presenting a reading from three days ago as today's answer.
type ReadAttempt struct {
	AttemptedAtMS int64
	IsFailed      bool
	// Failure is the redacted reason the read produced, in the provider's words.
	Failure string
}

// ReadOutcome answers what one read produced: whether it is a usable reading the snapshot may
// keep, and the reason when it is not.
//
// Every surface that reads a credential asks this one question - the manual refresh, the
// background loop, the warmup probe and the Agent capability - so "this refresh failed" and
// "the operator was told" cannot drift apart.
func ReadOutcome(reading *NormalizedQuota, err error) (isUsable bool, reason string) {
	if err != nil {
		return false, security.RedactText(err.Error())
	}
	if reading == nil {
		return false, ""
	}
	if reading.Status == "error" || reading.Status == "stale" || reading.Error != "" {
		return false, security.RedactText(reading.Error)
	}
	return true, ""
}

// HasRestoredCapacity reports whether a read just taken shows the credential can serve again:
// it is a usable reading observed no earlier than readStartedAtMS, and every window it publishes
// states room left. A window with no stated remainder could be the one that is used up, so it
// disqualifies the reading. A disabled credential's reading and a stale one replay older
// numbers, so they never qualify.
func HasRestoredCapacity(reading *NormalizedQuota, readStartedAtMS int64) bool {
	if isUsable, _ := ReadOutcome(reading, nil); !isUsable || reading.Disabled || reading.ObservedAtMS < readStartedAtMS {
		return false
	}
	for _, window := range reading.Windows {
		if window.RemainingPercent == nil || *window.RemainingPercent <= 0 {
			return false
		}
	}
	return len(reading.Windows) > 0
}

// ApplyReadingHealth sets the status the console presents from a stored reading and the last
// attempt to re-read it.
//
// hasStoredReading says whether the caller holds an observation to present at all. It decides what
// a failure means: with a reading, the failure is a reason that the previous numbers are still on
// screen; without one, the failure is the whole answer about the credential, and there is nothing
// for the attempt to be "older than".
//
// The order is by how much each fact constrains the operator, and it continues the order
// EvaluateStatusAndRecommendation already uses. A disabled credential is the operator's own
// decision. An active cooldown is the gateway blocking traffic right now, which a failed quota
// read says nothing about. A failed attempt is newer information than the reading it failed to
// replace, so it outranks what the reading claimed - as an auth failure (the credential needs
// signing in again) or as an ordinary refusal that left the previous numbers standing. Last, a
// reading that announced a window boundary which has since passed unseen cannot keep claiming to
// be current: nobody has data about the cycle that began.
//
// exhausted is deliberately not overridden by an age rule: its numbers still say "no capacity",
// which is what stops the credential, and the reset-driven read answers the question within
// minutes of a boundary.
func ApplyReadingHealth(q *NormalizedQuota, attempt *ReadAttempt, hasStoredReading bool, nowMS int64) {
	if q == nil || q.Disabled {
		return
	}
	if (q.ActiveCooldown != nil && q.ActiveCooldown.IsActive) || q.Status == "cooldown" {
		return
	}
	if attempt != nil && attempt.IsFailed && (!hasStoredReading || attempt.AttemptedAtMS >= q.ObservedAtMS) {
		q.Error = attempt.Failure
		if looksLikeAuthFailure(attempt.Failure) {
			q.Status = "error"
			q.Recommendation = QuotaRecommendation{
				Status:   "needs_reauth",
				Priority: "critical",
				Action:   "reauth",
				Reason:   "最近一次额度刷新认证失败，凭据可能已失效，建议重新授权",
			}
			return
		}
		if hasStoredReading {
			q.Status = "stale"
			q.Recommendation = QuotaRecommendation{
				Status:   "warning",
				Priority: "medium",
				Action:   "refresh",
				Reason:   "最近一次额度刷新失败，正在显示上一次成功读取的数据，可尝试重新刷新",
			}
			return
		}
		// No snapshot to present, so nothing can be called out of date: the credential is an error
		// that a retry may clear, and the page says that instead of asking for a first read that
		// has already been attempted.
		q.Status = "error"
		q.Recommendation = QuotaRecommendation{
			Status:   "warning",
			Priority: "medium",
			Action:   "refresh",
			Reason:   "最近一次额度刷新失败，尚未取得额度读数，可尝试重新刷新",
		}
		return
	}
	if (q.Status == "healthy" || q.Status == "warning") && ReadingOutlivedReset(q, nowMS) {
		q.Status = "stale"
		q.Recommendation = QuotaRecommendation{
			Status:   "warning",
			Priority: "low",
			Action:   "refresh",
			Reason:   "读数已超过其窗口的重置时间，刷新以获取当前额度",
		}
	}
}

// ReadingOutlivedReset reports whether a window the reading itself announced has reset since
// it was taken, longer ago than the reset-driven refresh waits before re-reading it.
//
// The reading must predate the boundary: a fresh read that reports a boundary already in the
// past describes the cycle upstream still serves, and flagging it would make the console
// flicker into "stale" at every rollover until the re-read lands.
func ReadingOutlivedReset(q *NormalizedQuota, nowMS int64) bool {
	if q == nil {
		return false
	}
	graceMS := AUTO_REFRESH_RESET_GRACE.Milliseconds()
	for _, window := range q.Windows {
		if window.ResetAtMS == nil {
			continue
		}
		if q.ObservedAtMS < *window.ResetAtMS && nowMS > *window.ResetAtMS+graceMS {
			return true
		}
	}
	return false
}
