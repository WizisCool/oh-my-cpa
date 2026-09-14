package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
	"github.com/oh-my-cpa/oh-my-cpa/internal/usage"
)

// modelEventFor is `eventFor` with the model chosen, since the whole point of this endpoint is the
// model dimension and the shared helper hardcodes one.
func modelEventFor(id, model string, at time.Time, totalTokens int64) usage.Event {
	event := eventFor(id, at, usage.TokenStats{InputTokens: totalTokens, TotalTokens: totalTokens}, false)
	event.Model = model
	return event
}

const modelsPath = "/omc/api/v1/management/dashboard/models"

// describeGroups renders just the ranking, so a failed assertion prints the claim under test rather
// than several hundred bucket timestamps.
func describeGroups(groups []dashboardModelUsage) string {
	parts := make([]string, 0, len(groups))
	for _, group := range groups {
		name := group.Model
		if group.Folded {
			name = "(folded)"
		}
		parts = append(parts, fmt.Sprintf("%s=%d", name, group.Tokens))
	}
	return strings.Join(parts, " ")
}

// These tests exercise the endpoint through the real router, not the pure helpers: the helpers are
// covered by `management_dashboard_models_test.go`, and what an HTTP test adds is everything between
// the request and them - the window parsing, the repository, the DTO, the status codes.

func TestDashboardModelsRequiresAuthentication(t *testing.T) {
	_, baseURL, _ := startDashboardTestServer(t, nil)
	// A bare client with no session cookie. The endpoint is a window over stored request history, so an
	// unauthenticated read must not be answered.
	response, err := http.Get(baseURL + modelsPath)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusUnauthorized {
		t.Fatalf("unauthenticated status = %d, want 401", response.StatusCode)
	}
}

func TestDashboardModelsRejectsInvalidWindows(t *testing.T) {
	client, baseURL, _ := startDashboardTestServer(t, nil)
	cases := map[string]string{
		"unknown preset":   modelsPath + "?preset=5minutes",
		"non numeric from": modelsPath + "?from=abc&to=1",
		"reversed range":   modelsPath + "?from=2000000000000&to=1000000000000",
		"oversized range":  modelsPath + "?from=1&to=9000000000000",
		"to without from":  modelsPath + "?to=2000000000000",
	}
	for name, path := range cases {
		response, payload := getJSON(t, client, baseURL+path)
		if response.StatusCode != http.StatusBadRequest {
			t.Fatalf("%s: status = %d body %s", name, response.StatusCode, payload)
		}
	}
}

func TestDashboardModelsReportsNoStoreAndAnEmptyWindow(t *testing.T) {
	client, baseURL, _ := startDashboardTestServer(t, nil)
	response, payload := getJSON(t, client, baseURL+modelsPath)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("status = %d body %s", response.StatusCode, payload)
	}
	// The body is a window over mutable request history, so a cached copy would outlive the data.
	if got := response.Header.Get("Cache-Control"); got != "no-store" {
		t.Fatalf("Cache-Control = %q, want no-store", got)
	}
	var body dashboardModelsResponse
	if err := json.Unmarshal(payload, &body); err != nil {
		t.Fatal(err)
	}
	if body.Window.Preset != "24h" || body.Window.Minutes != 1440 {
		t.Fatalf("default window wrong: %+v", body.Window)
	}
	// The empty state must be a valid, renderable shape: an absent list would make the client's
	// `groups.length === 0` branch and a failed parse indistinguishable.
	if body.Models == nil || len(body.Models) != 0 {
		t.Fatalf("empty window must answer with an empty list, got %#v", body.Models)
	}
	if body.TokenTotal != 0 {
		t.Fatalf("empty window total = %d, want 0", body.TokenTotal)
	}
	if body.Errors == nil {
		t.Fatalf("partial_errors must be present as an empty list")
	}
}

