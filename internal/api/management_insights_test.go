package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
	"github.com/oh-my-cpa/oh-my-cpa/internal/security"
	"github.com/oh-my-cpa/oh-my-cpa/internal/usage"
)

func TestInsightsWindowsFollowTheDeploymentCalendar(t *testing.T) {
	shanghai, err := time.LoadLocation("Asia/Shanghai")
	if err != nil {
		t.Fatal(err)
	}
	newYork, err := time.LoadLocation("America/New_York")
	if err != nil {
		t.Fatal(err)
	}
	local := func(zone *time.Location, year int, month time.Month, day, hour, minute int) int64 {
		return time.Date(year, month, day, hour, minute, 0, 0, zone).UnixMilli()
	}
	noFirstUsage := func() (*int64, error) { return nil, nil }
	// A Wednesday afternoon.
	wednesday := time.Date(2026, 10, 21, 14, 30, 0, 0, shanghai)

	cases := []struct {
		name, preset   string
		now            time.Time
		zone           *time.Location
		from, to       int64
		isOpen         bool
		compareFrom    int64
		compareTo      int64
		expectedBucket insightsBucket
	}{
		{"today grows and compares against full yesterday", "today", wednesday, shanghai,
			local(shanghai, 2026, 10, 21, 0, 0), wednesday.UnixMilli(), true,
			local(shanghai, 2026, 10, 20, 0, 0), local(shanghai, 2026, 10, 21, 0, 0) - 1, insightsBucketHour},
		{"yesterday is closed", "yesterday", wednesday, shanghai,
			local(shanghai, 2026, 10, 20, 0, 0), local(shanghai, 2026, 10, 21, 0, 0) - 1, false,
			local(shanghai, 2026, 10, 19, 0, 0), local(shanghai, 2026, 10, 20, 0, 0) - 1, insightsBucketHour},
		{"this week starts on Monday and compares against full last week", "this_week", wednesday, shanghai,
			local(shanghai, 2026, 10, 19, 0, 0), wednesday.UnixMilli(), true,
			local(shanghai, 2026, 10, 12, 0, 0), local(shanghai, 2026, 10, 19, 0, 0) - 1, insightsBucketDay},
		{"last week", "last_week", wednesday, shanghai,
			local(shanghai, 2026, 10, 12, 0, 0), local(shanghai, 2026, 10, 19, 0, 0) - 1, false,
			local(shanghai, 2026, 10, 5, 0, 0), local(shanghai, 2026, 10, 12, 0, 0) - 1, insightsBucketDay},
		{"this month compares against full last month", "this_month", wednesday, shanghai,
			local(shanghai, 2026, 10, 1, 0, 0), wednesday.UnixMilli(), true,
			local(shanghai, 2026, 9, 1, 0, 0), local(shanghai, 2026, 10, 1, 0, 0) - 1, insightsBucketDay},
		{"last month", "last_month", wednesday, shanghai,
			local(shanghai, 2026, 9, 1, 0, 0), local(shanghai, 2026, 10, 1, 0, 0) - 1, false,
			local(shanghai, 2026, 8, 1, 0, 0), local(shanghai, 2026, 9, 1, 0, 0) - 1, insightsBucketDay},
		{"the 31st compares against full February", "this_month", time.Date(2026, 3, 31, 9, 0, 0, 0, shanghai), shanghai,
			local(shanghai, 2026, 3, 1, 0, 0), local(shanghai, 2026, 3, 31, 9, 0), true,
			local(shanghai, 2026, 2, 1, 0, 0), local(shanghai, 2026, 3, 1, 0, 0) - 1, insightsBucketDay},
		{"the day clocks fall back is 25 hours", "yesterday", time.Date(2026, 11, 2, 9, 0, 0, 0, newYork), newYork,
			local(newYork, 2026, 11, 1, 0, 0), local(newYork, 2026, 11, 2, 0, 0) - 1, false,
			local(newYork, 2026, 10, 31, 0, 0), local(newYork, 2026, 11, 1, 0, 0) - 1, insightsBucketHour},
		{"a relative window compares against the one before it", "7d", wednesday, shanghai,
			wednesday.Add(-7 * 24 * time.Hour).UnixMilli(), wednesday.UnixMilli(), true,
			wednesday.Add(-14 * 24 * time.Hour).UnixMilli(), wednesday.Add(-7*24*time.Hour).UnixMilli() - 1, insightsBucketDay},
	}
	for _, testCase := range cases {
		resolved, message, err := resolveInsightsRange(url.Values{"preset": {testCase.preset}}, testCase.now, testCase.zone, noFirstUsage)
		if err != nil || message != "" {
			t.Fatalf("%s: %q %v", testCase.name, message, err)
		}
		window := resolved.window
		if window.FromMS != testCase.from || window.ToMS != testCase.to || window.OpenEnd != testCase.isOpen || window.Bucket != testCase.expectedBucket {
			t.Fatalf("%s: window %+v, want from %d to %d open %v bucket %s", testCase.name, window, testCase.from, testCase.to, testCase.isOpen, testCase.expectedBucket)
		}
		if resolved.compare == nil || resolved.compare.FromMS != testCase.compareFrom || resolved.compare.ToMS != testCase.compareTo {
			t.Fatalf("%s: compare %+v, want %d to %d", testCase.name, resolved.compare, testCase.compareFrom, testCase.compareTo)
		}
	}
	if window := cases[7]; window.to-window.from+1 != 25*time.Hour.Milliseconds() {
		t.Fatalf("the fall-back day spans %d ms", window.to-window.from+1)
	}

	rejected := map[string]url.Values{
		"unknown preset":     {"preset": {"fortnight"}},
		"unknown bucket":     {"preset": {"7d"}, "bucket": {"minute"}},
		"hours over 14 days": {"preset": {"30d"}, "bucket": {"hour"}},
		"reversed range":     {"from": {"2000"}, "to": {"1000"}},
	}
	for name, query := range rejected {
		if _, message, _ := resolveInsightsRange(query, wednesday, shanghai, noFirstUsage); message == "" {
			t.Fatalf("%s was accepted", name)
		}
	}
}

