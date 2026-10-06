package operations

import (
	"context"
	"errors"
	"sort"
	"strings"
	"time"
	"unicode"

	"github.com/oh-my-cpa/oh-my-cpa/internal/capability"
	"github.com/oh-my-cpa/oh-my-cpa/internal/pricing"
	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
)

const (
	// PricingUsageWindow is the traffic shown beside each price.
	PricingUsageWindow = 30 * 24 * time.Hour
	// PricingProfileWindow is the traffic a cost preview samples for a typical request.
	PricingProfileWindow = 7 * 24 * time.Hour
	// pricingPageSize bounds every paged pricing read an agent makes.
	pricingPageSize = 20
)

type Pricing interface {
	ListPrices(context.Context) ([]pricing.ModelPrice, error)
	UsedUnpricedModels(context.Context, int) ([]string, error)
	Suggestions(context.Context, string, int) ([]pricing.UpstreamModel, error)
	AutomaticMatch(context.Context, string) (pricing.Match, bool, error)
	StoredCatalog(context.Context) ([]pricing.UpstreamModel, error)
	SyncStateView(context.Context) (pricing.SyncState, bool, error)
	IsRunning() bool
	PreviewModeChange(context.Context, pricing.ModeChange) (pricing.ModelPrice, error)
	Candidates(context.Context, []pricing.ModelPrice) (map[string]pricing.Candidate, error)
	SetModelModeChecked(context.Context, pricing.ModeChange, func([]pricing.ModelPrice) error) (pricing.ModelPrice, error)
	DeletePriceChecked(context.Context, string, func([]pricing.ModelPrice) error) (bool, error)
	ListChannels(context.Context) ([]pricing.ChannelMultiplier, error)
	SetChannelChecked(context.Context, pricing.ChannelMultiplier, func([]pricing.ChannelMultiplier) error) (pricing.ChannelMultiplier, error)
	DeleteChannelChecked(context.Context, string, func([]pricing.ChannelMultiplier) error) (bool, error)
	TriggerSync() bool
}
type PriceQuery struct {
	Model  string `json:"model,omitempty"`
	Offset int    `json:"offset,omitempty"`
}
type PricePage struct {
	Providers []pricing.CatalogProvider `json:"providers"`
	Items     []pricing.ModelPrice      `json:"items"`
	// Candidates names, per custom or linked model on this page, an OpenRouter
	// model it could follow that the operator has not acknowledged yet.
	Candidates map[string]pricing.Candidate `json:"candidates"`
	Channels   []pricing.ChannelMultiplier  `json:"channels"`
	HasMore    bool                         `json:"has_more"`
	Revision   string                       `json:"revision"`
}

func (s *Service) ListPrices(ctx context.Context, input PriceQuery) (PricePage, error) {
	if s.Pricing == nil {
		return PricePage{}, errors.New("capability_unavailable")
	}
	if input.Offset < 0 || input.Offset > 10000 {
		return PricePage{}, errors.New("invalid_parameters")
	}
	rows, err := s.Pricing.ListPrices(ctx)
	if err != nil {
		return PricePage{}, err
	}
	channels, err := s.Pricing.ListChannels(ctx)
	if err != nil {
		return PricePage{}, err
	}
	filtered := []pricing.ModelPrice{}
	for _, row := range rows {
		if input.Model == "" || strings.Contains(strings.ToLower(row.Model), strings.ToLower(input.Model)) {
			filtered = append(filtered, row)
		}
	}
	output := PricePage{Items: []pricing.ModelPrice{}, Channels: channels, Revision: s.revision(rows)}
	if output.Channels == nil {
		output.Channels = []pricing.ChannelMultiplier{}
	}
	if input.Offset < len(filtered) {
		end := min(input.Offset+50, len(filtered))
		output.Items = filtered[input.Offset:end]
		output.HasMore = end < len(filtered)
	}
	// Candidates are advisory: a failed lookup must not fail the price list, or
	// the pricing_set and pricing_delete previews that read it.
	output.Candidates, err = s.Pricing.Candidates(ctx, output.Items)
	if err != nil || output.Candidates == nil {
		output.Candidates = map[string]pricing.Candidate{}
	}
	output.Providers = []pricing.CatalogProvider{}
	if s.Repo != nil {
		providers, err := s.Repo.ListPricingProviders(ctx)
		if err != nil {
			return PricePage{}, err
		}
		selected := make(map[string]bool, len(output.Items))
		for _, item := range output.Items {
			selected[item.Model] = true
		}
		for _, provider := range providers {
			models := []string{}
			for _, model := range provider.Models {
				if selected[model] {
					models = append(models, model)
				}
			}
			if len(models) > 0 {
				provider.Models = models
				output.Providers = append(output.Providers, provider)
			}
		}
	}
	return output, nil
}