// TestDashboardModelsRankFoldsAndConserves is the endpoint's central contract: the ranking, the fold,
// the boundary of the window, and that the numbers add up.
func TestDashboardModelsRankFoldsAndConserves(t *testing.T) {
	client, baseURL, repo := startDashboardTestServer(t, nil)
	now := time.Now().UTC()

	// Seven models inside the window, with volumes chosen so the top five are unambiguous and the
	// remaining two fold. One is a single-token difference, so a fold boundary that was off by one would
	// move a model into the remainder.
	volumes := map[string]int64{
		"model-a": 700, "model-b": 600, "model-c": 500, "model-d": 400, "model-e": 300,
		"model-f": 200, "model-g": 100,
	}
	events := make([]usage.Event, 0, len(volumes)*2)
	for index, model := range []string{"model-a", "model-b", "model-c", "model-d", "model-e", "model-f", "model-g"} {
		events = append(events, modelEventFor(fmt.Sprintf("m-%s", model), model, now.Add(-time.Duration(index+1)*time.Minute), volumes[model]))
	}
	// One more for the busiest model in a different bucket, so the series has two populated buckets.
	events = append(events, modelEventFor("m-a-again", "model-a", now.Add(-40*time.Minute), 50))
	// Outside the window on both sides: a model that appears only here must not be ranked at all, and
	// must not contribute to the total.
	events = append(events, modelEventFor("before", "outside-early", now.Add(-25*time.Hour), 9999))
	events = append(events, modelEventFor("after", "outside-late", now.Add(time.Hour), 9999))
	if _, err := repo.InsertUsageEvents(context.Background(), events); err != nil {
		t.Fatal(err)
	}

	response, payload := getJSON(t, client, baseURL+modelsPath+"?preset=24h")
	if response.StatusCode != http.StatusOK {
		t.Fatalf("status = %d body %s", response.StatusCode, payload)
	}
	var body dashboardModelsResponse
	if err := json.Unmarshal(payload, &body); err != nil {
		t.Fatal(err)
	}

	// Six groups: five named plus the folded remainder, which holds model-f and model-g.
	if len(body.Models) != dashboardModelTopN+1 {
		t.Fatalf("got %d groups, want %d: %s", len(body.Models), dashboardModelTopN+1, describeGroups(body.Models))
	}
	for index, want := range []string{"model-a", "model-b", "model-c", "model-d", "model-e"} {
		if body.Models[index].Model != want || body.Models[index].Folded {
			t.Fatalf("group %d = %#v, want the named model %s", index, body.Models[index], want)
		}
	}
	folded := body.Models[dashboardModelTopN]
	if !folded.Folded {
		t.Fatalf("last group must be the folded remainder: %#v", folded)
	}
	if folded.Tokens != 300 {
		t.Fatalf("folded remainder = %d tokens, want 300 (model-f 200 + model-g 100)", folded.Tokens)
	}
	// The in-window volumes are 700+600+500+400+300+200+100 = 2800, plus the 50 model-a carries in a
	// second bucket. Both out-of-window records are excluded, and each is large enough to dominate the
	// total if either edge were wrong.
	if body.TokenTotal != 2850 {
		t.Fatalf("window total = %d, want 2850; out-of-window traffic must not count", body.TokenTotal)
	}
	if body.Models[0].Tokens != 750 {
		t.Fatalf("model-a = %d tokens, want 750", body.Models[0].Tokens)
	}

	// Conservation, from the wire rather than from the helpers: every group's series must sum to that
	// group's own total, and the groups must sum to the window total. The donut's centre and its slices
	// are read against exactly these two identities.
	var summed int64
	for _, group := range body.Models {
		var seriesTotal int64
		for _, point := range group.Series {
			seriesTotal += point.Tokens
		}
		if seriesTotal != group.Tokens {
			t.Fatalf("group %q series sums to %d but reports %d", group.Model, seriesTotal, group.Tokens)
		}
		if group.Series == nil {
			t.Fatalf("group %q must carry a series, even when it is all zeros", group.Model)
		}
		summed += group.Tokens
	}
	if summed != body.TokenTotal {
		t.Fatalf("groups sum to %d, window reports %d", summed, body.TokenTotal)
	}
	// Every group's series spans the same grid, so bucket i is the same instant in each of them.
	width := len(body.Models[0].Series)
	for _, group := range body.Models {
		if len(group.Series) != width {
			t.Fatalf("group %q has %d buckets, want %d", group.Model, len(group.Series), width)
		}
		for index, point := range group.Series {
			if point.TimeMS != body.Models[0].Series[index].TimeMS {
				t.Fatalf("group %q bucket %d is at %d, want %d", group.Model, index, point.TimeMS, body.Models[0].Series[index].TimeMS)
			}
		}
	}
}

