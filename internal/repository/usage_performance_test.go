package repository

import (
	"context"
	"fmt"
	"path/filepath"
	"testing"
	"time"
)

func performanceRepository(tb testing.TB, n int) *Repository {
	tb.Helper()
	db, err := Open(context.Background(), filepath.Join(tb.TempDir(), "usage.db"))
	if err != nil {
		tb.Fatal(err)
	}
	tb.Cleanup(func() { _ = db.Close() })
	_, err = db.SQL.Exec(`INSERT INTO cpa_instances
        (id, name, base_url, usage_addr, management_key_ciphertext, management_key_nonce, status, created_at, updated_at)
        VALUES ('default','Default','http://localhost','localhost',x'00',x'00','ok',0,0)`)
	if err != nil {
		tb.Fatal(err)
	}
	_, err = db.SQL.Exec(`WITH RECURSIVE seq(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM seq WHERE n < ?)
        INSERT INTO usage_events (instance_id,event_key,api_group_key,timestamp_ms,created_at_ms)
        SELECT 'default', 'event-'||n, 'group', 1700000000000+n, 1700000000000 FROM seq`, n)
	if err != nil {
		tb.Fatal(err)
	}
	_, err = db.SQL.Exec(`INSERT INTO usage_inboxes (instance_id,source_mode,message_hash,raw_message,status,popped_at)
        SELECT instance_id, 'http_pull', event_key, '{}',
        CASE WHEN id % 3 = 0 THEN 'pending' WHEN id % 3 = 1 THEN 'processed' ELSE 'discarded' END, timestamp_ms
        FROM usage_events`)
	if err != nil {
		tb.Fatal(err)
	}
	return New(db)
}

func BenchmarkUsageStatus(b *testing.B) {
	for _, n := range []int{1000, 100000} {
		b.Run(fmt.Sprint(n), func(b *testing.B) {
			repo := performanceRepository(b, n)
			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				if _, err := repo.StatsUsagePipeline(context.Background()); err != nil {
					b.Fatal(err)
				}
			}
		})
	}
}

func BenchmarkUsageSpan(b *testing.B) {
	for _, n := range []int{1000, 100000} {
		b.Run(fmt.Sprint(n), func(b *testing.B) {
			repo := performanceRepository(b, n)
			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				if _, _, err := repo.UsageEventSpan(context.Background(), "default"); err != nil {
					b.Fatal(err)
				}
			}
		})
	}
}

func TestUsageStatusAndSpan(t *testing.T) {
	repo := performanceRepository(t, 9)
	ctx := context.Background()
	stats, err := repo.StatsUsagePipeline(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if stats.Events != 9 || stats.Pending != 3 || stats.Processed != 3 || stats.Discarded != 3 || stats.ErrorEvents != 0 {
		t.Fatalf("unexpected counts: %+v", stats)
	}
	first, last, err := repo.UsageEventSpan(ctx, "default")
	if err != nil || first != 1700000000001 || last != 1700000000009 {
		t.Fatalf("span %d %d: %v", first, last, err)
	}
	if stats.FirstEventMS == nil || stats.LastEventMS == nil || *stats.FirstEventMS != first || *stats.LastEventMS != last {
		t.Fatalf("stats span: %+v", stats)
	}
	first, last, err = repo.UsageEventSpan(ctx, "missing")
	if err != nil || first != 0 || last != 0 {
		t.Fatalf("missing span %d %d: %v", first, last, err)
	}
	if _, err := repo.SQL().Exec(`DELETE FROM usage_events; DELETE FROM usage_inboxes`); err != nil {
		t.Fatal(err)
	}
	stats, err = repo.StatsUsagePipeline(ctx)
	if err != nil || stats.Events != 0 || stats.FirstEventMS != nil || stats.LastEventMS != nil || stats.Pending != 0 {
		t.Fatalf("empty stats %+v: %v", stats, err)
	}
}

func BenchmarkUsageEventWindow(b *testing.B) {
	repo := performanceRepository(b, 100000)
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if _, err := repo.QueryUsageAnalytics(context.Background(), "default", 1700000000000, 1700000100000, 60000); err != nil {
			b.Fatal(err)
		}
	}
}

// BenchmarkUsageFacets tracks a 100k-row window; the strategy benchmark also
// exercises populated dimensions and high cardinality before accepting query changes.
func BenchmarkUsageFacets(b *testing.B) {
	repo := performanceRepository(b, 100000)
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if _, err := repo.GetUsageFacets(context.Background(), "default", 1700000000000, 1700100000000); err != nil {
			b.Fatal(err)
		}
	}
}