// PriceInput is one pricing decision an agent proposes. Rates and tiers only
// matter for mode "custom"; "linked" names an OpenRouter model id; "auto"
// returns the model to automatic matching.
type PriceInput struct {
	Model      string              `json:"model"`
	Mode       string              `json:"mode"`
	UpstreamID string              `json:"upstream_id,omitempty"`
	Prompt     float64             `json:"prompt_price_per_1m,omitempty"`
	Completion float64             `json:"completion_price_per_1m,omitempty"`
	CacheRead  float64             `json:"cache_read_price_per_1m,omitempty"`
	CacheWrite float64             `json:"cache_write_price_per_1m,omitempty"`
	Multiplier float64             `json:"price_multiplier,omitempty"`
	Tiers      []pricing.PriceTier `json:"tiers,omitempty"`
}

func (input PriceInput) modeChange() (pricing.ModeChange, error) {
	change := pricing.ModeChange{
		Model: strings.TrimSpace(input.Model), Mode: input.Mode, UpstreamID: strings.TrimSpace(input.UpstreamID), Multiplier: input.Multiplier,
		Price: pricing.ModelPrice{Model: strings.TrimSpace(input.Model), PromptPricePer1M: input.Prompt, CompletionPer1M: input.Completion,
			CacheReadPer1M: input.CacheRead, CacheWritePer1M: input.CacheWrite, Tiers: input.Tiers},
	}
	if change.Model == "" {
		return change, invalidParameters{"model is required"}
	}
	if change.Multiplier < 0 {
		return change, invalidParameters{"price_multiplier must be a positive number"}
	}
	switch change.Mode {
	case pricing.ModeCustom:
		candidate := change.Price
		candidate.PriceMultiplier = change.Multiplier
		if candidate.PriceMultiplier == 0 {
			candidate.PriceMultiplier = 1
		}
		candidate.Source = pricing.SourceManual
		if err := candidate.ValidateWrite(); err != nil {
			return change, invalidParameters{err.Error()}
		}
	case pricing.ModeLinked:
		if change.UpstreamID == "" {
			return change, invalidParameters{"mode linked needs upstream_id, an OpenRouter model id from pricing_catalog_search"}
		}
	case pricing.ModeAuto:
	default:
		return change, invalidParameters{pricing.ErrInvalidMode.Error()}
	}
	return change, nil
}

// pricingRefusal turns the pricing service's own refusals into a correctable
// invalid_parameters. Left as a plain failure, a write refused before it touched
// anything would be reported to the agent as an outcome nobody can know.
func pricingRefusal(err error) error {
	for _, refusal := range []error{pricing.ErrModelNotInCatalog, pricing.ErrUpstreamNotFound, pricing.ErrNoAutomaticMatch, pricing.ErrInvalidMode} {
		if errors.Is(err, refusal) {
			return invalidParameters{err.Error()}
		}
	}
	return err
}

