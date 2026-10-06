package pricing

import (
	"fmt"
	"math"
	"math/big"
	"strconv"
	"testing"
	"time"
)

// legacyCostNanos is the formula every request was priced with before tiers and
// channel multipliers existed, kept verbatim as the parity reference.
func legacyCostNanos(p ModelPrice, input, output, cacheRead, cacheWrite int64) (int64, error) {
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
	total.Mul(total, big.NewRat(1000, 1))
	rounded, remainder := new(big.Int), new(big.Int)
	rounded.QuoRem(total.Num(), total.Denom(), remainder)
	if remainder.Lsh(remainder, 1).Cmp(total.Denom()) >= 0 {
		rounded.Add(rounded, big.NewInt(1))
	}
	if !rounded.IsInt64() {
		return 0, fmt.Errorf("overflow")
	}
	return rounded.Int64(), nil
}

func TestCostNanosExactRoundingAndOverflow(t *testing.T) {
	p := ModelPrice{Model: "m", PromptPricePer1M: 0.0005, PriceMultiplier: 1}
	n, err := p.CostNanos(1, 0, 0, 0)
	if err != nil || n != 1 {
		t.Fatalf("half nano: %d %v", n, err)
	}
	p.PromptPricePer1M = 0.01
	n, err = p.CostNanos(1_000_000, 0, 0, 0)
	if err != nil || n != 10_000_000 {
		t.Fatalf("decimal: %d %v", n, err)
	}
	p.PromptPricePer1M = math.MaxFloat64
	if _, err = p.CostNanos(math.MaxInt64, 0, 0, 0); err == nil {
		t.Fatal("overflow accepted")
	}
	p.PromptPricePer1M = 1
	n, err = p.CostNanos(math.MaxInt64, 0, math.MaxInt64, math.MaxInt64)
	if err != nil || n != 0 {
		t.Fatalf("token subtraction overflow: %d %v", n, err)
	}
}

// A request with no tiers and a 1x channel must cost exactly what it cost before
// tiers existed, or historical and new totals would disagree.
func FuzzQuoteLegacyParity(f *testing.F) {
	f.Add(3.0, 15.0, 0.3, 3.75, 1.2, int64(120_000), int64(4_000), int64(80_000), int64(10_000))
	f.Add(0.0005, 0.0, 0.0, 0.0, 1.0, int64(1), int64(0), int64(0), int64(0))
	f.Add(0.0416666666666667, 0.1, 0.01, 0.0, 0.7, int64(-5), int64(99), int64(1_000), int64(0))
	f.Fuzz(func(t *testing.T, prompt, completion, cacheRead, cacheWrite, multiplier float64, input, output, read, write int64) {
		price := ModelPrice{Model: "m", PromptPricePer1M: prompt, CompletionPer1M: completion,
			CacheReadPer1M: cacheRead, CacheWritePer1M: cacheWrite, PriceMultiplier: multiplier}
		if price.ValidateRates() != nil {
			return
		}
		want, wantErr := legacyCostNanos(price, input, output, read, write)
		got, err := Quote(price, 1, Tokens{Input: input, Output: output, CacheRead: read, CacheWrite: write}, 0)
		if (wantErr != nil) != (err != nil) {
			t.Fatalf("error mismatch: legacy=%v quote=%v", wantErr, err)
		}
		if err == nil && got.TotalNanos != want {
			t.Fatalf("quote %d != legacy %d", got.TotalNanos, want)
		}
	})
}

// Both multipliers are exact fractions applied before one rounding: rounding
// after each would be one nano off here.
func TestQuoteRoundsOnceAcrossMultipliers(t *testing.T) {
	price := ModelPrice{Model: "m", PromptPricePer1M: 0.001, PriceMultiplier: 1.5}
	// One token at $0.001/1M is exactly 1 nano. Rounding after each multiplier
	// gives 1.5 → 2, then 2 × 0.3 = 0.6 → 1; one rounding of 1 × 1.5 × 0.3 = 0.45
	// gives 0.
	breakdown, err := Quote(price, 0.3, Tokens{Input: 1}, 0)
	if err != nil {
		t.Fatal(err)
	}
	if breakdown.TotalNanos != 0 {
		t.Fatalf("total = %d, want 0 (one rounding of 0.45 nanos)", breakdown.TotalNanos)
	}
	breakdown, err = Quote(ModelPrice{Model: "m", PromptPricePer1M: 2, PriceMultiplier: 1}, 0.3, Tokens{Input: 1_000_000}, 0)
	if err != nil || breakdown.TotalNanos != 600_000_000 {
		t.Fatalf("channel multiplier: %+v %v", breakdown, err)
	}
	if breakdown.ChannelMultiplier != 0.3 || breakdown.ModelMultiplier != 1 {
		t.Fatalf("multipliers not reported: %+v", breakdown)
	}
}

