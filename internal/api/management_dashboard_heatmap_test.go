package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"testing"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
	"github.com/oh-my-cpa/oh-my-cpa/internal/usage"
)

func heatmapURL(baseURL string, query string) string {
	return baseURL + "/omc/api/v1/management/dashboard/token-heatmap" + query
}

// getHeatmapJSON fetches the strip and fails on anything but a 200, so a wrong shape
// is reported here rather than by every assertion after it.
func getHeatmapJSON(t *testing.T, client *http.Client, url string) dashboardTokenHeatmapResponse {
	t.Helper()
	response, payload := getJSON(t, client, url)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("heatmap status = %d body %s", response.StatusCode, payload)
	}
	var body dashboardTokenHeatmapResponse
	if err := json.Unmarshal(payload, &body); err != nil {
		t.Fatal(err)
	}
	return body
}

// heatmapDay finds one day, so a failure names the day it could not find rather than
// dumping the whole 371-entry strip.
func heatmapDay(t *testing.T, body dashboardTokenHeatmapResponse, day string) dashboardTokenHeatmapDay {
	t.Helper()
	for _, entry := range body.Days {
		if entry.Day == day {
			return entry
		}
	}
	t.Fatalf("day %s is absent from the strip (%d days: %s .. %s)", day, len(body.Days), body.Days[0].Day, body.Days[len(body.Days)-1].Day)
	return dashboardTokenHeatmapDay{}
}

// dayFor builds the local day key a viewer in `zone` would see for an instant.
func dayFor(zone *time.Location, at time.Time) string {
	return at.In(zone).Format("2006-01-02")
}

func TestTokenHeatmapRequiresAKnownTimezone(t *testing.T) {
	client, baseURL, _ := startDashboardTestServer(t, nil)

	// Absent, over-long and unknown zones are refused rather than defaulted to UTC. A
	// default would answer for a calendar the operator is not looking at, and the only
	// visible symptom would be days shifting by some hours near midnight. The URL-
	// encoded space case is a value that is not a zone name at all.
	for _, query := range []string{"", "?tz=", "?tz=Not/AZone", "?tz=UTC+8", "?tz=" + fmt.Sprintf("%070d", 0)} {
		response, payload := getJSON(t, client, heatmapURL(baseURL, query))
		if response.StatusCode != http.StatusBadRequest {
			t.Fatalf("query %q: status = %d body %s", query, response.StatusCode, payload)
		}
	}
}

func TestTokenHeatmapDescribesARollingYearOfWeeks(t *testing.T) {
	client, baseURL, _ := startDashboardTestServer(t, nil)
	body := getHeatmapJSON(t, client, heatmapURL(baseURL, "?tz=UTC"))

	// Fifty-three whole Monday-first weeks. Whole weeks because the rows are weekdays, so a short
	// final column is the one place they stop lining up - and 53 is a year plus the days of the
	// current week, so the span is a trailing year rather than a calendar one.
	if len(body.Days) != heatmapWeeks*7 {
		t.Fatalf("grid carries %d days, want %d (53 whole weeks)", len(body.Days), heatmapWeeks*7)
	}
	from, err := time.Parse("2006-01-02", body.Days[0].Day)
	if err != nil {
		t.Fatalf("first day %q is not a date: %v", body.Days[0].Day, err)
	}
	if from.Weekday() != time.Monday {
		t.Fatalf("grid starts on %s, want a Monday", from.Weekday())
	}
	to, err := time.Parse("2006-01-02", body.Days[len(body.Days)-1].Day)
	if err != nil {
		t.Fatalf("last day %q is not a date: %v", body.Days[len(body.Days)-1].Day, err)
	}
	if to.Weekday() != time.Sunday {
		t.Fatalf("grid ends on %s, want a Sunday so the final column is complete", to.Weekday())
	}
	// The read instant the response was resolved against, not a second reading of the client's clock:
	// the two differ when the suite crosses UTC midnight between the request and this line, and the
	// grid's own `as_of_ms` is by definition the instant its days were built from.
	today := time.UnixMilli(body.AsOfMS).UTC().Format("2006-01-02")
	// Every day but today tiles onto the next: the grid spans a continuous range with no gap, which
	// is what lets the client divide it into weeks without checking anything. Today is the one
	// exception by design - its range stops at the read instant, so the following day does not begin
	// where it ended.
	for index := 1; index < len(body.Days); index++ {
		previous := body.Days[index-1]
		day := body.Days[index]
		if day.Day <= previous.Day {
			t.Fatalf("days are not strictly ordered at %d: %s then %s", index, previous.Day, day.Day)
		}
		// A day with no range is one nothing can be asked about: either today's successors in the
		// final column, or the boundary today itself leaves behind.
		if previous.Day == today || day.FromMS == 0 {
			continue
		}
		if day.FromMS != previous.ToMS+1 {
			t.Fatalf("day %s starts at %d but %s ends at %d: the windows must tile without a gap",
				day.Day, day.FromMS, previous.Day, previous.ToMS)
		}
	}
	if body.Timezone != "UTC" {
		t.Fatalf("timezone = %q, want UTC", body.Timezone)
	}

	// Today is in the grid, and the days after it in its own week are clamped to the read instant
	// rather than carrying the traffic of a day that has not finished.
	seenToday := false
	for _, day := range body.Days {
		if day.Day != today {
			if day.ToMS > body.AsOfMS {
				t.Fatalf("day %s ends at %d, past the read instant %d", day.Day, day.ToMS, body.AsOfMS)
			}
			continue
		}
		seenToday = true
		if day.ToMS > body.AsOfMS {
			t.Fatalf("today's window ends at %d, past the read instant %d", day.ToMS, body.AsOfMS)
		}
	}
	if !seenToday {
		t.Fatalf("today (%s) is not in the grid", today)
	}
	// The whole window is in the past, so nothing in it can carry a future timestamp.
	if body.Days[len(body.Days)-1].Day < today {
		t.Fatalf("grid ends on %s, before today (%s)", body.Days[len(body.Days)-1].Day, today)
	}
}

