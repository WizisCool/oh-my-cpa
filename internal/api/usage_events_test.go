package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"testing"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/pricing"
	"github.com/oh-my-cpa/oh-my-cpa/internal/usage"
)

func TestUsageEventsSurfaceCostUSD(t *testing.T) {
	client, baseURL, repo := startDashboardTestServer(t, nil)
	ctx := context.Background()
	now := time.Now().UTC()

	// Seed model prices: $2/1M prompt, $10/1M completion, multiplier 1.5
	if err := repo.UpsertModelPrices(ctx, []pricing.ModelPrice{
		{
			Model:            "test-model",
			PromptPricePer1M: 2.0,
			CompletionPer1M:  10.0,
			PriceMultiplier:  1.5,
			Source:           pricing.SourceManual,
		},
	}); err != nil {
		t.Fatal(err)
	}

	// Insert 2 events: 1 with priced model, 1 with unpriced model
	timestamp := now.UnixMilli()
	if _, err := repo.InsertUsageEvents(ctx, []usage.Event{
		{
			InstanceID:  "default",
			EventKey:    "evt-priced",
			Model:       "test-model",
			Generate:    true,
			TimestampMS: timestamp,
			InputTokens: 1_000_000,
			TotalTokens: 1_000_000,
		},
		{
			InstanceID:  "default",
			EventKey:    "evt-unpriced",
			Model:       "unknown-model",
			Generate:    true,
			TimestampMS: timestamp - 1000,
			InputTokens: 500,
			TotalTokens: 500,
		},
	}); err != nil {
		t.Fatal(err)
	}

	// Test GET /omc/api/v1/usage/events
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, baseURL+"/omc/api/v1/usage/events", nil)
	if err != nil {
		t.Fatal(err)
	}
	resp, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("unexpected status: %d", resp.StatusCode)
	}

	var page struct {
		Items []struct {
			ID       int64    `json:"id"`
			EventKey string   `json:"event_key"`
			Model    string   `json:"model"`
			CostUSD  *float64 `json:"cost_usd"`
		} `json:"items"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&page); err != nil {
		t.Fatal(err)
	}

	if len(page.Items) != 2 {
		t.Fatalf("expected 2 items, got %d", len(page.Items))
	}

	var pricedFound, unpricedFound bool
	var pricedID int64
	for _, item := range page.Items {
		if item.EventKey == "evt-priced" {
			pricedFound = true
			pricedID = item.ID
			if item.CostUSD == nil {
				t.Fatalf("expected cost_usd to be non-nil for priced event")
			}
			// 1M * 2.0 / 1M * 1.5 = 3.0
			expected := 3.0
			if diff := *item.CostUSD - expected; diff < -1e-6 || diff > 1e-6 {
				t.Fatalf("expected cost_usd ~ 3.0, got %v", *item.CostUSD)
			}
		} else if item.EventKey == "evt-unpriced" {
			unpricedFound = true
			if item.CostUSD != nil {
				t.Fatalf("expected cost_usd to be nil for unpriced event, got %v", *item.CostUSD)
			}
		}
	}

	if !pricedFound || !unpricedFound {
		t.Fatalf("missing expected events in response: priced=%v, unpriced=%v", pricedFound, unpricedFound)
	}

	// Test GET /omc/api/v1/usage/events/{id} for the priced event
	detailReq, err := http.NewRequestWithContext(ctx, http.MethodGet, fmt.Sprintf("%s/omc/api/v1/usage/events/%d", baseURL, pricedID), nil)
	if err != nil {
		t.Fatal(err)
	}
	detailResp, err := client.Do(detailReq)
	if err != nil {
		t.Fatal(err)
	}
	defer detailResp.Body.Close()

	if detailResp.StatusCode != http.StatusOK {
		t.Fatalf("detail status: %d", detailResp.StatusCode)
	}

	var detailBody struct {
		Event map[string]any `json:"event"`
	}
	if err := json.NewDecoder(detailResp.Body).Decode(&detailBody); err != nil {
		t.Fatal(err)
	}

	costVal, exists := detailBody.Event["cost_usd"]
	if !exists || costVal == nil {
		t.Fatalf("detail response missing cost_usd: %+v", detailBody.Event)
	}
	costFloat, ok := costVal.(float64)
	if !ok || costFloat < 2.99 || costFloat > 3.01 {
		t.Fatalf("expected detail cost_usd ~ 3.0, got %v (%T)", costVal, costVal)
	}
}
