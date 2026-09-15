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
		base.UnixMilli(), base.Add(2*time.Minute).UnixMilli(), time.Minute.Milliseconds(), UsageModelBucketOptions{})
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
			base.UnixMilli(), base.Add(time.Hour).UnixMilli(), time.Minute.Milliseconds(), UsageModelBucketOptions{})
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
		base.UnixMilli(), base.Add(time.Minute).UnixMilli(), time.Minute.Milliseconds(), UsageModelBucketOptions{})
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
	if _, err := repo.QueryUsageModelBuckets(context.Background(), "default", base.UnixMilli(), base.UnixMilli(), 0, UsageModelBucketOptions{}); err == nil {
		t.Fatal("a zero bucket width must be refused")
	}
	if _, err := repo.QueryUsageModelBuckets(context.Background(), "default", base.UnixMilli(), base.UnixMilli()-1, 60_000, UsageModelBucketOptions{}); err == nil {
		t.Fatal("a negative window must be refused")
	}
}

// insertCallPointEvent writes one event with its own model and model alias, which is the pair the
// call-point view partitions on: the alias is the call point a client requested, the model is what
// the gateway actually routed to. A nil alias and the alias carrying the same value as the model are
// two different shapes in the wire contract (pointer vs value), so both are exercised here.
func insertCallPointEvent(t *testing.T, repo *Repository, id, model string, alias *string, at time.Time, totalTokens int64, costNanos *int64) {
	t.Helper()
	event := modelEventAt("default", id, model, at, totalTokens)
	event.ModelAlias = alias
	if _, err := repo.InsertUsageEvents(context.Background(), []usage.Event{event}); err != nil {
		t.Fatal(err)
	}
}

// insertPricedCallPointEvent writes a row whose pricing snapshot is present from birth. Pricing is
// immutable by trigger, so a priced row cannot be produced by updating an unpriced one - the real
// ingest path writes cost, status and tokens in one INSERT, and so does this fixture. A nil alias
// groups the row under its own model name in both views.
func insertPricedCallPointEvent(t *testing.T, repo *Repository, id, model string, at time.Time, totalTokens int64, costNanos int64) {
	t.Helper()
	if _, err := repo.SQL().ExecContext(context.Background(),
		`INSERT INTO usage_events
		 (instance_id, event_key, request_id, api_group_key, model, auth_index, timestamp_ms,
		  created_at_ms, input_tokens, total_tokens, cost_nanos, pricing_status)
		 VALUES ('default', ?, ?, 'group-' || ?, ?, 'auth-1', ?, ?, ?, ?, ?, 'priced')`,
		id, id, id, model, at.UnixMilli(), at.UnixMilli(), totalTokens, totalTokens, costNanos); err != nil {
		t.Fatal(err)
	}
}

func TestQueryUsageModelBucketsGroupsCallPointsAcrossUpstreamModels(t *testing.T) {
	repo := usageTestRepository(t)
	base := time.Date(2026, 9, 14, 10, 0, 0, 0, time.UTC)
	// The user's example: one call point ("deepseek-v4.1-flash", set as the alias) served by two
	// upstream model names. In the call view it is one group; in the model view it is two.
	flash := "deepseek-v4.1-flash"
	insertCallPointEvent(t, repo, "c-1", "deepseek-flash", &flash, base, 100, nil)
	insertCallPointEvent(t, repo, "c-2", "deepseek-v4.1-flash", &flash, base.Add(time.Minute), 200, nil)
	// A call with no alias groups under its own model name in both views.
	insertCallPointEvent(t, repo, "c-3", "claude-sonnet-4-5", nil, base, 400, nil)
	// An alias of only whitespace is no call point at all: it falls back to the model name rather
	// than producing a blank group.
	blank := "   "
	insertCallPointEvent(t, repo, "c-4", "glm-5.3-flash", &blank, base, 50, nil)

	callRows, err := repo.QueryUsageModelBuckets(context.Background(), "default",
		base.UnixMilli(), base.Add(time.Minute).UnixMilli(), time.Minute.Milliseconds(), UsageModelBucketOptions{IsGroupedByCallPoint: true})
	if err != nil {
		t.Fatal(err)
	}
	callTokens := map[string]int64{}
	for _, row := range callRows {
		callTokens[row.Model] += row.Tokens
	}
	if len(callTokens) != 3 {
		t.Fatalf("call view produced %d groups, want 3: %#v", len(callTokens), callTokens)
	}
	if callTokens[flash] != 300 {
		t.Fatalf("call point %q summed to %d, want 300 (both upstream variants merged)", flash, callTokens[flash])
	}
	if callTokens["claude-sonnet-4-5"] != 400 || callTokens["glm-5.3-flash"] != 50 {
		t.Fatalf("call view misgrouped unaliased calls: %#v", callTokens)
	}

	modelRows, err := repo.QueryUsageModelBuckets(context.Background(), "default",
		base.UnixMilli(), base.Add(time.Minute).UnixMilli(), time.Minute.Milliseconds(), UsageModelBucketOptions{})
	if err != nil {
		t.Fatal(err)
	}
	modelTokens := map[string]int64{}
	for _, row := range modelRows {
		modelTokens[row.Model] += row.Tokens
	}
	if len(modelTokens) != 4 {
		t.Fatalf("model view produced %d groups, want 4 (the call point split back out): %#v", len(modelTokens), modelTokens)
	}
	if modelTokens["deepseek-flash"] != 100 || modelTokens["deepseek-v4.1-flash"] != 200 {
		t.Fatalf("model view must keep the upstream variants distinct: %#v", modelTokens)
	}
}

func TestQueryUsageModelBucketsCarriesPricedCostsOnly(t *testing.T) {
	repo := usageTestRepository(t)
	base := time.Date(2026, 9, 14, 10, 0, 0, 0, time.UTC)
	// Two priced requests and one unpriced one: the cost sums only the priced pair, and the priced
	// count says so, because a spend summed over part of the traffic is not the spend of the whole.
	insertPricedCallPointEvent(t, repo, "p-1", "alpha", base, 10, 1_000_000_000)
	insertPricedCallPointEvent(t, repo, "p-2", "alpha", base, 20, 2_500_000_000)
	insertCallPointEvent(t, repo, "p-3", "alpha", nil, base, 30, nil)

	rows, err := repo.QueryUsageModelBuckets(context.Background(), "default",
		base.UnixMilli(), base.UnixMilli(), time.Minute.Milliseconds(), UsageModelBucketOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 {
		t.Fatalf("got %d rows, want 1", len(rows))
	}
	row := rows[0]
	if row.CostNanos == nil || *row.CostNanos != 3_500_000_000 {
		t.Fatalf("cost = %v, want 3500000000 (priced rows only)", row.CostNanos)
	}
	if row.PricedRequests == nil || *row.PricedRequests != 2 {
		t.Fatalf("priced requests = %v, want 2", row.PricedRequests)
	}
	if row.Requests != 3 || row.Tokens != 60 {
		t.Fatalf("requests/tokens = %d/%d, want 3/60 (unpriced still counts as usage)", row.Requests, row.Tokens)
	}
}
