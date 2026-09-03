package api

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"reflect"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/auth"
	"github.com/oh-my-cpa/oh-my-cpa/internal/config"
	"github.com/oh-my-cpa/oh-my-cpa/internal/crypto"
	"github.com/oh-my-cpa/oh-my-cpa/internal/domain"
	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
	"github.com/oh-my-cpa/oh-my-cpa/internal/usage"
)

var dashboardDSNCounter atomic.Uint64

func dashboardMemoryDSN(purpose string) string {
	return fmt.Sprintf("file:memdb_%s_%d?mode=memory&cache=shared", purpose, dashboardDSNCounter.Add(1))
}

// startDashboardTestServer wires the real router over a fake CPA so dashboard
// and request-event endpoints are exercised exactly as the product runs them.
func startDashboardTestServer(t *testing.T, handler func(http.ResponseWriter, *http.Request)) (*http.Client, string, *repository.Repository) {
	t.Helper()
	cpaServer := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Header.Get("Authorization") != "Bearer management-secret-value" {
			writer.WriteHeader(http.StatusUnauthorized)
			_, _ = writer.Write([]byte(`{"error":"unauthorized"}`))
			return
		}
		if handler != nil {
			handler(writer, request)
			return
		}
		writer.WriteHeader(http.StatusNotFound)
	}))
	t.Cleanup(cpaServer.Close)

	db, err := repository.Open(context.Background(), dashboardMemoryDSN("dashboard"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	repo := repository.New(db)
	cipher, err := crypto.New("01234567890123456789012345678901")
	if err != nil {
		t.Fatal(err)
	}
	ciphertext, nonce, err := cipher.Encrypt([]byte("management-secret-value"))
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	if err := repo.UpsertInstance(context.Background(), domain.CPAInstance{
		ID: "default", Name: "Test CPA", BaseURL: cpaServer.URL,
		ManagementKeyCiphertext: ciphertext, ManagementKeyNonce: nonce,
		CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}
	authManager, err := auth.New("management-secret-value", "/omc", "")
	if err != nil {
		t.Fatal(err)
	}
	appHandler := NewHandler(config.Config{BasePath: "/omc", Version: "test", RequestTimeout: 5 * time.Second}, repo, cipher, nil, authManager)
	server := httptest.NewServer(appHandler.Router())
	t.Cleanup(server.Close)

	jar, err := cookiejar.New(nil)
	if err != nil {
		t.Fatal(err)
	}
	client := &http.Client{Jar: jar}
	login, err := client.Post(server.URL+"/omc/api/auth/login", "application/json", bytes.NewBufferString(`{"password":"management-secret-value"}`))
	if err != nil {
		t.Fatal(err)
	}
	login.Body.Close()
	if login.StatusCode != http.StatusOK {
		t.Fatalf("login status = %d", login.StatusCode)
	}
	return client, server.URL, repo
}

func getJSON(t *testing.T, client *http.Client, url string) (*http.Response, []byte) {
	t.Helper()
	response, err := client.Get(url)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	payload, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	return response, payload
}

// seedEvents stores request records the way the pipeline would.
func seedEvents(t *testing.T, repo *repository.Repository, base time.Time, specs []repository.UsageDecoded) {
	t.Helper()
	if _, err := repo.InsertUsageEvents(context.Background(), decodeSpecs(specs)); err != nil {
		t.Fatal(err)
	}
}

func decodeSpecs(specs []repository.UsageDecoded) []usage.Event {
	events := make([]usage.Event, 0, len(specs))
	for _, spec := range specs {
		events = append(events, spec.Event)
	}
	return events
}

func eventFor(id string, at time.Time, tokens usage.TokenStats, failed bool) usage.Event {
	return usage.Event{
		InstanceID: "default", EventKey: id, RequestID: id, APIGroupKey: "sk-group",
		Model: "gemini-2.5-pro", AuthIndex: "auth-1", AuthType: "oauth",
		Provider: "gemini", Source: "client-a", TimestampMS: at.UnixMilli(),
		Failed: failed, Generate: true, LatencyMS: 250,
		InputTokens: tokens.InputTokens, OutputTokens: tokens.OutputTokens,
		ReasoningTokens: tokens.ReasoningTokens, CachedTokens: tokens.CachedTokens,
		CacheReadTokens: tokens.CacheReadTokens, CacheCreationTokens: tokens.CacheCreationTokens,
		TotalTokens: tokens.TotalTokens,
	}
}

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
	if body.Coverage.FromRollup == 0 {
		t.Fatalf("aggregated window should be served from rollup: %+v", body.Coverage)
	}
	if body.Coverage.FromRollup+body.Coverage.FromDetails != body.Requests.Total {
		t.Fatalf("coverage must partition the total: %+v", body.Coverage)
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
		{StartMS: bucket * 9, UsageTotals: repository.UsageTotals{Requests: 3, TotalTokens: 30}},
		{StartMS: bucket * 12, UsageTotals: repository.UsageTotals{Requests: 5, TotalTokens: 50}},
	}
	points := fillDashboardBuckets(from, to, bucket, buckets)
	if len(points) < 2 {
		t.Fatalf("expected a filled grid, got %d points", len(points))
	}
	var requests, tokens int64
	for _, point := range points {
		requests += point.Requests
		tokens += point.Tokens
		if point.TimeMS%bucket != 0 {
			t.Fatalf("bucket start %d is not grid aligned", point.TimeMS)
		}
	}
	// The pre-window bucket must be folded into the first point rather than lost.
	if requests != 8 || tokens != 80 {
		t.Fatalf("edge buckets lost: requests=%d tokens=%d", requests, tokens)
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
	seedEvents(t, repo, now, []repository.UsageDecoded{
		{Event: eventFor("f1", now.Add(-time.Minute), usage.TokenStats{TotalTokens: 1}, false)},
	})
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

func TestUsageIngestStatusReportsDisabledPipeline(t *testing.T) {
	client, baseURL, _ := startDashboardTestServer(t, nil)
	response, payload := getJSON(t, client, baseURL+"/omc/api/v1/usage/ingest-status")
	if response.StatusCode != http.StatusOK {
		t.Fatalf("status = %d body %s", response.StatusCode, payload)
	}
	if !strings.Contains(string(payload), `"enabled":false`) {
		t.Fatalf("expected a disabled pipeline report: %s", payload)
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

// The dashboard range is the operator's working context: it has to come back
// after a reload, a service restart and a container rebuild, so it lives in the
// database rather than in browser storage.
func TestPreferencesRoundTripThroughTheDatabase(t *testing.T) {
	client, baseURL, repo := startDashboardTestServer(t, nil)
	base := baseURL + "/omc/api/v1/preferences"

	// A fresh install has no preferences, and that is a valid empty answer.
	response, payload := getJSON(t, client, base)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("status = %d body %s", response.StatusCode, payload)
	}
	var listed struct {
		Preferences map[string]json.RawMessage `json:"preferences"`
	}
	if err := json.Unmarshal(payload, &listed); err != nil {
		t.Fatal(err)
	}
	if len(listed.Preferences) != 0 {
		t.Fatalf("fresh install should list nothing: %s", payload)
	}

	// Only known keys are writable: this is UI state, not a blob store.
	if response, payload = doJSON(t, client, http.MethodPut, base+"/management_key", `{"x":1}`); response.StatusCode != http.StatusBadRequest {
		t.Fatalf("unknown key status = %d body %s", response.StatusCode, payload)
	}
	// Unparseable bodies are refused here so every reader can skip the check.
	if response, payload = doJSON(t, client, http.MethodPut, base+"/dashboard_range", `{"preset":`); response.StatusCode != http.StatusBadRequest {
		t.Fatalf("invalid json status = %d body %s", response.StatusCode, payload)
	}

	if response, payload = doJSON(t, client, http.MethodPut, base+"/dashboard_range", `{"preset":"6h"}`); response.StatusCode != http.StatusOK {
		t.Fatalf("write status = %d body %s", response.StatusCode, payload)
	}

	// The log page's view filters ride the same store, so a reload or a restart
	// does not silently turn management traffic back on.
	if response, payload = doJSON(t, client, http.MethodPut, base+"/log_filters", `{"hideManagement":true,"levels":["warn"],"statusClass":"all"}`); response.StatusCode != http.StatusOK {
		t.Fatalf("log filters status = %d body %s", response.StatusCode, payload)
	}

	_, payload = getJSON(t, client, base)
	if !strings.Contains(string(payload), `"dashboard_range":{"preset":"6h"}`) ||
		!strings.Contains(string(payload), `"log_filters":{"hideManagement":true,"levels":["warn"],"statusClass":"all"}`) {
		t.Fatalf("stored values did not come back verbatim: %s", payload)
	}
	stored, found, err := repo.GetPreference(context.Background(), repository.PreferenceDashboardRange)
	if err != nil || !found {
		t.Fatalf("value must be persisted in the database: found=%v err=%v", found, err)
	}
	if stored != `{"preset":"6h"}` {
		t.Fatalf("database holds %q", stored)
	}
	if _, found, err = repo.GetPreference(context.Background(), repository.PreferenceLogFilters); err != nil || !found {
		t.Fatalf("log filters not persisted: found=%v err=%v", found, err)
	}
}

// A range with no end is "至今": the end tracks the current time, so the newest
// bucket keeps appearing without the user touching anything.
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

// 实时 is a fifteen-minute window: one bucket per minute, so the newest point
// moves on the scale the collector actually delivers at. Five minutes would be
// too narrow to read as a trend; an hour is too coarse to feel live.
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
