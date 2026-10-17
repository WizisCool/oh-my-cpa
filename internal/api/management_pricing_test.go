package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/oh-my-cpa/oh-my-cpa/internal/pricing"
	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
)

type fakePricing struct {
	listRows    []pricing.ModelPrice
	unpriced    []string
	suggestions []pricing.UpstreamModel
	catalog     []pricing.UpstreamModel
	channels    []pricing.ChannelMultiplier
	state       pricing.SyncState
	known       bool
	running     bool
	acceptSync  bool
	changes     []pricing.ModeChange
	changeErr   error
	deleted     []string
	channelSets []pricing.ChannelMultiplier
	channelDels []string
	started     bool
	stateErr    error
	notifyCount atomic.Int32
	candidates  map[string]pricing.Candidate
	dismissed   []string
}

func (f *fakePricing) ListPrices(context.Context) ([]pricing.ModelPrice, error) {
	return f.listRows, nil
}
func (f *fakePricing) UsedUnpricedModels(context.Context, int) ([]string, error) {
	return f.unpriced, nil
}
func (f *fakePricing) Suggestions(context.Context, string, int) ([]pricing.UpstreamModel, error) {
	return f.suggestions, nil
}
func (f *fakePricing) AutomaticMatch(context.Context, string) (pricing.Match, bool, error) {
	if len(f.suggestions) == 0 {
		return pricing.Match{}, false, nil
	}
	return pricing.Match{Model: f.suggestions[0], Kind: pricing.MatchExact}, true, nil
}
func (f *fakePricing) Candidates(_ context.Context, prices []pricing.ModelPrice) (map[string]pricing.Candidate, error) {
	result := map[string]pricing.Candidate{}
	for _, price := range prices {
		if candidate, ok := f.candidates[price.Model]; ok {
			result[price.Model] = candidate
		}
	}
	return result, nil
}
func (f *fakePricing) DismissCandidate(_ context.Context, model, upstreamID string) error {
	if model == "" || upstreamID == "" {
		return pricing.ErrInvalidReview
	}
	f.dismissed = append(f.dismissed, model+"="+upstreamID)
	delete(f.candidates, model)
	return nil
}
func (f *fakePricing) StoredCatalog(context.Context) ([]pricing.UpstreamModel, error) {
	return f.catalog, nil
}
func (f *fakePricing) SyncStateView(context.Context) (pricing.SyncState, bool, error) {
	if f.stateErr != nil {
		return pricing.SyncState{}, false, f.stateErr
	}
	return f.state, f.known, nil
}
func (f *fakePricing) SetModelMode(ctx context.Context, change pricing.ModeChange) (pricing.ModelPrice, error) {
	return f.SetModelModeChecked(ctx, change, nil)
}
func (f *fakePricing) SetModelModeChecked(_ context.Context, change pricing.ModeChange, check func([]pricing.ModelPrice) error) (pricing.ModelPrice, error) {
	if check != nil {
		if err := check(f.listRows); err != nil {
			return pricing.ModelPrice{}, err
		}
	}
	if f.changeErr != nil {
		return pricing.ModelPrice{}, f.changeErr
	}
	f.changes = append(f.changes, change)
	return pricing.ModelPrice{Model: change.Model, Mode: change.Mode, UpstreamID: change.UpstreamID}, nil
}
func (f *fakePricing) PreviewModeChange(_ context.Context, change pricing.ModeChange) (pricing.ModelPrice, error) {
	if f.changeErr != nil {
		return pricing.ModelPrice{}, f.changeErr
	}
	row := change.Price
	row.Model, row.Mode, row.UpstreamID, row.PriceMultiplier = change.Model, change.Mode, change.UpstreamID, max(change.Multiplier, 1)
	return row, nil
}
func (f *fakePricing) DeletePrice(ctx context.Context, model string) (bool, error) {
	return f.DeletePriceChecked(ctx, model, nil)
}

