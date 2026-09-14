package repository

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/usage"
)

// dayWindowsIn builds consecutive local-day windows ending at `end`, using the real
// zone rules for `zone`. The tests state the expectation through this helper rather
// than through hand-computed millisecond literals, so a daylight-saving day is
// exercised by the same code path the handler uses rather than by a fixture that
// happens to be 24 hours long.
func dayWindowsIn(t *testing.T, zone *time.Location, end time.Time, span int) []UsageDayWindow {
	t.Helper()
	local := end.In(zone)
	today := time.Date(local.Year(), local.Month(), local.Day(), 0, 0, 0, 0, zone)
	windows := make([]UsageDayWindow, 0, span)
	for offset := -(span - 1); offset <= 0; offset++ {
		start := today.AddDate(0, 0, offset)
		finish := start.AddDate(0, 0, 1).Add(-time.Millisecond)
		toMS := finish.UnixMilli()
		if toMS > end.UnixMilli() {
			toMS = end.UnixMilli()
		}
		windows = append(windows, UsageDayWindow{
			Day: start.Format("2006-01-02"), FromMS: start.UnixMilli(), ToMS: toMS,
		})
	}
	return windows
}

// foldToMap runs the query and keys the result by day.
func foldToMap(t *testing.T, repo *Repository, windows []UsageDayWindow) map[string]UsageDayTotals {
	t.Helper()
	days, err := repo.QueryDailyTokenTotals(context.Background(), "default", windows)
	if err != nil {
		t.Fatal(err)
	}
	if len(days) != len(windows) {
		t.Fatalf("fold returned %d days for %d windows", len(days), len(windows))
	}
	byDay := make(map[string]UsageDayTotals, len(days))
	for index, day := range days {
		if day.Day != windows[index].Day {
			t.Fatalf("fold returned day %s at index %d, want %s", day.Day, index, windows[index].Day)
		}
		byDay[day.Day] = day
	}
	return byDay
}

func insertAt(t *testing.T, repo *Repository, id string, at time.Time, tokens int64) {
	t.Helper()
	if _, err := repo.InsertUsageEvents(context.Background(), []usage.Event{
		usageEventAt("default", id, at, usage.TokenStats{InputTokens: tokens, TotalTokens: tokens}, false),
	}); err != nil {
		t.Fatal(err)
	}
}

func TestQueryDailyTokenTotalsSplitsAFractionalOffsetMidnight(t *testing.T) {
	// The defect this pins: a whole-hour rollup row cannot straddle a local midnight
	// at a fractional offset, so an implementation that groups bucket starts by an
	// offset-shifted key reports these two events on the same day. India is UTC+5:30,
	// which puts local midnight at 18:30 UTC - inside the UTC 18:00 hour.
	kolkata, err := time.LoadLocation("Asia/Kolkata")
	if err != nil {
		t.Skipf("zone database unavailable: %v", err)
	}
	repo := usageTestRepository(t)

	// Both instants are in the same UTC hour and on different local days.
	before := time.Date(2026, 9, 14, 18, 29, 0, 0, time.UTC)
	after := time.Date(2026, 9, 14, 18, 31, 0, 0, time.UTC)
	if before.In(kolkata).Format("2006-01-02") == after.In(kolkata).Format("2006-01-02") {
		t.Fatal("fixture does not straddle the local midnight it is testing")
	}
	if before.Truncate(time.Hour) != after.Truncate(time.Hour) {
		t.Fatal("fixture must keep both events inside one UTC hour")
	}
	insertAt(t, repo, "kt-1", before, 10)
	insertAt(t, repo, "kt-2", after, 90)

	byDay := foldToMap(t, repo, dayWindowsIn(t, kolkata, after, 3))
	if got := byDay[before.In(kolkata).Format("2006-01-02")].Tokens; got != 10 {
		t.Fatalf("pre-midnight local day = %d tokens, want 10", got)
	}
	if got := byDay[after.In(kolkata).Format("2006-01-02")].Tokens; got != 90 {
		t.Fatalf("post-midnight local day = %d tokens, want 90", got)
	}
}

