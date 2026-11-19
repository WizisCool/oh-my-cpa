package api

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"math/rand/v2"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/quota"
	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
	"github.com/oh-my-cpa/oh-my-cpa/internal/usage"
)

func trendsAuthFilesHandler(files []map[string]any, unavailable *atomic.Bool) http.HandlerFunc {
	return func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/v8/management/credentials" {
			http.NotFound(writer, request)
			return
		}
		if unavailable != nil && unavailable.Load() {
			writer.WriteHeader(http.StatusBadGateway)
			_, _ = writer.Write([]byte(`{"error":"upstream unavailable"}`))
			return
		}
		writer.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(writer).Encode(map[string]any{"files": files})
	}
}

func trendsTestRead[T any](t *testing.T, client *http.Client, url string) T {
	t.Helper()
	response, body := getJSON(t, client, url)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("status %d: %s", response.StatusCode, body)
	}
	var result T
	if err := json.Unmarshal(body, &result); err != nil {
		t.Fatal(err)
	}
	return result
}

func trendsTestNumber(t *testing.T, name string, value *float64, want float64) {
	t.Helper()
	if value == nil || math.Abs(*value-want) > 1e-8 {
		t.Fatalf("%s: got %v, want %v", name, value, want)
	}
}

func TestTrendsUsageComparisonGroupingAndMovers(t *testing.T) {
	now := time.Date(2026, 10, 21, 12, 0, 0, 0, time.UTC)
	client, baseURL, repo := startDashboardTestServer(t, nil, func(handler *Handler) { handler.nowFn = func() time.Time { return now } })
	repo.Timezone().Apply(time.UTC)
	ctx := context.Background()
	var events []usage.Event
	add := func(model, agent string, hour int, tokens usage.TokenStats) {
		event := eventFor(fmt.Sprintf("trend-usage-%d", len(events)), now.Add(time.Duration(hour)*time.Hour+15*time.Minute), tokens, false)
		event.Provider, event.Model, event.ClientAgent = "codex", model, agent
		events = append(events, event)
	}
	add("cache-only", "claude-code", -4, usage.TokenStats{InputTokens: 100, CacheReadTokens: 100, TotalTokens: 100})
	add("rising", "claude-code", -3, usage.TokenStats{InputTokens: 200, CacheReadTokens: 100, OutputTokens: 100, ReasoningTokens: 20, TotalTokens: 300})
	add("new", "claude-code", -3, usage.TokenStats{InputTokens: 120, TotalTokens: 120})
	add("rising", "claude-code", -7, usage.TokenStats{InputTokens: 30, TotalTokens: 30})
	add("gone", "claude-code", -6, usage.TokenStats{InputTokens: 160, TotalTokens: 160})
	add("tiny", "claude-code", -5, usage.TokenStats{InputTokens: 1, TotalTokens: 1})
	add("rising", "opencode", -3, usage.TokenStats{InputTokens: 999, TotalTokens: 999})
	if _, err := repo.InsertUsageEvents(ctx, events); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.AggregateUsageFacts(ctx, 100); err != nil {
		t.Fatal(err)
	}

	path := fmt.Sprintf("%s/omc/api/v1/management/trends/usage?from=%d&to=%d&bucket=hour&group_by=model&top=2&client_agent=claude-code", baseURL, now.Add(-4*time.Hour).UnixMilli(), now.UnixMilli()-1)
	result := trendsTestRead[TrendsUsageResponseDTO](t, client, path)
	if result.Totals.Requests != 3 || result.Totals.NetTokens != 320 || result.Totals.TotalTokens != 520 || result.CompareWindow == nil || result.CompareTotals == nil || result.CompareTotals.NetTokens != 191 || result.CompareTotals.BaselineNetTokens != 191 {
		t.Fatalf("totals=%+v compare=%+v", result.Totals, result.CompareTotals)
	}
	if len(result.Buckets) != 4 || result.Buckets[3].CumNetTokens != 320 || result.Buckets[3].CumTotalTokens != 520 || result.Buckets[2].Requests != 0 || result.Buckets[3].CompareCumNetTokens == nil || *result.Buckets[3].CompareCumNetTokens != 191 {
		t.Fatalf("comparison overlay=%+v", result.Buckets)
	}
	trendsTestNumber(t, "saturated cache", result.Buckets[0].CacheRate, 99.9)
	trendsTestNumber(t, "reasoning share", result.Buckets[1].ReasoningShare, 20)
	if result.Buckets[0].ReasoningShare != nil || result.Buckets[2].CacheRate != nil {
		t.Fatalf("empty denominators produce rates: %+v", result.Buckets)
	}
	if len(result.Series) != 3 || result.Series[0].ID != "rising" || result.Series[1].ID != "new" || !result.Series[2].Folded || result.Series[2].TotalTokens != 100 || result.Series[2].Buckets[1].Requests != 0 {
		t.Fatalf("top and folded=%+v", result.Series)
	}
	if len(result.Groups) != 3 || result.Groups[0].ID != "rising" || result.Groups[0].Requests != 1 || result.Groups[2].ID != "cache-only" {
		t.Fatalf("listed filter groups=%+v", result.Groups)
	}
	if len(result.Movers.Risers) != 2 || result.Movers.Risers[0].ID != "rising" || result.Movers.Risers[0].DeltaNetTokens < result.Movers.Risers[1].DeltaNetTokens || result.Movers.Risers[1].Status != "new" || result.Movers.Risers[1].DeltaPercent != nil || len(result.Movers.Fallers) != 1 || result.Movers.Fallers[0].Status != "quiet" || result.Movers.Fallers[0].ID != "gone" {
		t.Fatalf("movers=%+v", result.Movers)
	}
	grouped := trendsTestRead[TrendsUsageResponseDTO](t, client, path+"&provider=codex&provider=irrelevant")
	if grouped.Totals.Requests != 3 {
		t.Fatalf("provider union discarded matching traffic: %+v", grouped.Totals)
	}
}

func TestTrendsTelemetryModesClassificationsAndRetention(t *testing.T) {
	now := time.Date(2026, 10, 22, 2, 0, 0, 0, time.UTC)
	client, baseURL, repo := startDashboardTestServer(t, nil, func(handler *Handler) { handler.nowFn = func() time.Time { return now } })
	repo.Timezone().Apply(time.UTC)
	ctx := context.Background()
	horizon := now.Add(-2 * time.Hour)
	var events []usage.Event
	add := func(model string, at time.Time, latency, ttft, output int64, isGenerate bool, failure int, code usage.FailureCode) {
		event := eventFor(fmt.Sprintf("trend-telemetry-%d", len(events)), at, usage.TokenStats{OutputTokens: output, TotalTokens: output}, failure > 0)
		event.Provider, event.Model, event.ClientAgent = "codex", model, "claude-code"
		event.LatencyMS, event.Generate, event.FailStatusCode, event.FailCode = latency, isGenerate, failure, code
		if ttft >= 0 {
			event.TTFTMS = &ttft
		}
		events = append(events, event)
	}
	add("gpt-main", horizon.Add(-time.Hour), 999, 99, 0, true, 400, "")
	at := horizon.Add(10 * time.Minute)
	add("gpt-main", at, 1000, 100, 90, true, 0, "")
	add("gpt-main", at, 2000, 500, 150, true, 0, "")
	add("gpt-main", at, 4000, -1, 40, true, 0, "")
	add("gpt-main", at, 100, 100, 20, true, 0, "")
	add("gpt-main", at, 3000, 200, 0, true, 0, "")
	add("gpt-main", at, 1500, -1, 100, false, 0, "")
	events[1].ResponseModel, events[1].ModelSubstituted = "gpt-served", true
	add("gpt-error", at, 0, -1, 0, true, 429, "")
	add("gpt-error", at, 0, -1, 0, true, 503, "")
	add("gpt-error", at, 0, -1, 0, true, 502, usage.FailureStreamTruncated)
	add("gpt-error", at, 0, -1, 0, true, 429, usage.FailureForceCooldown)
	add("gpt-error", at, 0, -1, 0, true, 400, "")
	// Unattributed requests: one generating request (belongs in client_agent=unknown)
	// and one non-generating request (must be excluded from client-scoped telemetry).
	unknownGen := eventFor("trend-telemetry-unknown-gen", at, usage.TokenStats{InputTokens: 20, OutputTokens: 30, TotalTokens: 50}, false)
	unknownGen.Provider, unknownGen.Model, unknownGen.ClientAgent = "codex", "gpt-main", ""
	unknownGen.LatencyMS, unknownGen.Generate = 600, true
	unknownNonGen := eventFor("trend-telemetry-unknown-nongen", at, usage.TokenStats{OutputTokens: 10, TotalTokens: 10}, false)
	unknownNonGen.Provider, unknownNonGen.Model, unknownNonGen.ClientAgent = "codex", "gpt-unknown-nongen", ""
	unknownNonGen.LatencyMS, unknownNonGen.Generate = 200, false
	events = append(events, unknownGen, unknownNonGen)
	if _, err := repo.InsertUsageEvents(ctx, events); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.AggregateUsageFacts(ctx, 100); err != nil {
		t.Fatal(err)
	}
	for range 2 {
		if _, err := repo.RunLifecycle(ctx, map[string]int64{repository.LifecycleUsageDetail: horizon.UnixMilli()}, 10); err != nil {
			t.Fatal(err)
		}
	}

	path := fmt.Sprintf("%s/omc/api/v1/management/trends/telemetry?from=%d&to=%d&bucket=hour&top=1", baseURL, horizon.Add(-2*time.Hour).UnixMilli(), now.UnixMilli()-1)
	result := trendsTestRead[TrendsTelemetryResponseDTO](t, client, path)
	if result.Coverage.FactRequests != 14 || result.Coverage.RetainedRequests != 13 || !result.Coverage.IsTruncatedByRetention || result.Coverage.RetentionStartMS == nil || *result.Coverage.RetentionStartMS != horizon.UnixMilli() {
		t.Fatalf("coverage=%+v", result.Coverage)
	}
	stats := result.Summary
	if result.TPSMode != "include_ttft" || stats.TPSSamples != 5 || stats.TTFTSamples != 4 || stats.LatencySamples != 8 || stats.TotalRequests != 13 || stats.SuccessRequests != 8 || stats.FailedRequests != 5 || stats.RateLimited429 != 2 || stats.Upstream5xx != 2 || stats.StreamTruncated != 1 || stats.ForceCooldown != 1 || stats.OtherFailures != 1 || stats.ModelSubstituted != 1 {
		t.Fatalf("telemetry summary=%+v", stats)
	}
	trendsTestNumber(t, "include TTFT mean", stats.TPSMean, 85)
	trendsTestNumber(t, "include TTFT median", stats.TPSP50, 75)
	trendsTestNumber(t, "TTFT p50", stats.TTFTP50MS, 150)
	trendsTestNumber(t, "TTFT p95", stats.TTFTP95MS, 455)
	trendsTestNumber(t, "latency p50", stats.LatencyP50MS, 1250)
	trendsTestNumber(t, "latency p95", stats.LatencyP95MS, 3650)
	if len(result.Series) != 1 || result.Series[0].ID != "gpt-main" || len(result.Groups) != 3 || result.Groups[0].ID != "gpt-main" || result.Groups[1].ID != "gpt-error" || len(result.Scatter) != 13 || result.Scatter[0].OutputTokens != 90 || result.Scatter[0].GroupID != "gpt-main" {
		t.Fatalf("wrong series, groups or scatter: %+v", result)
	}
	if len(result.Buckets) != 4 || result.Buckets[3].TPSP50 != nil || result.Buckets[3].TTFTP95MS != nil || result.Buckets[3].LatencyP50MS != nil || result.Buckets[2].TPSSamples != 5 {
		t.Fatalf("empty bucket and grid=%+v", result.Buckets)
	}
	if len(result.SubstitutionPairs) != 1 || result.SubstitutionPairs[0] != (TrendsSubstitutionPairDTO{RequestedModel: "gpt-main", ServedModel: "gpt-served", Provider: "codex", Count: 1}) {
		t.Fatalf("substitutions=%+v", result.SubstitutionPairs)
	}
	if len(result.FailureGroups) != 1 {
		t.Fatalf("expected 1 failure group, got %+v", result.FailureGroups)
	}
	fg := result.FailureGroups[0]
	if fg.Model != "gpt-error" || fg.Provider != "codex" || fg.FailedRequests != 5 || fg.TotalRequests != 5 || fg.ModelTotalRequests != 5 || fg.ProviderTotalRequests != 13 || fg.RateLimited429 != 2 || fg.Upstream5xx != 2 || fg.StreamTruncated != 1 || fg.ForceCooldown != 1 || fg.OtherFailures != 1 || fg.LastFailedAtMS != at.UnixMilli() {
		t.Fatalf("unexpected failure group=%+v", fg)
	}
	wantCodes := []TrendsStatusCountDTO{{Code: 429, Count: 2}, {Code: 400, Count: 1}, {Code: 502, Count: 1}, {Code: 503, Count: 1}}
	if !slices.Equal(fg.StatusCodes, wantCodes) {
		t.Fatalf("failure status codes=%+v want %+v", fg.StatusCodes, wantCodes)
	}
	if err := repo.PutPreference(ctx, repository.PreferenceTpsCalculationMode, `"exclude_ttft"`); err != nil {
		t.Fatal(err)
	}
	result = trendsTestRead[TrendsTelemetryResponseDTO](t, client, path+"&client_agent=claude-code&model=gpt-main&model=missing")
	if result.TPSMode != "exclude_ttft" || result.Summary.TPSSamples != 2 || result.Coverage.RetainedRequests != 5 || result.Coverage.FactRequests != 5 {
		t.Fatalf("filtered decode mode=%s stats=%+v coverage=%+v", result.TPSMode, result.Summary, result.Coverage)
	}
	trendsTestNumber(t, "exclude TTFT mean", result.Summary.TPSMean, 100)
	trendsTestNumber(t, "exclude TTFT median", result.Summary.TPSP50, 100)
	withAgent := trendsTestRead[TrendsTelemetryResponseDTO](t, client, path+"&client_agent=claude-code")
	if withAgent.Summary.FailedRequests != 5 || withAgent.Summary.RateLimited429 != 2 || withAgent.Coverage.FactRequests != 10 || withAgent.Coverage.RetainedRequests != 10 {
		t.Fatalf("client-scoped telemetry should include generating failures and exclude non-generating requests: summary=%+v coverage=%+v", withAgent.Summary, withAgent.Coverage)
	}
	unknownAgentTel := trendsTestRead[TrendsTelemetryResponseDTO](t, client, path+"&client_agent=unknown")
	unknownAgentUsage := trendsTestRead[TrendsUsageResponseDTO](t, client, fmt.Sprintf("%s/omc/api/v1/management/trends/usage?from=%d&to=%d&bucket=hour&client_agent=unknown", baseURL, horizon.Add(-2*time.Hour).UnixMilli(), now.UnixMilli()-1))
	if unknownAgentTel.Summary.TotalRequests != 1 || unknownAgentUsage.Totals.Requests != 1 || len(unknownAgentTel.Groups) != 1 || unknownAgentTel.Groups[0].ID != "gpt-main" {
		t.Fatalf("client_agent=unknown must exclude non-generation empty-agent traffic and match usage facts: tel=%+v usage=%+v", unknownAgentTel, unknownAgentUsage)
	}
}