// Hour buckets follow the wall clock, as the repository groups them: the hour
// clocks repeat is one bucket, and the hour they skip is none.
func TestInsightsHourBucketsStepTheWallClock(t *testing.T) {
	newYork, err := time.LoadLocation("America/New_York")
	if err != nil {
		t.Fatal(err)
	}
	for _, testCase := range []struct {
		day   int
		month time.Month
		want  []int
	}{{1, time.November, []int{0, 1, 2, 3}}, {8, time.March, []int{0, 1, 3}}} {
		from := time.Date(2026, testCase.month, testCase.day, 0, 0, 0, 0, newYork)
		to := time.Date(2026, testCase.month, testCase.day, 3, 59, 0, 0, newYork)
		starts := insightsBucketHour.bucketStarts(from.UnixMilli(), to.UnixMilli(), newYork)
		hours := []int{}
		for _, start := range starts {
			hours = append(hours, time.UnixMilli(start).In(newYork).Hour())
		}
		if !reflect.DeepEqual(hours, testCase.want) {
			t.Fatalf("%s %d hours %v, want %v", testCase.month, testCase.day, hours, testCase.want)
		}
	}
}

func TestInsightsCubeCarriesEveryDimensionWithoutKeys(t *testing.T) {
	shanghai, err := time.LoadLocation("Asia/Shanghai")
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 10, 21, 14, 30, 0, 0, shanghai)
	client, baseURL, repo := startDashboardTestServer(t, nil, func(handler *Handler) {
		handler.nowFn = func() time.Time { return now }
	})
	repo.Timezone().Apply(shanghai)

	event := func(id, key, alias, model string, at time.Time, tokens int64) usage.Event {
		ev := eventFor(id, at, usage.TokenStats{InputTokens: tokens / 2, OutputTokens: tokens / 2, TotalTokens: tokens}, false)
		ev.APIGroupKey, ev.Model, ev.APIKeyMask = key, model, security.MaskSecret(key)
		if alias != "" {
			ev.ModelAlias = &alias
		}
		return ev
	}
	todayMorning := time.Date(2026, 10, 21, 9, 15, 0, 0, shanghai)
	yesterdayMorning := time.Date(2026, 10, 20, 9, 15, 0, 0, shanghai)
	seedEvents(t, repo, now, []repository.UsageDecoded{
		{Event: event("a", "sk-alpha-secret-0001", "fast", "gpt-5", todayMorning, 100)},
		{Event: event("b", "sk-alpha-secret-0001", "fast", "gpt-5", todayMorning.Add(10*time.Minute), 60)},
		{Event: event("c", "sk-beta-secret-00002", "", "claude-sonnet", todayMorning.Add(3*time.Hour), 40)},
		{Event: event("d", "sk-beta-secret-00002", "", "claude-sonnet", yesterdayMorning, 500)},
		// After this instant of yesterday, so outside the comparison window.
		{Event: event("e", "sk-beta-secret-00002", "", "claude-sonnet", time.Date(2026, 10, 20, 20, 0, 0, 0, shanghai), 900)},
	})

	response, payload := getJSON(t, client, baseURL+"/omc/api/v1/management/insights/cube?preset=today")
	if response.StatusCode != http.StatusOK {
		t.Fatalf("status %d: %s", response.StatusCode, payload)
	}
	if response.Header.Get("Cache-Control") != "no-store" {
		t.Fatal("the cube must not be cached")
	}
	for _, secret := range []string{"sk-alpha-secret", "sk-beta-secret"} {
		if strings.Contains(string(payload), secret) {
			t.Fatalf("the cube leaked a client key: %s", payload)
		}
	}
	var body insightsCubeResponse
	if err := json.Unmarshal(payload, &body); err != nil {
		t.Fatal(err)
	}
	if body.Window.Bucket != insightsBucketHour || body.Window.Timezone != "Asia/Shanghai" || !body.Window.OpenEnd {
		t.Fatalf("window %+v", body.Window)
	}
	if len(body.BucketStarts) != 15 || body.BucketStarts[9] != time.Date(2026, 10, 21, 9, 0, 0, 0, shanghai).UnixMilli() {
		t.Fatalf("bucket starts %v", body.BucketStarts)
	}
	if len(body.Dims.Keys) != 2 || len(body.Dims.Models) != 2 || len(body.Dims.CallPoints) != 2 {
		t.Fatalf("dimensions %+v", body.Dims)
	}
	for _, key := range body.Dims.Keys {
		if !key.IsClientKey || !strings.HasPrefix(key.ID, "hmac:") || !security.IsMask(key.Mask) {
			t.Fatalf("key %+v must be a fingerprint with its mask", key)
		}
	}
	column := map[string]int{}
	for index, name := range body.Columns {
		column[name] = index
	}
	tokensByHour := map[int]int64{}
	var requests int64
	for _, row := range body.Rows {
		if row[column["key"]] >= int64(len(body.Dims.Keys)) || row[column["credential"]] >= int64(len(body.Dims.Credentials)) {
			t.Fatalf("row %v points past its dictionaries", row)
		}
		hour := time.UnixMilli(body.BucketStarts[row[column["bucket"]]]).In(shanghai).Hour()
		tokensByHour[hour] += row[column["total_tokens"]]
		requests += row[column["requests"]]
	}
	if requests != 3 || tokensByHour[9] != 160 || tokensByHour[12] != 40 {
		t.Fatalf("rows %v hold %d requests by hour %v", body.Rows, requests, tokensByHour)
	}
	// Full yesterday across hourly buckets: 09:00 (500 tokens) and 20:00 (900 tokens).
	if len(body.PreviousRows) != 2 ||
		body.PreviousRows[0][column["bucket"]] != 9 || body.PreviousRows[0][column["total_tokens"]] != 500 ||
		body.PreviousRows[1][column["bucket"]] != 20 || body.PreviousRows[1][column["total_tokens"]] != 900 {
		t.Fatalf("previous rows %v", body.PreviousRows)
	}

	rhythmURL := baseURL + "/omc/api/v1/management/insights/rhythm?preset=today&model=gpt-5"
	response, payload = getJSON(t, client, rhythmURL)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("rhythm status %d: %s", response.StatusCode, payload)
	}
	var rhythm insightsRhythmResponse
	if err := json.Unmarshal(payload, &rhythm); err != nil {
		t.Fatal(err)
	}
	if len(rhythm.Cells) != 168 {
		t.Fatalf("rhythm has %d cells", len(rhythm.Cells))
	}
	// Wednesday is the third weekday counted from Monday.
	if cell := rhythm.Cells[2*24+9]; cell.Requests != 2 || cell.TotalTokens != 160 {
		t.Fatalf("Wednesday 09:00 holds %+v", cell)
	}
	var total int64
	for _, cell := range rhythm.Cells {
		total += cell.Requests
	}
	if total != 2 {
		t.Fatalf("the model filter kept %d requests, want 2", total)
	}

	response, _ = getJSON(t, client, baseURL+"/omc/api/v1/management/insights/cube?preset=30d&bucket=hour")
	if response.StatusCode != http.StatusBadRequest {
		t.Fatalf("hourly buckets over 30 days answered %d", response.StatusCode)
	}

	// Changing the display bucket (day vs week) must not alter PreviousRows, so the
	// robust comparison baseline stays invariant to chart granularity.
	// 7d window at 2026-10-21 14:30 covers Oct 14 14:30–Oct 21 14:30; its comparison
	// period is Oct 07 14:30–Oct 14 14:30.
	seedEvents(t, repo, now, []repository.UsageDecoded{
		{Event: event("cmp-day-1", "sk-alpha-secret-0001", "fast", "gpt-5", time.Date(2026, 10, 9, 10, 0, 0, 0, shanghai), 700)},
		{Event: event("cmp-day-2", "sk-alpha-secret-0001", "fast", "gpt-5", time.Date(2026, 10, 12, 10, 0, 0, 0, shanghai), 800)},
	})
	var dayCube, weekCube insightsCubeResponse
	dayRes, dayPayload := getJSON(t, client, baseURL+"/omc/api/v1/management/insights/cube?preset=7d&bucket=day")
	if dayRes.StatusCode != http.StatusOK {
		t.Fatalf("day cube status %d: %s", dayRes.StatusCode, dayPayload)
	}
	weekRes, weekPayload := getJSON(t, client, baseURL+"/omc/api/v1/management/insights/cube?preset=7d&bucket=week")
	if weekRes.StatusCode != http.StatusOK {
		t.Fatalf("week cube status %d: %s", weekRes.StatusCode, weekPayload)
	}
	if err := json.Unmarshal(dayPayload, &dayCube); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(weekPayload, &weekCube); err != nil {
		t.Fatal(err)
	}
	var prevTokenSum int64
	for _, r := range dayCube.PreviousRows {
		prevTokenSum += r[column["total_tokens"]]
	}
	if len(dayCube.PreviousRows) != 2 || prevTokenSum != 1500 {
		t.Fatalf("expected 2 non-empty comparison day buckets totalling 1500 tokens, got %v", dayCube.PreviousRows)
	}
	if !reflect.DeepEqual(dayCube.PreviousRows, weekCube.PreviousRows) || !reflect.DeepEqual(dayCube.Compare, weekCube.Compare) {
		t.Fatalf("comparison rows changed across display buckets: day=%v week=%v", dayCube.PreviousRows, weekCube.PreviousRows)
	}
}

