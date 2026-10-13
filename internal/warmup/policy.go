package warmup

import (
	"fmt"
	"strconv"
	"strings"
	"time"
)

// DailyStart uses the deployment calendar, never the browser's zone. A repeated
// DST hour has one task identity; a missing hour is moved to the next valid hour.
func DailyStart(clock string, now time.Time) time.Time {
	hour, _ := strconv.Atoi(clock[:2])
	minute, _ := strconv.Atoi(clock[3:])
	year, month, day := now.Date()
	start := time.Date(year, month, day, hour, minute, 0, 0, now.Location())
	if start.Hour() < hour {
		start = start.Add(time.Hour)
	}
	return start
}
func NextDailyStart(clock string, now time.Time) time.Time {
	start := DailyStart(clock, now)
	if !start.After(now) {
		start = DailyStart(clock, now.AddDate(0, 0, 1))
	}
	return start
}
func DailyKey(clock string, now time.Time) string {
	return now.Location().String() + "/" + now.Format(time.DateOnly) + "/" + clock
}

func Reconcile(state State, observation Observation) State {
	previous := state.Observation
	if previous != nil {
		elapsed := observation.ObservedAtMS - previous.ObservedAtMS
		for _, pair := range []struct {
			before Window
			after  *Window
		}{{previous.FiveHour, &observation.FiveHour}, {previous.Weekly, &observation.Weekly}} {
			before, after := pair.before, pair.after
			if elapsed >= 30000 && before.UsedPercent != nil && after.UsedPercent != nil && *before.UsedPercent == 0 && *after.UsedPercent == 0 && before.ResetAtMS != nil && after.ResetAtMS != nil && before.PeriodMS == after.PeriodMS && *after.ResetAtMS-observation.ObservedAtMS >= after.PeriodMS-600000 {
				shift := *after.ResetAtMS - *before.ResetAtMS - elapsed
				if shift >= -1000 && shift <= 1000 {
					after.State = "idle"
				}
			}
		}
	}
	if previous != nil && observation.ObservedAtMS <= previous.ObservedAtMS {
		return state
	}
	if previous != nil {
		for _, pair := range [][2]Window{{previous.FiveHour, observation.FiveHour}, {previous.Weekly, observation.Weekly}} {
			before, after := pair[0], pair[1]
			if after.State == "idle" && before.State == "active" {
				state.Generation++
				break
			}
			if before.ResetAtMS != nil && after.ResetAtMS != nil && absWarmupTime(*before.ResetAtMS-*after.ResetAtMS) > 1000 && after.State == "active" {
				state.Generation++
				break
			}
		}
	}
	state.Observation = &observation
	return state
}

func Eligibility(policy Policy, observation *Observation, nowMS int64) string {
	if policy.Model == "" {
		return "model_required"
	}
	if observation == nil || observation.ObservedAtMS > nowMS+1000 || nowMS-observation.ObservedAtMS > OBSERVATION_MAX_AGE_MS {
		return "quota_unknown"
	}
	if observation.PaidFallback == "enabled" {
		return "paid_usage_enabled"
	}
	if observation.PaidFallback != "disabled" {
		return "paid_usage_unknown"
	}
	for family, window := range observation.ModelWindows {
		if strings.Contains(strings.ToLower(policy.Model), family) {
			if window.State == "unknown" {
				return "quota_unknown"
			}
			if window.UsedPercent != nil && *window.UsedPercent >= 100 {
				return "quota_exhausted"
			}
		}
	}
	for _, model := range observation.BlockedModels {
		if strings.EqualFold(model, policy.Model) {
			return "quota_exhausted"
		}
	}
	if observation.IsBlocked {
		return "quota_exhausted"
	}
	for _, window := range []Window{observation.FiveHour, observation.Weekly} {
		if window.State == "unknown" || window.State == "" {
			return "quota_unknown"
		}
		if window.State == "active" && (window.UsedPercent == nil || *window.UsedPercent >= 100) {
			return "quota_exhausted"
		}
	}
	return ""
}

// Decide combines simultaneous triggers. Manual runs intentionally bypass the
// clock preference, but never billing, observation or already-active guards.
func Decide(policy Policy, state State, now time.Time, isManual bool) (trigger, reason, cycle string, next *int64) {
	if !isManual && !policy.IsEnabled() {
		return "", "disabled", "", nil
	}
	if reason = Eligibility(policy, state.Observation, now.UnixMilli()); reason != "" {
		return
	}
	observation := state.Observation
	cycle = fmt.Sprintf("cycle/%d", state.Generation)
	if isManual {
		if observation.FiveHour.State != "idle" && observation.Weekly.State != "idle" {
			return "", "already_active", cycle, nil
		}
		return "manual", "", cycle, nil
	}
	if state.NextAttemptMS > now.UnixMilli() {
		instant := state.NextAttemptMS
		return "", "retry_wait", cycle, &instant
	}
	if state.Failures > 0 && state.Failures <= 3 && state.LastResult != nil && state.LastResult.Status == "failed" && state.LastResult.Reason == "rate_limited" && state.LastResult.Trigger == "daily" {
		start := DailyStart(policy.DailyTime, now)
		if policy.IsDailyEnabled && !now.Before(start) && now.Sub(start) <= time.Hour && observation.FiveHour.State == "idle" {
			return "daily", "", "daily/" + DailyKey(policy.DailyTime, now), nil
		}
	}

	start := DailyStart(policy.DailyTime, now)
	dailyKey := DailyKey(policy.DailyTime, now)
	isDailyDue := policy.IsDailyEnabled && !now.Before(start) && now.Sub(start) <= time.Hour && state.DailyKey != dailyKey
	if isDailyDue {
		if observation.FiveHour.State == "idle" {
			return "daily", "", "daily/" + dailyKey, nil
		}
		return "", "already_active", "daily/" + dailyKey, nil
	}
	isResetDue := (policy.ResetMode == "all" && observation.FiveHour.State == "idle") || (policy.ResetMode != "off" && observation.Weekly.State == "idle")
	if isResetDue && state.LastCycle != cycle {
		if policy.IsDailyEnabled && observation.FiveHour.State == "idle" {
			nextStart := NextDailyStart(policy.DailyTime, now)
			if nextStart.Sub(now) < 5*time.Hour {
				instant := nextStart.UnixMilli()
				return "", "waiting_daily", cycle, &instant
			}
		}
		return "reset", "", cycle, nil
	}
	if policy.IsDailyEnabled {
		instant := NextDailyStart(policy.DailyTime, now).UnixMilli()
		next = &instant
	}
	for _, window := range []Window{observation.FiveHour, observation.Weekly} {
		if window.ResetAtMS != nil && *window.ResetAtMS > now.UnixMilli() && policy.ResetMode != "off" && (window.PeriodMS == WEEK_MS || policy.ResetMode == "all") {
			if next == nil || *window.ResetAtMS < *next {
				instant := *window.ResetAtMS
				next = &instant
			}
		}
	}
	return "", "already_active", cycle, next
}

func absWarmupTime(value int64) int64 {
	if value < 0 {
		return -value
	}
	return value
}
