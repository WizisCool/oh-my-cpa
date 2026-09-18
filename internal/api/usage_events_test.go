package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/pricing"
	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
	"github.com/oh-my-cpa/oh-my-cpa/internal/usage"
)

func TestUsageEventsSurfaceCostUSD(t *testing.T) {
	client, baseURL, repo := startDashboardTestServer(t, nil)
	ctx := context.Background()
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
	timestamp := time.Now().UnixMilli()
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

func TestUsageEventsListFilterAndCursor(t *testing.T) {
	client, baseURL, repo := startDashboardTestServer(t, nil)
	now := time.Now().UTC()
	seedEvents(t, repo, now, []repository.UsageDecoded{
		{Event: eventFor("e1", now.Add(-5*time.Minute), usage.TokenStats{TotalTokens: 5}, false)},
		{Event: eventFor("e2", now.Add(-4*time.Minute), usage.TokenStats{TotalTokens: 6}, true)},
		{Event: eventFor("e3", now.Add(-3*time.Minute), usage.TokenStats{TotalTokens: 7}, false)},
	})
	listURL := baseURL + "/omc/api/v1/usage/events?preset=24h"

	response, payload := getJSON(t, client, listURL)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("status = %d body %s", response.StatusCode, payload)
	}
	var page struct {
		Items      []usageEventResponse `json:"items"`
		NextCursor string               `json:"next_cursor"`
		HasMore    bool                 `json:"has_more"`
		Limit      int                  `json:"limit"`
	}
	if err := json.Unmarshal(payload, &page); err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != 3 || page.Limit != repository.DefaultUsageEventLimit {
		t.Fatalf("listing wrong: %d items limit %d", len(page.Items), page.Limit)
	}
	// Newest first.
	if page.Items[0].EventKey != "e3" || page.Items[2].EventKey != "e1" {
		t.Fatalf("ordering wrong: %s .. %s", page.Items[0].EventKey, page.Items[2].EventKey)
	}
	if page.HasMore {
		t.Fatal("no more pages expected")
	}

	// Result filter.
	response, payload = getJSON(t, client, listURL+"&result=failed")
	if err := json.Unmarshal(payload, &page); err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != 1 || page.Items[0].EventKey != "e2" {
		t.Fatalf("failed filter wrong: %#v", page.Items)
	}

	// Model + auth index filters, and an impossible combination.
	response, payload = getJSON(t, client, listURL+"&model=gemini-2.5-pro&auth_index=auth-1")
	if err := json.Unmarshal(payload, &page); err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != 3 {
		t.Fatalf("matching filters dropped rows: %d", len(page.Items))
	}
	response, payload = getJSON(t, client, listURL+"&model=does-not-exist")
	if err := json.Unmarshal(payload, &page); err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != 0 {
		t.Fatal("non-matching model must return no rows")
	}

	// Keyset pagination: limit 2 then follow the cursor.
	response, payload = getJSON(t, client, listURL+"&limit=2")
	if err := json.Unmarshal(payload, &page); err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != 2 || !page.HasMore || page.NextCursor == "" {
		t.Fatalf("first page wrong: %d hasMore=%v cursor=%q", len(page.Items), page.HasMore, page.NextCursor)
	}
	response, payload = getJSON(t, client, listURL+"&limit=2&cursor="+page.NextCursor)
	if err := json.Unmarshal(payload, &page); err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != 1 || page.Items[0].EventKey != "e1" {
		t.Fatalf("second page wrong: %#v", page.Items)
	}

	// A tampered cursor must be rejected, not silently ignored.
	response, payload = getJSON(t, client, listURL+"&cursor=not-a-cursor")
	if response.StatusCode != http.StatusInternalServerError && response.StatusCode != http.StatusBadRequest {
		t.Fatalf("bad cursor status = %d", response.StatusCode)
	}
	if !strings.Contains(strings.ToLower(string(payload)), "cursor") {
		t.Fatalf("bad cursor message = %s", payload)
	}
}

