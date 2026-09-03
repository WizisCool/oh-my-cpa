package repository

import (
	"context"
	"database/sql"
	"fmt"
	"sync/atomic"
	"testing"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/usage"
)

var usageDSNCounter atomic.Uint64

// usageTestRepository opens a private in-memory database. The package's shared
// cache would otherwise leak rows between tests.
func usageTestRepository(t *testing.T) *Repository {
	t.Helper()
	name := fmt.Sprintf("file:memdb_usage_%d?mode=memory&cache=shared", usageDSNCounter.Add(1))
	db, err := Open(context.Background(), name)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	repo := New(db)
	// usage tables reference cpa_instances and foreign keys are enforced.
	if _, err := db.SQL.Exec(`
		INSERT INTO cpa_instances (id, name, base_url, usage_addr,
			management_key_ciphertext, management_key_nonce, status, created_at, updated_at)
		VALUES ('default', 'Default', 'http://127.0.0.1:8317', '127.0.0.1:8317',
			x'00', x'00', 'unknown', 0, 0)`); err != nil {
		t.Fatal(err)
	}
	return repo
}

func usageEventAt(instanceID string, id string, at time.Time, tokens usage.TokenStats, failed bool) usage.Event {
	return usage.Event{
		InstanceID: instanceID, EventKey: id, RequestID: id,
		APIGroupKey: "group-" + id, Model: "gemini-2.5-pro", AuthIndex: "auth-1",
		TimestampMS: at.UnixMilli(), Failed: failed, Generate: true,
		LatencyMS: 100, InputTokens: tokens.InputTokens, OutputTokens: tokens.OutputTokens,
		ReasoningTokens: tokens.ReasoningTokens, CachedTokens: tokens.CachedTokens,
		CacheReadTokens: tokens.CacheReadTokens, CacheCreationTokens: tokens.CacheCreationTokens,
		TotalTokens: tokens.TotalTokens,
	}
}