func (f *fakePricing) DeleteChannelPrice(_ context.Context, channel, model string) (bool, error) {
	f.deleted = append(f.deleted, channel+"/"+model)
	return true, nil
}
func (f *fakePricing) DeletePriceChecked(_ context.Context, model string, check func([]pricing.ModelPrice) error) (bool, error) {
	if check != nil {
		if err := check(f.listRows); err != nil {
			return false, err
		}
	}
	f.deleted = append(f.deleted, model)
	return true, nil
}
func (f *fakePricing) ListChannels(context.Context) ([]pricing.ChannelMultiplier, error) {
	return f.channels, nil
}
func (f *fakePricing) SetChannel(ctx context.Context, channel pricing.ChannelMultiplier) (pricing.ChannelMultiplier, error) {
	return f.SetChannelChecked(ctx, channel, nil)
}
func (f *fakePricing) SetChannelChecked(_ context.Context, channel pricing.ChannelMultiplier, check func([]pricing.ChannelMultiplier) error) (pricing.ChannelMultiplier, error) {
	if check != nil {
		if err := check(f.channels); err != nil {
			return pricing.ChannelMultiplier{}, err
		}
	}
	if err := channel.Validate(); err != nil {
		return pricing.ChannelMultiplier{}, err
	}
	f.channelSets = append(f.channelSets, channel)
	return channel, nil
}
func (f *fakePricing) DeleteChannel(ctx context.Context, channel string) (bool, error) {
	return f.DeleteChannelChecked(ctx, channel, nil)
}
func (f *fakePricing) DeleteChannelChecked(_ context.Context, channel string, check func([]pricing.ChannelMultiplier) error) (bool, error) {
	if check != nil {
		if err := check(f.channels); err != nil {
			return false, err
		}
	}
	f.channelDels = append(f.channelDels, channel)
	return true, nil
}
func (f *fakePricing) TriggerSync() bool {
	f.started = true
	return f.acceptSync
}
func (f *fakePricing) NotifyModelsChanged() {
	f.notifyCount.Add(1)
	f.TriggerSync()
}
func (f *fakePricing) IsRunning() bool { return f.running }
func (f *fakePricing) SetAutoSyncInterval(_ context.Context, hours int64) error {
	f.state.AutoSyncIntervalHours = hours
	return nil
}

// startPricingTestServer boots the real router with a fake pricing manager
// attached through the same SetPricing seam the app uses at startup.
func startPricingTestServer(t *testing.T, fake *fakePricing) (*http.Client, string) {
	t.Helper()
	client, baseURL, _ := startDashboardTestServer(t, nil, func(handler *Handler) {
		handler.SetPricing(fake)
	})
	return client, baseURL
}

func TestPricingWithoutServiceReturnsUnavailable(t *testing.T) {
	client, baseURL, _ := startDashboardTestServer(t, nil)
	response, payload := getJSON(t, client, baseURL+"/omc/api/v1/pricing")
	if response.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("pricing without service status = %d body %s", response.StatusCode, payload)
	}
}

func TestPricingPageEndpointShape(t *testing.T) {
	fake := &fakePricing{
		listRows: []pricing.ModelPrice{{
			Model: "openai/gpt-5", PromptPricePer1M: 2, CompletionPer1M: 10, PriceMultiplier: 1,
			Source: pricing.SourceOpenRouter, UpstreamID: "openai/gpt-5", MatchKind: pricing.MatchExact, Mode: pricing.ModeAuto,
		}},
		unpriced:    []string{"mystery-model"},
		suggestions: []pricing.UpstreamModel{{ID: "vendor/mystery", PromptPricePer1M: 1}},
		catalog:     []pricing.UpstreamModel{{ID: "openai/gpt-5"}, {ID: "vendor/mystery"}},
		channels:    []pricing.ChannelMultiplier{{Channel: "relay", Multiplier: 0.3}},
		state:       pricing.SyncState{Source: pricing.SourceOpenRouter, LastMatched: 3, LastUnmatched: 1},
		known:       true,
	}
	client, baseURL := startPricingTestServer(t, fake)
	response, payload := getJSON(t, client, baseURL+"/omc/api/v1/pricing")
	if response.StatusCode != http.StatusOK {
		t.Fatalf("pricing status = %d body %s", response.StatusCode, payload)
	}
	var body struct {
		Source string `json:"source"`
		Models []struct {
			Model string `json:"model"`
			Mode  string `json:"mode"`
			Usage *struct {
				Requests int64    `json:"requests"`
				CostUSD  *float64 `json:"cost_usd"`
			} `json:"usage_30d"`
		} `json:"models"`
		Unpriced []struct {
			Model       string                  `json:"model"`
			Suggestions []pricing.UpstreamModel `json:"suggestions"`
		} `json:"unpriced"`
		Channels []struct {
			Channel      string  `json:"channel"`
			Multiplier   float64 `json:"multiplier"`
			IsConfigured bool    `json:"is_configured"`
		} `json:"channels"`
		UpstreamCount int `json:"upstream_count"`
		Sync          struct {
			Known bool `json:"known"`
		} `json:"sync"`
	}
	if err := json.Unmarshal(payload, &body); err != nil {
		t.Fatal(err)
	}
	if body.Source != pricing.SourceOpenRouter || len(body.Models) != 1 || body.Models[0].Mode != pricing.ModeAuto || body.Models[0].Usage == nil || !body.Sync.Known {
		t.Fatalf("unexpected pricing body: %s", payload)
	}
	// No traffic is no known cost, not a zero cost.
	if body.Models[0].Usage.CostUSD != nil {
		t.Fatalf("a model without priced traffic reported a cost: %s", payload)
	}
	if len(body.Unpriced) != 1 || body.Unpriced[0].Suggestions[0].ID != "vendor/mystery" {
		t.Fatalf("unpriced models must carry suggestions: %s", payload)
	}
	if len(body.Channels) != 1 || !body.Channels[0].IsConfigured || body.Channels[0].Multiplier != 0.3 || body.UpstreamCount != 2 {
		t.Fatalf("channels or upstream count: %s", payload)
	}
	response, payload = getJSON(t, client, baseURL+"/omc/api/v1/pricing/attention")
	if response.StatusCode != http.StatusOK || !strings.Contains(string(payload), "mystery-model") {
		t.Fatalf("attention: %d %s", response.StatusCode, payload)
	}
	response, payload = getJSON(t, client, baseURL+"/omc/api/v1/pricing/catalog")
	if response.StatusCode != http.StatusOK || !strings.Contains(string(payload), "vendor/mystery") {
		t.Fatalf("catalog: %d %s", response.StatusCode, payload)
	}
}

