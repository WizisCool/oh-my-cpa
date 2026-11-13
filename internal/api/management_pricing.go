package api

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"sort"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/oh-my-cpa/oh-my-cpa/internal/operations"
	"github.com/oh-my-cpa/oh-my-cpa/internal/pricing"
	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
)

// PricingManager is the handler-facing view of the pricing service. The concrete
// *pricing.Service is wired once at startup; tests inject a fake here.
type PricingManager interface {
	ListPrices(ctx context.Context) ([]pricing.ModelPrice, error)
	UsedUnpricedModels(ctx context.Context, limit int) ([]string, error)
	Suggestions(ctx context.Context, model string, limit int) ([]pricing.UpstreamModel, error)
	AutomaticMatch(ctx context.Context, model string) (pricing.Match, bool, error)
	Candidates(ctx context.Context, prices []pricing.ModelPrice) (map[string]pricing.Candidate, error)
	DismissCandidate(ctx context.Context, model, upstreamID string) error
	StoredCatalog(ctx context.Context) ([]pricing.UpstreamModel, error)
	SyncStateView(ctx context.Context) (pricing.SyncState, bool, error)
	PreviewModeChange(ctx context.Context, change pricing.ModeChange) (pricing.ModelPrice, error)
	SetModelMode(ctx context.Context, change pricing.ModeChange) (pricing.ModelPrice, error)
	SetModelModeChecked(context.Context, pricing.ModeChange, func([]pricing.ModelPrice) error) (pricing.ModelPrice, error)
	DeletePrice(ctx context.Context, model string) (bool, error)
	DeleteChannelPrice(context.Context, string, string) (bool, error)
	DeletePriceChecked(context.Context, string, func([]pricing.ModelPrice) error) (bool, error)
	ListChannels(ctx context.Context) ([]pricing.ChannelMultiplier, error)
	SetChannel(ctx context.Context, channel pricing.ChannelMultiplier) (pricing.ChannelMultiplier, error)
	SetChannelChecked(context.Context, pricing.ChannelMultiplier, func([]pricing.ChannelMultiplier) error) (pricing.ChannelMultiplier, error)
	DeleteChannel(ctx context.Context, channel string) (bool, error)
	DeleteChannelChecked(context.Context, string, func([]pricing.ChannelMultiplier) error) (bool, error)
	TriggerSync() bool
	NotifyModelsChanged()
	IsRunning() bool
	SetAutoSyncInterval(ctx context.Context, hours int64) error
}

// SetPricing attaches the pricing service after construction so the app can
// keep the handler builder simple and keep tests free of a real service.
func (h *Handler) SetPricing(manager PricingManager) {
	h.pricing = manager
}

// The price book and the agent's pricing reads describe the same traffic windows.
const (
	pricingUsageWindow     = operations.PricingUsageWindow
	pricingProfileWindow   = operations.PricingProfileWindow
	pricingSuggestionLimit = 3
)

// pricingUsageDTO is recorded traffic in the console's money unit.
type pricingUsageDTO struct {
	Requests       int64    `json:"requests"`
	PricedRequests int64    `json:"priced_requests"`
	CostUSD        *float64 `json:"cost_usd"`
}

func projectPricingUsage(usage repository.PricingUsage) pricingUsageDTO {
	dto := pricingUsageDTO{Requests: usage.Requests, PricedRequests: usage.PricedRequests}
	// No priced request means no known cost, which is not a zero cost.
	if usage.PricedRequests > 0 {
		cost := float64(usage.CostNanos) / 1e9
		dto.CostUSD = &cost
	}
	return dto
}

type pricingPriceTierDTO struct {
	ServiceTiers     []string `json:"service_tiers,omitempty"`
	MinPromptTokens  int64    `json:"min_prompt_tokens,omitempty"`
	UTCStart         *int     `json:"utc_start,omitempty"`
	UTCEnd           *int     `json:"utc_end,omitempty"`
	TimeZone         string   `json:"time_zone,omitempty"`
	PromptPricePer1M *float64 `json:"prompt_price_per_1m,omitempty"`
	CompletionPer1M  *float64 `json:"completion_price_per_1m,omitempty"`
	CacheReadPer1M   *float64 `json:"cache_read_price_per_1m,omitempty"`
	CacheWritePer1M  *float64 `json:"cache_write_price_per_1m,omitempty"`
}

type pricingModelPriceDTO struct {
	Model            string                `json:"model"`
	Channel          string                `json:"channel,omitempty"`
	PromptPricePer1M float64               `json:"prompt_price_per_1m"`
	CompletionPer1M  float64               `json:"completion_price_per_1m"`
	CacheReadPer1M   float64               `json:"cache_read_price_per_1m"`
	CacheWritePer1M  float64               `json:"cache_write_price_per_1m"`
	PriceMultiplier  float64               `json:"price_multiplier"`
	Tiers            []pricingPriceTierDTO `json:"tiers"`
	Source           string                `json:"source"`
	UpstreamID       string                `json:"upstream_id"`
	MatchKind        string                `json:"match_kind"`
	Mode             string                `json:"mode,omitempty"`
	SyncedAtMS       int64                 `json:"synced_at_ms"`
	UpdatedAtMS      int64                 `json:"updated_at_ms"`
}

