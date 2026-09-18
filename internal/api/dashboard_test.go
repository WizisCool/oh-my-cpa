package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
	"github.com/oh-my-cpa/oh-my-cpa/internal/usage"
)

// getDashboardJSON fetches the full dashboard body; the tail tests compare
// against it, so a wrong shape fails here rather than at every assertion.
func getDashboardJSON(t *testing.T, client *http.Client, url string) dashboardResponse {
	t.Helper()
	response, payload := getJSON(t, client, url)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("dashboard status = %d body %s", response.StatusCode, payload)
	}
	var body dashboardResponse
	if err := json.Unmarshal(payload, &body); err != nil {
		t.Fatal(err)
	}
	return body
}

func TestDashboardRejectsInvalidWindows(t *testing.T) {
	client, baseURL, _ := startDashboardTestServer(t, nil)
	base := baseURL + "/omc/api/v1/management/dashboard"

	cases := map[string]string{
		"unknown preset":   base + "?preset=5minutes",
		"non numeric from": base + "?from=abc&to=1",
		"reversed range":   base + "?from=2000000000000&to=1000000000000",
		"oversized range":  base + "?from=1&to=9000000000000",
	}
	for name, url := range cases {
		response, payload := getJSON(t, client, url)
		if response.StatusCode != http.StatusBadRequest {
			t.Fatalf("%s: status = %d body %s", name, response.StatusCode, payload)
		}
	}
}

func TestDashboardDefaultsTo24hAndReportsZeroState(t *testing.T) {
	client, baseURL, _ := startDashboardTestServer(t, nil)
	response, payload := getJSON(t, client, baseURL+"/omc/api/v1/management/dashboard")
	if response.StatusCode != http.StatusOK {
		t.Fatalf("status = %d body %s", response.StatusCode, payload)
	}
	var body dashboardResponse
	if err := json.Unmarshal(payload, &body); err != nil {
		t.Fatal(err)
	}
	if body.Window.Preset != "24h" || body.Window.Minutes != 1440 {
		t.Fatalf("default window wrong: %+v", body.Window)
	}
	if body.Requests.Total != 0 || body.Requests.Series == nil {
		t.Fatalf("empty state must still be a valid shape: %+v", body.Requests)
	}
	// A zero-request window must not invent a 0% success rate.
	if body.Requests.SuccessRate != nil {
		t.Fatalf("success rate should be null with no traffic, got %v", *body.Requests.SuccessRate)
	}
	if body.Metrics.RPM != nil || body.Metrics.TPM != nil {
		t.Fatal("rate metrics must be null without traffic")
	}
	if body.Metrics.CostSource != "placeholder" || body.Metrics.Cost != 0 {
		t.Fatalf("cost must be an explicit placeholder: %+v", body.Metrics)
	}
}

func TestDashboardAggregatesStoredRequestsAndTokens(t *testing.T) {
	client, baseURL, repo := startDashboardTestServer(t, nil)
	base := time.Now().UTC().Add(-30 * time.Minute).Truncate(time.Minute)
	seedEvents(t, repo, base, []repository.UsageDecoded{
		{Event: eventFor("ok1", base, usage.TokenStats{InputTokens: 100, OutputTokens: 40, CacheReadTokens: 80, TotalTokens: 140}, false)},
		{Event: eventFor("ok2", base.Add(time.Minute), usage.TokenStats{InputTokens: 60, OutputTokens: 20, TotalTokens: 80}, false)},
		{Event: eventFor("bad", base.Add(2*time.Minute), usage.TokenStats{TotalTokens: 0}, true)},
	})

	response, payload := getJSON(t, client, baseURL+"/omc/api/v1/management/dashboard?preset=1h")
	if response.StatusCode != http.StatusOK {
		t.Fatalf("status = %d body %s", response.StatusCode, payload)
	}
	var body dashboardResponse
	if err := json.Unmarshal(payload, &body); err != nil {
		t.Fatal(err)
	}
	if body.Requests.Total != 3 || body.Requests.Success != 2 || body.Requests.Failed != 1 {
		t.Fatalf("request split wrong: %+v", body.Requests)
	}
	if body.Requests.SuccessRate == nil || *body.Requests.SuccessRate != 66.67 {
		t.Fatalf("success rate wrong: %+v", body.Requests.SuccessRate)
	}
	if body.Tokens.Total != 220 || body.Tokens.Input != 160 || body.Tokens.Output != 60 {
		t.Fatalf("token totals wrong: %+v", body.Tokens)
	}
	if body.Metrics.CacheRate == nil || *body.Metrics.CacheRate == 0 {
		t.Fatalf("cache rate missing: %+v", body.Metrics)
	}
	if body.Metrics.RPM == nil || *body.Metrics.RPM <= 0 {
		t.Fatalf("rpm missing: %+v", body.Metrics)
	}
	if body.Metrics.AvgLatencyMS == nil || *body.Metrics.AvgLatencyMS != 250 {
		t.Fatalf("avg latency wrong: %+v", body.Metrics.AvgLatencyMS)
	}
	if len(body.Requests.Series) == 0 {
		t.Fatal("sparkline series must be populated")
	}
	if body.Coverage.FromDetails != 3 {
		t.Fatalf("with no rollup everything is detail-sourced: %+v", body.Coverage)
	}
	// Bucket width must stay near the target resolution, not one point per row.
	if body.Window.BucketMS < int64(time.Minute/time.Millisecond) {
		t.Fatalf("bucket width too fine: %d", body.Window.BucketMS)
	}
}

