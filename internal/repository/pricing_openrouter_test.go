package repository

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/pricing"
	"github.com/oh-my-cpa/oh-my-cpa/internal/usage"
)

func float(value float64) *float64 { return &value }

// An upgrade must keep every stored price, version and request cost exactly as
// it was: 028 rebuilds model_prices and the sync bookkeeping, and a careless
// rebuild would mint versions, reprice history or drop the operator's schedule.
func TestMigration028UpgradeFrom027(t *testing.T) {
	ctx := context.Background()
	name := fmt.Sprintf("file:memdb_upgrade028_%d?mode=memory&cache=shared", usageDSNCounter.Add(1))
	db, err := Open(ctx, name, withMigrationsUntil(27))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	exec := func(query string, args ...any) {
		t.Helper()
		if _, err := db.SQL.ExecContext(ctx, query, args...); err != nil {
			t.Fatalf("%s: %v", query, err)
		}
	}
	exec(`INSERT INTO cpa_instances (id, name, base_url, usage_addr, management_key_ciphertext, management_key_nonce, status, created_at, updated_at)
		VALUES ('default', 'Default', 'http://127.0.0.1:8317', '127.0.0.1:8317', x'00', x'00', 'unknown', 0, 0)`)
	exec(`INSERT INTO model_prices(model, prompt_price_per_1m, completion_price_per_1m, cache_read_price_per_1m, cache_write_price_per_1m, price_multiplier, source, synced_at_ms, updated_at_ms)
		VALUES ('legacy-auto', 2, 8, 0.2, 0, 1, 'modelsdev', 1, 1), ('operator', 5, 5, 0, 0, 1.5, 'manual', 0, 1)`)
	exec(`INSERT INTO pricing_sync_state(source, running, last_success_at_ms, last_error, last_matched, last_unmatched, updated_at_ms, auto_sync_interval_hours)
		VALUES ('modelsdev', 0, 123, 'old error', 9, 1, 1, 6)`)
	var legacyVersion int64
	if err := db.SQL.QueryRowContext(ctx, `SELECT id FROM model_price_versions WHERE model='legacy-auto'`).Scan(&legacyVersion); err != nil {
		t.Fatal(err)
	}
	exec(`INSERT INTO usage_events(instance_id, event_key, api_group_key, model, timestamp_ms, created_at_ms, input_tokens, cost_nanos, price_version_id, pricing_status)
		VALUES ('default', 'priced', 'g', 'legacy-auto', 10, 10, 1000000, 2000000000, ?, 'priced'),
		       ('default', 'invalid', 'g', 'legacy-auto', 11, 11, 5, NULL, ?, 'invalid_price'),
		       ('default', 'legacy', 'g', 'legacy-auto', 12, 12, 5, NULL, NULL, 'legacy_unpriced')`, legacyVersion, legacyVersion)
	countVersions := func() int {
		var count int
		if err := db.SQL.QueryRowContext(ctx, `SELECT count(*) FROM model_price_versions`).Scan(&count); err != nil {
			t.Fatal(err)
		}
		return count
	}
	versionsBefore := countVersions()

	db.migrateUntil = 0
	if err := db.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	repo := New(db)
	if countVersions() != versionsBefore {
		t.Fatalf("the upgrade minted price versions: %d → %d", versionsBefore, countVersions())
	}
	prices, err := repo.ListModelPrices(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(prices) != 2 || prices[0].Model != "legacy-auto" || prices[0].Source != pricing.SourceModelsDev ||
		prices[0].PromptPricePer1M != 2 || prices[1].Source != pricing.SourceManual || prices[1].PriceMultiplier != 1.5 {
		t.Fatalf("rows changed: %+v", prices)
	}
	var cost sql.NullInt64
	var status string
	if err := db.SQL.QueryRowContext(ctx, `SELECT cost_nanos, pricing_status FROM usage_events WHERE event_key='priced'`).Scan(&cost, &status); err != nil {
		t.Fatal(err)
	}
	if !cost.Valid || cost.Int64 != 2_000_000_000 || status != "priced" {
		t.Fatalf("a stored cost moved: %v %s", cost, status)
	}
	state, err := repo.GetPricingSyncState(ctx, pricing.SourceOpenRouter)
	if err != nil {
		t.Fatal(err)
	}
	if state.AutoSyncIntervalHours != 6 || state.LastSuccessAtMS != nil || state.LastError != "" {
		t.Fatalf("schedule not carried or models.dev history carried over: %+v", state)
	}
	var violations int
	rows, err := db.SQL.QueryContext(ctx, `PRAGMA foreign_key_check`)
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		violations++
	}
	rows.Close()
	if violations != 0 {
		t.Fatalf("foreign key violations after the rebuild: %d", violations)
	}
	// A legacy version still explains the request it priced.
	var pricedID int64
	if err := db.SQL.QueryRowContext(ctx, `SELECT id FROM usage_events WHERE event_key='priced'`).Scan(&pricedID); err != nil {
		t.Fatal(err)
	}
	breakdown, err := repo.GetUsageEventCostBreakdown(ctx, pricedID)
	if err != nil || breakdown.Quote == nil || !breakdown.RecomputedMatches {
		t.Fatalf("legacy request breakdown: %+v %v", breakdown, err)
	}
	// The next write records the new columns in its version.
	if err := repo.ApplyModelPrice(ctx, pricing.ModelPrice{Model: "legacy-auto", PromptPricePer1M: 3, CompletionPer1M: 9, PriceMultiplier: 1,
		Source: pricing.SourceOpenRouter, UpstreamID: "vendor/legacy-auto", MatchKind: pricing.MatchExact,
		Tiers: []pricing.PriceTier{{MinPromptTokens: 100, PromptPricePer1M: float(6)}}}, ""); err != nil {
		t.Fatal(err)
	}
	var tiers, upstream string
	if err := db.SQL.QueryRowContext(ctx, `SELECT tiers_json, upstream_id FROM model_price_versions WHERE model='legacy-auto' ORDER BY id DESC LIMIT 1`).Scan(&tiers, &upstream); err != nil {
		t.Fatal(err)
	}
	if tiers == "[]" || upstream != "vendor/legacy-auto" {
		t.Fatalf("new version lacks tiers or upstream id: %s %s", tiers, upstream)
	}
}