func projectPricingModel(row pricing.ModelPrice) pricingModelPriceDTO {
	var tiers []pricingPriceTierDTO
	if row.Tiers != nil {
		tiers = make([]pricingPriceTierDTO, len(row.Tiers))
		for index, tier := range row.Tiers {
			tiers[index] = pricingPriceTierDTO{
				ServiceTiers:    tier.ServiceTiers,
				MinPromptTokens: tier.MinPromptTokens, UTCStart: tier.UTCStart, UTCEnd: tier.UTCEnd, TimeZone: tier.TimeZone,
				PromptPricePer1M: tier.PromptPricePer1M, CompletionPer1M: tier.CompletionPer1M,
				CacheReadPer1M: tier.CacheReadPer1M, CacheWritePer1M: tier.CacheWritePer1M,
			}
		}
	}
	return pricingModelPriceDTO{
		Model: row.Model, Channel: row.Channel, PromptPricePer1M: row.PromptPricePer1M, CompletionPer1M: row.CompletionPer1M,
		CacheReadPer1M: row.CacheReadPer1M, CacheWritePer1M: row.CacheWritePer1M, PriceMultiplier: row.PriceMultiplier,
		Tiers: tiers, Source: row.Source, UpstreamID: row.UpstreamID, MatchKind: row.MatchKind, Mode: row.Mode,
		SyncedAtMS: row.SyncedAtMS, UpdatedAtMS: row.UpdatedAtMS,
	}
}

type pricingModelDTO struct {
	pricingModelPriceDTO
	Usage pricingUsageDTO `json:"usage_30d"`
	// Candidate is an OpenRouter model a custom or linked price could follow
	// that the operator has not seen yet.
	Candidate *pricing.Candidate `json:"candidate,omitempty"`
}

// History omits current-row bookkeeping, preserving its existing wire format.
type pricingVersionPriceDTO struct {
	pricingModelPriceDTO
	MatchKind   string `json:"match_kind,omitempty"`
	Mode        string `json:"mode,omitempty"`
	SyncedAtMS  int64  `json:"synced_at_ms,omitempty"`
	UpdatedAtMS int64  `json:"updated_at_ms,omitempty"`
}

type pricingPriceVersionDTO struct {
	ID              int64                  `json:"id"`
	Available       bool                   `json:"available"`
	EffectiveFromMS int64                  `json:"effective_from_ms"`
	Price           pricingVersionPriceDTO `json:"price"`
}

type pricingUnpricedDTO struct {
	Model       string                  `json:"model"`
	Usage       pricingUsageDTO         `json:"usage_30d"`
	Suggestions []pricing.UpstreamModel `json:"suggestions"`
}

// pricingReferencePriceDTO is a models.dev rate offered beside an unmatched model; it is
// advice the editor can copy into a custom price, never a price itself.
type pricingReferencePriceDTO struct {
	Source           string   `json:"source"`
	Model            string   `json:"model"`
	Providers        []string `json:"providers"`
	PromptPricePer1M float64  `json:"prompt_price_per_1m"`
	CompletionPer1M  float64  `json:"completion_price_per_1m"`
	CacheReadPer1M   *float64 `json:"cache_read_price_per_1m,omitempty"`
	CacheWritePer1M  *float64 `json:"cache_write_price_per_1m,omitempty"`
}

func projectPricingReferences(prices []operations.ReferencePrice) []pricingReferencePriceDTO {
	projected := make([]pricingReferencePriceDTO, len(prices))
	for index, price := range prices {
		projected[index] = pricingReferencePriceDTO{Source: price.Source, Model: price.Model, Providers: price.Providers,
			PromptPricePer1M: price.PromptPricePer1M, CompletionPer1M: price.CompletionPer1M,
			CacheReadPer1M: price.CacheReadPer1M, CacheWritePer1M: price.CacheWritePer1M}
	}
	return projected
}

type pricingProviderDTO struct {
	pricing.CatalogProvider
	IconID string `json:"icon_id,omitempty"`
}

type pricingChannelDTO struct {
	Channel      string          `json:"channel"`
	Multiplier   float64         `json:"multiplier"`
	Note         string          `json:"note"`
	UpdatedAtMS  int64           `json:"updated_at_ms"`
	IsConfigured bool            `json:"is_configured"`
	Usage        pricingUsageDTO `json:"usage_30d"`
}

func (h *Handler) requirePricing(writer http.ResponseWriter) bool {
	if h.pricing == nil {
		writeError(writer, http.StatusServiceUnavailable, "pricing service is not available")
		return false
	}
	return true
}

// pricingPathParam reads a model or channel from the path. chi matches on the
// raw path, so an encoded "/" in "openai/gpt-5" arrives still escaped and has to
// be decoded here, or the handler would act on a name that does not exist.
func pricingPathParam(request *http.Request, name string) (string, bool) {
	value, err := url.PathUnescape(chi.URLParam(request, name))
	if err != nil {
		return "", false
	}
	value = strings.TrimSpace(value)
	return value, value != ""
}

// PricingSyncInfoDTO summarizes the OpenRouter pricing sync status.
type PricingSyncInfoDTO struct {
	Known   bool              `json:"known"`
	Running bool              `json:"running"`
	State   pricing.SyncState `json:"state"`
}