func TestTrendsQuotaCyclesForecastAndPhysicalUsage(t *testing.T) {
	start := time.Date(2026, 10, 21, 12, 0, 0, 0, time.UTC)
	now := start.Add(3*time.Hour + 30*time.Minute)
	const index = "trends-quota-credential"
	var cpaUnavailable atomic.Bool
	var disabled atomic.Bool
	client, baseURL, repo := startDashboardTestServer(t, func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/v8/management/credentials" {
			http.NotFound(writer, request)
			return
		}
		if cpaUnavailable.Load() {
			writer.WriteHeader(http.StatusBadGateway)
			_, _ = writer.Write([]byte(`{"error":"upstream unavailable"}`))
			return
		}
		writer.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(writer).Encode(map[string]any{
			"files": []map[string]any{{
				"auth_index": index, "name": "quota-test-private.json", "type": "codex", "provider": "codex",
				"account_type": "oauth", "email": "quota-owner@example.test", "disabled": disabled.Load(),
			}},
		})
	}, func(handler *Handler) { handler.nowFn = func() time.Time { return now } })
	ctx := context.Background()
	if err := repo.UpsertArchivedCredentials(ctx, defaultInstanceID(), []repository.ArchivedCredential{
		{AuthIndex: index, Kind: "oauth", ProviderFamily: "codex", FileName: "quota-test-private.json", DisplayName: "Archived team", MaskedAccount: "quota-owner@example.test"},
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.SetCredentialDisplayName(ctx, defaultInstanceID(), "quota-test-private.json", "Quota team", 0); err != nil {
		t.Fatal(err)
	}
	var events []usage.Event
	for _, at := range []time.Time{start.Add(-9 * time.Hour), start.Add(-4 * time.Hour), start.Add(10 * time.Minute), start.Add(70 * time.Minute), start.Add(2*time.Hour + 10*time.Minute), start.Add(3*time.Hour + 10*time.Minute)} {
		event := eventFor(fmt.Sprintf("quota-trend-%d", len(events)), at, usage.TokenStats{InputTokens: 100, CacheReadTokens: 80, CacheCreationTokens: 10, OutputTokens: 20, TotalTokens: 120}, false)
		event.Provider, event.AuthIndex, event.Model = "codex", index, "gpt-main"
		events = append(events, event)
	}
	if _, err := repo.InsertUsageEvents(ctx, events); err != nil {
		t.Fatal(err)
	}
	save := func(at, reset time.Time, percentages ...float64) {
		t.Helper()
		var windows []quota.QuotaWindow
		period, resetMS := 5.0, reset.UnixMilli()
		for i, percent := range percentages {
			windows = append(windows, quota.QuotaWindow{ID: []string{"limited", "forecast", "idle"}[i], UsedPercent: &percent, Scope: "standard", Kind: "five_hour", PeriodHours: &period, ResetAtMS: &resetMS, ResetAccuracy: "exact"})
		}
		raw, err := json.Marshal(windows)
		if err != nil {
			t.Fatal(err)
		}
		if err := repo.SaveQuotaSnapshot(ctx, repository.QuotaSnapshotRecord{ID: fmt.Sprintf("trend-reading-%d", at.UnixMilli()), AuthIndex: index, Provider: "codex", Status: "healthy", ObservedAtMS: at.UnixMilli(), CreatedAtMS: at.UnixMilli(), WindowsJSON: string(raw)}); err != nil {
			t.Fatal(err)
		}
	}
	save(start.Add(-6*time.Hour), start.Add(-5*time.Hour), 50, 50, 50)
	save(start.Add(-time.Hour), start, 60, 60, 60)
	reset := start.Add(5 * time.Hour)
	save(start.Add(time.Hour), reset, 20, 5, 2)
	save(start.Add(2*time.Hour), reset, 45, 35, 4)
	save(start.Add(3*time.Hour), reset, 100, 65, 8)
	save(now, reset, 100, 80, 10)
	result := trendsTestRead[TrendsQuotaResponseDTO](t, client, baseURL+"/omc/api/v1/management/trends/quota?provider=codex&provider=other&auth_index="+index)
	if result.Summary != (TrendsQuotaSummaryDTO{ActiveCredentials: 1, ObservableWindows: 3, LimitReachedWindows: 1, ProjectedExhaustWindows: 1, UnderutilizedWindows: 1}) || len(result.Items) != 1 {
		t.Fatalf("quota summary=%+v", result.Summary)
	}
	item := result.Items[0]
	if item.DisplayName != "Quota team" || item.AccountLabel != "qu•••r@example.test" {
		t.Fatalf("quota identity not restored safely: %+v", item)
	}
	limited, forecast, idle := item.Windows[0], item.Windows[1], item.Windows[2]
	if limited.ExhaustedAtMS == nil || *limited.ExhaustedAtMS != start.Add(3*time.Hour).UnixMilli() || limited.CurrentRequests != 3 || limited.CurrentNetTokens != 90 || limited.CurrentTotalTokens != 360 {
		t.Fatalf("earliest exhaustion and pre-limit usage=%+v", limited)
	}
	if len(forecast.Buckets) != 20 || forecast.ProjectedEndPercent == nil || *forecast.ProjectedEndPercent <= 100 || forecast.ProjectedExhaustAtMS == nil || *forecast.ProjectedExhaustAtMS >= reset.UnixMilli() || forecast.BurnRatePerHour == nil || *forecast.BurnRatePerHour < 20 {
		t.Fatalf("forecast should pass 100 before reset=%+v", forecast)
	}
	if idle.ProjectedEndPercent == nil || *idle.ProjectedEndPercent >= 35 || idle.Status != "underutilized" {
		t.Fatalf("low use should remain below 35%%=%+v", idle)
	}
	if len(forecast.Cycles) != 3 || !forecast.Cycles[0].IsCurrent || forecast.Cycles[1].IsCurrent || forecast.Cycles[1].ActualNetTokens != 30 || forecast.Cycles[1].FullNetTokens == nil || *forecast.Cycles[1].FullNetTokens != 50 || forecast.Cycles[1].FullTotalTokens == nil || *forecast.Cycles[1].FullTotalTokens != 200 {
		t.Fatalf("physical capacity and net token accounting=%+v", forecast.Cycles)
	}
	var previous float64
	for i, point := range limited.Buckets {
		if point.UsedPercent < previous || point.EndMS-point.StartMS != repository.QuarterHourBucketMS || point.DeltaPercent < 0 || (i >= 12 && (!point.IsForecast || point.UsedPercent != 100 || point.Requests != 0)) {
			t.Fatalf("bucket %d breaks measured/forecast curve: %+v", i, point)
		}
		previous = point.UsedPercent
	}

	// Disabling the credential excludes it when CPA is reachable.
	disabled.Store(true)
	disabledResp := trendsTestRead[TrendsQuotaResponseDTO](t, client, baseURL+"/omc/api/v1/management/trends/quota?provider=codex&auth_index="+index)
	if len(disabledResp.Items) != 0 || disabledResp.Summary.ActiveCredentials != 0 || disabledResp.Summary.IsMembershipUnknown {
		t.Fatalf("disabled credential must be excluded when CPA is live: %+v", disabledResp)
	}

	// When CPA becomes unavailable, the archived reading remains accessible with safe identity,
	// while active membership and risk are reported as unknown without forecasts.
	cpaUnavailable.Store(true)
	offlineResp := trendsTestRead[TrendsQuotaResponseDTO](t, client, baseURL+"/omc/api/v1/management/trends/quota?provider=codex&auth_index="+index)
	if offlineResp.Summary != (TrendsQuotaSummaryDTO{ActiveCredentials: 0, IsMembershipUnknown: true, ObservableWindows: 3}) || len(offlineResp.Items) != 1 {
		t.Fatalf("offline fallback must preserve readings while reporting membership and risk unknown: %+v", offlineResp.Summary)
	}
	offlineItem := offlineResp.Items[0]
	if offlineItem.Status != "unknown" || offlineItem.DisplayName != "Quota team" || offlineItem.AccountLabel != "qu•••r@example.test" {
		t.Fatalf("offline credential status/identity=%+v", offlineItem)
	}
	for _, w := range offlineItem.Windows {
		if w.ProjectedExhaustAtMS != nil || w.BurnRatePerHour != nil || w.Status != trendsQuotaNormal || w.Capacity != nil {
			t.Fatalf("offline unverified window must suppress forecast/risk/capacity: %+v", w)
		}
	}
}

func TestTrendsQuotaAdvancesNowAndProjectionPastStaleObservation(t *testing.T) {
	start := time.Date(2026, 10, 21, 22, 10, 0, 0, time.UTC)
	observed := start.Add(3*time.Hour + 33*time.Minute) // 01:43
	now := start.Add(3*time.Hour + 42*time.Minute)      // 01:52 (after naive at+2m=01:45)
	reset := start.Add(5 * time.Hour)                   // 03:10
	const index = "trends-quota-stale-now"

	client, baseURL, repo := startDashboardTestServer(t, trendsAuthFilesHandler([]map[string]any{{
		"auth_index": index, "name": "stale-now.json", "type": "claude", "provider": "claude", "account_type": "oauth",
	}}, nil), func(handler *Handler) { handler.nowFn = func() time.Time { return now } })
	ctx := context.Background()

	save := func(at time.Time, used float64) {
		t.Helper()
		period, resetMS := 5.0, reset.UnixMilli()
		windows := []quota.QuotaWindow{{
			ID: "five_hour", Label: "5小时滚动用量 (5-Hour)", Scope: "standard", PeriodHours: &period,
			UsedPercent: &used, ResetAtMS: &resetMS, ResetAccuracy: "exact",
		}, {
			ID: "seven_day_sonnet", Label: "Sonnet 每周用量", Scope: "model", Model: "claude-3-5-sonnet", PeriodHours: &period,
			UsedPercent: &used, ResetAtMS: &resetMS, ResetAccuracy: "exact",
		}}
		raw, err := json.Marshal(windows)
		if err != nil {
			t.Fatal(err)
		}
		if err := repo.SaveQuotaSnapshot(ctx, repository.QuotaSnapshotRecord{
			ID: fmt.Sprintf("stale-now-%d", at.UnixMilli()), AuthIndex: index, Provider: "claude",
			Status: "healthy", ObservedAtMS: at.UnixMilli(), CreatedAtMS: at.UnixMilli(), WindowsJSON: string(raw),
		}); err != nil {
			t.Fatal(err)
		}
	}
	save(start.Add(2*time.Hour), 30)
	save(start.Add(2*time.Hour+30*time.Minute), 58)
	save(start.Add(3*time.Hour), 78)
	save(observed, 99)

	postEvent := eventFor("post-observed", observed.Add(4*time.Minute), usage.TokenStats{InputTokens: 50, OutputTokens: 10, TotalTokens: 60}, false)
	postEvent.Provider, postEvent.AuthIndex, postEvent.Model = "claude", index, "claude-3-5-sonnet"
	if _, err := repo.InsertUsageEvents(ctx, []usage.Event{postEvent}); err != nil {
		t.Fatal(err)
	}

	result := trendsTestRead[TrendsQuotaResponseDTO](t, client, baseURL+"/omc/api/v1/management/trends/quota?auth_index="+index)
	if len(result.Items) != 1 || len(result.Items[0].Windows) != 2 {
		t.Fatalf("unexpected quota trends items: %+v", result.Items)
	}
	win := result.Items[0].Windows[0]
	if win.ProjectedExhaustAtMS == nil || *win.ProjectedExhaustAtMS <= now.UnixMilli() {
		t.Fatalf("projected exhaustion must stay after now (%d), got %v", now.UnixMilli(), win.ProjectedExhaustAtMS)
	}
	if win.Status != trendsQuotaProjectedExhaust || win.CurrentRequests != 1 {
		t.Fatalf("expected projected_exhaust with post-observation physical request counted, got status=%s requests=%d", win.Status, win.CurrentRequests)
	}
	if result.Items[0].Windows[1].Model != "claude-3-5-sonnet" {
		t.Fatalf("expected model field projected on model-scoped window, got %+v", result.Items[0].Windows[1])
	}
	var lastMeasuredEnd int64
	for _, bucket := range win.Buckets {
		if !bucket.IsForecast {
			lastMeasuredEnd = bucket.EndMS
			if bucket.UsedPercent > 99.0001 {
				t.Fatalf("measured bucket %+v must not extrapolate above last observed 99%%", bucket)
			}
		} else if bucket.StartMS < now.UnixMilli() {
			t.Fatalf("forecast bucket starts before now (%d): %+v", now.UnixMilli(), bucket)
		}
	}
	if lastMeasuredEnd != now.UnixMilli() {
		t.Fatalf("measured divider should align with now (%d), got %d", now.UnixMilli(), lastMeasuredEnd)
	}

	// Once wall-clock passes cycle reset without a fresh snapshot, no forecast buckets remain
	// even if the expired snapshot had already reached 100%.
	now = reset.Add(10 * time.Minute)
	expired := trendsTestRead[TrendsQuotaResponseDTO](t, client, baseURL+"/omc/api/v1/management/trends/quota?auth_index="+index).Items[0].Windows[0]
	if expired.ProjectedExhaustAtMS != nil || expired.BurnRatePerHour != nil || expired.Status != trendsQuotaNormal {
		t.Fatalf("expired cycle must not emit forecast: %+v", expired)
	}
	for _, bucket := range expired.Buckets {
		if bucket.IsForecast {
			t.Fatalf("expired cycle must not mark forecast buckets: %+v", bucket)
		}
	}

	// Verify an expired 100%-used snapshot does not emit forecast or limit_reached status.
	period, resetMS := 5.0, reset.UnixMilli()
	exhaustedRaw, err := json.Marshal([]quota.QuotaWindow{{
		ID: "five_hour", Scope: "standard", PeriodHours: &period,
		UsedPercent: func() *float64 { v := 100.0; return &v }(), ResetAtMS: &resetMS, ResetAccuracy: "exact",
	}})
	if err != nil {
		t.Fatal(err)
	}
	if err := repo.SaveQuotaSnapshot(ctx, repository.QuotaSnapshotRecord{
		ID: "stale-now-exhausted-expired", AuthIndex: index, Provider: "claude",
		Status: "healthy", ObservedAtMS: reset.Add(-15 * time.Minute).UnixMilli(), CreatedAtMS: reset.Add(-15 * time.Minute).UnixMilli(), WindowsJSON: string(exhaustedRaw),
	}); err != nil {
		t.Fatal(err)
	}
	expiredFull := trendsTestRead[TrendsQuotaResponseDTO](t, client, baseURL+"/omc/api/v1/management/trends/quota?auth_index="+index).Items[0].Windows[0]
	if expiredFull.Status != trendsQuotaNormal || expiredFull.ExhaustedAtMS == nil {
		t.Fatalf("expired 100%% cycle must preserve ExhaustedAtMS and report normal status, got %+v", expiredFull)
	}
	for _, bucket := range expiredFull.Buckets {
		if bucket.IsForecast {
			t.Fatalf("expired 100%% cycle must not mark forecast buckets: %+v", bucket)
		}
	}
}

func TestTrendsRedactedGroupIDsRoundTripAndConsistentWindowBoundaries(t *testing.T) {
	now := time.Date(2026, 10, 21, 12, 10, 0, 0, time.UTC)
	client, baseURL, repo := startDashboardTestServer(t, nil, func(handler *Handler) { handler.nowFn = func() time.Time { return now } })
	repo.Timezone().Apply(time.UTC)
	ctx := context.Background()

	// Use a horizon after all seeded events so queries read 15m rolled-up facts and test
	// boundary non-overlap between current and compare windows.
	boundaryAt := now.Add(-2*time.Hour - 5*time.Minute) // sits inside the 15m bucket at 10:00..10:15
	currentAt := now.Add(-30 * time.Minute)
	horizon := now.Add(-time.Minute)

	sensitiveModel := "custom-alice@example.com-sk-ant-api03-1234567890abcdef1234567890abcdef"
	servedModel := "served-bob@example.com"
	var events []usage.Event
	add := func(at time.Time, model string, tokens int64) {
		e := eventFor(fmt.Sprintf("redacted-%d", len(events)), at, usage.TokenStats{InputTokens: tokens, OutputTokens: tokens, TotalTokens: tokens * 2}, false)
		e.Provider, e.Model, e.LatencyMS, e.Generate = "codex", model, 1000, true
		ttft := int64(100)
		e.TTFTMS = &ttft
		events = append(events, e)
	}
	add(boundaryAt, sensitiveModel, 50)
	add(currentAt, sensitiveModel, 100)
	// Also test retained scatter/substitution redaction with a newer un-purged event.
	retained := eventFor("redacted-retained", now.Add(-30*time.Second), usage.TokenStats{InputTokens: 20, OutputTokens: 40, TotalTokens: 60}, false)
	retained.Provider, retained.Model, retained.ResponseModel, retained.ModelSubstituted = "codex", sensitiveModel, servedModel, true
	retained.LatencyMS, retained.Generate = 500, true
	ttft := int64(50)
	retained.TTFTMS = &ttft
	events = append(events, retained)

	if _, err := repo.InsertUsageEvents(ctx, events); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.AggregateUsageFacts(ctx, 100); err != nil {
		t.Fatal(err)
	}
	for range 2 {
		if _, err := repo.RunLifecycle(ctx, map[string]int64{repository.LifecycleUsageDetail: horizon.UnixMilli()}, 10); err != nil {
			t.Fatal(err)
		}
	}

	from := now.Add(-2 * time.Hour).UnixMilli()
	to := now.UnixMilli() - 1
	usageURL := fmt.Sprintf("%s/omc/api/v1/management/trends/usage?from=%d&to=%d&bucket=hour&group_by=model", baseURL, from, to)
	usageResp := trendsTestRead[TrendsUsageResponseDTO](t, client, usageURL)
	if len(usageResp.Series) != 1 {
		t.Fatalf("expected 1 model series, got %+v", usageResp.Series)
	}
	opaqueID := usageResp.Series[0].ID
	if !strings.HasPrefix(opaqueID, repository.TrendsRedactedPrefix) {
		t.Fatalf("expected opaque redacted prefix, got %q", opaqueID)
	}
	if strings.Contains(usageResp.Series[0].Label, "alice@example.com") || strings.Contains(usageResp.Series[0].Label, "sk-ant-api03") {
		t.Fatalf("label leaked raw sensitive data: %q", usageResp.Series[0].Label)
	}
	// Boundary 15m bucket widens into current (3 requests) and is excluded from compare (0 requests).
	if usageResp.Totals.Requests != 3 || usageResp.CompareTotals == nil || usageResp.CompareTotals.Requests != 0 {
		t.Fatalf("expected exact current=3 and compare=0 requests without boundary overlap, got current=%d compare=%+v", usageResp.Totals.Requests, usageResp.CompareTotals)
	}

	// Filtering by the opaque redacted ID resolves back to the stored model on both endpoints.
	filteredUsage := trendsTestRead[TrendsUsageResponseDTO](t, client, usageURL+"&model="+url.QueryEscape(opaqueID))
	if filteredUsage.Totals.Requests != usageResp.Totals.Requests {
		t.Fatalf("opaque model filter did not match usage: got %d want %d", filteredUsage.Totals.Requests, usageResp.Totals.Requests)
	}
	telemetryURL := fmt.Sprintf("%s/omc/api/v1/management/trends/telemetry?from=%d&to=%d&bucket=hour&group_by=model", baseURL, from, to)
	telemetryResp := trendsTestRead[TrendsTelemetryResponseDTO](t, client, telemetryURL+"&model="+url.QueryEscape(opaqueID))
	if len(telemetryResp.Scatter) != 1 || telemetryResp.Scatter[0].GroupID != opaqueID {
		t.Fatalf("scatter group_id should match opaque ID %q, got %+v", opaqueID, telemetryResp.Scatter)
	}
	if strings.Contains(telemetryResp.Scatter[0].Model, "sk-ant-api03") || strings.Contains(telemetryResp.Scatter[0].Model, "alice@example.com") {
		t.Fatalf("scatter model leaked secret/email: %q", telemetryResp.Scatter[0].Model)
	}
	if len(telemetryResp.SubstitutionPairs) != 1 || strings.Contains(telemetryResp.SubstitutionPairs[0].ServedModel, "bob@example.com") {
		t.Fatalf("substitution pair leaked email: %+v", telemetryResp.SubstitutionPairs)
	}
	// Verify failure attribution also redacts sensitive model/credential strings without losing opaque filter IDs.
	failEvent := eventFor("redacted-fail-1", now.Add(-20*time.Second), usage.TokenStats{}, true)
	failEvent.Model = "claude-alice@example.com-sk-ant-api03-secret"
	failEvent.Provider = "anthropic"
	failEvent.AuthIndex = "cred-carol@example.com"
	failEvent.FailStatusCode = 429
	if _, err := repo.InsertUsageEvents(ctx, []usage.Event{failEvent}); err != nil {
		t.Fatal(err)
	}
	redactedFailResp := trendsTestRead[TrendsTelemetryResponseDTO](t, client, telemetryURL)
	if len(redactedFailResp.FailureGroups) != 1 {
		t.Fatalf("expected 1 redacted failure group, got %+v", redactedFailResp.FailureGroups)
	}
	rfg := redactedFailResp.FailureGroups[0]
	if strings.Contains(rfg.Model, "alice@example.com") || strings.Contains(rfg.Model, "sk-ant-api03") || strings.Contains(rfg.AuthIndex, "carol@example.com") {
		t.Fatalf("failure group leaked sensitive data: %+v", rfg)
	}
	if !strings.HasPrefix(rfg.ModelID, repository.TrendsRedactedPrefix) || !strings.HasPrefix(rfg.AuthIndexID, repository.TrendsRedactedPrefix) || rfg.DrillDisabled {
		t.Fatalf("expected opaque redacted drill IDs on failure group, got %+v", rfg)
	}
	if rfg.CredentialTotalRequests != 1 || rfg.RateLimited429 != 1 {
		t.Fatalf("unexpected redacted failure group counts: %+v", rfg)
	}
}

func TestBoundFailureGroupsPreservesActiveLanesAndFlagsTruncation(t *testing.T) {
	groups := make([]TrendsFailureGroupDTO, 0, maxTelemetryFailureGroups+2)
	for i := range maxTelemetryFailureGroups + 1 {
		groups = append(groups, TrendsFailureGroupDTO{
			Model:          "gpt-5",
			Provider:       "codex",
			AuthIndex:      fmt.Sprintf("cred-%03d", i),
			FailedRequests: 2,
			Upstream5xx:    2,
		})
	}
	// The lowest-total tuple is the sole 429 culprit; bounding must keep it and mark truncated.
	groups = append(groups, TrendsFailureGroupDTO{
		Model:          "gpt-5",
		Provider:       "codex",
		AuthIndex:      "sole-429",
		FailedRequests: 1,
		RateLimited429: 1,
	})
	bounded, truncated := boundFailureGroups(groups, maxTelemetryFailureGroups)
	if !truncated || len(bounded) != maxTelemetryFailureGroups {
		t.Fatalf("boundFailureGroups = (%d, %v), want (%d, true)", len(bounded), truncated, maxTelemetryFailureGroups)
	}
	foundSole429 := false
	for _, g := range bounded {
		if g.AuthIndex == "sole-429" {
			foundSole429 = true
			break
		}
	}
	if !foundSole429 {
		t.Fatalf("sole 429 culprit dropped by failure-group cap")
	}
}

func TestTrendsTelemetryReservoirBoundsSamples(t *testing.T) {
	rng := rand.New(rand.NewPCG(1, 2))
	var stats trendsTelemetryStats
	const total = maxTelemetryPercentileSamples + 500
	for i := 1; i <= total; i++ {
		tps := float64(i)
		ttft := int64(i * 2)
		stats.add(repository.UsageTelemetrySample{
			TPS:       &tps,
			TTFTMS:    &ttft,
			LatencyMS: int64(i * 3),
		}, rng)
	}
	if len(stats.tps.samples) != maxTelemetryPercentileSamples || len(stats.ttft.samples) != maxTelemetryPercentileSamples || len(stats.latency.samples) != maxTelemetryPercentileSamples {
		t.Fatalf("reservoirs exceeded cap %d: tps=%d ttft=%d latency=%d", maxTelemetryPercentileSamples, len(stats.tps.samples), len(stats.ttft.samples), len(stats.latency.samples))
	}
	summary := stats.summary()
	if summary.TPSSamples != total || summary.TTFTSamples != total || summary.LatencySamples != total {
		t.Fatalf("exact sample counts lost: %+v", summary)
	}
	wantMean := float64(total+1) / 2
	trendsTestNumber(t, "exact tps mean", summary.TPSMean, wantMean)
}

func TestTrendsQuotaSnapshotCapacityAndApproximateFacts(t *testing.T) {
	start := time.Date(2026, 10, 21, 12, 5, 0, 0, time.UTC) // unaligned to 15m
	observed := start.Add(2 * time.Hour)
	now := start.Add(3 * time.Hour)
	reset := start.Add(5 * time.Hour)
	horizon := start.Add(time.Hour)
	const index = "trends-quota-approx-cap"

	client, baseURL, repo := startDashboardTestServer(t, trendsAuthFilesHandler([]map[string]any{{
		"auth_index": index, "name": "approx-cap.json", "type": "codex", "provider": "codex", "account_type": "oauth",
	}}, nil), func(handler *Handler) { handler.nowFn = func() time.Time { return now } })
	ctx := context.Background()
	var events []usage.Event
	// Events inside partial opening 15m bucket [12:00..12:15) behind retention horizon.
	for i := range 3 {
		e := eventFor(fmt.Sprintf("approx-%d", i), start.Add(time.Duration(2+i)*time.Minute), usage.TokenStats{InputTokens: 100, OutputTokens: 20, TotalTokens: 120}, false)
		e.Provider, e.AuthIndex, e.Model = "codex", index, "gpt-5"
		events = append(events, e)
	}
	// Event before snapshot (at 13:30) and event after snapshot (at 14:30).
	e2 := eventFor("cap-before", start.Add(85*time.Minute), usage.TokenStats{InputTokens: 100, OutputTokens: 20, TotalTokens: 120}, false)
	e2.Provider, e2.AuthIndex, e2.Model = "codex", index, "gpt-5"
	e3 := eventFor("cap-after", observed.Add(30*time.Minute), usage.TokenStats{InputTokens: 200, OutputTokens: 40, TotalTokens: 240}, false)
	e3.Provider, e3.AuthIndex, e3.Model = "codex", index, "gpt-5"
	events = append(events, e2, e3)
	if _, err := repo.InsertUsageEvents(ctx, events); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.AggregateUsageFacts(ctx, 100); err != nil {
		t.Fatal(err)
	}

	period, resetMS, used := 5.0, reset.UnixMilli(), 50.0
	raw, err := json.Marshal([]quota.QuotaWindow{
		{ID: "five_hour", Scope: "standard", PeriodHours: &period, UsedPercent: &used, ResetAtMS: &resetMS, ResetAccuracy: "exact"},
		{ID: "code_review", Scope: "code_review", PeriodHours: &period, UsedPercent: &used, ResetAtMS: &resetMS, ResetAccuracy: "exact"},
	})
	if err != nil {
		t.Fatal(err)
	}
	// Save snapshot before retention removes the opening-bucket events so cycle calibration
	// captures all 4 pre-snapshot requests while post-retention physical storage retains only e2 + e3.
	if err := repo.SaveQuotaSnapshot(ctx, repository.QuotaSnapshotRecord{
		ID: "cap-snap", AuthIndex: index, Provider: "codex", Status: "healthy",
		ObservedAtMS: observed.UnixMilli(), CreatedAtMS: observed.UnixMilli(), WindowsJSON: string(raw),
	}); err != nil {
		t.Fatal(err)
	}
	for range 2 {
		if _, err := repo.RunLifecycle(ctx, map[string]int64{repository.LifecycleUsageDetail: horizon.UnixMilli()}, 10); err != nil {
			t.Fatal(err)
		}
	}

	items := trendsTestRead[TrendsQuotaResponseDTO](t, client, baseURL+"/omc/api/v1/management/trends/quota?auth_index="+index).Items[0].Windows
	win, codeReview := items[0], items[1]
	if !win.IsApproximate {
		t.Fatalf("expected IsApproximate=true when partial 15m fact bucket overlaps cycle start")
	}
	// Reconciled snapshot usage (4) + disjoint post-snapshot request e3 (1) = 5 actual requests,
	// while full_* scaling at 50% scales only snapshot-aligned usage (4 -> FullRequests=8).
	if win.CurrentRequests != 5 || win.Cycles[0].ActualRequests != 5 {
		t.Fatalf("expected reconciled actual requests=5 (4 snapshot + 1 post-snapshot), got current=%d cycle=%+v", win.CurrentRequests, win.Cycles[0])
	}
	if win.Cycles[0].FullRequests == nil || *win.Cycles[0].FullRequests != 8 {
		t.Fatalf("expected FullRequests scaled from snapshot-aligned traffic (8), got %v", win.Cycles[0].FullRequests)
	}
	if codeReview.Capacity != nil || codeReview.Cycles[0].FullRequests != nil {
		t.Fatalf("expected code_review window to omit capacity and cycle full_* estimates, got %+v", codeReview)
	}
	if !codeReview.IsPhysicalUnavailable || codeReview.CurrentRequests != 0 || codeReview.CurrentNetTokens != 0 || codeReview.CurrentTotalTokens != 0 || codeReview.Cycles[0].ActualRequests != 0 || codeReview.UsedPercent != 50 {
		t.Fatalf("expected code_review window to mark physical usage unavailable without attributing generation traffic, got %+v", codeReview)
	}
	for _, bucket := range codeReview.Buckets {
		if bucket.Requests != 0 || bucket.NetTokens != 0 || bucket.TotalTokens != 0 {
			t.Fatalf("expected code_review bucket to carry zero physical counters, got %+v", bucket)
		}
	}
}

func TestTrendsRoutesRequireSessionAndAvoidBoundaryOverlap(t *testing.T) {
	now := time.Date(2026, 10, 21, 12, 30, 0, 0, time.UTC)
	const quotaIndex = "trends-quota-split-fact"
	const boundaryQuota = "trends-quota-cross-horizon"
	const overlapQuota = "trends-quota-overlap-fact"
	client, baseURL, repo := startDashboardTestServer(t, trendsAuthFilesHandler([]map[string]any{
		{"auth_index": quotaIndex, "name": "split-fact.json", "type": "codex", "provider": "codex", "account_type": "oauth"},
		{"auth_index": boundaryQuota, "name": "cross-horizon.json", "type": "codex", "provider": "codex", "account_type": "oauth"},
		{"auth_index": overlapQuota, "name": "overlap-fact.json", "type": "codex", "provider": "codex", "account_type": "oauth"},
	}, nil), func(handler *Handler) { handler.nowFn = func() time.Time { return now } })
	repo.Timezone().Apply(time.UTC)
	ctx := context.Background()

	// Unauthenticated requests to all Trends endpoints must return JSON 401.
	anon := &http.Client{}
	for _, endpoint := range []string{"/omc/api/v1/management/trends/quota", "/omc/api/v1/management/trends/usage", "/omc/api/v1/management/trends/telemetry"} {
		resp, body := getJSON(t, anon, baseURL+endpoint)
		if resp.StatusCode != http.StatusUnauthorized || !strings.Contains(string(body), `"error"`) {
			t.Fatalf("expected JSON 401 on %s, got %d: %s", endpoint, resp.StatusCode, body)
		}
	}

	// 1. Non-15m-aligned retention horizon (12:07) with a folded retained event at 12:10
	// must report fact_requests=1 and retained_requests=1 (never double-counted).
	horizon := time.Date(2026, 10, 21, 12, 7, 0, 0, time.UTC)
	e := eventFor("unaligned-horizon", time.Date(2026, 10, 21, 12, 10, 0, 0, time.UTC), usage.TokenStats{InputTokens: 50, OutputTokens: 50, TotalTokens: 100}, false)
	e.Provider, e.Model, e.LatencyMS, e.Generate = "codex", "gpt-5", 1000, true
	if _, err := repo.InsertUsageEvents(ctx, []usage.Event{e}); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.AggregateUsageFacts(ctx, 100); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.RunLifecycle(ctx, map[string]int64{repository.LifecycleUsageDetail: horizon.UnixMilli()}, 10); err != nil {
		t.Fatal(err)
	}
	telURL := fmt.Sprintf("%s/omc/api/v1/management/trends/telemetry?from=%d&to=%d&bucket=hour", baseURL, time.Date(2026, 10, 21, 11, 0, 0, 0, time.UTC).UnixMilli(), now.UnixMilli()-1)
	tel := trendsTestRead[TrendsTelemetryResponseDTO](t, client, telURL)
	if tel.Coverage.FactRequests != 1 || tel.Coverage.RetainedRequests != 1 {
		t.Fatalf("expected exact coverage 1/1 across unaligned horizon, got %+v", tel.Coverage)
	}

	// 2. Complete 15m historical fact [12:00, 12:15) spanning a 12:07 observation split must be
	// included once in the displayed [12:00, 12:30) cycle while marking capacity approximate.
	cycleStart := time.Date(2026, 10, 21, 12, 0, 0, 0, time.UTC)
	observed := time.Date(2026, 10, 21, 12, 7, 0, 0, time.UTC)
	reset := cycleStart.Add(5 * time.Hour)
	splitEvent := eventFor("split-fact-ev", time.Date(2026, 10, 21, 12, 3, 0, 0, time.UTC), usage.TokenStats{InputTokens: 40, OutputTokens: 20, TotalTokens: 60}, false)
	splitEvent.Provider, splitEvent.AuthIndex, splitEvent.Model = "codex", quotaIndex, "gpt-5"
	if _, err := repo.InsertUsageEvents(ctx, []usage.Event{splitEvent}); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.AggregateUsageFacts(ctx, 100); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.RunLifecycle(ctx, map[string]int64{repository.LifecycleUsageDetail: time.Date(2026, 10, 21, 12, 15, 0, 0, time.UTC).UnixMilli()}, 10); err != nil {
		t.Fatal(err)
	}
	period, resetMS, used := 5.0, reset.UnixMilli(), 25.0
	raw, err := json.Marshal([]quota.QuotaWindow{{ID: "five_hour", Scope: "standard", PeriodHours: &period, UsedPercent: &used, ResetAtMS: &resetMS, ResetAccuracy: "exact"}})
	if err != nil {
		t.Fatal(err)
	}
	if err := repo.SaveQuotaSnapshot(ctx, repository.QuotaSnapshotRecord{
		ID: "split-fact-snap", AuthIndex: quotaIndex, Provider: "codex", Status: "healthy",
		ObservedAtMS: observed.UnixMilli(), CreatedAtMS: observed.UnixMilli(), WindowsJSON: string(raw),
	}); err != nil {
		t.Fatal(err)
	}
	win := trendsTestRead[TrendsQuotaResponseDTO](t, client, baseURL+"/omc/api/v1/management/trends/quota?auth_index="+quotaIndex).Items[0].Windows[0]
	if win.CurrentRequests != 1 || !win.IsApproximate {
		t.Fatalf("expected split complete 15m fact counted once with IsApproximate=true, got current=%d approx=%v", win.CurrentRequests, win.IsApproximate)
	}

	// 3. A retained request starting just before the horizon (12:14) and completing inside
	// a new cycle starting at the published horizon (12:15) must be included once.
	cycleAtHorizon := time.Date(2026, 10, 21, 12, 15, 0, 0, time.UTC)
	preHorizonStart := eventFor("cross-horizon-ev", cycleAtHorizon.Add(-time.Minute), usage.TokenStats{InputTokens: 30, OutputTokens: 15, TotalTokens: 45}, false)
	preHorizonStart.Provider, preHorizonStart.AuthIndex, preHorizonStart.Model = "codex", boundaryQuota, "gpt-5"
	preHorizonStart.LatencyMS = int64((3 * time.Minute) / time.Millisecond) // completes at 12:17
	if _, err := repo.InsertUsageEvents(ctx, []usage.Event{preHorizonStart}); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.AggregateUsageFacts(ctx, 100); err != nil {
		t.Fatal(err)
	}
	crossReset := cycleAtHorizon.Add(5 * time.Hour).UnixMilli()
	crossRaw, _ := json.Marshal([]quota.QuotaWindow{{ID: "five_hour", Scope: "standard", PeriodHours: &period, UsedPercent: &used, ResetAtMS: &crossReset, ResetAccuracy: "exact"}})
	if err := repo.SaveQuotaSnapshot(ctx, repository.QuotaSnapshotRecord{
		ID: "cross-horizon-snap", AuthIndex: boundaryQuota, Provider: "codex", Status: "healthy",
		ObservedAtMS: cycleAtHorizon.Add(10 * time.Minute).UnixMilli(), CreatedAtMS: cycleAtHorizon.Add(10 * time.Minute).UnixMilli(), WindowsJSON: string(crossRaw),
	}); err != nil {
		t.Fatal(err)
	}
	crossWin := trendsTestRead[TrendsQuotaResponseDTO](t, client, baseURL+"/omc/api/v1/management/trends/quota?auth_index="+boundaryQuota).Items[0].Windows[0]
	if crossWin.CurrentRequests != 1 || crossWin.CurrentTotalTokens != 45 {
		t.Fatalf("expected retained request starting before horizon and completing in cycle to count once, got requests=%d tokens=%d", crossWin.CurrentRequests, crossWin.CurrentTotalTokens)
	}

	// 4. A folded request starting inside [12:00, 12:15) behind horizon 12:15 and completing
	// at 12:20 (past horizon) must be counted once via facts without double-counting in retained.
	overlapCycleStart := time.Date(2026, 10, 21, 12, 0, 0, 0, time.UTC)
	overlapEv := eventFor("overlap-fact-ev", time.Date(2026, 10, 21, 12, 5, 0, 0, time.UTC), usage.TokenStats{InputTokens: 40, OutputTokens: 20, TotalTokens: 60}, false)
	overlapEv.Provider, overlapEv.AuthIndex, overlapEv.Model = "codex", overlapQuota, "gpt-5"
	overlapEv.LatencyMS = int64((15 * time.Minute) / time.Millisecond) // completes at 12:20 >= horizon 12:15
	if _, err := repo.InsertUsageEvents(ctx, []usage.Event{overlapEv}); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.AggregateUsageFacts(ctx, 100); err != nil {
		t.Fatal(err)
	}
	overlapReset := overlapCycleStart.Add(5 * time.Hour).UnixMilli()
	overlapRaw, _ := json.Marshal([]quota.QuotaWindow{{ID: "five_hour", Scope: "standard", PeriodHours: &period, UsedPercent: &used, ResetAtMS: &overlapReset, ResetAccuracy: "exact"}})
	if err := repo.SaveQuotaSnapshot(ctx, repository.QuotaSnapshotRecord{
		ID: "overlap-fact-snap", AuthIndex: overlapQuota, Provider: "codex", Status: "healthy",
		ObservedAtMS: overlapCycleStart.Add(25 * time.Minute).UnixMilli(), CreatedAtMS: overlapCycleStart.Add(25 * time.Minute).UnixMilli(), WindowsJSON: string(overlapRaw),
	}); err != nil {
		t.Fatal(err)
	}
	overlapWin := trendsTestRead[TrendsQuotaResponseDTO](t, client, baseURL+"/omc/api/v1/management/trends/quota?auth_index="+overlapQuota).Items[0].Windows[0]
	if overlapWin.CurrentRequests != 1 || overlapWin.CurrentTotalTokens != 60 {
		t.Fatalf("expected folded cross-horizon request counted once (not double-counted), got requests=%d tokens=%d", overlapWin.CurrentRequests, overlapWin.CurrentTotalTokens)
	}
}

func TestTrendsDSTGridStaleHealthAndSubstitutionDrilldown(t *testing.T) {
	// 1. America/Havana spring-forward on 2026-03-08 moves 00:00 -> 01:00;
	// bucketStarts and trendsQuotaGrid must advance strictly monotonically without looping.
	havana, err := time.LoadLocation("America/Havana")
	if err != nil {
		t.Fatalf("load America/Havana: %v", err)
	}
	dstStart := time.Date(2026, 3, 7, 12, 0, 0, 0, havana).UnixMilli()
	dstReset := time.Date(2026, 4, 2, 12, 0, 0, 0, havana).UnixMilli()
	grid := trendsQuotaGrid(dstStart, dstReset, dstStart+3*24*int64(time.Hour/time.Millisecond), havana)
	if len(grid) == 0 || grid[len(grid)-1].EndMS != dstReset {
		t.Fatalf("expected DST quota grid to terminate cleanly at reset, len=%d", len(grid))
	}
	for i := 1; i < len(grid); i++ {
		if grid[i].StartMS <= grid[i-1].StartMS || grid[i].EndMS <= grid[i].StartMS {
			t.Fatalf("non-monotonic DST grid bucket at %d: prev=%+v cur=%+v", i, grid[i-1], grid[i])
		}
	}
	dayStarts := insightsBucketDay.bucketStarts(dstStart, dstReset, havana)
	if len(dayStarts) < 20 {
		t.Fatalf("expected ~26 Havana day starts across DST spring-forward, got %d", len(dayStarts))
	}

	// 2. Stale/failed quota attempt or expired window suppresses forecasts and excludes credential from risk summary.
	now := time.Date(2026, 10, 21, 14, 0, 0, 0, time.UTC)
	const staleIndex = "trends-stale-cred"
	client, baseURL, repo := startDashboardTestServer(t, trendsAuthFilesHandler([]map[string]any{{
		"auth_index": staleIndex, "name": "stale-cred.json", "type": "codex", "provider": "codex", "account_type": "oauth",
	}}, nil), func(handler *Handler) { handler.nowFn = func() time.Time { return now } })
	repo.Timezone().Apply(time.UTC)
	ctx := context.Background()
	snapAt := now.Add(-15 * time.Minute)
	resetAt := now.Add(3 * time.Hour)
	period, resetMS, used1, used2 := 5.0, resetAt.UnixMilli(), 30.0, 55.0
	raw1, _ := json.Marshal([]quota.QuotaWindow{{ID: "five_hour", Scope: "standard", PeriodHours: &period, UsedPercent: &used1, ResetAtMS: &resetMS, ResetAccuracy: "exact"}})
	raw2, _ := json.Marshal([]quota.QuotaWindow{{ID: "five_hour", Scope: "standard", PeriodHours: &period, UsedPercent: &used2, ResetAtMS: &resetMS, ResetAccuracy: "exact"}})
	if err := repo.SaveQuotaSnapshot(ctx, repository.QuotaSnapshotRecord{
		ID: "stale-snap-1", AuthIndex: staleIndex, Provider: "codex", Status: "healthy",
		ObservedAtMS: snapAt.Add(-20 * time.Minute).UnixMilli(), CreatedAtMS: snapAt.Add(-20 * time.Minute).UnixMilli(), WindowsJSON: string(raw1),
	}); err != nil {
		t.Fatal(err)
	}
	if err := repo.SaveQuotaSnapshot(ctx, repository.QuotaSnapshotRecord{
		ID: "stale-snap-2", AuthIndex: staleIndex, Provider: "codex", Status: "healthy",
		ObservedAtMS: snapAt.UnixMilli(), CreatedAtMS: snapAt.UnixMilli(), WindowsJSON: string(raw2),
	}); err != nil {
		t.Fatal(err)
	}
	// Record a newer failed refresh attempt (error) so reading health becomes stale/error.
	if err := repo.SaveQuotaRefreshAttempt(ctx, repository.QuotaRefreshAttemptRecord{
		AuthIndex: staleIndex, Outcome: repository.QuotaRefreshAttemptFailed, Error: "refresh failed", AttemptedAtMS: now.Add(-2 * time.Minute).UnixMilli(),
	}); err != nil {
		t.Fatal(err)
	}
	staleResp := trendsTestRead[TrendsQuotaResponseDTO](t, client, baseURL+"/omc/api/v1/management/trends/quota?auth_index="+staleIndex)
	if len(staleResp.Items) != 1 || staleResp.Items[0].Status != "stale" {
		t.Fatalf("expected credential status stale after failed attempt, got %+v", staleResp.Items)
	}
	if staleResp.Summary.ProjectedExhaustWindows != 0 || staleResp.Summary.HealthyWindows != 0 {
		t.Fatalf("expected stale credential excluded from summary risk counts, got %+v", staleResp.Summary)
	}
	staleWin := staleResp.Items[0].Windows[0]
	if staleWin.ProjectedExhaustAtMS != nil || staleWin.BurnRatePerHour != nil || staleWin.CapacityUnavailable != quota.CapacityReasonNoReading {
		t.Fatalf("expected stale credential to suppress forecast and report no_reading, got %+v", staleWin)
	}
	for _, b := range staleWin.Buckets {
		if b.IsForecast {
			t.Fatalf("stale credential must not emit forecast buckets: %+v", b)
		}
	}

	// 3. Substitution pair drill-down + response_model filtering + redacted pair resolution.
	reqModel := "custom-req@example.com-sk-ant-api03-1234567890abcdef1234567890abcdef"
	subEvent1 := eventFor("sub-b", now.Add(-10*time.Minute), usage.TokenStats{InputTokens: 10, OutputTokens: 20, TotalTokens: 30}, false)
	subEvent1.Provider, subEvent1.Model, subEvent1.ResponseModel, subEvent1.ModelSubstituted = "codex", "gpt-5", "gpt-5-mini", true
	subEvent2 := eventFor("sub-c", now.Add(-9*time.Minute), usage.TokenStats{InputTokens: 10, OutputTokens: 20, TotalTokens: 30}, false)
	subEvent2.Provider, subEvent2.Model, subEvent2.ResponseModel, subEvent2.ModelSubstituted = "codex", "gpt-5", "gpt-5-nano", true
	subEvent3 := eventFor("sub-redacted", now.Add(-8*time.Minute), usage.TokenStats{InputTokens: 10, OutputTokens: 20, TotalTokens: 30}, false)
	subEvent3.Provider, subEvent3.Model, subEvent3.ResponseModel, subEvent3.ModelSubstituted = "codex", reqModel, "gpt-5-mini", true
	subEvent4 := eventFor("sub-redacted-nano", now.Add(-7*time.Minute), usage.TokenStats{InputTokens: 10, OutputTokens: 20, TotalTokens: 30}, false)
	subEvent4.Provider, subEvent4.Model, subEvent4.ResponseModel, subEvent4.ModelSubstituted = "codex", reqModel, "gpt-5-nano", true
	if _, err := repo.InsertUsageEvents(ctx, []usage.Event{subEvent1, subEvent2, subEvent3, subEvent4}); err != nil {
		t.Fatal(err)
	}

	telURL := fmt.Sprintf("%s/omc/api/v1/management/trends/telemetry?from=%d&to=%d&bucket=hour", baseURL, now.Add(-time.Hour).UnixMilli(), now.UnixMilli()-1)
	tel := trendsTestRead[TrendsTelemetryResponseDTO](t, client, telURL)
	if len(tel.SubstitutionPairs) != 4 {
		t.Fatalf("expected 4 substitution pairs, got %+v", tel.SubstitutionPairs)
	}
	var redactedPair *TrendsSubstitutionPairDTO
	for i := range tel.SubstitutionPairs {
		if strings.HasPrefix(tel.SubstitutionPairs[i].RequestedID, repository.TrendsRedactedPrefix) {
			redactedPair = &tel.SubstitutionPairs[i]
		}
	}
	if redactedPair == nil || redactedPair.DrillDisabled {
		t.Fatalf("expected redacted substitution pair with opaque RequestedID and enabled drilldown, got %+v", redactedPair)
	}

	// Filtering /usage/events by response_model isolates gpt-5-mini from gpt-5-nano, and opaque requested_id resolves.
	eventsURL := fmt.Sprintf("%s/omc/api/v1/usage/events?from=%d&to=%d&served=substituted&model=%s&response_model=%s",
		baseURL, now.Add(-time.Hour).UnixMilli(), now.UnixMilli()-1,
		url.QueryEscape(redactedPair.RequestedID), url.QueryEscape("gpt-5-mini"))
	var eventsResp struct {
		Items []struct {
			RequestID     string `json:"request_id"`
			ResponseModel string `json:"response_model"`
		} `json:"items"`
	}
	resp, rawBody := getJSON(t, client, eventsURL)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("GET %s failed: %d %s", eventsURL, resp.StatusCode, rawBody)
	}
	if err := json.Unmarshal(rawBody, &eventsResp); err != nil {
		t.Fatal(err)
	}
	if len(eventsResp.Items) != 1 || eventsResp.Items[0].RequestID != "sub-redacted" || eventsResp.Items[0].ResponseModel != "gpt-5-mini" {
		t.Fatalf("expected opaque model + response_model filter to isolate sub-redacted/gpt-5-mini, got %+v", eventsResp.Items)
	}

	// 4. Opaque redacted model filter in a window with only a different model returns 0 rows, never unfiltered.
	emptyOpaqueUsage := trendsTestRead[TrendsUsageResponseDTO](t, client,
		fmt.Sprintf("%s/omc/api/v1/management/trends/usage?from=%d&to=%d&bucket=hour&model=%s",
			baseURL, now.Add(-12*time.Minute).UnixMilli(), now.Add(-9*time.Minute).UnixMilli(), url.QueryEscape(redactedPair.RequestedID)))
	if emptyOpaqueUsage.Totals.Requests != 0 {
		t.Fatalf("expected unresolved opaque model filter in non-matching window to return 0 requests, got %d", emptyOpaqueUsage.Totals.Requests)
	}

	// 5. End-to-end America/Havana DST spring-forward: noon 2026-03-08 event maps to 2026-03-08 01:00 CDT
	// daily bucket on both /trends/usage and /trends/telemetry.
	havanaNow := time.Date(2026, 3, 9, 23, 0, 0, 0, havana)
	havanaClient, havanaURL, havanaRepo := startDashboardTestServer(t, nil, func(handler *Handler) { handler.nowFn = func() time.Time { return havanaNow } })
	havanaRepo.Timezone().Apply(havana)
	havanaNoon := time.Date(2026, 3, 8, 12, 0, 0, 0, havana)
	havanaEv := eventFor("havana-dst-noon", havanaNoon, usage.TokenStats{InputTokens: 15, OutputTokens: 25, TotalTokens: 40}, false)
	havanaEv.Provider, havanaEv.Model, havanaEv.LatencyMS, havanaEv.Generate = "codex", "gpt-5", 200, true
	if _, err := havanaRepo.InsertUsageEvents(ctx, []usage.Event{havanaEv}); err != nil {
		t.Fatal(err)
	}
	wantBucketStart := time.Date(2026, 3, 8, 1, 0, 0, 0, havana).UnixMilli()
	hFrom := time.Date(2026, 3, 7, 0, 0, 0, 0, havana).UnixMilli()
	hTo := time.Date(2026, 3, 9, 23, 59, 59, 0, havana).UnixMilli()
	hUsage := trendsTestRead[TrendsUsageResponseDTO](t, havanaClient, fmt.Sprintf("%s/omc/api/v1/management/trends/usage?from=%d&to=%d&bucket=day", havanaURL, hFrom, hTo))
	hTel := trendsTestRead[TrendsTelemetryResponseDTO](t, havanaClient, fmt.Sprintf("%s/omc/api/v1/management/trends/telemetry?from=%d&to=%d&bucket=day", havanaURL, hFrom, hTo))
	var usageDayCount, telDayCount int64
	for _, b := range hUsage.Buckets {
		if b.StartMS == wantBucketStart {
			usageDayCount = b.Requests
		}
	}
	for _, b := range hTel.Buckets {
		if b.StartMS == wantBucketStart {
			telDayCount = b.TotalRequests
		}
	}
	if hUsage.Totals.Requests != 1 || usageDayCount != 1 || hTel.Summary.TotalRequests != 1 || telDayCount != 1 {
		t.Fatalf("expected Havana noon March 8 event in 01:00 CDT daily bucket on both endpoints, usage=(%d,%d) tel=(%d,%d)",
			hUsage.Totals.Requests, usageDayCount, hTel.Summary.TotalRequests, telDayCount)
	}
}