// BenchmarkUsageModelBuckets measures the dashboard's heaviest read in both shapes it takes: a
// grid finer than the fact grain, which has to bucket request records, and a grid on the fact
// grain after the fold, which reads the permanent facts. The second is what every window longer
// than a few hours pays, on every poll, so the gap between the two is the reason the facts exist.
func BenchmarkUsageModelBuckets(b *testing.B) {
	for _, n := range []int{1000, 100000} {
		for _, shape := range []struct {
			name     string
			bucketMS int64
			isFolded bool
		}{{"records", 60000, false}, {"facts", QuarterHourBucketMS, true}} {
			b.Run(fmt.Sprintf("%s/%d", shape.name, n), func(b *testing.B) {
				repo := performanceRepository(b, n)
				// The fixture writes one model for every event, so spread them over twenty to make
				// the grouping and the ranking do real work rather than collapsing to one group.
				if _, err := repo.SQL().Exec(`UPDATE usage_events SET model = 'model-' || (id % 20), timestamp_ms = 1700000000000 + id * 1000`); err != nil {
					b.Fatal(err)
				}
				for shape.isFolded {
					folded, err := repo.AggregateUsageFacts(context.Background(), 20000)
					if err != nil {
						b.Fatal(err)
					}
					if folded < 20000 {
						break
					}
				}
				b.ResetTimer()
				for i := 0; i < b.N; i++ {
					if _, err := repo.QueryUsageModelBuckets(context.Background(), "default",
						1700000000000, 1700100000000, shape.bucketMS, UsageModelBucketOptions{}); err != nil {
						b.Fatal(err)
					}
				}
			})
		}
	}
}

// BenchmarkUsageFactsCube reads the Insights cube - every dimension, on civil days -
// over ninety days of folded facts with forty live dimension combinations per
// quarter hour. UTC reads whole days from the daily table and Asia/Shanghai from the
// local-day grain, which the benchmark builds the way the fold loop would.
func BenchmarkUsageFactsCube(b *testing.B) {
	repo := performanceRepository(b, 0)
	const days = 90
	const combinations = 40
	fromMS := int64(1700006400000) // a UTC midnight
	for _, grain := range []struct {
		table    string
		bucketMS int64
	}{{usageFactsFineTable, QuarterHourBucketMS}, {usageFactsDailyTable, DayBucketMS}} {
		if _, err := repo.SQL().Exec(`
			WITH RECURSIVE buckets(start_ms) AS (
				SELECT ?1 UNION ALL SELECT start_ms + ?2 FROM buckets WHERE start_ms + ?2 < ?1 + ?3
			), combos(n) AS (
				SELECT 0 UNION ALL SELECT n + 1 FROM combos WHERE n + 1 < ?4
			)
			INSERT INTO `+grain.table+` (instance_id, bucket_start_ms, api_group_key, model, model_alias, auth_index,
				provider, auth_type, requests, input_tokens, output_tokens, total_tokens, cost_nanos, priced_requests, costed_requests)
			SELECT 'default', start_ms, 'hmac:key-' || (n % 20), 'model-' || (n % 8), 'alias-' || (n % 5),
				'auth-' || (n % 10), 'provider-' || (n % 3), 'oauth', 3, 300, 200, 500, 1000, 3, 3
			FROM buckets, combos`,
			fromMS, grain.bucketMS, int64(days)*DayBucketMS, combinations); err != nil {
			b.Fatal(err)
		}
	}
	if _, err := repo.SQL().Exec(`
		INSERT INTO usage_aggregation_checkpoints (name, last_usage_event_id, stats_updated_at_ms, created_at_ms, updated_at_ms)
		VALUES (?, 0, 0, 0, 0) ON CONFLICT(name) DO NOTHING`, CheckpointFacts); err != nil {
		b.Fatal(err)
	}
	shanghai, err := time.LoadLocation("Asia/Shanghai")
	if err != nil {
		b.Fatal(err)
	}
	repo.Timezone().Apply(shanghai)
	if _, err := repo.EnsureLocalUsageFacts(context.Background()); err != nil {
		b.Fatal(err)
	}
	dimensions := []UsageDimension{UsageDimensionKey, UsageDimensionCallPoint, UsageDimensionModel,
		UsageDimensionProvider, UsageDimensionCredential, UsageDimensionAuthType}
	for _, location := range []*time.Location{time.UTC, shanghai} {
		b.Run(location.String(), func(b *testing.B) {
			for i := 0; i < b.N; i++ {
				if _, err := repo.QueryUsageFacts(context.Background(), UsageFactQuery{
					InstanceID: "default", FromMS: fromMS, ToMS: fromMS + int64(days)*DayBucketMS - 1,
					Calendar: &UsageCalendar{Location: location, Unit: UsageCalendarDay}, Dimensions: dimensions,
				}); err != nil {
					b.Fatal(err)
				}
			}
		})
	}
}
