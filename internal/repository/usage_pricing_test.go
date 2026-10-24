package repository

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/pricing"
	"github.com/oh-my-cpa/oh-my-cpa/internal/usage"
	"github.com/oh-my-cpa/oh-my-cpa/migrations"
)

func TestRequestPriceSnapshotsNeverReprice(t *testing.T) {
	r := usageTestRepository(t)
	ctx := context.Background()
	price := pricing.ModelPrice{Model: "snapshot-model", PromptPricePer1M: 1, PriceMultiplier: 1, Source: pricing.SourceManual}
	save := func() int64 {
		t.Helper()
		if err := r.UpsertModelPrices(ctx, []pricing.ModelPrice{price}); err != nil {
			t.Fatal(err)
		}
		var ts int64
		if err := r.SQL().QueryRow(`SELECT max(effective_from_ms) FROM model_price_versions WHERE model=?`, price.Model).Scan(&ts); err != nil {
			t.Fatal(err)
		}
		return ts
	}
	insert := func(key, model string, ts int64) int64 {
		t.Helper()
		id, err := r.InsertUsageEvents(ctx, []usage.Event{{InstanceID: "default", EventKey: key, Model: model, TimestampMS: ts, InputTokens: 1_000_000}})
		if err != nil {
			t.Fatal(err)
		}
		return id
	}
	oldTime := save()
	oldID := insert("old", price.Model, oldTime)
	unknownID := insert("unknown", "new-model", oldTime)
	time.Sleep(3 * time.Millisecond)
	price.PromptPricePer1M = 0.01
	newTime := save()
	newID := insert("new", price.Model, newTime)
	lateID := insert("late", price.Model, oldTime)
	if _, err := r.DeleteModelPrice(ctx, price.Model); err != nil {
		t.Fatal(err)
	}
	price.Model = "new-model"
	save()
	for _, tc := range []struct {
		id   int64
		want float64
	}{{oldID, 1}, {lateID, 1}, {newID, 0.01}} {
		row, err := r.GetUsageEvent(ctx, tc.id)
		if err != nil {
			t.Fatal(err)
		}
		if row.CostUSD == nil || *row.CostUSD != tc.want || row.PricingStatus != "priced" || row.PriceVersionID == nil {
			t.Fatalf("row %+v want %v", row, tc.want)
		}
	}
	row, err := r.GetUsageEvent(ctx, unknownID)
	if err != nil || row.CostUSD != nil || row.PricingStatus != "unpriced" {
		t.Fatalf("unpriced retroactively changed: %+v %v", row, err)
	}
	deletedID := insert("deleted", "snapshot-model", time.Now().UnixMilli())
	row, err = r.GetUsageEvent(ctx, deletedID)
	if err != nil || row.CostUSD != nil {
		t.Fatalf("deleted rate leaked forward: %+v %v", row, err)
	}
	stats, err := r.QueryUsageCost(ctx, "default", 0, time.Now().UnixMilli()+1000)
	if err != nil || stats.CostUSD != 2.01 || stats.PricedEvents != 3 || stats.UnpricedEvents != 2 {
		t.Fatalf("stats %+v %v", stats, err)
	}
	if _, err := r.SQL().Exec(`UPDATE usage_events SET cost_nanos=0 WHERE id=?`, oldID); err == nil {
		t.Fatal("snapshot mutable")
	}
	if _, err := r.SQL().Exec(`DELETE FROM model_price_versions`); err == nil {
		t.Fatal("history deletable")
	}
	// A source-only or rates-only change creates a version; repeated sync metadata does not.
	var before, after int
	r.SQL().QueryRow(`SELECT count(*) FROM model_price_versions`).Scan(&before)
	save()
	r.SQL().QueryRow(`SELECT count(*) FROM model_price_versions`).Scan(&after)
	if before != after {
		t.Fatal("unchanged sync created redundant versions")
	}
}

func TestSnapshotMigrationDoesNotInventHistoricalCosts(t *testing.T) {
	db, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	// Minimal pre-migration shape isolates the upgrade policy from newer migrations.
	if _, err = db.Exec(`CREATE TABLE usage_events(id INTEGER PRIMARY KEY); INSERT INTO usage_events VALUES(1);`); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"015_model_prices.sql", "019_request_price_snapshots.sql"} {
		data, err := migrations.Files.ReadFile(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err = db.Exec(string(data)); err != nil {
			t.Fatal(err)
		}
	}
	var cost, version sql.NullInt64
	var status string
	if err = db.QueryRow(`SELECT cost_nanos,price_version_id,pricing_status FROM usage_events`).Scan(&cost, &version, &status); err != nil {
		t.Fatal(err)
	}
	if cost.Valid || version.Valid || status != "legacy_unpriced" {
		t.Fatalf("fabricated legacy cost: %v %v %s", cost, version, status)
	}
}