// PriceUsage is recorded traffic in USD. CostUSD is absent, not zero, when no
// request in the window was priced.
type PriceUsage struct {
	Requests       int64    `json:"requests"`
	PricedRequests int64    `json:"priced_requests"`
	CostUSD        *float64 `json:"cost_usd,omitempty"`
}

func projectPriceUsage(usage repository.PricingUsage) PriceUsage {
	output := PriceUsage{Requests: usage.Requests, PricedRequests: usage.PricedRequests}
	if usage.PricedRequests > 0 {
		cost := float64(usage.CostNanos) / 1e9
		output.CostUSD = &cost
	}
	return output
}

type PriceMatch struct {
	Model     pricing.UpstreamModel `json:"model"`
	MatchKind string                `json:"match_kind"`
}

// PriceDetail is everything needed to decide one model's price in a single read.
type PriceDetail struct {
	Model       string                  `json:"model"`
	Price       *pricing.ModelPrice     `json:"price,omitempty"`
	Automatic   *PriceMatch             `json:"automatic,omitempty"`
	Suggestions []pricing.UpstreamModel `json:"suggestions"`
	Candidate   *pricing.Candidate      `json:"candidate,omitempty"`
	Channels    []string                `json:"channels"`
	Usage       PriceUsage              `json:"usage_30d"`
	Profile     repository.TokenProfile `json:"profile_7d"`
}

type PriceModelInput struct {
	Model string `json:"model" jsonschema:"Exact model name as pricing_list or pricing_overview returns it"`
}

func (s *Service) GetPrice(ctx context.Context, input PriceModelInput) (PriceDetail, error) {
	if s.Pricing == nil {
		return PriceDetail{}, errors.New("capability_unavailable")
	}
	model := strings.TrimSpace(input.Model)
	if model == "" {
		return PriceDetail{}, invalidParameters{"model is required"}
	}
	rows, err := s.Pricing.ListPrices(ctx)
	if err != nil {
		return PriceDetail{}, err
	}
	output := PriceDetail{Model: model, Suggestions: []pricing.UpstreamModel{}, Channels: []string{}}
	for index := range rows {
		if rows[index].Model == model {
			output.Price = &rows[index]
			break
		}
	}
	// Matches, suggestions and candidates are advice from the stored snapshot: a
	// failed lookup leaves them out rather than hiding the price itself.
	if match, found, err := s.Pricing.AutomaticMatch(ctx, model); err == nil && found {
		output.Automatic = &PriceMatch{Model: match.Model, MatchKind: match.Kind}
	}
	if suggestions, err := s.Pricing.Suggestions(ctx, model, 5); err == nil && suggestions != nil {
		output.Suggestions = suggestions
	}
	if output.Price != nil {
		if candidates, err := s.Pricing.Candidates(ctx, []pricing.ModelPrice{*output.Price}); err == nil {
			if candidate, ok := candidates[model]; ok {
				output.Candidate = &candidate
			}
		}
	}
	if s.Repo == nil {
		return output, nil
	}
	ctx, cancel := queryContext(ctx)
	defer cancel()
	now := time.UnixMilli(capability.AnchorMS(ctx))
	if usage, err := s.Repo.QueryPricingUsageByModel(ctx, now.Add(-PricingUsageWindow).UnixMilli()); err == nil {
		output.Usage = projectPriceUsage(usage[model])
	}
	if profile, err := s.Repo.QueryModelTokenProfile(ctx, model, now.Add(-PricingProfileWindow).UnixMilli()); err == nil {
		output.Profile = profile
	}
	if providers, err := s.Repo.ListPricingProviders(ctx); err == nil {
		seen := map[string]bool{}
		for _, provider := range providers {
			for _, served := range provider.Models {
				if served == model && provider.Channel != "" && !seen[provider.Channel] {
					seen[provider.Channel] = true
					output.Channels = append(output.Channels, provider.Channel)
				}
			}
		}
		sort.Strings(output.Channels)
	}
	return output, nil
}