// TestDashboardModelsExcludesTrafficOutsideACustomRange pins the window bounds exactly, which a preset
// cannot: a preset is computed from `now`, so its edges are never adjacent to a stored record.
func TestDashboardModelsExcludesTrafficOutsideACustomRange(t *testing.T) {
	client, baseURL, repo := startDashboardTestServer(t, nil)
	// A range aligned to a minute so the bucket grid and the window share a boundary.
	to := time.Now().UTC().Truncate(time.Minute)
	from := to.Add(-10 * time.Minute)
	millisecond := time.Millisecond

	insert := func(id, model string, at time.Time, tokens int64) {
		if _, err := repo.InsertUsageEvents(context.Background(), []usage.Event{modelEventFor(id, model, at, tokens)}); err != nil {
			t.Fatal(err)
		}
	}
	// One millisecond outside each edge, and one at each edge: the bounds are inclusive, and an
	// off-by-one at either end is invisible when the neighbours are a minute away.
	insert("early", "excluded-early", from.Add(-millisecond), 5000)
	insert("late", "excluded-late", to.Add(millisecond), 5000)
	insert("first", "included", from, 100)
	insert("last", "included", to, 250)

	response, payload := getJSON(t, client, fmt.Sprintf("%s%s?from=%d&to=%d", baseURL, modelsPath, from.UnixMilli(), to.UnixMilli()))
	if response.StatusCode != http.StatusOK {
		t.Fatalf("status = %d body %s", response.StatusCode, payload)
	}
	var body dashboardModelsResponse
	if err := json.Unmarshal(payload, &body); err != nil {
		t.Fatal(err)
	}
	if len(body.Models) != 1 || body.Models[0].Model != "included" {
		t.Fatalf("groups = %s, want only the model inside the range", describeGroups(body.Models))
	}
	if body.TokenTotal != 350 {
		t.Fatalf("total = %d, want 350", body.TokenTotal)
	}
}

// TestDashboardModelsKeepsTheNameFromCollidingWithTheRemainder guards the reason the folded group is a
// discriminator rather than a reserved name: the label is the client's to translate, so a real model
// whose name equals it must stay a model of its own.
func TestDashboardModelsKeepsTheNameFromCollidingWithTheRemainder(t *testing.T) {
	client, baseURL, repo := startDashboardTestServer(t, nil)
	now := time.Now().UTC()
	events := []usage.Event{
		// The colliding name is the largest volume in the window, so it ranks first rather than folding.
		modelEventFor("collide", "其他模型", now.Add(-time.Minute), 9000),
		modelEventFor("plain-1", "model-1", now.Add(-2*time.Minute), 800),
		modelEventFor("plain-2", "model-2", now.Add(-3*time.Minute), 700),
	}
	if _, err := repo.InsertUsageEvents(context.Background(), events); err != nil {
		t.Fatal(err)
	}
	response, payload := getJSON(t, client, baseURL+modelsPath)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("status = %d body %s", response.StatusCode, payload)
	}
	var body dashboardModelsResponse
	if err := json.Unmarshal(payload, &body); err != nil {
		t.Fatal(err)
	}
	if len(body.Models) != 3 {
		t.Fatalf("got %d groups, want 3 with no remainder: %s", len(body.Models), describeGroups(body.Models))
	}
	if body.Models[0].Folded || body.Models[0].Model != "其他模型" {
		t.Fatalf("first group = %q (folded=%v, %d tokens), want the real model ranked first",
			body.Models[0].Model, body.Models[0].Folded, body.Models[0].Tokens)
	}
	if body.Models[0].Tokens != 9000 {
		t.Fatalf("the real model's traffic was altered: %d tokens", body.Models[0].Tokens)
	}
}