func TestAutoPriceCannotOverwriteManual(t *testing.T) {
	r := usageTestRepository(t)
	ctx := context.Background()
	p := pricing.ModelPrice{Model: "m", PromptPricePer1M: 5, PriceMultiplier: 1, Source: pricing.SourceManual}
	if err := r.UpsertModelPrices(ctx, []pricing.ModelPrice{p}); err != nil {
		t.Fatal(err)
	}
	p.Source = pricing.SourceOpenRouter
	p.PromptPricePer1M = 1
	if err := r.UpsertModelPrices(ctx, []pricing.ModelPrice{p}); err != nil {
		t.Fatal(err)
	}
	rows, err := r.ListModelPrices(ctx)
	if err != nil || len(rows) != 1 || rows[0].PromptPricePer1M != 5 || rows[0].Source != pricing.SourceManual {
		t.Fatalf("manual overwritten: %+v %v", rows, err)
	}
}

func TestDecodedPriceAndInboxCommitRollBackTogether(t *testing.T) {
	r := usageTestRepository(t)
	ctx := context.Background()
	p := pricing.ModelPrice{Model: "m", PromptPricePer1M: 1, PriceMultiplier: 1, Source: pricing.SourceManual}
	if err := r.UpsertModelPrices(ctx, []pricing.ModelPrice{p}); err != nil {
		t.Fatal(err)
	}
	if _, err := r.AppendUsageInbox(ctx, "default", "http_pull", []string{`{"request_id":"atomic"}`}, time.Now()); err != nil {
		t.Fatal(err)
	}
	batch, err := r.ClaimUsageInboxBatch(ctx, 10)
	if err != nil {
		t.Fatal(err)
	}
	event := usage.Event{InstanceID: "default", EventKey: "atomic", Model: "m", TimestampMS: time.Now().UnixMilli(), InputTokens: 1_000_000}
	broken := event
	broken.InstanceID = "missing-instance"
	if _, err = r.CommitUsageDecoded(ctx, []UsageDecoded{{InboxID: batch[0].ID, Event: event}, {InboxID: batch[0].ID, Event: broken}}); err == nil {
		t.Fatal("invalid batch committed")
	}
	var count int
	if err = r.SQL().QueryRow(`SELECT count(*) FROM usage_events`).Scan(&count); err != nil || count != 0 {
		t.Fatalf("partial request commit: %d %v", count, err)
	}
	pending, err := r.PendingUsageInboxCount(ctx)
	if err != nil || pending != 1 {
		t.Fatalf("inbox lost: %d %v", pending, err)
	}
	if _, err = r.CommitUsageDecoded(ctx, []UsageDecoded{{InboxID: batch[0].ID, Event: event}}); err != nil {
		t.Fatal(err)
	}
	var cost int64
	if err = r.SQL().QueryRow(`SELECT cost_nanos FROM usage_events`).Scan(&cost); err != nil || cost != 1_000_000_000 {
		t.Fatalf("decoded request not locked: %d %v", cost, err)
	}
}

