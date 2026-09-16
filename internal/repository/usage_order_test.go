package repository

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"strconv"
	"testing"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/usage"
)

// encodeLegacyCursor writes the id-only cursor an older console would still be
// holding, so the conversion path is exercised rather than assumed.
func encodeLegacyCursor(id int64) string {
	return base64.RawURLEncoding.EncodeToString([]byte(strconv.FormatInt(id, 10)))
}

// TestListUsageEventsOrdersByRequestTime pins the list's visible order.
//
// The time column is what the reader sorts by eye, so it has to be monotonic:
// anything else reads as a broken sort. Ordering by row id - which the list used
// to do - put a long-running request above requests that started after it, because
// its record is written when the request finishes. Against a real instance that
// inverted roughly a quarter of adjacent rows.
func TestListUsageEventsOrdersByRequestTime(t *testing.T) {
	repo := usageTestRepository(t)
	ctx := context.Background()
	base := time.Date(2026, 9, 11, 9, 0, 0, 0, time.UTC)

	// Inserted first: an old request that finished quickly.
	quick := usageEventAt("default", "quick", base.Add(-10*time.Minute), usage.TokenStats{TotalTokens: 1}, false)
	// Inserted last: an agent request that started 25 minutes ago and only now
	// reached the collector, so its recording order and request order disagree.
	slow := usageEventAt("default", "slow-agent", base.Add(-25*time.Minute), usage.TokenStats{TotalTokens: 2}, false)

	if _, err := repo.InsertUsageEvents(ctx, []usage.Event{quick, slow}); err != nil {
		t.Fatal(err)
	}

	page, err := repo.ListUsageEvents(ctx, UsageEventFilter{
		InstanceID: "default",
		FromMS:     base.Add(-time.Hour).UnixMilli(),
		ToMS:       base.UnixMilli(),
		Limit:      50,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != 2 {
		t.Fatalf("items = %d, want 2", len(page.Items))
	}
	if page.Items[0].RequestID != "quick" {
		t.Fatalf("first row = %q, want the newest request time even though it was recorded first",
			page.Items[0].RequestID)
	}
	if page.Items[0].TimestampMS < page.Items[1].TimestampMS {
		t.Fatalf("test no longer exercises the case: timestamps %d then %d",
			page.Items[0].TimestampMS, page.Items[1].TimestampMS)
	}
}

// TestListUsageEventsBreaksTimestampTiesByID keeps the order total.
//
// Several records can share an exact start time (a client fanning out, or a
// coarse-grained source). Without a tiebreaker the keyset boundary is ambiguous,
// and a page edge landing inside the run would skip or repeat rows.
func TestListUsageEventsBreaksTimestampTiesByID(t *testing.T) {
	repo := usageTestRepository(t)
	ctx := context.Background()
	base := time.Date(2026, 9, 11, 9, 0, 0, 0, time.UTC)

	// Same timestamp, distinct ids: only the id can separate them.
	events := []usage.Event{
		usageEventAt("default", "tie-a", base, usage.TokenStats{TotalTokens: 1}, false),
		usageEventAt("default", "tie-b", base, usage.TokenStats{TotalTokens: 1}, false),
		usageEventAt("default", "tie-c", base, usage.TokenStats{TotalTokens: 1}, false),
	}
	if _, err := repo.InsertUsageEvents(ctx, events); err != nil {
		t.Fatal(err)
	}

	filter := UsageEventFilter{
		InstanceID: "default",
		FromMS:     base.Add(-time.Hour).UnixMilli(),
		ToMS:       base.Add(time.Hour).UnixMilli(),
		Limit:      1,
	}
	// Paging one row at a time through a tie must visit each row exactly once.
	seen := make([]string, 0, len(events))
	for page := 0; page < len(events)+1; page++ {
		result, err := repo.ListUsageEvents(ctx, filter)
		if err != nil {
			t.Fatal(err)
		}
		for _, item := range result.Items {
			seen = append(seen, item.RequestID)
		}
		if !result.HasMore {
			break
		}
		filter.Cursor = result.NextCursor
	}
	if len(seen) != len(events) {
		t.Fatalf("paging through a timestamp tie returned %d records, want %d: %v", len(seen), len(events), seen)
	}
	unique := make(map[string]bool, len(seen))
	for _, id := range seen {
		if unique[id] {
			t.Fatalf("paging through a timestamp tie returned %q twice: %v", id, seen)
		}
		unique[id] = true
	}
	// Newest first within the tie means the highest id leads.
	if seen[0] != "tie-c" {
		t.Fatalf("first record = %q, want the highest id within the tie", seen[0])
	}
}

func TestListUsageEventsReturnsEachInsertedIdentityOnce(t *testing.T) {
	repo := usageTestRepository(t)
	ctx := context.Background()
	base := time.Date(2026, 9, 11, 9, 0, 0, 0, time.UTC)

	const count = 75
	expected := make(map[string]struct{}, count)
	events := make([]usage.Event, 0, count)
	for index := 0; index < count; index++ {
		requestID := fmt.Sprintf("identity-%03d", index)
		expected[requestID] = struct{}{}
		events = append(events, usageEventAt("default", requestID, base.Add(time.Duration(index%5)*time.Second), usage.TokenStats{TotalTokens: 1}, false))
	}
	if _, err := repo.InsertUsageEvents(ctx, events); err != nil {
		t.Fatal(err)
	}

	page, err := repo.ListUsageEvents(ctx, UsageEventFilter{
		InstanceID: "default",
		FromMS:     base.Add(-time.Hour).UnixMilli(),
		ToMS:       base.Add(time.Hour).UnixMilli(),
		Limit:      500,
	})
	if err != nil {
		t.Fatal(err)
	}
	seen := make(map[string]struct{}, len(page.Items))
	ids := make(map[int64]struct{}, len(page.Items))
	for _, item := range page.Items {
		if _, duplicate := ids[item.ID]; duplicate {
			t.Fatalf("row id %d was returned twice", item.ID)
		}
		ids[item.ID] = struct{}{}
		if _, duplicate := seen[item.RequestID]; duplicate {
			t.Fatalf("request %q was returned twice", item.RequestID)
		}
		seen[item.RequestID] = struct{}{}
	}
	if len(seen) != count {
		t.Fatalf("returned %d unique identities, want %d", len(seen), count)
	}
	for requestID := range expected {
		if _, ok := seen[requestID]; !ok {
			t.Fatalf("identity %q was not returned", requestID)
		}
	}
}

// TestListUsageEventsCursorWalksRequestOrderOnce checks that keyset paging covers
// every record exactly once while new records are being appended, which is the
// property the live view depends on.
func TestListUsageEventsCursorWalksRequestOrderOnce(t *testing.T) {
	repo := usageTestRepository(t)
	ctx := context.Background()
	base := time.Date(2026, 9, 11, 9, 0, 0, 0, time.UTC)

	events := make([]usage.Event, 0, 10)
	for i := 0; i < 10; i++ {
		// Descending timestamps against ascending ids: request order is the
		// exact reverse of recording order here, so a cursor that still walked by
		// id could not produce the sequence asserted below.
		events = append(events, usageEventAt("default", string(rune('a'+i)), base.Add(-time.Duration(i)*time.Minute), usage.TokenStats{TotalTokens: 1}, false))
	}
	if _, err := repo.InsertUsageEvents(ctx, events); err != nil {
		t.Fatal(err)
	}

	filter := UsageEventFilter{
		InstanceID: "default",
		FromMS:     base.Add(-time.Hour).UnixMilli(),
		ToMS:       base.Add(time.Minute).UnixMilli(),
		Limit:      4,
	}
	seen := make([]string, 0, 10)
	for page := 0; page < 5; page++ {
		result, err := repo.ListUsageEvents(ctx, filter)
		if err != nil {
			t.Fatal(err)
		}
		for _, item := range result.Items {
			seen = append(seen, item.RequestID)
		}
		if !result.HasMore {
			break
		}
		if result.NextCursor == "" {
			t.Fatal("HasMore without a cursor")
		}
		filter.Cursor = result.NextCursor
	}
	if len(seen) != 10 {
		t.Fatalf("cursor walk returned %d records, want 10: %v", len(seen), seen)
	}
	unique := make(map[string]bool, len(seen))
	for _, id := range seen {
		if unique[id] {
			t.Fatalf("cursor walk returned %q twice: %v", id, seen)
		}
		unique[id] = true
	}
	// Newest request first: the first inserted event has the newest timestamp.
	if seen[0] != "a" {
		t.Fatalf("first record = %q, want the newest request time (a)", seen[0])
	}
}

// TestListUsageEventsCountsArrivalsBeyondAnIngestionBoundary covers the live pill.
//
// "New records" means newly recorded, which is not the same question as "newest
// request time" once the list is sorted by request time: the slow request below is
// recorded last but carries the oldest timestamp, so it must still be counted.
func TestListUsageEventsCountsArrivalsBeyondAnIngestionBoundary(t *testing.T) {
	repo := usageTestRepository(t)
	ctx := context.Background()
	base := time.Date(2026, 9, 11, 9, 0, 0, 0, time.UTC)

	first := usageEventAt("default", "first", base.Add(-5*time.Minute), usage.TokenStats{TotalTokens: 1}, false)
	if _, err := repo.InsertUsageEvents(ctx, []usage.Event{first}); err != nil {
		t.Fatal(err)
	}
	page, err := repo.ListUsageEvents(ctx, UsageEventFilter{
		InstanceID: "default",
		FromMS:     base.Add(-time.Hour).UnixMilli(),
		ToMS:       base.UnixMilli(),
		Limit:      50,
	})
	if err != nil {
		t.Fatal(err)
	}
	boundary := page.Items[0].ID

	// Recorded after the reader's boundary: one newer request time, one older.
	newer := usageEventAt("default", "newer", base.Add(-time.Minute), usage.TokenStats{TotalTokens: 1}, false)
	slow := usageEventAt("default", "slow-arrival", base.Add(-40*time.Minute), usage.TokenStats{TotalTokens: 1}, false)
	if _, err := repo.InsertUsageEvents(ctx, []usage.Event{newer, slow}); err != nil {
		t.Fatal(err)
	}

	counted, err := repo.ListUsageEvents(ctx, UsageEventFilter{
		InstanceID: "default",
		FromMS:     base.Add(-time.Hour).UnixMilli(),
		ToMS:       base.UnixMilli(),
		Limit:      50,
		SinceID:    boundary,
	})
	if err != nil {
		t.Fatal(err)
	}
	if counted.ArrivedCount != 2 {
		t.Fatalf("arrived count = %d, want both records recorded after the boundary", counted.ArrivedCount)
	}
	// The count must not disturb the rows: the list still leads with request time.
	if counted.Items[0].RequestID != "newer" {
		t.Fatalf("first row = %q, want the newest request time; the arrival count must not reorder the list",
			counted.Items[0].RequestID)
	}
	// Without the boundary the count is not reported at all.
	unrequested, err := repo.ListUsageEvents(ctx, UsageEventFilter{
		InstanceID: "default",
		FromMS:     base.Add(-time.Hour).UnixMilli(),
		ToMS:       base.UnixMilli(),
		Limit:      50,
	})
	if err != nil {
		t.Fatal(err)
	}
	if unrequested.ArrivedCount != 0 {
		t.Fatalf("arrived count = %d when no boundary was asked for, want 0", unrequested.ArrivedCount)
	}
}

// TestListUsageEventsResolvesLegacyCursor covers a cursor written before the list
// was ordered by request time. Those carry only an id, which cannot be turned into
// its keyset position without reading the row.
func TestListUsageEventsResolvesLegacyCursor(t *testing.T) {
	repo := usageTestRepository(t)
	ctx := context.Background()
	base := time.Date(2026, 9, 11, 9, 0, 0, 0, time.UTC)

	events := []usage.Event{
		usageEventAt("default", "a", base.Add(-3*time.Minute), usage.TokenStats{TotalTokens: 1}, false),
		usageEventAt("default", "b", base.Add(-2*time.Minute), usage.TokenStats{TotalTokens: 1}, false),
		usageEventAt("default", "c", base.Add(-1*time.Minute), usage.TokenStats{TotalTokens: 1}, false),
	}
	if _, err := repo.InsertUsageEvents(ctx, events); err != nil {
		t.Fatal(err)
	}

	full, err := repo.ListUsageEvents(ctx, UsageEventFilter{
		InstanceID: "default",
		FromMS:     base.Add(-time.Hour).UnixMilli(),
		ToMS:       base.UnixMilli(),
		Limit:      50,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(full.Items) != 3 {
		t.Fatalf("items = %d, want 3", len(full.Items))
	}
	// The middle row, addressed by its id alone as an older console would.
	legacy := encodeLegacyCursor(full.Items[1].ID)

	page, err := repo.ListUsageEvents(ctx, UsageEventFilter{
		InstanceID: "default",
		FromMS:     base.Add(-time.Hour).UnixMilli(),
		ToMS:       base.UnixMilli(),
		Limit:      50,
		Cursor:     legacy,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != 1 || page.Items[0].RequestID != "a" {
		t.Fatalf("legacy cursor resumed at %#v, want the row just older than the cursor", page.Items)
	}
}

// TestListUsageEventsRejectsUnresolvableLegacyCursor covers the one legacy cursor
// that cannot be honoured.
//
// A legacy cursor names a row, and the new order needs that row's timestamp. When
// the row is gone the position is unrecoverable, and guessing would show the reader
// a page from an arbitrary place in the list.
func TestListUsageEventsRejectsUnresolvableLegacyCursor(t *testing.T) {
	repo := usageTestRepository(t)
	ctx := context.Background()
	base := time.Date(2026, 9, 11, 9, 0, 0, 0, time.UTC)

	if _, err := repo.InsertUsageEvents(ctx, []usage.Event{
		usageEventAt("default", "only", base, usage.TokenStats{TotalTokens: 1}, false),
	}); err != nil {
		t.Fatal(err)
	}

	_, err := repo.ListUsageEvents(ctx, UsageEventFilter{
		InstanceID: "default",
		FromMS:     base.Add(-time.Hour).UnixMilli(),
		ToMS:       base.Add(time.Hour).UnixMilli(),
		Limit:      50,
		Cursor:     encodeLegacyCursor(999999),
	})
	if !errors.Is(err, ErrUsageCursorStale) {
		t.Fatalf("err = %v, want ErrUsageCursorStale for an id that names no row", err)
	}
}
