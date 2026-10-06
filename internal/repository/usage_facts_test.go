package repository

import (
	"context"
	"fmt"
	"math/rand"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/crypto"
)

// seedFactEvents writes request records with every dimension and measure the
// facts carry, spread over spanMS so a read crosses day and quarter-hour
// boundaries. Rows are inserted in random time order, as CPA delivers them.
func seedFactEvents(t *testing.T, repo *Repository, baseMS, spanMS int64, count int, seed int64) {
	t.Helper()
	random := rand.New(rand.NewSource(seed))
	models := []string{"alpha", "beta", "gamma"}
	aliases := []any{nil, "", "fast", "smart"}
	providers := []string{"codex", "", "claude"}
	authTypes := []string{"oauth", "apikey"}
	statuses := []string{"priced", "unpriced", "invalid_price"}
	for index := 0; index < count; index++ {
		status := statuses[random.Intn(len(statuses))]
		var cost any
		if status == "priced" {
			cost = random.Int63n(5_000_000)
		}
		var ttft any
		if random.Intn(3) > 0 {
			ttft = random.Int63n(900)
		}
		_, err := repo.SQL().Exec(`
			INSERT INTO usage_events (instance_id, event_key, api_group_key, provider, auth_type, model, model_alias,
				auth_index, timestamp_ms, failed, latency_ms, ttft_ms, input_tokens, output_tokens, reasoning_tokens,
				cached_tokens, cache_read_tokens, cache_creation_tokens, total_tokens, cost_nanos, pricing_status, created_at_ms)
			VALUES ('default', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
			fmt.Sprintf("event-%d-%d", seed, index), fmt.Sprintf("key-%d", random.Intn(2)),
			providers[random.Intn(len(providers))], authTypes[random.Intn(len(authTypes))],
			models[random.Intn(len(models))], aliases[random.Intn(len(aliases))], fmt.Sprintf("auth-%d", random.Intn(3)),
			baseMS+random.Int63n(spanMS), random.Intn(2), random.Int63n(4000), ttft,
			random.Int63n(1000), random.Int63n(1000), random.Int63n(100), random.Int63n(100), random.Int63n(100),
			random.Int63n(100), random.Int63n(3000), cost, status)
		if err != nil {
			t.Fatal(err)
		}
	}
}

// recordFacts answers a usage query from request records alone, which is the
// definition the facts have to reproduce.
func recordFacts(t *testing.T, repo *Repository, query UsageFactQuery) []UsageFactRow {
	t.Helper()
	expressions := usageFactGroupExpressions[query.GroupBy]
	aligned := "0"
	if query.BucketMS > 0 {
		aligned = fmt.Sprintf("(timestamp_ms / %d) * %d", query.BucketMS, query.BucketMS)
	}
	sums := make([]string, 0, len(usageFactMeasures))
	for _, measure := range usageFactMeasures {
		sums = append(sums, "SUM("+measure+")")
	}
	statement := `SELECT group_key, sub_group_key, aligned, ` + strings.Join(sums, ", ") + ` FROM (
		SELECT ` + expressions[0] + ` AS group_key, ` + expressions[1] + ` AS sub_group_key, ` + aligned + ` AS aligned, ` + usageEventMeasures + `
		FROM usage_events WHERE instance_id = ? AND timestamp_ms >= ? AND timestamp_ms <= ?`
	args := []any{query.InstanceID, query.FromMS, query.ToMS}
	if query.APIGroupKey != "" {
		statement += ` AND api_group_key = ?`
		args = append(args, query.APIGroupKey)
	}
	statement += `) GROUP BY group_key, sub_group_key, aligned ORDER BY group_key, sub_group_key, aligned`
	rows, err := repo.SQL().Query(statement, args...)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	result := []UsageFactRow{}
	for rows.Next() {
		var row UsageFactRow
		targets := append([]any{&row.Group, &row.SubGroup, &row.StartMS}, usageMeasureTargets(&row.UsageMeasures)...)
		if err := rows.Scan(targets...); err != nil {
			t.Fatal(err)
		}
		result = append(result, row)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return result
}

func factTestQueries(baseMS int64) []UsageFactQuery {
	queries := []UsageFactQuery{}
	windows := [][2]int64{
		{baseMS, baseMS + 4*DayBucketMS},                                       // whole days
		{baseMS + 7*60_000 + 13, baseMS + 3*DayBucketMS + 11*HourBucketMS + 5}, // every edge unaligned
		{baseMS + DayBucketMS + 3*HourBucketMS, baseMS + DayBucketMS + 9*HourBucketMS},
		{baseMS + 2*60_000, baseMS + 9*60_000}, // inside one fact bucket
	}
	for _, window := range windows {
		for _, bucketMS := range []int64{0, 60_000, QuarterHourBucketMS, HourBucketMS, DayBucketMS, 2 * DayBucketMS} {
			for _, grouping := range []UsageFactGrouping{UsageGroupNone, UsageGroupModel, UsageGroupCallPoint, UsageGroupProviderCredential} {
				queries = append(queries, UsageFactQuery{InstanceID: "default", FromMS: window[0], ToMS: window[1], BucketMS: bucketMS, GroupBy: grouping})
			}
			queries = append(queries, UsageFactQuery{InstanceID: "default", FromMS: window[0], ToMS: window[1], BucketMS: bucketMS, APIGroupKey: "key-1"})
		}
	}
	return queries
}

// The facts are only worth trusting if a read through them is indistinguishable
// from a read of the records they were folded from, at every fold depth and for
// every grouping, grid and window edge.
func TestUsageFactsMatchRequestRecordsAtEveryFoldDepth(t *testing.T) {
	repo := usageTestRepository(t)
	ctx := context.Background()
	baseMS := time.Date(2026, 8, 30, 0, 0, 0, 0, time.UTC).UnixMilli()
	seedFactEvents(t, repo, baseMS, 4*DayBucketMS, 600, 1)

	compare := func(stage string) {
		t.Helper()
		for _, query := range factTestQueries(baseMS) {
			got, err := repo.QueryUsageFacts(ctx, query)
			if err != nil {
				t.Fatalf("%s %+v: %v", stage, query, err)
			}
			want := recordFacts(t, repo, query)
			if !reflect.DeepEqual(got.Rows, want) {
				t.Fatalf("%s: facts disagree with request records for %+v\n got %d rows %+v\nwant %d rows %+v",
					stage, query, len(got.Rows), got.Totals(), len(want), UsageFactResult{Rows: want}.Totals())
			}
			if total := got.Totals().Requests; got.FactRequests+got.DetailRequests != total {
				t.Fatalf("%s: coverage %d+%d does not add up to %d", stage, got.FactRequests, got.DetailRequests, total)
			}
		}
	}

	compare("nothing folded")
	if folded, err := repo.AggregateUsageFacts(ctx, 250); err != nil || folded != 250 {
		t.Fatalf("first fold absorbed %d: %v", folded, err)
	}
	compare("partly folded")
	// Records that arrive after their bucket was folded, with timestamps all over
	// the already-folded range: the case a timestamp boundary counts twice.
	seedFactEvents(t, repo, baseMS, 4*DayBucketMS, 200, 2)
	// A dense cluster inside the quarter hours the unaligned windows start and
	// end in, so the sub-bucket edges hold folded and unfolded records at once.
	seedFactEvents(t, repo, baseMS, QuarterHourBucketMS, 40, 5)
	seedFactEvents(t, repo, baseMS+3*DayBucketMS+11*HourBucketMS, QuarterHourBucketMS, 40, 6)
	compare("late records behind the checkpoint")
	for {
		folded, err := repo.AggregateUsageFacts(ctx, 250)
		if err != nil {
			t.Fatal(err)
		}
		if folded == 0 {
			break
		}
	}
	compare("fully folded")

	// A fully folded window on the fact grid must not touch request records at all:
	// that is what keeps a multi-year window cheap.
	result, err := repo.QueryUsageFacts(ctx, UsageFactQuery{InstanceID: "default", FromMS: baseMS, ToMS: baseMS + 4*DayBucketMS - 1, BucketMS: DayBucketMS})
	if err != nil {
		t.Fatal(err)
	}
	if result.DetailRequests != 0 || result.FactRequests != 880 {
		t.Fatalf("aligned folded window read %d from facts and %d from records, want 880 and 0", result.FactRequests, result.DetailRequests)
	}
}

func TestUsageSurvivesTheDeletionOfItsRequestRecords(t *testing.T) {
	repo := usageTestRepository(t)
	ctx := context.Background()
	baseMS := time.Date(2026, 8, 30, 0, 0, 0, 0, time.UTC).UnixMilli()
	seedFactEvents(t, repo, baseMS, 4*DayBucketMS, 400, 3)
	for {
		folded, err := repo.AggregateUsageFacts(ctx, 1000)
		if err != nil {
			t.Fatal(err)
		}
		if folded == 0 {
			break
		}
	}

	// Read on whole fact buckets before anything is deleted: this is what the
	// widened windows below must still answer afterwards.
	whole := UsageFactQuery{InstanceID: "default", FromMS: baseMS, ToMS: baseMS + 4*DayBucketMS - 1, BucketMS: HourBucketMS, GroupBy: UsageGroupModel}
	before := recordFacts(t, repo, whole)
	alignedEdge := UsageFactQuery{InstanceID: "default", FromMS: baseMS + QuarterHourBucketMS, ToMS: baseMS + 4*DayBucketMS - 1, BucketMS: QuarterHourBucketMS}
	beforeEdge := recordFacts(t, repo, alignedEdge)

	horizonMS := baseMS + 2*DayBucketMS
	for pass := 0; pass < 2; pass++ {
		if _, err := repo.RunLifecycle(ctx, map[string]int64{LifecycleUsageDetail: horizonMS}, 100); err != nil {
			t.Fatal(err)
		}
	}
	var remaining, oldest int64
	if err := repo.SQL().QueryRow(`SELECT COUNT(1), COALESCE(MIN(timestamp_ms), 0) FROM usage_events`).Scan(&remaining, &oldest); err != nil {
		t.Fatal(err)
	}
	if remaining == 0 || remaining == 400 || oldest < horizonMS {
		t.Fatalf("retention left %d records, oldest %d, want only those from %d on", remaining, oldest, horizonMS)
	}

	after, err := repo.QueryUsageFacts(ctx, whole)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(after.Rows, before) {
		t.Fatalf("usage changed when its request records were deleted: %+v, want %+v", after.Totals(), UsageFactResult{Rows: before}.Totals())
	}

	// A window that starts mid-bucket behind the horizon cannot be split any more,
	// so it is widened to the bucket and says so, on a grid the facts can serve.
	ragged, err := repo.QueryUsageFacts(ctx, UsageFactQuery{InstanceID: "default", FromMS: baseMS + QuarterHourBucketMS + 4*60_000, ToMS: baseMS + 4*DayBucketMS - 1, BucketMS: 60_000})
	if err != nil {
		t.Fatal(err)
	}
	if ragged.FromMS != baseMS+QuarterHourBucketMS || ragged.BucketMS != QuarterHourBucketMS {
		t.Fatalf("window behind the horizon read as from %d on a %d grid, want %d on %d", ragged.FromMS, ragged.BucketMS, baseMS+QuarterHourBucketMS, QuarterHourBucketMS)
	}
	if !reflect.DeepEqual(ragged.Rows, beforeEdge) {
		t.Fatalf("widened window lost usage: %+v, want %+v", ragged.Totals(), UsageFactResult{Rows: beforeEdge}.Totals())
	}

	first, err := repo.FirstUsageRecordMS(ctx, "default")
	if err != nil || first == nil || *first >= horizonMS {
		t.Fatalf("first usage %v must still reach behind the deleted records: %v", first, err)
	}
}

func TestFoldIsExactUnderRepetition(t *testing.T) {
	repo := usageTestRepository(t)
	ctx := context.Background()
	baseMS := time.Date(2026, 8, 30, 0, 0, 0, 0, time.UTC).UnixMilli()
	seedFactEvents(t, repo, baseMS, 4*DayBucketMS, 120, 4)
	for pass := 0; pass < 5; pass++ {
		if _, err := repo.AggregateUsageFacts(ctx, 50); err != nil {
			t.Fatal(err)
		}
	}
	for _, table := range []string{usageFactsFineTable, usageFactsDailyTable} {
		var requests, costNanos, wantCost int64
		if err := repo.SQL().QueryRow(`SELECT SUM(requests), SUM(cost_nanos) FROM `+table).Scan(&requests, &costNanos); err != nil {
			t.Fatal(err)
		}
		if err := repo.SQL().QueryRow(`SELECT SUM(COALESCE(cost_nanos, 0)) FROM usage_events`).Scan(&wantCost); err != nil {
			t.Fatal(err)
		}
		if requests != 120 || costNanos != wantCost {
			t.Fatalf("%s holds %d requests and %d cost, want 120 and %d", table, requests, costNanos, wantCost)
		}
	}
}

func TestEncryptedInboxKeepsOnePayloadCopy(t *testing.T) {
	cipher, err := crypto.New("01234567890123456789012345678901")
	if err != nil {
		t.Fatal(err)
	}
	db, err := Open(context.Background(), fmt.Sprintf("file:memdb_usage_%d?mode=memory&cache=shared", usageDSNCounter.Add(1)), WithCipher(cipher))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	repo := New(db)
	if _, err := db.SQL.Exec(`INSERT INTO cpa_instances (id, name, base_url, usage_addr, management_key_ciphertext, management_key_nonce, status, created_at, updated_at)
		VALUES ('default', 'Default', 'http://127.0.0.1:8317', '127.0.0.1:8317', x'00', x'00', 'unknown', 0, 0)`); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	payload := `{"request_id":"r1","api_key":"sk-live-secret"}`
	if _, err := repo.AppendUsageInbox(ctx, "default", "subscribe", []string{payload}, time.UnixMilli(1000)); err != nil {
		t.Fatal(err)
	}
	var stored string
	if err := db.SQL.QueryRow(`SELECT raw_message FROM usage_inboxes`).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	if stored != "" {
		t.Fatalf("a second, plaintext copy of the payload was stored: %q", stored)
	}
	batch, err := repo.ClaimUsageInboxBatch(ctx, 10)
	if err != nil || len(batch) != 1 || batch[0].RawMessage != payload {
		t.Fatalf("decoder must still receive the original payload, got %+v: %v", batch, err)
	}
}