func TestTrendsKeylessEndpointProjectionCipherlessGuardAndLiteralEventFilters(t *testing.T) {
	now := time.Date(2026, 10, 21, 15, 0, 0, 0, time.UTC)
	client, baseURL, repo := startDashboardTestServer(t, nil, func(handler *Handler) { handler.nowFn = func() time.Time { return now } })
	repo.Timezone().Apply(time.UTC)
	ctx := context.Background()

	endpointURL := "https://internal-relay.corp/v1/chat/completions"
	e1 := eventFor("keyless-endpoint", now.Add(-15*time.Minute), usage.TokenStats{InputTokens: 40, OutputTokens: 20, TotalTokens: 60}, false)
	e1.APIGroupKey, e1.APIGroupLabel, e1.Model = endpointURL, "endpoint", "gpt-5"
	e2 := eventFor("other-model-key", now.Add(-10*time.Minute), usage.TokenStats{InputTokens: 30, OutputTokens: 15, TotalTokens: 45}, false)
	e2.APIGroupKey, e2.APIGroupLabel, e2.Model = "codex", "provider", "gpt-4.1"
	if _, err := repo.InsertUsageEvents(ctx, []usage.Event{e1, e2}); err != nil {
		t.Fatal(err)
	}

	from := now.Add(-time.Hour).UnixMilli()
	to := now.UnixMilli() - 1
	usageResp := trendsTestRead[TrendsUsageResponseDTO](t, client, fmt.Sprintf("%s/omc/api/v1/management/trends/usage?from=%d&to=%d&bucket=hour&group_by=key", baseURL, from, to))
	var endpointGroup *TrendsUsageGroupOptionDTO
	for i := range usageResp.Groups {
		if usageResp.Groups[i].Label == "endpoint" {
			endpointGroup = &usageResp.Groups[i]
		}
		if strings.Contains(usageResp.Groups[i].ID, "internal-relay.corp") || strings.Contains(usageResp.Groups[i].Label, "internal-relay.corp") {
			t.Fatalf("group_by=key leaked raw endpoint URL: %+v", usageResp.Groups[i])
		}
	}
	if endpointGroup == nil || !strings.HasPrefix(endpointGroup.ID, repository.TrendsRedactedPrefix) || endpointGroup.FilterDisabled {
		t.Fatalf("expected opaque endpoint group with neutral label, got %+v", usageResp.Groups)
	}

	// Filtering by the opaque endpoint ID works on both /trends/usage and /v1/usage/events.
	filteredUsage := trendsTestRead[TrendsUsageResponseDTO](t, client,
		fmt.Sprintf("%s/omc/api/v1/management/trends/usage?from=%d&to=%d&bucket=hour&api_key=%s", baseURL, from, to, url.QueryEscape(endpointGroup.ID)))
	if filteredUsage.Totals.Requests != 1 {
		t.Fatalf("expected opaque endpoint api_key filter on /trends/usage to match 1 request, got %d", filteredUsage.Totals.Requests)
	}
	var evResp struct {
		Items []struct {
			RequestID string `json:"request_id"`
			Model     string `json:"model"`
		} `json:"items"`
	}
	for _, tc := range []struct {
		query string
		want  []string
	}{
		{"api_key=" + url.QueryEscape(endpointGroup.ID), []string{"keyless-endpoint"}},
		{"model=gpt-5", []string{"keyless-endpoint"}},
		{"model=nonexistent-model", nil},
	} {
		resp, body := getJSON(t, client, fmt.Sprintf("%s/omc/api/v1/usage/events?from=%d&to=%d&%s", baseURL, from, to, tc.query))
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("GET /usage/events?%s status=%d: %s", tc.query, resp.StatusCode, body)
		}
		evResp.Items = nil
		if err := json.Unmarshal(body, &evResp); err != nil {
			t.Fatal(err)
		}
		if len(evResp.Items) != len(tc.want) {
			t.Fatalf("query %q: got %+v, want %v", tc.query, evResp.Items, tc.want)
		}
		for i, wantID := range tc.want {
			if evResp.Items[i].RequestID != wantID {
				t.Fatalf("query %q item %d: got %q, want %q", tc.query, i, evResp.Items[i].RequestID, wantID)
			}
		}
	}

	// Without a fingerprinter, masked labels never fall back to raw values and mark filter_disabled.
	cipherless := &Handler{}
	masked := cipherless.trendsGroupProjection(repository.UsageDimensionModel, "custom-alice@example.com-sk-ant-api03-1234567890abcdef1234567890abcdef")
	if strings.Contains(masked.ID, "alice@example.com") || strings.Contains(masked.ID, "sk-ant-api03") || !masked.FilterDisabled {
		t.Fatalf("expected masked model without raw fallback and FilterDisabled=true, got %+v", masked)
	}
	endpointNoCipher := cipherless.trendsGroupProjection(repository.UsageDimensionKey, endpointURL)
	if endpointNoCipher.ID != "endpoint" || endpointNoCipher.Label != "endpoint" || !endpointNoCipher.FilterDisabled {
		t.Fatalf("expected neutral endpoint projection with FilterDisabled=true when cipher is nil, got %+v", endpointNoCipher)
	}
}

