package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
	"github.com/oh-my-cpa/oh-my-cpa/internal/usage"
)

// decodeFilterJSON reads an endpoint payload, failing the test rather than an
// assertion when the response shape is not what the handler promised.
func decodeFilterJSON(t *testing.T, payload []byte, target any) {
	t.Helper()
	if err := json.Unmarshal(payload, target); err != nil {
		t.Fatalf("decode %s: %v", payload, err)
	}
}

// filterEventFor builds a record that differs from its neighbours along exactly
// the dimension each subtest filters on, so a wrong predicate changes the count.
func filterEventFor(id string, at time.Time, overrides func(*usage.Event)) usage.Event {
	event := eventFor(id, at, usage.TokenStats{TotalTokens: 100}, false)
	event.Model = "gpt-5"
	event.Provider = "openai"
	event.AuthIndex = "auth-a"
	event.AuthType = "oauth"
	event.Source = "team-a.json"
	if overrides != nil {
		overrides(&event)
	}
	return event
}

func TestUsageEventsRejectMalformedFilters(t *testing.T) {
	client, baseURL, _ := startDashboardTestServer(t, nil)
	for suffix, want := range map[string]string{
		"latency_min=abc":                   "must be an integer",
		"latency_min=-1":                    "cannot be negative",
		"tokens_max=-5":                     "cannot be negative",
		"cost_min=1.2.3":                    "decimal",
		"cost_min=abc":                      "decimal",
		"cost_min=-1":                       "decimal",
		"cost_min=1e-99":                    "decimal",
		"cost_max=1.1234567891":             "nine decimal places",
		"latency_min=500&latency_max=100":   "must not be greater",
		"tokens_min=900&tokens_max=100":     "must not be greater",
		"cost_min=2&cost_max=1":             "must not be greater",
		"cost=maybe":                        "cost must be one of",
		"q=" + strings.Repeat("x", 300):     "at most",
		"model=" + strings.Repeat("m", 300): "at most",
	} {
		response, payload := getJSON(t, client, baseURL+"/omc/api/v1/usage/events?preset=24h&"+suffix)
		if response.StatusCode != http.StatusBadRequest {
			t.Fatalf("%s: status = %d body %s", suffix, response.StatusCode, payload)
		}
		if !strings.Contains(string(payload), want) {
			t.Fatalf("%s: message %q does not mention %q", suffix, payload, want)
		}
	}
}

// An over-long multi-select is refused rather than truncated: silently dropping
// values would widen the result set the caller asked for.
func TestUsageEventsRejectOversizedMultiSelect(t *testing.T) {
	client, baseURL, _ := startDashboardTestServer(t, nil)
	query := "preset=24h"
	for index := 0; index <= repository.MaxUsageEventFilterValues; index++ {
		query += fmt.Sprintf("&model=m%d", index)
	}
	response, payload := getJSON(t, client, baseURL+"/omc/api/v1/usage/events?"+query)
	if response.StatusCode != http.StatusBadRequest {
		t.Fatalf("status = %d body %s", response.StatusCode, payload)
	}
}