func ptr[T any](value T) *T { return &value }

func longContextPrice() ModelPrice {
	return ModelPrice{Model: "m", PromptPricePer1M: 3, CompletionPer1M: 15, CacheReadPer1M: 0.3, CacheWritePer1M: 3.75, PriceMultiplier: 1,
		Tiers: []PriceTier{
			{MinPromptTokens: 200_000, PromptPricePer1M: ptr(6.0), CompletionPer1M: ptr(22.5)},
			{MinPromptTokens: 500_000, PromptPricePer1M: ptr(9.0)},
		}}
}

func TestQuoteLongContextBoundary(t *testing.T) {
	price := longContextPrice()
	below, err := Quote(price, 1, Tokens{Input: 199_999, Output: 1_000_000}, 0)
	if err != nil || below.TierIndex != nil || below.TotalNanos != (199_999*3+15_000_000)*1000 {
		t.Fatalf("below threshold: %+v %v", below, err)
	}
	at, err := Quote(price, 1, Tokens{Input: 200_000, Output: 1_000_000}, 0)
	if err != nil || at.TierIndex == nil || *at.TierIndex != 0 {
		t.Fatalf("threshold not applied: %+v %v", at, err)
	}
	if at.TotalNanos != (200_000*6+22_500_000)*1000 {
		t.Fatalf("tier rates: %d", at.TotalNanos)
	}
	// Cached tokens count toward the threshold: 150k cached + 60k fresh is a
	// 210k-token prompt, billed at the tier's cache rate — inherited here.
	cached, err := Quote(price, 1, Tokens{Input: 210_000, CacheRead: 150_000}, 0)
	if err != nil || cached.TierIndex == nil {
		t.Fatalf("cached tokens ignored for the threshold: %+v %v", cached, err)
	}
	if want := int64(60_000*6+150_000*0.3) * 1000; cached.TotalNanos != want {
		t.Fatalf("inherited cache rate: %d want %d", cached.TotalNanos, want)
	}
	// The highest eligible threshold wins; its missing completion rate inherits
	// the base, not the lower tier.
	highest, err := Quote(price, 1, Tokens{Input: 600_000, Output: 1_000_000}, 0)
	if err != nil || highest.TierIndex == nil || *highest.TierIndex != 1 {
		t.Fatalf("highest tier not chosen: %+v %v", highest, err)
	}
	if highest.TotalNanos != (600_000*9+15_000_000)*1000 {
		t.Fatalf("tiers stacked or inherited from the wrong tier: %d", highest.TotalNanos)
	}
}

func at(hour, minute int) int64 {
	return time.Date(2026, 9, 28, hour, minute, 0, 0, time.UTC).UnixMilli()
}

func TestQuoteWrappingWindow(t *testing.T) {
	price := ModelPrice{Model: "m", PromptPricePer1M: 1, PriceMultiplier: 1,
		Tiers: []PriceTier{{UTCStart: ptr(1600), UTCEnd: ptr(0), PromptPricePer1M: ptr(0.5)}}}
	cases := []struct {
		hour, minute int
		discounted   bool
	}{{15, 59, false}, {16, 0, true}, {23, 59, true}, {0, 0, false}, {8, 30, false}}
	for _, tc := range cases {
		breakdown, err := Quote(price, 1, Tokens{Input: 1_000_000}, at(tc.hour, tc.minute))
		if err != nil {
			t.Fatal(err)
		}
		if (breakdown.TierIndex != nil) != tc.discounted {
			t.Fatalf("%02d:%02d discounted=%v, want %v", tc.hour, tc.minute, breakdown.TierIndex != nil, tc.discounted)
		}
	}
	complement := ModelPrice{Model: "m", PromptPricePer1M: 1, PriceMultiplier: 1,
		Tiers: []PriceTier{{UTCStart: ptr(0), UTCEnd: ptr(1600), PromptPricePer1M: ptr(0.5)}}}
	for _, tc := range cases {
		breakdown, _ := Quote(complement, 1, Tokens{Input: 1}, at(tc.hour, tc.minute))
		if (breakdown.TierIndex != nil) == tc.discounted {
			t.Fatalf("0000-1600 is not the complement at %02d:%02d", tc.hour, tc.minute)
		}
	}
	if _, ok := SelectTier([]PriceTier{{UTCStart: ptr(900), UTCEnd: ptr(900)}}, 0, at(9, 0)); ok {
		t.Fatal("an empty window applied")
	}
}