func TestPricingModelModeChangesAndRefusals(t *testing.T) {
	fake := &fakePricing{acceptSync: true}
	client, baseURL := startPricingTestServer(t, fake)
	put := func(model, body string) (*http.Response, []byte) {
		return doJSON(t, client, http.MethodPut, baseURL+"/omc/api/v1/pricing/models/"+model, body)
	}
	// Unknown fields are rejected so a typo cannot silently change rates.
	if response, _ := put("m", `{"mode":"custom","unknown_field":1}`); response.StatusCode != http.StatusBadRequest {
		t.Fatalf("unknown field status = %d", response.StatusCode)
	}
	if response, _ := put("m", `{"mode":"custom","prompt_price_per_1m":-1}`); response.StatusCode != http.StatusBadRequest {
		t.Fatalf("negative rate status = %d", response.StatusCode)
	}
	response, payload := put("m", `{"mode":"custom","prompt_price_per_1m":5,"completion_price_per_1m":5,"price_multiplier":1,"tiers":[{"min_prompt_tokens":200000,"prompt_price_per_1m":10}]}`)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("custom status = %d %s", response.StatusCode, payload)
	}
	if len(fake.changes) != 1 || fake.changes[0].Mode != pricing.ModeCustom || fake.changes[0].Price.PromptPricePer1M != 5 || len(fake.changes[0].Price.Tiers) != 1 {
		t.Fatalf("custom change not routed: %+v", fake.changes)
	}
	// A model name with a slash arrives encoded and must be decoded, or the
	// handler would act on a name that does not exist.
	if response, payload := put("openai%2Fgpt-5", `{"mode":"linked","upstream_id":"openai/gpt-5"}`); response.StatusCode != http.StatusOK {
		t.Fatalf("linked status = %d %s", response.StatusCode, payload)
	}
	if last := fake.changes[len(fake.changes)-1]; last.Model != "openai/gpt-5" || last.UpstreamID != "openai/gpt-5" {
		t.Fatalf("encoded model not decoded: %+v", last)
	}
	fake.changeErr = pricing.ErrNoAutomaticMatch
	response, payload = put("m", `{"mode":"auto"}`)
	if response.StatusCode != http.StatusBadRequest || !strings.Contains(string(payload), "pricing_no_automatic_match") {
		t.Fatalf("refusal code: %d %s", response.StatusCode, payload)
	}
	fake.changeErr = nil
	del, _ := http.NewRequest(http.MethodDelete, baseURL+"/omc/api/v1/pricing/models/openai%2Fgpt-5", nil)
	response, err := client.Do(del)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusOK || len(fake.deleted) != 1 || fake.deleted[0] != "openai/gpt-5" {
		t.Fatalf("delete: %d %+v", response.StatusCode, fake.deleted)
	}
	response, payload = getJSON(t, client, baseURL+"/omc/api/v1/pricing/models/openai%2Fgpt-5")
	if response.StatusCode != http.StatusOK || !strings.Contains(string(payload), `"model":"openai/gpt-5"`) {
		t.Fatalf("model detail: %d %s", response.StatusCode, payload)
	}
	// Sync: 202 on start, 409 while one is already in flight.
	response, _ = doJSON(t, client, http.MethodPost, baseURL+"/omc/api/v1/pricing/sync", "")
	if response.StatusCode != http.StatusAccepted {
		t.Fatalf("sync start status = %d", response.StatusCode)
	}
	fake.running, fake.acceptSync = true, false
	response, _ = doJSON(t, client, http.MethodPost, baseURL+"/omc/api/v1/pricing/sync", "")
	if response.StatusCode != http.StatusConflict {
		t.Fatalf("conflicting sync status = %d", response.StatusCode)
	}
}

