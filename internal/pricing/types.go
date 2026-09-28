// Package pricing keeps the per-model USD price book and computes request costs.
// OpenRouter's public model list is the only automatic source. A price carries
// four rates per 1M tokens (prompt, completion, cache read, cache write), an
// optional list of tiers (long-context thresholds and UTC time-of-day windows)
// and one model multiplier; a channel multiplier per CPA provider is applied on
// top. A model without a price row is unpriced, never zero.
package pricing

import (
	"errors"
	"fmt"
	"math"
	"strings"
)

// ModelPrice is one price row. Source records who last wrote the rates; Mode is
// derived on read (custom for manual rows, linked when an operator pinned an
// OpenRouter model, auto otherwise) and is never stored.
type ModelPrice struct {
	Model            string      `json:"model"`
	PromptPricePer1M float64     `json:"prompt_price_per_1m"`
	CompletionPer1M  float64     `json:"completion_price_per_1m"`
	CacheReadPer1M   float64     `json:"cache_read_price_per_1m"`
	CacheWritePer1M  float64     `json:"cache_write_price_per_1m"`
	PriceMultiplier  float64     `json:"price_multiplier"`
	Tiers            []PriceTier `json:"tiers"`
	Source           string      `json:"source"`
	UpstreamID       string      `json:"upstream_id"`
	MatchKind        string      `json:"match_kind"`
	Mode             string      `json:"mode,omitempty"`
	SyncedAtMS       int64       `json:"synced_at_ms"`
	UpdatedAtMS      int64       `json:"updated_at_ms"`
}

// Source values for ModelPrice. SourceModelsDev only survives on rows and price
// versions written before OpenRouter became the source: such rows stay priceable
// until a sync replaces them, and new writes can never carry it.
const (
	SourceManual     = "manual"
	SourceOpenRouter = "openrouter"
	SourceModelsDev  = "modelsdev"
)

// Price modes.
const (
	ModeAuto   = "auto"
	ModeLinked = "linked"
	ModeCustom = "custom"
)

// Match kinds, from most to least precise. MatchLinked marks a row whose
// upstream model an operator chose rather than one the matcher found.
const (
	MatchExact        = "exact"
	MatchCanonical    = "canonical"
	MatchNormalized   = "normalized"
	MatchDateStripped = "date_stripped"
	MatchAlias        = "alias"
	MatchLinked       = "linked"
)

// PriceTier is one conditional rate override. A tier applies when every
// condition it carries holds; rates it leaves nil inherit the base price.
type PriceTier struct {
	MinPromptTokens  int64    `json:"min_prompt_tokens,omitempty"`
	UTCStart         *int     `json:"utc_start,omitempty"`
	UTCEnd           *int     `json:"utc_end,omitempty"`
	PromptPricePer1M *float64 `json:"prompt_price_per_1m,omitempty"`
	CompletionPer1M  *float64 `json:"completion_price_per_1m,omitempty"`
	CacheReadPer1M   *float64 `json:"cache_read_price_per_1m,omitempty"`
	CacheWritePer1M  *float64 `json:"cache_write_price_per_1m,omitempty"`
}

// HasWindow reports whether the tier is limited to a UTC time-of-day window.
func (t PriceTier) HasWindow() bool { return t.UTCStart != nil && t.UTCEnd != nil }

// DeriveMode names how a row is maintained. A legacy row is automatic: the next
// sync that finds an OpenRouter match replaces it.
func DeriveMode(source string, hasLink bool) string {
	switch {
	case source == SourceManual:
		return ModeCustom
	case hasLink:
		return ModeLinked
	default:
		return ModeAuto
	}
}

// ValidateRates checks everything the cost calculation depends on. It ignores the
// source on purpose: a price version written under a retired source must keep
// pricing late-arriving requests stamped inside its effective period.
func (p *ModelPrice) ValidateRates() error {
	p.Model = strings.TrimSpace(p.Model)
	if p.Model == "" || len(p.Model) > 512 {
		return errors.New("model is required (max 512 chars)")
	}
	for _, value := range []struct {
		name  string
		price float64
	}{
		{"prompt_price_per_1m", p.PromptPricePer1M},
		{"completion_price_per_1m", p.CompletionPer1M},
		{"cache_read_price_per_1m", p.CacheReadPer1M},
		{"cache_write_price_per_1m", p.CacheWritePer1M},
	} {
		if !isValidRate(value.price) {
			return fmt.Errorf("%s must be a non-negative number", value.name)
		}
	}
	if math.IsNaN(p.PriceMultiplier) || math.IsInf(p.PriceMultiplier, 0) || p.PriceMultiplier <= 0 {
		return errors.New("price_multiplier must be a positive number")
	}
	return ValidateTiers(p.Tiers)
}

