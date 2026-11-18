package api

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"math/rand/v2"
	"net/http"
	"net/url"
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
	if _, err := repo.InsertUsageEvents(ctx, []usage.Event{subEvent1, subEvent2, subEvent3}); err != nil {
		t.Fatal(err)
	}

	telURL := fmt.Sprintf("%s/omc/api/v1/management/trends/telemetry?from=%d&to=%d&bucket=hour", baseURL, now.Add(-time.Hour).UnixMilli(), now.UnixMilli()-1)
	tel := trendsTestRead[TrendsTelemetryResponseDTO](t, client, telURL)
	if len(tel.SubstitutionPairs) != 3 {
		t.Fatalf("expected 3 substitution pairs, got %+v", tel.SubstitutionPairs)
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
	if len(eventsResp.Items) != 1 || eventsResp.Items[0].RequestID != "sub-redacted" {
		t.Fatalf("expected opaque model + response_model filter to isolate sub-redacted, got %+v", eventsResp.Items)
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
