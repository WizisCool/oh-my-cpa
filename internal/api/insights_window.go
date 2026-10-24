package api

import (
	"fmt"
	"net/url"
	"strings"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
)

// Insights windows.
//
// The Insights page answers two questions the dashboard's sliding presets cannot:
// "how did today go" and "how does that compare". A calendar window is a fact of the
// deployment's calendar - local midnight, the Monday a week starts on, the first of
// the month - so it is placed here, on the server's clock and in the OMC Time Zone,
// never in the browser.

// insightsRelativePresets slide with the clock, like the dashboard's.
var insightsRelativePresets = map[string]time.Duration{
	"24h": 24 * time.Hour,
	"7d":  7 * 24 * time.Hour,
	"30d": 30 * 24 * time.Hour,
	"90d": 90 * 24 * time.Hour,
}

// insightsCalendarPresets are civil units: the current one grows with the clock,
// the previous one is closed.
var insightsCalendarPresets = map[string]struct {
	unit     string
	previous int
}{
	"today": {"day", 0}, "yesterday": {"day", 1},
	"this_week": {"week", 0}, "last_week": {"week", 1},
	"this_month": {"month", 0}, "last_month": {"month", 1},
}

const insightsPresetMessage = "preset must be one of today, yesterday, this_week, last_week, this_month, last_month, 24h, 7d, 30d, 90d, all"

// insightsBucket is the granularity a read is drawn at. Month is folded from local
// days in Go: a month has no fixed width the SQL could divide by.
type insightsBucket string

const (
	insightsBucketHour  insightsBucket = "hour"
	insightsBucketDay   insightsBucket = "day"
	insightsBucketWeek  insightsBucket = "week"
	insightsBucketMonth insightsBucket = "month"
)

// insightsCoarser is the order an automatic granularity coarsens in when a read
// would carry too many rows.
var insightsCoarser = map[insightsBucket]insightsBucket{
	insightsBucketHour: insightsBucketDay, insightsBucketDay: insightsBucketWeek, insightsBucketWeek: insightsBucketMonth,
}

// maxInsightsHourSpan bounds hourly buckets: past two weeks an hourly bar is
// thinner than a pixel on the widest layout.
const maxInsightsHourSpan = 14 * 24 * time.Hour

// insightsWindow is the window a read covers, as resolved.
type insightsWindow struct {
	Preset string `json:"preset"`
	FromMS int64  `json:"from"`
	// ToMS is inclusive, like the dashboard's.
	ToMS int64 `json:"to"`
	// OpenEnd marks a window whose end follows the clock: a sliding preset, the
	// current calendar unit, or an open custom range. Only those are polled.
	OpenEnd  bool           `json:"open_end"`
	Bucket   insightsBucket `json:"bucket"`
	Timezone string         `json:"timezone"`
	// Widened reports that request records behind the retention horizon could not
	// split an edge bucket, so the window read was widened to whole fact buckets.
	Widened bool `json:"widened"`
}

// insightsCompareWindow is the period a window is compared against.
type insightsCompareWindow struct {
	FromMS int64 `json:"from"`
	ToMS   int64 `json:"to"`
}

type insightsRange struct {
	window  insightsWindow
	compare *insightsCompareWindow
	// isAutoBucket lets an oversized read coarsen instead of failing.
	isAutoBucket bool
}

// civilStart is the local start of the unit holding `at`, stepped back by `previous` units.
func civilStart(at time.Time, zone *time.Location, unit string, previous int) time.Time {
	local := at.In(zone)
	switch unit {
	case "day":
		return time.Date(local.Year(), local.Month(), local.Day()-previous, 0, 0, 0, 0, zone)
	case "week":
		sinceMonday := (int(local.Weekday()) + 6) % 7
		return time.Date(local.Year(), local.Month(), local.Day()-sinceMonday-7*previous, 0, 0, 0, 0, zone)
	default:
		return time.Date(local.Year(), local.Month()-time.Month(previous), 1, 0, 0, 0, 0, zone)
	}
}

