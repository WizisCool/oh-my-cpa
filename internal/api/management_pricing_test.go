package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"testing"

	"github.com/oh-my-cpa/oh-my-cpa/internal/pricing"
)

type fakePricing struct {
	listRows   []pricing.ModelPrice
	unpriced   []string
	state      pricing.SyncState
	known      bool
	running    bool
	acceptSync bool
	saved      []pricing.ModelPrice
	deleted    []string
	started    bool
	stateErr   error
}

func (f *fakePricing) ListPrices(context.Context) ([]pricing.ModelPrice, error) {
	return f.listRows, nil
}
func (f *fakePricing) SaveManualPrices(_ context.Context, rows []pricing.ModelPrice) error {
	f.saved = append(f.saved, rows...)
	return nil
}
func (f *fakePricing) DeletePrice(_ context.Context, model string) (bool, error) {
	f.deleted = append(f.deleted, model)
	return true, nil
}
func (f *fakePricing) UsedUnpricedModels(context.Context, int) ([]string, error) {
	return f.unpriced, nil
}
func (f *fakePricing) SyncStateView(context.Context) (pricing.SyncState, bool, error) {
	if f.stateErr != nil {
		return pricing.SyncState{}, false, f.stateErr
	}
	return f.state, f.known, nil
}
func (f *fakePricing) TriggerSync() bool {
	f.started = true
	return f.acceptSync
}
func (f *fakePricing) IsRunning() bool { return f.running }

// startPricingTestServer boots the real router with a fake pricing manager
// attached through the same SetPricing seam the app uses at startup.
func startPricingTestServer(t *testing.T, fake *fakePricing) (*http.Client, string) {
	t.Helper()
	client, baseURL, _ := startDashboardTestServer(t, nil, func(handler *Handler) {
		handler.SetPricing(fake)
	})
	return client, baseURL
}

func TestPricingWithoutServiceReturnsUnavailable(t *testing.T) {
	client, baseURL, _ := startDashboardTestServer(t, nil)
	response, payload := getJSON(t, client, baseURL+"/omc/api/v1/pricing")
	if response.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("pricing without service status = %d body %s", response.StatusCode, payload)
	}
}

func TestPricingPageEndpointShape(t *testing.T) {
	fake := &fakePricing{
		listRows: []pricing.ModelPrice{{
			Model: "openai/gpt-5", PromptPricePer1M: 2, CompletionPer1M: 10,
			PriceMultiplier: 1, Source: pricing.SourceModelsDev,
		}},
		unpriced: []string{"mystery-model"},
		state:    pricing.SyncState{Source: pricing.SourceModelsDev, LastMatched: 3, LastUnmatched: 1},
		known:    true,
	}
	client, baseURL := startPricingTestServer(t, fake)

	response, payload := getJSON(t, client, baseURL+"/omc/api/v1/pricing")
	if response.StatusCode != http.StatusOK {
		t.Fatalf("pricing status = %d body %s", response.StatusCode, payload)
	}
	var body struct {
		Source   string               `json:"source"`
		Models   []pricing.ModelPrice `json:"models"`
		Unpriced []string             `json:"unpriced"`
		Sync     struct {
			Known   bool              `json:"known"`
			Running bool              `json:"running"`
			State   pricing.SyncState `json:"state"`
		} `json:"sync"`
	}
	if err := json.Unmarshal(payload, &body); err != nil {
		t.Fatal(err)
	}
	if body.Source != pricing.SourceModelsDev || len(body.Models) != 1 || !body.Sync.Known {
		t.Fatalf("unexpected pricing body: %+v", body)
	}
}

