package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"testing"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
	"github.com/oh-my-cpa/oh-my-cpa/internal/usage"
)

func TestUsageEventsResolveCodexTierAcrossListDetailAndFacets(t *testing.T) {
	client, baseURL, repo := startDashboardTestServer(t, nil)
	at := time.Now().Add(-time.Minute)
	for _, provider := range []string{"codex", "openai"} {
		event := filterEventFor(provider, at, func(event *usage.Event) {
			event.Provider = provider
			event.ServiceTier, event.ResponseServiceTier = "priority", "default"
		})
		if _, err := repo.InsertUsageEvents(t.Context(), []usage.Event{event}); err != nil {
			t.Fatal(err)
		}
	}
	response, payload := getJSON(t, client, baseURL+"/omc/api/v1/usage/events?preset=24h&resolved_service_tier=priority")
	var page struct {
		Items []usageEventResponse `json:"items"`
	}
	decodeFilterJSON(t, payload, &page)
	if response.StatusCode != http.StatusOK || len(page.Items) != 1 {
		t.Fatalf("resolved filter: %d %s", response.StatusCode, payload)
	}
	item := page.Items[0]
	if item.Provider != "codex" || item.ServiceTier != "priority" || item.ResponseServiceTier != "default" || item.ResolvedServiceTier != "priority" || item.ResolvedServiceTierSource != "request" {
		t.Fatalf("list evidence: %+v", item)
	}
	response, payload = getJSON(t, client, fmt.Sprintf("%s/omc/api/v1/usage/events/%d", baseURL, item.ID))
	var detail struct {
		Event usageEventResponse `json:"event"`
	}
	decodeFilterJSON(t, payload, &detail)
	if response.StatusCode != http.StatusOK || detail.Event.ServiceTier != "priority" || detail.Event.ResponseServiceTier != "default" || detail.Event.ResolvedServiceTier != "priority" || detail.Event.ResolvedServiceTierSource != "request" {
		t.Fatalf("detail evidence: %d %s", response.StatusCode, payload)
	}
	response, payload = getJSON(t, client, baseURL+"/omc/api/v1/usage/events?preset=24h&service_tier=priority")
	decodeFilterJSON(t, payload, &page)
	if response.StatusCode != http.StatusOK || len(page.Items) != 2 {
		t.Fatalf("raw filter contract: %d %s", response.StatusCode, payload)
	}
	response, payload = getJSON(t, client, baseURL+"/omc/api/v1/usage/facets?preset=24h")
	var facets struct {
		Facets repository.UsageFacets `json:"facets"`
	}
	if err := json.Unmarshal(payload, &facets); err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != http.StatusOK || len(facets.Facets.ResolvedServiceTiers) != 2 || len(facets.Facets.ServiceTiers) != 1 {
		t.Fatalf("facets: %d %s", response.StatusCode, payload)
	}
}