// PricingBookResponseDTO returns the complete price book, unpriced models, channels, and sync status.
type PricingBookResponseDTO struct {
	Source        string                 `json:"source"`
	Providers     []pricingProviderDTO   `json:"providers"`
	Models        []pricingModelDTO      `json:"models"`
	Unpriced      []pricingUnpricedDTO   `json:"unpriced"`
	Channels      []pricingChannelDTO    `json:"channels"`
	UpstreamCount int                    `json:"upstream_count"`
	Sync          PricingSyncInfoDTO     `json:"sync"`
	ChannelModels []pricingModelPriceDTO `json:"channel_models,omitempty"`
	Partial       []string               `json:"partial,omitempty"`
}

// PricingAttentionResponseDTO lists models observed in usage that currently lack a price.
type PricingAttentionResponseDTO struct {
	Unpriced []string `json:"unpriced"`
}

// PricingCatalogResponseDTO wraps the stored upstream OpenRouter model catalog.
type PricingCatalogResponseDTO struct {
	Models []pricing.UpstreamModel `json:"models"`
}

// PricingAutomaticMatchDTO describes the upstream model selected by automatic matching.
type PricingAutomaticMatchDTO struct {
	Model     pricing.UpstreamModel `json:"model"`
	MatchKind string                `json:"match_kind"`
}

// PricingModelDetailResponseDTO returns the editor view for a single model or channel override.
type PricingModelDetailResponseDTO struct {
	Model           string                     `json:"model"`
	Price           *pricingModelPriceDTO      `json:"price"`
	Suggestions     []pricing.UpstreamModel    `json:"suggestions"`
	Automatic       *PricingAutomaticMatchDTO  `json:"automatic"`
	ReferencePrices []pricingReferencePriceDTO `json:"reference_prices"`
	Candidate       *pricing.Candidate         `json:"candidate"`
	Versions        []pricingPriceVersionDTO   `json:"versions"`
	Profile         repository.TokenProfile    `json:"profile"`
	Channel         string                     `json:"channel,omitempty"`
	IsInherited     *bool                      `json:"is_inherited,omitempty"`
}

// PricingModelUpdateResponseDTO wraps the saved model price row.
type PricingModelUpdateResponseDTO struct {
	Price pricingModelPriceDTO `json:"price"`
}

// DismissPricingCandidateRequestDTO names the upstream candidate being dismissed for a model.
type DismissPricingCandidateRequestDTO struct {
	UpstreamID string `json:"upstream_id"`
}

// PricingDismissedResponseDTO acknowledges candidate dismissal.
type PricingDismissedResponseDTO struct {
	Dismissed bool `json:"dismissed"`
}

// PricingDeletedResponseDTO reports whether a model price or channel multiplier was deleted.
type PricingDeletedResponseDTO struct {
	Deleted bool `json:"deleted"`
}

// PricingChannelUpdateResponseDTO wraps the saved channel multiplier.
type PricingChannelUpdateResponseDTO struct {
	Channel pricing.ChannelMultiplier `json:"channel"`
}

// PricingSyncStartResponseDTO acknowledges background OpenRouter pricing sync launch.
type PricingSyncStartResponseDTO struct {
	Started bool `json:"started"`
}

// PricingSyncScheduleResponseDTO returns the updated auto-sync interval and sync state.
type PricingSyncScheduleResponseDTO struct {
	IntervalHours int64             `json:"interval_hours"`
	Known         bool              `json:"known"`
	State         pricing.SyncState `json:"state"`
}