// A repeated parameter must reach the repository as a union. This is the whole
// reason the wire format is repeated keys instead of a comma list: model names,
// source labels and caller masks all legally contain commas.
func TestUsageEventsMultiSelectUsesRepeatedParameters(t *testing.T) {
	client, baseURL, repo := startDashboardTestServer(t, nil)
	now := time.Now().UTC()
	seedEvents(t, repo, now, []repository.UsageDecoded{
		{Event: filterEventFor("a", now.Add(-4*time.Minute), func(e *usage.Event) { e.Model = "gpt-5" })},
		{Event: filterEventFor("b", now.Add(-3*time.Minute), func(e *usage.Event) { e.Model = "claude-sonnet-4-5" })},
		{Event: filterEventFor("c", now.Add(-2*time.Minute), func(e *usage.Event) { e.Model = "o3" })},
		{Event: filterEventFor("d", now.Add(-time.Minute), func(e *usage.Event) {
			// A comma in the value is the exact case a delimited list would corrupt.
			e.Model = "vendor,inc/gpt-5"
		})},
	})

	requestIDs := func(suffix string) []string {
		response, payload := getJSON(t, client, baseURL+"/omc/api/v1/usage/events?preset=24h&"+suffix)
		if response.StatusCode != http.StatusOK {
			t.Fatalf("%s: status = %d body %s", suffix, response.StatusCode, payload)
		}
		var page struct {
			Items []usageEventResponse `json:"items"`
		}
		decodeFilterJSON(t, payload, &page)
		ids := make([]string, 0, len(page.Items))
		for _, item := range page.Items {
			ids = append(ids, item.RequestID)
		}
		return ids
	}

	if got := requestIDs("model=gpt-5&model=o3"); len(got) != 2 {
		t.Fatalf("union of two models = %v", got)
	}
	// A single occurrence keeps working, so drill-down links written before
	// multi-select existed are unchanged.
	if got := requestIDs("model=gpt-5"); len(got) != 1 {
		t.Fatalf("single model = %v", got)
	}
	// A value containing a comma is matched whole, never split.
	if got := requestIDs("model=vendor%2Cinc%2Fgpt-5"); len(got) != 1 || got[0] != "d" {
		t.Fatalf("comma-bearing model = %v", got)
	}
	// A repeated value cannot inflate the statement or the result.
	if got := requestIDs("model=gpt-5&model=gpt-5&model=o3"); len(got) != 2 {
		t.Fatalf("duplicate values = %v", got)
	}
	// Dimensions still intersect.
	if got := requestIDs("model=gpt-5&model=o3&provider=claude"); len(got) != 0 {
		t.Fatalf("contradicting dimensions = %v", got)
	}
}

// The global search must be a literal substring across the identity columns and
// must not be widened onto the private network fields or the endpoint URL.
func TestUsageEventsGlobalSearchIsLiteralAndScoped(t *testing.T) {
	client, baseURL, repo := startDashboardTestServer(t, nil)
	now := time.Now().UTC()

	agent := "codex-cli/0.46"
	event := filterEventFor("searchable", now.Add(-time.Minute), func(e *usage.Event) {
		e.RequestID = "req-100%_done"
		e.Endpoint = "https://internal-relay.example.internal/v1/responses"
		e.UserAgent = &agent
	})
	seedEvents(t, repo, now, []repository.UsageDecoded{{Event: event}})

	count := func(suffix string) int {
		response, payload := getJSON(t, client, baseURL+"/omc/api/v1/usage/events?preset=24h&"+suffix)
		if response.StatusCode != http.StatusOK {
			t.Fatalf("%s: status = %d body %s", suffix, response.StatusCode, payload)
		}
		var page struct {
			Items []usageEventResponse `json:"items"`
		}
		decodeFilterJSON(t, payload, &page)
		return len(page.Items)
	}

	if got := count("q=req-100%25"); got != 1 {
		t.Fatalf("literal percent matched %d records", got)
	}
	if got := count("q=%25"); got != 1 {
		t.Fatalf("a lone percent must match only the record containing one, matched %d", got)
	}
	if got := count("q=codex-cli"); got != 1 {
		t.Fatalf("user agent is part of the identity search, matched %d", got)
	}
	// The private endpoint must not be reachable through the shared search box;
	// it has its own explicit filter instead.
	if got := count("q=internal-relay"); got != 0 {
		t.Fatalf("global search leaked the endpoint URL: matched %d", got)
	}
	if got := count("endpoint=internal-relay"); got != 1 {
		t.Fatalf("the explicit endpoint filter must still work, matched %d", got)
	}
	// The list payload never carries the endpoint or the client address.
	response, payload := getJSON(t, client, baseURL+"/omc/api/v1/usage/events?preset=24h&endpoint=internal-relay")
	if response.StatusCode != http.StatusOK {
		t.Fatalf("status = %d body %s", response.StatusCode, payload)
	}
	for _, forbidden := range []string{"endpoint", "internal-relay", "client_ip", "x_forwarded_for"} {
		if strings.Contains(string(payload), forbidden) {
			t.Fatalf("filtered list leaked %q: %s", forbidden, payload)
		}
	}
}