func TestInsightsCubeFoldsDailyFactsIntoCalendarMonths(t *testing.T) {
	shanghai, err := time.LoadLocation("Asia/Shanghai")
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 10, 21, 14, 30, 0, 0, shanghai)
	client, baseURL, repo := startDashboardTestServer(t, nil, func(handler *Handler) {
		handler.nowFn = func() time.Time { return now }
	})
	repo.Timezone().Apply(shanghai)

	mkEvent := func(id string, at time.Time, tokens int64) repository.UsageDecoded {
		ev := eventFor(id, at, usage.TokenStats{InputTokens: tokens / 2, OutputTokens: tokens / 2, TotalTokens: tokens}, false)
		ev.APIGroupKey, ev.Model, ev.APIKeyMask = "sk-alpha-secret-0001", "gpt-5", security.MaskSecret("sk-alpha-secret-0001")
		return repository.UsageDecoded{Event: ev}
	}
	seedEvents(t, repo, now, []repository.UsageDecoded{
		mkEvent("aug-1", time.Date(2026, 8, 5, 10, 0, 0, 0, shanghai), 100),
		mkEvent("sep-1", time.Date(2026, 9, 3, 11, 0, 0, 0, shanghai), 200),
		mkEvent("sep-2", time.Date(2026, 9, 28, 16, 0, 0, 0, shanghai), 300),
		mkEvent("oct-1", time.Date(2026, 10, 2, 9, 0, 0, 0, shanghai), 400),
		mkEvent("oct-2", time.Date(2026, 10, 12, 18, 0, 0, 0, shanghai), 500),
		mkEvent("oct-3", time.Date(2026, 10, 21, 8, 0, 0, 0, shanghai), 600),
	})
	if _, err := repo.AggregateUsageFacts(context.Background(), 100); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.EnsureLocalUsageFacts(context.Background()); err != nil {
		t.Fatal(err)
	}

	fromMS := time.Date(2026, 8, 1, 0, 0, 0, 0, shanghai).UnixMilli()
	toMS := now.UnixMilli()
	urlStr := baseURL + "/omc/api/v1/management/insights/cube?bucket=month&from=" +
		jsonNumber(fromMS) + "&to=" + jsonNumber(toMS)
	response, payload := getJSON(t, client, urlStr)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("status %d: %s", response.StatusCode, payload)
	}
	var body insightsCubeResponse
	if err := json.Unmarshal(payload, &body); err != nil {
		t.Fatal(err)
	}
	if body.Window.Bucket != insightsBucketMonth || len(body.BucketStarts) != 3 {
		t.Fatalf("window=%+v bucket_starts=%v", body.Window, body.BucketStarts)
	}
	col := map[string]int{}
	for idx, name := range body.Columns {
		col[name] = idx
	}
	requestsByBucket := make([]int64, len(body.BucketStarts))
	for _, row := range body.Rows {
		requestsByBucket[row[col["bucket"]]] += row[col["requests"]]
	}
	want := []int64{1, 2, 3}
	if !reflect.DeepEqual(requestsByBucket, want) {
		t.Fatalf("requests per month bucket = %v, want %v", requestsByBucket, want)
	}
}

