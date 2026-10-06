package operations

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/capability"
	appcrypto "github.com/oh-my-cpa/oh-my-cpa/internal/crypto"
	"github.com/oh-my-cpa/oh-my-cpa/internal/pricing"
	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
)

type candidateFailingPricing struct {
	Pricing
	prices []pricing.ModelPrice
}

func (f candidateFailingPricing) ListPrices(context.Context) ([]pricing.ModelPrice, error) {
	return f.prices, nil
}

func (candidateFailingPricing) ListChannels(context.Context) ([]pricing.ChannelMultiplier, error) {
	return nil, nil
}

func (candidateFailingPricing) Candidates(context.Context, []pricing.ModelPrice) (map[string]pricing.Candidate, error) {
	return nil, errors.New("snapshot unreadable")
}

// pricing_list also backs the pricing_set and pricing_delete previews, so a
// candidate lookup that fails must leave the list readable.
func TestPriceListSurvivesAFailedCandidateLookup(t *testing.T) {
	service := &Service{Pricing: candidateFailingPricing{prices: []pricing.ModelPrice{{Model: "claude-sonnet", Source: pricing.SourceManual}}}}
	page, err := service.ListPrices(context.Background(), PriceQuery{})
	if err != nil {
		t.Fatalf("ListPrices failed with the candidate lookup: %v", err)
	}
	if len(page.Items) != 1 || page.Candidates == nil || len(page.Candidates) != 0 {
		t.Fatalf("page = %+v, want the price with no candidates", page)
	}
}

// bookPricing is a price book small enough to read in a test: two priced
// models, two unpriced ones and a three-model OpenRouter snapshot.
type bookPricing struct {
	Pricing
	prices   []pricing.ModelPrice
	channels []pricing.ChannelMultiplier
	catalog  []pricing.UpstreamModel
	unpriced []string
}

func newBookPricing() bookPricing {
	return bookPricing{
		prices: []pricing.ModelPrice{
			{Model: "deepseek-chat", PromptPricePer1M: 2, CompletionPer1M: 8, PriceMultiplier: 1, Source: pricing.SourceManual, Mode: pricing.ModeCustom, Tiers: []pricing.PriceTier{}},
			{Model: "gpt-5", PromptPricePer1M: 1.25, CompletionPer1M: 10, PriceMultiplier: 1, Source: pricing.SourceOpenRouter, Mode: pricing.ModeAuto, Tiers: []pricing.PriceTier{}},
		},
		channels: []pricing.ChannelMultiplier{{Channel: "relay", Multiplier: 0.5}},
		catalog: []pricing.UpstreamModel{
			{ID: "deepseek/deepseek-chat-v3", Name: "DeepSeek Chat V3", PromptPricePer1M: 0.3, CompletionPer1M: 1.2},
			{ID: "deepseek/deepseek-chat", Name: "DeepSeek Chat", PromptPricePer1M: 0.27, CompletionPer1M: 1.1},
			{ID: "openai/gpt-5", Name: "GPT-5", PromptPricePer1M: 1.25, CompletionPer1M: 10},
		},
		unpriced: []string{"house-model", "qwen-max"},
	}
}