func TestDashboardFiltersByClientAPIKey(t *testing.T) {
	client, baseURL, repo := startDashboardTestServer(t, nil)
	base := time.Now().UTC().Add(-20 * time.Minute).Truncate(time.Minute)

	ev1 := eventFor("ev1", base, usage.TokenStats{InputTokens: 50, OutputTokens: 50, TotalTokens: 100}, false)
	ev1.APIGroupKey = "key-alpha"

	ev2 := eventFor("ev2", base.Add(time.Minute), usage.TokenStats{InputTokens: 30, OutputTokens: 30, TotalTokens: 60}, false)
	ev2.APIGroupKey = "key-beta"

	seedEvents(t, repo, base, []repository.UsageDecoded{
		{Event: ev1},
		{Event: ev2},
	})

	// 1. Without api_key: all 2 requests
	all := getDashboardJSON(t, client, baseURL+"/omc/api/v1/management/dashboard?preset=1h")
	if all.Requests.Total != 2 || all.Tokens.Total != 160 {
		t.Fatalf("expected all 2 requests, got requests=%d tokens=%d", all.Requests.Total, all.Tokens.Total)
	}

	// 2. With api_key=key-alpha: 1 request
	alpha := getDashboardJSON(t, client, baseURL+"/omc/api/v1/management/dashboard?preset=1h&api_key=key-alpha")
	if alpha.Requests.Total != 1 || alpha.Tokens.Total != 100 {
		t.Fatalf("expected 1 request for key-alpha, got requests=%d tokens=%d", alpha.Requests.Total, alpha.Tokens.Total)
	}

	// 3. With api_key=key-beta: 1 request
	beta := getDashboardJSON(t, client, baseURL+"/omc/api/v1/management/dashboard?preset=1h&api_key=key-beta")
	if beta.Requests.Total != 1 || beta.Tokens.Total != 60 {
		t.Fatalf("expected 1 request for key-beta, got requests=%d tokens=%d", beta.Requests.Total, beta.Tokens.Total)
	}

	// 4. With nonexistent api_key: 0 requests
	none := getDashboardJSON(t, client, baseURL+"/omc/api/v1/management/dashboard?preset=1h&api_key=nonexistent")
	if none.Requests.Total != 0 {
		t.Fatalf("expected 0 requests for nonexistent key, got requests=%d", none.Requests.Total)
	}
}

func TestDashboardUsesRollupOnceAggregated(t *testing.T) {
	client, baseURL, repo := startDashboardTestServer(t, nil)
	base := time.Now().UTC().Add(-2 * time.Hour).Truncate(time.Hour)
	seedEvents(t, repo, base, []repository.UsageDecoded{
		{Event: eventFor("a", base.Add(time.Minute), usage.TokenStats{TotalTokens: 10}, false)},
		{Event: eventFor("b", base.Add(2*time.Minute), usage.TokenStats{TotalTokens: 20}, false)},
	})
	if _, err := repo.AggregateUsageGrain(context.Background(), repository.CheckpointHourly, repository.HourBucketMS, 100); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.AggregateUsageGrain(context.Background(), repository.CheckpointDaily, repository.DayBucketMS, 100); err != nil {
		t.Fatal(err)
	}

	response, payload := getJSON(t, client, baseURL+"/omc/api/v1/management/dashboard?preset=6h")
	if response.StatusCode != http.StatusOK {
		t.Fatalf("status = %d body %s", response.StatusCode, payload)
	}
	var body dashboardResponse
	if err := json.Unmarshal(payload, &body); err != nil {
		t.Fatal(err)
	}
	if body.Requests.Total != 2 {
		t.Fatalf("rollup path lost rows: %+v", body.Requests)
	}
	if body.Coverage.FromRollup+body.Coverage.FromDetails != body.Requests.Total {
		t.Fatalf("coverage must partition the total: %+v", body.Coverage)
	}
	// The rollup serves a window only where it can be sliced honestly. This
	// preset's grid is finer than the hourly grain, so the answer must come from
	// the detail rows: an hourly row cannot be split across ten-minute buckets, and
	// re-aligning it would collapse the hour onto its first bucket (see
	// TestUsageAnalyticsFinerBucketThanRollupKeepsDistribution).
	if body.Window.BucketMS < repository.HourBucketMS && body.Coverage.FromRollup != 0 {
		t.Fatalf("a finer-than-grain grid must not be served from the hourly rollup: %+v", body.Coverage)
	}
}