func TestPricingHistoryIsImmutable(t *testing.T) {
	r := usageTestRepository(t)
	ctx := context.Background()
	if err := r.UpsertChannelMultiplier(ctx, pricing.ChannelMultiplier{Channel: "relay", Multiplier: 0.3}); err != nil {
		t.Fatal(err)
	}
	for _, statement := range []string{
		`UPDATE pricing_channel_versions SET multiplier = 1`,
		`DELETE FROM pricing_channel_versions`,
	} {
		if _, err := r.SQL().ExecContext(ctx, statement); err == nil {
			t.Fatalf("%s succeeded", statement)
		}
	}
	if err := r.ApplyModelPrice(ctx, pricing.ModelPrice{Model: "m", PromptPricePer1M: 1, PriceMultiplier: 1, Source: pricing.SourceManual}, ""); err != nil {
		t.Fatal(err)
	}
	if _, err := r.SQL().ExecContext(ctx, `DELETE FROM model_price_versions`); err == nil {
		t.Fatal("price history was deletable")
	}
	id, err := r.InsertUsageEvents(ctx, []usage.Event{{InstanceID: "default", EventKey: "k", Model: "m", Provider: "relay", TimestampMS: time.Now().UnixMilli(), InputTokens: 10}})
	if err != nil {
		t.Fatal(err)
	}
	for _, column := range []string{"channel_version_id = NULL", "price_tier = 3"} {
		if _, err := r.SQL().ExecContext(ctx, `UPDATE usage_events SET `+column+` WHERE id = ?`, id); err == nil {
			t.Fatalf("usage_events %s was allowed", column)
		}
	}
	// A note-only edit changes no multiplier and mints nothing.
	var before, after int
	r.SQL().QueryRow(`SELECT count(*) FROM pricing_channel_versions`).Scan(&before)
	if err := r.UpsertChannelMultiplier(ctx, pricing.ChannelMultiplier{Channel: "relay", Multiplier: 0.3, Note: "renamed"}); err != nil {
		t.Fatal(err)
	}
	r.SQL().QueryRow(`SELECT count(*) FROM pricing_channel_versions`).Scan(&after)
	if before != after {
		t.Fatal("a note edit minted a channel version")
	}
}