func TestTrendsCodeRabbitRegressionInvariants(t *testing.T) {
	now := time.Date(2026, 10, 21, 15, 0, 0, 0, time.UTC)
	var currentNow atomic.Int64
	currentNow.Store(now.UnixMilli())
	var cpaOffline atomic.Bool
	const authIdx = "quota-late-auth"
	client, baseURL, repo := startDashboardTestServer(t, func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/v8/management/credentials" {
			http.NotFound(writer, request)
			return
		}
		if cpaOffline.Load() {
			writer.WriteHeader(http.StatusBadGateway)
			return
		}
		writer.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(writer).Encode(map[string]any{
			"files": []map[string]any{
				{"auth_index": authIdx, "name": "late.json", "type": "codex", "provider": "codex", "account_type": "oauth"},
				{"auth_index": "quota-late-cycle-auth", "name": "late-cycle.json", "type": "codex", "provider": "codex", "account_type": "oauth"},
			},
		})
	}, func(handler *Handler) {
		handler.nowFn = func() time.Time { return time.UnixMilli(currentNow.Load()).UTC() }
	})
	repo.Timezone().Apply(time.UTC)
	ctx := context.Background()

	// 1. Offline empty authIndexes reports IsMembershipUnknown=true.
	cpaOffline.Store(true)
	offlineEmpty := trendsTestRead[TrendsQuotaResponseDTO](t, client, baseURL+"/omc/api/v1/management/trends/quota")
	if !offlineEmpty.Summary.IsMembershipUnknown {
		t.Fatalf("expected IsMembershipUnknown=true when CPA is offline with empty snapshots, got %+v", offlineEmpty.Summary)
	}
	cpaOffline.Store(false)

	// 2. Unaligned equal-duration comparison keeps full prior range without dropping buckets.
	// Current: [12:05, 12:34:59.999] (1 hour bucket: 12:00). Prior: [11:35, 12:04:59.999] (2 hour buckets: 11:00, 12:00).
	curFrom := time.Date(2026, 10, 21, 12, 5, 0, 0, time.UTC)
	curTo := time.Date(2026, 10, 21, 12, 34, 59, 999_000_000, time.UTC)
	evPriorEarly := eventFor("cmp-early", time.Date(2026, 10, 21, 11, 40, 0, 0, time.UTC), usage.TokenStats{InputTokens: 30, TotalTokens: 30}, false)
	evPriorLate := eventFor("cmp-late", time.Date(2026, 10, 21, 12, 2, 0, 0, time.UTC), usage.TokenStats{InputTokens: 70, TotalTokens: 70}, false)
	evCur := eventFor("cmp-cur", time.Date(2026, 10, 21, 12, 10, 0, 0, time.UTC), usage.TokenStats{InputTokens: 50, TotalTokens: 50}, false)
	// Caller key literally prefixed with "redacted:" must still match via hmac fingerprint.
	fpRedacted, err := repo.UsageClientKeyFingerprint("redacted:tenant-key")
	if err != nil {
		t.Fatal(err)
	}
	// URL-shaped model & provider must not leak hostnames/paths into telemetry groups/scatter/substitutions.
	urlModel := "https://secret.upstream.internal/v1/custom-model"
	urlProvider := "https://proxy.upstream.internal/gateway"
	evURL := eventFor("url-telemetry", time.Date(2026, 10, 21, 12, 15, 0, 0, time.UTC), usage.TokenStats{InputTokens: 20, OutputTokens: 10, TotalTokens: 30}, false)
	evURL.Model, evURL.ResponseModel, evURL.Provider, evURL.ModelSubstituted, evURL.Generate, evURL.LatencyMS = urlModel, "gpt-5-served", urlProvider, true, true, 120
	for _, ev := range []*usage.Event{&evPriorEarly, &evPriorLate, &evCur} {
		ev.Provider, ev.Model, ev.AuthIndex, ev.APIGroupKey = "codex", "gpt-5", authIdx, fpRedacted
	}
	if _, err := repo.InsertUsageEvents(ctx, []usage.Event{evPriorEarly, evPriorLate, evCur, evURL}); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.AggregateUsageFacts(ctx, 100); err != nil {
		t.Fatal(err)
	}

	unalignedUsage := trendsTestRead[TrendsUsageResponseDTO](t, client,
		fmt.Sprintf("%s/omc/api/v1/management/trends/usage?from=%d&to=%d&bucket=hour&model=gpt-5&api_key=%s",
			baseURL, curFrom.UnixMilli(), curTo.UnixMilli(), url.QueryEscape("redacted:tenant-key")))
	if unalignedUsage.Totals.NetTokens != 50 || unalignedUsage.CompareTotals == nil || unalignedUsage.CompareTotals.NetTokens != 100 {
		t.Fatalf("unexpected totals/compare_totals for literal redacted: key + unaligned window: totals=%+v compare=%+v", unalignedUsage.Totals, unalignedUsage.CompareTotals)
	}
	if len(unalignedUsage.Buckets) != 1 || unalignedUsage.Buckets[0].CompareCumNetTokens == nil || *unalignedUsage.Buckets[0].CompareCumNetTokens != 100 {
		t.Fatalf("expected unaligned equal-duration comparison overlay to retain full prior 100 tokens, got %+v", unalignedUsage.Buckets)
	}
	multiCurTo := time.Date(2026, 10, 21, 14, 34, 59, 999_000_000, time.UTC) // [12:05, 14:35) -> 3 buckets vs [09:35, 12:05) -> 4 buckets
	multiUsage := trendsTestRead[TrendsUsageResponseDTO](t, client,
		fmt.Sprintf("%s/omc/api/v1/management/trends/usage?from=%d&to=%d&bucket=hour&model=gpt-5&api_key=%s",
			baseURL, curFrom.UnixMilli(), multiCurTo.UnixMilli(), url.QueryEscape("redacted:tenant-key")))
	if len(multiUsage.Buckets) != 3 || multiUsage.CompareTotals == nil || multiUsage.CompareTotals.NetTokens != 100 ||
		multiUsage.Buckets[0].CompareNetTokens == nil || *multiUsage.Buckets[0].CompareNetTokens != 0 ||
		multiUsage.Buckets[1].CompareNetTokens == nil || *multiUsage.Buckets[1].CompareNetTokens != 30 ||
		multiUsage.Buckets[2].CompareNetTokens == nil || *multiUsage.Buckets[2].CompareNetTokens != 70 ||
		multiUsage.Buckets[2].CompareCumNetTokens == nil || *multiUsage.Buckets[2].CompareCumNetTokens != 100 {
		t.Fatalf("expected multi-bucket unaligned overlay to place 0/30/70 across buckets and accumulate 100 by end, totals=%+v buckets=%+v", multiUsage.CompareTotals, multiUsage.Buckets)
	}

	// 3. URL-shaped model/provider values emit neutral "endpoint" labels across telemetry responses.
	telProbeResp := trendsTestRead[TrendsTelemetryResponseDTO](t, client,
		fmt.Sprintf("%s/omc/api/v1/management/trends/telemetry?from=%d&to=%d&bucket=hour", baseURL, curFrom.UnixMilli(), curTo.UnixMilli()))
	var telProbeID string
	for _, g := range telProbeResp.Groups {
		if g.Label == "endpoint" {
			telProbeID = g.ID
		}
		if strings.Contains(g.Label, "secret.upstream.internal") || strings.Contains(g.ID, "secret.upstream.internal") {
			t.Fatalf("leaked URL-shaped model in telemetry groups: %+v", g)
		}
	}
	if !strings.HasPrefix(telProbeID, repository.TrendsRedactedPrefix) {
		t.Fatalf("expected opaque redacted ID for URL-shaped model in telemetry groups, got %+v", telProbeResp.Groups)
	}
	telURLResp := trendsTestRead[TrendsTelemetryResponseDTO](t, client,
		fmt.Sprintf("%s/omc/api/v1/management/trends/telemetry?from=%d&to=%d&bucket=hour&model=%s",
			baseURL, curFrom.UnixMilli(), curTo.UnixMilli(), url.QueryEscape(telProbeID)))
	if telURLResp.Summary.TotalRequests != 1 || len(telURLResp.Groups) != 1 || telURLResp.Groups[0].Label != "endpoint" ||
		len(telURLResp.Scatter) != 1 || telURLResp.Scatter[0].Model != "endpoint" || telURLResp.Scatter[0].Provider != "endpoint" ||
		len(telURLResp.SubstitutionPairs) != 1 || telURLResp.SubstitutionPairs[0].RequestedModel != "endpoint" || telURLResp.SubstitutionPairs[0].Provider != "endpoint" {
		t.Fatalf("expected neutral endpoint labels across telemetry groups, scatter, and substitutions, got %+v", telURLResp)
	}

	// 4. Quota cycles count >15m latency requests by completion time and do not double-count across adjacent cycles
	// when a pre-horizon row still exists in usage_events during two-phase retention.
	const authIdxQuota = "quota-late-cycle-auth"
	cycle1Reset := time.Date(2026, 10, 21, 12, 30, 0, 0, time.UTC)
	cycle2Reset := time.Date(2026, 10, 21, 16, 30, 0, 0, time.UTC)
	longReq := eventFor("long-latency-req", time.Date(2026, 10, 21, 12, 0, 0, 0, time.UTC), usage.TokenStats{InputTokens: 40, OutputTokens: 10, TotalTokens: 50}, false)
	longReq.Provider = "codex"
	longReq.Model = "gpt-5"
	longReq.AuthIndex = authIdxQuota
	longReq.LatencyMS = int64(45 * time.Minute / time.Millisecond) // completes 12:45 (inside cycle 2 [12:30, 16:30))
	longInCycle1 := eventFor("long-cycle1-req", time.Date(2026, 10, 21, 8, 10, 0, 0, time.UTC), usage.TokenStats{InputTokens: 20, OutputTokens: 10, TotalTokens: 30}, false)
	longInCycle1.Provider = "codex"
	longInCycle1.Model = "gpt-5"
	longInCycle1.AuthIndex = authIdxQuota
	longInCycle1.LatencyMS = int64(25 * time.Minute / time.Millisecond) // starts 08:10 (<08:30 - 15m!), completes 08:35 (inside cycle 1 [08:30, 12:30))
	if _, err := repo.InsertUsageEvents(ctx, []usage.Event{longReq, longInCycle1}); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.AggregateUsageFacts(ctx, 100); err != nil {
		t.Fatal(err)
	}
	// Publish lifecycle horizon at 12:15 while longReq (started 12:00, completed 12:45) still remains in usage_events.
	if _, err := repo.RunLifecycle(ctx, map[string]int64{repository.LifecycleUsageDetail: time.Date(2026, 10, 21, 12, 15, 0, 0, time.UTC).UnixMilli()}, 10); err != nil {
		t.Fatal(err)
	}
	saveQuotaAt := func(at, reset time.Time, used float64) {
		periodH := 4.0
		raw, _ := json.Marshal([]quota.QuotaWindow{{ID: "custom_4h", Scope: "standard", Kind: "custom", PeriodHours: &periodH, UsedPercent: &used, ResetAtMS: func() *int64 { ms := reset.UnixMilli(); return &ms }(), ResetAccuracy: "exact"}})
		if err := repo.SaveQuotaSnapshot(ctx, repository.QuotaSnapshotRecord{
			ID: fmt.Sprintf("late-snap-%d", at.UnixMilli()), AuthIndex: authIdxQuota, Provider: "codex", Status: "healthy",
			ObservedAtMS: at.UnixMilli(), CreatedAtMS: at.UnixMilli(), WindowsJSON: string(raw),
		}); err != nil {
			t.Fatal(err)
		}
	}
	saveQuotaAt(time.Date(2026, 10, 21, 12, 20, 0, 0, time.UTC), cycle1Reset, 40)
	saveQuotaAt(now, cycle2Reset, 25)

	quotaResp := trendsTestRead[TrendsQuotaResponseDTO](t, client, baseURL+"/omc/api/v1/management/trends/quota?auth_index="+authIdxQuota)
	if len(quotaResp.Items) != 1 || len(quotaResp.Items[0].Windows) != 1 {
		t.Fatalf("unexpected quota response: %+v", quotaResp)
	}
	cycles := quotaResp.Items[0].Windows[0].Cycles
	if len(cycles) != 2 {
		t.Fatalf("expected 2 cycles (current + prior), got %+v", cycles)
	}
	var priorCycle, curCycle TrendsQuotaCycleHistoryDTO
	for _, c := range cycles {
		if c.IsCurrent {
			curCycle = c
		} else {
			priorCycle = c
		}
	}
	// Cycle 1 [08:30, 12:30): only longInCycle1 (30 tokens, started 08:10, completed 08:35).
	if priorCycle.ActualRequests != 1 || priorCycle.ActualTotalTokens != 30 {
		t.Fatalf("expected prior cycle to count only longInCycle1 (1 req, 30 tokens) without longReq, got %+v", priorCycle)
	}
	// Cycle 2 [12:30, 16:30): only longReq (1 req, 50 tokens, started 12:00, completed 12:45).
	if curCycle.ActualRequests != 1 || curCycle.ActualTotalTokens != 50 {
		t.Fatalf("expected current cycle to count longReq once (1 req, 50 tokens), got %+v", curCycle)
	}

	// 5. Keyless URL-shaped (including hmac://...) and email-shaped provider labels stay masked/neutral and filterable.
	keyWinFrom := time.Date(2026, 10, 20, 9, 0, 0, 0, time.UTC)
	keyWinTo := time.Date(2026, 10, 20, 11, 0, 0, 0, time.UTC)
	evKeyURL := eventFor("keyless-hmac-url", time.Date(2026, 10, 20, 10, 0, 0, 0, time.UTC), usage.TokenStats{InputTokens: 11, TotalTokens: 11}, false)
	evKeyURL.Provider, evKeyURL.Model, evKeyURL.APIGroupKey, evKeyURL.APIGroupLabel = "hmac://relay.internal/v1", "gpt-5", "hmac://relay.internal/v1", "provider"
	evKeyEmail := eventFor("keyless-email", time.Date(2026, 10, 20, 10, 5, 0, 0, time.UTC), usage.TokenStats{InputTokens: 22, TotalTokens: 22}, false)
	evKeyEmail.Provider, evKeyEmail.Model, evKeyEmail.APIGroupKey, evKeyEmail.APIGroupLabel = "alice@example.com", "gpt-5", "alice@example.com", "provider"
	if _, err := repo.InsertUsageEvents(ctx, []usage.Event{evKeyURL, evKeyEmail}); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.AggregateUsageFacts(ctx, 100); err != nil {
		t.Fatal(err)
	}
	keyGroupsResp := trendsTestRead[TrendsUsageResponseDTO](t, client,
		fmt.Sprintf("%s/omc/api/v1/management/trends/usage?from=%d&to=%d&bucket=hour&group_by=key",
			baseURL, keyWinFrom.UnixMilli(), keyWinTo.UnixMilli()))
	var hmacURLID, emailKeyID string
	for _, g := range keyGroupsResp.Groups {
		if strings.Contains(g.ID, "relay.internal") || strings.Contains(g.Label, "relay.internal") ||
			strings.Contains(g.ID, "alice@example.com") || strings.Contains(g.Label, "alice@example.com") {
			t.Fatalf("leaked keyless label in group_by=key groups: %+v", g)
		}
		if g.Label == "endpoint" {
			hmacURLID = g.ID
		} else if g.Label == "al•••e@example.com" {
			emailKeyID = g.ID
		}
	}
	if !strings.HasPrefix(hmacURLID, repository.TrendsRedactedPrefix) || !strings.HasPrefix(emailKeyID, repository.TrendsRedactedPrefix) {
		t.Fatalf("expected opaque redacted IDs for URL/email keyless labels, got %+v", keyGroupsResp.Groups)
	}
	byURL := trendsTestRead[TrendsUsageResponseDTO](t, client,
		fmt.Sprintf("%s/omc/api/v1/management/trends/usage?from=%d&to=%d&bucket=hour&api_key=%s",
			baseURL, keyWinFrom.UnixMilli(), keyWinTo.UnixMilli(), url.QueryEscape(hmacURLID)))
	if byURL.Totals.NetTokens != 11 {
		t.Fatalf("expected filtered hmac:// keyless group to yield 11 net tokens, got %+v", byURL.Totals)
	}
	byEmail := trendsTestRead[TrendsUsageResponseDTO](t, client,
		fmt.Sprintf("%s/omc/api/v1/management/trends/usage?from=%d&to=%d&bucket=hour&api_key=%s",
			baseURL, keyWinFrom.UnixMilli(), keyWinTo.UnixMilli(), url.QueryEscape(emailKeyID)))
	if byEmail.Totals.NetTokens != 22 {
		t.Fatalf("expected filtered email keyless group to yield 22 net tokens, got %+v", byEmail.Totals)
	}

	// 6. Closed calendar presets (e.g. last_month: Feb 28d vs Jan 31d) pair by day position without folding extra days.
	var janEvents []usage.Event
	for day := 28; day <= 31; day++ {
		ev := eventFor(fmt.Sprintf("jan-%d", day), time.Date(2026, 1, day, 12, 0, 0, 0, time.UTC), usage.TokenStats{InputTokens: 10, TotalTokens: 10}, false)
		ev.Provider, ev.Model = "codex", "gpt-5"
		janEvents = append(janEvents, ev)
	}
	evFeb := eventFor("feb-28", time.Date(2026, 2, 28, 12, 0, 0, 0, time.UTC), usage.TokenStats{InputTokens: 5, TotalTokens: 5}, false)
	evFeb.Provider, evFeb.Model = "codex", "gpt-5"
	if _, err := repo.InsertUsageEvents(ctx, append(janEvents, evFeb)); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.AggregateUsageFacts(ctx, 100); err != nil {
		t.Fatal(err)
	}
	currentNow.Store(time.Date(2026, 3, 15, 12, 0, 0, 0, time.UTC).UnixMilli())
	lastMonth := trendsTestRead[TrendsUsageResponseDTO](t, client, baseURL+"/omc/api/v1/management/trends/usage?preset=last_month&bucket=day")
	currentNow.Store(now.UnixMilli())
	if len(lastMonth.Buckets) != 28 || lastMonth.Totals.NetTokens != 5 || lastMonth.CompareTotals == nil || lastMonth.CompareTotals.NetTokens != 40 ||
		lastMonth.Buckets[27].CompareNetTokens == nil || *lastMonth.Buckets[27].CompareNetTokens != 10 {
		t.Fatalf("expected last_month day 28 to pair with Jan 28 (10) while compare_totals keeps all 40, totals=%+v compare=%+v lastBucket=%+v",
			lastMonth.Totals, lastMonth.CompareTotals, lastMonth.Buckets[len(lastMonth.Buckets)-1])
	}

	// 7. Zero-token requests in ReadQuotaTrendPhysical count identically before and after retention deletes their detail row.
	const authZero = "quota-zero-token-auth"
	evZero := eventFor("zero-tok-phys", time.Date(2026, 10, 19, 10, 5, 0, 0, time.UTC), usage.TokenStats{}, false)
	evZero.Provider, evZero.Model, evZero.AuthIndex = "codex", "gpt-5", authZero
	evPriced := eventFor("priced-tok-phys", time.Date(2026, 10, 19, 10, 10, 0, 0, time.UTC), usage.TokenStats{InputTokens: 15, TotalTokens: 15}, false)
	evPriced.Provider, evPriced.Model, evPriced.AuthIndex = "codex", "gpt-5", authZero
	if _, err := repo.InsertUsageEvents(ctx, []usage.Event{evZero, evPriced}); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.AggregateUsageFacts(ctx, 100); err != nil {
		t.Fatal(err)
	}
	physFrom := time.Date(2026, 10, 19, 10, 0, 0, 0, time.UTC).UnixMilli()
	physTo := time.Date(2026, 10, 19, 11, 0, 0, 0, time.UTC).UnixMilli()
	sumPhysical := func() (reqs, tokens int64) {
		_, facts, retained, err := repo.ReadQuotaTrendPhysical(ctx, defaultInstanceID(), authZero, physFrom, physTo)
		if err != nil {
			t.Fatal(err)
		}
		for _, row := range facts.Rows {
			reqs += row.Requests
			tokens += row.TotalTokens
		}
		for _, entry := range retained {
			reqs += entry.Measures.Requests
			tokens += entry.Measures.TotalTokens
		}
		return reqs, tokens
	}
	beforeReqs, beforeToks := sumPhysical()
	if beforeReqs != 2 || beforeToks != 15 {
		t.Fatalf("before retention: got (%d reqs, %d tokens), want (2, 15)", beforeReqs, beforeToks)
	}
	// Advance lifecycle past 10:15 (two passes purge detail rows into facts).
	cutoffZero := time.Date(2026, 10, 19, 10, 15, 0, 0, time.UTC).UnixMilli()
	if _, err := repo.RunLifecycle(ctx, map[string]int64{repository.LifecycleUsageDetail: cutoffZero}, 10); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.RunLifecycle(ctx, map[string]int64{repository.LifecycleUsageDetail: cutoffZero}, 10); err != nil {
		t.Fatal(err)
	}
	afterReqs, afterToks := sumPhysical()
	if afterReqs != 2 || afterToks != 15 {
		t.Fatalf("after retention: got (%d reqs, %d tokens), want (2, 15)", afterReqs, afterToks)
	}
}