// Numeric bounds are inclusive, and a bound of zero is a bound rather than
// "unset". Cost bounds ride on a decimal wire format, so the conversion has to
// be exact rather than float-rounded.
func TestUsageEventsRangeFiltersAndCostConversion(t *testing.T) {
	client, baseURL, repo := startDashboardTestServer(t, nil)
	now := time.Now().UTC()
	seedEvents(t, repo, now, []repository.UsageDecoded{
		{Event: filterEventFor("slow", now.Add(-3*time.Minute), func(e *usage.Event) {
			e.LatencyMS = 60_000
			e.TotalTokens = 500_000
		})},
		{Event: filterEventFor("fast", now.Add(-2*time.Minute), func(e *usage.Event) {
			e.LatencyMS = 200
			e.TotalTokens = 10
		})},
		{Event: filterEventFor("failed", now.Add(-time.Minute), func(e *usage.Event) {
			e.LatencyMS = 100
			e.Failed = true
		})},
	})

	ids := func(suffix string) []string {
		response, payload := getJSON(t, client, baseURL+"/omc/api/v1/usage/events?preset=24h&"+suffix)
		if response.StatusCode != http.StatusOK {
			t.Fatalf("%s: status = %d body %s", suffix, response.StatusCode, payload)
		}
		var page struct {
			Items []usageEventResponse `json:"items"`
		}
		decodeFilterJSON(t, payload, &page)
		out := make([]string, 0, len(page.Items))
		for _, item := range page.Items {
			out = append(out, item.RequestID)
		}
		return out
	}

	if got := ids("latency_min=1000"); len(got) != 1 || got[0] != "slow" {
		t.Fatalf("min latency = %v", got)
	}
	// Both ends are inclusive: a bound equal to a stored value keeps that record.
	if got := ids("latency_min=200&latency_max=200"); len(got) != 1 || got[0] != "fast" {
		t.Fatalf("inclusive bounds = %v", got)
	}
	if got := ids("tokens_max=0"); len(got) != 0 {
		t.Fatalf("tokens_max=0 must exclude every record carrying tokens, got %v", got)
	}
	if got := ids("tokens_min=100"); len(got) != 2 {
		t.Fatalf("min tokens = %v", got)
	}
	// The window is closed on both ends by the handler, so an event placed
	// outside it is filtered by the window rather than by the range predicate.
	if got := ids("latency_max=0"); len(got) != 0 {
		t.Fatalf("latency_max=0 must exclude every record with latency, got %v", got)
	}
	if got := ids("result=failed"); len(got) != 1 || got[0] != "failed" {
		t.Fatalf("result filter = %v", got)
	}
	// Every record was priced before an explicit cost filter is applied, so
	// "unpriced" is the empty set and "all" is everything.
	if got := ids("cost=unpriced"); len(got) != 3 {
		t.Fatalf("cost state filter changed the result set: %v", got)
	}
}

// A reversed range is a malformed request, not an empty result: the operator
// transposed two numbers and the console has to say so instead of rendering a
// convincing empty list.
func TestUsageEventsReversedRangeIsRejected(t *testing.T) {
	client, baseURL, _ := startDashboardTestServer(t, nil)
	for _, suffix := range []string{
		"latency_min=10&latency_max=5",
		"tokens_min=10&tokens_max=5",
		"cost_min=0.5&cost_max=0.1",
	} {
		response, payload := getJSON(t, client, baseURL+"/omc/api/v1/usage/events?preset=24h&"+suffix)
		if response.StatusCode != http.StatusBadRequest {
			t.Fatalf("%s: status = %d body %s", suffix, response.StatusCode, payload)
		}
	}
}

// The endpoint filter is a substring match on a private value. It must narrow
// the list without the record ever being returned to the browser, which is what
// keeps the operator's internal base URL out of the console.
func TestParseUSDAmountNanosGrammar(t *testing.T) {
	for input, want := range map[string]int64{
		"0":           0,
		"0.1":         100_000_000,
		"1":           1_000_000_000,
		"12.5":        12_500_000_000,
		".5":          500_000_000,
		"0.000000001": 1,
		"0.00000001":  10,
		"0007":        7_000_000_000,
		".0009":       900_000,
	} {
		got, err := parseUSDAmountNanos(input)
		if err != nil {
			t.Fatalf("%q: %v", input, err)
		}
		if got != want {
			t.Fatalf("%q = %d nanos, want %d", input, got, want)
		}
	}

	// A bare separator and an empty string carry no digits. Both used to parse as
	// zero, which meant a malformed bound silently became "cost at most nothing"
	// instead of a validation error.
	for _, input := range []string{".", "", "   ", "abc", "-1", "1.2.3", "1e-7", ".e3", "12,5"} {
		if _, err := parseUSDAmountNanos(input); err == nil {
			t.Fatalf("%q must be refused", input)
		}
	}

	// Beyond nine fractional digits the stored column cannot represent the bound,
	// so it is refused rather than rounded to a different constraint.
	if _, err := parseUSDAmountNanos("0.0000000001"); err == nil {
		t.Fatal("ten decimal places must be refused, not rounded")
	}
	if _, err := parseUSDAmountNanos("99999999999999999999"); err == nil {
		t.Fatal("an out-of-range amount must be refused")
	}
}