func TestPricingManualEditAndDeleteAndSync(t *testing.T) {
	fake := &fakePricing{acceptSync: true}
	client, baseURL := startPricingTestServer(t, fake)

	// Unknown fields are rejected so a typo cannot silently change rates.
	body := `{"models":[{"model":"bad","unknown_field":1}]}`
	put, _ := http.NewRequest(http.MethodPut, baseURL+"/omc/api/v1/pricing/models", bytes.NewBufferString(body))
	put.Header.Set("Content-Type", "application/json")
	response, _ := client.Do(put)
	if response.StatusCode != http.StatusBadRequest {
		t.Fatalf("unknown field status = %d", response.StatusCode)
	}
	response.Body.Close()

	editBody := `{"models":[{"model":"manual-model","prompt_price_per_1m":5,"completion_price_per_1m":5,"cache_read_price_per_1m":0,"cache_write_price_per_1m":0,"price_multiplier":1}]}`
	put, _ = http.NewRequest(http.MethodPut, baseURL+"/omc/api/v1/pricing/models", bytes.NewBufferString(editBody))
	put.Header.Set("Content-Type", "application/json")
	response, _ = client.Do(put)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("update status = %d", response.StatusCode)
	}
	response.Body.Close()
	if len(fake.saved) != 1 || fake.saved[0].Model != "manual-model" {
		t.Fatalf("manual rows not saved: %+v", fake.saved)
	}

	del, _ := http.NewRequest(http.MethodDelete, baseURL+"/omc/api/v1/pricing/models/manual-model", nil)
	response, _ = client.Do(del)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("delete status = %d", response.StatusCode)
	}
	response.Body.Close()
	if len(fake.deleted) != 1 || fake.deleted[0] != "manual-model" {
		t.Fatalf("delete not routed: %+v", fake.deleted)
	}

	// Sync: 202 on start, 409 while one is already in flight.
	sync, _ := http.NewRequest(http.MethodPost, baseURL+"/omc/api/v1/pricing/sync", nil)
	response, _ = client.Do(sync)
	if response.StatusCode != http.StatusAccepted {
		t.Fatalf("sync start status = %d", response.StatusCode)
	}
	response.Body.Close()
	fake.running = true
	fake.acceptSync = false
	response, _ = client.Do(sync)
	if response.StatusCode != http.StatusConflict {
		t.Fatalf("conflicting sync status = %d", response.StatusCode)
	}
	response.Body.Close()
	if !fake.started {
		t.Fatal("TriggerSync was never called")
	}
}

// Sync bookkeeping is a side panel, not a precondition for pricing. When its row
// cannot be read at all, the page must still get every price and see the reason
// as a sync error instead of a blank 500 screen.
func TestPricingPageDegradesWhenSyncStateUnreadable(t *testing.T) {
	fake := &fakePricing{
		listRows: []pricing.ModelPrice{{
			Model: "openai/gpt-5", PromptPricePer1M: 2, CompletionPer1M: 10,
			PriceMultiplier: 1, Source: pricing.SourceModelsDev,
		}},
		unpriced: []string{"mystery-model"},
		stateErr: errors.New("corrupt sync state"),
	}
	client, baseURL := startPricingTestServer(t, fake)

	response, payload := getJSON(t, client, baseURL+"/omc/api/v1/pricing")
	if response.StatusCode != http.StatusOK {
		t.Fatalf("pricing status = %d body %s", response.StatusCode, payload)
	}
	var body struct {
		Models   []pricing.ModelPrice `json:"models"`
		Unpriced []string             `json:"unpriced"`
		Sync     struct {
			Known bool              `json:"known"`
			State pricing.SyncState `json:"state"`
		} `json:"sync"`
	}
	if err := json.Unmarshal(payload, &body); err != nil {
		t.Fatal(err)
	}
	if len(body.Models) != 1 || len(body.Unpriced) != 1 {
		t.Fatalf("prices must still load: %s", payload)
	}
	if body.Sync.Known {
		t.Fatal("an unreadable state must report known=false")
	}
	if !strings.Contains(body.Sync.State.LastError, "corrupt sync state") {
		t.Fatalf("the reason must reach the UI as last_error, got %q", body.Sync.State.LastError)
	}
}
