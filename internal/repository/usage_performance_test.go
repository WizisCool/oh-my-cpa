package repository

import (
	"context"
	"fmt"
	"path/filepath"
	"testing"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/pricing"
	"github.com/oh-my-cpa/oh-my-cpa/internal/usage"
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

func BenchmarkCommitUsageDecoded(b *testing.B) {
	ctx := context.Background()
	repo := performanceRepository(b, 0)
	if err := repo.UpsertModelPrices(ctx, []pricing.ModelPrice{
		{Model: "gpt-5", PromptPricePer1M: 1.25, CompletionPer1M: 10, CacheReadPer1M: 0.125, CacheWritePer1M: 1.25, PriceMultiplier: 1, Source: pricing.SourceOpenRouter},
		{Model: "claude-sonnet-4-5", PromptPricePer1M: 3, CompletionPer1M: 15, CacheReadPer1M: 0.3, CacheWritePer1M: 3.75, PriceMultiplier: 1, Source: pricing.SourceOpenRouter},
	}); err != nil {
		b.Fatal(err)
	}
	if err := repo.UpsertChannelMultiplier(ctx, pricing.ChannelMultiplier{Channel: "codex", Multiplier: 0.8}); err != nil {
		b.Fatal(err)
	}
	const batchSize = 200
	payloads := make([]string, batchSize)
	for i := range payloads {
		payloads[i] = `{"request_id":"req"}`
	}
	accounting := &usage.TokenAccounting{
		Version: 2,
		Status:  "complete",
		RawTokens: usage.TokenStats{
			InputTokens:  1200,
			OutputTokens: 300,
			TotalTokens:  1500,
		},
	}
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		b.StopTimer()
		if _, err := repo.AppendUsageInbox(ctx, "default", "subscribe", payloads, time.UnixMilli(1700000000000)); err != nil {
			b.Fatal(err)
		}
		inbox, err := repo.ClaimUsageInboxBatch(ctx, batchSize)
		if err != nil || len(inbox) != batchSize {
			b.Fatalf("claim batch: len=%d err=%v", len(inbox), err)
		}
		decoded := make([]UsageDecoded, batchSize)
		for idx, item := range inbox {
			model := "gpt-5"
			provider := "codex"
			if idx%2 == 1 {
				model = "claude-sonnet-4-5"
				provider = "claude"
			}
			decoded[idx] = UsageDecoded{
				InboxID: item.ID,
				Event: usage.Event{
					InstanceID:      "default",
					EventKey:        fmt.Sprintf("ev-%d-%d", i, idx),
					RequestID:       fmt.Sprintf("req-%d-%d", i, idx),
					APIGroupKey:     fmt.Sprintf("hmac:key-%d", idx%10),
					APIGroupLabel:   "api_key",
					APIKeyMask:      "sk-••••1234",
					Provider:        provider,
					AuthType:        "apikey",
					AuthIndex:       fmt.Sprintf("auth-%d", idx%6),
					Model:           model,
					TimestampMS:     1700000000000 + int64(i*batchSize+idx)*100,
					Generate:        true,
					LatencyMS:       420,
					InputTokens:     1000,
					CacheReadTokens: 200,
					OutputTokens:    300,
					TotalTokens:     1500,
					Accounting:      accounting,
				},
			}
		}
		b.StartTimer()
		if committed, err := repo.CommitUsageDecoded(ctx, decoded); err != nil || committed != batchSize {
			b.Fatalf("commit decoded: committed=%d err=%v", committed, err)
		}
	}
}

func BenchmarkAggregateUsageFacts(b *testing.B) {
	ctx := context.Background()
	shanghai, err := time.LoadLocation("Asia/Shanghai")
	if err != nil {
		b.Fatal(err)
	}
	const batchSize = 20000
	repo := performanceRepository(b, 0)
	repo.Timezone().Apply(shanghai)
	if _, err := repo.EnsureLocalUsageFacts(ctx); err != nil {
		b.Fatal(err)
	}
	if _, err := repo.SQL().Exec(`
		WITH RECURSIVE seq(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM seq WHERE n <= ?)
		INSERT INTO usage_events (
			instance_id, event_key, api_group_key, model, model_alias, auth_index, provider, auth_type,
			timestamp_ms, created_at_ms, input_tokens, output_tokens, total_tokens, cost_nanos, pricing_status, token_accounting
		)
		SELECT 'default', 'ev-' || n, 'hmac:key-' || (n % 20), 'model-' || (n % 12),
			CASE WHEN n % 3 = 0 THEN 'fast' ELSE NULL END, 'auth-' || (n % 8), 'provider-' || (n % 4), 'apikey',
			1700006400000 + n * 3000, 1700006400000, 1000, 250, 1250, 500000, 'priced',
			'{"version":2,"status":"complete","raw_tokens":{"input_tokens":1000,"output_tokens":250,"total_tokens":1250}}'
		FROM seq`, batchSize); err != nil {
		b.Fatal(err)
	}
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		b.StopTimer()
		if _, err := repo.SQL().Exec(`
			DELETE FROM usage_facts_15m;
			DELETE FROM usage_facts_daily;
			DELETE FROM usage_facts_local_daily;
			UPDATE usage_aggregation_checkpoints SET last_usage_event_id = 0 WHERE name = ?`, CheckpointFacts); err != nil {
			b.Fatal(err)
		}
		b.StartTimer()
		folded, err := repo.AggregateUsageFacts(ctx, batchSize)
		if err != nil || folded != batchSize {
			b.Fatalf("folded=%d err=%v", folded, err)
		}
	}
}

