package pricing

import (
	"math"
	"testing"
)

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