// The channel multiplier in force at the request's own timestamp is locked on
// both insert paths; a missing or retired channel is 1x.
func TestChannelMultiplierLockedAtRequestTime(t *testing.T) {
	r := usageTestRepository(t)
	ctx := context.Background()
	if err := r.ApplyModelPrice(ctx, pricing.ModelPrice{Model: "m", PromptPricePer1M: 2, PriceMultiplier: 1, Source: pricing.SourceManual}, ""); err != nil {
		t.Fatal(err)
	}
	before := time.Now().UnixMilli()
	time.Sleep(3 * time.Millisecond)
	if err := r.UpsertChannelMultiplier(ctx, pricing.ChannelMultiplier{Channel: "relay", Multiplier: 0.3}); err != nil {
		t.Fatal(err)
	}
	var effective int64
	if err := r.SQL().QueryRow(`SELECT effective_from_ms FROM pricing_channel_versions WHERE channel='relay'`).Scan(&effective); err != nil {
		t.Fatal(err)
	}
	insert := func(key, provider string, at int64) int64 {
		t.Helper()
		id, err := r.InsertUsageEvents(ctx, []usage.Event{{InstanceID: "default", EventKey: key, Model: "m", Provider: provider, TimestampMS: at, InputTokens: 1_000_000}})
		if err != nil {
			t.Fatal(err)
		}
		return id
	}
	cost := func(id int64) float64 {
		t.Helper()
		row, err := r.GetUsageEvent(ctx, id)
		if err != nil || row.CostUSD == nil {
			t.Fatalf("row %d: %+v %v", id, row, err)
		}
		return *row.CostUSD
	}
	if got := cost(insert("relay-now", "relay", effective)); got != 0.6 {
		t.Fatalf("relay cost %v, want 0.6", got)
	}
	// Ingested now, stamped before the multiplier existed.
	if got := cost(insert("relay-late", "relay", before)); got != 2 {
		t.Fatalf("a late event took a later multiplier: %v", got)
	}
	if got := cost(insert("other", "codex", effective)); got != 2 {
		t.Fatalf("an unconfigured channel was scaled: %v", got)
	}
	// The decoded path locks the same multiplier.
	if _, err := r.AppendUsageInbox(ctx, "default", "http_pull", []string{`{"request_id":"decoded"}`}, time.Now()); err != nil {
		t.Fatal(err)
	}
	batch, err := r.ClaimUsageInboxBatch(ctx, 10)
	if err != nil || len(batch) != 1 {
		t.Fatalf("claim: %d %v", len(batch), err)
	}
	if _, err := r.CommitUsageDecoded(ctx, []UsageDecoded{{InboxID: batch[0].ID, Event: usage.Event{
		InstanceID: "default", EventKey: "decoded", Model: "m", Provider: "relay", TimestampMS: effective, InputTokens: 1_000_000}}}); err != nil {
		t.Fatal(err)
	}
	var decoded int64
	if err := r.SQL().QueryRow(`SELECT cost_nanos FROM usage_events WHERE event_key='decoded'`).Scan(&decoded); err != nil || decoded != 600_000_000 {
		t.Fatalf("decoded path: %d %v", decoded, err)
	}
	time.Sleep(3 * time.Millisecond)
	if _, err := r.DeleteChannelMultiplier(ctx, "relay"); err != nil {
		t.Fatal(err)
	}
	if got := cost(insert("relay-after-delete", "relay", time.Now().UnixMilli())); got != 2 {
		t.Fatalf("a retired multiplier leaked forward: %v", got)
	}
	// The breakdown names the locked channel version.
	var relayID int64
	r.SQL().QueryRow(`SELECT id FROM usage_events WHERE event_key='relay-now'`).Scan(&relayID)
	breakdown, err := r.GetUsageEventCostBreakdown(ctx, relayID)
	if err != nil || breakdown.Channel == nil || breakdown.Channel.Multiplier != 0.3 || !breakdown.RecomputedMatches {
		t.Fatalf("breakdown: %+v %v", breakdown, err)
	}
}

