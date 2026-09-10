package repository

import (
	"context"
	"testing"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/usage"
)

// TestListUsageEventsOrdersByRecordingOrder pins the reason the request list is
// ordered by row id and not by request time.
//
// CPA reports the time a request started. An agent request can run for minutes,
// so the record written last can carry the oldest timestamp in the window.
// Ordering by timestamp — which the list used to do — buried that record in the
// middle of the list, so a live view looked frozen while records were arriving.
func TestListUsageEventsOrdersByRecordingOrder(t *testing.T) {
	repo := usageTestRepository(t)
	ctx := context.Background()
	base := time.Date(2026, 9, 11, 9, 0, 0, 0, time.UTC)

	// Inserted first: an old request that finished quickly.
	quick := usageEventAt("default", "quick", base.Add(-10*time.Minute), usage.TokenStats{TotalTokens: 1}, false)
	// Inserted last: an agent request that started 25 minutes ago and only now
	// reached the collector.
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
	if page.Items[0].RequestID != "slow-agent" {
		t.Fatalf("first row = %q, want the most recently recorded record even though its request time is older",
			page.Items[0].RequestID)
	}
	if page.Items[0].TimestampMS >= page.Items[1].TimestampMS {
		t.Fatalf("test no longer exercises the case: timestamps %d then %d",
			page.Items[0].TimestampMS, page.Items[1].TimestampMS)
	}
}

// TestListUsageEventsCursorWalksRecordingOrderOnce checks that keyset paging
// covers every record exactly once while new records are being appended, which
// is the property the live view depends on.
func TestListUsageEventsCursorWalksRecordingOrderOnce(t *testing.T) {
	repo := usageTestRepository(t)
	ctx := context.Background()
	base := time.Date(2026, 9, 11, 9, 0, 0, 0, time.UTC)

	events := make([]usage.Event, 0, 10)
	for i := 0; i < 10; i++ {
		// Descending timestamps against ascending ids: recording order is the
		// exact reverse of request-time order here.
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
	// Newest recorded first: the last inserted event leads.
	if seen[0] != "j" {
		t.Fatalf("first record = %q, want the last inserted (j)", seen[0])
	}
}