func (f bookPricing) ListPrices(context.Context) ([]pricing.ModelPrice, error) { return f.prices, nil }
func (f bookPricing) ListChannels(context.Context) ([]pricing.ChannelMultiplier, error) {
	return f.channels, nil
}
func (f bookPricing) StoredCatalog(context.Context) ([]pricing.UpstreamModel, error) {
	return f.catalog, nil
}
func (f bookPricing) UsedUnpricedModels(context.Context, int) ([]string, error) {
	return append([]string(nil), f.unpriced...), nil
}
func (f bookPricing) Suggestions(_ context.Context, model string, limit int) ([]pricing.UpstreamModel, error) {
	if model != "qwen-max" {
		return nil, nil
	}
	return f.catalog[:min(limit, len(f.catalog))], nil
}
func (bookPricing) AutomaticMatch(context.Context, string) (pricing.Match, bool, error) {
	return pricing.Match{}, false, nil
}
func (bookPricing) Candidates(context.Context, []pricing.ModelPrice) (map[string]pricing.Candidate, error) {
	return nil, nil
}
func (bookPricing) SyncStateView(context.Context) (pricing.SyncState, bool, error) {
	return pricing.SyncState{LastError: "GET https://openrouter.ai: 502 upstream body", AutoSyncIntervalHours: 24}, true, nil
}
func (bookPricing) IsRunning() bool { return false }
func (f bookPricing) PreviewModeChange(_ context.Context, change pricing.ModeChange) (pricing.ModelPrice, error) {
	switch change.Mode {
	case pricing.ModeCustom:
		row := change.Price
		row.Source, row.Mode, row.PriceMultiplier = pricing.SourceManual, change.Mode, max(change.Multiplier, 1)
		return row, nil
	case pricing.ModeLinked:
		for _, upstream := range f.catalog {
			if upstream.ID == change.UpstreamID {
				return upstream.PriceFor(change.Model, pricing.MatchLinked, change.Multiplier, 0), nil
			}
		}
		return pricing.ModelPrice{}, fmt.Errorf("%w: %q", pricing.ErrUpstreamNotFound, change.UpstreamID)
	}
	return pricing.ModelPrice{}, fmt.Errorf("%w: %q", pricing.ErrNoAutomaticMatch, change.Model)
}

