package pricing

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"math/big"
	"sort"
	"strconv"
)

// Tokens are one request's billable token buckets. Input includes cached and
// cache-creation tokens, which is how CPA reports them.
type Tokens struct {
	Input      int64 `json:"input"`
	Output     int64 `json:"output"`
	CacheRead  int64 `json:"cache_read"`
	CacheWrite int64 `json:"cache_write"`
}

// Bucket kinds in a Breakdown.
const (
	BucketPrompt     = "prompt"
	BucketCompletion = "completion"
	BucketCacheRead  = "cache_read"
	BucketCacheWrite = "cache_write"
)

// BreakdownBucket is one priced token bucket. Nanos is that bucket alone at the
// selected rate, before multipliers, rounded for display only; the request total
// is rounded once from the exact sum and can differ from summing the buckets.
type BreakdownBucket struct {
	Kind      string  `json:"kind"`
	Tokens    int64   `json:"tokens"`
	RatePer1M float64 `json:"rate_per_1m"`
	Nanos     int64   `json:"nanos"`
}

// Breakdown explains a request cost with structured fields only: the console
// localises every label, so nothing here is prose.
type Breakdown struct {
	TierIndex         *int              `json:"tier_index,omitempty"`
	Tier              *PriceTier        `json:"tier,omitempty"`
	Buckets           []BreakdownBucket `json:"buckets"`
	ModelMultiplier   float64           `json:"model_multiplier"`
	ChannelMultiplier float64           `json:"channel_multiplier"`
	TotalNanos        int64             `json:"total_nanos"`
}

// SelectTier picks the single override that governs a request. A tier applies
// when all of its conditions hold: min_prompt_tokens against the full input
// (cached tokens included, as the providers count it) and a half-open UTC window
// [start, end) that wraps past midnight when end <= start, read from the
// request's own timestamp so late ingestion cannot move it. Among applicable
// tiers the highest threshold wins, then a windowed tier over an unwindowed
// one, then list order — exactly one tier, never a stack.
func SelectTier(tiers []PriceTier, inputTokens, timestampMS int64) (int, bool) {
	minute := minuteOfDayUTC(timestampMS)
	best := -1
	for i, tier := range tiers {
		if tier.MinPromptTokens == 0 && !tier.HasWindow() {
			continue
		}
		if tier.MinPromptTokens > 0 && clampTokens(inputTokens) < tier.MinPromptTokens {
			continue
		}
		if tier.HasWindow() && !inWindow(minute, *tier.UTCStart, *tier.UTCEnd) {
			continue
		}
		if best < 0 || tierOutranks(tier, tiers[best]) {
			best = i
		}
	}
	return best, best >= 0
}

func tierOutranks(candidate, current PriceTier) bool {
	if candidate.MinPromptTokens != current.MinPromptTokens {
		return candidate.MinPromptTokens > current.MinPromptTokens
	}
	return candidate.HasWindow() && !current.HasWindow()
}

func minuteOfDayUTC(timestampMS int64) int {
	minutes := timestampMS / 60_000 % 1440
	if minutes < 0 {
		minutes += 1440
	}
	return int(minutes)
}

// inWindow tests a half-open HHMM window; a malformed or empty window never
// applies rather than applying all day.
func inWindow(minute, startHHMM, endHHMM int) bool {
	if !isValidHHMM(startHHMM) || !isValidHHMM(endHHMM) || startHHMM == endHHMM {
		return false
	}
	start := startHHMM/100*60 + startHHMM%100
	end := endHHMM/100*60 + endHHMM%100
	if start < end {
		return minute >= start && minute < end
	}
	return minute >= start || minute < end
}

// effectiveRates resolves the base rates with the selected tier laid over them.
func (p ModelPrice) effectiveRates(tier *PriceTier) (prompt, completion, cacheRead, cacheWrite float64) {
	prompt, completion, cacheRead, cacheWrite = p.PromptPricePer1M, p.CompletionPer1M, p.CacheReadPer1M, p.CacheWritePer1M
	if tier == nil {
		return
	}
	if tier.PromptPricePer1M != nil {
		prompt = *tier.PromptPricePer1M
	}
	if tier.CompletionPer1M != nil {
		completion = *tier.CompletionPer1M
	}
	if tier.CacheReadPer1M != nil {
		cacheRead = *tier.CacheReadPer1M
	}
	if tier.CacheWritePer1M != nil {
		cacheWrite = *tier.CacheWritePer1M
	}
	return
}

