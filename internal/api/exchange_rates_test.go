package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"testing"

	"github.com/oh-my-cpa/oh-my-cpa/internal/exchangerate"
	"github.com/oh-my-cpa/oh-my-cpa/internal/testkit"
)

type rateFetcher struct{ err error }

func (f *rateFetcher) Fetch(context.Context) ([]exchangerate.Rate, error) { return nil, f.err }

func TestExchangeRatesAreCachedAllowlistedReads(t *testing.T) {
	fetcher := &rateFetcher{err: errors.New("offline")}
	client, baseURL, repo := startDashboardTestServer(t, nil, func(h *Handler) { h.SetExchangeRates(exchangerate.NewService(h.repo, fetcher, nil)) })
	base := baseURL + "/omc/api/v1/exchange-rates"
	anonymous := &http.Client{}
	response, _ := getJSON(t, anonymous, base)
	if response.StatusCode != http.StatusUnauthorized {
		t.Fatal("rates read must require a session")
	}
	response, payload := getJSON(t, client, base)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("empty rates: %s", payload)
	}
	var actual any
	if err := json.Unmarshal(payload, &actual); err != nil {
		t.Fatal(err)
	}
	testkit.Golden(t, "testdata/golden/exchange-rates/empty.golden.json", actual)
	for _, entry := range []struct{ body, code string }{
		{`"usd"`, "invalid_display_currency"}, {`null`, "invalid_display_currency"}, {`"MYR"`, "display_currency_unavailable"},
	} {
		response, payload = doJSON(t, client, http.MethodPut, baseURL+"/omc/api/v1/preferences/omc_display_currency", entry.body)
		if response.StatusCode != http.StatusBadRequest || !strings.Contains(string(payload), entry.code) {
			t.Fatalf("currency validation: %d %s", response.StatusCode, payload)
		}
	}
	snapshot := exchangerate.Snapshot{Rates: []exchangerate.Rate{{Currency: "CNY", Rate: 6.7, Date: "2026-10-27"}, {Currency: "MYR", Rate: 4.1, Date: "2026-10-26"}}, UpdatedAtMS: 1793091600000, AttemptedAtMS: 1793091600000}
	if err := repo.SaveExchangeRates(context.Background(), snapshot); err != nil {
		t.Fatal(err)
	}
	response, payload = getJSON(t, client, base)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("cached rates: %s", payload)
	}
	if err := json.Unmarshal(payload, &actual); err != nil {
		t.Fatal(err)
	}
	testkit.Golden(t, "testdata/golden/exchange-rates/cached.golden.json", actual)
	response, payload = doJSON(t, client, http.MethodPut, baseURL+"/omc/api/v1/preferences/omc_display_currency", `"MYR"`)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("cached currency preference: %s", payload)
	}
	response, payload = doJSON(t, client, http.MethodPost, base+"/refresh", ``)
	if response.StatusCode != http.StatusBadGateway || string(payload) != "{\"error\":\"exchange_rate_fetch_failed\"}\n" {
		t.Fatalf("refresh failure leaked upstream data: %d %s", response.StatusCode, payload)
	}
}