// The console's "N records arrived" pill asks the server to count what has been
// recorded since the reader stopped following. It is a request-time-ordered list
// whose arrivals can sort anywhere, so the count cannot be derived from the page.
func TestUsageEventsArrivalCount(t *testing.T) {
	client, baseURL, repo := startDashboardTestServer(t, nil)
	now := time.Now().UTC()
	seedEvents(t, repo, now, []repository.UsageDecoded{
		{Event: eventFor("older", now.Add(-5*time.Minute), usage.TokenStats{TotalTokens: 5}, false)},
	})
	listURL := baseURL + "/omc/api/v1/usage/events?preset=24h"

	var page struct {
		Items        []usageEventResponse `json:"items"`
		ArrivedCount int64                `json:"arrived_count"`
	}
	_, payload := getJSON(t, client, listURL)
	if err := json.Unmarshal(payload, &page); err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != 1 {
		t.Fatalf("items = %d, want 1", len(page.Items))
	}
	if page.ArrivedCount != 0 {
		t.Fatalf("arrived_count = %d without asking for it, want 0", page.ArrivedCount)
	}
	boundary := page.Items[0].ID

	// One record with a newer request time and one that ran long and only just
	// finished: both were recorded after the boundary, so both must be counted
	// even though only one of them is newer in request time.
	seedEvents(t, repo, now, []repository.UsageDecoded{
		{Event: eventFor("newer", now.Add(-time.Minute), usage.TokenStats{TotalTokens: 5}, false)},
		{Event: eventFor("slow-arrival", now.Add(-40*time.Minute), usage.TokenStats{TotalTokens: 5}, false)},
	})

	_, payload = getJSON(t, client, listURL+"&since="+strconv.FormatInt(boundary, 10))
	if err := json.Unmarshal(payload, &page); err != nil {
		t.Fatal(err)
	}
	if page.ArrivedCount != 2 {
		t.Fatalf("arrived_count = %d, want both records recorded after the boundary", page.ArrivedCount)
	}

	// A malformed boundary is refused rather than ignored: dropping it silently
	// would report "nothing new" forever.
	response, payload := getJSON(t, client, listURL+"&since=not-a-number")
	if response.StatusCode != http.StatusBadRequest {
		t.Fatalf("bad since status = %d body %s", response.StatusCode, payload)
	}
}