// listPricing returns the price book in one round trip: every priced model with
// its recent traffic, the unpriced models with candidates to adopt, the channel
// multipliers beside the channels traffic actually used, and the sync state.
// A missing service keeps the endpoint honest with 503 instead of an empty table.
//
// @Summary List model price book
// @Description Return priced models, unpriced models with suggestions, channel multipliers, providers, and OpenRouter sync state.
// @Tags Pricing
// @Produce json
// @Security CookieAuth
// @Success 200 {object} PricingBookResponseDTO
// @Failure 401 {object} ErrorResponseDTO
// @Failure 500 {object} ErrorResponseDTO
// @Failure 503 {object} ErrorResponseDTO
// @Router /v1/pricing [get]
func (h *Handler) listPricing(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	if !h.requirePricing(writer) {
		return
	}
	ctx := request.Context()
	rows, err := h.pricing.ListPrices(ctx)
	if err != nil {
		writeInternalError(writer, err)
		return
	}
	unpriced, err := h.pricing.UsedUnpricedModels(ctx, 0)
	if err != nil {
		writeInternalError(writer, err)
		return
	}
	channels, err := h.pricing.ListChannels(ctx)
	if err != nil {
		writeInternalError(writer, err)
		return
	}
	var partial []string
	since := h.now().Add(-pricingUsageWindow).UnixMilli()
	modelUsage, channelUsage := map[string]repository.PricingUsage{}, map[string]repository.PricingUsage{}
	if h.repo != nil {
		// Traffic is context, not the price book: a failed read leaves the columns
		// empty rather than the page.
		if modelUsage, err = h.repo.QueryPricingUsageByModel(ctx, since); err != nil {
			slog.Warn("pricing model usage unavailable", "error", err)
			partial, modelUsage = append(partial, "usage"), map[string]repository.PricingUsage{}
		}
		if channelUsage, err = h.repo.QueryPricingUsageByChannel(ctx, since); err != nil {
			slog.Warn("pricing channel usage unavailable", "error", err)
			partial, channelUsage = append(partial, "usage"), map[string]repository.PricingUsage{}
		}
	}
	// Candidates are advice beside the book: a failed read leaves them out and
	// names it in partial rather than failing the page.
	candidates, err := h.pricing.Candidates(ctx, rows)
	if err != nil {
		slog.Warn("pricing candidates unavailable", "error", err)
		partial, candidates = append(partial, "candidates"), nil
	}
	models := make([]pricingModelDTO, 0, len(rows))
	for _, row := range rows {
		dto := pricingModelDTO{pricingModelPriceDTO: projectPricingModel(row), Usage: projectPricingUsage(modelUsage[row.Model])}
		if candidate, ok := candidates[row.Model]; ok {
			dto.Candidate = &candidate
		}
		models = append(models, dto)
	}
	attention := make([]pricingUnpricedDTO, 0, len(unpriced))
	var batchedSuggestions map[string][]pricing.UpstreamModel
	useBatch := false
	if batcher, ok := h.pricing.(interface {
		SuggestionsBatch(context.Context, []string, int) (map[string][]pricing.UpstreamModel, error)
	}); ok && len(unpriced) > 0 {
		useBatch = true
		var errBatch error
		batchedSuggestions, errBatch = batcher.SuggestionsBatch(ctx, unpriced, pricingSuggestionLimit)
		if errBatch != nil {
			slog.Warn("pricing suggestions unavailable", "error", errBatch)
			// One retry covers a transient store hiccup without re-reading the
			// catalog once per unpriced model when the store is persistently down.
			batchedSuggestions, _ = batcher.SuggestionsBatch(ctx, unpriced, pricingSuggestionLimit)
		}
	}
	suggestFailed := false
	for _, model := range unpriced {
		var suggestions []pricing.UpstreamModel
		if useBatch {
			if batchedSuggestions != nil {
				suggestions = batchedSuggestions[model]
			}
		} else if !suggestFailed {
			var errSuggest error
			suggestions, errSuggest = h.pricing.Suggestions(ctx, model, pricingSuggestionLimit)
			if errSuggest != nil {
				slog.Warn("pricing suggestions unavailable", "model", model, "error", errSuggest)
				suggestFailed = true
			}
		}
		if suggestions == nil {
			suggestions = []pricing.UpstreamModel{}
		}
		attention = append(attention, pricingUnpricedDTO{Model: model, Usage: projectPricingUsage(modelUsage[model]), Suggestions: suggestions})
	}
	// Sync bookkeeping is auxiliary. Pricing the recorded traffic must not depend
	// on it, so a state read that still fails degrades to "unknown" with the
	// reason shown as last_error instead of blanking the whole page.
	state, known, err := h.pricing.SyncStateView(ctx)
	if err != nil {
		slog.Warn("pricing sync state unavailable", "error", err)
		state = pricing.SyncState{Source: pricing.SourceOpenRouter, LastError: err.Error()}
		known = false
	}
	upstreamCount := 0
	if catalog, err := h.pricing.StoredCatalog(ctx); err == nil {
		upstreamCount = len(catalog)
	}
	providers := []pricingProviderDTO{}
	if h.repo != nil {
		memberships, readErr := h.repo.ListPricingProviders(ctx)
		if readErr != nil {
			slog.Warn("pricing provider membership unavailable", "error", readErr)
			partial = append(partial, "providers")
		} else {
			names, icons := h.loadProviderNames(ctx), h.loadProviderIcons(ctx)
			for _, provider := range memberships {
				name := provider.Name
				if spec, ok := lookupProviderConfigFamily(provider.Family); ok && !provider.IsOAuth {
					name = spec.DefaultName
					if provider.Prefix != "" {
						name = fmt.Sprintf("%s (%s)", spec.PrefixLabel, provider.Prefix)
					}
				}
				if name == "" {
					name = provider.Family
				}
				if custom := names[provider.ID]; custom != "" {
					name = custom
				}
				provider.Name = name
				providers = append(providers, pricingProviderDTO{CatalogProvider: provider, IconID: firstNonEmpty(icons[provider.ID], icons[name])})
			}
		}
	}
	response := PricingBookResponseDTO{
		Source:        pricing.SourceOpenRouter,
		Providers:     providers,
		Models:        models,
		Unpriced:      attention,
		Channels:      mergePricingChannels(channels, channelUsage),
		UpstreamCount: upstreamCount,
		Sync: PricingSyncInfoDTO{
			Known:   known,
			Running: h.pricing.IsRunning(),
			State:   state,
		},
		Partial: partial,
	}
	if h.repo != nil {
		overrides, err := h.repo.ListChannelModelPrices(ctx)
		if err != nil {
			writeInternalError(writer, err)
			return
		}
		if len(overrides) > 0 {
			prices := make([]pricingModelPriceDTO, len(overrides))
			for index, row := range overrides {
				prices[index] = projectPricingModel(row)
			}
			response.ChannelModels = prices
		}
	}
	writeJSON(writer, http.StatusOK, response)
}