func TestUsageInboxRoundTrip(t *testing.T) {
	repo := usageTestRepository(t)
	ctx := context.Background()
	popped := time.Date(2026, 8, 31, 10, 0, 0, 0, time.UTC)

	written, err := repo.AppendUsageInbox(ctx, "default", "http_pull",
		[]string{`{"request_id":"a"}`, "", "null", `{"request_id":"b"}`}, popped)
	if err != nil {
		t.Fatal(err)
	}
	if written != 2 {
		t.Fatalf("blank and null payloads should be skipped, wrote %d", written)
	}

	pending, err := repo.PendingUsageInboxCount(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if pending != 2 {
		t.Fatalf("pending = %d, want 2", pending)
	}

	batch, err := repo.ClaimUsageInboxBatch(ctx, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(batch) != 2 || batch[0].RawMessage != `{"request_id":"a"}` {
		t.Fatalf("batch wrong: %#v", batch)
	}
	if batch[0].MessageHash != usage.Hash(`{"request_id":"a"}`) {
		t.Fatal("message hash not stored")
	}
	if batch[0].PoppedAtMS != popped.UnixMilli() {
		t.Fatalf("popped_at not stored: %d", batch[0].PoppedAtMS)
	}

	if err := repo.MarkUsageInboxProcessed(ctx, batch[0].ID, "a"); err != nil {
		t.Fatal(err)
	}
	pending, _ = repo.PendingUsageInboxCount(ctx)
	if pending != 1 {
		t.Fatalf("pending after processing = %d, want 1", pending)
	}
}

func TestUsageInboxDiscardsPoisonAfterRetries(t *testing.T) {
	repo := usageTestRepository(t)
	ctx := context.Background()
	if _, err := repo.AppendUsageInbox(ctx, "default", "subscribe", []string{`{"broken":`}, time.Now()); err != nil {
		t.Fatal(err)
	}
	batch, _ := repo.ClaimUsageInboxBatch(ctx, 5)
	if len(batch) != 1 {
		t.Fatalf("want one row, got %d", len(batch))
	}
	id := batch[0].ID

	for attempt := 1; attempt < maxInboxAttempts; attempt++ {
		if err := repo.MarkUsageInboxFailure(ctx, id, "decode usage payload: unexpected end of JSON input"); err != nil {
			t.Fatal(err)
		}
		// Still retryable: a poison row must not vanish before the budget is spent.
		pending, _ := repo.PendingUsageInboxCount(ctx)
		if pending != 1 {
			t.Fatalf("attempt %d: pending = %d, want 1", attempt, pending)
		}
	}
	if err := repo.MarkUsageInboxFailure(ctx, id, "still broken"); err != nil {
		t.Fatal(err)
	}
	pending, _ := repo.PendingUsageInboxCount(ctx)
	if pending != 0 {
		t.Fatalf("exhausted row should leave the working set, pending = %d", pending)
	}
	var status string
	if err := repo.SQL().QueryRowContext(ctx, `SELECT status FROM usage_inboxes WHERE id = ?`, id).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status != InboxDiscarded {
		t.Fatalf("status = %q, want %q", status, InboxDiscarded)
	}
	// The raw payload stays on disk for operator review.
	var raw string
	if err := repo.SQL().QueryRowContext(ctx, `SELECT raw_message FROM usage_inboxes WHERE id = ?`, id).Scan(&raw); err != nil {
		t.Fatal(err)
	}
	if raw != `{"broken":` {
		t.Fatalf("raw payload lost on discard: %q", raw)
	}
}

func TestUsageAnalyticsFromEventsWithoutRollup(t *testing.T) {
	repo := usageTestRepository(t)
	ctx := context.Background()
	base := time.Date(2026, 8, 31, 10, 5, 0, 0, time.UTC)

	events := []usage.Event{
		usageEventAt("default", "r1", base, usage.TokenStats{InputTokens: 10, OutputTokens: 5, TotalTokens: 15}, false),
		usageEventAt("default", "r2", base.Add(time.Minute), usage.TokenStats{InputTokens: 20, OutputTokens: 10, TotalTokens: 30}, true),
		usageEventAt("default", "r3", base.Add(70*time.Minute), usage.TokenStats{InputTokens: 1, OutputTokens: 1, TotalTokens: 2}, false),
	}
	if _, err := repo.InsertUsageEvents(ctx, events); err != nil {
		t.Fatal(err)
	}

	result, err := repo.QueryUsageAnalytics(ctx, "default",
		base.UnixMilli()-1000, base.Add(2*time.Hour).UnixMilli(), HourBucketMS)
	if err != nil {
		t.Fatal(err)
	}
	if result.Totals.Requests != 3 || result.Totals.Failures != 1 {
		t.Fatalf("totals wrong: %+v", result.Totals)
	}
	if result.Totals.TotalTokens != 47 {
		t.Fatalf("token sum wrong: %+v", result.Totals)
	}
	if result.FromRollup != 0 || result.FromEvents != 3 {
		t.Fatalf("with a zero checkpoint everything must come from events: %+v", result)
	}
	// Two hourly buckets: 10:00 holds r1+r2, 11:00 holds r3.
	if len(result.Buckets) != 2 {
		t.Fatalf("bucket count wrong: %#v", result.Buckets)
	}
	if result.Buckets[0].Requests != 2 || result.Buckets[1].Requests != 1 {
		t.Fatalf("bucket split wrong: %#v", result.Buckets)
	}
}

func TestUsageRollupAggregationIsIdempotent(t *testing.T) {
	repo := usageTestRepository(t)
	ctx := context.Background()
	base := time.Date(2026, 8, 31, 10, 0, 0, 0, time.UTC)

	events := make([]usage.Event, 0, 5)
	for i := 0; i < 5; i++ {
		events = append(events, usageEventAt("default", fmt.Sprintf("r%d", i),
			base.Add(time.Duration(i)*time.Minute),
			usage.TokenStats{InputTokens: 2, OutputTokens: 3, TotalTokens: 5}, i == 4))
	}
	if _, err := repo.InsertUsageEvents(ctx, events); err != nil {
		t.Fatal(err)
	}

	aggregated, err := repo.AggregateUsageGrain(ctx, CheckpointHourly, HourBucketMS, 100)
	if err != nil {
		t.Fatal(err)
	}
	if aggregated == 0 {
		t.Fatal("first pass should fold rows")
	}
	checkpoint, _ := repo.UsageCheckpoint(ctx, CheckpointHourly)
	if checkpoint == 0 {
		t.Fatal("checkpoint did not advance")
	}

	// A second pass over the same data must be a no-op, not a double count.
	if _, err := repo.AggregateUsageGrain(ctx, CheckpointHourly, HourBucketMS, 100); err != nil {
		t.Fatal(err)
	}
	var requests int64
	if err := repo.SQL().QueryRowContext(ctx, `SELECT COALESCE(SUM(requests),0) FROM usage_overview_hourly_stats`).Scan(&requests); err != nil {
		t.Fatal(err)
	}
	if requests != 5 {
		t.Fatalf("re-aggregation double counted: rollup requests = %d", requests)
	}
}

func TestUsageAnalyticsHybridCountsEachEventOnce(t *testing.T) {
	repo := usageTestRepository(t)
	ctx := context.Background()
	base := time.Date(2026, 8, 31, 10, 0, 0, 0, time.UTC)

	first := []usage.Event{
		usageEventAt("default", "old1", base, usage.TokenStats{InputTokens: 10, TotalTokens: 10}, false),
		usageEventAt("default", "old2", base.Add(20*time.Minute), usage.TokenStats{InputTokens: 20, TotalTokens: 20}, false),
	}
	if _, err := repo.InsertUsageEvents(ctx, first); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.AggregateUsageGrain(ctx, CheckpointHourly, HourBucketMS, 100); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.AggregateUsageGrain(ctx, CheckpointDaily, DayBucketMS, 100); err != nil {
		t.Fatal(err)
	}

	// Fresh events land in the same hourly bucket but are not aggregated yet.
	second := []usage.Event{
		usageEventAt("default", "new1", base.Add(40*time.Minute), usage.TokenStats{InputTokens: 30, TotalTokens: 30}, true),
		usageEventAt("default", "new2", base.Add(90*time.Minute), usage.TokenStats{InputTokens: 40, TotalTokens: 40}, false),
	}
	if _, err := repo.InsertUsageEvents(ctx, second); err != nil {
		t.Fatal(err)
	}

	result, err := repo.QueryUsageAnalytics(ctx, "default",
		base.UnixMilli(), base.Add(3*time.Hour).UnixMilli(), HourBucketMS)
	if err != nil {
		t.Fatal(err)
	}
	if result.Totals.Requests != 4 {
		t.Fatalf("hybrid window must count all four events once, got %d", result.Totals.Requests)
	}
	if result.Totals.TotalTokens != 100 {
		t.Fatalf("token sum wrong: %+v", result.Totals)
	}
	if result.FromRollup == 0 || result.FromEvents == 0 {
		t.Fatalf("expected a mixed rollup+detail answer: %+v", result)
	}
	if result.FromRollup+result.FromEvents != result.Totals.Requests {
		t.Fatalf("coverage accounting inconsistent: %+v", result)
	}
	// Buckets must be ordered and merged across both sources.
	if len(result.Buckets) != 2 {
		t.Fatalf("want two hourly buckets, got %#v", result.Buckets)
	}
	if result.Buckets[0].StartMS > result.Buckets[1].StartMS {
		t.Fatal("buckets not ordered")
	}
	if result.Buckets[0].Requests != 3 {
		t.Fatalf("10:00 bucket should merge rollup + tail, got %d", result.Buckets[0].Requests)
	}
}

func TestUsageAnalyticsLeftEdgePartialBucketIsNotDropped(t *testing.T) {
	repo := usageTestRepository(t)
	ctx := context.Background()
	base := time.Date(2026, 8, 31, 10, 0, 0, 0, time.UTC)

	events := []usage.Event{
		usageEventAt("default", "before", base, usage.TokenStats{TotalTokens: 7}, false),
		usageEventAt("default", "inside", base.Add(30*time.Minute), usage.TokenStats{TotalTokens: 11}, false),
	}
	if _, err := repo.InsertUsageEvents(ctx, events); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.AggregateUsageGrain(ctx, CheckpointHourly, HourBucketMS, 100); err != nil {
		t.Fatal(err)
	}

	// Window starts mid-bucket: the aggregated 10:00 row covers 10:00-10:59 as a
	// whole, so reading it would over-count and skipping it would lose "inside".
	result, err := repo.QueryUsageAnalytics(ctx, "default",
		base.Add(15*time.Minute).UnixMilli(), base.Add(time.Hour).UnixMilli(), HourBucketMS)
	if err != nil {
		t.Fatal(err)
	}
	if result.Totals.Requests != 1 || result.Totals.TotalTokens != 11 {
		t.Fatalf("partial leading bucket wrong: %+v", result.Totals)
	}
	if result.FromRollup != 0 {
		t.Fatalf("partial bucket must be served from the detail table, got %+v", result)
	}
}

func TestUsageRetentionRespectsAggregationWatermark(t *testing.T) {
	repo := usageTestRepository(t)
	ctx := context.Background()
	base := time.Date(2026, 8, 31, 10, 0, 0, 0, time.UTC)

	if _, err := repo.InsertUsageEvents(ctx, []usage.Event{
		usageEventAt("default", "old", base, usage.TokenStats{TotalTokens: 1}, false),
		usageEventAt("default", "new", base.Add(time.Hour), usage.TokenStats{TotalTokens: 1}, false),
	}); err != nil {
		t.Fatal(err)
	}
	// Nothing aggregated yet: the watermark is the oldest event, so a purge must
	// not delete data the rollup has not absorbed.
	deleted, err := repo.PurgeUsageOlderThan(ctx, base.Add(2*time.Hour).UnixMilli())
	if err != nil {
		t.Fatal(err)
	}
	if deleted != 0 {
		t.Fatalf("purge deleted unaggregated events: %d", deleted)
	}

	if _, err := repo.AggregateUsageGrain(ctx, CheckpointHourly, HourBucketMS, 100); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.AggregateUsageGrain(ctx, CheckpointDaily, DayBucketMS, 100); err != nil {
		t.Fatal(err)
	}
	deleted, err = repo.PurgeUsageOlderThan(ctx, base.Add(2*time.Hour).UnixMilli())
	if err != nil {
		t.Fatal(err)
	}
	if deleted != 2 {
		t.Fatalf("purge after aggregation should clear both rows, deleted %d", deleted)
	}
	var remaining int64
	if err := repo.SQL().QueryRowContext(ctx, `SELECT COUNT(1) FROM usage_events`).Scan(&remaining); err != nil {
		t.Fatal(err)
	}
	if remaining != 0 {
		t.Fatalf("events survived purge: %d", remaining)
	}
	// Rollup rows outside the horizon are removed with the details.
	if err := repo.SQL().QueryRowContext(ctx, `SELECT COUNT(1) FROM usage_overview_hourly_stats`).Scan(&remaining); err != nil {
		t.Fatal(err)
	}
	if remaining != 0 {
		t.Fatalf("hourly stats survived purge: %d", remaining)
	}
}

func TestErrorEventsAreIdempotent(t *testing.T) {
	repo := usageTestRepository(t)
	ctx := context.Background()
	event := usage.ErrorEvent{
		InstanceID: "default", EventKey: "err-abc", StatusCode: 429,
		Body: "resource exhausted", AuthIndex: "auth-1", QuotaExceeded: true,
		TimestampMS: time.Date(2026, 8, 31, 10, 0, 0, 0, time.UTC).UnixMilli(),
	}
	if err := repo.InsertErrorEvent(ctx, event); err != nil {
		t.Fatal(err)
	}
	// CPA can re-deliver; the hash-derived key must not duplicate the row.
	if err := repo.InsertErrorEvent(ctx, event); err != nil {
		t.Fatal(err)
	}
	var count int64
	if err := repo.SQL().QueryRowContext(ctx, `SELECT COUNT(1) FROM error_events`).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("error event duplicated: %d rows", count)
	}
}

func TestUsageCheckpointNeverRewinds(t *testing.T) {
	repo := usageTestRepository(t)
	ctx := context.Background()
	if err := repo.SetUsageCheckpoint(ctx, CheckpointHourly, 50); err != nil {
		t.Fatal(err)
	}
	if err := repo.SetUsageCheckpoint(ctx, CheckpointHourly, 10); err != nil {
		t.Fatal(err)
	}
	value, err := repo.UsageCheckpoint(ctx, CheckpointHourly)
	if err != nil {
		t.Fatal(err)
	}
	if value != 50 {
		t.Fatalf("checkpoint rewound to %d", value)
	}
	if err := repo.SetUsageCheckpoint(ctx, CheckpointHourly, 0); err != nil {
		t.Fatal(err)
	}
	if value, _ = repo.UsageCheckpoint(ctx, CheckpointHourly); value != 50 {
		t.Fatalf("zero must not move the checkpoint, got %d", value)
	}
}

func TestAggregateRejectsUnknownGrain(t *testing.T) {
	repo := usageTestRepository(t)
	if _, err := repo.AggregateUsageGrain(context.Background(), "weekly", HourBucketMS, 10); err == nil {
		t.Fatal("unknown grain must be rejected")
	}
}

func TestUsageAnalyticsValidatesWindow(t *testing.T) {
	repo := usageTestRepository(t)
	ctx := context.Background()
	if _, err := repo.QueryUsageAnalytics(ctx, "default", 100, 100, HourBucketMS); err == nil {
		t.Fatal("empty window rejected")
	}
	if _, err := repo.QueryUsageAnalytics(ctx, "default", 0, 100, 0); err == nil {
		t.Fatal("zero bucket width rejected")
	}
	var absent sql.NullInt64
	if err := repo.SQL().QueryRowContext(ctx, `SELECT MAX(id) FROM usage_events`).Scan(&absent); err != nil {
		t.Fatal(err)
	}
	if absent.Valid {
		t.Fatal("expected an empty detail table for this fixture")
	}
}
