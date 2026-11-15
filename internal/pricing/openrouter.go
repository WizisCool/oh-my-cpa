package pricing

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"net/http"
	"net/url"
	"regexp"
	"slices"
	"strings"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/remotedata"
)

// OpenRouterModelsURL is the single fixed price source. It is public, needs no
// key, and the client never accepts an operator-supplied URL. Fetch includes all
// output modalities so image generators are not omitted by the text-only default.
const OpenRouterModelsURL = "https://openrouter.ai/api/v1/models"

const (
	upstreamTimeout  = 20 * time.Second
	upstreamMaxBytes = 32 << 20
)

// UpstreamReasoning captures OpenRouter's per-model reasoning support and effort defaults.
type UpstreamReasoning struct {
	Mandatory        bool     `json:"mandatory"`
	DefaultEnabled   bool     `json:"default_enabled"`
	SupportedEfforts []string `json:"supported_efforts"`
	DefaultEffort    string   `json:"default_effort,omitempty"`
}

// UpstreamModel is one OpenRouter model reduced to what pricing and model
// specifications use. Rates are USD per 1M tokens; a cache rate OpenRouter does
// not publish has already been resolved to the prompt rate (see DecodeOpenRouter).
type UpstreamModel struct {
	ID                  string             `json:"id"`
	CanonicalSlug       string             `json:"canonical_slug"`
	Name                string             `json:"name"`
	Author              string             `json:"author"`
	Description         string             `json:"description,omitempty"`
	ContextLength       int64              `json:"context_length"`
	MaxCompletionTokens int64              `json:"max_completion_tokens,omitempty"`
	InputModalities     []string           `json:"input_modalities,omitempty"`
	OutputModalities    []string           `json:"output_modalities,omitempty"`
	SupportedParameters []string           `json:"supported_parameters,omitempty"`
	Reasoning           *UpstreamReasoning `json:"reasoning,omitempty"`
	KnowledgeCutoff     string             `json:"knowledge_cutoff,omitempty"`
	HuggingFaceID       string             `json:"hugging_face_id,omitempty"`
	PromptPricePer1M    float64            `json:"prompt_price_per_1m"`
	CompletionPer1M     float64            `json:"completion_price_per_1m"`
	CacheReadPer1M      float64            `json:"cache_read_price_per_1m"`
	CacheWritePer1M     float64            `json:"cache_write_price_per_1m"`
	Tiers               []PriceTier        `json:"tiers"`
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

// OpenRouterClient fetches and decodes OpenRouter's model list. Production uses
// the fixed HTTPS endpoint and its configured outbound transport.
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
	query := parsed.Query()
	query.Set("output_modalities", "all")
	parsed.RawQuery = query.Encode()
	body, err := remotedata.Fetch(ctx, c.client, parsed.String(), "oh-my-cpa-pricing/3", upstreamMaxBytes)
	if err != nil {
		return Catalog{}, fmt.Errorf("fetch OpenRouter prices: %w", err)
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
		Description   string                     `json:"description"`
		ContextLength json.Number                `json:"context_length"`
		Pricing       map[string]json.RawMessage `json:"pricing"`
		Architecture  struct {
			InputModalities  []string `json:"input_modalities"`
			OutputModalities []string `json:"output_modalities"`
		} `json:"architecture"`
		TopProvider struct {
			MaxCompletionTokens json.Number `json:"max_completion_tokens"`
		} `json:"top_provider"`
		SupportedParameters []string `json:"supported_parameters"`
		Reasoning           *struct {
			Mandatory        bool     `json:"mandatory"`
			DefaultEnabled   bool     `json:"default_enabled"`
			SupportedEfforts []string `json:"supported_efforts"`
			DefaultEffort    string   `json:"default_effort"`
		} `json:"reasoning"`
		KnowledgeCutoff string `json:"knowledge_cutoff"`
		HuggingFaceID   string `json:"hugging_face_id"`
	} `json:"data"`
}

var huggingFaceSegmentPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]*$`)

// SanitizeHuggingFaceID retains only safe Hugging Face repository identifiers
// ("owner/model" or a single slug) so downstream URL construction cannot inject
// paths, queries, or external hosts.
func SanitizeHuggingFaceID(raw string) string {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" || len(trimmed) > 256 {
		return ""
	}
	if strings.Contains(trimmed, "..") || strings.ContainsAny(trimmed, "?#\\") {
		return ""
	}
	parts := strings.Split(trimmed, "/")
	if len(parts) > 2 {
		return ""
	}
	for _, part := range parts {
		if part == "" || part == "." || part == ".." || !huggingFaceSegmentPattern.MatchString(part) {
			return ""
		}
	}
	return trimmed
}

func normalizeStringList(values []string) []string {
	if len(values) == 0 {
		return []string{}
	}
	seen := make(map[string]struct{}, len(values))
	result := make([]string, 0, len(values))
	for _, value := range values {
		trimmed := strings.TrimSpace(value)
		if trimmed == "" {
			continue
		}
		if _, exists := seen[trimmed]; exists {
			continue
		}
		seen[trimmed] = struct{}{}
		result = append(result, trimmed)
	}
	return result
}

func EncodeStringList(values []string) (string, error) {
	encoded, err := json.Marshal(normalizeStringList(values))
	if err != nil {
		return "", fmt.Errorf("encode string list: %w", err)
	}
	return string(encoded), nil
}

func DecodeStringList(raw string) ([]string, error) {
	if raw == "" || raw == "[]" {
		return []string{}, nil
	}
	var values []string
	if err := json.Unmarshal([]byte(raw), &values); err != nil {
		return nil, fmt.Errorf("decode string list: %w", err)
	}
	return normalizeStringList(values), nil
}

func EncodeReasoning(reasoning *UpstreamReasoning) (string, error) {
	if reasoning == nil {
		return "{}", nil
	}
	normalized := UpstreamReasoning{
		Mandatory:        reasoning.Mandatory,
		DefaultEnabled:   reasoning.DefaultEnabled,
		SupportedEfforts: normalizeStringList(reasoning.SupportedEfforts),
		DefaultEffort:    strings.TrimSpace(reasoning.DefaultEffort),
	}
	encoded, err := json.Marshal(normalized)
	if err != nil {
		return "", fmt.Errorf("encode reasoning metadata: %w", err)
	}
	return string(encoded), nil
}

func DecodeReasoning(raw string) (*UpstreamReasoning, error) {
	if raw == "" || raw == "{}" {
		return nil, nil
	}
	var decoded UpstreamReasoning
	if err := json.Unmarshal([]byte(raw), &decoded); err != nil {
		return nil, fmt.Errorf("decode reasoning metadata: %w", err)
	}
	decoded.SupportedEfforts = normalizeStringList(decoded.SupportedEfforts)
	decoded.DefaultEffort = strings.TrimSpace(decoded.DefaultEffort)
	return &decoded, nil
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
		outputs := normalizeStringList(entry.Architecture.OutputModalities)
		isImageOutput := len(outputs) == 1 && outputs[0] == "image"
		// Other non-text modalities need their own pricing policy, not generic
		// completion rates. Missing metadata keeps the legacy token policy.
		if len(outputs) > 0 && !isImageOutput && !slices.Contains(outputs, "text") {
			continue
		}
		completionKey := "completion"
		// Only a pure image generator can use one image rate for all output.
		// Mixed text/image models must retain their text completion rate.
		if isImageOutput {
			if _, ok := perMillion(entry.Pricing["image_output"]); ok {
				completionKey = "image_output"
			}
		}
		prompt, promptOK := perMillion(entry.Pricing["prompt"])
		completion, completionOK := perMillion(entry.Pricing[completionKey])
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
		maxCompletionTokens, _ := entry.TopProvider.MaxCompletionTokens.Int64()
		var reasoning *UpstreamReasoning
		if entry.Reasoning != nil {
			reasoning = &UpstreamReasoning{
				Mandatory:        entry.Reasoning.Mandatory,
				DefaultEnabled:   entry.Reasoning.DefaultEnabled,
				SupportedEfforts: normalizeStringList(entry.Reasoning.SupportedEfforts),
				DefaultEffort:    strings.TrimSpace(entry.Reasoning.DefaultEffort),
			}
		}
		model := UpstreamModel{
			ID:                  id,
			CanonicalSlug:       strings.TrimSpace(entry.CanonicalSlug),
			Name:                strings.TrimSpace(entry.Name),
			Author:              author,
			Description:         strings.TrimSpace(entry.Description),
			ContextLength:       max(contextLength, 0),
			MaxCompletionTokens: max(maxCompletionTokens, 0),
			InputModalities:     normalizeStringList(entry.Architecture.InputModalities),
			OutputModalities:    outputs,
			SupportedParameters: normalizeStringList(entry.SupportedParameters),
			Reasoning:           reasoning,
			KnowledgeCutoff:     strings.TrimSpace(entry.KnowledgeCutoff),
			HuggingFaceID:       SanitizeHuggingFaceID(entry.HuggingFaceID),
			PromptPricePer1M:    prompt,
			CompletionPer1M:     completion,
			CacheReadPer1M:      cacheRead,
			CacheWritePer1M:     cacheWrite,
		}
		model.Tiers = CanonicalTiers(decodeOverrides(entry.Pricing["overrides"], hasCacheRead, hasCacheWrite, completionKey))
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
// paired with the base-tier cache rate. Output overrides use the base's selected
// pricing key; an absent image override inherits the image rate, not completion.
func decodeOverrides(raw json.RawMessage, hasCacheRead, hasCacheWrite bool, completionKey string) []PriceTier {
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
		tier.CompletionPer1M = optionalPerMillion(override[completionKey])
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