// Among tiers that all apply, the highest threshold wins, then a windowed tier
// over an unwindowed one.
func TestSelectTierPicksExactlyOne(t *testing.T) {
	tiers := []PriceTier{
		{MinPromptTokens: 100},
		{UTCStart: ptr(0), UTCEnd: ptr(2359)},
		{MinPromptTokens: 100, UTCStart: ptr(0), UTCEnd: ptr(2359)},
	}
	index, ok := SelectTier(tiers, 500, at(12, 0))
	if !ok || index != 2 {
		t.Fatalf("selected %d, want the windowed threshold tier", index)
	}
	index, ok = SelectTier(tiers, 50, at(12, 0))
	if !ok || index != 1 {
		t.Fatalf("selected %d, want the window-only tier", index)
	}
}

// A version written under the retired models.dev source stays priceable.
func TestQuoteAcceptsLegacyModelsDevVersion(t *testing.T) {
	legacy := ModelPrice{Model: "m", PromptPricePer1M: 1, PriceMultiplier: 1, Source: SourceModelsDev}
	if _, err := Quote(legacy, 1, Tokens{Input: 10}, 0); err != nil {
		t.Fatalf("legacy version refused: %v", err)
	}
	if err := legacy.ValidateWrite(); err == nil {
		t.Fatal("a new write under the retired source was accepted")
	}
}

func TestTiersJSONCanonical(t *testing.T) {
	first := []PriceTier{
		{UTCStart: ptr(1600), UTCEnd: ptr(0), PromptPricePer1M: ptr(0.0825)},
		{MinPromptTokens: 200_000, PromptPricePer1M: ptr(6.0)},
		{UTCStart: ptr(0), UTCEnd: ptr(1600), PromptPricePer1M: ptr(0.132)},
	}
	second := []PriceTier{first[1], first[2], first[0]}
	a, err := EncodeTiers(first)
	if err != nil {
		t.Fatal(err)
	}
	b, _ := EncodeTiers(second)
	if a != b {
		t.Fatalf("encoding depends on order:\n%s\n%s", a, b)
	}
	decoded, err := DecodeTiers(a)
	if err != nil {
		t.Fatal(err)
	}
	again, _ := EncodeTiers(decoded)
	if again != a {
		t.Fatalf("round trip changed the text:\n%s\n%s", a, again)
	}
	if empty, _ := EncodeTiers(nil); empty != "[]" {
		t.Fatalf("empty tiers = %q", empty)
	}
}

func TestModelPriceValidation(t *testing.T) {
	valid := func() ModelPrice { return ModelPrice{Model: "gpt-x", PriceMultiplier: 1, Source: SourceManual} }
	row := valid()
	if err := row.ValidateWrite(); err != nil {
		t.Fatalf("valid row rejected: %v", err)
	}
	for name, mutate := range map[string]func(*ModelPrice){
		"negative":       func(p *ModelPrice) { p.PromptPricePer1M = -1 },
		"zero multi":     func(p *ModelPrice) { p.PriceMultiplier = 0 },
		"nan":            func(p *ModelPrice) { p.CacheReadPer1M = math.NaN() },
		"unknown source": func(p *ModelPrice) { p.Source = "whatever" },
		"half window":    func(p *ModelPrice) { p.Tiers = []PriceTier{{UTCStart: ptr(100)}} },
		"bad hhmm":       func(p *ModelPrice) { p.Tiers = []PriceTier{{UTCStart: ptr(1260), UTCEnd: ptr(0)}} },
		"no condition":   func(p *ModelPrice) { p.Tiers = []PriceTier{{PromptPricePer1M: ptr(1.0)}} },
		"negative tier":  func(p *ModelPrice) { p.Tiers = []PriceTier{{MinPromptTokens: 5, PromptPricePer1M: ptr(-1.0)}} },
	} {
		row := valid()
		mutate(&row)
		if err := row.ValidateWrite(); err == nil {
			t.Fatalf("%s accepted", name)
		}
	}
}

func utcMS(year int, month time.Month, day, hour, minute int) int64 {
	return time.Date(year, month, day, hour, minute, 0, 0, time.UTC).UnixMilli()
}