// ValidateWrite is ValidateRates plus the rules a new write must satisfy: only
// the two live sources may be written.
func (p *ModelPrice) ValidateWrite() error {
	if err := p.ValidateRates(); err != nil {
		return err
	}
	switch p.Source {
	case SourceManual, SourceOpenRouter:
	default:
		return fmt.Errorf("unknown price source %q", p.Source)
	}
	if len(p.UpstreamID) > 256 {
		return errors.New("upstream_id is too long (max 256 chars)")
	}
	switch p.MatchKind {
	case "", MatchExact, MatchCanonical, MatchNormalized, MatchDateStripped, MatchAlias, MatchLinked:
	default:
		return fmt.Errorf("unknown match kind %q", p.MatchKind)
	}
	return nil
}

// maxTiers bounds one price's override list; OpenRouter publishes at most two.
const maxTiers = 8

// ValidateTiers rejects a tier that could never apply or that would poison
// every estimate it is selected for.
func ValidateTiers(tiers []PriceTier) error {
	if len(tiers) > maxTiers {
		return fmt.Errorf("at most %d tiers are allowed", maxTiers)
	}
	for i, tier := range tiers {
		if tier.MinPromptTokens < 0 {
			return fmt.Errorf("tier %d: min_prompt_tokens must be non-negative", i)
		}
		if (tier.UTCStart == nil) != (tier.UTCEnd == nil) {
			return fmt.Errorf("tier %d: utc_start and utc_end must be set together", i)
		}
		if tier.HasWindow() {
			if !isValidHHMM(*tier.UTCStart) || !isValidHHMM(*tier.UTCEnd) {
				return fmt.Errorf("tier %d: utc_start and utc_end must be HHMM between 0000 and 2359", i)
			}
			if *tier.UTCStart == *tier.UTCEnd {
				return fmt.Errorf("tier %d: an empty time window never applies", i)
			}
		}
		if tier.MinPromptTokens == 0 && !tier.HasWindow() {
			return fmt.Errorf("tier %d: a tier needs min_prompt_tokens or a time window", i)
		}
		for _, rate := range []*float64{tier.PromptPricePer1M, tier.CompletionPer1M, tier.CacheReadPer1M, tier.CacheWritePer1M} {
			if rate != nil && !isValidRate(*rate) {
				return fmt.Errorf("tier %d: rates must be non-negative numbers", i)
			}
		}
	}
	return nil
}

// ChannelMultiplier scales every request a CPA provider answered, on top of the
// model's own price: a relay that resells at 30% of list is 0.3.
type ChannelMultiplier struct {
	Channel     string  `json:"channel"`
	Multiplier  float64 `json:"multiplier"`
	Note        string  `json:"note"`
	UpdatedAtMS int64   `json:"updated_at_ms"`
}

// Validate bounds a channel write.
func (c *ChannelMultiplier) Validate() error {
	c.Channel = strings.TrimSpace(c.Channel)
	c.Note = strings.TrimSpace(c.Note)
	if c.Channel == "" || len(c.Channel) > 256 {
		return errors.New("channel is required (max 256 chars)")
	}
	if len(c.Note) > 512 {
		return errors.New("note is too long (max 512 chars)")
	}
	if math.IsNaN(c.Multiplier) || math.IsInf(c.Multiplier, 0) || c.Multiplier <= 0 || c.Multiplier > 100 {
		return errors.New("multiplier must be greater than 0 and at most 100")
	}
	return nil
}

func isValidRate(value float64) bool {
	return !math.IsNaN(value) && !math.IsInf(value, 0) && value >= 0
}

func isValidHHMM(value int) bool {
	return value >= 0 && value <= 2359 && value%100 < 60
}

// CatalogProvider is model membership from the complete CPA discovery sweep.
// Display-name and icon overlays are resolved at read time by the facade.
type CatalogProvider struct {
	EndpointHost string   `json:"endpoint_host,omitempty"`
	ID           string   `json:"id"`
	Family       string   `json:"family"`
	Name         string   `json:"name"`
	Prefix       string   `json:"prefix,omitempty"`
	Channel      string   `json:"channel"`
	Priority     int      `json:"priority"`
	IsOAuth      bool     `json:"is_oauth"`
	Models       []string `json:"models"`
}

type ModelCatalogSnapshot struct {
	Models    map[string]string
	Providers []CatalogProvider
}