func TestPricingChannelEndpoints(t *testing.T) {
	fake := &fakePricing{}
	client, baseURL := startPricingTestServer(t, fake)
	response, payload := doJSON(t, client, http.MethodPut, baseURL+"/omc/api/v1/pricing/channels/openai-compatible-relay%2Fus", `{"multiplier":0.3,"note":"resells at 30%"}`)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("channel set: %d %s", response.StatusCode, payload)
	}
	if len(fake.channelSets) != 1 || fake.channelSets[0].Channel != "openai-compatible-relay/us" || fake.channelSets[0].Multiplier != 0.3 {
		t.Fatalf("channel not routed: %+v", fake.channelSets)
	}
	if response, _ := doJSON(t, client, http.MethodPut, baseURL+"/omc/api/v1/pricing/channels/relay", `{"multiplier":0}`); response.StatusCode != http.StatusBadRequest {
		t.Fatalf("zero multiplier status = %d", response.StatusCode)
	}
	del, _ := http.NewRequest(http.MethodDelete, baseURL+"/omc/api/v1/pricing/channels/relay", nil)
	response, err := client.Do(del)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusOK || len(fake.channelDels) != 1 {
		t.Fatalf("channel delete: %d %+v", response.StatusCode, fake.channelDels)
	}
}

// Sync bookkeeping is a side panel, not a precondition for pricing. When its row
// cannot be read at all, the page must still get every price and see the reason
// as a sync error instead of a blank 500 screen.
func TestPricingPageDegradesWhenSyncStateUnreadable(t *testing.T) {
	fake := &fakePricing{
		listRows: []pricing.ModelPrice{{Model: "openai/gpt-5", PromptPricePer1M: 2, CompletionPer1M: 10, PriceMultiplier: 1, Source: pricing.SourceOpenRouter}},
		unpriced: []string{"mystery-model"},
		stateErr: errors.New("corrupt sync state"),
	}
	client, baseURL := startPricingTestServer(t, fake)
	response, payload := getJSON(t, client, baseURL+"/omc/api/v1/pricing")
	if response.StatusCode != http.StatusOK {
		t.Fatalf("pricing status = %d body %s", response.StatusCode, payload)
	}
	var body struct {
		Models   []json.RawMessage `json:"models"`
		Unpriced []json.RawMessage `json:"unpriced"`
		Sync     struct {
			Known bool              `json:"known"`
			State pricing.SyncState `json:"state"`
		} `json:"sync"`
	}
	if err := json.Unmarshal(payload, &body); err != nil {
		t.Fatal(err)
	}
	if len(body.Models) != 1 || len(body.Unpriced) != 1 {
		t.Fatalf("prices must still load: %s", payload)
	}
	if body.Sync.Known || !strings.Contains(body.Sync.State.LastError, "corrupt sync state") {
		t.Fatalf("an unreadable state must report known=false with its reason: %s", payload)
	}
}

func TestUpdatePricingSyncSchedule(t *testing.T) {
	fake := &fakePricing{state: pricing.SyncState{Source: pricing.SourceOpenRouter, AutoSyncIntervalHours: 24}, known: true}
	client, baseURL := startPricingTestServer(t, fake)
	response, payload := doJSON(t, client, http.MethodPut, baseURL+"/omc/api/v1/pricing/sync-schedule", `{"interval_hours":6}`)
	if response.StatusCode != http.StatusOK || fake.state.AutoSyncIntervalHours != 6 {
		t.Fatalf("update schedule status = %d body %s", response.StatusCode, payload)
	}
	response, payload = doJSON(t, client, http.MethodPut, baseURL+"/omc/api/v1/pricing/sync-schedule", `{"interval_hours":0}`)
	if response.StatusCode != http.StatusOK || fake.state.AutoSyncIntervalHours != 0 {
		t.Fatalf("disable schedule status = %d body %s", response.StatusCode, payload)
	}
	response, _ = doJSON(t, client, http.MethodPut, baseURL+"/omc/api/v1/pricing/sync-schedule", `{"interval_hours":999}`)
	if response.StatusCode != http.StatusBadRequest {
		t.Fatalf("invalid schedule status = %d, want 400", response.StatusCode)
	}
}

func TestPricingProvidersUseCurrentIdentityOverlays(t *testing.T) {
	fake := &fakePricing{}
	client, baseURL, _ := startDashboardTestServer(t, nil, func(handler *Handler) {
		handler.SetPricing(fake)
		ctx := context.Background()
		providers := []pricing.CatalogProvider{
			{ID: "openai-compat-0", Family: "openai-compatibility", Name: "upstream", Channel: "openai-compatible-upstream", Priority: 10, Models: []string{"gpt-5"}},
			{ID: "oauth:codex", Family: "codex", Name: "codex", Channel: "codex", IsOAuth: true, Models: []string{"gpt-5"}},
		}
		if _, err := handler.repo.ReplacePricingModels(ctx, map[string]string{"gpt-5": "gpt-5"}, providers...); err != nil {
			t.Fatal(err)
		}
		if err := handler.repo.PutPreference(ctx, "provider_names", `{"openai-compat-0":"Team Relay","oauth:codex":"Team OAuth"}`); err != nil {
			t.Fatal(err)
		}
		if err := handler.repo.PutPreference(ctx, "provider_icons", `{"openai-compat-0":"DeepSeek","oauth:codex":"Codex"}`); err != nil {
			t.Fatal(err)
		}
	})
	response, payload := getJSON(t, client, baseURL+"/omc/api/v1/pricing")
	if response.StatusCode != http.StatusOK {
		t.Fatalf("status=%d: %s", response.StatusCode, payload)
	}
	var result struct {
		Providers []pricingProviderDTO `json:"providers"`
	}
	if err := json.Unmarshal(payload, &result); err != nil {
		t.Fatal(err)
	}
	if len(result.Providers) != 2 || result.Providers[0].Name != "Team Relay" || result.Providers[0].IconID != "DeepSeek" || result.Providers[1].Name != "Team OAuth" || !result.Providers[1].IsOAuth {
		t.Fatalf("providers: %+v", result.Providers)
	}
}