func TestTierLockedWithRequest(t *testing.T) {
	r := usageTestRepository(t)
	ctx := context.Background()
	price := pricing.ModelPrice{Model: "m", PromptPricePer1M: 1, PriceMultiplier: 1, Source: pricing.SourceOpenRouter,
		Tiers: []pricing.PriceTier{{MinPromptTokens: 1000, PromptPricePer1M: float(2)}}}
	if err := r.ApplyModelPrice(ctx, price, ""); err != nil {
		t.Fatal(err)
	}
	at := time.Now().UnixMilli()
	id, err := r.InsertUsageEvents(ctx, []usage.Event{{InstanceID: "default", EventKey: "long", Model: "m", TimestampMS: at, InputTokens: 1_000_000}})
	if err != nil {
		t.Fatal(err)
	}
	breakdown, err := r.GetUsageEventCostBreakdown(ctx, id)
	if err != nil || breakdown.StoredTier == nil || *breakdown.StoredTier != 0 || breakdown.StoredNanos == nil || *breakdown.StoredNanos != 2_000_000_000 {
		t.Fatalf("tier not locked: %+v %v", breakdown, err)
	}
	if breakdown.Quote == nil || breakdown.Quote.TierIndex == nil || !breakdown.RecomputedMatches {
		t.Fatalf("recomputed breakdown: %+v", breakdown)
	}
	unpricedID, _ := r.InsertUsageEvents(ctx, []usage.Event{{InstanceID: "default", EventKey: "none", Model: "unknown", TimestampMS: at, InputTokens: 1}})
	unpriced, err := r.GetUsageEventCostBreakdown(ctx, unpricedID)
	if err != nil || unpriced.Status != "unpriced" || unpriced.Version != nil {
		t.Fatalf("unpriced breakdown: %+v %v", unpriced, err)
	}
	if _, err := r.GetUsageEventCostBreakdown(ctx, 999_999); err != ErrNotFound {
		t.Fatalf("missing request: %v", err)
	}
}