func TestTokenHeatmapFoldsDaysOnTheViewersCalendar(t *testing.T) {
	// Kolkata is UTC+5:30, so local midnight is at 18:30 UTC. An implementation that
	// grouped by an offset-shifted hour would put both of these records on one day.
	kolkata, err := time.LoadLocation("Asia/Kolkata")
	if err != nil {
		t.Skipf("zone database unavailable: %v", err)
	}
	now := time.Now().UTC()
	// Yesterday and today, an hour apart in UTC and on different local days.
	before := time.Date(now.Year(), now.Month(), now.Day(), 18, 29, 0, 0, time.UTC).AddDate(0, 0, -1)
	after := before.Add(2 * time.Minute)
	if dayFor(kolkata, before) == dayFor(kolkata, after) {
		t.Fatalf("fixture does not straddle a local midnight: both are %s", dayFor(kolkata, before))
	}
	client, baseURL, repo := startDashboardTestServer(t, nil)
	seedEvents(t, repo, before, []repository.UsageDecoded{
		{Event: eventFor("heat-before", before, usage.TokenStats{InputTokens: 10, TotalTokens: 10}, false)},
		{Event: eventFor("heat-after", after, usage.TokenStats{InputTokens: 90, TotalTokens: 90}, false)},
	})

	body := getHeatmapJSON(t, client, heatmapURL(baseURL, "?tz=Asia%2FKolkata"))
	if entry := heatmapDay(t, body, dayFor(kolkata, before)); entry.Tokens != 10 {
		t.Fatalf("day %s = %d tokens, want 10", entry.Day, entry.Tokens)
	}
	if entry := heatmapDay(t, body, dayFor(kolkata, after)); entry.Tokens != 90 {
		t.Fatalf("day %s = %d tokens, want 90", entry.Day, entry.Tokens)
	}

	// The same two records land on one day for a viewer at UTC, so the zone is what
	// decided the split rather than the fixture's offsets.
	utc := getHeatmapJSON(t, client, heatmapURL(baseURL, "?tz=UTC"))
	if entry := heatmapDay(t, utc, dayFor(time.UTC, before)); entry.Tokens != 100 {
		t.Fatalf("UTC day %s = %d tokens, want both records (100)", entry.Day, entry.Tokens)
	}
	if body.Timezone != "Asia/Kolkata" || utc.Timezone != "UTC" {
		t.Fatalf("zones were not echoed: %q and %q", body.Timezone, utc.Timezone)
	}
}

func TestTokenHeatmapReportsMissingStoredUsageAsNull(t *testing.T) {
	// Nothing captured: the marker must be an explicit null. Zero would claim the
	// whole strip had been recorded since the epoch, which is the difference the
	// client paints between "no stored usage" and "a quiet day".
	client, baseURL, _ := startDashboardTestServer(t, nil)
	empty := getHeatmapJSON(t, client, heatmapURL(baseURL, "?tz=UTC"))
	if empty.FirstStoredMS != nil {
		t.Fatalf("first_stored_ms = %d on an empty store, want null", *empty.FirstStoredMS)
	}
	// Every day is still present and zeroed, so the grid has its shape on a fresh
	// install rather than collapsing to nothing.
	// A fresh install still gets the whole window, so the panel has its shape before any traffic.
	if len(empty.Days) != heatmapWeeks*7 {
		t.Fatalf("empty store carries %d days, want %d", len(empty.Days), heatmapWeeks*7)
	}
	for _, day := range empty.Days {
		if day.Tokens != 0 || day.Requests != 0 {
			t.Fatalf("empty store reported traffic on %s: %+v", day.Day, day)
		}
	}

	first := time.Now().UTC().AddDate(0, 0, -3).Truncate(time.Hour)
	client, baseURL, repo := startDashboardTestServer(t, nil)
	seedEvents(t, repo, first, []repository.UsageDecoded{
		{Event: eventFor("heat-first", first, usage.TokenStats{TotalTokens: 5}, false)},
	})
	body := getHeatmapJSON(t, client, heatmapURL(baseURL, "?tz=UTC"))
	if body.FirstStoredMS == nil || *body.FirstStoredMS != first.UnixMilli() {
		t.Fatalf("first_stored_ms = %v, want %d", body.FirstStoredMS, first.UnixMilli())
	}
}