func jsonNumber(v int64) string {
	b, _ := json.Marshal(v)
	return string(b)
}

func BenchmarkInsightsCubeHandler(b *testing.B) {
	ctx := context.Background()
	shanghai, err := time.LoadLocation("Asia/Shanghai")
	if err != nil {
		b.Fatal(err)
	}
	db, err := repository.Open(ctx, dashboardMemoryDSN("insights_bench"))
	if err != nil {
		b.Fatal(err)
	}
	b.Cleanup(func() { _ = db.Close() })
	repo := repository.New(db)
	repo.Timezone().Apply(shanghai)
	if _, err := db.SQL.Exec(`INSERT INTO cpa_instances
		(id, name, base_url, usage_addr, management_key_ciphertext, management_key_nonce, status, created_at, updated_at)
		VALUES ('default','Default','http://localhost','localhost',x'00',x'00','ok',0,0)`); err != nil {
		b.Fatal(err)
	}
	const days = 90
	const combinations = 40
	fromMS := int64(1700006400000)
	dayMS := int64(24 * 60 * 60 * 1000)
	for _, grain := range []struct {
		table    string
		bucketMS int64
	}{{"usage_facts_15m", repository.QuarterHourBucketMS}, {"usage_facts_daily", dayMS}} {
		if _, err := db.SQL.Exec(`
			WITH RECURSIVE buckets(start_ms) AS (
				SELECT ?1 UNION ALL SELECT start_ms + ?2 FROM buckets WHERE start_ms + ?2 < ?1 + ?3
			), combos(n) AS (
				SELECT 0 UNION ALL SELECT n + 1 FROM combos WHERE n + 1 < ?4
			)
			INSERT INTO `+grain.table+` (instance_id, bucket_start_ms, api_group_key, model, model_alias, auth_index,
				provider, auth_type, requests, input_tokens, output_tokens, total_tokens, cost_nanos, priced_requests, costed_requests)
			SELECT 'default', start_ms, 'hmac:key-' || (n % 20), 'model-' || (n % 8), 'alias-' || (n % 5),
				'auth-' || (n % 10), 'provider-' || (n % 3), 'apikey', 3, 300, 200, 500, 1000, 3, 3
			FROM buckets, combos`,
			fromMS, grain.bucketMS, int64(days)*dayMS, combinations); err != nil {
			b.Fatal(err)
		}
	}
	if _, err := db.SQL.Exec(`
		WITH RECURSIVE seq(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM seq WHERE n < 20000)
		INSERT INTO usage_events (instance_id, event_key, api_group_key, api_group_label, api_key_mask, model, provider, timestamp_ms, created_at_ms)
		SELECT 'default', 'ev-'||n, 'hmac:key-'||(n%20), 'api_key', 'sk-••••'||printf('%04d', n%20),
			'model-'||(n%8), 'provider-'||(n%3), ?1 + n * 1000, ?1
		FROM seq`, fromMS); err != nil {
		b.Fatal(err)
	}
	if _, err := db.SQL.Exec(`
		UPDATE usage_aggregation_checkpoints SET last_usage_event_id = 20000 WHERE name = ?`, repository.CheckpointFacts); err != nil {
		b.Fatal(err)
	}
	if _, err := repo.EnsureLocalUsageFacts(ctx); err != nil {
		b.Fatal(err)
	}
	now := time.UnixMilli(fromMS + int64(days)*dayMS - 1).In(shanghai)
	handler := &Handler{repo: repo, nowFn: func() time.Time { return now }}
	req := httptest.NewRequest(http.MethodGet, "/api/v1/management/insights/cube?preset=90d", nil)
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		rec := httptest.NewRecorder()
		handler.insightsCube(rec, req)
		if rec.Code != http.StatusOK {
			b.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
		}
	}
}

