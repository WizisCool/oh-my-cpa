package repository

import (
	"context"
	"fmt"
	"math/rand"
	"reflect"
	"slices"
	"sort"
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

// recordFacts answers a usage query from request records alone, in Go, which is
// the definition the facts have to reproduce. It shares nothing with the SQL the
// read compiles to: dimensions, filters and civil buckets are all derived here.
func recordFacts(t *testing.T, repo *Repository, query UsageFactQuery) []UsageFactRow {
	t.Helper()
	rows, err := repo.SQL().Query(`
		SELECT api_group_key, model, COALESCE(model_alias, ''), auth_index, provider, auth_type, timestamp_ms,
		       failed, input_tokens, output_tokens, reasoning_tokens, cached_tokens, cache_read_tokens,
		       cache_creation_tokens, total_tokens, latency_ms, ttft_ms, cost_nanos, pricing_status
		FROM usage_events WHERE instance_id = ? AND timestamp_ms >= ? AND timestamp_ms <= ?`,
		query.InstanceID, query.FromMS, query.ToMS)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	grouped := map[string]*UsageFactRow{}
	for rows.Next() {
		var key, model, alias, authIndex, provider, authType, status string
		var timestampMS int64
		var failed int64
		var measures UsageMeasures
		var ttft, cost *int64
		if err := rows.Scan(&key, &model, &alias, &authIndex, &provider, &authType, &timestampMS, &failed,
			&measures.InputTokens, &measures.OutputTokens, &measures.ReasoningTokens, &measures.CachedTokens,
			&measures.CacheReadTokens, &measures.CacheCreationTokens, &measures.TotalTokens, &measures.LatencySumMS,
			&ttft, &cost, &status); err != nil {
			t.Fatal(err)
		}
		values := map[UsageDimension]string{
			UsageDimensionKey: key, UsageDimensionModel: model, UsageDimensionAuthType: authType,
			UsageDimensionCallPoint: model, UsageDimensionProvider: "unknown",
			UsageDimensionCredential: strings.TrimSpace(authIndex),
		}
		if trimmed := strings.TrimSpace(alias); trimmed != "" {
			values[UsageDimensionCallPoint] = trimmed
		}
		if trimmed := strings.TrimSpace(provider); trimmed != "" {
			values[UsageDimensionProvider] = trimmed
		}
		if authType == "apikey" {
			values[UsageDimensionServingKey] = strings.TrimSpace(authIndex)
		}
		isKept := true
		for dimension, wanted := range query.Filters {
			if len(wanted) > 0 && !slices.Contains(wanted, values[dimension]) {
				isKept = false
			}
		}
		if !isKept {
			continue
		}
		measures.Requests, measures.Failures = 1, failed
		if ttft != nil {
			measures.TTFTSumMS, measures.TTFTCount = *ttft, 1
		}
		if cost != nil {
			measures.CostNanos, measures.CostedRequests = *cost, 1
		}
		if status == "priced" {
			measures.PricedRequests = 1
		}
		var startMS int64
		switch {
		case query.Calendar != nil:
			startMS = calendarBucketStart(timestampMS, *query.Calendar)
		case query.BucketMS > 0:
			startMS = timestampMS / query.BucketMS * query.BucketMS
		}
		keys := make([]string, len(query.Dimensions))
		for index, dimension := range query.Dimensions {
			keys[index] = values[dimension]
		}
		id := fmt.Sprintf("%q/%d", keys, startMS)
		row, ok := grouped[id]
		if !ok {
			row = &UsageFactRow{Keys: keys, StartMS: startMS}
			grouped[id] = row
		}
		row.UsageMeasures.add(measures)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	result := make([]UsageFactRow, 0, len(grouped))
	for _, row := range grouped {
		result = append(result, *row)
	}
	sort.Slice(result, func(left, right int) bool {
		for index := range result[left].Keys {
			if result[left].Keys[index] != result[right].Keys[index] {
				return result[left].Keys[index] < result[right].Keys[index]
			}
		}
		return result[left].StartMS < result[right].StartMS
	})
	return result
}

// calendarBucketStart is the local hour, day or Monday-first week holding an instant.
func calendarBucketStart(timestampMS int64, calendar UsageCalendar) int64 {
	local := time.UnixMilli(timestampMS).In(calendar.Location)
	switch calendar.Unit {
	case UsageCalendarHour:
		return time.Date(local.Year(), local.Month(), local.Day(), local.Hour(), 0, 0, 0, calendar.Location).UnixMilli()
	case UsageCalendarDay:
		return time.Date(local.Year(), local.Month(), local.Day(), 0, 0, 0, 0, calendar.Location).UnixMilli()
	default:
		daysSinceMonday := (int(local.Weekday()) + 6) % 7
		return time.Date(local.Year(), local.Month(), local.Day()-daysSinceMonday, 0, 0, 0, 0, calendar.Location).UnixMilli()
	}
}

var factTestPartitions = [][]UsageDimension{
	nil,
	{UsageDimensionModel},
	{UsageDimensionCallPoint},
	{UsageDimensionProvider, UsageDimensionServingKey},
	{UsageDimensionKey, UsageDimensionCallPoint, UsageDimensionModel, UsageDimensionProvider, UsageDimensionCredential, UsageDimensionAuthType},
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
			for _, dimensions := range factTestPartitions {
				queries = append(queries, UsageFactQuery{InstanceID: "default", FromMS: window[0], ToMS: window[1], BucketMS: bucketMS, Dimensions: dimensions})
			}
			queries = append(queries, UsageFactQuery{InstanceID: "default", FromMS: window[0], ToMS: window[1], BucketMS: bucketMS, Filters: ClientKeyFilter("key-1")})
			queries = append(queries, UsageFactQuery{InstanceID: "default", FromMS: window[0], ToMS: window[1], BucketMS: bucketMS,
				Dimensions: []UsageDimension{UsageDimensionKey},
				Filters:    map[UsageDimension][]string{UsageDimensionCallPoint: {"fast", "gamma"}, UsageDimensionCredential: {"auth-0", "auth-2"}}})
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
	whole := UsageFactQuery{InstanceID: "default", FromMS: baseMS, ToMS: baseMS + 4*DayBucketMS - 1, BucketMS: HourBucketMS, Dimensions: []UsageDimension{UsageDimensionModel}}
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

// A restored database can carry a local-grain marker for a zone this image's
// tzdata does not know. It is derived state, so it must not stall the primary fold.
func TestUnknownLocalGrainZoneDoesNotBlockFactsFold(t *testing.T) {
	repo := usageTestRepository(t)
	ctx := context.Background()
	seedFactEvents(t, repo, time.Date(2026, 10, 21, 0, 0, 0, 0, time.UTC).UnixMilli(), HourBucketMS, 1, 91)
	if _, err := repo.SQL().Exec(`
		INSERT INTO usage_aggregation_checkpoints (name, last_usage_event_id, stats_updated_at_ms, created_at_ms, updated_at_ms)
		VALUES ('facts_local:Not/AZone', 0, 0, 0, 0);
		INSERT INTO usage_facts_local_daily (instance_id, zone, day_wall_ms) VALUES ('default', 'Not/AZone', 0)`); err != nil {
		t.Fatal(err)
	}

	folded, err := repo.AggregateUsageFacts(ctx, 10)
	if err != nil {
		t.Fatalf("an unknown local-grain zone blocked the primary fold: %v", err)
	}
	if folded != 1 {
		t.Fatalf("folded %d records, want 1", folded)
	}
	var checkpoint int64
	if err := repo.SQL().QueryRow(`SELECT last_usage_event_id FROM usage_aggregation_checkpoints WHERE name = ?`, CheckpointFacts).Scan(&checkpoint); err != nil {
		t.Fatal(err)
	}
	var localRows, localMarkers int
	if err := repo.SQL().QueryRow(`SELECT (SELECT COUNT(1) FROM usage_facts_local_daily), (SELECT COUNT(1) FROM usage_aggregation_checkpoints WHERE name LIKE ?)`,
		localFactsMarkerPrefix+"%").Scan(&localRows, &localMarkers); err != nil {
		t.Fatal(err)
	}
	if checkpoint == 0 || localRows != 0 || localMarkers != 0 {
		t.Fatalf("checkpoint %d, stale local rows %d, stale markers %d", checkpoint, localRows, localMarkers)
	}

	// The periodic rebuild must treat the same marker as unbuilt rather than
	// refusing forever to replace it.
	repo.Timezone().Apply(time.UTC)
	if _, err := repo.SQL().Exec(`INSERT INTO usage_aggregation_checkpoints (name, last_usage_event_id, stats_updated_at_ms, created_at_ms, updated_at_ms)
		VALUES ('facts_local:Not/AZone', 0, 0, 0, 0)`); err != nil {
		t.Fatal(err)
	}
	if rebuilt, err := repo.EnsureLocalUsageFacts(ctx); err != nil || !rebuilt {
		t.Fatalf("unknown local-grain marker rebuilt %v: %v", rebuilt, err)
	}
	var zoneMarker string
	if err := repo.SQL().QueryRow(`SELECT name FROM usage_aggregation_checkpoints WHERE name LIKE ? ORDER BY name LIMIT 1`,
		localFactsMarkerPrefix+"%").Scan(&zoneMarker); err != nil {
		t.Fatal(err)
	}
	if zoneMarker != localFactsMarkerPrefix+"UTC" {
		t.Fatalf("rebuilt marker is %q", zoneMarker)
	}
}

// A civil bucket must be the reader's local hour, day or week however the zone
// moved during the window: New York's day of the autumn change is 25 hours, and
// Kathmandu's +05:45 puts every local midnight on a quarter hour.
func TestCalendarBucketsFollowTheWallClock(t *testing.T) {
	repo := usageTestRepository(t)
	ctx := context.Background()
	newYork, err := time.LoadLocation("America/New_York")
	if err != nil {
		t.Fatal(err)
	}
	kathmandu, err := time.LoadLocation("Asia/Kathmandu")
	if err != nil {
		t.Fatal(err)
	}
	baseMS := time.Date(2026, 10, 29, 0, 0, 0, 0, time.UTC).UnixMilli()
	spanMS := 6 * DayBucketMS
	seedFactEvents(t, repo, baseMS, spanMS, 700, 11)

	windows := [][2]int64{
		{baseMS, baseMS + spanMS - 1},
		{baseMS + 7*60_000 + 3, baseMS + spanMS - 11*60_000},
	}
	compare := func(stage string) {
		t.Helper()
		for _, window := range windows {
			for _, location := range []*time.Location{time.UTC, newYork, kathmandu} {
				for _, unit := range []UsageCalendarUnit{UsageCalendarHour, UsageCalendarDay, UsageCalendarWeek} {
					for _, dimensions := range factTestPartitions[:3] {
						query := UsageFactQuery{InstanceID: "default", FromMS: window[0], ToMS: window[1],
							Calendar: &UsageCalendar{Location: location, Unit: unit}, Dimensions: dimensions}
						got, err := repo.QueryUsageFacts(ctx, query)
						if err != nil {
							t.Fatalf("%s %s %s: %v", stage, location, unit, err)
						}
						if want := recordFacts(t, repo, query); !reflect.DeepEqual(got.Rows, want) {
							t.Fatalf("%s: %s %s buckets disagree with request records\n got %d rows %+v\nwant %d rows %+v",
								stage, location, unit, len(got.Rows), got.Totals(), len(want), UsageFactResult{Rows: want}.Totals())
						}
					}
				}
			}
		}
	}
	compare("nothing folded")
	if _, err := repo.AggregateUsageFacts(ctx, 300); err != nil {
		t.Fatal(err)
	}
	seedFactEvents(t, repo, baseMS, spanMS, 150, 12)
	compare("partly folded with late records")
	for {
		folded, err := repo.AggregateUsageFacts(ctx, 500)
		if err != nil {
			t.Fatal(err)
		}
		if folded == 0 {
			break
		}
	}
	compare("fully folded")

	// The local-day grain answers whole local days once it is built, for whichever
	// zone it was built for, and keeps agreeing as later batches fold into it.
	for index, location := range []*time.Location{newYork, kathmandu} {
		repo.Timezone().Apply(location)
		if rebuilt, err := repo.EnsureLocalUsageFacts(ctx); err != nil || !rebuilt {
			t.Fatalf("local grain for %s rebuilt %v: %v", location, rebuilt, err)
		}
		if rebuilt, err := repo.EnsureLocalUsageFacts(ctx); err != nil || rebuilt {
			t.Fatalf("local grain for %s rebuilt twice: %v", location, err)
		}
		compare("local grain built for " + location.String())
		seedFactEvents(t, repo, baseMS, spanMS, 120, int64(20+index))
		compare("local grain with unfolded records")
		for {
			folded, err := repo.AggregateUsageFacts(ctx, 70)
			if err != nil {
				t.Fatal(err)
			}
			if folded == 0 {
				break
			}
		}
		compare("local grain after more folds")
	}

	// The local day of the change is one 25-hour bucket.
	dayOfChange := time.Date(2026, 11, 1, 0, 0, 0, 0, newYork).UnixMilli()
	nextDay := time.Date(2026, 11, 2, 0, 0, 0, 0, newYork).UnixMilli()
	days, err := repo.QueryUsageFacts(ctx, UsageFactQuery{InstanceID: "default", FromMS: dayOfChange, ToMS: nextDay + DayBucketMS - 1,
		Calendar: &UsageCalendar{Location: newYork, Unit: UsageCalendarDay}})
	if err != nil {
		t.Fatal(err)
	}
	if len(days.Rows) != 2 || days.Rows[0].StartMS != dayOfChange || days.Rows[1].StartMS-days.Rows[0].StartMS != 25*HourBucketMS {
		t.Fatalf("day buckets across the change are %+v, want starts %d and %d", days.Rows, dayOfChange, nextDay)
	}

	// On a zone with no offset the daily table still answers whole days, so a long
	// calendar window stays as cheap as an epoch one.
	utcDays, err := repo.QueryUsageFacts(ctx, UsageFactQuery{InstanceID: "default", FromMS: baseMS, ToMS: baseMS + spanMS - 1,
		Calendar: &UsageCalendar{Location: time.UTC, Unit: UsageCalendarWeek}})
	if err != nil {
		t.Fatal(err)
	}
	if utcDays.DetailRequests != 0 {
		t.Fatalf("a folded UTC calendar read took %d requests from records, want none", utcDays.DetailRequests)
	}
}