// TestDashboardUsesRollupForCoarseGrids is the other half of the rule above: the
// rollup still carries the long presets, which is the reason it exists. A daily
// grid is coarser than the hourly grain, so slicing it is honest and the answer
// must not fall back to scanning every detail row.
func TestDashboardUsesRollupForCoarseGrids(t *testing.T) {
	client, baseURL, repo := startDashboardTestServer(t, nil)
	// Well inside the 30d window: a base exactly at the boundary would fall
	// before `from` and be invisible to the query.
	base := time.Now().UTC().Add(-20 * 24 * time.Hour).Truncate(time.Hour)
	seedEvents(t, repo, base, []repository.UsageDecoded{
		{Event: eventFor("coarse-a", base.Add(time.Minute), usage.TokenStats{TotalTokens: 10}, false)},
		{Event: eventFor("coarse-b", base.Add(2*time.Minute), usage.TokenStats{TotalTokens: 20}, false)},
	})
	if _, err := repo.AggregateUsageGrain(context.Background(), repository.CheckpointDaily, repository.DayBucketMS, 100); err != nil {
		t.Fatal(err)
	}
	response, payload := getJSON(t, client, baseURL+"/omc/api/v1/management/dashboard?preset=30d")
	if response.StatusCode != http.StatusOK {
		t.Fatalf("status = %d body %s", response.StatusCode, payload)
	}
	var body dashboardResponse
	if err := json.Unmarshal(payload, &body); err != nil {
		t.Fatal(err)
	}
	if body.Requests.Total != 2 {
		t.Fatalf("coarse window lost rows: %+v", body.Requests)
	}
	if body.Window.BucketMS < repository.HourBucketMS {
		t.Fatalf("expected a coarse grid for the 30d preset, got %d", body.Window.BucketMS)
	}
	if body.Coverage.FromRollup == 0 {
		t.Fatalf("a coarse grid must still be served from the rollup: %+v", body.Coverage)
	}
}

func TestDashboardCustomRangeAccepted(t *testing.T) {
	client, baseURL, repo := startDashboardTestServer(t, nil)
	now := time.Now().UTC()
	base := now.Add(-3 * time.Hour)
	seedEvents(t, repo, base, []repository.UsageDecoded{
		{Event: eventFor("old", base, usage.TokenStats{TotalTokens: 5}, false)},
		{Event: eventFor("recent", now.Add(-time.Hour), usage.TokenStats{TotalTokens: 7}, false)},
	})
	from := now.Add(-2 * time.Hour).UnixMilli()
	response, payload := getJSON(t, client, fmt.Sprintf("%s/omc/api/v1/management/dashboard?from=%d&to=%d", baseURL, from, now.UnixMilli()))
	if response.StatusCode != http.StatusOK {
		t.Fatalf("status = %d body %s", response.StatusCode, payload)
	}
	var body dashboardResponse
	if err := json.Unmarshal(payload, &body); err != nil {
		t.Fatal(err)
	}
	if body.Window.Preset != "custom" {
		t.Fatalf("preset = %q", body.Window.Preset)
	}
	// The older record must fall outside the custom window.
	if body.Requests.Total != 1 {
		t.Fatalf("custom window should include only the recent event: %+v", body.Requests)
	}
}

func TestCacheRateNeverDoubleCountsOverlappingFields(t *testing.T) {
	// CPA reports cached_tokens and cache_read_tokens for the same event; they
	// overlap. Summing them produced a 175% "cache rate" in the field.
	totals := repository.UsageTotals{
		InputTokens: 388_380, OutputTokens: 40_000, TotalTokens: 428_380,
		CacheReadTokens: 343_300, CachedTokens: 343_300,
	}
	numerator, denominator := cacheRateParts(totals)
	if numerator != 343_300 {
		t.Fatalf("overlapping cache fields were summed: numerator %d", numerator)
	}
	if denominator != 388_380 {
		t.Fatalf("denominator must be prompt tokens, got %d", denominator)
	}
	rate := float64(numerator) / float64(denominator) * 100
	if rate > 100 {
		t.Fatalf("cache rate exceeded 100%%: %.2f", rate)
	}
}