func TestInsightsClientsAggregatesAgentsFiltersAndRetentionCoverage(t *testing.T) {
	shanghai, err := time.LoadLocation("Asia/Shanghai")
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 10, 21, 14, 30, 0, 0, shanghai)
	client, baseURL, repo := startDashboardTestServer(t, nil, func(handler *Handler) {
		handler.nowFn = func() time.Time { return now }
	})
	repo.Timezone().Apply(shanghai)

	makeEvent := func(id, key, model, provider, endpoint, ua string, at time.Time, input, cacheRead, output, reasoning int64, ttft *int64, generate bool) usage.Event {
		ev := eventFor(id, at, usage.TokenStats{
			InputTokens:     input,
			CacheReadTokens: cacheRead,
			CachedTokens:    cacheRead,
			OutputTokens:    output,
			ReasoningTokens: reasoning,
			TotalTokens:     input + output,
		}, false)
		ev.APIGroupKey = key
		ev.APIKeyMask = security.MaskSecret(key)
		ev.Model = model
		ev.Provider = provider
		ev.Endpoint = endpoint
		ev.Generate = generate
		ev.TTFTMS = ttft
		if ua != "" {
			ev.UserAgent = &ua
		}
		return ev
	}

	ttftFast := int64(120)
	ttftSlow := int64(360)
	today := time.Date(2026, 10, 21, 10, 0, 0, 0, shanghai)
	seedEvents(t, repo, now, []repository.UsageDecoded{
		{Event: makeEvent("c1", "sk-alpha-secret-0001", "claude-sonnet-4-5", "claude", "POST /v1/messages", "claude-cli/2.1.3 (external, cli)", today, 1000, 800, 200, 50, &ttftFast, true)},
		{Event: makeEvent("c2", "sk-alpha-secret-0001", "claude-sonnet-4-5", "claude", "POST /v1/messages", "claude-cli/2.0.14", today.Add(time.Minute), 500, 300, 100, 20, &ttftSlow, true)},
		// Qwen Code disguising as claude-cli/0.x on /v1/messages must stay separate from Claude Code.
		{Event: makeEvent("q1", "sk-beta-secret-00002", "qwen-coder-plus", "openai", "POST /v1/messages", "claude-cli/0.1.5", today.Add(2*time.Minute), 400, 0, 150, 0, nil, true)},
		{Event: makeEvent("o1", "sk-beta-secret-00002", "gpt-5", "codex", "POST /v1/responses", "opencode/latest/1.19.5/cli", today.Add(3*time.Minute), 600, 200, 120, 40, &ttftFast, true)},
		{Event: makeEvent("u1", "sk-beta-secret-00002", "gpt-5", "codex", "POST /v1/chat/completions", "", today.Add(4*time.Minute), 100, 0, 50, 0, nil, true)},
		// Non-generating warmup record is excluded from client request attribution.
		{Event: makeEvent("w1", "sk-alpha-secret-0001", "gpt-5", "codex", "GET /v1/realtime", "codex_cli_rs/0.47.0", today.Add(5*time.Minute), 0, 0, 0, 0, nil, false)},
	})

	response, payload := getJSON(t, client, baseURL+"/omc/api/v1/management/insights/clients?preset=today")
	if response.StatusCode != http.StatusOK {
		t.Fatalf("status %d: %s", response.StatusCode, payload)
	}
	if response.Header.Get("Cache-Control") != "no-store" {
		t.Fatal("clients endpoint must set Cache-Control: no-store")
	}
	for _, secret := range []string{"sk-alpha-secret", "sk-beta-secret"} {
		if strings.Contains(string(payload), secret) {
			t.Fatalf("clients response leaked secret %q: %s", secret, payload)
		}
	}

	var all insightsClientsResponse
	if err := json.Unmarshal(payload, &all); err != nil {
		t.Fatal(err)
	}
	if all.Coverage.RetainedRequests != 6 || all.Coverage.TotalRequests != 6 {
		t.Fatalf("coverage = %+v, want exact 6/6 retained requests including warmup", all.Coverage)
	}
	if len(all.Clients) != 4 {
		t.Fatalf("clients = %+v, want 4 distinct groups", all.Clients)
	}
	if all.Clients[0].ID != usage.ClientAgentClaudeCode || all.Clients[0].Requests != 2 ||
		all.Clients[0].CacheReadTokens != 1100 || all.Clients[0].ReasoningTokens != 70 ||
		all.Clients[0].TTFTSumMS != 480 || all.Clients[0].TTFTCount != 2 ||
		all.Clients[0].RawPrefix != "claude-cli/2." {
		t.Fatalf("top client = %+v", all.Clients[0])
	}

	byID := map[string]insightsClientItem{}
	for _, item := range all.Clients {
		byID[item.ID] = item
	}
	if byID[usage.ClientAgentQwenCode].Requests != 1 || byID[usage.ClientAgentQwenCode].RawPrefix != "claude-cli/0." {
		t.Fatalf("qwen-code group = %+v", byID[usage.ClientAgentQwenCode])
	}
	if byID[usage.ClientAgentOpenCode].Requests != 1 || byID[usage.ClientAgentOpenCode].RawPrefix != "opencode" {
		t.Fatalf("opencode group = %+v", byID[usage.ClientAgentOpenCode])
	}
	if byID[usage.ClientAgentUnknown].Requests != 1 || byID[usage.ClientAgentUnknown].RawPrefix != "" {
		t.Fatalf("unknown group = %+v", byID[usage.ClientAgentUnknown])
	}

	// Cross-dimensional filtering narrows to matching model/provider records.
	response, payload = getJSON(t, client, baseURL+"/omc/api/v1/management/insights/clients?preset=today&model=gpt-5")
	if response.StatusCode != http.StatusOK {
		t.Fatalf("filtered status %d: %s", response.StatusCode, payload)
	}
	var filtered insightsClientsResponse
	if err := json.Unmarshal(payload, &filtered); err != nil {
		t.Fatal(err)
	}
	if filtered.Coverage.RetainedRequests != 3 || filtered.Coverage.TotalRequests != 3 || len(filtered.Clients) != 2 {
		t.Fatalf("filtered clients = %+v", filtered)
	}

	// Detail retention pruning leaves permanent usage_facts intact while lowering retained_requests honestly.
	if _, err := repo.AggregateUsageFacts(context.Background(), 100); err != nil {
		t.Fatal(err)
	}
	oldDay := now.Add(-40 * 24 * time.Hour)
	seedEvents(t, repo, now, []repository.UsageDecoded{
		{Event: makeEvent("old-1", "sk-alpha-secret-0001", "gpt-5", "codex", "POST /v1/responses", "codex_cli_rs/0.47.0", oldDay, 300, 100, 80, 0, nil, true)},
	})
	if _, err := repo.AggregateUsageFacts(context.Background(), 100); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.SQL().Exec(`DELETE FROM usage_events WHERE event_key = 'old-1'`); err != nil {
		t.Fatal(err)
	}
	response, payload = getJSON(t, client, baseURL+"/omc/api/v1/management/insights/clients?preset=90d")
	if response.StatusCode != http.StatusOK {
		t.Fatalf("90d status %d: %s", response.StatusCode, payload)
	}
	var retention insightsClientsResponse
	if err := json.Unmarshal(payload, &retention); err != nil {
		t.Fatal(err)
	}
	if retention.Coverage.RetainedRequests != 6 || retention.Coverage.TotalRequests != 7 {
		t.Fatalf("retention coverage = %+v, want exact retained=6 and total=7", retention.Coverage)
	}

	// Empty window returns empty slice rather than null.
	emptyFrom := now.Add(-10 * 24 * time.Hour).UnixMilli()
	emptyTo := now.Add(-9 * 24 * time.Hour).UnixMilli()
	response, payload = getJSON(t, client, baseURL+"/omc/api/v1/management/insights/clients?from="+url.QueryEscape(strings.TrimSpace(jsonNumber(emptyFrom)))+"&to="+url.QueryEscape(strings.TrimSpace(jsonNumber(emptyTo))))
	if response.StatusCode != http.StatusOK {
		t.Fatalf("empty window status %d: %s", response.StatusCode, payload)
	}
	if !strings.Contains(string(payload), `"clients":[]`) {
		t.Fatalf("empty window must encode clients as []: %s", payload)
	}
}