func TestQueryDailyTokenTotalsExcludesTrafficOutsideTheWindows(t *testing.T) {
	// Two temptations are pinned here. A window's `from` may sit mid-hour, and a
	// query that widens its range to an hour boundary would pull in traffic before the
	// window; and a record after the last window's end must not count at all, which is
	// the future-timestamp case.
	zone := time.UTC
	repo := usageTestRepository(t)
	asOf := time.Date(2026, 9, 14, 12, 0, 0, 0, time.UTC)
	windows := dayWindowsIn(t, zone, asOf, 2)

	// One millisecond before the first window opens, and in the same UTC hour as the
	// record inside it: a query that widened its range to an hour boundary would pull
	// this in.
	insertAt(t, repo, "early", time.UnixMilli(windows[0].FromMS-1).UTC(), 1_000)
	// Inside the first window.
	insertAt(t, repo, "inside", time.UnixMilli(windows[0].FromMS+1).UTC(), 7)
	// After the last window's end (asOf), i.e. timestamped in the future.
	insertAt(t, repo, "future", time.UnixMilli(windows[len(windows)-1].ToMS+1).UTC(), 5_000)

	byDay := foldToMap(t, repo, windows)
	if got := byDay["2026-09-13"].Tokens; got != 7 {
		t.Fatalf("2026-09-13 = %d tokens, want 7 (traffic before the window must not count)", got)
	}
	// The excluded record must not have landed on the previous day either: widening
	// the range does not merely add a day, it adds an hour to whichever day absorbs it.
	if got := byDay["2026-09-12"].Tokens; got != 0 {
		t.Fatalf("2026-09-12 = %d tokens, want 0 (the day before the span is not requested)", got)
	}
	if got := byDay["2026-09-14"].Tokens; got != 0 {
		t.Fatalf("2026-09-14 = %d tokens, want 0 (future traffic must not count)", got)
	}
}

func TestQueryDailyTokenTotalsCountsEveryRecordOnceWhenTimestampsArriveOutOfOrder(t *testing.T) {
	// CPA event times can arrive slightly out of order, and the hourly rollup is not
	// disjoint from a timestamp boundary: fold an event at 10:50, then insert an
	// unaggregated event at 10:30, and a hybrid read would count 10:50 from the rollup
	// and again from the detail tail. Folding one source has no such boundary.
	repo := usageTestRepository(t)
	ctx := context.Background()
	zone := time.UTC

	later := time.Date(2026, 9, 14, 10, 50, 0, 0, time.UTC)
	earlier := time.Date(2026, 9, 14, 10, 30, 0, 0, time.UTC)
	insertAt(t, repo, "later", later, 40)
	if _, err := repo.AggregateUsageGrain(ctx, CheckpointHourly, HourBucketMS, 100); err != nil {
		t.Fatal(err)
	}
	insertAt(t, repo, "earlier", earlier, 60)

	byDay := foldToMap(t, repo, dayWindowsIn(t, zone, later, 2))
	if got := byDay["2026-09-14"].Tokens; got != 100 {
		t.Fatalf("day totals %d tokens, want 100 (each record exactly once)", got)
	}
	if got := byDay["2026-09-14"].Requests; got != 2 {
		t.Fatalf("day counts %d requests, want 2", got)
	}
}

func TestQueryDailyTokenTotalsIgnoresAnotherInstancesRecords(t *testing.T) {
	repo := usageTestRepository(t)
	ctx := context.Background()
	at := time.Date(2026, 9, 14, 8, 0, 0, 0, time.UTC)
	insertAt(t, repo, "mine", at, 10)

	// A second instance shares the tables; its traffic must not appear in this one's
	// strip. The foreign key means the row has to exist first.
	if _, err := repo.SQL().ExecContext(ctx, `
		INSERT INTO cpa_instances (id, name, base_url, usage_addr,
			management_key_ciphertext, management_key_nonce, status, created_at, updated_at)
		VALUES ('other', 'Other', 'http://127.0.0.1:8318', '127.0.0.1:8318', x'00', x'00', 'unknown', 0, 0)`); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.InsertUsageEvents(ctx, []usage.Event{
		usageEventAt("other", "theirs", at, usage.TokenStats{InputTokens: 999, TotalTokens: 999}, false),
	}); err != nil {
		t.Fatal(err)
	}

	byDay := foldToMap(t, repo, dayWindowsIn(t, time.UTC, at, 2))
	if got := byDay["2026-09-14"].Tokens; got != 10 {
		t.Fatalf("day = %d tokens, want 10 (another instance's records must not be counted)", got)
	}
}