func TestCacheRateEdgeCases(t *testing.T) {
	// Older CPA payloads carry only cached_tokens.
	numerator, denominator := cacheRateParts(repository.UsageTotals{
		InputTokens: 1000, TotalTokens: 1200, CachedTokens: 250,
	})
	if numerator != 250 || denominator != 1000 {
		t.Fatalf("cached_tokens fallback wrong: %d/%d", numerator, denominator)
	}
	// Anthropic-style payload: input_tokens excludes the cached prefix, so
	// cache_read legitimately exceeds input. The prompt side must widen to keep
	// the ratio bounded instead of reporting 150%.
	numerator, denominator = cacheRateParts(repository.UsageTotals{
		InputTokens: 1000, OutputTokens: 200, TotalTokens: 1200, CacheReadTokens: 9000,
	})
	if numerator != 9000 || denominator != 10000 {
		t.Fatalf("claude-style denominator wrong: %d/%d", numerator, denominator)
	}
	if float64(numerator)/float64(denominator) > 1 {
		t.Fatal("claude-style payload still yields an impossible rate")
	}
	// Cache writes are deliberately NOT added to the denominator: the persisted
	// row carries no canonical per-event breakdown, so the accounting convention
	// that produced its raw counts cannot be proven. See cacheRateParts.
	numerator, denominator = cacheRateParts(repository.UsageTotals{
		InputTokens: 200, OutputTokens: 300, TotalTokens: 2000,
		CacheReadTokens: 1000, CacheCreationTokens: 500,
	})
	if numerator != 1000 || denominator != 1200 {
		t.Fatalf("cache-write denominator changed: %d/%d", numerator, denominator)
	}
	// Nothing prompt-side at all: unusable denominator, so the UI shows a dash.
	numerator, denominator = cacheRateParts(repository.UsageTotals{OutputTokens: 90, TotalTokens: 90})
	if denominator != 0 || numerator != 0 {
		t.Fatalf("output-only payload must be unusable: %d/%d", numerator, denominator)
	}
}

func TestDashboardCacheRateIsBounded(t *testing.T) {
	client, baseURL, repo := startDashboardTestServer(t, nil)
	now := time.Now().UTC()
	seedEvents(t, repo, now, []repository.UsageDecoded{
		{Event: usage.Event{
			InstanceID: "default", EventKey: "cache-heavy", RequestID: "cache-heavy", APIGroupKey: "sk-demo",
			Model: "claude-sonnet-4-5", AuthIndex: "auth-1", TimestampMS: now.Add(-time.Minute).UnixMilli(),
			// Claude-style payload where cached and cache_read overlap.
			InputTokens: 1000, OutputTokens: 200, TotalTokens: 1200,
			CacheReadTokens: 900, CachedTokens: 900, Generate: true,
		}},
	})
	response, payload := getJSON(t, client, baseURL+"/omc/api/v1/management/dashboard?preset=24h")
	if response.StatusCode != http.StatusOK {
		t.Fatalf("status = %d body %s", response.StatusCode, payload)
	}
	var body dashboardResponse
	if err := json.Unmarshal(payload, &body); err != nil {
		t.Fatal(err)
	}
	if body.Metrics.CacheRate == nil {
		t.Fatal("cache rate should be reported when prompt tokens exist")
	}
	if *body.Metrics.CacheRate > 100 {
		t.Fatalf("dashboard reported an impossible cache rate of %.2f%%", *body.Metrics.CacheRate)
	}
	if *body.Metrics.CacheRate != 90 {
		t.Fatalf("expected 900/1000 = 90%%, got %.2f", *body.Metrics.CacheRate)
	}
}

func TestDashboardCacheRateNeverReachesOneHundred(t *testing.T) {
	client, baseURL, repo := startDashboardTestServer(t, nil)
	now := time.Now().UTC()
	// A payload whose cache read equals the whole prompt: physically impossible
	// (the turn being asked for is never in the cache), so the aggregate must
	// hold the reading below 100% rather than paint a perfect hit rate.
	seedEvents(t, repo, now, []repository.UsageDecoded{
		{Event: usage.Event{
			InstanceID: "default", EventKey: "cache-full", RequestID: "cache-full", APIGroupKey: "sk-demo",
			Model: "gpt-5.4", AuthIndex: "auth-1", TimestampMS: now.Add(-time.Minute).UnixMilli(),
			InputTokens: 1000, OutputTokens: 200, TotalTokens: 1200,
			CacheReadTokens: 1000, CachedTokens: 1000, Generate: true,
		}},
	})
	response, payload := getJSON(t, client, baseURL+"/omc/api/v1/management/dashboard?preset=24h")
	if response.StatusCode != http.StatusOK {
		t.Fatalf("status = %d body %s", response.StatusCode, payload)
	}
	var body dashboardResponse
	if err := json.Unmarshal(payload, &body); err != nil {
		t.Fatal(err)
	}
	if body.Metrics.CacheRate == nil {
		t.Fatal("cache rate should be reported when prompt tokens exist")
	}
	if *body.Metrics.CacheRate >= 100 {
		t.Fatalf("cache rate reached an impossible reading: %.2f", *body.Metrics.CacheRate)
	}
	if *body.Metrics.CacheRate != 99.9 {
		t.Fatalf("expected the aggregate to stop at 99.9%%, got %.2f", *body.Metrics.CacheRate)
	}
}