// A custom price carries the OpenRouter model it could now follow, and the
// operator can dismiss it without touching the price.
func TestPricingCandidatesAndDismissal(t *testing.T) {
	newModel := pricing.UpstreamModel{ID: "vendor/brand-new", PromptPricePer1M: 3, CompletionPer1M: 6}
	fake := &fakePricing{
		listRows: []pricing.ModelPrice{
			{Model: "brand-new", PromptPricePer1M: 1, CompletionPer1M: 2, PriceMultiplier: 1, Source: pricing.SourceManual, Mode: pricing.ModeCustom},
			{Model: "steady", PromptPricePer1M: 1, CompletionPer1M: 2, PriceMultiplier: 1, Source: pricing.SourceManual, Mode: pricing.ModeCustom},
		},
		candidates: map[string]pricing.Candidate{"brand-new": {Model: newModel, Kind: pricing.CandidateAutomatic, MatchKind: pricing.MatchExact}},
	}
	client, baseURL := startPricingTestServer(t, fake)
	response, payload := getJSON(t, client, baseURL+"/omc/api/v1/pricing")
	if response.StatusCode != http.StatusOK {
		t.Fatalf("pricing status = %d body %s", response.StatusCode, payload)
	}
	var body struct {
		Models []struct {
			Model     string             `json:"model"`
			Candidate *pricing.Candidate `json:"candidate"`
		} `json:"models"`
	}
	if err := json.Unmarshal(payload, &body); err != nil {
		t.Fatal(err)
	}
	if len(body.Models) != 2 || body.Models[0].Candidate == nil || body.Models[0].Candidate.Model.ID != newModel.ID ||
		body.Models[0].Candidate.Kind != pricing.CandidateAutomatic || body.Models[1].Candidate != nil {
		t.Fatalf("candidates not projected onto their rows: %s", payload)
	}
	response, payload = getJSON(t, client, baseURL+"/omc/api/v1/pricing/models/brand-new")
	if response.StatusCode != http.StatusOK || !strings.Contains(string(payload), `"candidate":{"model":{"id":"vendor/brand-new"`) {
		t.Fatalf("model detail candidate: %d %s", response.StatusCode, payload)
	}

	dismiss := func(model, body string) (*http.Response, []byte) {
		return doJSON(t, client, http.MethodPost, baseURL+"/omc/api/v1/pricing/models/"+model+"/dismiss-candidate", body)
	}
	if response, payload := dismiss("brand-new", `{"upstream_id":""}`); response.StatusCode != http.StatusBadRequest || !strings.Contains(string(payload), "pricing_invalid_review") {
		t.Fatalf("empty dismissal: %d %s", response.StatusCode, payload)
	}
	if response, _ := dismiss("brand-new", `{"upstream_id":"vendor/brand-new","extra":1}`); response.StatusCode != http.StatusBadRequest {
		t.Fatalf("unknown field accepted: %d", response.StatusCode)
	}
	if response, payload := dismiss("brand-new", `{"upstream_id":"vendor/brand-new"}`); response.StatusCode != http.StatusOK {
		t.Fatalf("dismissal: %d %s", response.StatusCode, payload)
	}
	if len(fake.dismissed) != 1 || fake.dismissed[0] != "brand-new=vendor/brand-new" || len(fake.changes) != 0 {
		t.Fatalf("dismissal routed wrong or changed a price: %+v %+v", fake.dismissed, fake.changes)
	}
	if _, payload := getJSON(t, client, baseURL+"/omc/api/v1/pricing"); strings.Contains(string(payload), `"candidate"`) {
		t.Fatalf("a dismissed candidate is still offered: %s", payload)
	}
}

func assertPricingJSON(t *testing.T, actual []byte, expected string) {
	t.Helper()
	var got, want any
	if err := json.Unmarshal(actual, &got); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal([]byte(expected), &want); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("wire response = %s, want %s", actual, expected)
	}
}

