package api

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/usage"
	"github.com/oh-my-cpa/oh-my-cpa/internal/usage/ingest"
)

type routingResponse struct {
	WindowMS int64 `json:"window_ms"`
	Records  []struct {
		ID        int64  `json:"id"`
		RequestID string `json:"request_id"`
		Model     string `json:"model"`
		AuthIndex string `json:"auth_index"`
	} `json:"records"`
	HasMore   bool `json:"has_more"`
	Cooldowns []struct {
		AuthIndex string `json:"auth_index"`
		UntilMS   int64  `json:"until_at_ms"`
	} `json:"cooldowns"`
}

func routingEvent(requestID, authIndex string, at time.Time, latency int64, failed bool) usage.Event {
	event := eventFor(requestID+"-"+authIndex, at, usage.TokenStats{TotalTokens: 10}, failed)
	event.RequestID = requestID
	event.AuthIndex = authIndex
	event.LatencyMS = latency
	return event
}

func readRouting(t *testing.T, client *http.Client, url string) routingResponse {
	t.Helper()
	response, payload := getJSON(t, client, url)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("status = %d: %s", response.StatusCode, payload)
	}
	var routing routingResponse
	if err := json.Unmarshal(payload, &routing); err != nil {
		t.Fatal(err)
	}
	return routing
}

// The routing window holds the attempts that finished in the last minute, read
// back from request records (one per attempt), newest arrival first. An attempt
// belongs to the minute it finished in: a long request that started three
// minutes ago and just answered is on the panel, a short one from two minutes
// ago is not. With `after` the answer is only what was recorded since, which is
// how the panel follows the live stream.
func TestUsageRoutingReadsTheRollingMinuteOfAttempts(t *testing.T) {
	client, baseURL, repo := startDashboardTestServer(t, nil)
	ctx := context.Background()
	now := time.Now().UTC()
	if _, err := repo.InsertUsageEvents(ctx, []usage.Event{
		routingEvent("req-old", "auth-1", now.Add(-2*time.Minute), 250, false),
		routingEvent("req-a", "auth-1", now.Add(-40*time.Second), 250, true),
		routingEvent("req-a", "auth-2", now.Add(-39*time.Second), 250, false),
		routingEvent("req-long", "auth-2", now.Add(-3*time.Minute), (150 * time.Second).Milliseconds(), false),
	}); err != nil {
		t.Fatal(err)
	}
	future := now.Add(30 * time.Second).UnixMilli()
	past := now.Add(-30 * time.Second).UnixMilli()
	for _, event := range []usage.ErrorEvent{
		{InstanceID: "default", EventKey: "err-1", AuthIndex: "auth-1", StatusCode: 429, NextRetryAfterMS: &future, TimestampMS: now.Add(-40 * time.Second).UnixMilli()},
		// auth-2's older cooldown is superseded by its newer error, which has none.
		{InstanceID: "default", EventKey: "err-2", AuthIndex: "auth-2", StatusCode: 429, NextRetryAfterMS: &future, TimestampMS: now.Add(-5 * time.Minute).UnixMilli()},
		{InstanceID: "default", EventKey: "err-3", AuthIndex: "auth-2", StatusCode: 500, NextRetryAfterMS: &past, TimestampMS: now.Add(-4 * time.Minute).UnixMilli()},
	} {
		if err := repo.InsertErrorEvent(ctx, event); err != nil {
			t.Fatal(err)
		}
	}

	routing := readRouting(t, client, baseURL+"/omc/api/v1/usage/routing")
	if routing.WindowMS != USAGE_ROUTING_WINDOW.Milliseconds() {
		t.Fatalf("window_ms = %d", routing.WindowMS)
	}
	got := []string{}
	for _, record := range routing.Records {
		got = append(got, record.RequestID+"@"+record.AuthIndex)
	}
	want := []string{"req-long@auth-2", "req-a@auth-2", "req-a@auth-1"}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("records = %v, want %v (newest arrival first, by finish time)", got, want)
	}
	if routing.HasMore {
		t.Fatal("a window under the limit reported more")
	}
	if len(routing.Cooldowns) != 1 || routing.Cooldowns[0].AuthIndex != "auth-1" || routing.Cooldowns[0].UntilMS != future {
		t.Fatalf("cooldowns = %+v, want only auth-1 until %d", routing.Cooldowns, future)
	}

	newest := routing.Records[0].ID
	if _, err := repo.InsertUsageEvents(ctx, []usage.Event{routingEvent("req-b", "auth-1", now, 250, false)}); err != nil {
		t.Fatal(err)
	}
	since := readRouting(t, client, fmt.Sprintf("%s/omc/api/v1/usage/routing?after=%d", baseURL, newest))
	if len(since.Records) != 1 || since.Records[0].RequestID != "req-b" {
		t.Fatalf("after=%d answered %+v, want only req-b", newest, since.Records)
	}

	if response, _ := getJSON(t, client, baseURL+"/omc/api/v1/usage/routing?after=x"); response.StatusCode != http.StatusBadRequest {
		t.Fatalf("a malformed after answered %d", response.StatusCode)
	}
}