// Quote prices one request at the given price and channel multiplier. Decimal
// rates are accumulated exactly, both multipliers are applied as exact fractions,
// and the total is rounded half-up to USD nanos once — so a request with no
// tiers and a 1x channel costs exactly what the pre-tier formula charged.
func Quote(price ModelPrice, channelMultiplier float64, tokens Tokens, timestampMS int64) (Breakdown, error) {
	if err := price.ValidateRates(); err != nil {
		return Breakdown{}, err
	}
	if math.IsNaN(channelMultiplier) || math.IsInf(channelMultiplier, 0) || channelMultiplier <= 0 {
		return Breakdown{}, errors.New("channel multiplier must be a positive number")
	}
	breakdown := Breakdown{ModelMultiplier: price.PriceMultiplier, ChannelMultiplier: channelMultiplier}
	var tier *PriceTier
	if index, ok := SelectTier(price.Tiers, tokens.Input, timestampMS); ok {
		selected := price.Tiers[index]
		tier = &selected
		breakdown.TierIndex = &index
		breakdown.Tier = tier
	}
	prompt, completion, cacheRead, cacheWrite := price.effectiveRates(tier)
	uncached := clampTokens(tokens.Input)
	uncached -= min(uncached, clampTokens(tokens.CacheRead))
	uncached -= min(uncached, clampTokens(tokens.CacheWrite))
	total := new(big.Rat)
	for _, bucket := range []struct {
		kind   string
		tokens int64
		rate   float64
	}{
		{BucketPrompt, uncached, prompt},
		{BucketCompletion, clampTokens(tokens.Output), completion},
		{BucketCacheRead, clampTokens(tokens.CacheRead), cacheRead},
		{BucketCacheWrite, clampTokens(tokens.CacheWrite), cacheWrite},
	} {
		rate, err := exactDecimal(bucket.rate)
		if err != nil {
			return Breakdown{}, err
		}
		amount := rate.Mul(rate, new(big.Rat).SetInt64(bucket.tokens))
		total.Add(total, amount)
		bucketNanos, err := roundNanos(new(big.Rat).Mul(amount, big.NewRat(1000, 1)))
		if err != nil {
			return Breakdown{}, err
		}
		breakdown.Buckets = append(breakdown.Buckets, BreakdownBucket{Kind: bucket.kind, Tokens: bucket.tokens, RatePer1M: bucket.rate, Nanos: bucketNanos})
	}
	modelMultiplier, err := exactDecimal(price.PriceMultiplier)
	if err != nil {
		return Breakdown{}, err
	}
	channel, err := exactDecimal(channelMultiplier)
	if err != nil {
		return Breakdown{}, err
	}
	total.Mul(total, modelMultiplier.Mul(modelMultiplier, channel))
	total.Mul(total, big.NewRat(1000, 1)) // nanos/USD divided by tokens/million
	breakdown.TotalNanos, err = roundNanos(total)
	if err != nil {
		return Breakdown{}, err
	}
	return breakdown, nil
}

// CostNanos prices a request at the base rates with a 1x channel. It is the
// tier-free form Quote reduces to; the request lock always calls Quote.
func (p ModelPrice) CostNanos(input, output, cacheRead, cacheWrite int64) (int64, error) {
	price := p
	price.Tiers = nil
	breakdown, err := Quote(price, 1, Tokens{Input: input, Output: output, CacheRead: cacheRead, CacheWrite: cacheWrite}, 0)
	return breakdown.TotalNanos, err
}

// exactDecimal reads a float through its shortest decimal spelling, so 0.1 is
// one tenth rather than the binary fraction nearest to it.
func exactDecimal(value float64) (*big.Rat, error) {
	rate, ok := new(big.Rat).SetString(strconv.FormatFloat(value, 'g', -1, 64))
	if !ok {
		return nil, fmt.Errorf("invalid decimal rate")
	}
	return rate, nil
}

func roundNanos(value *big.Rat) (int64, error) {
	rounded, remainder := new(big.Int), new(big.Int)
	rounded.QuoRem(value.Num(), value.Denom(), remainder)
	if remainder.Lsh(remainder, 1).Cmp(value.Denom()) >= 0 {
		rounded.Add(rounded, big.NewInt(1))
	}
	if !rounded.IsInt64() {
		return 0, fmt.Errorf("request cost exceeds USD nanos range")
	}
	return rounded.Int64(), nil
}

func clampTokens(value int64) int64 {
	if value < 0 {
		return 0
	}
	return value
}

// EncodeTiers is the only spelling tiers are stored in. The version trigger
// compares the stored text, so two spellings of the same tiers would mint a new
// price version on every sync; sorting and a fixed field order make the text a
// function of the tiers alone.
func EncodeTiers(tiers []PriceTier) (string, error) {
	if len(tiers) == 0 {
		return "[]", nil
	}
	encoded, err := json.Marshal(CanonicalTiers(tiers))
	if err != nil {
		return "", fmt.Errorf("encode price tiers: %w", err)
	}
	return string(encoded), nil
}

// CanonicalTiers orders tiers the way they are stored, so a tie between two
// equally ranked tiers resolves the same before and after a round trip.
func CanonicalTiers(tiers []PriceTier) []PriceTier {
	if len(tiers) == 0 {
		return []PriceTier{}
	}
	sorted := make([]PriceTier, len(tiers))
	copy(sorted, tiers)
	sort.SliceStable(sorted, func(i, j int) bool {
		left, right := sorted[i], sorted[j]
		if left.MinPromptTokens != right.MinPromptTokens {
			return left.MinPromptTokens < right.MinPromptTokens
		}
		if left.HasWindow() != right.HasWindow() {
			return !left.HasWindow()
		}
		if left.HasWindow() && *left.UTCStart != *right.UTCStart {
			return *left.UTCStart < *right.UTCStart
		}
		return false
	})
	return sorted
}

// DecodeTiers reads stored tiers; an empty column is no tiers. The result is
// never nil, so the wire always carries a list.
func DecodeTiers(value string) ([]PriceTier, error) {
	if value == "" || value == "[]" {
		return []PriceTier{}, nil
	}
	var tiers []PriceTier
	if err := json.Unmarshal([]byte(value), &tiers); err != nil {
		return nil, fmt.Errorf("decode price tiers: %w", err)
	}
	return tiers, nil
}
