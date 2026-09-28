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
	"time"

	"github.com/go-chi/chi/v5"
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
	StoredCatalog(ctx context.Context) ([]pricing.UpstreamModel, error)
	SyncStateView(ctx context.Context) (pricing.SyncState, bool, error)
	SetModelMode(ctx context.Context, change pricing.ModeChange) (pricing.ModelPrice, error)
	SetModelModeChecked(context.Context, pricing.ModeChange, func([]pricing.ModelPrice) error) (pricing.ModelPrice, error)
	DeletePrice(ctx context.Context, model string) (bool, error)
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

const (
	// pricingUsageWindow is the traffic the price book shows beside each rate.
	pricingUsageWindow = 30 * 24 * time.Hour
	// pricingProfileWindow is the traffic the editor's cost preview samples.
	pricingProfileWindow   = 7 * 24 * time.Hour
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

type pricingModelDTO struct {
	pricing.ModelPrice
	Usage pricingUsageDTO `json:"usage_30d"`
}

type pricingUnpricedDTO struct {
	Model       string                  `json:"model"`
	Usage       pricingUsageDTO         `json:"usage_30d"`
	Suggestions []pricing.UpstreamModel `json:"suggestions"`
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

// listPricing returns the price book in one round trip: every priced model with
// its recent traffic, the unpriced models with candidates to adopt, the channel
// multipliers beside the channels traffic actually used, and the sync state.
// A missing service keeps the endpoint honest with 503 instead of an empty table.
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
	models := make([]pricingModelDTO, 0, len(rows))
	for _, row := range rows {
		models = append(models, pricingModelDTO{ModelPrice: row, Usage: projectPricingUsage(modelUsage[row.Model])})
	}
	attention := make([]pricingUnpricedDTO, 0, len(unpriced))
	for _, model := range unpriced {
		suggestions, err := h.pricing.Suggestions(ctx, model, pricingSuggestionLimit)
		if err != nil {
			slog.Warn("pricing suggestions unavailable", "model", model, "error", err)
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
	response := map[string]any{
		"source":         pricing.SourceOpenRouter,
		"providers":      providers,
		"models":         models,
		"unpriced":       attention,
		"channels":       mergePricingChannels(channels, channelUsage),
		"upstream_count": upstreamCount,
		"sync": map[string]any{
			"known":   known,
			"running": h.pricing.IsRunning(),
			"state":   state,
		},
	}
	if len(partial) > 0 {
		response["partial"] = partial
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
	writeJSON(writer, http.StatusOK, map[string]any{"unpriced": unpriced})
}

// getPricingCatalog serves the stored OpenRouter snapshot whole; the picker
// filters it in the browser, so searching costs neither a request nor a fetch.
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
	writeJSON(writer, http.StatusOK, map[string]any{"models": models})
}

// getPricingModel is the editor's read: the current row, its version history,
// what a typical recent request looks like, and adoptable candidates.
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
	var automatic any
	if match, found, err := h.pricing.AutomaticMatch(ctx, model); err != nil {
		slog.Warn("pricing automatic match unavailable", "model", model, "error", err)
	} else if found {
		automatic = map[string]any{"model": match.Model, "match_kind": match.Kind}
	}
	response := map[string]any{"model": model, "price": current, "suggestions": suggestions, "automatic": automatic,
		"versions": []repository.PriceVersion{}, "profile": repository.TokenProfile{}}
	if h.repo != nil {
		if versions, err := h.repo.ListModelPriceVersions(ctx, model, 50); err == nil && versions != nil {
			response["versions"] = versions
		}
		if profile, err := h.repo.QueryModelTokenProfile(ctx, model, h.now().Add(-pricingProfileWindow).UnixMilli()); err == nil {
			response["profile"] = profile
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
		"mode": change.Mode, "upstream_id": row.UpstreamID,
	}); err != nil {
		writeInternalError(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, map[string]any{"price": row})
}

// deletePricingModel retires the current price and any pin. A later sync may
// recreate an automatic price for future requests; recorded costs are intact.
func (h *Handler) deletePricingModel(writer http.ResponseWriter, request *http.Request) {
	if !h.requirePricing(writer) {
		return
	}
	model, ok := pricingPathParam(request, "model")
	if !ok {
		writeError(writer, http.StatusBadRequest, "model path parameter is required")
		return
	}
	deleted, err := h.pricing.DeletePrice(request.Context(), model)
	if err != nil {
		writeInternalError(writer, err)
		return
	}
	if err := h.recordAudit(request, "pricing.model.delete", "pricing", model, "success", map[string]any{
		"deleted": deleted,
	}); err != nil {
		writeInternalError(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, map[string]any{"deleted": deleted})
}

type pricingChannelRequest struct {
	Multiplier float64 `json:"multiplier"`
	Note       string  `json:"note"`
}

// updatePricingChannel sets one channel multiplier for requests stamped from
// now on.
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
	writeJSON(writer, http.StatusOK, map[string]any{"channel": saved})
}

// deletePricingChannel returns a channel to 1x for requests stamped from now on.
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
	writeJSON(writer, http.StatusOK, map[string]any{"deleted": deleted})
}

// startPricingSync kicks one background OpenRouter sync. A sync already in
// flight returns 409 so parallel UI refreshes cannot stack fetches.
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
	writeJSON(writer, http.StatusAccepted, map[string]any{"started": true})
}

// pricingScheduleRequest is the auto-sync interval update payload.
type pricingScheduleRequest struct {
	IntervalHours *int64 `json:"interval_hours"`
}

// updatePricingSyncSchedule modifies the background sync interval (0 = disabled).
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
	writeJSON(writer, http.StatusOK, map[string]any{
		"interval_hours": hours,
		"known":          known,
		"state":          state,
	})
}