func pricingExecutor(t *testing.T) *capability.Executor {
	t.Helper()
	ctx := context.Background()
	database, err := repository.Open(ctx, filepath.Join(t.TempDir(), "pricing.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { database.Close() })
	repo := repository.New(database)
	cipher, err := appcrypto.New(strings.Repeat("p", 32))
	if err != nil {
		t.Fatal(err)
	}
	registry := capability.NewRegistry()
	service := &Service{Pricing: newBookPricing(), Repo: repo, Cipher: cipher}
	for _, register := range []func(*capability.Registry) error{service.registerPricing, service.registerUsage} {
		if err := register(registry); err != nil {
			t.Fatal(err)
		}
	}
	return &capability.Executor{Registry: registry, Store: repository.AgentStore{Repo: repo, Cipher: cipher}}
}

// A refused price is corrected by the agent before the operator is asked, so the
// refusal has to say which field was wrong on both adapters.
func TestPricingSetRefusalsNameWhatToChange(t *testing.T) {
	executor := pricingExecutor(t)
	for _, adapter := range []string{"agent", "mcp"} {
		principal := capability.Principal{ID: "administrator", Adapter: adapter, IsAdmin: true}
		for _, test := range []struct {
			arguments  string
			wantDetail string
		}{
			{`{"model":"deepseek-chat","mode":"custom","prompt_price_per_1m":2,"tiers":[{"utc_start":30,"utc_end":830,"time_zone":"Beijing"}]}`, "time_zone"},
			{`{"model":"deepseek-chat","mode":"custom","prompt_price_per_1m":2,"tiers":[{"utc_start":30}]}`, "utc_start and utc_end"},
			{`{"model":"deepseek-chat","mode":"linked"}`, "upstream_id"},
			{`{"model":"deepseek-chat","mode":"linked","upstream_id":"deepseek/nope"}`, "OpenRouter price list"},
			{`{"model":"house-model","mode":"auto"}`, "automatically"},
			{`{"model":"deepseek-chat","mode":"manual"}`, "auto, linked or custom"},
		} {
			result, err := executor.Invoke(context.Background(), principal, "pricing_set", json.RawMessage(test.arguments), "")
			if err != nil || result.Status != "error" || result.Code != "invalid_parameters" || !strings.Contains(result.Detail, test.wantDetail) {
				t.Errorf("%s %s: %+v %v, want invalid_parameters naming %q", adapter, test.arguments, result, err, test.wantDetail)
			}
		}
		result, err := executor.Invoke(context.Background(), principal, "pricing_set",
			json.RawMessage(`{"model":"deepseek-chat","mode":"custom","prompt_price_per_1m":2,"tiers":[{"utc_start":30,"utc_end":830,"time_zone":"Asia/Shanghai","prompt_price_per_1m":1}]}`), "")
		if err != nil || result.Status != "pending" || result.OperationID == "" {
			t.Errorf("%s: a valid zoned tier was not prepared for approval: %+v %v", adapter, result, err)
		}
	}
}

func TestPricingQuoteDryRunsAProposalOnItsOwnClock(t *testing.T) {
	service := &Service{Pricing: newBookPricing()}
	start, end, rate := 30, 830, 1.0
	proposed := &PriceInput{Model: "deepseek-chat", Mode: pricing.ModeCustom, Prompt: 2, Completion: 8,
		Tiers: []pricing.PriceTier{{UTCStart: &start, UTCEnd: &end, TimeZone: "Asia/Shanghai", PromptPricePer1M: &rate}}}
	at := func(hour int) int64 { return time.Date(2026, 10, 6, hour, 0, 0, 0, time.UTC).UnixMilli() }

	offPeak, err := service.QuotePrice(context.Background(), QuoteInput{Proposed: proposed, InputTokens: 1_000_000, TimestampMS: at(17)})
	if err != nil || offPeak.Breakdown.TierIndex == nil || offPeak.CostUSD != 1 {
		t.Fatalf("01:00 in Beijing: %+v %v, want the off-peak tier at $1", offPeak, err)
	}
	peak, err := service.QuotePrice(context.Background(), QuoteInput{Proposed: proposed, InputTokens: 1_000_000, TimestampMS: at(4), Channel: "relay"})
	if err != nil || peak.Breakdown.TierIndex != nil || peak.CostUSD != 1 || peak.Breakdown.ChannelMultiplier != 0.5 {
		t.Fatalf("12:00 in Beijing through a 0.5x channel: %+v %v, want base $2 halved", peak, err)
	}
	stored, err := service.QuotePrice(context.Background(), QuoteInput{Model: "gpt-5", InputTokens: 1_000_000, OutputTokens: 1_000_000})
	if err != nil || stored.CostUSD != 11.25 {
		t.Fatalf("stored price: %+v %v", stored, err)
	}
	for name, input := range map[string]QuoteInput{
		"an unpriced model":       {Model: "house-model", InputTokens: 1},
		"neither model nor draft": {InputTokens: 1},
		"negative tokens":         {Model: "gpt-5", InputTokens: -1},
	} {
		if _, err := service.QuotePrice(context.Background(), input); err == nil || err.Error() != "invalid_parameters" || capability.ErrorDetail(err) == "" {
			t.Errorf("%s: err = %v, want invalid_parameters with a detail", name, err)
		}
	}
}

func TestPricingCatalogSearchPutsTheExactIdFirst(t *testing.T) {
	service := &Service{Pricing: newBookPricing()}
	page, err := service.SearchPricingCatalog(context.Background(), CatalogSearchInput{Query: "deepseek chat"})
	if err != nil || page.Total != 2 || page.HasMore || len(page.Items) != 2 || page.Items[0].ID != "deepseek/deepseek-chat" {
		t.Fatalf("page = %+v %v, want both DeepSeek models with the exact id first", page, err)
	}
	if page.Items[0].Tiers == nil {
		t.Fatal("tiers must be a list on the wire")
	}
	if page, err = service.SearchPricingCatalog(context.Background(), CatalogSearchInput{Query: "claude"}); err != nil || page.Total != 0 || len(page.Items) != 0 {
		t.Fatalf("no match: %+v %v", page, err)
	}
	if page, err = service.SearchPricingCatalog(context.Background(), CatalogSearchInput{}); err != nil || page.Total != 3 {
		t.Fatalf("empty query lists the snapshot: %+v %v", page, err)
	}
}

func TestPricingOverviewCountsModesAndWithholdsTheSyncError(t *testing.T) {
	service := &Service{Pricing: newBookPricing()}
	overview, err := service.OverviewPricing(context.Background(), OffsetInput{})
	if err != nil {
		t.Fatal(err)
	}
	if overview.Coverage != (PriceCoverage{Auto: 1, Custom: 1, Unpriced: 2}) {
		t.Fatalf("coverage = %+v", overview.Coverage)
	}
	if !overview.Sync.HasFailed || overview.Sync.UpstreamModels != 3 || overview.Sync.AutoSyncIntervalHours != 24 {
		t.Fatalf("sync = %+v", overview.Sync)
	}
	raw, _ := json.Marshal(overview)
	if strings.Contains(string(raw), "upstream body") {
		t.Fatalf("the stored sync error reached the agent: %s", raw)
	}
	if len(overview.Unpriced) != 2 || overview.Unpriced[1].Model != "qwen-max" || len(overview.Unpriced[1].Suggestions) != 2 || len(overview.Unpriced[0].Suggestions) != 0 {
		t.Fatalf("unpriced = %+v", overview.Unpriced)
	}
}

func TestPricingReadsAreOfferedToBothAdapters(t *testing.T) {
	executor := pricingExecutor(t)
	for _, adapter := range []string{"agent", "mcp"} {
		principal := capability.Principal{ID: "administrator", Adapter: adapter, IsAdmin: true}
		for name, arguments := range map[string]string{
			"pricing_overview":       `{}`,
			"pricing_get":            `{"model":"deepseek-chat"}`,
			"pricing_catalog_search": `{"query":"gpt"}`,
			"pricing_quote":          `{"model":"gpt-5","input_tokens":1000}`,
		} {
			result, err := executor.Invoke(context.Background(), principal, name, json.RawMessage(arguments), "")
			if err != nil || result.Status != "success" {
				t.Errorf("%s %s: %+v %v", adapter, name, result, err)
			}
		}
		result, err := executor.Invoke(context.Background(), principal, "requests_cost_breakdown", json.RawMessage(`{"id":404}`), "")
		if err != nil || result.Status != "error" || result.Code != "resource_missing" {
			t.Errorf("%s: a missing request must be resource_missing: %+v %v", adapter, result, err)
		}
	}
}

// The breakdown is declared from repository types that were shaped for HTTP, so
// its inferred schema has to accept what the repository actually returns.
func TestRequestCostBreakdownResultsPassTheirOwnSchema(t *testing.T) {
	definition, err := pricingExecutor(t).Registry.Lookup("requests_cost_breakdown", capability.Principal{Adapter: "mcp", IsAdmin: true})
	if err != nil {
		t.Fatal(err)
	}
	nanos, tier, start, end := int64(1_000_000_000), int64(0), 30, 830
	price := pricing.ModelPrice{Model: "deepseek-chat", PromptPricePer1M: 2, PriceMultiplier: 1, Source: pricing.SourceManual,
		Tiers: []pricing.PriceTier{{UTCStart: &start, UTCEnd: &end, TimeZone: "Asia/Shanghai"}}}
	quote, err := pricing.Quote(price, 1, pricing.Tokens{Input: 1_000_000}, time.Date(2026, 10, 6, 17, 0, 0, 0, time.UTC).UnixMilli())
	if err != nil {
		t.Fatal(err)
	}
	for name, breakdown := range map[string]repository.RequestCostBreakdown{
		"unpriced": {Status: "unpriced"},
		"priced": {Status: "priced", StoredNanos: &nanos, StoredTier: &tier, Quote: &quote, RecomputedMatches: true,
			Version: &repository.PriceVersion{ID: 7, Available: true, Price: repository.VersionPrice{ModelPrice: price}}},
	} {
		if _, err := definition.ValidateOutput(breakdown); err != nil {
			t.Errorf("%s breakdown refused by its schema: %v", name, err)
		}
	}
}
