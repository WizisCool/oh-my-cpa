package api

import (
	"encoding/json"
	"net/http"
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
		{"today grows and compares against the same hours of yesterday", "today", wednesday, shanghai,
			local(shanghai, 2026, 10, 21, 0, 0), wednesday.UnixMilli(), true,
			local(shanghai, 2026, 10, 20, 0, 0), local(shanghai, 2026, 10, 20, 14, 30), insightsBucketHour},
		{"yesterday is closed", "yesterday", wednesday, shanghai,
			local(shanghai, 2026, 10, 20, 0, 0), local(shanghai, 2026, 10, 21, 0, 0) - 1, false,
			local(shanghai, 2026, 10, 19, 0, 0), local(shanghai, 2026, 10, 20, 0, 0) - 1, insightsBucketHour},
		{"this week starts on Monday", "this_week", wednesday, shanghai,
			local(shanghai, 2026, 10, 19, 0, 0), wednesday.UnixMilli(), true,
			local(shanghai, 2026, 10, 12, 0, 0), local(shanghai, 2026, 10, 14, 14, 30), insightsBucketDay},
		{"last week", "last_week", wednesday, shanghai,
			local(shanghai, 2026, 10, 12, 0, 0), local(shanghai, 2026, 10, 19, 0, 0) - 1, false,
			local(shanghai, 2026, 10, 5, 0, 0), local(shanghai, 2026, 10, 12, 0, 0) - 1, insightsBucketDay},
		{"this month", "this_month", wednesday, shanghai,
			local(shanghai, 2026, 10, 1, 0, 0), wednesday.UnixMilli(), true,
			local(shanghai, 2026, 9, 1, 0, 0), local(shanghai, 2026, 9, 21, 14, 30), insightsBucketDay},
		{"last month", "last_month", wednesday, shanghai,
			local(shanghai, 2026, 9, 1, 0, 0), local(shanghai, 2026, 10, 1, 0, 0) - 1, false,
			local(shanghai, 2026, 8, 1, 0, 0), local(shanghai, 2026, 9, 1, 0, 0) - 1, insightsBucketDay},
		{"the 31st compares against the end of a shorter month", "this_month", time.Date(2026, 3, 31, 9, 0, 0, 0, shanghai), shanghai,
			local(shanghai, 2026, 3, 1, 0, 0), local(shanghai, 2026, 3, 31, 9, 0), true,
			local(shanghai, 2026, 2, 1, 0, 0), local(shanghai, 2026, 2, 28, 9, 0), insightsBucketDay},
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
	// Yesterday up to 14:30, not the evening record after it.
	if len(body.PreviousRows) != 1 || body.PreviousRows[0][column["total_tokens"]-1] != 500 {
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
}