// The list view is an identity surface: it names who called and what it cost.
// Client IP, the forwarded-for chain and the full endpoint stay in the
// single-record detail where diagnosis actually needs them. The user agent is
// list-safe because ingestion minimizes it to a product label before storage.
func TestUsageEventListOmitsDiagnosticFields(t *testing.T) {
	client, baseURL, repo := startDashboardTestServer(t, nil)
	now := time.Now().UTC()
	event := eventFor("private-scope", now.Add(-time.Minute), usage.TokenStats{TotalTokens: 4}, false)
	event.Endpoint = "https://internal-relay.example.internal/v1/responses"
	clientIP := "192.0.2.44"
	forwarded := "203.0.113.9"
	agent := "secret-client/9.9 (fixture)"
	event.ClientIP = &clientIP
	event.XForwardedFor = &forwarded
	event.UserAgent = &agent
	event.APIGroupLabel = "api_key"
	event.APIKeyMask = "sk-12345••••••••7890"
	seedEvents(t, repo, now, []repository.UsageDecoded{{Event: event}})
	listURL := baseURL + "/omc/api/v1/usage/events?preset=24h"

	response, payload := getJSON(t, client, listURL)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("status = %d body %s", response.StatusCode, payload)
	}
	for _, forbidden := range []string{"client_ip", "x_forwarded_for", "endpoint", "192.0.2.", "203.0.113.", "internal-relay"} {
		if strings.Contains(string(payload), forbidden) {
			t.Fatalf("list payload leaked diagnostic field %q: %s", forbidden, payload)
		}
	}
	var list struct {
		Items []map[string]any `json:"items"`
	}
	if err := json.Unmarshal(payload, &list); err != nil {
		t.Fatal(err)
	}
	if len(list.Items) != 1 {
		t.Fatalf("expected one listed record, got %d", len(list.Items))
	}
	// Identity attribution itself must survive: provider, credential index and
	// the caller group are the legitimate list fields.
	for _, required := range []string{"provider", "auth_index", "api_group_key", "source"} {
		if _, ok := list.Items[0][required]; !ok {
			t.Fatalf("list payload dropped identity field %q", required)
		}
	}
	// The user agent is allowed on the list, but only in its minimized
	// product-label form: the diagnostic suffix must have been stripped.
	if got := list.Items[0]["user_agent"]; got != "secret-client/9.9" {
		t.Fatalf("list user_agent = %v, want minimized product label", got)
	}
	// The caller key reaches the console as a display mask only: the raw key is
	// never stored, and the mask is not the identity used for grouping.
	if got := list.Items[0]["api_key_mask"]; got != "sk-12345••••••••7890" {
		t.Fatalf("list api_key_mask = %v", got)
	}

	// The same record on the detail view keeps diagnosis data behind one id.
	id := int64(list.Items[0]["id"].(float64))
	_, detail := getJSON(t, client, fmt.Sprintf("%s/omc/api/v1/usage/events/%d", baseURL, id))
	// Protected detail keeps the diagnostic address and proxy chain, while the
	// user agent is still reduced before persistence.
	for _, expected := range []string{"client_ip", "x_forwarded_for", "user_agent", "endpoint", "192.0.2.44", "203.0.113.9", "secret-client", "api_key_mask", "sk-12345••••••••7890"} {
		if !strings.Contains(string(detail), expected) {
			t.Fatalf("detail payload missing diagnostic field %q: %s", expected, detail)
		}
	}
}

func TestUsageEventListPreservesExplicitNonStreamingFlag(t *testing.T) {
	client, baseURL, repo := startDashboardTestServer(t, nil)
	now := time.Now().UTC()
	stream := false
	nonStream := eventFor("explicit-non-stream", now.Add(-time.Minute), usage.TokenStats{TotalTokens: 4}, false)
	nonStream.Stream = &stream
	legacy := eventFor("legacy-stream-unknown", now.Add(-2*time.Minute), usage.TokenStats{TotalTokens: 5}, false)
	seedEvents(t, repo, now, []repository.UsageDecoded{{Event: nonStream}, {Event: legacy}})

	response, payload := getJSON(t, client, baseURL+"/omc/api/v1/usage/events?preset=24h")
	if response.StatusCode != http.StatusOK {
		t.Fatalf("status = %d body %s", response.StatusCode, payload)
	}
	var list struct {
		Items []map[string]any `json:"items"`
	}
	if err := json.Unmarshal(payload, &list); err != nil {
		t.Fatal(err)
	}
	if len(list.Items) != 2 {
		t.Fatalf("expected two listed records, got %d", len(list.Items))
	}
	seen := make(map[string]bool, len(list.Items))
	for _, item := range list.Items {
		value, present := item["stream"]
		requestID, _ := item["request_id"].(string)
		seen[requestID] = true
		switch requestID {
		case "explicit-non-stream":
			if !present || value != false {
				t.Fatalf("explicit non-stream flag = %#v, present=%v", value, present)
			}
		case "legacy-stream-unknown":
			if present {
				t.Fatalf("legacy stream flag should be omitted, got %#v", value)
			}
		default:
			t.Fatalf("unexpected request id in stream-flag list: %q", requestID)
		}
	}
	if !seen["explicit-non-stream"] || !seen["legacy-stream-unknown"] {
		t.Fatalf("stream-flag list omitted an expected record: %v", seen)
	}
}