// civilShift moves a local instant back by one unit, keeping its wall-clock time. A
// month shift clamps to the shorter month's last day, so 31 March compares against
// 28 February rather than 3 March.
func civilShift(at time.Time, zone *time.Location, unit string) time.Time {
	local := at.In(zone)
	switch unit {
	case "day":
		return time.Date(local.Year(), local.Month(), local.Day()-1, local.Hour(), local.Minute(), local.Second(), local.Nanosecond(), zone)
	case "week":
		return time.Date(local.Year(), local.Month(), local.Day()-7, local.Hour(), local.Minute(), local.Second(), local.Nanosecond(), zone)
	default:
		firstOfPrevious := time.Date(local.Year(), local.Month()-1, 1, 0, 0, 0, 0, zone)
		lastDay := firstOfPrevious.AddDate(0, 1, -1).Day()
		return time.Date(firstOfPrevious.Year(), firstOfPrevious.Month(), min(local.Day(), lastDay),
			local.Hour(), local.Minute(), local.Second(), local.Nanosecond(), zone)
	}
}

// resolveInsightsRange reads the window, its comparison and its granularity from a
// request. firstUsageMS places the all-time window and is only called for it.
func resolveInsightsRange(query url.Values, now time.Time, zone *time.Location, firstUsageMS func() (*int64, error)) (insightsRange, string, error) {
	preset := strings.ToLower(strings.TrimSpace(query.Get("preset")))
	rawFrom, rawTo := strings.TrimSpace(query.Get("from")), strings.TrimSpace(query.Get("to"))
	nowMS := now.UnixMilli()
	result := insightsRange{window: insightsWindow{Timezone: zone.String()}}
	window := &result.window

	switch {
	case rawFrom != "" || rawTo != "":
		if rawFrom == "" {
			return result, "from is required when to is set", nil
		}
		fromMS, err := parseMilli(rawFrom)
		if err != nil {
			return result, "from and to must be epoch milliseconds", nil
		}
		toMS := nowMS
		if rawTo != "" {
			if toMS, err = parseMilli(rawTo); err != nil {
				return result, "from and to must be epoch milliseconds", nil
			}
			toMS = min(toMS, nowMS)
		} else {
			window.OpenEnd = true
		}
		if fromMS >= toMS {
			return result, "from must be earlier than to", nil
		}
		if toMS-fromMS > maxDashboardWindow.Milliseconds() {
			return result, fmt.Sprintf("custom range must not exceed %s", maxDashboardWindow), nil
		}
		window.Preset, window.FromMS, window.ToMS = "custom", fromMS, toMS
		span := toMS - fromMS
		result.compare = &insightsCompareWindow{FromMS: fromMS - span - 1, ToMS: fromMS - 1}
	case preset == "all":
		fromMS := nowMS - dashboardAllFallback.Milliseconds()
		first, err := firstUsageMS()
		if err != nil {
			return result, "", err
		}
		if first != nil && *first < fromMS {
			fromMS = *first
		}
		*window = insightsWindow{Preset: preset, FromMS: fromMS, ToMS: nowMS, OpenEnd: true, Timezone: zone.String()}
	default:
		if preset == "" {
			preset = "7d"
		}
		if span, isRelative := insightsRelativePresets[preset]; isRelative {
			fromMS := nowMS - span.Milliseconds()
			*window = insightsWindow{Preset: preset, FromMS: fromMS, ToMS: nowMS, OpenEnd: true, Timezone: zone.String()}
			result.compare = &insightsCompareWindow{FromMS: fromMS - span.Milliseconds(), ToMS: fromMS - 1}
			break
		}
		calendar, isCalendar := insightsCalendarPresets[preset]
		if !isCalendar {
			return result, insightsPresetMessage, nil
		}
		start := civilStart(now, zone, calendar.unit, calendar.previous)
		window.Preset, window.FromMS = preset, start.UnixMilli()
		comparisonStart := civilStart(now, zone, calendar.unit, calendar.previous+1)
		if calendar.previous == 0 {
			// The unit so far, against the same stretch of the unit before it.
			window.ToMS, window.OpenEnd = nowMS, true
			result.compare = &insightsCompareWindow{FromMS: comparisonStart.UnixMilli(), ToMS: civilShift(now, zone, calendar.unit).UnixMilli()}
		} else {
			window.ToMS = civilStart(now, zone, calendar.unit, calendar.previous-1).UnixMilli() - 1
			result.compare = &insightsCompareWindow{FromMS: comparisonStart.UnixMilli(), ToMS: window.FromMS - 1}
		}
	}

	span := time.Duration(window.ToMS-window.FromMS) * time.Millisecond
	switch bucket := insightsBucket(strings.ToLower(strings.TrimSpace(query.Get("bucket")))); bucket {
	case "", "auto":
		result.isAutoBucket = true
		switch {
		case span <= 2*24*time.Hour:
			window.Bucket = insightsBucketHour
		case span <= 92*24*time.Hour:
			window.Bucket = insightsBucketDay
		case span <= 400*24*time.Hour:
			window.Bucket = insightsBucketWeek
		default:
			window.Bucket = insightsBucketMonth
		}
	case insightsBucketHour:
		if span > maxInsightsHourSpan {
			return result, "hour buckets cover at most 14 days", nil
		}
		window.Bucket = bucket
	case insightsBucketDay, insightsBucketWeek, insightsBucketMonth:
		window.Bucket = bucket
	default:
		return result, "bucket must be one of auto, hour, day, week, month", nil
	}
	return result, "", nil
}