// Cost bounds ride a decimal wire format, so the conversion has to be exact rather
// than float-rounded. This is an end-to-end check of the parameter the browser
// actually emits: the console holds `0.000000001` as text precisely because a
// double would turn it into 1e-9, which this parser refuses.
func TestUsageEventsNanoDollarCostBoundRoundTrip(t *testing.T) {
	client, baseURL, repo := startDashboardTestServer(t, nil)
	now := time.Now().UTC()
	seedEvents(t, repo, now, []repository.UsageDecoded{
		{Event: eventFor("cheap", now.Add(-2*time.Minute), usage.TokenStats{TotalTokens: 100}, false)},
		{Event: eventFor("expensive", now.Add(-time.Minute), usage.TokenStats{TotalTokens: 200}, false)},
	})

	// A nano-dollar bound is accepted, which is only possible if every digit
	// survived the trip; the previous probe would have been rejected as malformed.
	for _, suffix := range []string{
		"cost_min=0.000000001",
		"cost_max=0.000000001",
		"cost_min=0.000000001&cost_max=1.000000001",
	} {
		response, payload := getJSON(t, client, baseURL+"/omc/api/v1/usage/events?preset=24h&"+suffix)
		if response.StatusCode != http.StatusOK {
			t.Fatalf("%s: status = %d body %s", suffix, response.StatusCode, payload)
		}
	}

	// The bound is applied, not dropped. These records are unpriced, and a record
	// with no locked price satisfies neither a lower nor an upper bound - so a
	// one-nano floor selects nothing. If the parameter had been discarded the way a
	// malformed one used to be, both records would come back, which is what makes
	// this a real assertion rather than a status check.
	response, payload := getJSON(t, client, baseURL+"/omc/api/v1/usage/events?preset=24h&cost_min=0.000000001")
	if response.StatusCode != http.StatusOK {
		t.Fatalf("status = %d body %s", response.StatusCode, payload)
	}
	var bounded struct {
		Items []usageEventResponse `json:"items"`
	}
	decodeFilterJSON(t, payload, &bounded)
	if len(bounded.Items) != 0 {
		t.Fatalf("an unpriced record must not satisfy a cost bound, got %d", len(bounded.Items))
	}
	response, payload = getJSON(t, client, baseURL+"/omc/api/v1/usage/events?preset=24h")
	if response.StatusCode != http.StatusOK {
		t.Fatalf("status = %d body %s", response.StatusCode, payload)
	}
	var unbounded struct {
		Items []usageEventResponse `json:"items"`
	}
	decodeFilterJSON(t, payload, &unbounded)
	if len(unbounded.Items) != 2 {
		t.Fatalf("the unfiltered window must hold both records, got %d", len(unbounded.Items))
	}

	// A value outside the grammar is a 400, not a silently ignored filter.
	for _, suffix := range []string{"cost_min=1e-9", "cost_min=.", "cost_min=1.2.3"} {
		response, payload := getJSON(t, client, baseURL+"/omc/api/v1/usage/events?preset=24h&"+suffix)
		if response.StatusCode != http.StatusBadRequest {
			t.Fatalf("%s: status = %d body %s", suffix, response.StatusCode, payload)
		}
	}
}

