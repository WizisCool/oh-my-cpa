package api

import (
	"context"
	"encoding/json"
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