// TestDashboardCacheRateStaysBoundedForMixedConventions pins the behaviour of a
// window that mixes providers: the rate stays bounded and below the presentation
// ceiling. The exact value is NOT asserted because the rollup carries no
// provider column, so a mixed window cannot be split by accounting convention;
// making the number exact needs a rollup schema change (see cacheRateParts).
func TestDashboardCacheRateStaysBoundedForMixedConventions(t *testing.T) {
	client, baseURL, repo := startDashboardTestServer(t, nil)
	now := time.Now().UTC()
	seedEvents(t, repo, now, []repository.UsageDecoded{
		// OpenAI-style: 800 of a 1000-token prompt was cached.
		{Event: usage.Event{
			InstanceID: "default", EventKey: "subset", RequestID: "subset", APIGroupKey: "sk-demo",
			Model: "gpt-5.4", AuthIndex: "auth-1", TimestampMS: now.Add(-2 * time.Minute).UnixMilli(),
			InputTokens: 1000, OutputTokens: 100, TotalTokens: 1100,
			CacheReadTokens: 800, CachedTokens: 800, Generate: true,
		}},
		// Anthropic-style: 200 new + 1000 read + 500 written.
		{Event: usage.Event{
			InstanceID: "default", EventKey: "independent", RequestID: "independent", APIGroupKey: "sk-demo",
			Model: "claude-sonnet-4-5", AuthIndex: "auth-2", TimestampMS: now.Add(-time.Minute).UnixMilli(),
			InputTokens: 200, OutputTokens: 300, TotalTokens: 2000,
			CacheReadTokens: 1000, CacheCreationTokens: 500, Generate: true,
		}},
	})
	response, payload := getJSON(t, client, baseURL+"/omc/api/v1/management/dashboard?preset=24h")
	if response.StatusCode != http.StatusOK {
		t.Fatalf("status = %d body %s", response.StatusCode, payload)
	}
	var body dashboardResponse
	if err := json.Unmarshal(payload, &body); err != nil {
		t.Fatal(err)
	}
	if body.Metrics.CacheRate == nil {
		t.Fatal("cache rate should be reported when prompt tokens exist")
	}
	if rate := *body.Metrics.CacheRate; rate < 0 || rate >= 100 {
		t.Fatalf("mixed window cache rate out of range: %.2f", rate)
	}
}

func TestDashboardSeriesIsZeroFilledAndStableAcrossRefresh(t *testing.T) {
	client, baseURL, repo := startDashboardTestServer(t, nil)
	now := time.Now().UTC()
	// Two records sitting in the same recent bucket: a GROUP BY would return a
	// single point and the sparkline would vanish.
	seedEvents(t, repo, now, []repository.UsageDecoded{
		{Event: eventFor("sparse-1", now.Add(-time.Minute), usage.TokenStats{TotalTokens: 4}, false)},
		{Event: eventFor("sparse-2", now.Add(-2*time.Minute), usage.TokenStats{TotalTokens: 6}, false)},
	})

	response, payload := getJSON(t, client, baseURL+"/omc/api/v1/management/dashboard?preset=24h")
	if response.StatusCode != http.StatusOK {
		t.Fatalf("status = %d body %s", response.StatusCode, payload)
	}
	var body dashboardResponse
	if err := json.Unmarshal(payload, &body); err != nil {
		t.Fatal(err)
	}
	// The grid must span the window regardless of how sparse the data is.
	if len(body.Requests.Series) < 2 {
		t.Fatalf("sparse data collapsed the series to %d points; sparkline would not render", len(body.Requests.Series))
	}
	if len(body.Requests.Series) != len(body.Tokens.Series) {
		t.Fatalf("request and token series disagree: %d vs %d", len(body.Requests.Series), len(body.Tokens.Series))
	}
	// Buckets must be evenly spaced, ordered, and inside the window.
	bucket := body.Window.BucketMS
	for index, point := range body.Requests.Series {
		if index > 0 {
			if point.TimeMS != body.Requests.Series[index-1].TimeMS+bucket {
				t.Fatalf("bucket %d is not evenly spaced: %d after %d", index, point.TimeMS, body.Requests.Series[index-1].TimeMS)
			}
		}
		if point.TimeMS < body.Window.FromMS || point.TimeMS > body.Window.ToMS {
			t.Fatalf("bucket %d outside the window", point.TimeMS)
		}
	}
	// Totals must survive the grid: nothing dropped, nothing double counted.
	var summed int64
	for _, point := range body.Requests.Series {
		summed += point.Requests
	}
	if summed != body.Requests.Total {
		t.Fatalf("series sums to %d but window total is %d", summed, body.Requests.Total)
	}
}

