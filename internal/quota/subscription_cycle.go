package quota

import (
	"strings"
	"time"
)

const (
	// SubscriptionCycleSourceLive marks a billing cycle read directly from the
	// upstream subscription endpoint (or an authoritative provider seat document).
	SubscriptionCycleSourceLive = "live_subscription"

	// SubscriptionProjectionBasisPace marks a full-cycle estimate scaled linearly
	// from current-cycle usage and elapsed time.
	SubscriptionProjectionBasisPace = "pace"

	// SubscriptionProjectionReasonNoTraffic indicates the current billing cycle
	// has no recorded requests yet.
	SubscriptionProjectionReasonNoTraffic = "no_traffic"
	// SubscriptionProjectionReasonInsufficientTime indicates too little of the
	// billing cycle has elapsed to extrapolate a reliable full-cycle total.
	SubscriptionProjectionReasonInsufficientTime = "insufficient_elapsed"

	dayMS                            = int64(24 * time.Hour / time.Millisecond)
	minSubscriptionProjectionFloorMS = int64(time.Minute / time.Millisecond)
)

// NormalizeBillingPeriod canonicalizes an upstream billing cadence string into
// one of the supported BillingPeriod constants. Unrecognized or empty values
// return "" so callers never guess a cycle length upstream did not state.
func NormalizeBillingPeriod(raw string) string {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "week", "weekly":
		return BillingPeriodWeekly
	case "month", "monthly":
		return BillingPeriodMonthly
	case "quarter", "quarterly":
		return BillingPeriodQuarterly
	case "year", "yearly", "annual", "annually":
		return BillingPeriodYearly
	default:
		return ""
	}
}

// SubscriptionCycleBounds is a half-open [FromMS, ToMS) billing period.
type SubscriptionCycleBounds struct {
	FromMS int64
	ToMS   int64
}

// ResolvedSubscriptionCycle holds the resolved current and previous billing
// periods together with the provenance of the boundaries.
type ResolvedSubscriptionCycle struct {
	Source   string
	Current  SubscriptionCycleBounds
	Previous SubscriptionCycleBounds
}

// ResolveSubscriptionCycle determines the credential's active subscription
// cycle and its immediately preceding cycle at nowMS.
//
// Only credentials with verified upstream start and expiry instants covering
// nowMS resolve a cycle; plans lacking exact boundaries or relying on an
// unverified id_token snapshot return false rather than estimating dates.
//
// When upstream also states a billing cadence (e.g. Codex reports active_start
// as the original subscription start across renewals alongside billing_period),
// [StartsAtMS, ExpiresAtMS) is sliced by that cadence anchored at ExpiresAtMS so
// renewed multi-month subscriptions resolve the active single billing cycle
// rather than the entire cumulative tenure.
func ResolveSubscriptionCycle(plan *QuotaPlan, nowMS int64) (ResolvedSubscriptionCycle, bool) {
	if plan == nil || plan.ExpiresSource == PlanSourceCredentialSnapshot || plan.StartsAtMS == nil || plan.ExpiresAtMS == nil {
		return ResolvedSubscriptionCycle{}, false
	}
	startMS, endMS := *plan.StartsAtMS, *plan.ExpiresAtMS
	if startMS <= 0 || startMS > nowMS || nowMS >= endMS {
		return ResolvedSubscriptionCycle{}, false
	}
	current, previous := sliceSubscriptionPeriod(startMS, endMS, nowMS, NormalizeBillingPeriod(plan.BillingPeriod))
	return ResolvedSubscriptionCycle{
		Source:   SubscriptionCycleSourceLive,
		Current:  current,
		Previous: previous,
	}, true
}

func sliceSubscriptionPeriod(startMS, endMS, nowMS int64, billingPeriod string) (SubscriptionCycleBounds, SubscriptionCycleBounds) {
	switch billingPeriod {
	case BillingPeriodMonthly:
		return resolveCalendarMonthCycle(startMS, endMS, nowMS, 1)
	case BillingPeriodQuarterly:
		return resolveCalendarMonthCycle(startMS, endMS, nowMS, 3)
	case BillingPeriodYearly:
		return resolveCalendarMonthCycle(startMS, endMS, nowMS, 12)
	case BillingPeriodWeekly:
		return resolveFixedSpanCycle(startMS, endMS, nowMS, 7*dayMS)
	default:
		current := SubscriptionCycleBounds{FromMS: startMS, ToMS: endMS}
		return current, PreviousSubscriptionPeriod(current.FromMS, current.ToMS)
	}
}

func resolveCalendarMonthCycle(startMS, endMS, nowMS int64, cadenceMonths int) (SubscriptionCycleBounds, SubscriptionCycleBounds) {
	subStart := time.UnixMilli(startMS).UTC()
	subEnd := time.UnixMilli(endMS).UTC()
	now := time.UnixMilli(nowMS).UTC()

	// Recover an original month-end billing anchor (for example, a 31st-of-month
	// plan whose active_until landed on April 30 or Feb 28).
	anchorDay := subEnd.Day()
	if subEnd.Day() == daysInMonth(subEnd.Year(), subEnd.Month()) && subStart.Day() > anchorDay {
		anchorDay = subStart.Day()
	}

	boundary := func(step int) int64 {
		if step == 0 {
			return endMS
		}
		return shiftAnchoredMonths(subEnd, -step*cadenceMonths, anchorDay)
	}

	monthsAhead := (subEnd.Year()*12 + int(subEnd.Month()-1)) - (now.Year()*12 + int(now.Month()-1))
	step := max(0, monthsAhead/cadenceMonths-1)
	for step > 0 && boundary(step) <= nowMS {
		step--
	}
	for boundary(step+1) > nowMS {
		step++
	}

	cycleTo := boundary(step)
	rawFrom := boundary(step + 1)
	if rawFrom < startMS {
		current := SubscriptionCycleBounds{FromMS: startMS, ToMS: cycleTo}
		return current, PreviousSubscriptionPeriod(current.FromMS, current.ToMS)
	}
	current := SubscriptionCycleBounds{FromMS: rawFrom, ToMS: cycleTo}
	previous := SubscriptionCycleBounds{FromMS: boundary(step + 2), ToMS: rawFrom}
	return current, previous
}