// A mode change replaces a custom row in one write, so it mints one version and
// never a tombstone in between.
func TestApplyModelPriceMintsOneVersion(t *testing.T) {
	r := usageTestRepository(t)
	ctx := context.Background()
	if err := r.ApplyModelPrice(ctx, pricing.ModelPrice{Model: "m", PromptPricePer1M: 5, PriceMultiplier: 1, Source: pricing.SourceManual}, ""); err != nil {
		t.Fatal(err)
	}
	var before int
	r.SQL().QueryRow(`SELECT count(*) FROM model_price_versions WHERE model='m'`).Scan(&before)
	if err := r.ApplyModelPrice(ctx, pricing.ModelPrice{Model: "m", PromptPricePer1M: 1, PriceMultiplier: 1, Source: pricing.SourceOpenRouter,
		UpstreamID: "vendor/m", MatchKind: pricing.MatchLinked}, "vendor/m"); err != nil {
		t.Fatal(err)
	}
	var after, tombstones int
	r.SQL().QueryRow(`SELECT count(*) FROM model_price_versions WHERE model='m'`).Scan(&after)
	r.SQL().QueryRow(`SELECT count(*) FROM model_price_versions WHERE model='m' AND available=0`).Scan(&tombstones)
	if after != before+1 || tombstones != 0 {
		t.Fatalf("versions %d → %d, tombstones %d", before, after, tombstones)
	}
	links, err := r.ListModelLinks(ctx)
	if err != nil || links["m"] != "vendor/m" {
		t.Fatalf("link not stored: %v %v", links, err)
	}
	// A sync write for another upstream model cannot replace the pinned row.
	if err := r.UpsertModelPrices(ctx, []pricing.ModelPrice{{Model: "m", PromptPricePer1M: 9, PriceMultiplier: 1, Source: pricing.SourceOpenRouter, UpstreamID: "vendor/other", MatchKind: pricing.MatchExact}}); err != nil {
		t.Fatal(err)
	}
	rows, _ := r.ListModelPrices(ctx)
	if rows[0].UpstreamID != "vendor/m" || rows[0].PromptPricePer1M != 1 {
		t.Fatalf("sync replaced a pinned row: %+v", rows[0])
	}
	if deleted, err := r.DeleteModelPrice(ctx, "m"); err != nil || !deleted {
		t.Fatalf("delete: %v %v", deleted, err)
	}
	if links, _ := r.ListModelLinks(ctx); len(links) != 0 {
		t.Fatalf("delete left the pin behind: %v", links)
	}
}

func TestCatalogReplacementKeepsPinnedPrices(t *testing.T) {
	r := usageTestRepository(t)
	ctx := context.Background()
	if _, err := r.ReplacePricingModels(ctx, map[string]string{"pinned": "old", "pinned-gone": "pinned-gone", "auto": "old", "gone": "gone"}); err != nil {
		t.Fatal(err)
	}
	for _, model := range []string{"pinned", "pinned-gone"} {
		if err := r.ApplyModelPrice(ctx, pricing.ModelPrice{Model: model, PromptPricePer1M: 1, PriceMultiplier: 1, Source: pricing.SourceOpenRouter, UpstreamID: "v/x", MatchKind: pricing.MatchLinked}, "v/x"); err != nil {
			t.Fatal(err)
		}
	}
	if err := r.UpsertModelPrices(ctx, []pricing.ModelPrice{
		{Model: "auto", PromptPricePer1M: 1, PriceMultiplier: 1, Source: pricing.SourceOpenRouter},
		{Model: "gone", PromptPricePer1M: 1, PriceMultiplier: 1, Source: pricing.SourceOpenRouter},
	}); err != nil {
		t.Fatal(err)
	}
	pruned, err := r.ReplacePricingModels(ctx, map[string]string{"pinned": "new", "auto": "new"})
	if err != nil || pruned != 2 {
		t.Fatalf("pruned %d %v", pruned, err)
	}
	rows, _ := r.ListModelPrices(ctx)
	if len(rows) != 2 || rows[0].Model != "pinned" || rows[1].Model != "pinned-gone" {
		t.Fatalf("a pinned price was pruned on retarget or removal: %+v", rows)
	}
}