func TestTokenHeatmapCountsEachRecordOnceAcrossRollupAndTail(t *testing.T) {
	// The panel folds the detail table only, and the case it must survive is a record
	// that arrives after its own hour has already been rolled up: a hybrid read would
	// take that hour from the rollup and the record again from the tail.
	client, baseURL, repo := startDashboardTestServer(t, nil)
	ctx := t.Context()
	now := time.Now().UTC()
	later := now.Add(-2 * time.Hour).Truncate(time.Hour).Add(50 * time.Minute)
	earlier := later.Add(-20 * time.Minute)

	if _, err := repo.InsertUsageEvents(ctx, []usage.Event{
		eventFor("heat-later", later, usage.TokenStats{InputTokens: 40, TotalTokens: 40}, false),
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.AggregateUsageGrain(ctx, repository.CheckpointHourly, repository.HourBucketMS, 100); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.InsertUsageEvents(ctx, []usage.Event{
		eventFor("heat-earlier", earlier, usage.TokenStats{InputTokens: 60, TotalTokens: 60}, false),
	}); err != nil {
		t.Fatal(err)
	}

	body := getHeatmapJSON(t, client, heatmapURL(baseURL, "?tz=UTC"))
	entry := heatmapDay(t, body, dayFor(time.UTC, later))
	if entry.Tokens != 100 || entry.Requests != 2 {
		t.Fatalf("day %s = %d tokens over %d requests, want 100 over 2 (each record once)",
			entry.Day, entry.Tokens, entry.Requests)
	}
}

func TestTokenHeatmapWindowsMatchTheRequestListWindowForTheSameDay(t *testing.T) {
	// A cell's total and the request list it opens must describe the same interval.
	// The check is end-to-end: the strip's own bounds are used as the request list's
	// query, and the list must answer with exactly the requests the strip counted -
	// including the one that sits on the last millisecond of the day, which is the
	// bound an exclusive interval would drop.
	client, baseURL, repo := startDashboardTestServer(t, nil)
	body := getHeatmapJSON(t, client, heatmapURL(baseURL, "?tz=UTC"))
	// Today is the day the response was resolved against, and the mid-window instant comes from that
	// day's own bounds. Two traps here, and both are why this does not read the client's clock: the
	// grid ends on the *week's* Sunday, which is often a future day carrying zero bounds, and
	// `now - 30m` falls on the previous day for any run in the first half hour after UTC midnight -
	// silently dropping the middle record from the totals below.
	todayKey := time.UnixMilli(body.AsOfMS).UTC().Format("2006-01-02")
	today := heatmapDay(t, body, todayKey)
	middle := today.FromMS + (today.ToMS-today.FromMS)/2

	// One record just inside each edge of today's window, and one in its middle.
	if _, err := repo.InsertUsageEvents(t.Context(), []usage.Event{
		eventFor("heat-window-start", time.UnixMilli(today.FromMS).UTC(), usage.TokenStats{InputTokens: 3, TotalTokens: 3}, false),
		eventFor("heat-window-end", time.UnixMilli(today.ToMS).UTC(), usage.TokenStats{InputTokens: 5, TotalTokens: 5}, false),
		eventFor("heat-window-middle", time.UnixMilli(middle).UTC(), usage.TokenStats{InputTokens: 7, TotalTokens: 7}, false),
	}); err != nil {
		t.Fatal(err)
	}

	refreshed := getHeatmapJSON(t, client, heatmapURL(baseURL, "?tz=UTC"))
	today = heatmapDay(t, refreshed, todayKey)
	if today.Tokens != 15 || today.Requests != 3 {
		t.Fatalf("cell = %d tokens over %d requests, want 15 over 3", today.Tokens, today.Requests)
	}

	// The list, asked for the strip's own bounds.
	url := fmt.Sprintf("%s/omc/api/v1/usage/events?from=%d&to=%d&limit=500", baseURL, today.FromMS, today.ToMS)
	response, payload := getJSON(t, client, url)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("request list status = %d body %s", response.StatusCode, payload)
	}
	var listed struct {
		Items []struct {
			Tokens struct {
				Total int64 `json:"total"`
			} `json:"tokens"`
		} `json:"items"`
	}
	if err := json.Unmarshal(payload, &listed); err != nil {
		t.Fatal(err)
	}
	listedTotal := int64(0)
	for _, event := range listed.Items {
		listedTotal += event.Tokens.Total
	}
	if int64(len(listed.Items)) != today.Requests || listedTotal != today.Tokens {
		t.Fatalf("the list answered %d requests totalling %d tokens for the cell's own window, but the cell says %d over %d",
			len(listed.Items), listedTotal, today.Requests, today.Tokens)
	}
}

func TestTokenHeatmapKeepsFutureTrafficOutOfToday(t *testing.T) {
	// An upstream clock running ahead, or a request logged early, must not inflate
	// today's total: the final window stops at the read instant.
	client, baseURL, repo := startDashboardTestServer(t, nil)
	// The record is placed relative to the *response's* read instant rather than the client's clock,
	// and the cell is looked up by its day key. Reading the clock twice was the same midnight hazard
	// as elsewhere in this file: within six hours of UTC midnight the offset record landed on the
	// following day, where it is legitimately that day's traffic and the assertion failed.
	body := getHeatmapJSON(t, client, heatmapURL(baseURL, "?tz=UTC"))
	todayKey := time.UnixMilli(body.AsOfMS).UTC().Format("2006-01-02")
	if _, err := repo.InsertUsageEvents(t.Context(), []usage.Event{
		eventFor("heat-future", time.UnixMilli(body.AsOfMS+6*int64(time.Hour/time.Millisecond)).UTC(), usage.TokenStats{InputTokens: 999, TotalTokens: 999}, false),
	}); err != nil {
		t.Fatal(err)
	}

	refreshed := getHeatmapJSON(t, client, heatmapURL(baseURL, "?tz=UTC"))
	if entry := heatmapDay(t, refreshed, todayKey); entry.Tokens != 0 {
		t.Fatalf("today = %d tokens, want 0 (a future timestamp is not today's traffic)", entry.Tokens)
	}
}

func TestHeatmapDayWindowsSurviveAMidnightDaylightSavingStart(t *testing.T) {
	// Chile springs forward at local midnight: 2020-09-06 has no 00:00, and Go resolves that civil
	// date to 2020-09-05 23:00. An implementation that walked the span with AddDate therefore emitted
	// 2020-09-05 a second time and never emitted 2020-09-06 - a grid that reports 371 days while
	// carrying 370 distinct ones, with every day after the transition shifted by one column.
	santiago, err := time.LoadLocation("America/Santiago")
	if err != nil {
		t.Skipf("zone database unavailable: %v", err)
	}
	// The read instant is inside the transition week, so the span covers it.
	asOf := time.Date(2020, 9, 9, 12, 0, 0, 0, santiago)
	windows := heatmapDayWindows(asOf, santiago)

	if len(windows) != heatmapWeeks*7 {
		t.Fatalf("span carries %d days, want %d", len(windows), heatmapWeeks*7)
	}
	seen := make(map[string]int, len(windows))
	for _, window := range windows {
		seen[window.Day]++
	}
	for day, count := range seen {
		if count != 1 {
			t.Errorf("day %s appears %d times in the span, want once", day, count)
		}
	}
	if seen["2020-09-06"] != 1 {
		t.Errorf("the day the zone transitions on is absent from the span (or duplicated): count=%d", seen["2020-09-06"])
	}
	// The days are consecutive civil dates with no repeat: each differs from the last by one day.
	for index := 1; index < len(windows); index++ {
		before, errBefore := time.Parse("2006-01-02", windows[index-1].Day)
		after, errAfter := time.Parse("2006-01-02", windows[index].Day)
		if errBefore != nil || errAfter != nil {
			t.Fatalf("span carries a non-date key: %q, %q", windows[index-1].Day, windows[index].Day)
		}
		if delta := after.Sub(before).Hours() / 24; delta != 1 {
			t.Fatalf("days %s and %s are %v days apart, want 1", windows[index-1].Day, windows[index].Day, delta)
		}
	}
	// The transition day is 23 hours long, so its window must be too - that is the point of building
	// the bounds from the civil date rather than assuming 86 400 000 ms.
	for _, window := range windows {
		if window.Day != "2020-09-06" {
			continue
		}
		hours := float64(window.ToMS-window.FromMS+1) / 3_600_000
		if hours < 22.99 || hours > 23.01 {
			t.Errorf("the transition day spans %.2f hours, want 23", hours)
		}
	}
}