func TestUsageLiveAnswersNoContentWithoutACollector(t *testing.T) {
	client, baseURL, _ := startDashboardTestServer(t, nil)
	response, _ := getJSON(t, client, baseURL+"/omc/api/v1/usage/live")
	if response.StatusCode != http.StatusNoContent {
		t.Fatalf("status = %d, want 204 so EventSource stops and the page keeps polling", response.StatusCode)
	}
}

type liveTestPipeline struct {
	usagePipeline
	changes *ingest.Changes
}

func (p liveTestPipeline) SubscribeChanges() (<-chan struct{}, func(), error) {
	return p.changes.Subscribe()
}

// Past the reader limit the stream refuses with 503 and the error contract, which
// is what tells the browser to keep polling and retry later rather than hold a
// connection the server will not serve.
func TestUsageLiveRefusesReadersPastTheLimit(t *testing.T) {
	changes := ingest.NewChanges()
	for range ingest.MAX_CHANGE_SUBSCRIBERS {
		_, unsubscribe, err := changes.Subscribe()
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(unsubscribe)
	}
	client, baseURL, _ := startDashboardTestServer(t, nil, func(handler *Handler) {
		handler.SetUsagePipeline(liveTestPipeline{changes: changes})
	})
	response, payload := getJSON(t, client, baseURL+"/omc/api/v1/usage/live")
	if response.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", response.StatusCode)
	}
	var body struct {
		Error string `json:"error"`
	}
	if err := json.Unmarshal(payload, &body); err != nil || body.Error != ingest.ErrTooManySubscribers.Error() {
		t.Fatalf("body = %s (%v)", payload, err)
	}
}

func TestUsageLiveSignalsAStoredChange(t *testing.T) {
	changes := ingest.NewChanges()
	client, baseURL, _ := startDashboardTestServer(t, nil, func(handler *Handler) {
		handler.SetUsagePipeline(liveTestPipeline{changes: changes})
	})
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, baseURL+"/omc/api/v1/usage/live", nil)
	if err != nil {
		t.Fatal(err)
	}
	response, err := client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK || !strings.HasPrefix(response.Header.Get("Content-Type"), "text/event-stream") {
		t.Fatalf("status = %d, content type = %q", response.StatusCode, response.Header.Get("Content-Type"))
	}
	reader := bufio.NewReader(response.Body)
	readEvent := func() string {
		for {
			line, errRead := reader.ReadString('\n')
			if errRead != nil {
				t.Fatalf("stream ended: %v", errRead)
			}
			if name, ok := strings.CutPrefix(strings.TrimSpace(line), "event: "); ok {
				return name
			}
		}
	}
	// `ready` is what makes a reconnect safe: the page re-reads on it, covering
	// whatever changed while it was disconnected.
	if name := readEvent(); name != "ready" {
		t.Fatalf("first event = %q, want ready", name)
	}
	changes.Publish()
	if name := readEvent(); name != "usage" {
		t.Fatalf("event after a publish = %q, want usage", name)
	}
}
