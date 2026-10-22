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