// A vendor bills its off-peak hours on its own clock: 00:30–08:30 in Beijing is
// 16:30–00:30 UTC, and reading the same digits as UTC would discount the wrong
// half of the day.
func TestQuoteWindowIsReadInTheTiersOwnZone(t *testing.T) {
	offPeak := PriceTier{UTCStart: ptr(30), UTCEnd: ptr(830), TimeZone: "Asia/Shanghai", PromptPricePer1M: ptr(1.0)}
	price := ModelPrice{Model: "m", PromptPricePer1M: 2, PriceMultiplier: 1, Tiers: []PriceTier{offPeak}}
	for _, test := range []struct {
		name        string
		timestampMS int64
		wantTier    bool
	}{
		{"01:00 in Beijing", utcMS(2026, 10, 6, 17, 0), true},
		{"window start is inclusive", utcMS(2026, 10, 6, 16, 30), true},
		{"window end is exclusive", utcMS(2026, 10, 7, 0, 30), false},
		{"20:00 in Beijing, 01:00 would be UTC", utcMS(2026, 10, 6, 12, 0), false},
		{"01:00 UTC is 09:00 in Beijing", utcMS(2026, 10, 6, 1, 0), false},
	} {
		breakdown, err := Quote(price, 1, Tokens{Input: 1_000_000}, test.timestampMS)
		if err != nil || (breakdown.TierIndex != nil) != test.wantTier {
			t.Errorf("%s: tier applied = %v, want %v (%v)", test.name, breakdown.TierIndex != nil, test.wantTier, err)
		}
	}
	// The same digits without a zone stay a UTC window, as every stored tier is.
	price.Tiers[0].TimeZone = ""
	if breakdown, _ := Quote(price, 1, Tokens{Input: 1}, utcMS(2026, 10, 6, 1, 0)); breakdown.TierIndex == nil {
		t.Error("a tier without a zone must read its window in UTC")
	}
}

// A named zone follows the vendor's wall clock across daylight saving, which a
// window converted to UTC once cannot.
func TestQuoteZonedWindowFollowsDaylightSaving(t *testing.T) {
	price := ModelPrice{Model: "m", PromptPricePer1M: 2, PriceMultiplier: 1, Tiers: []PriceTier{
		{UTCStart: ptr(900), UTCEnd: ptr(1700), TimeZone: "America/New_York", PromptPricePer1M: ptr(4.0)},
	}}
	for _, test := range []struct {
		name        string
		timestampMS int64
		wantTier    bool
	}{
		{"09:30 EST", utcMS(2026, 1, 15, 14, 30), true},
		{"09:30 EDT", utcMS(2026, 7, 15, 13, 30), true},
		{"08:30 EDT, 09:30 by the winter offset", utcMS(2026, 7, 15, 12, 30), false},
		{"17:30 EDT", utcMS(2026, 7, 15, 21, 30), false},
	} {
		if index, ok := SelectTier(price.Tiers, 1, test.timestampMS); ok != test.wantTier {
			t.Errorf("%s: selected %d %v, want applied=%v", test.name, index, ok, test.wantTier)
		}
	}
}

func TestTierTimeZoneValidationAndEncoding(t *testing.T) {
	window := func(zone string) []PriceTier {
		return []PriceTier{{UTCStart: ptr(30), UTCEnd: ptr(830), TimeZone: zone}}
	}
	for _, zone := range []string{"Mars/Phobos", "Local", "../etc/passwd", "UTC+8"} {
		if err := ValidateTiers(window(zone)); err == nil {
			t.Errorf("time zone %q accepted", zone)
		}
	}
	for _, zone := range []string{"", "UTC", "Asia/Shanghai", "Etc/GMT-8"} {
		if err := ValidateTiers(window(zone)); err != nil {
			t.Errorf("time zone %q refused: %v", zone, err)
		}
	}
	if err := ValidateTiers([]PriceTier{{MinPromptTokens: 200_000, TimeZone: "Asia/Shanghai"}}); err == nil {
		t.Error("a time zone without a window accepted")
	}
	// A tier without a zone keeps its stored spelling, so the version trigger sees
	// no change on rows written before zones existed.
	encoded, err := EncodeTiers(window(""))
	if err != nil || encoded != `[{"utc_start":30,"utc_end":830}]` {
		t.Fatalf("zone-free spelling changed: %s %v", encoded, err)
	}
	encoded, err = EncodeTiers(window("Asia/Shanghai"))
	if err != nil || encoded != `[{"utc_start":30,"utc_end":830,"time_zone":"Asia/Shanghai"}]` {
		t.Fatalf("zoned spelling: %s %v", encoded, err)
	}
	decoded, err := DecodeTiers(encoded)
	if err != nil || len(decoded) != 1 || decoded[0].TimeZone != "Asia/Shanghai" {
		t.Fatalf("round trip: %+v %v", decoded, err)
	}
}