func TestUsageEventsRejectBadLimits(t *testing.T) {
	client, baseURL, _ := startDashboardTestServer(t, nil)
	for _, suffix := range []string{"limit=0", "limit=-5", "limit=abc", "result=maybe"} {
		response, payload := getJSON(t, client, baseURL+"/omc/api/v1/usage/events?preset=24h&"+suffix)
		if response.StatusCode != http.StatusBadRequest {
			t.Fatalf("%s: status = %d body %s", suffix, response.StatusCode, payload)
		}
	}
}

func TestUsageEventDetailIncludesCorrelatedErrors(t *testing.T) {
	client, baseURL, repo := startDashboardTestServer(t, nil)
	now := time.Now().UTC()
	seedEvents(t, repo, now, []repository.UsageDecoded{
		{Event: eventFor("detail-1", now.Add(-time.Minute), usage.TokenStats{TotalTokens: 3}, true)},
	})
	page, err := repo.ListUsageEvents(context.Background(), repository.UsageEventFilter{
		InstanceID: "default", FromMS: now.Add(-time.Hour).UnixMilli(), ToMS: now.UnixMilli(),
	})
	if err != nil || len(page.Items) != 1 {
		t.Fatalf("seed listing failed: %v %#v", err, page.Items)
	}
	eventID := page.Items[0].ID

	if err := repo.CaptureErrorEvent(context.Background(), "default",
		`{"timestamp":"`+now.Add(-90*time.Second).Format(time.RFC3339)+`","status_code":429,"body":"exhausted","auth_index":"auth-1"}`, now); err != nil {
		t.Fatal(err)
	}
	// An error far outside the correlation window must not be attached.
	if err := repo.CaptureErrorEvent(context.Background(), "default",
		`{"timestamp":"`+now.Add(-time.Hour).Format(time.RFC3339)+`","status_code":500,"body":"ancient","auth_index":"auth-1"}`, now); err != nil {
		t.Fatal(err)
	}

	response, payload := getJSON(t, client, fmt.Sprintf("%s/omc/api/v1/usage/events/%d", baseURL, eventID))
	if response.StatusCode != http.StatusOK {
		t.Fatalf("status = %d body %s", response.StatusCode, payload)
	}
	var detail struct {
		Event         usageEventResponse `json:"event"`
		RelatedErrors []map[string]any   `json:"related_errors"`
	}
	if err := json.Unmarshal(payload, &detail); err != nil {
		t.Fatal(err)
	}
	if detail.Event.EventKey != "detail-1" {
		t.Fatalf("event wrong: %+v", detail.Event)
	}
	if len(detail.RelatedErrors) != 1 {
		t.Fatalf("correlated errors wrong: %#v", detail.RelatedErrors)
	}
	if code, _ := detail.RelatedErrors[0]["status_code"].(float64); int(code) != 429 {
		t.Fatalf("correlated status wrong: %#v", detail.RelatedErrors[0])
	}
}

func TestUsageEventDetailNotFound(t *testing.T) {
	client, baseURL, _ := startDashboardTestServer(t, nil)
	response, payload := getJSON(t, client, baseURL+"/omc/api/v1/usage/events/999999")
	if response.StatusCode != http.StatusNotFound {
		t.Fatalf("status = %d body %s", response.StatusCode, payload)
	}
	response, payload = getJSON(t, client, baseURL+"/omc/api/v1/usage/events/zero")
	if response.StatusCode != http.StatusBadRequest {
		t.Fatalf("non numeric id status = %d body %s", response.StatusCode, payload)
	}
}