// The tail endpoint exists to be polled every few seconds, so the one property
// that matters is that it never disagrees with the full response about the
// numbers the KPI tiles print.
func TestDashboardTailMatchesFullWindowNumbers(t *testing.T) {
	client, baseURL, repo := startDashboardTestServer(t, nil)
	now := time.Now().UTC()
	seedEvents(t, repo, now, []repository.UsageDecoded{
		{Event: eventFor("tail-1", now.Add(-40*time.Minute), usage.TokenStats{InputTokens: 50, OutputTokens: 20, CacheReadTokens: 30, TotalTokens: 70}, false)},
		{Event: eventFor("tail-2", now.Add(-20*time.Minute), usage.TokenStats{TotalTokens: 30}, false)},
		{Event: eventFor("tail-3", now.Add(-3*time.Minute), usage.TokenStats{TotalTokens: 5}, true)},
	})
	// An absolute window keeps both calls on identical bounds; a relative
	// preset would slide between them.
	window := fmt.Sprintf("?from=%d&to=%d", now.Add(-time.Hour).UnixMilli(), now.UnixMilli())

	full := getDashboardJSON(t, client, baseURL+"/omc/api/v1/management/dashboard"+window)
	response, payload := getJSON(t, client, baseURL+"/omc/api/v1/management/dashboard/tail"+window)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("tail status = %d body %s", response.StatusCode, payload)
	}
	var tail dashboardTailResponse
	if err := json.Unmarshal(payload, &tail); err != nil {
		t.Fatal(err)
	}

	if tail.Window != full.Window {
		t.Fatalf("tail window %+v differs from full %+v", tail.Window, full.Window)
	}
	if tail.Requests.Total != full.Requests.Total || tail.Requests.Success != full.Requests.Success ||
		tail.Requests.Failed != full.Requests.Failed {
		t.Fatalf("tail request totals differ: %+v vs %+v", tail.Requests, full.Requests)
	}
	if tail.Tokens.Total != full.Tokens.Total || tail.Tokens.Input != full.Tokens.Input {
		t.Fatalf("tail token totals differ: %+v vs %+v", tail.Tokens, full.Tokens)
	}
	if tail.Metrics.RPM == nil || full.Metrics.RPM == nil || *tail.Metrics.RPM != *full.Metrics.RPM {
		t.Fatalf("tail rpm differs: %v vs %v", tail.Metrics.RPM, full.Metrics.RPM)
	}
	if tail.Metrics.AvgLatencyMS == nil || *tail.Metrics.AvgLatencyMS != *full.Metrics.AvgLatencyMS {
		t.Fatalf("tail latency differs: %v vs %v", tail.Metrics.AvgLatencyMS, full.Metrics.AvgLatencyMS)
	}

	// Only the series is trimmed, and it is trimmed from the same tail both
	// sides agree on.
	for name, pair := range map[string]struct {
		full, tail []dashboardSeriesPoint
	}{
		"requests": {full.Requests.Series, tail.Requests.Series},
		"tokens":   {full.Tokens.Series, tail.Tokens.Series},
	} {
		want := pair.full[max(0, len(pair.full)-dashboardTailBuckets):]
		if !reflect.DeepEqual(pair.tail, want) {
			t.Fatalf("%s tail %+v is not the last %d buckets of %+v", name, pair.tail, dashboardTailBuckets, want)
		}
	}

	if tail.Live.TailFromMS != tail.Requests.Series[0].TimeMS {
		t.Fatalf("tail_from_ms %d does not point at the first returned bucket %d",
			tail.Live.TailFromMS, tail.Requests.Series[0].TimeMS)
	}
	if tail.Live.SeriesStartMS != full.Requests.Series[0].TimeMS {
		t.Fatalf("series_start_ms %d does not match the full grid start %d",
			tail.Live.SeriesStartMS, full.Requests.Series[0].TimeMS)
	}
	if tail.Live.BucketMS != full.Window.BucketMS || tail.Live.AsOfMS != full.Window.ToMS {
		t.Fatalf("live pacing state wrong: %+v window %+v", tail.Live, full.Window)
	}
	// Coverage describes the collector, not the window. Shipping a zeroed block
	// here would let the UI paint "0 stored events" over a healthy pipeline.
	if strings.Contains(string(payload), "coverage") {
		t.Fatalf("tail response must omit coverage: %s", payload)
	}
}

// A window with no traffic still answers with a grid, because the client splices
// on bucket positions rather than on "did anything arrive".
func TestDashboardTailKeepsAnEmptyWindowRenderable(t *testing.T) {
	client, baseURL, _ := startDashboardTestServer(t, nil)
	response, payload := getJSON(t, client, baseURL+"/omc/api/v1/management/dashboard/tail?preset=1h")
	if response.StatusCode != http.StatusOK {
		t.Fatalf("status = %d body %s", response.StatusCode, payload)
	}
	var tail dashboardTailResponse
	if err := json.Unmarshal(payload, &tail); err != nil {
		t.Fatal(err)
	}
	if len(tail.Requests.Series) == 0 || tail.Requests.Series == nil || tail.Tokens.Series == nil {
		t.Fatalf("an empty tail must still carry a splicable grid: %s", payload)
	}
	for _, point := range tail.Requests.Series {
		if point.Requests != 0 || point.Failures != 0 || point.Tokens != 0 {
			t.Fatalf("empty window invented traffic: %+v", point)
		}
	}
	if tail.Requests.SuccessRate != nil || tail.Metrics.RPM != nil {
		t.Fatal("rates must stay null without traffic")
	}
	if tail.Live.TailFromMS != tail.Requests.Series[0].TimeMS ||
		tail.Live.SeriesStartMS > tail.Live.TailFromMS || tail.Live.BucketMS != tail.Window.BucketMS {
		t.Fatalf("splice markers must describe the grid that was returned: %+v", tail.Live)
	}
}

