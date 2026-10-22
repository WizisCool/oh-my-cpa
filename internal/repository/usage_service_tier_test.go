package repository

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/pricing"
	"github.com/oh-my-cpa/oh-my-cpa/internal/usage"
)

func TestCodexServiceTierSnapshot(t *testing.T) {
	for _, path := range []string{"insert", "inbox"} {
		t.Run(path, func(t *testing.T) {
			repo := usageTestRepository(t)
			ctx := context.Background()
			price := pricing.ModelPrice{Model: "m", PromptPricePer1M: 2, CompletionPer1M: 10, PriceMultiplier: 1, Source: pricing.SourceManual,
				Tiers: []pricing.PriceTier{{ServiceTiers: []string{"priority", "fast"}, PromptPricePer1M: float(4), CompletionPer1M: float(20)}}}
			if err := repo.ApplyModelPrice(ctx, price, ""); err != nil {
				t.Fatal(err)
			}
			at := time.Now()
			cases := []struct {
				name, provider, executor, requested, response, effective, tier, source string
				nanos                                                                  int64
			}{
				{"codex", "codex", "", "priority", "default", "", "priority", "request", 6_000_000},
				{"websocket", "custom", "CodexWebsocketsExecutor", "fast", "default", "", "fast", "request", 6_000_000},
				{"openai", "openai", "", "priority", "default", "", "default", "response", 3_000_000},
				{"outbound-priority", "codex", "", "auto", "default", "priority", "priority", "outbound", 6_000_000},
				{"outbound-default", "codex", "", "priority", "default", "default", "default", "outbound", 3_000_000},
				{"outbound-auto", "codex", "", "priority", "priority", "auto", "", "outbound", 3_000_000},
				{"outbound-websocket", "custom", "CodexWebsocketsExecutor", "auto", "default", "fast", "fast", "outbound", 6_000_000},
				{"other-outbound", "openai", "", "auto", "default", "priority", "default", "response", 3_000_000},
				{"unknown-outbound", "codex", "", "auto", "default", "", "", "request", 3_000_000},
			}
			for _, test := range cases {
				event := usage.Event{InstanceID: "default", EventKey: test.name, RequestID: test.name, Model: "m", Provider: test.provider,
					ExecutorType: test.executor, TimestampMS: at.UnixMilli(), InputTokens: 1000, OutputTokens: 100,
					ServiceTier: test.requested, EffectiveServiceTier: test.effective, ResponseServiceTier: test.response}
				if path == "inbox" {
					if _, err := repo.AppendUsageInbox(ctx, "default", "http_pull", []string{fmt.Sprintf(`{"request_id":%q}`, test.name)}, at); err != nil {
						t.Fatal(err)
					}
					batch, err := repo.ClaimUsageInboxBatch(ctx, 1)
					if err != nil || len(batch) != 1 {
						t.Fatalf("claim: %+v %v", batch, err)
					}
					if _, err := repo.CommitUsageDecoded(ctx, []UsageDecoded{{InboxID: batch[0].ID, Event: event}}); err != nil {
						t.Fatal(err)
					}
				} else if _, err := repo.InsertUsageEvents(ctx, []usage.Event{event}); err != nil {
					t.Fatal(err)
				}
				var id int64
				if err := repo.SQL().QueryRowContext(ctx, `SELECT id FROM usage_events WHERE event_key = ?`, test.name).Scan(&id); err != nil {
					t.Fatal(err)
				}
				breakdown, err := repo.GetUsageEventCostBreakdown(ctx, id)
				if err != nil || breakdown.StoredNanos == nil || *breakdown.StoredNanos != test.nanos || !breakdown.RecomputedMatches || breakdown.ServiceTier != test.tier || breakdown.ServiceTierSource != test.source {
					t.Fatalf("%s: %+v %v", test.name, breakdown, err)
				}
				row, err := repo.GetUsageEvent(ctx, id)
				if err != nil || row.ServiceTier != test.requested || row.ResponseServiceTier != test.response || row.EffectiveServiceTier != test.effective {
					t.Fatalf("raw evidence changed: %+v %v", row, err)
				}
				for _, statement := range []string{
					`UPDATE usage_events SET billed_service_tier = 'changed' WHERE id = ?`,
					`UPDATE usage_events SET billed_service_tier_source = CASE billed_service_tier_source WHEN 'request' THEN 'response' ELSE 'request' END WHERE id = ?`,
				} {
					if _, err := repo.SQL().ExecContext(ctx, statement, id); err == nil || !strings.Contains(err.Error(), "immutable") {
						t.Fatalf("snapshot update: %v", err)
					}
				}
			}
		})
	}
}