// calendarUnit is the repository's unit for a bucket; months are read as days.
func (bucket insightsBucket) calendarUnit() repository.UsageCalendarUnit {
	switch bucket {
	case insightsBucketHour:
		return repository.UsageCalendarHour
	case insightsBucketWeek:
		return repository.UsageCalendarWeek
	default:
		return repository.UsageCalendarDay
	}
}

// bucketStart is the local start of the bucket holding an instant.
func (bucket insightsBucket) bucketStart(at time.Time, zone *time.Location) time.Time {
	local := at.In(zone)
	switch bucket {
	case insightsBucketHour:
		return time.Date(local.Year(), local.Month(), local.Day(), local.Hour(), 0, 0, 0, zone)
	case insightsBucketDay:
		return civilStart(at, zone, "day", 0)
	case insightsBucketWeek:
		return civilStart(at, zone, "week", 0)
	default:
		return civilStart(at, zone, "month", 0)
	}
}

// next is the start of the bucket after the one starting at `start`.
func (bucket insightsBucket) next(start time.Time, zone *time.Location) time.Time {
	local := start.In(zone)
	switch bucket {
	case insightsBucketHour:
		// Hours step on the wall clock, as the repository buckets them: a repeated
		// local hour is one bucket, and a skipped one resolves onto the hour after
		// it, which the next step must then pass.
		for hours := 1; ; hours++ {
			next := time.Date(local.Year(), local.Month(), local.Day(), local.Hour()+hours, 0, 0, 0, zone)
			if next.After(start) {
				return next
			}
		}
	case insightsBucketDay:
		return time.Date(local.Year(), local.Month(), local.Day()+1, 0, 0, 0, 0, zone)
	case insightsBucketWeek:
		return time.Date(local.Year(), local.Month(), local.Day()+7, 0, 0, 0, 0, zone)
	default:
		return time.Date(local.Year(), local.Month()+1, 1, 0, 0, 0, 0, zone)
	}
}

// bucketStarts lists every bucket the window touches, so a series can be drawn
// zero-filled across quiet stretches.
func (bucket insightsBucket) bucketStarts(fromMS, toMS int64, zone *time.Location) []int64 {
	starts := []int64{}
	for at := bucket.bucketStart(time.UnixMilli(fromMS), zone); at.UnixMilli() <= toMS; at = bucket.next(at, zone) {
		starts = append(starts, at.UnixMilli())
	}
	return starts
}
