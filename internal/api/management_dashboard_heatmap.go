package api

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"time"
	_ "time/tzdata"

	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
)

// The grid is a rolling year: fifty-three whole Monday-first weeks ending on the week containing
// today.
//
// Rolling rather than a calendar year because the question the panel answers is "what has my usage
// been doing lately", and that is a trailing window: a calendar grid spends every January almost
// entirely empty and shows nothing at all about last December, which is exactly the comparison a
// reader wants at that moment. GitHub's own graph is the same shape for the same reason.
//
// The span is fixed rather than derived from the dashboard's window picker: a field whose width is
// its own data's age is not a calendar, and at the 24h default it would be a single column. The
// window picker still governs the six KPI tiles above it, which is why the panel says which axis it
// owns.
//
// Because the window ends today there are no days still to come, so every cell in it is either a
// record or the absence of one - which is the only distinction a reader can act on.
const heatmapWeeks = 53

// heatmapMaxZoneName bounds a zone name before it reaches the loader. Real names are
// short ("America/Argentina/ComodRivadavia" is 32 bytes); the bound exists so a
// malformed value is refused instead of being handed to a filesystem lookup.
//
// Resolving the name needs the zone database, which the runtime image already
// installs for other reasons.
const heatmapMaxZoneName = 64

type dashboardTokenHeatmapResponse struct {
	// AsOfMS is the instant the grid was resolved against, on the viewer's calendar.
	AsOfMS int64 `json:"as_of_ms"`
	// Timezone is the IANA zone the days were built in, echoed so a response and the
	// strip it was rendered into cannot silently disagree about where a day starts.
	Timezone string `json:"timezone"`
	// FirstStoredMS is the earliest stored request record for this instance, or null
	// when none has been captured. Days before it have no stored usage - which is a
	// statement about storage, not about whether the gateway was running. The panel
	// labels those cells accordingly rather than claiming nothing happened.
	FirstStoredMS *int64 `json:"first_stored_ms"`
	// Days is the whole grid, oldest first, one entry per calendar day. Days with no traffic
	// are present with zero totals, and so are the days of the current week that have not
	// happened: the grid's shape is its span, and the client should not have to reconstruct
	// which days were missing.
	Days []dashboardTokenHeatmapDay `json:"days"`
}

type dashboardTokenHeatmapDay struct {
	Day string `json:"day"`
	// FromMS and ToMS are the exact inclusive instant range a click opens in the request
	// list. For today the range stops at the read instant rather than at the following local
	// midnight, so the cell and the list it opens describe the same interval - a record
	// timestamped later today (an upstream clock running ahead) is in neither.
	FromMS int64 `json:"from_ms"`
	ToMS   int64 `json:"to_ms"`
	// Tokens is zero for a day with no stored record, which is what a day that has not happened
	// yet also is. The client does not distinguish the two: a future day is a day nothing is
	// stored for, and the panel shows both as "no record" rather than inventing a pending state
	// that has no meaning to a reader comparing days.
	Tokens int64 `json:"tokens"`
	// Requests and Failures let the readout interpret a spike without a second
	// request per day.
	Requests int64 `json:"requests"`
	Failures int64 `json:"failures"`
	Input    int64 `json:"input"`
	Output   int64 `json:"output"`
	// Reasoning and cache reads are the two components the window's own tiles print,
	// so a day can be decomposed the same way the tile above it is.
	Reasoning  int64 `json:"reasoning"`
	CacheRead  int64 `json:"cache_read"`
	CacheWrite int64 `json:"cache_creation"`
}

