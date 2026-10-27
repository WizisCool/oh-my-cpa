package exchangerate

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"slices"
	"sort"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/remotedata"
)

const Source = "frankfurter_v2"
const RefreshInterval = 24 * time.Hour
const FRANKFURTER_URL = "https://api.frankfurter.dev/v2/rates?base=USD"

// Rate converts one accounting USD into the display currency. Each currency
// retains its own observation date: providers do not share a publication calendar.
type Rate struct {
	Currency string  `json:"currency"`
	Rate     float64 `json:"rate"`
	Date     string  `json:"date"`
}

type Snapshot struct {
	Rates         []Rate
	UpdatedAtMS   int64
	AttemptedAtMS int64
	LastError     string
}

// DISPLAY_CURRENCIES is the closed set an operator can read amounts in. The
// console carries the same list with a flag and a symbol for each, so a code
// outside it would have neither; the cache keeps only these quotes.
var DISPLAY_CURRENCIES = []string{"USD", "CNY", "EUR", "JPY", "GBP", "HKD", "SGD", "MYR", "KRW", "AUD", "CAD"}

func IsDisplayCurrency(code string) bool {
	return slices.Contains(DISPLAY_CURRENCIES, code)
}

func IsCurrency(code string) bool {
	if len(code) != 3 {
		return false
	}
	for _, letter := range code {
		if letter < 'A' || letter > 'Z' {
			return false
		}
	}
	return true
}

// DecodeFrankfurter refuses a partial or invalid refresh instead of publishing
// mixed old/new rates. USD is an identity, never a provider-supplied conversion.
func DecodeFrankfurter(body []byte) ([]Rate, error) {
	var rows []struct {
		Date  string  `json:"date"`
		Base  string  `json:"base"`
		Quote string  `json:"quote"`
		Rate  float64 `json:"rate"`
	}
	if err := json.Unmarshal(body, &rows); err != nil {
		return nil, fmt.Errorf("decode Frankfurter rates: %w", err)
	}
	rates := make([]Rate, 0, len(rows))
	seen := make(map[string]bool, len(rows))
	for _, row := range rows {
		_, dateErr := time.Parse(time.DateOnly, row.Date)
		if row.Base != "USD" || !IsCurrency(row.Quote) || dateErr != nil || row.Rate <= 0 || math.IsNaN(row.Rate) || math.IsInf(row.Rate, 0) || seen[row.Quote] || (row.Quote == "USD" && row.Rate != 1) {
			return nil, fmt.Errorf("invalid Frankfurter rate")
		}
		seen[row.Quote] = true
		if row.Quote != "USD" && IsDisplayCurrency(row.Quote) {
			rates = append(rates, Rate{Currency: row.Quote, Rate: row.Rate, Date: row.Date})
		}
	}
	// A snapshot replaces the whole table, so one missing quote would leave an
	// operator who chose that currency with no reading until the next refresh.
	for _, required := range DISPLAY_CURRENCIES {
		if required != "USD" && !seen[required] {
			return nil, fmt.Errorf("Frankfurter snapshot is missing %s", required)
		}
	}
	sort.Slice(rates, func(left, right int) bool { return rates[left].Currency < rates[right].Currency })
	return rates, nil
}

type FrankfurterClient struct{ client *http.Client }

func NewFrankfurterClient() *FrankfurterClient {
	return &FrankfurterClient{client: &http.Client{Timeout: 20 * time.Second, CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }}}
}

func (c *FrankfurterClient) Fetch(ctx context.Context) ([]Rate, error) {
	body, err := remotedata.Fetch(ctx, c.client, FRANKFURTER_URL, "oh-my-cpa-exchange-rates/1", 1<<20)
	if err != nil {
		return nil, fmt.Errorf("fetch Frankfurter rates: %w", err)
	}
	return DecodeFrankfurter(body)
}