func TestQueryDailyTokenTotalsHandlesDaylightSavingDays(t *testing.T) {
	// A local day is not always 24 hours. The windows come from the zone's own rules,
	// so an event placed just inside each end of the transition day must land on it
	// rather than on its neighbour.
	newYork, err := time.LoadLocation("America/New_York")
	if err != nil {
		t.Skipf("zone database unavailable: %v", err)
	}
	repo := usageTestRepository(t)

	// 2026-03-08 is the spring-forward day in the US: 23 hours long. 07:30Z is 02:30
	// local standard time, an hour before the 02:00 -> 03:00 jump.
	spring := time.Date(2026, 3, 8, 7, 30, 0, 0, time.UTC)
	if spring.In(newYork).Format("2006-01-02") != "2026-03-08" {
		t.Fatalf("fixture instant is %s in New York, expected the transition day", spring.In(newYork))
	}
	insertAt(t, repo, "spring", spring, 25)
	if length := time.Date(2026, 3, 9, 0, 0, 0, 0, newYork).Sub(time.Date(2026, 3, 8, 0, 0, 0, 0, newYork)); length != 23*time.Hour {
		t.Fatalf("the spring-forward day is %s, expected 23h", length)
	}

	// 2026-11-01 is the fall-back day: 25 hours long.
	autumn := time.Date(2026, 11, 1, 5, 30, 0, 0, time.UTC)
	if autumn.In(newYork).Format("2006-01-02") != "2026-11-01" {
		t.Fatalf("fixture instant is %s in New York, expected the transition day", autumn.In(newYork))
	}
	insertAt(t, repo, "autumn", autumn, 50)
	if length := time.Date(2026, 11, 2, 0, 0, 0, 0, newYork).Sub(time.Date(2026, 11, 1, 0, 0, 0, 0, newYork)); length != 25*time.Hour {
		t.Fatalf("the fall-back day is %s, expected 25h", length)
	}

	byDay := foldToMap(t, repo, dayWindowsIn(t, newYork, autumn, 400))
	if got := byDay["2026-03-08"].Tokens; got != 25 {
		t.Fatalf("spring-forward day = %d tokens, want 25", got)
	}
	if got := byDay["2026-11-01"].Tokens; got != 50 {
		t.Fatalf("fall-back day = %d tokens, want 50", got)
	}

	// Every complete window in the span is 23, 24 or 25 hours wide, which is the
	// property a fixed-width window would break on exactly two of them. The final
	// window is short by design - it stops at the read instant, so future timestamps
	// cannot inflate today - and is checked separately.
	span := dayWindowsIn(t, newYork, autumn, 400)
	for _, window := range span[:len(span)-1] {
		width := time.Duration(window.ToMS-window.FromMS+1) * time.Millisecond
		if width != 23*time.Hour && width != 24*time.Hour && width != 25*time.Hour {
			t.Fatalf("window %s is %s wide, expected 23-25h", window.Day, width)
		}
	}
	last := span[len(span)-1]
	if last.ToMS != autumn.UnixMilli() {
		t.Fatalf("the final window ends at %d, want the read instant %d", last.ToMS, autumn.UnixMilli())
	}
}

func TestQueryDailyTokenTotalsRejectsInvalidWindows(t *testing.T) {
	repo := usageTestRepository(t)
	ctx := context.Background()
	for _, window := range []UsageDayWindow{
		{Day: "2026-09-14", FromMS: 1_000, ToMS: 999},
	} {
		if _, err := repo.QueryDailyTokenTotals(ctx, "default", []UsageDayWindow{window}); err == nil {
			t.Fatalf("window %+v should be refused", window)
		}
	}
	// An empty span is a valid request with an empty answer, not an error: the panel
	// asks for ninety days and a caller asking for none has asked a coherent question.
	days, err := repo.QueryDailyTokenTotals(ctx, "default", nil)
	if err != nil || len(days) != 0 {
		t.Fatalf("empty span = %v, %v; want no days and no error", days, err)
	}
}

func TestQueryDailyTokenTotalsReportsDaysThatCarriedNothing(t *testing.T) {
	// The strip's shape is its span, so a day with no traffic must come back as a
	// present, zeroed entry rather than being absent: the client would otherwise have
	// to reconstruct the gap, and a shift in the pairing would be invisible.
	repo := usageTestRepository(t)
	at := time.Date(2026, 9, 14, 8, 0, 0, 0, time.UTC)
	insertAt(t, repo, "only", at, 42)

	windows := dayWindowsIn(t, time.UTC, at, 5)
	days, err := repo.QueryDailyTokenTotals(context.Background(), "default", windows)
	if err != nil {
		t.Fatal(err)
	}
	if len(days) != 5 {
		t.Fatalf("fold returned %d days, want 5", len(days))
	}
	empty := 0
	for _, day := range days {
		if day.Tokens == 0 {
			empty++
			if day.Requests != 0 || day.Input != 0 {
				t.Fatalf("day %s is zero on tokens but not on its other counts: %+v", day.Day, day)
			}
		}
	}
	if empty != 4 {
		t.Fatalf("%d days reported as empty, want 4", empty)
	}
}

