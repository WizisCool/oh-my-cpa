package pricing

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// OpenRouterModelsURL is the single fixed price source. It is public, needs no
// key, and the client never accepts an operator-supplied URL.
const OpenRouterModelsURL = "https://openrouter.ai/api/v1/models"

const (
	upstreamTimeout  = 20 * time.Second
	upstreamMaxBytes = 32 << 20
)

// UpstreamModel is one OpenRouter model reduced to what pricing uses. Rates are
// USD per 1M tokens; a cache rate OpenRouter does not publish has already been
// resolved to the prompt rate (see DecodeOpenRouter).
type UpstreamModel struct {
	ID               string      `json:"id"`
	CanonicalSlug    string      `json:"canonical_slug"`
	Name             string      `json:"name"`
	Author           string      `json:"author"`
	ContextLength    int64       `json:"context_length"`
	PromptPricePer1M float64     `json:"prompt_price_per_1m"`
	CompletionPer1M  float64     `json:"completion_price_per_1m"`
	CacheReadPer1M   float64     `json:"cache_read_price_per_1m"`
	CacheWritePer1M  float64     `json:"cache_write_price_per_1m"`
	Tiers            []PriceTier `json:"tiers"`
}

// IsAlias reports OpenRouter's floating "~vendor/…-latest" aliases, whose target
// changes under them; they are only ever a last-resort candidate.
func (m UpstreamModel) IsAlias() bool { return strings.HasPrefix(m.ID, "~") }

// PriceFor turns an upstream model into a price row for a CPA model.
func (m UpstreamModel) PriceFor(model, matchKind string, multiplier float64, syncedAtMS int64) ModelPrice {
	if multiplier <= 0 {
		multiplier = 1
	}
	tiers := make([]PriceTier, len(m.Tiers))
	copy(tiers, m.Tiers)
	return ModelPrice{
		Model: model, PromptPricePer1M: m.PromptPricePer1M, CompletionPer1M: m.CompletionPer1M,
		CacheReadPer1M: m.CacheReadPer1M, CacheWritePer1M: m.CacheWritePer1M, PriceMultiplier: multiplier,
		Tiers: tiers, Source: SourceOpenRouter, UpstreamID: m.ID, MatchKind: matchKind, SyncedAtMS: syncedAtMS,
	}
}

// Fetcher downloads the upstream catalog.
type Fetcher interface {
	Fetch(context.Context) (Catalog, error)
}

// OpenRouterClient fetches and decodes OpenRouter's model list. Transport and
// URL are injectable for tests only; production uses the fixed HTTPS default.
type OpenRouterClient struct {
	client  *http.Client
	baseURL string
}

func NewOpenRouterClient() *OpenRouterClient {
	return &OpenRouterClient{client: &http.Client{Timeout: upstreamTimeout}, baseURL: OpenRouterModelsURL}
}

func NewOpenRouterClientWithTransport(transport http.RoundTripper, baseURL string) *OpenRouterClient {
	return &OpenRouterClient{client: &http.Client{Timeout: upstreamTimeout, Transport: transport}, baseURL: baseURL}
}