func TestPricingModelPriceWireShape(t *testing.T) {
	start, end := 0, 830
	prompt, completion, cacheRead, cacheWrite := 1.5, 2.5, 0.0, 3.5
	for _, tc := range []struct {
		name, channel, mode, tiersJSON, optionalJSON string
		tiers                                        []pricing.PriceTier
	}{
		{name: "null tiers and omitted optional fields", tiersJSON: "null"},
		{name: "empty tiers", mode: pricing.ModeAuto, tiers: []pricing.PriceTier{}, tiersJSON: "[]", optionalJSON: `,"mode":"auto"`},
		{name: "channel and nested tier fields", channel: "relay/us", mode: pricing.ModeCustom,
			tiers: []pricing.PriceTier{{MinPromptTokens: 128000, UTCStart: &start, UTCEnd: &end, TimeZone: "Asia/Shanghai",
				PromptPricePer1M: &prompt, CompletionPer1M: &completion, CacheReadPer1M: &cacheRead, CacheWritePer1M: &cacheWrite}, {}},
			tiersJSON:    `[{"min_prompt_tokens":128000,"utc_start":0,"utc_end":830,"time_zone":"Asia/Shanghai","prompt_price_per_1m":1.5,"completion_price_per_1m":2.5,"cache_read_price_per_1m":0,"cache_write_price_per_1m":3.5},{}]`,
			optionalJSON: `,"channel":"relay/us","mode":"custom"`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			row := pricing.ModelPrice{Model: "vendor/model", Channel: tc.channel, Mode: tc.mode,
				PromptPricePer1M: 2, CompletionPer1M: 10, CacheReadPer1M: 0.2, CacheWritePer1M: 2.5,
				PriceMultiplier: 0.75, Tiers: tc.tiers, Source: pricing.SourceManual,
				UpstreamID: "vendor/reference", MatchKind: pricing.MatchLinked, SyncedAtMS: 123, UpdatedAtMS: 456}
			client, baseURL := startPricingTestServer(t, &fakePricing{listRows: []pricing.ModelPrice{row}})
			want := fmt.Sprintf(`{"model":"vendor/model","prompt_price_per_1m":2,"completion_price_per_1m":10,"cache_read_price_per_1m":0.2,"cache_write_price_per_1m":2.5,"price_multiplier":0.75,"tiers":%s,"source":"manual","upstream_id":"vendor/reference","match_kind":"linked","synced_at_ms":123,"updated_at_ms":456%s}`, tc.tiersJSON, tc.optionalJSON)
			response, payload := getJSON(t, client, baseURL+"/omc/api/v1/pricing")
			var book struct {
				Models        []map[string]json.RawMessage `json:"models"`
				ChannelModels json.RawMessage              `json:"channel_models"`
			}
			if err := json.Unmarshal(payload, &book); err != nil {
				t.Fatal(err)
			}
			if response.StatusCode != http.StatusOK || len(book.Models) != 1 || book.ChannelModels != nil {
				t.Fatalf("price book: %d %s", response.StatusCode, payload)
			}
			assertPricingJSON(t, book.Models[0]["usage_30d"], `{"requests":0,"priced_requests":0,"cost_usd":null}`)
			delete(book.Models[0], "usage_30d")
			encoded, err := json.Marshal(book.Models[0])
			if err != nil {
				t.Fatal(err)
			}
			assertPricingJSON(t, encoded, want)
			response, payload = getJSON(t, client, baseURL+"/omc/api/v1/pricing/models/vendor%2Fmodel")
			var detail map[string]json.RawMessage
			if err := json.Unmarshal(payload, &detail); err != nil {
				t.Fatal(err)
			}
			if response.StatusCode != http.StatusOK || detail["channel"] != nil || detail["is_inherited"] != nil {
				t.Fatalf("unscoped detail: %d %s", response.StatusCode, payload)
			}
			assertPricingJSON(t, detail["price"], want)
		})
	}
}

func startChannelPricingTestServer(t *testing.T) (*http.Client, string, *repository.Repository) {
	t.Helper()
	client, baseURL, repo := startDashboardTestServer(t, nil, func(handler *Handler) {
		handler.SetPricing(pricing.NewService(handler.repo, nil, nil))
	})
	ctx := context.Background()
	if _, err := repo.ReplacePricingModels(ctx, map[string]string{"vendor/model": "vendor/model"},
		pricing.CatalogProvider{ID: "openai-compat-0", Channel: "华为云/us+west", Models: []string{"vendor/model"}}); err != nil {
		t.Fatal(err)
	}
	if err := repo.UpsertModelPrices(ctx, []pricing.ModelPrice{{Model: "vendor/model", PromptPricePer1M: 2,
		CompletionPer1M: 10, PriceMultiplier: 1, Source: pricing.SourceManual}}); err != nil {
		t.Fatal(err)
	}
	return client, baseURL, repo
}

