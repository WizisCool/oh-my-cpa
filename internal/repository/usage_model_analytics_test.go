package repository

import (
	"context"
	"testing"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/usage"
)

// modelEventAt is `usageEventAt` with the model chosen, which is the whole point of this
// suite: the shared helper hardcodes one model, so every row would land in a single group.
func modelEventAt(instanceID, id, model string, at time.Time, totalTokens int64) usage.Event {
	event := usageEventAt(instanceID, id, at, usage.TokenStats{InputTokens: totalTokens, TotalTokens: totalTokens}, false)
	event.Model = model
	return event
}

func insertModelEvent(t *testing.T, repo *Repository, id, model string, at time.Time, totalTokens int64) {
	t.Helper()
	if _, err := repo.InsertUsageEvents(context.Background(), []usage.Event{
		modelEventAt("default", id, model, at, totalTokens),
	}); err != nil {
		t.Fatal(err)
	}
}

func TestQueryUsageModelBucketsGroupsByModelAndBucket(t *testing.T) {
	repo := usageTestRepository(t)
	base := time.Date(2026, 9, 14, 10, 0, 0, 0, time.UTC)
	// Two models, two buckets, so a query that collapsed either dimension fails.
	insertModelEvent(t, repo, "m-1", "alpha", base, 10)
	insertModelEvent(t, repo, "m-2", "alpha", base.Add(time.Minute), 20)
	insertModelEvent(t, repo, "m-3", "beta", base, 5)
	insertModelEvent(t, repo, "m-4", "beta", base.Add(2*time.Minute), 7)

	rows, err := repo.QueryUsageModelBuckets(context.Background(), "default",
		base.UnixMilli(), base.Add(2*time.Minute).UnixMilli(), time.Minute.Milliseconds())
	if err != nil {
		t.Fatal(err)
	}
	type key struct {
		model  string
		bucket int64
	}
	got := map[key]int64{}
	for _, row := range rows {
		got[key{row.Model, row.StartMS}] += row.Tokens
	}
	want := map[key]int64{
		{"alpha", base.UnixMilli()}:                     10,
		{"alpha", base.Add(time.Minute).UnixMilli()}:    20,
		{"beta", base.UnixMilli()}:                      5,
		{"beta", base.Add(2 * time.Minute).UnixMilli()}: 7,
	}
	if len(got) != len(want) {
		t.Fatalf("got %d (model, bucket) rows, want %d: %#v", len(got), len(want), got)
	}
	for entry, tokens := range want {
		if got[entry] != tokens {
			t.Fatalf("%s at %d = %d tokens, want %d", entry.model, entry.bucket, got[entry], tokens)
		}
	}

	// The rows must arrive grouped by model, because the handler's fold walks one model at a
	// time. An interleaved result would still aggregate correctly but the ordering is part of
	// the contract.
	seen := map[string]bool{}
	previous := ""
	for _, row := range rows {
		if row.Model != previous {
			if seen[row.Model] {
				t.Fatalf("model %s appears in more than one run", row.Model)
			}
			seen[row.Model] = true
			previous = row.Model
		}
	}
}

// TestQueryUsageModelBucketsIgnoresTheRollup is the regression this endpoint exists to avoid.
//
// `QueryUsageAnalytics` splits its window at the aggregation checkpoint and reads the two
// halves from different tables, which double counts an event whose own hour was already
// folded when it arrived. This query reads one source, so folding the hour first must not
// change what the window reports.
func TestQueryUsageModelBucketsIgnoresTheRollup(t *testing.T) {
	repo := usageTestRepository(t)
	base := time.Date(2026, 9, 14, 10, 0, 0, 0, time.UTC)
	insertModelEvent(t, repo, "r-1", "alpha", base, 100)
	insertModelEvent(t, repo, "r-2", "beta", base.Add(time.Minute), 30)

	window := func() int64 {
		rows, err := repo.QueryUsageModelBuckets(context.Background(), "default",
			base.UnixMilli(), base.Add(time.Hour).UnixMilli(), time.Minute.Milliseconds())
		if err != nil {
			t.Fatal(err)
		}
		var total int64
		for _, row := range rows {
			total += row.Tokens
		}
		return total
	}

	before := window()
	if before != 130 {
		t.Fatalf("before aggregation = %d tokens, want 130", before)
	}
	if _, err := repo.AggregateUsageGrain(context.Background(), CheckpointHourly, HourBucketMS, 1000); err != nil {
		t.Fatal(err)
	}
	// A record that arrives late with an earlier timestamp, after its own hour was folded.
	// The hybrid read is exactly the case that counts this twice: it sits on the detail side
	// of the timestamp boundary while its hour is already inside the rollup.
	insertModelEvent(t, repo, "r-3", "alpha", base.Add(2*time.Minute), 11)

	after := window()
	if after != 141 {
		t.Fatalf("after aggregation and a late event = %d tokens, want 141", after)
	}
}

func TestQueryUsageModelBucketsIsScopedToTheInstanceAndWindow(t *testing.T) {
	repo := usageTestRepository(t)
	base := time.Date(2026, 9, 14, 10, 0, 0, 0, time.UTC)

	// A second instance's traffic must not appear: the ranking is per deployment, and a
	// missing instance predicate would let another CPA's models into this one's legend.
	if _, err := repo.SQL().Exec(`
		INSERT INTO cpa_instances (id, name, base_url, usage_addr,
			management_key_ciphertext, management_key_nonce, status, created_at, updated_at)
		VALUES ('other', 'Other', 'http://127.0.0.1:9', '127.0.0.1:9', x'00', x'00', 'unknown', 0, 0)`); err != nil {
		t.Fatal(err)
	}
	insertModelEvent(t, repo, "s-1", "alpha", base, 10)
	if _, err := repo.InsertUsageEvents(context.Background(), []usage.Event{
		modelEventAt("other", "s-2", "foreign", base, 999),
	}); err != nil {
		t.Fatal(err)
	}
	// One millisecond before the window opens, and one after it closes: an inclusive/exclusive
	// mistake at either edge is invisible in a single-event test.
	insertModelEvent(t, repo, "s-3", "early", time.UnixMilli(base.UnixMilli()-1).UTC(), 500)
	insertModelEvent(t, repo, "s-4", "late", base.Add(2*time.Minute), 700)

	rows, err := repo.QueryUsageModelBuckets(context.Background(), "default",
		base.UnixMilli(), base.Add(time.Minute).UnixMilli(), time.Minute.Milliseconds())
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 || rows[0].Model != "alpha" || rows[0].Tokens != 10 {
		t.Fatalf("scoped query = %#v, want only alpha/10", rows)
	}
}

func TestQueryUsageModelBucketsRejectsAnInvalidGrid(t *testing.T) {
	repo := usageTestRepository(t)
	base := time.Date(2026, 9, 14, 10, 0, 0, 0, time.UTC)
	// A zero bucket width would divide by zero inside the query; a negative window has no
	// meaning. Both are refused rather than answered with something plausible.
	if _, err := repo.QueryUsageModelBuckets(context.Background(), "default", base.UnixMilli(), base.UnixMilli(), 0); err == nil {
		t.Fatal("a zero bucket width must be refused")
	}
	if _, err := repo.QueryUsageModelBuckets(context.Background(), "default", base.UnixMilli(), base.UnixMilli()-1, 60_000); err == nil {
		t.Fatal("a negative window must be refused")
	}
}