func TestCanonicalAccountingSurvivesPricingAndRetention(t *testing.T) {
	ctx := context.Background()
	for _, tc := range []struct {
		name       string
		output     int64
		version    int
		quality    string
		wantOutput int64
		wantCost   int64
		wantStatus string
		rawCached  int64
	}{
		{"separate reasoning", 30, 2, "complete", 40, 170000, "complete", 20},
		{"inclusive reasoning", 40, 2, "complete", 40, 170000, "complete", 20},
		{"legacy", 30, 0, "", 30, 150000, "", 20},
		{"future version", 30, 3, "complete", 30, 0, "unsupported", 20},
		{"unclassified", 30, 2, "unclassified", 30, 0, "unclassified", 20},
		{"inconsistent", 30, 2, "inconsistent", 30, 0, "inconsistent", 20},
		{"cached alias zero", 30, 2, "complete", 40, 170000, "complete", 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			repo := usageTestRepository(t)
			price := pricing.ModelPrice{Model: "canonical", PromptPricePer1M: 1, CompletionPer1M: 2, CacheReadPer1M: 0.5, PriceMultiplier: 1, Source: pricing.SourceManual}
			if err := repo.UpsertModelPrices(ctx, []pricing.ModelPrice{price}); err != nil {
				t.Fatal(err)
			}
			at := time.Now().Add(24 * time.Hour).Truncate(24 * time.Hour)
			tokens := usage.TokenStats{InputTokens: 100, OutputTokens: tc.output, ReasoningTokens: 10, CachedTokens: tc.rawCached, CacheReadTokens: 20, CacheReadTokensPresent: true, TotalTokens: 140}
			payload := map[string]any{"request_id": "canonical", "model": "canonical", "timestamp": at.Add(time.Second), "tokens": tokens}
			if tc.version != 0 {
				payload["accounting_version"] = tc.version
				payload["token_breakdown"] = usage.TokenBreakdown{SchemaVersion: 2, Quality: tc.quality, TotalTokens: 140,
					Input:  usage.TokenInputBreakdown{TotalTokens: 100, UncachedTokens: 80, CacheReadTokens: 20},
					Output: usage.TokenOutputBreakdown{TotalTokens: 40, NonReasoningTokens: 30, ReasoningTokens: 10}}
			}
			raw, err := json.Marshal(payload)
			if err != nil {
				t.Fatal(err)
			}
			event, err := usage.DecodeEvent(string(raw), "default", at)
			if err != nil {
				t.Fatal(err)
			}
			// Exercise the inbox transaction used by the live queue, not only direct inserts.
			if _, err = repo.AppendUsageInbox(ctx, "default", "http_pull", []string{string(raw)}, at); err != nil {
				t.Fatal(err)
			}
			inbox, err := repo.ClaimUsageInboxBatch(ctx, 1)
			if err != nil {
				t.Fatal(err)
			}
			if _, err = repo.CommitUsageDecoded(ctx, []UsageDecoded{{InboxID: inbox[0].ID, Event: event}}); err != nil {
				t.Fatal(err)
			}
			page, err := repo.ListUsageEvents(ctx, UsageEventFilter{Limit: 5})
			if err != nil || len(page.Items) != 1 {
				t.Fatalf("list: %+v %v", page, err)
			}
			row := page.Items[0]
			detail, err := repo.GetUsageEvent(ctx, row.ID)
			if err != nil {
				t.Fatal(err)
			}
			for _, record := range []UsageEventRow{row, detail} {
				if record.Tokens.OutputTokens != tc.wantOutput || !reflect.DeepEqual(record.Accounting, event.Accounting) {
					t.Fatalf("stored accounting: %+v", record)
				}
			}
			cost, err := repo.GetUsageEventCostBreakdown(ctx, row.ID)
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(cost.Accounting, event.Accounting) {
				t.Fatalf("cost lost accounting: %+v", cost)
			}
			if tc.wantCost > 0 {
				if cost.StoredNanos == nil || *cost.StoredNanos != tc.wantCost || !cost.RecomputedMatches || cost.Quote == nil {
					t.Fatalf("cost: %+v", cost)
				}
			} else if cost.Status != "unpriced" || cost.StoredNanos != nil || cost.Quote != nil {
				t.Fatalf("unresolved accounting was priced: %+v", cost)
			}
			if tc.wantStatus != "" && (detail.Accounting == nil || detail.Accounting.Status != tc.wantStatus || detail.Accounting.RawTokens.OutputTokens != tc.output) {
				t.Fatalf("raw evidence: %+v", detail.Accounting)
			}
			if _, err = repo.SQL().Exec(`UPDATE usage_events SET token_accounting=NULL WHERE id=?`, row.ID); err == nil {
				t.Fatal("accounting evidence is mutable")
			}
			query := UsageFactQuery{InstanceID: "default", FromMS: at.UnixMilli(), ToMS: at.Add(24*time.Hour).UnixMilli() - 1, BucketMS: DayBucketMS}
			want := UsageMeasures{UsageTotals: UsageTotals{Requests: 1, InputTokens: 100, OutputTokens: tc.wantOutput, ReasoningTokens: 10, CachedTokens: 20, CacheReadTokens: 20, TotalTokens: 140}, CostNanos: tc.wantCost}
			if tc.wantCost > 0 {
				want.PricedRequests, want.CostedRequests = 1, 1
			}
			if tc.version != 0 {
				want.Accounting = TokenAccountingMeasures{RawInputTokens: 100, RawOutputTokens: tc.output, RawTotalTokens: 140}
				if tc.wantStatus == "complete" {
					want.Accounting.CanonicalRequests = 1
				} else {
					want.Accounting.UnresolvedRequests = 1
				}
			}
			verify := func(stage string) {
				t.Helper()
				facts, err := repo.QueryUsageFacts(ctx, query)
				if err != nil || !reflect.DeepEqual(facts.Totals(), want) {
					t.Fatalf("%s: got %+v want %+v: %v", stage, facts.Totals(), want, err)
				}
			}
			verify("unfolded")
			if _, err = repo.AggregateUsageFacts(ctx, 100); err != nil {
				t.Fatal(err)
			}
			verify("folded")
			for pass := 0; pass < 2; pass++ {
				if _, err = repo.RunLifecycle(ctx, map[string]int64{LifecycleUsageDetail: at.Add(24 * time.Hour).UnixMilli()}, 5); err != nil {
					t.Fatal(err)
				}
			}
			if _, err = repo.GetUsageEvent(ctx, row.ID); !errors.Is(err, ErrNotFound) {
				t.Fatalf("detail did not expire: %v", err)
			}
			verify("retained daily facts")
			query.BucketMS = QuarterHourBucketMS
			verify("retained fine facts")
			repo.Timezone().Apply(time.UTC)
			if _, err = repo.EnsureLocalUsageFacts(ctx); err != nil {
				t.Fatal(err)
			}
			query.Calendar = &UsageCalendar{Location: time.UTC, Unit: UsageCalendarDay}
			verify("rebuilt local-day facts")
		})
	}
}