// TestDashboardModelsIgnoresAggregatedRollups pins the endpoint's reason for reading one source: the
// hybrid rollup/detail split double counts an event whose own hour was already folded when it arrived,
// and for a *ranking* that artefact also reorders models.
func TestDashboardModelsIgnoresAggregatedRollups(t *testing.T) {
	client, baseURL, repo := startDashboardTestServer(t, nil)
	now := time.Now().UTC()
	if _, err := repo.InsertUsageEvents(context.Background(), []usage.Event{
		modelEventFor("rank-1", "heavy", now.Add(-5*time.Minute), 100),
		modelEventFor("rank-2", "light", now.Add(-6*time.Minute), 10),
	}); err != nil {
		t.Fatal(err)
	}

	read := func() dashboardModelsResponse {
		response, payload := getJSON(t, client, baseURL+modelsPath)
		if response.StatusCode != http.StatusOK {
			t.Fatalf("status = %d body %s", response.StatusCode, payload)
		}
		var body dashboardModelsResponse
		if err := json.Unmarshal(payload, &body); err != nil {
			t.Fatal(err)
		}
		return body
	}
	before := read()
	if before.TokenTotal != 110 {
		t.Fatalf("before aggregation total = %d, want 110", before.TokenTotal)
	}

	if _, err := repo.AggregateUsageGrain(context.Background(), repository.CheckpointHourly, repository.HourBucketMS, 1000); err != nil {
		t.Fatal(err)
	}
	// A late record with an earlier timestamp, arriving after its own hour was folded.
	if _, err := repo.InsertUsageEvents(context.Background(), []usage.Event{
		modelEventFor("rank-3", "light", now.Add(-20*time.Minute), 55),
	}); err != nil {
		t.Fatal(err)
	}

	after := read()
	// 110 + 55, counted once. A hybrid read would report 220 here, and would also rank `light` above
	// `heavy` once the double count landed on one side.
	if after.TokenTotal != 165 {
		t.Fatalf("after aggregation and a late event total = %d, want 165; the rollup was counted too", after.TokenTotal)
	}
	if after.Models[0].Model != "heavy" {
		t.Fatalf("ranking changed after aggregation: %s", describeGroups(after.Models))
	}
}

// TestDashboardModelsCallViewMergesCallPointsAcrossUpstreamModels pins the grouping contract: the
// call view merges one call point's traffic across the upstream models the gateway routed it to, the
// model view keeps them distinct, and the two views each answer for their own ranking.
func TestDashboardModelsCallViewMergesCallPointsAcrossUpstreamModels(t *testing.T) {
	client, baseURL, repo := startDashboardTestServer(t, nil)
	now := time.Now().UTC()

	flash := "deepseek-v4.1-flash"
	events := []usage.Event{
		func() usage.Event { e := modelEventFor("call-a", "deepseek-flash", now.Add(-time.Minute), 100); e.ModelAlias = &flash; return e }(),
		func() usage.Event { e := modelEventFor("call-b", "deepseek-v4.1-flash", now.Add(-2*time.Minute), 200); e.ModelAlias = &flash; return e }(),
		modelEventFor("call-c", "claude-sonnet-4-5", now.Add(-3*time.Minute), 400),
	}
	if _, err := repo.InsertUsageEvents(context.Background(), events); err != nil {
		t.Fatal(err)
	}

	read := func(path string) dashboardModelsResponse {
		response, payload := getJSON(t, client, baseURL+modelsPath+path)
		if response.StatusCode != http.StatusOK {
			t.Fatalf("status = %d body %s", response.StatusCode, payload)
		}
		var body dashboardModelsResponse
		if err := json.Unmarshal(payload, &body); err != nil {
			t.Fatal(err)
		}
		return body
	}

	call := read("?preset=24h&group_by=call")
	if len(call.Models) != 2 {
		t.Fatalf("call view groups = %s, want 2 (the call point merged, claude separate)", describeGroups(call.Models))
	}
	if call.Models[0].Model != "claude-sonnet-4-5" || call.Models[0].Tokens != 400 {
		t.Fatalf("call view top = %#v, want claude at 400", call.Models[0])
	}
	if call.Models[1].Model != flash || call.Models[1].Tokens != 300 {
		t.Fatalf("call view second = %#v, want %q at 300 (100+200 merged)", call.Models[1], flash)
	}

	model := read("?preset=24h")
	if len(model.Models) != 3 {
		t.Fatalf("model view groups = %s, want 3 (the call point split back out)", describeGroups(model.Models))
	}
	if model.Models[0].Model != "claude-sonnet-4-5" || model.Models[0].Tokens != 400 {
		t.Fatalf("model view top = %#v, want claude at 400", model.Models[0])
	}
	if model.Models[1].Model != "deepseek-v4.1-flash" || model.Models[1].Tokens != 200 {
		t.Fatalf("model view second = %#v, want the upstream model at 200", model.Models[1])
	}
	if model.Models[2].Model != "deepseek-flash" || model.Models[2].Tokens != 100 {
		t.Fatalf("model view third = %#v, want the other upstream variant at 100", model.Models[2])
	}
}