func TestInsightsAdditiveTokenPartitionsAcrossMixedLegacyAndCanonicalDialects(t *testing.T) {
	shanghai, err := time.LoadLocation("Asia/Shanghai")
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 10, 21, 14, 30, 0, 0, shanghai)
	client, baseURL, repo := startDashboardTestServer(t, nil, func(handler *Handler) {
		handler.nowFn = func() time.Time { return now }
	})
	repo.Timezone().Apply(shanghai)

	slot := time.Date(2026, 10, 21, 10, 1, 0, 0, shanghai)
	ua := "hindsight/1.2.0"
	stamp := func(ev *usage.Event) {
		// Force every record into the exact same 15m bucket AND identical Cube tuple
		// (key, call_point, model, provider, credential, auth_type) so post-SUM
		// heuristic reconstruction would fail if partitions were not folded per event.
		ev.APIGroupKey = "sk-shared-secret-0001"
		ev.APIKeyMask = security.MaskSecret(ev.APIGroupKey)
		ev.Model = "claude-sonnet-4-5"
		ev.Provider = "claude"
		ev.Endpoint = "POST /v1/messages"
		ev.AuthIndex = "auth-shared"
		ev.AuthType = "oauth"
		ev.UserAgent = &ua
	}

	// Row A: legacy inclusive cached_tokens only (900 cached inside 1000 input + 100 output -> prompt 1000, net 200).
	legacyInclusive := eventFor("mix-a", slot, usage.TokenStats{
		InputTokens:  1000,
		CachedTokens: 900,
		OutputTokens: 100,
		TotalTokens:  1100,
	}, false)
	stamp(&legacyInclusive)

	// Row B: canonical v2 breakdown in the same 15m bucket (900 cache_read & cached inside 1000 input + 100 output -> prompt 1000, net 200).
	canonical := eventFor("mix-b", slot.Add(time.Minute), usage.TokenStats{
		InputTokens:     1000,
		CachedTokens:    900,
		CacheReadTokens: 900,
		OutputTokens:    100,
		TotalTokens:     1100,
	}, false)
	stamp(&canonical)
	canonical.Accounting = &usage.TokenAccounting{
		Version: 2,
		Status:  "complete",
		Breakdown: &usage.TokenBreakdown{
			SchemaVersion: 2,
			Quality:       "complete",
			TotalTokens:   1100,
			Input:         usage.TokenInputBreakdown{TotalTokens: 1000, UncachedTokens: 100, CacheReadTokens: 900},
			Output:        usage.TokenOutputBreakdown{TotalTokens: 100, NonReasoningTokens: 100},
		},
	}

	// Row C: legacy Anthropic disjoint prompt with uncached < cache and full total (50 + 900 + 100 + 20 = 1070 -> prompt 1050, net 70).
	legacyDisjointSmall := eventFor("mix-c", slot.Add(2*time.Minute), usage.TokenStats{
		InputTokens:         50,
		CacheReadTokens:     900,
		CacheCreationTokens: 100,
		OutputTokens:        20,
		TotalTokens:         1070,
	}, false)
	stamp(&legacyDisjointSmall)

	// Row D: legacy Anthropic disjoint prompt with uncached > cache and fallback total=input+output (1000 + 100 read + 20 out, total=1020 -> prompt 1100, net 1020).
	legacyDisjointLarge := eventFor("mix-d", slot.Add(3*time.Minute), usage.TokenStats{
		InputTokens:     1000,
		CacheReadTokens: 100,
		OutputTokens:    20,
		TotalTokens:     1020,
	}, false)
	stamp(&legacyDisjointLarge)

	// Row E: legacy Anthropic disjoint prompt with uncached == cache and missing total=0 (200 + 200 read + 30 out -> prompt 400, net 230).
	legacyDisjointEqual := eventFor("mix-e", slot.Add(4*time.Minute), usage.TokenStats{
		InputTokens:     200,
		CacheReadTokens: 200,
		OutputTokens:    30,
		TotalTokens:     0,
	}, false)
	stamp(&legacyDisjointEqual)

	// Row F: legacy inclusive thinking under Claude semantics (100 input + 30 output containing 10 thinking -> completion 30, net 130).
	legacyClaudeThinking := eventFor("mix-f", slot.Add(5*time.Minute), usage.TokenStats{
		InputTokens:     100,
		OutputTokens:    30,
		ReasoningTokens: 10,
		TotalTokens:     130,
	}, false)
	stamp(&legacyClaudeThinking)

	seedEvents(t, repo, now, []repository.UsageDecoded{
		{Event: legacyInclusive},
		{Event: canonical},
		{Event: legacyDisjointSmall},
		{Event: legacyDisjointLarge},
		{Event: legacyDisjointEqual},
		{Event: legacyClaudeThinking},
	})

	// Expected additive totals across all 6 events:
	// PromptTotal     = 1000 + 1000 + 1050 + 1100 + 400 + 100 = 4650
	// CacheRead       =  900 +  900 +  900 +  100 + 200 +   0 = 3000
	// CacheWrite      =    0 +    0 +  100 +    0 +   0 +   0 =  100
	// CompletionTotal =  100 +  100 +   20 +   20 +  30 +  30 =  300
	// UncachedInput   = 4650 - 3000 -  100                    = 1550
	// NetTokens       =  200 +  200 +   70 + 1020 + 230 + 130 = 1850
	// TotalTokens     = 4650 +  300                           = 4950
	assertSnapshot := func(stage, preset string) {
		t.Helper()
		_, clientsPayload := getJSON(t, client, baseURL+"/omc/api/v1/management/insights/clients?preset="+preset)
		var clientsBody insightsClientsResponse
		if err := json.Unmarshal(clientsPayload, &clientsBody); err != nil {
			t.Fatal(err)
		}
		if len(clientsBody.Clients) != 1 || clientsBody.Clients[0].ID != usage.ClientAgentHindsight {
			t.Fatalf("%s/%s clients = %+v", stage, preset, clientsBody.Clients)
		}
		gotClient := clientsBody.Clients[0]
		if gotClient.InputTokens != 4650 || gotClient.OutputTokens != 300 || gotClient.CacheReadTokens != 3000 ||
			gotClient.CacheCreationTokens != 100 || gotClient.TotalTokens != 4950 || gotClient.NetTokens != 1850 {
			t.Fatalf("%s/%s client measures = %+v", stage, preset, gotClient)
		}

		_, cubePayload := getJSON(t, client, baseURL+"/omc/api/v1/management/insights/cube?preset="+preset)
		var cubeBody insightsCubeResponse
		if err := json.Unmarshal(cubePayload, &cubeBody); err != nil {
			t.Fatal(err)
		}
		if len(cubeBody.Rows) != 1 {
			t.Fatalf("%s/%s expected all 6 events merged into 1 cube tuple, got %d rows", stage, preset, len(cubeBody.Rows))
		}
		col := map[string]int{}
		for idx, name := range cubeBody.Columns {
			col[name] = idx
		}
		r := cubeBody.Rows[0]
		if r[col["input_tokens"]] != 4650 || r[col["output_tokens"]] != 300 || r[col["cache_read_tokens"]] != 3000 ||
			r[col["cache_creation_tokens"]] != 100 || r[col["total_tokens"]] != 4950 || r[col["net_tokens"]] != 1850 {
			t.Fatalf("%s/%s cube row = %v", stage, preset, r)
		}

		_, rhythmPayload := getJSON(t, client, baseURL+"/omc/api/v1/management/insights/rhythm?preset="+preset)
		var rhythmBody insightsRhythmResponse
		if err := json.Unmarshal(rhythmPayload, &rhythmBody); err != nil {
			t.Fatal(err)
		}
		var rhythmTotal, rhythmNet int64
		for _, cell := range rhythmBody.Cells {
			rhythmTotal += cell.TotalTokens
			rhythmNet += cell.NetTokens
		}
		if rhythmTotal != 4950 || rhythmNet != 1850 {
			t.Fatalf("%s/%s rhythm total=%d net=%d, want 4950 and 1850", stage, preset, rhythmTotal, rhythmNet)
		}
	}

	assertSnapshot("unfolded", "today")
	if _, err := repo.AggregateUsageFacts(context.Background(), 100); err != nil {
		t.Fatal(err)
	}
	assertSnapshot("folded", "today")
	assertSnapshot("folded", "7d")
}