func TestUsageEventRequestLogProxiedFromCPA(t *testing.T) {
	var requested atomic.Value
	requested.Store("")
	client, baseURL, repo := startDashboardTestServer(t, func(writer http.ResponseWriter, request *http.Request) {
		if strings.HasPrefix(request.URL.Path, "/v0/management/request-log-by-id/") {
			requested.Store(strings.TrimPrefix(request.URL.Path, "/v0/management/request-log-by-id/"))
			writer.Header().Set("Content-Type", "text/plain")
			_, _ = writer.Write([]byte("=== REQUEST INFO ===\nTimestamp: now\n"))
			return
		}
		writer.WriteHeader(http.StatusNotFound)
	})
	now := time.Now().UTC()
	seedEvents(t, repo, now, []repository.UsageDecoded{
		{Event: eventFor("loggable", now.Add(-time.Minute), usage.TokenStats{TotalTokens: 1}, false)},
	})
	page, err := repo.ListUsageEvents(context.Background(), repository.UsageEventFilter{
		InstanceID: "default", FromMS: now.Add(-time.Hour).UnixMilli(), ToMS: now.UnixMilli(),
	})
	if err != nil || len(page.Items) == 0 {
		t.Fatalf("seed failed: %v", err)
	}
	id := page.Items[0].ID

	response, payload := getJSON(t, client, fmt.Sprintf("%s/omc/api/v1/usage/events/%d/request-log", baseURL, id))
	if response.StatusCode != http.StatusOK {
		t.Fatalf("status = %d body %s", response.StatusCode, payload)
	}
	if !strings.Contains(string(payload), "REQUEST INFO") {
		t.Fatalf("log body wrong: %s", payload)
	}
	if disposition := response.Header.Get("Content-Disposition"); !strings.Contains(disposition, "attachment") ||
		!strings.Contains(disposition, "loggable.log") {
		t.Fatalf("disposition wrong: %q", disposition)
	}
	if response.Header.Get("X-Content-Type-Options") != "nosniff" {
		t.Fatal("download must be nosniff")
	}
	if got := requested.Load().(string); got != "loggable" {
		t.Fatalf("CPA fetched the wrong id: %q", got)
	}
}

func TestUsageEventRequestLogMapsCPAGaps(t *testing.T) {
	client, baseURL, repo := startDashboardTestServer(t, func(writer http.ResponseWriter, request *http.Request) {
		// CPA answers 404 for an unknown log: that is a capability/lookup miss,
		// not an empty file, and must not be rendered as success.
		writer.WriteHeader(http.StatusNotFound)
		_, _ = writer.Write([]byte(`{"error":"log file not found"}`))
	})
	now := time.Now().UTC()
	event := eventFor("nolog", now.Add(-time.Minute), usage.TokenStats{TotalTokens: 1}, false)
	if _, err := repo.InsertUsageEvents(context.Background(), []usage.Event{event}); err != nil {
		t.Fatal(err)
	}
	page, err := repo.ListUsageEvents(context.Background(), repository.UsageEventFilter{
		InstanceID: "default", FromMS: now.Add(-time.Hour).UnixMilli(), ToMS: now.UnixMilli(),
	})
	if err != nil || len(page.Items) == 0 {
		t.Fatal("seed failed")
	}
	response, payload := getJSON(t, client, fmt.Sprintf("%s/omc/api/v1/usage/events/%d/request-log", baseURL, page.Items[0].ID))
	if response.StatusCode == http.StatusOK {
		t.Fatalf("missing upstream log must not look like success: %s", payload)
	}
}

func TestUsageEventRequestLogRejectsTraversalIDs(t *testing.T) {
	client, baseURL, _ := startDashboardTestServer(t, nil)
	// The path parameter is numeric, so a traversal payload cannot even route
	// here; and an unknown id must not reach CPA with a fabricated path.
	for _, raw := range []string{"..%2F..%2Fetc%2Fpasswd", "1/../../etc", "0", "-1", "abc"} {
		response, payload := getJSON(t, client, baseURL+"/omc/api/v1/usage/events/"+raw+"/request-log")
		if response.StatusCode == http.StatusOK {
			t.Fatalf("traversal id %q was served: %s", raw, payload)
		}
	}
}