// PricingSync is the sync bookkeeping an agent may read. The stored failure
// text is withheld: it can quote an upstream response.
type PricingSync struct {
	IsKnown               bool   `json:"is_known"`
	IsRunning             bool   `json:"is_running"`
	HasFailed             bool   `json:"has_failed"`
	LastSuccessAtMS       *int64 `json:"last_success_at_ms,omitempty"`
	NextSyncAtMS          *int64 `json:"next_sync_at_ms,omitempty"`
	AutoSyncIntervalHours int64  `json:"auto_sync_interval_hours"`
	UpstreamModels        int    `json:"upstream_models"`
}

type UpstreamRef struct {
	ID               string  `json:"id"`
	Name             string  `json:"name"`
	PromptPricePer1M float64 `json:"prompt_price_per_1m"`
	CompletionPer1M  float64 `json:"completion_price_per_1m"`
}

type UnpricedModel struct {
	Model       string        `json:"model"`
	Usage       PriceUsage    `json:"usage_30d"`
	Suggestions []UpstreamRef `json:"suggestions"`
}

type PriceCoverage struct {
	Auto     int `json:"auto"`
	Linked   int `json:"linked"`
	Custom   int `json:"custom"`
	Unpriced int `json:"unpriced"`
}

type PricingOverview struct {
	Sync     PricingSync     `json:"sync"`
	Coverage PriceCoverage   `json:"coverage"`
	Unpriced []UnpricedModel `json:"unpriced"`
	HasMore  bool            `json:"has_more"`
}

type OffsetInput struct {
	Offset int `json:"offset,omitempty"`
}

func (s *Service) OverviewPricing(ctx context.Context, input OffsetInput) (PricingOverview, error) {
	if s.Pricing == nil {
		return PricingOverview{}, errors.New("capability_unavailable")
	}
	if input.Offset < 0 || input.Offset > 10000 {
		return PricingOverview{}, invalidParameters{"offset must be between 0 and 10000"}
	}
	rows, err := s.Pricing.ListPrices(ctx)
	if err != nil {
		return PricingOverview{}, err
	}
	unpriced, err := s.Pricing.UsedUnpricedModels(ctx, 0)
	if err != nil {
		return PricingOverview{}, err
	}
	output := PricingOverview{Unpriced: []UnpricedModel{}, Coverage: PriceCoverage{Unpriced: len(unpriced)}}
	for _, row := range rows {
		switch row.Mode {
		case pricing.ModeCustom:
			output.Coverage.Custom++
		case pricing.ModeLinked:
			output.Coverage.Linked++
		default:
			output.Coverage.Auto++
		}
	}
	if state, known, err := s.Pricing.SyncStateView(ctx); err == nil {
		output.Sync = PricingSync{IsKnown: known, HasFailed: state.LastError != "", LastSuccessAtMS: state.LastSuccessAtMS,
			NextSyncAtMS: state.NextSyncAtMS, AutoSyncIntervalHours: state.AutoSyncIntervalHours}
	}
	output.Sync.IsRunning = s.Pricing.IsRunning()
	if catalog, err := s.Pricing.StoredCatalog(ctx); err == nil {
		output.Sync.UpstreamModels = len(catalog)
	}
	usage := map[string]repository.PricingUsage{}
	if s.Repo != nil {
		queryCtx, cancel := queryContext(ctx)
		defer cancel()
		since := time.UnixMilli(capability.AnchorMS(ctx)).Add(-PricingUsageWindow).UnixMilli()
		if read, err := s.Repo.QueryPricingUsageByModel(queryCtx, since); err == nil {
			usage = read
		}
	}
	// Busiest first: the model costing the most unaccounted traffic is the one to price first.
	sort.SliceStable(unpriced, func(i, j int) bool { return usage[unpriced[i]].Requests > usage[unpriced[j]].Requests })
	if input.Offset < len(unpriced) {
		end := min(input.Offset+pricingPageSize, len(unpriced))
		output.HasMore = end < len(unpriced)
		for _, model := range unpriced[input.Offset:end] {
			item := UnpricedModel{Model: model, Usage: projectPriceUsage(usage[model]), Suggestions: []UpstreamRef{}}
			suggestions, _ := s.Pricing.Suggestions(ctx, model, 2)
			for _, suggestion := range suggestions {
				item.Suggestions = append(item.Suggestions, UpstreamRef{ID: suggestion.ID, Name: suggestion.Name,
					PromptPricePer1M: suggestion.PromptPricePer1M, CompletionPer1M: suggestion.CompletionPer1M})
			}
			output.Unpriced = append(output.Unpriced, item)
		}
	}
	return output, nil
}