func TestInsightsClientsCubeAndRhythmPreserveAdditiveTotalAcrossBucketGrains(t *testing.T) {
	now := time.Date(2026, 10, 21, 14, 30, 0, 0, time.UTC)
	client, baseURL, repo := startDashboardTestServer(t, nil, func(handler *Handler) {
		handler.nowFn = func() time.Time { return now }
	})

	at := time.Date(2026, 10, 21, 12, 59, 0, 0, time.UTC)
	// Event A at 12:59 carries an unclassified total surplus (rawTotal=1000 > 120).
	evA := eventFor("total-a", at, usage.TokenStats{InputTokens: 100, OutputTokens: 20, TotalTokens: 1000}, false)
	// Event B at 13:01 carries disjoint Anthropic cache omitted from fallback rawTotal=120 (effectiveTotal=220).
	evB := eventFor("total-b", at.Add(2*time.Minute), usage.TokenStats{InputTokens: 100, OutputTokens: 20, CacheReadTokens: 100, TotalTokens: 120}, false)
	for _, ev := range []*usage.Event{&evA, &evB} {
		ev.Provider = "claude"
		ev.Model = "claude-sonnet"
		ev.Endpoint = "POST /v1/messages"
	}
	seedEvents(t, repo, now, []repository.UsageDecoded{{Event: evA}, {Event: evB}})
	if _, err := repo.AggregateUsageFacts(context.Background(), 100); err != nil {
		t.Fatal(err)
	}

	windowQuery := "from=" + jsonNumber(at.UnixMilli()-1) + "&to=" + jsonNumber(at.Add(3*time.Minute).UnixMilli())
	sumCubeTotal := func(bucket string) int64 {
		t.Helper()
		_, raw := getJSON(t, client, baseURL+"/omc/api/v1/management/insights/cube?"+windowQuery+"&bucket="+bucket)
		var cube insightsCubeResponse
		if err := json.Unmarshal(raw, &cube); err != nil {
			t.Fatal(err)
		}
		col := -1
		for idx, name := range cube.Columns {
			if name == "total_tokens" {
				col = idx
			}
		}
		var sum int64
		for _, row := range cube.Rows {
			sum += row[col]
		}
		return sum
	}

	hourlyTotal := sumCubeTotal("hour")
	dailyTotal := sumCubeTotal("day")

	_, clientsRaw := getJSON(t, client, baseURL+"/omc/api/v1/management/insights/clients?"+windowQuery)
	var clientsBody insightsClientsResponse
	if err := json.Unmarshal(clientsRaw, &clientsBody); err != nil {
		t.Fatal(err)
	}
	var clientTotal int64
	for _, item := range clientsBody.Clients {
		clientTotal += item.TotalTokens
	}

	_, rhythmRaw := getJSON(t, client, baseURL+"/omc/api/v1/management/insights/rhythm?"+windowQuery)
	var rhythmBody insightsRhythmResponse
	if err := json.Unmarshal(rhythmRaw, &rhythmBody); err != nil {
		t.Fatal(err)
	}
	var rhythmTotal int64
	for _, cell := range rhythmBody.Cells {
		rhythmTotal += cell.TotalTokens
	}

	if hourlyTotal != 1220 || dailyTotal != 1220 || clientTotal != 1220 || rhythmTotal != 1220 {
		t.Fatalf("expected additive total 1220 across all views/grains, got hourly=%d daily=%d clients=%d rhythm=%d",
			hourlyTotal, dailyTotal, clientTotal, rhythmTotal)
	}
}