func TestTrendsQuotaBatchLateReconcileLegacyAndCanonicalCapacity(t *testing.T) {
	start := time.Date(2026, 10, 21, 10, 0, 0, 0, time.UTC)
	obs := start.Add(2 * time.Hour)
	now := start.Add(3 * time.Hour)
	reset := start.Add(5 * time.Hour)
	const (
		authCanon  = "quota-batch-canon"
		authLegacy = "quota-batch-legacy"
	)

	client, baseURL, repo := startDashboardTestServer(t, trendsAuthFilesHandler([]map[string]any{
		{"auth_index": authCanon, "name": "canon.json", "type": "claude", "provider": "claude", "account_type": "oauth"},
		{"auth_index": authLegacy, "name": "legacy.json", "type": "codex", "provider": "codex", "account_type": "oauth"},
	}, nil), func(handler *Handler) { handler.nowFn = func() time.Time { return now } })
	ctx := context.Background()

	// 1. Canonical v2 independent-cache row before observation (1000 raw input + 200 cache read = 1200 prompt, 16.7% cache rate),
	// plus an unmatched alias row on the same credential to verify scoped UnmatchedRequests handling.
	canonicalJSON := `{"version":2,"status":"complete","raw_tokens":{"input_tokens":1000,"output_tokens":300,"cache_read_tokens":200,"total_tokens":1500},"token_breakdown":{"schema_version":2,"quality":"complete","total_tokens":1500,"input":{"total_tokens":1200,"uncached_tokens":1000,"cache_read_tokens":200,"cache_write_tokens":0},"output":{"total_tokens":300,"non_reasoning_tokens":300,"reasoning_tokens":0},"unclassified_tokens":0}}`
	if _, err := repo.SQL().ExecContext(ctx, `
		INSERT INTO usage_events (
			instance_id, event_key, api_group_key, provider, model, response_model,
			auth_index, auth_type, timestamp_ms, created_at_ms, latency_ms,
			input_tokens, output_tokens, cache_read_tokens, total_tokens,
			cost_nanos, pricing_status, token_accounting
		) VALUES
			('default', 'canon-sonnet', 'group', 'claude', 'fast-alias', 'claude-sonnet-4-6', ?, 'oauth', ?, ?, 0, 1000, 300, 200, 1500, 5000, 'priced', ?),
			('default', 'canon-unknown', 'group', 'claude', 'mystery-alias', '', ?, 'oauth', ?, ?, 0, 100, 50, 0, 150, 1000, 'priced', NULL)`,
		authCanon, start.Add(30*time.Minute).UnixMilli(), start.Add(30*time.Minute).UnixMilli(), canonicalJSON,
		authCanon, start.Add(45*time.Minute).UnixMilli(), start.Add(45*time.Minute).UnixMilli(),
	); err != nil {
		t.Fatal(err)
	}

	period, resetMS, used := 5.0, reset.UnixMilli(), 25.0
	canonRaw, _ := json.Marshal([]quota.QuotaWindow{
		{ID: "five_hour", Scope: "standard", Kind: "five_hour", PeriodHours: &period, UsedPercent: &used, ResetAtMS: &resetMS, ResetAccuracy: "exact"},
		{ID: "seven_day_sonnet", Scope: "model", Model: "claude-sonnet-4-6", Kind: "weekly", PeriodHours: &period, UsedPercent: &used, ResetAtMS: &resetMS, ResetAccuracy: "exact"},
		{ID: "code_review", Scope: "code_review", PeriodHours: &period, UsedPercent: &used, ResetAtMS: &resetMS, ResetAccuracy: "exact"},
	})
	if err := repo.SaveQuotaSnapshot(ctx, repository.QuotaSnapshotRecord{
		ID: "batch-canon-snap", AuthIndex: authCanon, Provider: "claude", Status: "healthy",
		ObservedAtMS: obs.UnixMilli(), CreatedAtMS: obs.UnixMilli(), WindowsJSON: string(canonRaw),
	}); err != nil {
		t.Fatal(err)
	}

	// Fold and prune canon-sonnet so live usage_events no longer carries it;
	// the response must combine the stored calibration checkpoint with canon-late
	// via watermark reconciliation rather than reading both from live usage_events.
	if _, err := repo.AggregateUsageFacts(ctx, 100); err != nil {
		t.Fatal(err)
	}
	for range 2 {
		if _, err := repo.RunLifecycle(ctx, map[string]int64{repository.LifecycleUsageDetail: start.Add(time.Hour).UnixMilli()}, 100); err != nil {
			t.Fatal(err)
		}
	}
	var remainingCanon int
	if err := repo.SQL().QueryRowContext(ctx, `SELECT COUNT(*) FROM usage_events WHERE auth_index = ?`, authCanon).Scan(&remainingCanon); err != nil {
		t.Fatal(err)
	}
	if remainingCanon != 0 {
		t.Fatalf("expected canon pre-snapshot rows to be pruned, found %d", remainingCanon)
	}

	// Late-arriving row inserted AFTER the snapshot (id > UsageWatermarkID) that completed before obs.
	if _, err := repo.SQL().ExecContext(ctx, `
		INSERT INTO usage_events (
			instance_id, event_key, api_group_key, provider, model, response_model,
			auth_index, auth_type, timestamp_ms, created_at_ms, latency_ms,
			input_tokens, output_tokens, cache_read_tokens, total_tokens, cost_nanos, pricing_status
		) VALUES ('default', 'canon-late', 'group', 'claude', 'claude-sonnet-4-6', '', ?, 'oauth', ?, ?, 0, 400, 100, 0, 500, 2000, 'priced')`,
		authCanon, start.Add(90*time.Minute).UnixMilli(), now.UnixMilli(),
	); err != nil {
		t.Fatal(err)
	}

	// 2. Legacy unwatermarked calibration row (UsageWatermarkID == 0, HasUsageGap == true)
	// with a mid-cycle reset (40% -> 10% -> 30%). The stored reset baseline is stale
	// (0 reqs / 0 tokens), while retained usage has 1 req (100 tokens) before the reset
	// and 2 reqs (200 tokens) after it. Repairing the legacy reset baseline yields
	// dUsed = 20%, dTokens = 200 -> 1000 capacity (versus 300/20% = 1500 unrepaired).
	legacyUsed := 30.0
	legacyRaw, _ := json.Marshal([]quota.QuotaWindow{
		{ID: "five_hour", Scope: "standard", Kind: "five_hour", PeriodHours: &period, UsedPercent: &legacyUsed, ResetAtMS: &resetMS, ResetAccuracy: "exact"},
	})
	if err := repo.SaveQuotaSnapshot(ctx, repository.QuotaSnapshotRecord{
		ID: "batch-legacy-snap", AuthIndex: authLegacy, Provider: "codex", Status: "healthy",
		ObservedAtMS: obs.UnixMilli(), CreatedAtMS: obs.UnixMilli(), WindowsJSON: string(legacyRaw),
	}); err != nil {
		t.Fatal(err)
	}
	legacyPoints, _ := json.Marshal([]quota.CalibrationPoint{
		{ObservedAtMS: start.Add(40 * time.Minute).UnixMilli(), UsedPercent: 40, Requests: 1, Tokens: 100, HasUsageGap: true},
		{ObservedAtMS: start.Add(60 * time.Minute).UnixMilli(), UsedPercent: 10, Requests: 0, Tokens: 0, HasUsageGap: true},
		{ObservedAtMS: obs.UnixMilli(), UsedPercent: 30, Requests: 1, Tokens: 100, HasUsageGap: true},
	})
	if _, err := repo.SQL().ExecContext(ctx, `
		UPDATE quota_capacity_cycles SET points_json = ? WHERE auth_index = ?`,
		string(legacyPoints), authLegacy,
	); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.SQL().ExecContext(ctx, `
		INSERT INTO usage_events (
			instance_id, event_key, api_group_key, provider, model, auth_index, auth_type,
			timestamp_ms, created_at_ms, input_tokens, output_tokens, total_tokens, cost_nanos, pricing_status
		) VALUES
			('default', 'legacy-pre-reset', 'group', 'codex', 'gpt-5', ?, 'oauth', ?, ?, 80, 20, 100, 500, 'priced'),
			('default', 'legacy-post-reset-1', 'group', 'codex', 'gpt-5', ?, 'oauth', ?, ?, 80, 20, 100, 500, 'priced'),
			('default', 'legacy-post-reset-2', 'group', 'codex', 'gpt-5', ?, 'oauth', ?, ?, 80, 20, 100, 500, 'priced')`,
		authLegacy, start.Add(30*time.Minute).UnixMilli(), start.Add(30*time.Minute).UnixMilli(),
		authLegacy, start.Add(75*time.Minute).UnixMilli(), start.Add(75*time.Minute).UnixMilli(),
		authLegacy, start.Add(90*time.Minute).UnixMilli(), start.Add(90*time.Minute).UnixMilli(),
	); err != nil {
		t.Fatal(err)
	}

	resp := trendsTestRead[TrendsQuotaResponseDTO](t, client, baseURL+"/omc/api/v1/management/trends/quota")
	if len(resp.Items) != 2 {
		t.Fatalf("expected 2 credentials, got %d", len(resp.Items))
	}
	byAuth := map[string]TrendsQuotaCredentialDTO{}
	for _, item := range resp.Items {
		byAuth[item.AuthIndex] = item
	}

	canonItem := byAuth[authCanon]
	if len(canonItem.Windows) != 3 {
		t.Fatalf("canon windows=%+v", canonItem.Windows)
	}
	sonnetWin := canonItem.Windows[1]
	// Pruned canon-sonnet checkpoint (1200 prompt, 200 cache, 1500 total) + reconciled canon-late (400 prompt, 0 cache, 500 total)
	// = 2 reqs, 2000 tokens, 1600 prompt, 200 cache -> 12.5% cache rate.
	if sonnetWin.CurrentUsage == nil || sonnetWin.CurrentUsage.Requests != 2 || sonnetWin.CurrentUsage.Tokens != 2000 ||
		sonnetWin.CurrentUsage.PromptTokens != 1600 || sonnetWin.CurrentUsage.CachedTokens != 200 ||
		sonnetWin.CurrentUsage.CacheRate == nil || *sonnetWin.CurrentUsage.CacheRate != 12.5 {
		t.Fatalf("canonical + late scoped usage mismatch: %+v", sonnetWin.CurrentUsage)
	}
	if sonnetWin.Capacity == nil || sonnetWin.Capacity.Requests != 8 || sonnetWin.Capacity.Tokens != 8000 {
		t.Fatalf("canonical + late scoped capacity mismatch: %+v", sonnetWin.Capacity)
	}
	if !canonItem.Windows[2].IsPhysicalUnavailable || canonItem.Windows[2].CurrentRequests != 0 {
		t.Fatalf("feature window should keep zero physical usage: %+v", canonItem.Windows[2])
	}

	legacyItem := byAuth[authLegacy]
	if len(legacyItem.Windows) != 1 {
		t.Fatalf("legacy windows=%+v", legacyItem.Windows)
	}
	legacyWin := legacyItem.Windows[0]
	if legacyWin.CurrentUsage == nil || legacyWin.CurrentUsage.Requests != 3 || legacyWin.CurrentUsage.Tokens != 300 {
		t.Fatalf("legacy reconciled usage mismatch: %+v", legacyWin.CurrentUsage)
	}
	// Post-reset delta: (3 - 1) reqs = 2 reqs, (300 - 100) tokens = 200 tokens over (30 - 10)% = 20% -> 10 reqs / 1000 tokens capacity.
	if legacyWin.Capacity == nil || legacyWin.Capacity.Requests != 10 || legacyWin.Capacity.Tokens != 1000 {
		t.Fatalf("legacy mid-cycle reset repaired capacity mismatch: %+v", legacyWin.Capacity)
	}
}