type CatalogSearchInput struct {
	Query  string `json:"query,omitempty" jsonschema:"Words from an OpenRouter id or name, such as deepseek chat; empty lists everything"`
	Offset int    `json:"offset,omitempty"`
}

type CatalogSearchPage struct {
	Items   []pricing.UpstreamModel `json:"items"`
	Total   int                     `json:"total"`
	HasMore bool                    `json:"has_more"`
}

// searchWords splits a query the way model names are written: on anything that
// is not a letter or a digit, so "gpt 5.4" finds "gpt-5.4".
func searchWords(value string) []string {
	return strings.FieldsFunc(strings.ToLower(value), func(r rune) bool { return !unicode.IsLetter(r) && !unicode.IsDigit(r) })
}

func (s *Service) SearchPricingCatalog(ctx context.Context, input CatalogSearchInput) (CatalogSearchPage, error) {
	if s.Pricing == nil {
		return CatalogSearchPage{}, errors.New("capability_unavailable")
	}
	if input.Offset < 0 || input.Offset > 10000 || len(input.Query) > 256 {
		return CatalogSearchPage{}, invalidParameters{"offset must be between 0 and 10000 and query at most 256 characters"}
	}
	catalog, err := s.Pricing.StoredCatalog(ctx)
	if err != nil {
		return CatalogSearchPage{}, err
	}
	words := searchWords(input.Query)
	needle := strings.Join(words, "")
	type ranked struct {
		model pricing.UpstreamModel
		rank  int
	}
	matches := []ranked{}
	for _, model := range catalog {
		haystack := strings.ToLower(model.ID + " " + model.Name + " " + model.CanonicalSlug)
		isMatch := true
		for _, word := range words {
			if !strings.Contains(haystack, word) {
				isMatch = false
				break
			}
		}
		if !isMatch {
			continue
		}
		// An id that is the query outranks one that merely starts with it, and both
		// outrank a match elsewhere in the name.
		rank := 2
		if needle != "" {
			for _, identity := range []string{model.ID, model.ID[strings.Index(model.ID, "/")+1:], model.CanonicalSlug} {
				compact := strings.Join(searchWords(identity), "")
				if compact == needle {
					rank = 0
				} else if rank > 1 && strings.HasPrefix(compact, needle) {
					rank = 1
				}
			}
		}
		matches = append(matches, ranked{model, rank})
	}
	sort.SliceStable(matches, func(i, j int) bool {
		left, right := matches[i], matches[j]
		if left.rank != right.rank {
			return left.rank < right.rank
		}
		if left.model.IsAlias() != right.model.IsAlias() {
			return !left.model.IsAlias()
		}
		return left.model.ID < right.model.ID
	})
	output := CatalogSearchPage{Items: []pricing.UpstreamModel{}, Total: len(matches)}
	if input.Offset < len(matches) {
		end := min(input.Offset+pricingPageSize, len(matches))
		output.HasMore = end < len(matches)
		for _, match := range matches[input.Offset:end] {
			if match.model.Tiers == nil {
				match.model.Tiers = []pricing.PriceTier{}
			}
			output.Items = append(output.Items, match.model)
		}
	}
	return output, nil
}