// dashboardTokenHeatmap answers the dashboard's strip of daily token volume.
//
// It is a separate endpoint rather than another block on the dashboard response for
// three reasons. Its span is a fixed fifty-three whole weeks while the dashboard's
// window slides from fifteen minutes to ninety days, so it answers a different question
// from a different range and would be recomputed on every tail poll if it rode along. The
// timezone has to come from the browser, and the dashboard's own parameters are shared
// with the request list. And the panel is allowed to fail on its own: an unavailable read
// should not blank the six tiles beside it, which is the same reasoning that put
// `partial_errors` on the overview.
func (h *Handler) dashboardTokenHeatmap(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	if h.repo == nil {
		writeError(writer, http.StatusServiceUnavailable, "database is unavailable")
		return
	}

	zone, zoneErr := heatmapTimezone(request)
	if zoneErr != "" {
		writeError(writer, http.StatusBadRequest, zoneErr)
		return
	}

	ctx, cancel := context.WithTimeout(request.Context(), h.queryTimeout())
	defer cancel()

	asOf := h.now().UTC()
	// The calendar grid and the query are deliberately two lists. The grid is the shape the
	// operator reads: whole weeks, with the current week drawn in full. The query is only the
	// days that can have traffic, and today's range stops at the read instant - so the shape
	// can include days still to come without any of them being queried, and without a
	// future-dated record inflating today.
	windows := heatmapDayWindows(asOf, zone)
	today := localDay(asOf, zone)

	response := dashboardTokenHeatmapResponse{
		AsOfMS:   asOf.UnixMilli(),
		Timezone: zone.String(),
		Days:     make([]dashboardTokenHeatmapDay, 0, len(windows)),
	}
	repoDays := make([]repository.UsageDayWindow, 0, len(windows))
	for _, window := range windows {
		entry := dashboardTokenHeatmapDay{Day: window.Day, FromMS: window.FromMS, ToMS: window.ToMS}
		// `window.Day > today` is a string comparison on fixed-width `YYYY-MM-DD` keys, which
		// is what makes it order correctly without parsing.
		if window.Day > today {
			// A day that has not happened yet is not queried, so it reads as a day with no
			// stored record - which is what it is, and the only thing a reader can compare.
			response.Days = append(response.Days, entry)
			continue
		}
		if window.Day == today {
			// Today is the one day whose range is cut short, so the cell cannot count a record
			// that the request list it opens would not show.
			entry.ToMS = asOf.UnixMilli()
		}
		response.Days = append(response.Days, entry)
		repoDays = append(repoDays, repository.UsageDayWindow{
			Day: entry.Day, FromMS: entry.FromMS, ToMS: entry.ToMS,
		})
	}

	totals, err := h.repo.QueryDailyTokenTotals(ctx, defaultInstanceID(), repoDays)
	if err != nil {
		writeInternalError(writer, fmt.Errorf("query daily token totals: %w", err))
		return
	}
	if len(totals) != len(repoDays) {
		writeInternalError(writer, fmt.Errorf("daily token totals answered %d days for %d queried", len(totals), len(repoDays)))
		return
	}
	// The totals cover the queried days only, so they are walked alongside that list and matched
	// back to the response entries by day key - a future day has no entry here.
	byDay := make(map[string]int, len(response.Days))
	for index := range response.Days {
		byDay[response.Days[index].Day] = index
	}
	for index, total := range totals {
		if total.Day != repoDays[index].Day {
			// Reported rather than patched: a shifted pairing would attribute one day's traffic
			// to another day's cell, which reads as plausible data.
			writeInternalError(writer, fmt.Errorf("daily token totals returned day %s at index %d (expected %s)", total.Day, index, repoDays[index].Day))
			return
		}
		position, exists := byDay[total.Day]
		if !exists {
			writeInternalError(writer, fmt.Errorf("daily token totals returned a day %s that the grid does not carry", total.Day))
			return
		}
		day := &response.Days[position]
		day.Tokens = total.Tokens
		day.Requests = total.Requests
		day.Failures = total.Failures
		day.Input = total.Input
		day.Output = total.Output
		day.Reasoning = total.Reasoning
		day.CacheRead = total.CacheRead
		day.CacheWrite = total.CacheWrite
	}

	// A nil marker is reported as null, never as epoch zero: the panel paints "no
	// stored usage" before that instant, and zero would claim the whole strip had been
	// recorded since 1970.
	first, err := h.repo.FirstUsageEventMS(ctx, defaultInstanceID())
	if err != nil {
		writeInternalError(writer, fmt.Errorf("query first usage event: %w", err))
		return
	}
	response.FirstStoredMS = first

	writeJSON(writer, http.StatusOK, response)
}

// heatmapTimezone resolves the viewer's timezone.
//
// The zone is a request parameter because the days it describes are the viewer's
// days, and the server cannot derive them: the deployed image runs in a container
// whose `TZ` is whatever the operator set, if anything. An IANA name is required
// rather than a UTC offset because an offset cannot express daylight saving, and a
// single offset applied to a whole quarter is wrong for every day on the other side
// of a transition - not merely the two transition days.
func heatmapTimezone(request *http.Request) (*time.Location, string) {
	raw := strings.TrimSpace(request.URL.Query().Get("tz"))
	if raw == "" {
		return nil, "tz is required (the viewer's IANA timezone, e.g. Asia/Shanghai)"
	}
	if len(raw) > heatmapMaxZoneName {
		return nil, "tz is not a valid timezone name"
	}
	zone, err := time.LoadLocation(raw)
	if err != nil {
		// An unknown zone is refused rather than defaulted to UTC: defaulting would
		// answer for a calendar the operator is not looking at, and the only symptom
		// would be days shifted by some hours near midnight.
		return nil, fmt.Sprintf("tz %q is not a known timezone", raw)
	}
	return zone, ""
}