func TestPricingChannelModelParameterRouting(t *testing.T) {
	fake := &fakePricing{}
	client, baseURL := startPricingTestServer(t, fake)
	for _, channel := range []string{" \t华为云/us+west\n ", " \t "} {
		target := baseURL + "/omc/api/v1/pricing/models/%20vendor%2Fmodel%20?channel=" + url.QueryEscape(channel)
		response, payload := doJSON(t, client, http.MethodPut, target, `{"mode":"custom"}`)
		if response.StatusCode != http.StatusOK {
			t.Fatalf("PUT: %d %s", response.StatusCode, payload)
		}
		change := fake.changes[len(fake.changes)-1]
		if change.Model != "vendor/model" || change.Channel != strings.TrimSpace(channel) {
			t.Fatalf("parameters routed before normalization: %+v", change)
		}
		response, payload = doJSON(t, client, http.MethodDelete, target, "")
		if response.StatusCode != http.StatusOK {
			t.Fatalf("DELETE: %d %s", response.StatusCode, payload)
		}
		assertPricingJSON(t, payload, `{"deleted":true}`)
		want := "vendor/model"
		if trimmed := strings.TrimSpace(channel); trimmed != "" {
			want = trimmed + "/" + want
		}
		if deleted := fake.deleted[len(fake.deleted)-1]; deleted != want {
			t.Fatalf("delete target = %q, want %q", deleted, want)
		}
	}
}

func TestPricingChannelModelEndpoints(t *testing.T) {
	client, baseURL, repo := startChannelPricingTestServer(t)
	endpoint := baseURL + "/omc/api/v1/pricing/models/vendor%2Fmodel"
	scoped := endpoint + "?channel=" + url.QueryEscape(" \t华为云/us+west\n ")
	read := func(target string) map[string]json.RawMessage {
		t.Helper()
		response, payload := getJSON(t, client, target)
		if response.StatusCode != http.StatusOK {
			t.Fatalf("GET: %d %s", response.StatusCode, payload)
		}
		var result map[string]json.RawMessage
		if err := json.Unmarshal(payload, &result); err != nil {
			t.Fatal(err)
		}
		return result
	}
	shared := read(endpoint)["price"]
	assertPricingJSON(t, read(endpoint + "?channel=+%09+")["price"], string(shared))
	inherited := read(scoped)
	assertPricingJSON(t, inherited["channel"], `"华为云/us+west"`)
	assertPricingJSON(t, inherited["is_inherited"], `true`)
	assertPricingJSON(t, inherited["price"], string(shared))
	assertPricingJSON(t, inherited["versions"], `[]`)
	unpriced := read(baseURL + "/omc/api/v1/pricing/models/unknown?channel=other")
	assertPricingJSON(t, unpriced["price"], `null`)
	assertPricingJSON(t, unpriced["is_inherited"], `true`)

	body := `{"mode":"custom","prompt_price_per_1m":3,"completion_price_per_1m":6,"cache_read_price_per_1m":0.3,"cache_write_price_per_1m":3.75,"price_multiplier":0.5,"tiers":[{"utc_start":0,"utc_end":830,"time_zone":"Asia/Shanghai","prompt_price_per_1m":1.5}]}`
	response, payload := doJSON(t, client, http.MethodPut, scoped, body)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("PUT: %d %s", response.StatusCode, payload)
	}
	wantPrice := `{"model":"vendor/model","channel":"华为云/us+west","prompt_price_per_1m":3,"completion_price_per_1m":6,"cache_read_price_per_1m":0.3,"cache_write_price_per_1m":3.75,"price_multiplier":0.5,"tiers":[{"utc_start":0,"utc_end":830,"time_zone":"Asia/Shanghai","prompt_price_per_1m":1.5}],"source":"manual","upstream_id":"","match_kind":"","mode":"custom","synced_at_ms":0,"updated_at_ms":0}`
	assertPricingJSON(t, payload, `{"price":`+wantPrice+`}`)
	current := read(scoped)
	assertPricingJSON(t, current["channel"], `"华为云/us+west"`)
	assertPricingJSON(t, current["is_inherited"], `false`)
	assertPricingJSON(t, current["candidate"], `null`)
	var price map[string]json.RawMessage
	if err := json.Unmarshal(current["price"], &price); err != nil {
		t.Fatal(err)
	}
	var updated int64
	if err := json.Unmarshal(price["updated_at_ms"], &updated); err != nil || updated <= 0 {
		t.Fatalf("stored update timestamp = %s, err %v", price["updated_at_ms"], err)
	}
	price["updated_at_ms"] = json.RawMessage(`0`)
	encoded, err := json.Marshal(price)
	if err != nil {
		t.Fatal(err)
	}
	assertPricingJSON(t, encoded, wantPrice)
	var versions []map[string]json.RawMessage
	if err := json.Unmarshal(current["versions"], &versions); err != nil || len(versions) != 1 {
		t.Fatalf("channel versions = %s, err %v", current["versions"], err)
	}
	assertPricingJSON(t, versions[0]["available"], `true`)
	assertPricingJSON(t, versions[0]["price"], `{"model":"vendor/model","channel":"华为云/us+west","prompt_price_per_1m":3,"completion_price_per_1m":6,"cache_read_price_per_1m":0.3,"cache_write_price_per_1m":3.75,"price_multiplier":0.5,"tiers":[{"utc_start":0,"utc_end":830,"time_zone":"Asia/Shanghai","prompt_price_per_1m":1.5}],"source":"manual","upstream_id":""}`)
	assertPricingJSON(t, read(endpoint)["price"], string(shared))
	assertPricingJSON(t, read(endpoint + "?channel=other")["is_inherited"], `true`)
	book := read(baseURL + "/omc/api/v1/pricing")
	assertPricingJSON(t, book["channel_models"], "["+string(current["price"])+"]")
	if err := repo.UpsertChannelModelPrice(context.Background(), pricing.ModelPrice{
		Model: "vendor/model", Channel: "other", PromptPricePer1M: 99, PriceMultiplier: 1, Source: pricing.SourceManual,
	}); err != nil {
		t.Fatal(err)
	}

	for _, want := range []string{`{"deleted":true}`, `{"deleted":false}`} {
		response, payload = doJSON(t, client, http.MethodDelete, scoped, "")
		if response.StatusCode != http.StatusOK {
			t.Fatalf("DELETE: %d %s", response.StatusCode, payload)
		}
		assertPricingJSON(t, payload, want)
	}
	restored := read(scoped)
	assertPricingJSON(t, restored["is_inherited"], `true`)
	assertPricingJSON(t, restored["price"], string(shared))
	if err := json.Unmarshal(restored["versions"], &versions); err != nil || len(versions) != 2 {
		t.Fatalf("channel history = %s, err %v", restored["versions"], err)
	}
	assertPricingJSON(t, versions[0]["available"], `false`)
	if rows, err := repo.ListChannelModelPrices(context.Background()); err != nil || len(rows) != 1 || rows[0].Channel != "other" || rows[0].PromptPricePer1M != 99 {
		t.Fatalf("scoped deletion affected another channel: %+v, %v", rows, err)
	}
	response, payload = doJSON(t, client, http.MethodDelete, endpoint+"?channel=other", "")
	if response.StatusCode != http.StatusOK {
		t.Fatalf("DELETE other: %d %s", response.StatusCode, payload)
	}
	if book := read(baseURL + "/omc/api/v1/pricing"); book["channel_models"] != nil {
		t.Fatalf("empty channel_models must be omitted: %s", book["channel_models"])
	}
}