func TestUsageEventsEndpointFilterNarrowsWithoutLeaking(t *testing.T) {
	client, baseURL, repo := startDashboardTestServer(t, nil)
	now := time.Now().UTC()
	seedEvents(t, repo, now, []repository.UsageDecoded{
		{Event: filterEventFor("relay", now.Add(-2*time.Minute), func(e *usage.Event) {
			e.Endpoint = "https://relay.example/v1/responses"
		})},
		{Event: filterEventFor("direct", now.Add(-time.Minute), func(e *usage.Event) {
			e.Endpoint = "https://api.example/v1/responses"
		})},
	})

	response, payload := getJSON(t, client, baseURL+"/omc/api/v1/usage/events?preset=24h&endpoint=relay.example")
	if response.StatusCode != http.StatusOK {
		t.Fatalf("status = %d body %s", response.StatusCode, payload)
	}
	var page struct {
		Items []usageEventResponse `json:"items"`
	}
	decodeFilterJSON(t, payload, &page)
	if len(page.Items) != 1 || page.Items[0].RequestID != "relay" {
		t.Fatalf("endpoint filter = %+v", page.Items)
	}
	if strings.Contains(string(payload), "relay.example") {
		t.Fatalf("filtered list leaked the endpoint it filtered on: %s", payload)
	}
}

// Facets must keep reporting the window's real values for every dimension the
// panel offers a dropdown for.
func TestUsageFacetsCoverEveryDropdownDimension(t *testing.T) {
	client, baseURL, repo := startDashboardTestServer(t, nil)
	now := time.Now().UTC()
	seedEvents(t, repo, now, []repository.UsageDecoded{
		{Event: filterEventFor("dimensioned", now.Add(-time.Minute), func(e *usage.Event) {
			e.ReasoningEffort = "high"
			e.ServiceTier = "flex"
			e.AuthType = "oauth"
		})},
	})

	response, payload := getJSON(t, client, baseURL+"/omc/api/v1/usage/facets?preset=24h")
	if response.StatusCode != http.StatusOK {
		t.Fatalf("status = %d body %s", response.StatusCode, payload)
	}
	var body struct {
		Facets struct {
			AuthTypes        []repository.UsageFacetValue `json:"auth_types"`
			ReasoningEfforts []repository.UsageFacetValue `json:"reasoning_efforts"`
			ServiceTiers     []repository.UsageFacetValue `json:"service_tiers"`
		} `json:"facets"`
	}
	decodeFilterJSON(t, payload, &body)
	for name, values := range map[string][]repository.UsageFacetValue{
		"auth_types":        body.Facets.AuthTypes,
		"reasoning_efforts": body.Facets.ReasoningEfforts,
		"service_tiers":     body.Facets.ServiceTiers,
	} {
		if len(values) == 0 {
			t.Fatalf("facet %s reported no values for a record that has one", name)
		}
	}
	// The endpoint is deliberately not a facet: it is a private, high-cardinality
	// value, so it is filtered by typing rather than offered as a list.
	if strings.Contains(string(payload), "endpoint") || strings.Contains(string(payload), "user_agent") {
		t.Fatalf("facets must not expose the endpoint or the user agent: %s", payload)
	}
}

// The alias is an exact-match dimension with a dropdown. A text field for it
// looks identical and silently filters nothing, so the facet has to exist and the
// filter has to match on it.
func TestUsageEventsModelAliasFacetAndFilter(t *testing.T) {
	client, baseURL, repo := startDashboardTestServer(t, nil)
	now := time.Now().UTC()
	alias := "coding-fast"
	seedEvents(t, repo, now, []repository.UsageDecoded{
		{Event: filterEventFor("aliased", now.Add(-2*time.Minute), func(e *usage.Event) { e.ModelAlias = &alias })},
		{Event: filterEventFor("plain", now.Add(-time.Minute), nil)},
	})

	response, payload := getJSON(t, client, baseURL+"/omc/api/v1/usage/facets?preset=24h")
	if response.StatusCode != http.StatusOK {
		t.Fatalf("facets status = %d body %s", response.StatusCode, payload)
	}
	var body struct {
		Facets struct {
			ModelAliases []repository.UsageFacetValue `json:"model_aliases"`
		} `json:"facets"`
	}
	decodeFilterJSON(t, payload, &body)
	if len(body.Facets.ModelAliases) != 1 || body.Facets.ModelAliases[0].Value != alias {
		t.Fatalf("alias facet = %+v", body.Facets.ModelAliases)
	}

	response, payload = getJSON(t, client, baseURL+"/omc/api/v1/usage/events?preset=24h&model_alias="+alias)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("filter status = %d body %s", response.StatusCode, payload)
	}
	var page struct {
		Items []usageEventResponse `json:"items"`
	}
	decodeFilterJSON(t, payload, &page)
	if len(page.Items) != 1 || page.Items[0].RequestID != "aliased" {
		t.Fatalf("alias filter = %+v", page.Items)
	}
}