// TestDashboardModelsGroupByIsClosed pins the parameter's validation: an unrecognised grouping is a
// bad request rather than a silent fall-back, because a typo that changed what the numbers mean would
// be invisible in the panels.
func TestDashboardModelsGroupByIsClosed(t *testing.T) {
	client, baseURL, _ := startDashboardTestServer(t, nil)
	for _, value := range []string{"calls", "models", "Call", "provider"} {
		response, payload := getJSON(t, client, baseURL+modelsPath+"?group_by="+value)
		if response.StatusCode != http.StatusBadRequest {
			t.Fatalf("group_by=%q status = %d body %s, want 400", value, response.StatusCode, payload)
		}
	}
}

// TestDashboardModelsCarriesCostPins the cost contract: the spend is the priced rows' snapshot sum,
// priced_requests counts only those rows, and a group with no priced request reports null rather than
// a zero that would claim the calls were free.
func TestDashboardModelsCarriesCost(t *testing.T) {
	client, baseURL, repo := startDashboardTestServer(t, nil)
	now := time.Now().UTC()

	// Seed priced rows directly: pricing is immutable by trigger, so a priced row is born priced.
	base := now.Add(-time.Hour).Truncate(time.Minute)
	for id, cost := range map[string]int64{"cost-a": 1_000_000_000, "cost-b": 500_000_000} {
		event := modelEventFor(id, "priced-model", base.Add(time.Duration(len(id))*time.Minute), 100)
		if _, err := repo.InsertUsageEvents(context.Background(), []usage.Event{event}); err != nil {
			t.Fatal(err)
		}
		if _, err := repo.SQL().ExecContext(context.Background(),
			`INSERT INTO usage_events
			 (instance_id, event_key, request_id, api_group_key, model, auth_index, timestamp_ms,
			  created_at_ms, input_tokens, total_tokens, cost_nanos, pricing_status)
			 SELECT instance_id, event_key || '-priced', request_id || '-priced', api_group_key, model, auth_index,
			       timestamp_ms, created_at_ms, input_tokens, total_tokens, ?, 'priced'
			 FROM usage_events WHERE event_key = ?`, cost, id); err != nil {
			t.Fatal(err)
		}
	}
	// An unpriced model: the group carries tokens but no spend.
	if _, err := repo.InsertUsageEvents(context.Background(), []usage.Event{
		modelEventFor("cost-unpriced", "unpriced-model", base.Add(3*time.Minute), 300),
	}); err != nil {
		t.Fatal(err)
	}

	response, payload := getJSON(t, client, baseURL+modelsPath+"?preset=24h")
	if response.StatusCode != http.StatusOK {
		t.Fatalf("status = %d body %s", response.StatusCode, payload)
	}
	var body dashboardModelsResponse
	if err := json.Unmarshal(payload, &body); err != nil {
		t.Fatal(err)
	}

	byModel := map[string]dashboardModelUsage{}
	for _, group := range body.Models {
		byModel[group.Model] = group
	}
	priced, exists := byModel["priced-model"]
	if !exists {
		t.Fatalf("priced-model missing from ranking: %s", describeGroups(body.Models))
	}
	if priced.CostUSD == nil || *priced.CostUSD != 1.5 {
		t.Fatalf("priced-model cost = %v, want 1.5", priced.CostUSD)
	}
	// The group carries 4 requests: 2 priced snapshots plus the 2 originals they were seeded from,
	// which stay unpriced. That mix is exactly the partial case the panel's note exists for.
	if priced.PricedRequests != 2 || priced.Requests != 4 {
		t.Fatalf("priced-model requests = %d/%d, want 2 priced of 4", priced.PricedRequests, priced.Requests)
	}
	unpriced, exists := byModel["unpriced-model"]
	if !exists {
		t.Fatalf("unpriced-model missing from ranking: %s", describeGroups(body.Models))
	}
	if unpriced.CostUSD != nil {
		t.Fatalf("unpriced-model cost = %v, want null (a zero would claim the calls were free)", *unpriced.CostUSD)
	}
	if unpriced.Tokens != 300 {
		t.Fatalf("unpriced-model tokens = %d, want 300 (usage without pricing still counts)", unpriced.Tokens)
	}
}