func TestTrendsQuotaTieBreakOrderAndCaseInsensitiveEndpointPartition(t *testing.T) {
	start := time.Date(2026, 10, 21, 10, 0, 0, 0, time.UTC)
	obs := start.Add(2 * time.Hour)
	now := start.Add(3 * time.Hour)
	reset := start.Add(5 * time.Hour)
	const authID = "quota-tie-ep"

	client, baseURL, repo := startDashboardTestServer(t, trendsAuthFilesHandler([]map[string]any{
		{"auth_index": authID, "name": "tie.json", "type": "codex", "provider": "codex", "account_type": "oauth"},
	}, nil), func(handler *Handler) { handler.nowFn = func() time.Time { return now } })
	ctx := context.Background()

	// Legacy row with empty provider/executor and uppercase /v1/MESSAGES endpoint:
	// SQL LIKE '%/v1/messages%' treats it as independent Anthropic semantics (2),
	// so prompt = 100 + 40 = 140, completion = 20 -> effectiveTotal = 160, net = 160 - 40 = 120.
	if _, err := repo.SQL().ExecContext(ctx, `
		INSERT INTO usage_events (
			instance_id, event_key, api_group_key, provider, executor_type, endpoint, model,
			auth_index, auth_type, timestamp_ms, created_at_ms, latency_ms,
			input_tokens, output_tokens, cache_read_tokens, total_tokens, pricing_status
		) VALUES ('default', 'upper-ep', 'group', '', '', '/v1/MESSAGES', 'claude-sonnet-4-6', ?, 'oauth', ?, ?, 0, 100, 20, 40, 120, 'priced')`,
		authID, start.Add(30*time.Minute).UnixMilli(), start.Add(30*time.Minute).UnixMilli(),
	); err != nil {
		t.Fatal(err)
	}

	// Pin both ObservedAtMS and CreatedAtMS across two snapshots (20% then 90%)
	// at a historical timestamp, followed by a newer snapshot at a distinct timestamp.
	// GetQuotaSnapshotHistoryBatch must preserve rowid DESC tie-breaking so the
	// historical burn bucket at the tied timestamp reflects 90% rather than 20%.
	tiedObs := start.Add(time.Hour)
	period, resetMS := 5.0, reset.UnixMilli()
	saveSnap := func(id string, at time.Time, used float64) {
		raw, _ := json.Marshal([]quota.QuotaWindow{
			{ID: "five_hour", Scope: "standard", Kind: "five_hour", PeriodHours: &period, UsedPercent: &used, ResetAtMS: &resetMS, ResetAccuracy: "exact"},
		})
		if err := repo.SaveQuotaSnapshot(ctx, repository.QuotaSnapshotRecord{
			ID: id, AuthIndex: authID, Provider: "codex", Status: "healthy",
			ObservedAtMS: at.UnixMilli(), CreatedAtMS: at.UnixMilli(), WindowsJSON: string(raw),
		}); err != nil {
			t.Fatal(err)
		}
	}
	saveSnap("snap-tie-1", tiedObs, 20)
	saveSnap("snap-tie-2", tiedObs, 90)
	saveSnap("snap-latest", obs, 95)

	resp := trendsTestRead[TrendsQuotaResponseDTO](t, client, baseURL+"/omc/api/v1/management/trends/quota")
	if len(resp.Items) != 1 || len(resp.Items[0].Windows) != 1 {
		t.Fatalf("unexpected items: %+v", resp.Items)
	}
	win := resp.Items[0].Windows[0]
	if win.UsedPercent != 95 {
		t.Fatalf("expected latest snapshot used_percent=95, got %v", win.UsedPercent)
	}
	// Find the burn bucket ending at tiedObs (whose cumulative UsedPercent is
	// evaluated at EndMS == tiedObs) and verify it recorded 90% (not 20%).
	var tiedBucket *TrendsQuotaBucketDTO
	for i := range win.Buckets {
		b := &win.Buckets[i]
		if b.EndMS == tiedObs.UnixMilli() {
			tiedBucket = b
			break
		}
	}
	if tiedBucket == nil || tiedBucket.UsedPercent != 90 {
		t.Fatalf("expected historical tied bucket ending at tiedObs used_percent=90 via rowid DESC tie-break, got %+v", tiedBucket)
	}
	if win.CurrentNetTokens != 120 || win.CurrentTotalTokens != 160 {
		t.Fatalf("case-insensitive /v1/MESSAGES partition mismatch: net=%d total=%d, want net=120 total=160",
			win.CurrentNetTokens, win.CurrentTotalTokens)
	}
}