func TestPricingChannelModelRefusals(t *testing.T) {
	client, baseURL, repo := startChannelPricingTestServer(t)
	endpoint := baseURL + "/omc/api/v1/pricing/models/vendor%2Fmodel?channel=" + url.QueryEscape(" 华为云/us+west ")
	for _, tc := range []struct{ name, target, body, code string }{
		{"unknown channel", baseURL + "/omc/api/v1/pricing/models/vendor%2Fmodel?channel=unknown", `{"mode":"custom"}`, "pricing_model_not_in_catalog"},
		{"unknown model", baseURL + "/omc/api/v1/pricing/models/unknown?channel=" + url.QueryEscape("华为云/us+west"), `{"mode":"custom"}`, "pricing_model_not_in_catalog"},
		{"automatic channel price", endpoint, `{"mode":"auto"}`, "pricing_invalid_mode"},
		{"linked channel price", endpoint, `{"mode":"linked","upstream_id":"vendor/model"}`, "pricing_invalid_mode"},
		{"unknown field", endpoint, `{"mode":"custom","unknown":true}`, ""},
		{"negative rate", endpoint, `{"mode":"custom","prompt_price_per_1m":-1}`, ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			response, payload := doJSON(t, client, http.MethodPut, tc.target, tc.body)
			if response.StatusCode != http.StatusBadRequest || tc.code != "" && !strings.Contains(string(payload), `"code":"`+tc.code+`"`) {
				t.Fatalf("refusal: %d %s", response.StatusCode, payload)
			}
		})
	}
	if rows, err := repo.ListChannelModelPrices(context.Background()); err != nil || len(rows) != 0 {
		t.Fatalf("refused writes changed channel prices: %+v, %v", rows, err)
	}
}

func TestPricingChannelModelReadFailureReturnsInternalError(t *testing.T) {
	fake := &fakePricing{listRows: []pricing.ModelPrice{{Model: "vendor/model"}}}
	client, baseURL, repo := startDashboardTestServer(t, nil, func(handler *Handler) { handler.SetPricing(fake) })
	if err := repo.SQL().Close(); err != nil {
		t.Fatal(err)
	}
	for _, target := range []string{"/pricing", "/pricing/models/vendor%2Fmodel?channel=relay"} {
		response, payload := getJSON(t, client, baseURL+"/omc/api/v1"+target)
		if response.StatusCode != http.StatusInternalServerError || strings.Contains(string(payload), `"price"`) || strings.Contains(string(payload), `"models"`) {
			t.Fatalf("an unreadable override must not expose a fallback price: %d %s", response.StatusCode, payload)
		}
	}
}