func TestFirstUsageEventMSIsInstanceScopedAndDistinguishesEmptyFromEpoch(t *testing.T) {
	repo := usageTestRepository(t)
	ctx := context.Background()

	// Nothing captured: nil, not zero. The panel reads the difference to label a cell
	// "no stored usage" rather than claiming a first record at the epoch.
	value, err := repo.FirstUsageEventMS(ctx, "default")
	if err != nil {
		t.Fatal(err)
	}
	if value != nil {
		t.Fatalf("empty store reported first record %d, want nil", *value)
	}

	first := time.Date(2026, 9, 1, 3, 4, 5, 0, time.UTC)
	second := time.Date(2026, 9, 14, 6, 7, 8, 0, time.UTC)
	insertAt(t, repo, "b", second, 1)
	insertAt(t, repo, "a", first, 1)

	value, err = repo.FirstUsageEventMS(ctx, "default")
	if err != nil {
		t.Fatal(err)
	}
	if value == nil || *value != first.UnixMilli() {
		t.Fatalf("first = %v, want %d", value, first.UnixMilli())
	}

	// Another instance's earlier record must not become this instance's first.
	if _, err := repo.SQL().ExecContext(ctx, `
		INSERT INTO cpa_instances (id, name, base_url, usage_addr,
			management_key_ciphertext, management_key_nonce, status, created_at, updated_at)
		VALUES ('other', 'Other', 'http://127.0.0.1:8318', '127.0.0.1:8318', x'00', x'00', 'unknown', 0, 0)`); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.InsertUsageEvents(ctx, []usage.Event{
		usageEventAt("other", "earlier", first.Add(-72*time.Hour), usage.TokenStats{TotalTokens: 1}, false),
	}); err != nil {
		t.Fatal(err)
	}
	value, err = repo.FirstUsageEventMS(ctx, "default")
	if err != nil {
		t.Fatal(err)
	}
	if value == nil || *value != first.UnixMilli() {
		t.Fatalf("first = %v after another instance's earlier record, want %d", value, first.UnixMilli())
	}
}

func TestQueryDailyTokenTotalsCountsEveryRequestExactlyOnceAcrossTheSpan(t *testing.T) {
	// Both edges of every window are populated, one unit each, and the windows are
	// contiguous - so the strip's own total is the number of records written. Anything
	// counted twice, dropped, or attributed to a day outside the span moves that sum.
	// This is the arithmetic the drill-down depends on: a cell whose total and whose
	// open interval disagree is exactly what a mismatched bound produces.
	repo := usageTestRepository(t)
	at := time.Date(2026, 9, 14, 8, 0, 0, 0, time.UTC)
	windows := dayWindowsIn(t, time.UTC, at, 5)

	written := 0
	for index, window := range windows {
		insertAt(t, repo, fmt.Sprintf("start-%d", index), time.UnixMilli(window.FromMS).UTC(), 1)
		written++
		if window.ToMS != window.FromMS {
			insertAt(t, repo, fmt.Sprintf("end-%d", index), time.UnixMilli(window.ToMS).UTC(), 1)
			written++
		}
	}
	// One record immediately outside each edge of the whole span.
	insertAt(t, repo, "before-span", time.UnixMilli(windows[0].FromMS-1).UTC(), 1_000)
	insertAt(t, repo, "after-span", time.UnixMilli(windows[len(windows)-1].ToMS+1).UTC(), 1_000)

	byDay := foldToMap(t, repo, windows)
	total := int64(0)
	for _, window := range windows {
		entry := byDay[window.Day]
		total += entry.Tokens
		// Every requested day is present, whether or not it carried anything.
		if entry.Day != window.Day {
			t.Fatalf("day %s came back keyed as %s", window.Day, entry.Day)
		}
	}
	if total != int64(written) {
		t.Fatalf("the span totals %d tokens across %d records, want %d", total, written, written)
	}
}