// mergePricingChannels lists every configured multiplier plus every channel the
// window's traffic used, so an operator can scale a channel the moment it shows
// up rather than typing its technical name from memory.
func mergePricingChannels(configured []pricing.ChannelMultiplier, usage map[string]repository.PricingUsage) []pricingChannelDTO {
	result := make([]pricingChannelDTO, 0, len(configured)+len(usage))
	seen := make(map[string]struct{}, len(configured))
	for _, channel := range configured {
		seen[channel.Channel] = struct{}{}
		result = append(result, pricingChannelDTO{Channel: channel.Channel, Multiplier: channel.Multiplier, Note: channel.Note,
			UpdatedAtMS: channel.UpdatedAtMS, IsConfigured: true, Usage: projectPricingUsage(usage[channel.Channel])})
	}
	for name, traffic := range usage {
		if _, ok := seen[name]; ok {
			continue
		}
		result = append(result, pricingChannelDTO{Channel: name, Multiplier: 1, Usage: projectPricingUsage(traffic)})
	}
	sort.SliceStable(result, func(i, j int) bool {
		if result[i].Usage.Requests != result[j].Usage.Requests {
			return result[i].Usage.Requests > result[j].Usage.Requests
		}
		return result[i].Channel < result[j].Channel
	})
	return result
}