func TestDashboardTailRejectsInvalidWindows(t *testing.T) {
	client, baseURL, _ := startDashboardTestServer(t, nil)
	base := baseURL + "/omc/api/v1/management/dashboard/tail"
	for name, url := range map[string]string{
		"unknown preset":   base + "?preset=5minutes",
		"non numeric from": base + "?from=abc&to=1",
		"reversed range":   base + "?from=2000000000000&to=1000000000000",
	} {
		response, payload := getJSON(t, client, url)
		if response.StatusCode != http.StatusBadRequest {
			t.Fatalf("%s: status = %d body %s", name, response.StatusCode, payload)
		}
	}
}

func TestFillDashboardBucketsFoldsEdgeBuckets(t *testing.T) {
	const bucket = int64(60000)
	from := bucket*10 + 500 // unaligned start
	to := bucket * 14
	buckets := []repository.UsageBucket{
		{StartMS: bucket * 9, UsageTotals: repository.UsageTotals{Requests: 3, TotalTokens: 30, CacheReadTokens: 7}},
		{StartMS: bucket * 12, UsageTotals: repository.UsageTotals{Requests: 5, TotalTokens: 50, CacheReadTokens: 11}},
	}
	costs := []repository.UsageCostBucket{
		{StartMS: bucket * 9, CostNanos: 2_000_000_000},
		{StartMS: bucket * 12, CostNanos: 3_000_000_000},
	}
	points := fillDashboardBuckets(from, to, bucket, buckets, costs)
	if len(points) < 2 {
		t.Fatalf("expected a filled grid, got %d points", len(points))
	}
	var requests, tokens, cacheRead, costNanos int64
	for _, point := range points {
		requests += point.Requests
		tokens += point.Tokens
		cacheRead += point.CacheReadTokens
		costNanos += point.CostNanos
		if point.TimeMS%bucket != 0 {
			t.Fatalf("bucket start %d is not grid aligned", point.TimeMS)
		}
	}
	// The pre-window bucket must be folded into the first point rather than lost.
	if requests != 8 || tokens != 80 {
		t.Fatalf("edge buckets lost: requests=%d tokens=%d", requests, tokens)
	}
	// Cache and cost ride the same folding, so the tiles cannot disagree about
	// which bucket an edge event belongs to.
	if cacheRead != 18 {
		t.Fatalf("cache reads lost on fold: got %d, want 18", cacheRead)
	}
	if costNanos != 5_000_000_000 {
		t.Fatalf("cost lost on fold: got %d, want 5000000000", costNanos)
	}
}

// TestDashboardSeriesCarriesPerBucketCacheAndCost pins the properties the four
// right-hand tiles depend on: each bucket must state its own cache reads and its
// own cost, so the cache-rate and cost tiles stop plotting token volume.
func TestDashboardSeriesCarriesPerBucketCacheAndCost(t *testing.T) {
	const bucket = int64(60_000)
	from := bucket * 10
	to := bucket * 13
	buckets := []repository.UsageBucket{
		{StartMS: bucket * 11, UsageTotals: repository.UsageTotals{
			Requests: 4, InputTokens: 100, CacheReadTokens: 60, TotalTokens: 160,
		}},
	}
	costs := []repository.UsageCostBucket{{StartMS: bucket * 11, CostNanos: 1_500_000_000}}
	points := fillDashboardBuckets(from, to, bucket, buckets, costs)

	byTime := make(map[int64]dashboardSeriesPoint, len(points))
	for _, point := range points {
		byTime[point.TimeMS] = point
	}
	populated, ok := byTime[bucket*11]
	if !ok {
		t.Fatalf("expected a point at %d, got %d points", bucket*11, len(points))
	}
	if populated.CacheReadTokens != 60 {
		t.Fatalf("cache reads not carried per bucket: got %d, want 60", populated.CacheReadTokens)
	}
	if populated.CostNanos != 1_500_000_000 {
		t.Fatalf("cost not carried per bucket: got %d, want 1500000000", populated.CostNanos)
	}
	// A bucket with no priced event must not borrow its neighbour's cost: a
	// fabricated cost would overstate spend in exactly the window it must not.
	empty := byTime[bucket*12]
	if empty.CostNanos != 0 || empty.CacheReadTokens != 0 {
		t.Fatalf("empty bucket fabricated data: cost=%d cacheRead=%d", empty.CostNanos, empty.CacheReadTokens)
	}
}