type QuoteInput struct {
	Model            string      `json:"model,omitempty" jsonschema:"Quote this model's stored price; omit when proposed is given"`
	Proposed         *PriceInput `json:"proposed,omitempty" jsonschema:"A pricing_set argument object to dry-run instead of the stored price; nothing is saved"`
	InputTokens      int64       `json:"input_tokens" jsonschema:"Full prompt tokens, cached tokens included"`
	OutputTokens     int64       `json:"output_tokens,omitempty"`
	CacheReadTokens  int64       `json:"cache_read_tokens,omitempty"`
	CacheWriteTokens int64       `json:"cache_write_tokens,omitempty"`
	TimestampMS      int64       `json:"timestamp_ms,omitempty" jsonschema:"Request instant in epoch milliseconds, which decides the time-of-day tier; defaults to now"`
	Channel          string      `json:"channel,omitempty" jsonschema:"Apply this channel's current multiplier; omit for 1x"`
}

type QuoteResult struct {
	Price       pricing.ModelPrice `json:"price"`
	TimestampMS int64              `json:"timestamp_ms"`
	Breakdown   pricing.Breakdown  `json:"breakdown"`
	CostUSD     float64            `json:"cost_usd"`
}

// QuotePrice prices one hypothetical request with the same rule the request lock
// uses, against the stored price or a proposal that is never saved.
func (s *Service) QuotePrice(ctx context.Context, input QuoteInput) (QuoteResult, error) {
	if s.Pricing == nil {
		return QuoteResult{}, errors.New("capability_unavailable")
	}
	if input.InputTokens < 0 || input.OutputTokens < 0 || input.CacheReadTokens < 0 || input.CacheWriteTokens < 0 || input.TimestampMS < 0 {
		return QuoteResult{}, invalidParameters{"token counts and timestamp_ms must not be negative"}
	}
	output := QuoteResult{TimestampMS: input.TimestampMS}
	if output.TimestampMS == 0 {
		output.TimestampMS = capability.AnchorMS(ctx)
	}
	model := strings.TrimSpace(input.Model)
	switch {
	case input.Proposed != nil:
		change, err := input.Proposed.modeChange()
		if err != nil {
			return QuoteResult{}, err
		}
		if output.Price, err = s.Pricing.PreviewModeChange(ctx, change); err != nil {
			return QuoteResult{}, pricingRefusal(err)
		}
	case model != "":
		rows, err := s.Pricing.ListPrices(ctx)
		if err != nil {
			return QuoteResult{}, err
		}
		found := false
		for _, row := range rows {
			if row.Model == model {
				output.Price, found = row, true
				break
			}
		}
		if !found {
			return QuoteResult{}, invalidParameters{"model has no stored price; pass proposed to dry-run one"}
		}
	default:
		return QuoteResult{}, invalidParameters{"model or proposed is required"}
	}
	multiplier := 1.0
	if channel := strings.TrimSpace(input.Channel); channel != "" {
		channels, err := s.Pricing.ListChannels(ctx)
		if err != nil {
			return QuoteResult{}, err
		}
		for _, configured := range channels {
			if configured.Channel == channel {
				multiplier = configured.Multiplier
			}
		}
	}
	breakdown, err := pricing.Quote(output.Price, multiplier, pricing.Tokens{Input: input.InputTokens, Output: input.OutputTokens,
		CacheRead: input.CacheReadTokens, CacheWrite: input.CacheWriteTokens}, output.TimestampMS)
	if err != nil {
		return QuoteResult{}, invalidParameters{err.Error()}
	}
	if output.Price.Tiers == nil {
		output.Price.Tiers = []pricing.PriceTier{}
	}
	output.Breakdown, output.CostUSD = breakdown, float64(breakdown.TotalNanos)/1e9
	return output, nil
}

type ChannelInput struct {
	Channel    string  `json:"channel"`
	Multiplier float64 `json:"multiplier"`
	Note       string  `json:"note,omitempty"`
}