func TestUpstreamCatalogRoundTrip(t *testing.T) {
	r := usageTestRepository(t)
	ctx := context.Background()
	if err := r.ReplaceUpstreamCatalog(ctx, nil); err == nil {
		t.Fatal("an empty snapshot was stored")
	}
	models := []pricing.UpstreamModel{
		{ID: "anthropic/claude-opus-5.5", Author: "anthropic", Name: "Claude Opus 5.5", PromptPricePer1M: 4, CompletionPer1M: 20, CacheReadPer1M: 0.2, CacheWritePer1M: 5,
			Tiers: []pricing.PriceTier{{MinPromptTokens: 200_000, PromptPricePer1M: float(8)}}},
		{ID: "z-ai/glm-5.3", Author: "z-ai", PromptPricePer1M: 1.4, CompletionPer1M: 4.4, CacheReadPer1M: 0.26, CacheWritePer1M: 1.4},
	}
	if err := r.ReplaceUpstreamCatalog(ctx, models); err != nil {
		t.Fatal(err)
	}
	if err := r.ReplaceUpstreamCatalog(ctx, models[1:]); err != nil {
		t.Fatal(err)
	}
	stored, err := r.ListUpstreamCatalog(ctx)
	if err != nil || len(stored) != 1 || stored[0].ID != "z-ai/glm-5.3" {
		t.Fatalf("snapshot not replaced whole: %+v %v", stored, err)
	}
	if err := r.ReplaceUpstreamCatalog(ctx, models); err != nil {
		t.Fatal(err)
	}
	stored, _ = r.ListUpstreamCatalog(ctx)
	if len(stored[0].Tiers) != 1 || *stored[0].Tiers[0].PromptPricePer1M != 8 {
		t.Fatalf("tiers lost: %+v", stored[0])
	}
}

func TestPricingUsageAndTokenProfile(t *testing.T) {
	r := usageTestRepository(t)
	ctx := context.Background()
	if err := r.ApplyModelPrice(ctx, pricing.ModelPrice{Model: "m", PromptPricePer1M: 1, PriceMultiplier: 1, Source: pricing.SourceManual}, ""); err != nil {
		t.Fatal(err)
	}
	now := time.Now().UnixMilli()
	var events []usage.Event
	for i, input := range []int64{100, 300, 200, 900_000} {
		events = append(events, usage.Event{InstanceID: "default", EventKey: fmt.Sprint("e", i), Model: "m", Provider: "relay", TimestampMS: now, InputTokens: input, OutputTokens: int64(i)})
	}
	events = append(events, usage.Event{InstanceID: "default", EventKey: "u", Model: "unpriced", Provider: "codex", TimestampMS: now, InputTokens: 5})
	events = append(events, usage.Event{InstanceID: "default", EventKey: "old", Model: "m", Provider: "relay", TimestampMS: now - 40*24*3600*1000, InputTokens: 5})
	if _, err := r.InsertUsageEvents(ctx, events); err != nil {
		t.Fatal(err)
	}
	since := now - 30*24*3600*1000
	byModel, err := r.QueryPricingUsageByModel(ctx, since)
	if err != nil || byModel["m"].Requests != 4 || byModel["m"].PricedRequests != 4 || byModel["unpriced"].PricedRequests != 0 {
		t.Fatalf("by model: %+v %v", byModel, err)
	}
	byChannel, err := r.QueryPricingUsageByChannel(ctx, since)
	if err != nil || byChannel["relay"].Requests != 4 || byChannel["codex"].Requests != 1 {
		t.Fatalf("by channel: %+v %v", byChannel, err)
	}
	profile, err := r.QueryModelTokenProfile(ctx, "m", since)
	if err != nil || profile.Samples != 4 || profile.Input != 300 || profile.MaxInput != 900_000 {
		t.Fatalf("profile: %+v %v", profile, err)
	}
	versions, err := r.ListModelPriceVersions(ctx, "m", 10)
	if err != nil || len(versions) != 1 || !versions[0].Available || versions[0].Price.Source != pricing.SourceManual {
		t.Fatalf("versions: %+v %v", versions, err)
	}
}