func TestDashboardBucketWidthStaysReadable(t *testing.T) {
	// The contract is a bounded point count on a friendly step, not one exact
	// width per window.
	for _, span := range []time.Duration{
		time.Minute, 10 * time.Minute, time.Hour, 6 * time.Hour, 24 * time.Hour,
		7 * 24 * time.Hour, 30 * 24 * time.Hour, 90 * 24 * time.Hour,
	} {
		bucket := dashboardBucketWidth(span)
		if bucket <= 0 || span/bucket > dashboardTargetBuckets {
			t.Fatalf("%s -> %s keeps more than %d points", span, bucket, dashboardTargetBuckets)
		}
		// Every step must be a whole number of minutes to align with buckets.
		if bucket%time.Minute != 0 {
			t.Fatalf("%s -> %s is not minute aligned", span, bucket)
		}
	}
	if got := dashboardBucketWidth(time.Hour); got != 2*time.Minute {
		t.Fatalf("1h bucket = %s", got)
	}
	if got := dashboardBucketWidth(90 * 24 * time.Hour); got > 7*24*time.Hour {
		t.Fatalf("90d bucket too fine: %s", got)
	}
}

// A range with no end is open-ended: the end tracks the current time, so the
// newest bucket keeps appearing without the user touching anything.
func TestDashboardOpenEndedWindowTracksNow(t *testing.T) {
	client, baseURL, repo := startDashboardTestServer(t, nil)
	now := time.Now().UTC()
	seedEvents(t, repo, now, []repository.UsageDecoded{
		{Event: eventFor("open-1", now.Add(-30*time.Minute), usage.TokenStats{TotalTokens: 12}, false)},
	})
	base := baseURL + "/omc/api/v1/management/dashboard"

	response, payload := getJSON(t, client, base+"?from="+strconv.FormatInt(now.Add(-90*time.Minute).UnixMilli(), 10))
	if response.StatusCode != http.StatusOK {
		t.Fatalf("status = %d body %s", response.StatusCode, payload)
	}
	var body dashboardResponse
	if err := json.Unmarshal(payload, &body); err != nil {
		t.Fatal(err)
	}
	if !body.Window.OpenEnd || body.Window.Preset != "custom" {
		t.Fatalf("an end-less range must be reported as open: %+v", body.Window)
	}
	if body.Window.ToMS < now.Add(-time.Minute).UnixMilli() {
		t.Fatalf("open end must resolve to now, got %d", body.Window.ToMS)
	}
	if body.Requests.Total != 1 {
		t.Fatalf("the window must still cover the recent event: %+v", body.Requests)
	}

	// `to` with no `from` is not a window.
	if response, payload = getJSON(t, client, base+"?to="+strconv.FormatInt(now.UnixMilli(), 10)); response.StatusCode != http.StatusBadRequest {
		t.Fatalf("to-without-from status = %d body %s", response.StatusCode, payload)
	}
}

// The Live preset is a fifteen-minute window: one bucket per minute, so the
// newest point moves on the scale the collector actually delivers at. Five
// minutes would be too narrow to read as a trend; an hour is too coarse to
// feel live.
func TestDashboardRealtimePresetIsFifteenMinutes(t *testing.T) {
	client, baseURL, repo := startDashboardTestServer(t, nil)
	now := time.Now().UTC()
	seedEvents(t, repo, now, []repository.UsageDecoded{
		{Event: eventFor("rt-now", now.Add(-30*time.Second), usage.TokenStats{TotalTokens: 5}, false)},
		{Event: eventFor("rt-mid", now.Add(-12*time.Minute), usage.TokenStats{TotalTokens: 7}, false)},
		{Event: eventFor("rt-out", now.Add(-40*time.Minute), usage.TokenStats{TotalTokens: 9}, false)},
	})

	response, payload := getJSON(t, client, baseURL+"/omc/api/v1/management/dashboard?preset=15m")
	if response.StatusCode != http.StatusOK {
		t.Fatalf("status = %d body %s", response.StatusCode, payload)
	}
	var body dashboardResponse
	if err := json.Unmarshal(payload, &body); err != nil {
		t.Fatal(err)
	}
	if body.Window.Preset != "15m" || body.Window.Minutes != 15 {
		t.Fatalf("window wrong: %+v", body.Window)
	}
	if body.Window.BucketMS != int64(time.Minute/time.Millisecond) {
		t.Fatalf("a 15m window must resolve to one-minute buckets, got %d", body.Window.BucketMS)
	}
	if body.Requests.Total != 2 {
		t.Fatalf("the 40-minute record must fall outside the window: %+v", body.Requests)
	}
	if len(body.Requests.Series) < 15 || len(body.Requests.Series) > 17 {
		t.Fatalf("expected roughly one point per minute, got %d", len(body.Requests.Series))
	}
	// The tail poll keeps the same resolution, which is what paces the client.
	response, payload = getJSON(t, client, baseURL+"/omc/api/v1/management/dashboard/tail?preset=15m")
	var tail dashboardTailResponse
	if err := json.Unmarshal(payload, &tail); err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != http.StatusOK || tail.Live.BucketMS != body.Window.BucketMS {
		t.Fatalf("tail pacing disagrees with the window: %d vs %d", tail.Live.BucketMS, body.Window.BucketMS)
	}
}