func TestUsageFacetsListOnlyPresentValues(t *testing.T) {
	client, baseURL, repo := startDashboardTestServer(t, nil)
	now := time.Now().UTC()
	event := eventFor("f1", now.Add(-time.Minute), usage.TokenStats{TotalTokens: 1}, false)
	event.APIGroupLabel = "api_key"
	event.APIKeyMask = "sk-12345••••••••7890"
	seedEvents(t, repo, now, []repository.UsageDecoded{{Event: event}})
	response, payload := getJSON(t, client, baseURL+"/omc/api/v1/usage/facets?preset=24h")
	if response.StatusCode != http.StatusOK {
		t.Fatalf("status = %d body %s", response.StatusCode, payload)
	}
	var body struct {
		Facets repository.UsageFacets `json:"facets"`
	}
	if err := json.Unmarshal(payload, &body); err != nil {
		t.Fatal(err)
	}
	if len(body.Facets.Models) != 1 || body.Facets.Models[0].Value != "gemini-2.5-pro" {
		t.Fatalf("models facet wrong: %#v", body.Facets.Models)
	}
	if body.Facets.Models[0].Requests != 1 {
		t.Fatalf("facet count wrong: %#v", body.Facets.Models[0])
	}
	// The caller-key facet is what the filter dropdown lists, so it must carry
	// the display mask instead of the stored group fingerprint.
	if len(body.Facets.APIGroupKey) != 1 || body.Facets.APIGroupKey[0].Mask != "sk-12345••••••••7890" {
		t.Fatalf("api key facet mask wrong: %#v", body.Facets.APIGroupKey)
	}
	if strings.Contains(body.Facets.APIGroupKey[0].Value, "sk-12345") {
		t.Fatalf("facet value must stay the stored identity: %#v", body.Facets.APIGroupKey[0])
	}
	// Empty dimensions must be present as empty arrays, not null.
	encoded := string(payload)
	if !strings.Contains(encoded, `"executors":[]`) {
		t.Fatalf("empty facet must serialise as []: %s", encoded)
	}
}

func TestUsageEndpointsRequireSession(t *testing.T) {
	_, baseURL, _ := startDashboardTestServer(t, nil)
	for _, path := range []string{
		"/omc/api/v1/management/dashboard",
		"/omc/api/v1/management/dashboard/tail",
		"/omc/api/v1/management/logs",
		"/omc/api/v1/management/logs/status",
		"/omc/api/v1/management/request-error-logs",
		"/omc/api/v1/preferences",
		"/omc/api/v1/usage/events",
		"/omc/api/v1/usage/facets",
		"/omc/api/v1/usage/ingest-status",
		"/omc/api/v1/usage/events/1",
		// Reading the raw configuration source is the most sensitive config action
		// and no longer asks for the management key a second time, so the session
		// check is the boundary that has to hold.
		"/omc/api/v1/management/config/source",
	} {
		response, err := http.Get(baseURL + path)
		if err != nil {
			t.Fatal(err)
		}
		response.Body.Close()
		if response.StatusCode != http.StatusUnauthorized {
			t.Fatalf("%s unauthenticated status = %d", path, response.StatusCode)
		}
	}
}

func TestSanitizeLogNameCannotBreakHeader(t *testing.T) {
	for _, raw := range []string{`a"b`, "x\r\nY: z", "../../etc/passwd", "   ", "🙂🙂", strings.Repeat("a", 300)} {
		name := sanitizeLogName(raw)
		if strings.ContainsAny(name, "\r\n\"") {
			t.Fatalf("unsafe log name %q from %q", name, raw)
		}
		if !strings.HasSuffix(name, ".log") {
			t.Fatalf("log name lost extension: %q", name)
		}
		if len(name) > 90 {
			t.Fatalf("log name too long: %d", len(name))
		}
	}
}