func TestUsageEventsOutboundTierAcrossListDetailAndFacets(t *testing.T) {
	client, baseURL, repo := startDashboardTestServer(t, nil)
	at := time.Now().Add(-time.Minute)
	for _, test := range []struct{ key, requested, effective string }{
		{"outbound-fast", "auto", "priority"}, {"old-fast", "priority", ""},
		{"outbound-default", "priority", "default"}, {"outbound-auto", "priority", "auto"},
	} {
		event := filterEventFor(test.key, at, func(event *usage.Event) {
			event.Provider = "codex"
			event.ServiceTier = test.requested
			event.EffectiveServiceTier = test.effective
			event.ResponseServiceTier = "default"
		})
		if _, err := repo.InsertUsageEvents(t.Context(), []usage.Event{event}); err != nil {
			t.Fatal(err)
		}
	}
	response, payload := getJSON(t, client, baseURL+"/omc/api/v1/usage/events?preset=24h&resolved_service_tier=priority")
	var page struct {
		Items []usageEventResponse `json:"items"`
	}
	decodeFilterJSON(t, payload, &page)
	if response.StatusCode != http.StatusOK || len(page.Items) != 2 {
		t.Fatalf("mixed gateway filter: %d %s", response.StatusCode, payload)
	}
	var outbound usageEventResponse
	for _, item := range page.Items {
		if item.EffectiveServiceTier != "" {
			outbound = item
		}
	}
	if outbound.EffectiveServiceTier != "priority" || outbound.ResolvedServiceTier != "priority" || outbound.ServiceTier != "auto" || outbound.ResponseServiceTier != "default" || outbound.ResolvedServiceTierSource != "outbound" {
		t.Fatalf("outbound list: %+v", outbound)
	}
	response, payload = getJSON(t, client, fmt.Sprintf("%s/omc/api/v1/usage/events/%d", baseURL, outbound.ID))
	var detail struct {
		Event usageEventResponse `json:"event"`
	}
	decodeFilterJSON(t, payload, &detail)
	if response.StatusCode != http.StatusOK || detail.Event.EffectiveServiceTier != "priority" || detail.Event.ResolvedServiceTier != "priority" || detail.Event.ResolvedServiceTierSource != "outbound" {
		t.Fatalf("outbound detail: %d %s", response.StatusCode, payload)
	}
	response, payload = getJSON(t, client, baseURL+"/omc/api/v1/usage/events?preset=24h")
	var rawPage struct {
		Items []map[string]json.RawMessage `json:"items"`
	}
	decodeFilterJSON(t, payload, &rawPage)
	if response.StatusCode != http.StatusOK || len(rawPage.Items) != 4 {
		t.Fatalf("all outbound records: %d %s", response.StatusCode, payload)
	}
	hasAuto := false
	for _, item := range rawPage.Items {
		if string(item["effective_service_tier"]) != `"auto"` {
			continue
		}
		hasAuto = true
		if _, exists := item["resolved_service_tier"]; exists || string(item["resolved_service_tier_source"]) != `"outbound"` {
			t.Fatalf("explicit auto must expose an outbound source without a resolved tier: %s", payload)
		}
		var id int64
		if err := json.Unmarshal(item["id"], &id); err != nil {
			t.Fatal(err)
		}
		response, payload = getJSON(t, client, fmt.Sprintf("%s/omc/api/v1/usage/events/%d", baseURL, id))
		detail.Event = usageEventResponse{}
		decodeFilterJSON(t, payload, &detail)
		if response.StatusCode != http.StatusOK || detail.Event.EffectiveServiceTier != "auto" || detail.Event.ResolvedServiceTier != "" || detail.Event.ResolvedServiceTierSource != "outbound" {
			t.Fatalf("auto detail: %d %s", response.StatusCode, payload)
		}
		var detailWire struct {
			Event map[string]json.RawMessage `json:"event"`
		}
		decodeFilterJSON(t, payload, &detailWire)
		if tier, exists := detailWire.Event["resolved_service_tier"]; !exists || string(tier) != `""` {
			t.Fatalf("detail must preserve its explicit empty-tier wire representation: %s", payload)
		}
	}
	if !hasAuto {
		t.Fatal("explicit outbound auto record was not returned")
	}
	response, payload = getJSON(t, client, baseURL+"/omc/api/v1/usage/events?preset=24h&service_tier=priority")
	decodeFilterJSON(t, payload, &page)
	if response.StatusCode != http.StatusOK || len(page.Items) != 3 {
		t.Fatalf("original request filter: %d %s", response.StatusCode, payload)
	}
	response, payload = getJSON(t, client, baseURL+"/omc/api/v1/usage/events?preset=24h&resolved_service_tier=default")
	decodeFilterJSON(t, payload, &page)
	if response.StatusCode != http.StatusOK || len(page.Items) != 1 || page.Items[0].EffectiveServiceTier != "default" || page.Items[0].ResolvedServiceTier != "default" || page.Items[0].ResolvedServiceTierSource != "outbound" {
		t.Fatalf("outbound downgrade filter: %d %s", response.StatusCode, payload)
	}
	response, payload = getJSON(t, client, baseURL+"/omc/api/v1/usage/facets?preset=24h")
	var facets struct {
		Facets repository.UsageFacets `json:"facets"`
	}
	decodeFilterJSON(t, payload, &facets)
	counts := map[string]int64{}
	for _, tier := range facets.Facets.ResolvedServiceTiers {
		counts[tier.Value] = tier.Requests
	}
	if response.StatusCode != http.StatusOK || len(counts) != 2 || counts["priority"] != 2 || counts["default"] != 1 {
		t.Fatalf("outbound facets: %d %s", response.StatusCode, payload)
	}
}