func TestServiceTierMigrationPreservesHistoricalExplanation(t *testing.T) {
	ctx := context.Background()
	name := fmt.Sprintf("file:tier_upgrade_%d?mode=memory&cache=shared", usageDSNCounter.Add(1))
	db, err := Open(ctx, name, withMigrationsUntil(44))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	repo := New(db)
	if _, err := repo.SQL().ExecContext(ctx, `INSERT INTO cpa_instances(id, name, base_url, usage_addr, management_key_ciphertext, management_key_nonce, created_at, updated_at)
 VALUES ('default', 'Default', 'http://127.0.0.1:8317', '', x'00', x'00', 0, 0)`); err != nil {
		t.Fatal(err)
	}
	price := pricing.ModelPrice{Model: "m", PromptPricePer1M: 2, CompletionPer1M: 10, PriceMultiplier: 1, Source: pricing.SourceManual,
		Tiers: []pricing.PriceTier{{ServiceTiers: []string{"priority"}, PromptPricePer1M: float(4), CompletionPer1M: float(20)}}}
	if err := repo.ApplyModelPrice(ctx, price, ""); err != nil {
		t.Fatal(err)
	}
	at := time.Now().UnixMilli()
	result, err := repo.SQL().ExecContext(ctx, `INSERT INTO usage_events(instance_id, event_key, api_group_key, model, provider, service_tier, response_service_tier,
 timestamp_ms, created_at_ms, input_tokens, output_tokens, cost_nanos, pricing_status, price_version_id)
 VALUES ('default', 'legacy', '', 'm', 'codex', 'priority', 'default', ?, ?, 1000, 100, 3000000, 'priced',
 (SELECT id FROM model_price_versions WHERE model = 'm' AND channel = '' ORDER BY id DESC LIMIT 1))`, at, at)
	if err != nil {
		t.Fatal(err)
	}
	id, err := result.LastInsertId()
	if err != nil {
		t.Fatal(err)
	}
	db.migrateUntil = 0
	if err := db.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	breakdown, err := repo.GetUsageEventCostBreakdown(ctx, id)
	if err != nil || breakdown.StoredNanos == nil || *breakdown.StoredNanos != 3_000_000 || !breakdown.RecomputedMatches || breakdown.ServiceTier != "default" || breakdown.ServiceTierSource != "response" {
		t.Fatalf("historical explanation: %+v %v", breakdown, err)
	}
	if _, err := repo.SQL().ExecContext(ctx, `UPDATE usage_events SET billed_service_tier = 'priority', billed_service_tier_source = 'request' WHERE id = ?`, id); err == nil {
		t.Fatal("historical snapshot was writable")
	}
	newID, err := repo.InsertUsageEvents(ctx, []usage.Event{{InstanceID: "default", EventKey: "new", Model: "m", Provider: "codex", ServiceTier: "priority", ResponseServiceTier: "default", TimestampMS: at, InputTokens: 1000, OutputTokens: 100}})
	if err != nil {
		t.Fatal(err)
	}
	price.Tiers[0].PromptPricePer1M = float(8)
	if err := repo.ApplyModelPrice(ctx, price, ""); err != nil {
		t.Fatal(err)
	}
	for _, expected := range []struct {
		id, nanos int64
		tier      string
	}{{id, 3_000_000, "default"}, {newID, 6_000_000, "priority"}} {
		got, err := repo.GetUsageEventCostBreakdown(ctx, expected.id)
		if err != nil || got.StoredNanos == nil || *got.StoredNanos != expected.nanos || got.ServiceTier != expected.tier || !got.RecomputedMatches {
			t.Fatalf("after price edit: %+v %v", got, err)
		}
	}
}

func TestResolvedServiceTierFilterAndFacets(t *testing.T) {
	repo := usageTestRepository(t)
	ctx := context.Background()
	at := time.Now().UnixMilli()
	for _, test := range []struct{ key, provider, executor, requested, response, effective string }{
		{"fast", "codex", "", "priority", "default", ""},
		{"ws", "custom", "CodexWebsocketsExecutor", " Priority ", "default", ""},
		{"standard", "openai", "", "priority", "default", ""},
		{"unknown", "codex", "", "auto", "default", ""},
	} {
		if _, err := repo.InsertUsageEvents(ctx, []usage.Event{{InstanceID: "default", EventKey: test.key, Provider: test.provider, ExecutorType: test.executor, TimestampMS: at, ServiceTier: test.requested, EffectiveServiceTier: test.effective, ResponseServiceTier: test.response}}); err != nil {
			t.Fatal(err)
		}
	}
	for _, test := range []struct {
		resolved, raw []string
		count         int
	}{
		{[]string{"priority"}, nil, 2}, {[]string{"default"}, nil, 1}, {nil, []string{"priority"}, 2},
		{[]string{"default"}, []string{"priority"}, 1}, {[]string{"priority", "default"}, nil, 3},
	} {
		page, err := repo.ListUsageEvents(ctx, UsageEventFilter{ResolvedServiceTiers: test.resolved, ServiceTiers: test.raw, Limit: 10})
		if err != nil || len(page.Items) != test.count {
			t.Fatalf("filter %+v: %d %v", test, len(page.Items), err)
		}
	}
	facets, err := repo.GetUsageFacets(ctx, "default", at-1, at+1)
	if err != nil || len(facets.ResolvedServiceTiers) != 2 || facets.ResolvedServiceTiers[0].Value != "priority" || facets.ResolvedServiceTiers[0].Requests != 2 || facets.ResolvedServiceTiers[1].Value != "default" {
		t.Fatalf("resolved facets: %+v %v", facets.ResolvedServiceTiers, err)
	}
}