func TestUsageEventsAcceptsLargeProviderCredentialDrillDownUpToCap(t *testing.T) {
	now := time.Date(2026, 10, 21, 14, 30, 0, 0, time.UTC)
	client, baseURL, _ := startDashboardTestServer(t, nil, func(handler *Handler) {
		handler.nowFn = func() time.Time { return now }
	})

	for _, count := range []int{64, 65, repository.MaxUsageEventFilterValues} {
		q := url.Values{
			"from":         []string{jsonNumber(now.Add(-time.Hour).UnixMilli())},
			"to":           []string{jsonNumber(now.UnixMilli())},
			"client_agent": []string{"claude-code"},
		}
		for idx := 0; idx < count; idx++ {
			q.Add("auth_index", fmt.Sprintf("auth-%d", idx))
		}
		res, body := getJSON(t, client, baseURL+"/omc/api/v1/usage/events?"+q.Encode())
		if res.StatusCode != http.StatusOK {
			t.Fatalf("count=%d: expected 200 OK, got %d body=%s", count, res.StatusCode, body)
		}
	}

	over := url.Values{"from": []string{"0"}, "to": []string{"1000"}}
	for idx := 0; idx <= repository.MaxUsageEventFilterValues; idx++ {
		over.Add("auth_index", fmt.Sprintf("auth-%d", idx))
	}
	res, _ := getJSON(t, client, baseURL+"/omc/api/v1/usage/events?"+over.Encode())
	if res.StatusCode != http.StatusBadRequest {
		t.Fatalf("expected 400 past cap %d, got %d", repository.MaxUsageEventFilterValues, res.StatusCode)
	}
}
