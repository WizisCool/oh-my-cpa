// Package pricing keeps a simple per-model USD price table and computes
// estimated request costs. Prices follow cpa-usage-keeper / CPA-Manager-Plus:
// four rates per 1M tokens (prompt, completion, cache read, cache write) plus
// one optional multiplier. A model without a price row is unpriced, never zero.
package pricing

import (
	"errors"
	"fmt"
	"math"
	"strings"
)

// ModelPrice is one editable price row. Manual rows win over auto sync; the
// source records whether the last write came from the operator or models.dev.
type ModelPrice struct {
	Model            string  `json:"model"`
	PromptPricePer1M float64 `json:"prompt_price_per_1m"`
	CompletionPer1M  float64 `json:"completion_price_per_1m"`
	CacheReadPer1M   float64 `json:"cache_read_price_per_1m"`
	CacheWritePer1M  float64 `json:"cache_write_price_per_1m"`
	PriceMultiplier  float64 `json:"price_multiplier"`
	Source           string  `json:"source"`
	SyncedAtMS       int64   `json:"synced_at_ms"`
	UpdatedAtMS      int64   `json:"updated_at_ms"`
}

// Source values for ModelPrice.
const (
	SourceManual    = "manual"
	SourceModelsDev = "modelsdev"
)

// Validate rejects NaN/Inf, negative rates and a non-positive multiplier so a
// bad manual edit can never poison every later estimate.
func (p *ModelPrice) Validate() error {
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
		if math.IsNaN(value.price) || math.IsInf(value.price, 0) || value.price < 0 {
			return fmt.Errorf("%s must be a non-negative number", value.name)
		}
	}
	if math.IsNaN(p.PriceMultiplier) || math.IsInf(p.PriceMultiplier, 0) || p.PriceMultiplier <= 0 {
		return errors.New("price_multiplier must be a positive number")
	}
	switch p.Source {
	case "", SourceManual, SourceModelsDev:
	default:
		return fmt.Errorf("unknown price source %q", p.Source)
	}
	return nil
}

// CostUSD estimates one request from its token buckets. Negative buckets are
// clamped: bad telemetry must not create negative money.
func (p ModelPrice) CostUSD(input, output, cacheRead, cacheWrite int64) float64 {
	uncached := clampTokens(input) - clampTokens(cacheRead) - clampTokens(cacheWrite)
	if uncached < 0 {
		uncached = 0
	}
	cost := float64(uncached)/1e6*p.PromptPricePer1M +
		float64(clampTokens(cacheRead))/1e6*p.CacheReadPer1M +
		float64(clampTokens(cacheWrite))/1e6*p.CacheWritePer1M +
		float64(clampTokens(output))/1e6*p.CompletionPer1M
	return cost * p.PriceMultiplier
}

func clampTokens(value int64) int64 {
	if value < 0 {
		return 0
	}
	return value
}