func TestCorruptStoredTiersKeepCostBreakdown(t *testing.T) {
	repo := usageTestRepository(t)
	ctx := context.Background()
	// A corrupt imported snapshot must remain visible without a fabricated quote.
	_, err := repo.SQL().ExecContext(ctx, `INSERT INTO model_price_versions(model, effective_from_ms, available,
	 prompt_price_per_1m, completion_price_per_1m, cache_read_price_per_1m, cache_write_price_per_1m,
	 price_multiplier, source, tiers_json) VALUES ('broken', 0, 1, 2, 0, 0, 0, 1, 'manual', 'corrupt')`)
	if err != nil {
		t.Fatal(err)
	}
	id, err := repo.InsertUsageEvents(ctx, []usage.Event{{InstanceID: "default", EventKey: "broken-tier", Model: "broken", TimestampMS: time.Now().UnixMilli(), InputTokens: 1000}})
	if err != nil {
		t.Fatal(err)
	}
	breakdown, err := repo.GetUsageEventCostBreakdown(ctx, id)
	if err != nil || breakdown.Version == nil || breakdown.InvalidReason == "" || breakdown.Quote != nil || breakdown.Status != "invalid_price" {
		t.Fatalf("corrupt snapshot was hidden or quoted: %+v %v", breakdown, err)
	}
	// History fails explicitly rather than silently presenting a corrupt tier as base-only.
	if _, err := repo.ListModelPriceVersions(ctx, "broken", 10); err == nil {
		t.Fatal("corrupt history was presented as valid")
	}
}

// A review records the candidate an operator saw; removing the price clears it
// so the model starts over if it is priced again.
func TestMatchReviewsFollowThePrice(t *testing.T) {
	r := usageTestRepository(t)
	ctx := context.Background()
	if err := r.ApplyModelPrice(ctx, pricing.ModelPrice{Model: "m", PromptPricePer1M: 5, PriceMultiplier: 1, Source: pricing.SourceManual}, ""); err != nil {
		t.Fatal(err)
	}
	if err := r.SaveMatchReview(ctx, "m", "vendor/m"); err != nil {
		t.Fatal(err)
	}
	if err := r.SaveMatchReview(ctx, "m", "vendor/m-2"); err != nil {
		t.Fatal(err)
	}
	reviews, err := r.ListMatchReviews(ctx)
	if err != nil || len(reviews) != 1 || reviews["m"] != "vendor/m-2" {
		t.Fatalf("review not replaced: %v %v", reviews, err)
	}
	if err := r.SaveMatchReview(ctx, "", "vendor/m"); err == nil {
		t.Fatal("a review without a model was accepted")
	}
	if deleted, err := r.DeleteModelPrice(ctx, "m"); err != nil || !deleted {
		t.Fatalf("delete: %v %v", deleted, err)
	}
	if reviews, err := r.ListMatchReviews(ctx); err != nil || len(reviews) != 0 {
		t.Fatalf("removing the price kept its review: %v %v", reviews, err)
	}
	if err := r.SaveMatchReview(ctx, "n", "vendor/n"); err != nil {
		t.Fatal(err)
	}
	if err := r.SaveMatchReview(ctx, "n", ""); err != nil {
		t.Fatal(err)
	}
	if reviews, _ := r.ListMatchReviews(ctx); len(reviews) != 0 {
		t.Fatalf("an empty id did not clear the review: %v", reviews)
	}
}

func TestMatchReviewsRequireMigration031(t *testing.T) {
	ctx := context.Background()
	database, err := Open(ctx, "file:pricing_review_gate?mode=memory&cache=shared", withMigrationsUntil(30))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = database.Close() })
	repository := New(database)
	if _, err := repository.ListMatchReviews(ctx); err == nil || !strings.Contains(err.Error(), "migration 31") {
		t.Fatalf("read gate: %v", err)
	}
	if err := repository.ApplyModelPrice(ctx, pricing.ModelPrice{Model: "m", PromptPricePer1M: 5, PriceMultiplier: 1, Source: pricing.SourceManual}, ""); err != nil {
		t.Fatal(err)
	}
	if deleted, err := repository.DeleteModelPrice(ctx, "m"); err != nil || !deleted {
		t.Fatalf("deleting a price before migration 31 failed: %v %v", deleted, err)
	}
}