// getPricingAttention lists current models without a price, without traffic or suggestions.
//
// @Summary List unpriced models
// @Description Return model names observed in traffic that currently lack pricing rules.
// @Tags Pricing
// @Produce json
// @Security CookieAuth
// @Success 200 {object} PricingAttentionResponseDTO
// @Failure 401 {object} ErrorResponseDTO
// @Failure 503 {object} ErrorResponseDTO
// @Router /v1/pricing/attention [get]
func (h *Handler) getPricingAttention(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	if !h.requirePricing(writer) {
		return
	}
	unpriced, err := h.pricing.UsedUnpricedModels(request.Context(), 0)
	if err != nil {
		writeInternalError(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, PricingAttentionResponseDTO{Unpriced: unpriced})
}

// getPricingCatalog serves the stored OpenRouter snapshot whole; the picker
// filters it in the browser, so searching costs neither a request nor a fetch.
//
// @Summary Get stored OpenRouter pricing catalog
// @Description Return the cached upstream OpenRouter model catalog for client-side price picking.
// @Tags Pricing
// @Produce json
// @Security CookieAuth
// @Success 200 {object} PricingCatalogResponseDTO
// @Failure 401 {object} ErrorResponseDTO
// @Failure 503 {object} ErrorResponseDTO
// @Router /v1/pricing/catalog [get]
func (h *Handler) getPricingCatalog(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	if !h.requirePricing(writer) {
		return
	}
	models, err := h.pricing.StoredCatalog(request.Context())
	if err != nil {
		writeInternalError(writer, err)
		return
	}
	if models == nil {
		models = []pricing.UpstreamModel{}
	}
	writeJSON(writer, http.StatusOK, PricingCatalogResponseDTO{Models: models})
}

// getPricingModel is the editor's read: the current row, its version history,
// what a typical recent request looks like, and adoptable candidates.
//
// @Summary Get pricing details for a model
// @Description Return current price, version history, token usage profile, automatic match, and reference prices for a model.
// @Tags Pricing
// @Produce json
// @Security CookieAuth
// @Param model path string true "Model ID (URL-encoded if it contains slashes)"
// @Param channel query string false "Optional channel name for channel-specific override inspection"
// @Success 200 {object} PricingModelDetailResponseDTO
// @Failure 400 {object} ErrorResponseDTO
// @Failure 401 {object} ErrorResponseDTO
// @Failure 503 {object} ErrorResponseDTO
// @Router /v1/pricing/models/{model} [get]
func (h *Handler) getPricingModel(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	if !h.requirePricing(writer) {
		return
	}
	model, ok := pricingPathParam(request, "model")
	if !ok {
		writeError(writer, http.StatusBadRequest, "model path parameter is required")
		return
	}
	ctx := request.Context()
	rows, err := h.pricing.ListPrices(ctx)
	if err != nil {
		writeInternalError(writer, err)
		return
	}
	var current *pricing.ModelPrice
	for index := range rows {
		if rows[index].Model == model {
			current = &rows[index]
			break
		}
	}
	channel := strings.TrimSpace(request.URL.Query().Get("channel"))
	isInherited := channel != ""
	if channel != "" && h.repo != nil {
		overrides, err := h.repo.ListChannelModelPrices(ctx)
		if err != nil {
			writeInternalError(writer, err)
			return
		}
		for index := range overrides {
			if overrides[index].Channel == channel && overrides[index].Model == model {
				current, isInherited = &overrides[index], false
				break
			}
		}
	}
	suggestions, err := h.pricing.Suggestions(ctx, model, pricingSuggestionLimit)
	if err != nil {
		slog.Warn("pricing suggestions unavailable", "model", model, "error", err)
	}
	if suggestions == nil {
		suggestions = []pricing.UpstreamModel{}
	}
	// What auto mode would choose, so the editor can show it before the operator
	// switches: a switch that would find nothing is refused, and the editor says so
	// up front instead of after a failed save.
	var automatic *PricingAutomaticMatchDTO
	references := []pricingReferencePriceDTO{}
	if match, found, err := h.pricing.AutomaticMatch(ctx, model); err != nil {
		slog.Warn("pricing automatic match unavailable", "model", model, "error", err)
	} else if found {
		automatic = &PricingAutomaticMatchDTO{Model: match.Model, MatchKind: match.Kind}
	} else {
		references = projectPricingReferences(operations.ReferencePrices(model))
	}
	var candidate *pricing.Candidate
	if current != nil && channel == "" {
		if found, err := h.pricing.Candidates(ctx, []pricing.ModelPrice{*current}); err != nil {
			slog.Warn("pricing candidate unavailable", "model", model, "error", err)
		} else if value, ok := found[model]; ok {
			candidate = &value
		}
	}
	var price *pricingModelPriceDTO
	if current != nil {
		projected := projectPricingModel(*current)
		price = &projected
	}
	response := PricingModelDetailResponseDTO{
		Model: model, Price: price, Suggestions: suggestions, Automatic: automatic,
		ReferencePrices: references, Candidate: candidate,
		Versions: []pricingPriceVersionDTO{}, Profile: repository.TokenProfile{},
	}
	if channel != "" {
		response.Channel = channel
		response.IsInherited = &isInherited
	}
	if h.repo != nil {
		if versions, err := h.repo.ListModelPriceVersions(ctx, model, 50, channel); err == nil && versions != nil {
			projected := make([]pricingPriceVersionDTO, len(versions))
			for index, version := range versions {
				projected[index] = pricingPriceVersionDTO{
					ID: version.ID, Available: version.Available, EffectiveFromMS: version.EffectiveFromMS,
					Price: pricingVersionPriceDTO{
						pricingModelPriceDTO: projectPricingModel(version.Price.ModelPrice),
						MatchKind:            version.Price.MatchKind, Mode: version.Price.Mode,
						SyncedAtMS: version.Price.SyncedAtMS, UpdatedAtMS: version.Price.UpdatedAtMS,
					},
				}
			}
			response.Versions = projected
		}
		if profile, err := h.repo.QueryModelTokenProfile(ctx, model, h.now().Add(-pricingProfileWindow).UnixMilli()); err == nil {
			response.Profile = profile
		}
	}
	writeJSON(writer, http.StatusOK, response)
}

// pricingModelRequest is one operator decision about a model. Unknown fields are
// rejected so a typo silently changing rates is impossible.
type pricingModelRequest struct {
	Mode             string              `json:"mode"`
	UpstreamID       string              `json:"upstream_id"`
	PromptPricePer1M float64             `json:"prompt_price_per_1m"`
	CompletionPer1M  float64             `json:"completion_price_per_1m"`
	CacheReadPer1M   float64             `json:"cache_read_price_per_1m"`
	CacheWritePer1M  float64             `json:"cache_write_price_per_1m"`
	PriceMultiplier  float64             `json:"price_multiplier"`
	Tiers            []pricing.PriceTier `json:"tiers"`
}

// ModeChange converts the request; rates only matter for a custom price.
func (body pricingModelRequest) ModeChange(model string) pricing.ModeChange {
	return pricing.ModeChange{
		Model: model, Mode: body.Mode, UpstreamID: body.UpstreamID, Multiplier: body.PriceMultiplier,
		Price: pricing.ModelPrice{Model: model, PromptPricePer1M: body.PromptPricePer1M, CompletionPer1M: body.CompletionPer1M,
			CacheReadPer1M: body.CacheReadPer1M, CacheWritePer1M: body.CacheWritePer1M, Tiers: body.Tiers},
	}
}

// pricingErrorResponse maps the service's refusals to stable codes the console
// localises; anything else is an internal error.
func pricingErrorResponse(writer http.ResponseWriter, err error) {
	for _, known := range []struct {
		target error
		code   string
	}{
		{pricing.ErrModelNotInCatalog, "pricing_model_not_in_catalog"},
		{pricing.ErrUpstreamNotFound, "pricing_upstream_not_found"},
		{pricing.ErrNoAutomaticMatch, "pricing_no_automatic_match"},
		{pricing.ErrInvalidMode, "pricing_invalid_mode"},
		{pricing.ErrInvalidReview, "pricing_invalid_review"},
	} {
		if errors.Is(err, known.target) {
			writeJSON(writer, http.StatusBadRequest, map[string]string{"error": err.Error(), "code": known.code})
			return
		}
	}
	writeInternalError(writer, err)
}

// updatePricingModel applies one operator decision for a current CPA model:
// custom rates, a pin to an OpenRouter model, or automatic matching. It takes
// effect for requests stamped from now on; recorded costs never move.
//
// @Summary Set model pricing rule
// @Description Apply custom rates, pin an OpenRouter upstream model, or enable automatic matching for a model (optionally scoped to a channel).
// @Tags Pricing
// @Accept json
// @Produce json
// @Security CookieAuth
// @Param model path string true "Model ID"
// @Param channel query string false "Optional channel name"
// @Param body body pricingModelRequest true "Pricing rule update"
// @Success 200 {object} PricingModelUpdateResponseDTO
// @Failure 400 {object} ErrorResponseDTO
// @Failure 401 {object} ErrorResponseDTO
// @Failure 503 {object} ErrorResponseDTO
// @Router /v1/pricing/models/{model} [put]
func (h *Handler) updatePricingModel(writer http.ResponseWriter, request *http.Request) {
	if !h.requirePricing(writer) {
		return
	}
	model, ok := pricingPathParam(request, "model")
	if !ok {
		writeError(writer, http.StatusBadRequest, "model path parameter is required")
		return
	}
	var body pricingModelRequest
	if err := decodeManagementJSON(writer, request, 16*1024, &body); err != nil {
		return
	}
	change := body.ModeChange(model)
	change.Channel = strings.TrimSpace(request.URL.Query().Get("channel"))
	if change.Mode == pricing.ModeCustom {
		candidate := change.Price
		candidate.PriceMultiplier = change.Multiplier
		if candidate.PriceMultiplier == 0 {
			candidate.PriceMultiplier = 1
		}
		candidate.Source = pricing.SourceManual
		if err := candidate.ValidateWrite(); err != nil {
			writeErrorWithDetails(writer, http.StatusBadRequest, "invalid price", []string{err.Error()})
			return
		}
	} else if change.Multiplier < 0 {
		writeError(writer, http.StatusBadRequest, "price_multiplier must be a positive number")
		return
	}
	row, err := h.pricing.SetModelMode(request.Context(), change)
	if err != nil {
		pricingErrorResponse(writer, err)
		return
	}
	if err := h.recordAudit(request, "pricing.model.update", "pricing", model, "success", map[string]any{
		"mode": change.Mode, "upstream_id": row.UpstreamID, "channel": change.Channel,
	}); err != nil {
		writeInternalError(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, PricingModelUpdateResponseDTO{Price: projectPricingModel(row)})
}

// dismissPricingCandidate records that the operator saw a model's candidate
// and keeps their own price. Only a different candidate is offered later; the
// price itself is untouched.
//
// @Summary Dismiss a model pricing candidate
// @Description Dismiss an OpenRouter price suggestion for a model while preserving the current price.
// @Tags Pricing
// @Accept json
// @Produce json
// @Security CookieAuth
// @Param model path string true "Model ID"
// @Param body body DismissPricingCandidateRequestDTO true "Candidate upstream model ID"
// @Success 200 {object} PricingDismissedResponseDTO
// @Failure 400 {object} ErrorResponseDTO
// @Failure 401 {object} ErrorResponseDTO
// @Failure 503 {object} ErrorResponseDTO
// @Router /v1/pricing/models/{model}/dismiss-candidate [post]
func (h *Handler) dismissPricingCandidate(writer http.ResponseWriter, request *http.Request) {
	if !h.requirePricing(writer) {
		return
	}
	model, ok := pricingPathParam(request, "model")
	if !ok {
		writeError(writer, http.StatusBadRequest, "model path parameter is required")
		return
	}
	var body DismissPricingCandidateRequestDTO
	if err := decodeManagementJSON(writer, request, 4*1024, &body); err != nil {
		return
	}
	if err := h.pricing.DismissCandidate(request.Context(), model, body.UpstreamID); err != nil {
		pricingErrorResponse(writer, err)
		return
	}
	if err := h.recordAudit(request, "pricing.model.dismiss_candidate", "pricing", model, "success", map[string]any{
		"upstream_id": body.UpstreamID,
	}); err != nil {
		writeInternalError(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, PricingDismissedResponseDTO{Dismissed: true})
}

// deletePricingModel retires the current price and any pin. A later sync may
// recreate an automatic price for future requests; recorded costs are intact.
//
// @Summary Delete model pricing rule
// @Description Remove the active pricing rule or channel override for a model without altering historical usage costs.
// @Tags Pricing
// @Produce json
// @Security CookieAuth
// @Param model path string true "Model ID"
// @Param channel query string false "Optional channel name"
// @Success 200 {object} PricingDeletedResponseDTO
// @Failure 400 {object} ErrorResponseDTO
// @Failure 401 {object} ErrorResponseDTO
// @Failure 503 {object} ErrorResponseDTO
// @Router /v1/pricing/models/{model} [delete]
func (h *Handler) deletePricingModel(writer http.ResponseWriter, request *http.Request) {
	if !h.requirePricing(writer) {
		return
	}
	model, ok := pricingPathParam(request, "model")
	if !ok {
		writeError(writer, http.StatusBadRequest, "model path parameter is required")
		return
	}
	channel := strings.TrimSpace(request.URL.Query().Get("channel"))
	var deleted bool
	var err error
	if channel == "" {
		deleted, err = h.pricing.DeletePrice(request.Context(), model)
	} else {
		deleted, err = h.pricing.DeleteChannelPrice(request.Context(), channel, model)
	}
	if err != nil {
		writeInternalError(writer, err)
		return
	}
	if err := h.recordAudit(request, "pricing.model.delete", "pricing", model, "success", map[string]any{
		"deleted": deleted, "channel": channel,
	}); err != nil {
		writeInternalError(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, PricingDeletedResponseDTO{Deleted: deleted})
}

type pricingChannelRequest struct {
	Multiplier float64 `json:"multiplier"`
	Note       string  `json:"note"`
}

// updatePricingChannel sets one channel multiplier for requests stamped from
// now on.
//
// @Summary Set channel price multiplier
// @Description Configure a cost multiplier for a specific upstream channel.
// @Tags Pricing
// @Accept json
// @Produce json
// @Security CookieAuth
// @Param channel path string true "Channel name"
// @Param body body pricingChannelRequest true "Multiplier configuration"
// @Success 200 {object} PricingChannelUpdateResponseDTO
// @Failure 400 {object} ErrorResponseDTO
// @Failure 401 {object} ErrorResponseDTO
// @Failure 503 {object} ErrorResponseDTO
// @Router /v1/pricing/channels/{channel} [put]
func (h *Handler) updatePricingChannel(writer http.ResponseWriter, request *http.Request) {
	if !h.requirePricing(writer) {
		return
	}
	channel, ok := pricingPathParam(request, "channel")
	if !ok {
		writeError(writer, http.StatusBadRequest, "channel path parameter is required")
		return
	}
	var body pricingChannelRequest
	if err := decodeManagementJSON(writer, request, 4*1024, &body); err != nil {
		return
	}
	saved, err := h.pricing.SetChannel(request.Context(), pricing.ChannelMultiplier{Channel: channel, Multiplier: body.Multiplier, Note: body.Note})
	if err != nil {
		writeErrorWithDetails(writer, http.StatusBadRequest, "invalid channel multiplier", []string{err.Error()})
		return
	}
	if err := h.recordAudit(request, "pricing.channel.update", "pricing", channel, "success", map[string]any{
		"multiplier": saved.Multiplier,
	}); err != nil {
		writeInternalError(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, PricingChannelUpdateResponseDTO{Channel: saved})
}

// deletePricingChannel returns a channel to 1x for requests stamped from now on.
//
// @Summary Delete channel price multiplier
// @Description Remove a custom multiplier for a channel so future requests use 1x pricing.
// @Tags Pricing
// @Produce json
// @Security CookieAuth
// @Param channel path string true "Channel name"
// @Success 200 {object} PricingDeletedResponseDTO
// @Failure 400 {object} ErrorResponseDTO
// @Failure 401 {object} ErrorResponseDTO
// @Failure 503 {object} ErrorResponseDTO
// @Router /v1/pricing/channels/{channel} [delete]
func (h *Handler) deletePricingChannel(writer http.ResponseWriter, request *http.Request) {
	if !h.requirePricing(writer) {
		return
	}
	channel, ok := pricingPathParam(request, "channel")
	if !ok {
		writeError(writer, http.StatusBadRequest, "channel path parameter is required")
		return
	}
	deleted, err := h.pricing.DeleteChannel(request.Context(), channel)
	if err != nil {
		writeInternalError(writer, err)
		return
	}
	if err := h.recordAudit(request, "pricing.channel.delete", "pricing", channel, "success", map[string]any{
		"deleted": deleted,
	}); err != nil {
		writeInternalError(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, PricingDeletedResponseDTO{Deleted: deleted})
}

// startPricingSync kicks one background OpenRouter sync. A sync already in
// flight returns 409 so parallel UI refreshes cannot stack fetches.
//
// @Summary Start OpenRouter pricing sync
// @Description Trigger an asynchronous refresh of the OpenRouter model price catalog.
// @Tags Pricing
// @Produce json
// @Security CookieAuth
// @Success 202 {object} PricingSyncStartResponseDTO
// @Failure 401 {object} ErrorResponseDTO
// @Failure 409 {object} ErrorResponseDTO
// @Failure 503 {object} ErrorResponseDTO
// @Router /v1/pricing/sync [post]
func (h *Handler) startPricingSync(writer http.ResponseWriter, request *http.Request) {
	if !h.requirePricing(writer) {
		return
	}
	if !h.pricing.TriggerSync() {
		writeError(writer, http.StatusConflict, "a pricing sync is already running")
		return
	}
	if err := h.recordAudit(request, "pricing.sync.start", "pricing", pricing.SourceOpenRouter, "success", nil); err != nil {
		writeInternalError(writer, err)
		return
	}
	writeJSON(writer, http.StatusAccepted, PricingSyncStartResponseDTO{Started: true})
}

// pricingScheduleRequest is the auto-sync interval update payload.
type pricingScheduleRequest struct {
	IntervalHours *int64 `json:"interval_hours"`
}

// updatePricingSyncSchedule modifies the background sync interval (0 = disabled).
//
// @Summary Update pricing auto-sync schedule
// @Description Configure the automatic OpenRouter pricing refresh interval in hours (0 disables auto-sync).
// @Tags Pricing
// @Accept json
// @Produce json
// @Security CookieAuth
// @Param body body pricingScheduleRequest true "Sync interval in hours (0-168)"
// @Success 200 {object} PricingSyncScheduleResponseDTO
// @Failure 400 {object} ErrorResponseDTO
// @Failure 401 {object} ErrorResponseDTO
// @Failure 503 {object} ErrorResponseDTO
// @Router /v1/pricing/sync-schedule [put]
func (h *Handler) updatePricingSyncSchedule(writer http.ResponseWriter, request *http.Request) {
	if !h.requirePricing(writer) {
		return
	}
	var body pricingScheduleRequest
	if err := decodeManagementJSON(writer, request, 1024, &body); err != nil {
		return
	}
	if body.IntervalHours == nil {
		writeError(writer, http.StatusBadRequest, "interval_hours is required")
		return
	}
	hours := *body.IntervalHours
	if hours < 0 || hours > 168 {
		writeError(writer, http.StatusBadRequest, "interval_hours must be between 0 and 168")
		return
	}
	if err := h.pricing.SetAutoSyncInterval(request.Context(), hours); err != nil {
		writeInternalError(writer, err)
		return
	}
	if err := h.recordAudit(request, "pricing.sync_schedule.update", "pricing", pricing.SourceOpenRouter, "success", map[string]any{
		"interval_hours": hours,
	}); err != nil {
		writeInternalError(writer, err)
		return
	}
	state, known, _ := h.pricing.SyncStateView(request.Context())
	writeJSON(writer, http.StatusOK, PricingSyncScheduleResponseDTO{
		IntervalHours: hours,
		Known:         known,
		State:         state,
	})
}