// heatmapDayWindows builds the grid's local calendar days, each with the exact inclusive instant
// range it covers.
//
// The bounds come from `time.Date` in the target zone rather than from arithmetic on a day length. A
// local day is not always 86 400 000 ms - a daylight-saving start is 23 hours and an end is 25 - so a
// fixed-width window would attribute an hour of the transition day's traffic to its neighbour, twice
// a year, on a day the operator is most likely to be looking for.
//
// The range is whole weeks rather than a fixed day count, and it ends on the week containing today
// rather than on today: the rows are weekdays, so a short final column is the one place they stop
// lining up.
//
// Today's own range stops at the read instant, so a record timestamped later today cannot inflate
// it. The days after today in that final column carry no range at all: there is nothing to ask
// about a day that has not happened, and giving them one would mean a window whose start is after
// its end. They are still emitted, because the grid's shape is its span, and they render as days
// with no stored record - which is exactly what they are.
func heatmapDayWindows(asOf time.Time, zone *time.Location) []repository.UsageDayWindow {
	local := asOf.In(zone)
	// The span is walked as *civil dates*, not as instants. Daylight-saving arithmetic is the reason:
	// a few zones transition at midnight, so an instant-based walk repeats one civil date and skips
	// another, and the grid would then report a full span while carrying a duplicate and a gap. A UTC
	// carrier has no transitions, so `AddDate` on it always advances exactly one calendar date.
	year, month, day := local.Date()
	weekdayOffset := (int(local.Weekday()) + 6) % 7
	origin := time.Date(year, month, day-weekdayOffset-(heatmapWeeks-1)*7, 0, 0, 0, 0, time.UTC)
	todayKey := local.Format("2006-01-02")

	total := heatmapWeeks * 7
	windows := make([]repository.UsageDayWindow, 0, total)
	for offset := 0; offset < total; offset++ {
		civil := origin.AddDate(0, 0, offset)
		key := civil.Format("2006-01-02")
		if key > todayKey {
			// Nothing to ask about a day that has not happened, and giving it a range would mean a
			// window whose start is after its end. It is still emitted: the grid's shape is its span.
			windows = append(windows, repository.UsageDayWindow{Day: key})
			continue
		}
		civilYear, civilMonth, civilDay := civil.Date()
		from := dayStart(civilYear, civilMonth, civilDay, zone)
		// The next day's start, resolved independently rather than by adding 24 hours: the two are
		// the same thing on every day except the two transition days a year, which is exactly where
		// a fixed-width window would attribute an hour of one day's traffic to its neighbour.
		nextCivil := origin.AddDate(0, 0, offset+1)
		nextYear, nextMonth, nextDay := nextCivil.Date()
		toMS := dayStart(nextYear, nextMonth, nextDay, zone).Add(-time.Millisecond).UnixMilli()
		if key == todayKey {
			// Today is the one day whose range is cut short, so its cell cannot count a record the
			// request list it opens would not show.
			toMS = asOf.UnixMilli()
		}
		windows = append(windows, repository.UsageDayWindow{
			Day:    key,
			FromMS: from.UnixMilli(),
			ToMS:   toMS,
		})
	}
	return windows
}

// dayStart returns the first instant whose local clock in `zone` reads the given civil date.
//
// It cannot be `time.Date(y, m, d, 0, 0, 0, 0, zone)` alone. Where a zone springs forward *at*
// midnight the civil date has no 00:00 - Chile's `2020-09-06` begins at 01:00 -0300 - and Go
// normalizes that request to `2020-09-05 23:00`, an instant on the previous day. Taking that as the
// start put an hour of the previous day's traffic inside this day's window and made the transition
// day 24 hours long instead of 23.
//
// The transition is bounded, so a short forward walk finds it: any gap at midnight is a
// daylight-saving shift, and no zone shifts by more than a couple of hours.
func dayStart(year int, month time.Month, day int, zone *time.Location) time.Time {
	key := time.Date(year, month, day, 0, 0, 0, 0, time.UTC).Format("2006-01-02")
	instant := time.Date(year, month, day, 0, 0, 0, 0, zone)
	for elapsed := time.Duration(0); elapsed <= maxMidnightShift; elapsed += midnightShiftStep {
		if instant.In(zone).Format("2006-01-02") == key {
			return instant
		}
		instant = instant.Add(midnightShiftStep)
	}
	return instant
}

// The bound on the forward walk in dayStart. Four hours is comfortably past any real midnight
// transition - the largest in the zone database is two hours - and keeping the search bounded means
// malformed zone data cannot spin here.
const (
	maxMidnightShift  = 4 * time.Hour
	midnightShiftStep = time.Minute
)

// localDay renders an instant as the `YYYY-MM-DD` the given zone's clock shows.
//
// The keys are fixed-width, so they compare correctly as strings - which is what lets the
// handler ask "is this day still to come" without parsing anything.
func localDay(at time.Time, zone *time.Location) string {
	return at.In(zone).Format("2006-01-02")
}