func (s *Service) registerPricing(registry *capability.Registry) error {
	if err := read(registry, "pricing_list", "Read current model prices (mode auto, linked or custom, OpenRouter id, tiers), the OpenRouter candidates custom or linked models could now follow, and channel multipliers, paginated. Historical request cost snapshots do not change when current prices change.", s.ListPrices); err != nil {
		return err
	}
	if err := read(registry, "pricing_overview", "The first stop for pricing work: OpenRouter sync state, how many models are priced in each mode, and the unpriced models busiest first with their recent traffic and closest OpenRouter suggestions, paginated.", s.OverviewPricing); err != nil {
		return err
	}
	if err := read(registry, "pricing_get", "Read everything needed to price one model: its current price (absent when unpriced), what auto mode would match, OpenRouter suggestions, a pending candidate, the channels that serve it, 30-day traffic and the 7-day median request size.", s.GetPrice); err != nil {
		return err
	}
	if err := read(registry, "pricing_catalog_search", "Search the stored OpenRouter price list by id or name, 20 per page, to find the upstream_id for a linked price or published rates and tiers to copy into a custom one.", s.SearchPricingCatalog); err != nil {
		return err
	}
	if err := read(registry, "pricing_quote", "Price one hypothetical request with the rule recorded requests are billed by, against a model's stored price or a proposed pricing_set input that is not saved. The breakdown names the governing tier, so vary timestamp_ms or input_tokens to check a time-of-day window or long-context threshold before asking for approval.", s.QuotePrice); err != nil {
		return err
	}
	metadata := Meta("pricing_sync", "Request a price refresh from OpenRouter, the configured pricing source.", "write", "high")
	metadata.Invalidates = []string{"pricing"}
	if err := capability.Register(registry, metadata, func(context.Context, Empty) (capability.Preview, error) {
		if s.Pricing == nil {
			return capability.Preview{}, errors.New("capability_unavailable")
		}
		return capability.Preview{Target: "pricing", Revision: "sync", Changes: map[string]string{"action": "sync"}}, nil
	}, func(context.Context, Empty, string, string) (Done, error) {
		if s.Pricing == nil {
			return Done{}, errors.New("capability_unavailable")
		}
		return Done{s.Pricing.TriggerSync()}, nil
	}); err != nil {
		return err
	}
	metadata = Meta("pricing_set", "Decide how one model is priced for future requests: mode custom (operator rates in USD per 1M tokens and optional tiers), linked (follow one OpenRouter model id) or auto (automatic OpenRouter match). A time-of-day tier is read on its own time_zone, the vendor's billing clock, so off-peak hours published in Beijing time take Asia/Shanghai as written rather than a conversion to UTC. Verify with pricing_quote first. Historical snapshots never change.", "write", "high")
	metadata.Invalidates = []string{"pricing"}
	if err := capability.Register(registry, metadata, func(ctx context.Context, input PriceInput) (capability.Preview, error) {
		if s.Pricing == nil {
			return capability.Preview{}, errors.New("capability_unavailable")
		}
		change, err := input.modeChange()
		if err != nil {
			return capability.Preview{}, err
		}
		// Resolved before the operator is asked: a link to an unknown model or an
		// auto switch with no match is corrected by the agent, not approved and failed.
		if _, err := s.Pricing.PreviewModeChange(ctx, change); err != nil {
			return capability.Preview{}, pricingRefusal(err)
		}
		current, err := s.ListPrices(ctx, PriceQuery{})
		return capability.Preview{Target: change.Model, Revision: current.Revision, Changes: input}, err
	}, func(ctx context.Context, input PriceInput, revision, _ string) (Done, error) {
		if s.Pricing == nil {
			return Done{}, errors.New("capability_unavailable")
		}
		change, err := input.modeChange()
		if err != nil {
			return Done{}, err
		}
		_, err = s.Pricing.SetModelModeChecked(ctx, change, func(current []pricing.ModelPrice) error { return s.checkRevision(current, revision) })
		return Done{err == nil}, pricingRefusal(err)
	}); err != nil {
		return err
	}
	type DeleteInput struct {
		Model string `json:"model"`
	}
	metadata = Meta("pricing_delete", "Delete one current model price and its OpenRouter pin. A future sync may recreate an automatic price; historical snapshots remain unchanged.", "destructive", "high")
	metadata.Invalidates = []string{"pricing"}
	if err := capability.Register(registry, metadata, func(ctx context.Context, input DeleteInput) (capability.Preview, error) {
		if strings.TrimSpace(input.Model) == "" {
			return capability.Preview{}, errors.New("invalid_parameters")
		}
		current, err := s.ListPrices(ctx, PriceQuery{})
		return capability.Preview{Target: input.Model, Revision: current.Revision, Changes: input}, err
	}, func(ctx context.Context, input DeleteInput, revision, _ string) (Done, error) {
		if s.Pricing == nil {
			return Done{}, errors.New("capability_unavailable")
		}
		deleted, err := s.Pricing.DeletePriceChecked(ctx, input.Model, func(current []pricing.ModelPrice) error { return s.checkRevision(current, revision) })
		return Done{deleted}, err
	}); err != nil {
		return err
	}
	channelRevision := func(ctx context.Context) (string, error) {
		if s.Pricing == nil {
			return "", errors.New("capability_unavailable")
		}
		channels, err := s.Pricing.ListChannels(ctx)
		return s.revision(channels), err
	}
	metadata = Meta("pricing_channel_set", "Set the multiplier applied to every future request one CPA provider (channel) answers, on top of the model price; 0.3 means the channel costs 30% of list price. Historical snapshots never change.", "write", "high")
	metadata.Invalidates = []string{"pricing"}
	if err := capability.Register(registry, metadata, func(ctx context.Context, input ChannelInput) (capability.Preview, error) {
		channel := pricing.ChannelMultiplier{Channel: input.Channel, Multiplier: input.Multiplier, Note: input.Note}
		if channel.Validate() != nil {
			return capability.Preview{}, errors.New("invalid_parameters")
		}
		revision, err := channelRevision(ctx)
		return capability.Preview{Target: channel.Channel, Revision: revision, Changes: channel}, err
	}, func(ctx context.Context, input ChannelInput, revision, _ string) (Done, error) {
		if s.Pricing == nil {
			return Done{}, errors.New("capability_unavailable")
		}
		channel := pricing.ChannelMultiplier{Channel: input.Channel, Multiplier: input.Multiplier, Note: input.Note}
		_, err := s.Pricing.SetChannelChecked(ctx, channel, func(current []pricing.ChannelMultiplier) error { return s.checkRevision(current, revision) })
		return Done{err == nil}, err
	}); err != nil {
		return err
	}
	type ChannelDeleteInput struct {
		Channel string `json:"channel"`
	}
	metadata = Meta("pricing_channel_delete", "Remove one channel multiplier, returning that CPA provider to 1x for future requests. Historical snapshots never change.", "destructive", "high")
	metadata.Invalidates = []string{"pricing"}
	return capability.Register(registry, metadata, func(ctx context.Context, input ChannelDeleteInput) (capability.Preview, error) {
		if strings.TrimSpace(input.Channel) == "" {
			return capability.Preview{}, errors.New("invalid_parameters")
		}
		revision, err := channelRevision(ctx)
		return capability.Preview{Target: input.Channel, Revision: revision, Changes: input}, err
	}, func(ctx context.Context, input ChannelDeleteInput, revision, _ string) (Done, error) {
		if s.Pricing == nil {
			return Done{}, errors.New("capability_unavailable")
		}
		deleted, err := s.Pricing.DeleteChannelChecked(ctx, input.Channel, func(current []pricing.ChannelMultiplier) error { return s.checkRevision(current, revision) })
		return Done{deleted}, err
	})
}