func BenchmarkListUsageEventsWithArrivedCount(b *testing.B) {
	ctx := context.Background()
	const n = 100000
	repo := performanceRepository(b, n)
	if _, err := repo.SQL().Exec(`
		UPDATE usage_events
		SET api_group_key = 'hmac:key-' || (id % 20),
		    api_group_label = 'api_key',
		    api_key_mask = 'sk-••••1234',
		    model = 'model-' || (id % 12),
		    provider = 'provider-' || (id % 4),
		    auth_index = 'auth-' || (id % 16),
		    timestamp_ms = 1700000000000 + id * 500`); err != nil {
		b.Fatal(err)
	}
	for idx := 0; idx < 64; idx++ {
		if _, err := repo.SQL().Exec(`
			INSERT INTO discovered_resources (
				id, instance_id, resource_key, cpa_resource_type, cpa_auth_index, cpa_resource_name,
				cpa_driver, protocol_driver, protocol_display, status, last_seen_at, created_at, updated_at
			) VALUES (?, 'default', ?, 'auth_file', ?, ?, 'codex', 'codex', 'Codex', 'triaged', 0, 0, 0)`,
			fmt.Sprintf("res-%d", idx), fmt.Sprintf("key-%d", idx), fmt.Sprintf("auth-%d", idx), fmt.Sprintf("cred-%d.json", idx)); err != nil {
			b.Fatal(err)
		}
	}
	filter := UsageEventFilter{
		InstanceID: "default",
		FromMS:     1700000000000,
		ToMS:       1700060000000,
		SinceID:    int64(n - 5),
		Limit:      100,
	}
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		page, err := repo.ListUsageEvents(ctx, filter)
		if err != nil || len(page.Items) != 100 || page.ArrivedCount != 5 {
			b.Fatalf("items=%d arrived=%d err=%v", len(page.Items), page.ArrivedCount, err)
		}
	}
}

func BenchmarkClientKeyMasksFor(b *testing.B) {
	ctx := context.Background()
	const n = 100000
	repo := performanceRepository(b, n)
	if _, err := repo.SQL().Exec(`
		UPDATE usage_events
		SET api_group_key = 'hmac:key-' || (id % 20),
		    api_group_label = 'api_key',
		    api_key_mask = 'sk-••••' || printf('%04d', id % 20),
		    timestamp_ms = 1700000000000 + id * 500`); err != nil {
		b.Fatal(err)
	}
	fingerprints := make([]string, 20)
	for i := range fingerprints {
		fingerprints[i] = fmt.Sprintf("hmac:key-%d", i)
	}
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		masks, err := repo.ClientKeyMasksFor(ctx, "default", fingerprints)
		if err != nil || len(masks) != 20 {
			b.Fatalf("masks=%d err=%v", len(masks), err)
		}
	}
}

func BenchmarkPricingUsage(b *testing.B) {
	ctx := context.Background()
	const n = 100000
	repo := performanceRepository(b, 0)
	fromMS := int64(1700006400000)
	if _, err := repo.SQL().Exec(`
		WITH RECURSIVE seq(k) AS (VALUES(1) UNION ALL SELECT k+1 FROM seq WHERE k <= ?)
		INSERT INTO usage_events (instance_id, event_key, api_group_key, model, provider, timestamp_ms, created_at_ms, cost_nanos, pricing_status)
		SELECT 'default', 'event-'||k, 'group', 'model-'||(k%25), 'provider-'||(k%6),
			? + k * 20000, 1700000000000,
			CASE WHEN k % 5 = 0 THEN NULL ELSE 250000 END,
			CASE WHEN k % 5 = 0 THEN 'unpriced' ELSE 'priced' END
		FROM seq`, n, fromMS); err != nil {
		b.Fatal(err)
	}
	// Fold all but the newest 500 records so the database matches normal steady-state operation.
	for {
		folded, err := repo.AggregateUsageFacts(ctx, 20000)
		if err != nil {
			b.Fatal(err)
		}
		if folded < 20000 {
			break
		}
	}
	if _, err := repo.SQL().Exec(`
		WITH RECURSIVE seq(k) AS (VALUES(1) UNION ALL SELECT k+1 FROM seq WHERE k <= 500)
		INSERT INTO usage_events (instance_id, event_key, api_group_key, model, provider, timestamp_ms, created_at_ms, cost_nanos, pricing_status)
		SELECT 'default', 'tail-'||k, 'group', 'model-'||(k%25), 'provider-'||(k%6), ? + (? + k) * 20000, 1700000000000, 250000, 'priced'
		FROM seq`, fromMS, n); err != nil {
		b.Fatal(err)
	}
	querySince := fromMS + 3*DayBucketMS + 7*60*1000 // non-midnight 30d rolling cutoff
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		byModel, err := repo.QueryPricingUsageByModel(ctx, querySince)
		if err != nil || len(byModel) != 25 {
			b.Fatalf("byModel=%d err=%v", len(byModel), err)
		}
		byChannel, err := repo.QueryPricingUsageByChannel(ctx, querySince)
		if err != nil || len(byChannel) != 6 {
			b.Fatalf("byChannel=%d err=%v", len(byChannel), err)
		}
	}
}