func resolveFixedSpanCycle(startMS, endMS, nowMS, spanMS int64) (SubscriptionCycleBounds, SubscriptionCycleBounds) {
	step := (endMS - nowMS - 1) / spanMS
	cycleTo := endMS - step*spanMS
	rawFrom := cycleTo - spanMS
	if rawFrom < startMS {
		current := SubscriptionCycleBounds{FromMS: startMS, ToMS: cycleTo}
		return current, PreviousSubscriptionPeriod(current.FromMS, current.ToMS)
	}
	current := SubscriptionCycleBounds{FromMS: rawFrom, ToMS: cycleTo}
	previous := SubscriptionCycleBounds{FromMS: max(0, rawFrom-spanMS), ToMS: rawFrom}
	return current, previous
}

// PreviousSubscriptionPeriod computes the [prevFrom, fromMS) billing period
// immediately preceding [fromMS, toMS). Monthly and annual upstream spans step
// by calendar months with month-end clamping so 31st-of-month plans do not
// overflow February.
func PreviousSubscriptionPeriod(fromMS, toMS int64) SubscriptionCycleBounds {
	span := toMS - fromMS
	switch {
	case span >= 27*dayMS && span <= 32*dayMS:
		return SubscriptionCycleBounds{FromMS: shiftMonthsClamped(fromMS, toMS, -1, time.UTC), ToMS: fromMS}
	case span >= 364*dayMS && span <= 367*dayMS:
		return SubscriptionCycleBounds{FromMS: shiftMonthsClamped(fromMS, toMS, -12, time.UTC), ToMS: fromMS}
	case span > 0:
		return SubscriptionCycleBounds{FromMS: max(0, fromMS-span), ToMS: fromMS}
	default:
		return SubscriptionCycleBounds{FromMS: fromMS, ToMS: fromMS}
	}
}

// ProjectSubscriptionCycle computes elapsed time share and projects full-cycle
// usage linearly from the current cycle's observed pace once enough of the cycle
// has elapsed (at least 24 hours for monthly plans, or 5% for shorter spans).
// When usage carries effective query bounds widened past fromMS behind detail
// retention, scaling uses the measured span so the widened edge does not inflate
// the projected rate.
func ProjectSubscriptionCycle(fromMS, toMS, measuredAtMS int64, usage WindowUsage) (float64, *WindowCapacity, string) {
	if toMS <= fromMS {
		return 0, nil, SubscriptionProjectionReasonInsufficientTime
	}
	clampedMeasured := min(max(measuredAtMS, fromMS), toMS)
	totalSpan := toMS - fromMS
	elapsedMS := clampedMeasured - fromMS
	elapsedPercent := clamp(float64(elapsedMS)/float64(totalSpan)*100, 0, 100)

	if usage.Requests <= 0 || usage.Tokens <= 0 {
		return elapsedPercent, nil, SubscriptionProjectionReasonNoTraffic
	}
	minElapsedMS := max(min(dayMS, totalSpan/20), minSubscriptionProjectionFloorMS)
	if elapsedMS < minElapsedMS {
		return elapsedPercent, nil, SubscriptionProjectionReasonInsufficientTime
	}
	scalePercent := elapsedPercent
	if usage.FromMS > 0 && usage.ToMS > usage.FromMS {
		scalePercent = clamp(float64(usage.ToMS-usage.FromMS)/float64(totalSpan)*100, 0, 100)
	}
	projected := ScaleWindowCapacity(SubscriptionProjectionBasisPace, scalePercent, usage)
	if projected == nil {
		return elapsedPercent, nil, SubscriptionProjectionReasonInsufficientTime
	}
	return elapsedPercent, projected, ""
}

func shiftMonthsClamped(fromMS, toMS int64, deltaMonths int, loc *time.Location) int64 {
	from := time.UnixMilli(fromMS).In(loc)
	to := time.UnixMilli(toMS).In(loc)
	anchorDay := from.Day()
	// Recover an anchor day that was clamped at month-end on fromMS (for example,
	// a 31st-of-month plan whose current cycle is [Feb 28, Mar 31) -> prev Jan 31).
	monthSpan := (to.Year()*12 + int(to.Month()-1)) - (from.Year()*12 + int(from.Month()-1))
	if monthSpan == -deltaMonths && from.Day() == daysInMonth(from.Year(), from.Month()) && to.Day() > anchorDay {
		anchorDay = to.Day()
	}
	return shiftAnchoredMonths(from, deltaMonths, anchorDay)
}

func shiftAnchoredMonths(base time.Time, deltaMonths, anchorDay int) int64 {
	totalMonths := base.Year()*12 + int(base.Month()-1) + deltaMonths
	year := totalMonths / 12
	monthIdx := totalMonths % 12
	if monthIdx < 0 {
		monthIdx += 12
		year--
	}
	month := time.Month(monthIdx + 1)
	day := min(anchorDay, daysInMonth(year, month))
	return time.Date(year, month, day, base.Hour(), base.Minute(), base.Second(), base.Nanosecond(), base.Location()).UnixMilli()
}

func daysInMonth(year int, month time.Month) int {
	return time.Date(year, month+1, 0, 0, 0, 0, 0, time.UTC).Day()
}
