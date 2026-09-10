package pricing

import (
	"fmt"
	"math/big"
	"strconv"
)

// CostNanos locks USD at 1e-9 precision. Decimal rates are accumulated exactly
// and rounded half-up once per request, not once per token or to whole cents.
// Float conversion is reserved for display, not stored request amounts.
func (p ModelPrice) CostNanos(input, output, cacheRead, cacheWrite int64) (int64, error) {
	if err := p.Validate(); err != nil {
		return 0, err
	}
	uncached := clampTokens(input)
	uncached -= min(uncached, clampTokens(cacheRead))
	uncached -= min(uncached, clampTokens(cacheWrite))
	total := new(big.Rat)
	for _, bucket := range []struct {
		tokens int64
		rate   float64
	}{
		{uncached, p.PromptPricePer1M}, {clampTokens(output), p.CompletionPer1M},
		{clampTokens(cacheRead), p.CacheReadPer1M}, {clampTokens(cacheWrite), p.CacheWritePer1M},
	} {
		rate, ok := new(big.Rat).SetString(strconv.FormatFloat(bucket.rate, 'g', -1, 64))
		if !ok {
			return 0, fmt.Errorf("invalid decimal rate")
		}
		total.Add(total, rate.Mul(rate, new(big.Rat).SetInt64(bucket.tokens)))
	}
	multiplier, _ := new(big.Rat).SetString(strconv.FormatFloat(p.PriceMultiplier, 'g', -1, 64))
	total.Mul(total, multiplier)
	total.Mul(total, big.NewRat(1000, 1)) // nanos/USD divided by tokens/million
	rounded, remainder := new(big.Int), new(big.Int)
	rounded.QuoRem(total.Num(), total.Denom(), remainder)
	if remainder.Lsh(remainder, 1).Cmp(total.Denom()) >= 0 {
		rounded.Add(rounded, big.NewInt(1))
	}
	if !rounded.IsInt64() {
		return 0, fmt.Errorf("request cost exceeds USD nanos range")
	}
	return rounded.Int64(), nil
}