// Fetch downloads and decodes the catalog. Any HTTP error, truncation or an
// empty list is an error, and the caller keeps its last good prices.
func (c *OpenRouterClient) Fetch(ctx context.Context) (Catalog, error) {
	parsed, err := url.Parse(c.baseURL)
	if err != nil || (parsed.Scheme != "https" && parsed.Scheme != "http") {
		return Catalog{}, fmt.Errorf("pricing source URL must be http(s)")
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, c.baseURL, nil)
	if err != nil {
		return Catalog{}, err
	}
	request.Header.Set("Accept", "application/json")
	request.Header.Set("User-Agent", "oh-my-cpa-pricing/3")
	response, err := c.client.Do(request)
	if err != nil {
		return Catalog{}, fmt.Errorf("fetch OpenRouter prices: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return Catalog{}, fmt.Errorf("fetch OpenRouter prices: status %d", response.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, upstreamMaxBytes+1))
	if err != nil {
		return Catalog{}, fmt.Errorf("read OpenRouter prices: %w", err)
	}
	if int64(len(body)) > upstreamMaxBytes {
		return Catalog{}, errors.New("OpenRouter price list exceeds size limit")
	}
	models, err := DecodeOpenRouter(body)
	if err != nil {
		return Catalog{}, err
	}
	if len(models) == 0 {
		return Catalog{}, errors.New("OpenRouter returned no priced models")
	}
	return NewCatalog(models, time.Now()), nil
}

type openRouterEnvelope struct {
	Data []struct {
		ID            string                     `json:"id"`
		CanonicalSlug string                     `json:"canonical_slug"`
		Name          string                     `json:"name"`
		ContextLength json.Number                `json:"context_length"`
		Pricing       map[string]json.RawMessage `json:"pricing"`
	} `json:"data"`
}

// DecodeOpenRouter reduces OpenRouter's envelope to standard list prices.
//
// Skipped: variants (":free" is zero, ":batch" is a discount, the rest are
// routing flavours of a base model), OpenRouter's own routers and any entry
// whose price is negative or missing (a router's "-1" means "decided per
// request", not a price).
//
// OpenRouter prices are USD per token as decimal strings; they are scaled to
// per 1M exactly. A cache rate OpenRouter omits resolves to the prompt rate,
// never to zero: an omission means the provider publishes no cache discount,
// and zero would bill cached tokens as free.
func DecodeOpenRouter(body []byte) ([]UpstreamModel, error) {
	var envelope openRouterEnvelope
	decoder := json.NewDecoder(strings.NewReader(string(body)))
	decoder.UseNumber()
	if err := decoder.Decode(&envelope); err != nil {
		return nil, fmt.Errorf("decode OpenRouter prices: %w", err)
	}
	models := make([]UpstreamModel, 0, len(envelope.Data))
	for _, entry := range envelope.Data {
		id := strings.TrimSpace(entry.ID)
		author, _, hasAuthor := strings.Cut(strings.TrimPrefix(id, "~"), "/")
		if !hasAuthor || author == "" || strings.Contains(id, ":") || author == "openrouter" || len(id) > 256 {
			continue
		}
		prompt, promptOK := perMillion(entry.Pricing["prompt"])
		completion, completionOK := perMillion(entry.Pricing["completion"])
		if !promptOK || !completionOK {
			continue
		}
		cacheRead, hasCacheRead := perMillion(entry.Pricing["input_cache_read"])
		if !hasCacheRead {
			cacheRead = prompt
		}
		cacheWrite, hasCacheWrite := perMillion(entry.Pricing["input_cache_write"])
		if !hasCacheWrite {
			cacheWrite = prompt
		}
		contextLength, _ := entry.ContextLength.Int64()
		model := UpstreamModel{
			ID: id, CanonicalSlug: strings.TrimSpace(entry.CanonicalSlug), Name: strings.TrimSpace(entry.Name),
			Author: author, ContextLength: max(contextLength, 0),
			PromptPricePer1M: prompt, CompletionPer1M: completion, CacheReadPer1M: cacheRead, CacheWritePer1M: cacheWrite,
		}
		model.Tiers = CanonicalTiers(decodeOverrides(entry.Pricing["overrides"], hasCacheRead, hasCacheWrite))
		if ValidateTiers(model.Tiers) != nil {
			model.Tiers = nil
		}
		models = append(models, model)
	}
	return models, nil
}

// decodeOverrides keeps the two override kinds the request lock can evaluate —
// a prompt-token threshold and a UTC time-of-day window — and drops any other.
// A cache rate the base price inherited from the prompt rate is inherited from
// the tier's own prompt rate too, so a doubled long-context prompt rate is not
// paired with the base-tier cache rate.
func decodeOverrides(raw json.RawMessage, hasCacheRead, hasCacheWrite bool) []PriceTier {
	if len(raw) == 0 {
		return nil
	}
	var overrides []map[string]json.RawMessage
	decoder := json.NewDecoder(strings.NewReader(string(raw)))
	decoder.UseNumber()
	if decoder.Decode(&overrides) != nil {
		return nil
	}
	var tiers []PriceTier
	for _, override := range overrides {
		var tier PriceTier
		if value, ok := integerField(override["min_prompt_tokens"]); ok && value > 0 {
			tier.MinPromptTokens = value
		}
		start, hasStart := integerField(override["utc_start"])
		end, hasEnd := integerField(override["utc_end"])
		if hasStart && hasEnd {
			startHHMM, endHHMM := int(start), int(end)
			tier.UTCStart, tier.UTCEnd = &startHHMM, &endHHMM
		}
		tier.PromptPricePer1M = optionalPerMillion(override["prompt"])
		tier.CompletionPer1M = optionalPerMillion(override["completion"])
		tier.CacheReadPer1M = optionalPerMillion(override["input_cache_read"])
		tier.CacheWritePer1M = optionalPerMillion(override["input_cache_write"])
		if tier.PromptPricePer1M != nil {
			if !hasCacheRead && tier.CacheReadPer1M == nil {
				tier.CacheReadPer1M = tier.PromptPricePer1M
			}
			if !hasCacheWrite && tier.CacheWritePer1M == nil {
				tier.CacheWritePer1M = tier.PromptPricePer1M
			}
		}
		if tier.MinPromptTokens == 0 && !tier.HasWindow() {
			continue
		}
		tiers = append(tiers, tier)
	}
	return tiers
}

var perTokenToPerMillion = big.NewRat(1_000_000, 1)

// perMillion scales a per-token decimal (string or number) to per 1M tokens.
// Negative, empty and non-numeric values are "no price".
func perMillion(raw json.RawMessage) (float64, bool) {
	text := strings.Trim(strings.TrimSpace(string(raw)), `"`)
	if text == "" || text == "null" {
		return 0, false
	}
	value, ok := new(big.Rat).SetString(text)
	if !ok || value.Sign() < 0 {
		return 0, false
	}
	scaled, _ := value.Mul(value, perTokenToPerMillion).Float64()
	return scaled, true
}

func optionalPerMillion(raw json.RawMessage) *float64 {
	value, ok := perMillion(raw)
	if !ok {
		return nil
	}
	return &value
}

func integerField(raw json.RawMessage) (int64, bool) {
	text := strings.Trim(strings.TrimSpace(string(raw)), `"`)
	if text == "" || text == "null" {
		return 0, false
	}
	value, ok := new(big.Int).SetString(text, 10)
	if !ok || !value.IsInt64() {
		return 0, false
	}
	return value.Int64(), true
}
