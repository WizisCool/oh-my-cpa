package quota

import (
	"testing"
)

// TestParseCentValAcceptsWrappedAmounts pins the upstream shapes for a credit
// amount: the billing endpoint nests the number under "val" in some responses
// and sends a bare number in others. Both must decode, and the key must stay
// spelled "val" — it is the provider's field name, not ours.
func TestParseCentValAcceptsWrappedAmounts(t *testing.T) {
	cases := []struct {
		name  string
		value any
		want  int64
	}{
		{name: "wrapped val key", value: map[string]any{"val": float64(3450)}, want: 3450},
		{name: "bare number", value: float64(3450), want: 3450},
		{name: "string number", value: "3450", want: 3450},
		{name: "absent", value: nil, want: 0},
		{name: "unusable", value: map[string]any{"value": float64(3450)}, want: 0},
	}
	for _, testCase := range cases {
		if got := parseCentVal(testCase.value); got != testCase.want {
			t.Errorf("%s: parseCentVal(%#v) = %d, want %d", testCase.name, testCase.value, got, testCase.want)
		}
	}
}
