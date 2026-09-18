package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
	"github.com/oh-my-cpa/oh-my-cpa/internal/usage/ingest"
)

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

// fakeUsagePipeline answers the two collector calls the page makes. It records
// the refresh so the test can prove the endpoint is what pulled, not a read.
type fakeUsagePipeline struct {
	status      ingest.PipelineStatus
	refresh     ingest.RefreshNowResult
	refreshErr  error
	refreshCall atomic.Int32
}

func (f *fakeUsagePipeline) Status(context.Context) (ingest.PipelineStatus, error) {
	return f.status, nil
}

func (f *fakeUsagePipeline) RefreshNow(context.Context) (ingest.RefreshNowResult, error) {
	f.refreshCall.Add(1)
	return f.refresh, f.refreshErr
}

func TestUsageIngestRefreshReportsDisabledIngestion(t *testing.T) {
	client, baseURL, _ := startDashboardTestServer(t, nil)
	response, payload := postJSON(t, client, baseURL+"/omc/api/v1/usage/ingest/refresh")
	if response.StatusCode != http.StatusOK {
		t.Fatalf("status = %d body %s", response.StatusCode, payload)
	}
	var body ingest.RefreshNowResult
	if err := json.Unmarshal(payload, &body); err != nil {
		t.Fatal(err)
	}
	if body.Enabled || body.Synced {
		t.Fatalf("a deployment without a collector must not report a sync: %+v", body)
	}
}

func TestUsageIngestRefreshServesTheSyncResult(t *testing.T) {
	pipeline := &fakeUsagePipeline{refresh: ingest.RefreshNowResult{
		Enabled: true, Synced: true, Mode: "subscribe", Captured: 3, Decoded: 3,
	}}
	client, baseURL, _ := startDashboardTestServer(t, nil, func(handler *Handler) {
		handler.SetUsagePipeline(pipeline)
	})

	response, payload := postJSON(t, client, baseURL+"/omc/api/v1/usage/ingest/refresh")
	if response.StatusCode != http.StatusOK {
		t.Fatalf("status = %d body %s", response.StatusCode, payload)
	}
	var body ingest.RefreshNowResult
	if err := json.Unmarshal(payload, &body); err != nil {
		t.Fatal(err)
	}
	if !body.Synced || body.Captured != 3 {
		t.Fatalf("refresh result not served: %+v", body)
	}
	if pipeline.refreshCall.Load() != 1 {
		t.Fatalf("refresh calls = %d, want 1", pipeline.refreshCall.Load())
	}
}

// A collector that could not drain CPA is a 200 with an explanation, not an
// error status: the page still re-reads stored data and needs to say why it may
// be incomplete.
func TestUsageIngestRefreshReportsTransportFailure(t *testing.T) {
	pipeline := &fakeUsagePipeline{
		refresh:    ingest.RefreshNowResult{Enabled: true, Error: "connection refused"},
		refreshErr: errors.New("connection refused"),
	}
	client, baseURL, _ := startDashboardTestServer(t, nil, func(handler *Handler) {
		handler.SetUsagePipeline(pipeline)
	})

	response, payload := postJSON(t, client, baseURL+"/omc/api/v1/usage/ingest/refresh")
	if response.StatusCode != http.StatusOK {
		t.Fatalf("status = %d body %s", response.StatusCode, payload)
	}
	var body ingest.RefreshNowResult
	if err := json.Unmarshal(payload, &body); err != nil {
		t.Fatal(err)
	}
	if body.Synced || body.Error == "" {
		t.Fatalf("a failed sync must explain itself: %+v", body)
	}
}

func TestUsageIngestRefreshRefusesOverlapWithConflict(t *testing.T) {
	pipeline := &fakeUsagePipeline{refreshErr: ingest.ErrRefreshBusy}
	client, baseURL, _ := startDashboardTestServer(t, nil, func(handler *Handler) {
		handler.SetUsagePipeline(pipeline)
	})

	response, payload := postJSON(t, client, baseURL+"/omc/api/v1/usage/ingest/refresh")
	if response.StatusCode != http.StatusConflict {
		t.Fatalf("status = %d body %s, want 409", response.StatusCode, payload)
	}
}

func TestUsageIngestRefreshRequiresSameOrigin(t *testing.T) {
	client, baseURL, _ := startDashboardTestServer(t, nil)
	request, err := http.NewRequest(http.MethodPost, baseURL+"/omc/api/v1/usage/ingest/refresh", nil)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Origin", "https://attacker.example")
	response, err := client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusForbidden {
		t.Fatalf("cross-origin status = %d, want 403", response.StatusCode)
	}
}

// fakeUsageIngest is a real collector over a fake CPA queue, wired the way
// app.New wires it. The mocked-pipeline tests above prove the HTTP contract;
// this one proves the endpoint actually pulls and stores.
type fakeUsageIngest struct {
	mu       sync.Mutex
	batches  [][]string
	served   int
	pipeline *ingest.Pipeline
	runner   *ingest.Runner
}

func (f *fakeUsageIngest) ProbeUsageChannel(context.Context) error {
	return errors.New("no RESP in this fixture")
}

func (f *fakeUsageIngest) OpenUsageStream(context.Context, string) (ingest.Stream, error) {
	return nil, errors.New("no RESP in this fixture")
}

func (f *fakeUsageIngest) PopUsageQueue(context.Context, int) ([]string, error) {
	return f.next(), nil
}

func (f *fakeUsageIngest) UsageQueueJSON(context.Context, int) ([]string, error) {
	return f.next(), nil
}

// next serves one queued HTTP batch, so the test controls exactly when CPA has
// something to hand over.
func (f *fakeUsageIngest) next() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.served++
	if len(f.batches) == 0 {
		return nil
	}
	batch := f.batches[0]
	f.batches = f.batches[1:]
	return batch
}

func (f *fakeUsageIngest) queue(batches ...[]string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.batches = append(f.batches, batches...)
}

func (f *fakeUsageIngest) pollCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.served
}

// waitForInitialPoll blocks until the collector's start-up poll has finished.
// With an hour-long idle interval, nothing after that point can fetch a record
// except a manual sync.
func (f *fakeUsageIngest) waitForInitialPoll(t *testing.T) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if f.pollCount() >= 1 {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("collector never performed its initial poll")
}

// startFakeUsageIngest builds a live pipeline whose collector polls an hour
// apart, so only the manual refresh can explain a record being captured.
func startFakeUsageIngest(t *testing.T, store *repository.Repository) *fakeUsageIngest {
	t.Helper()
	fixture := &fakeUsageIngest{}
	runner, err := ingest.NewRunner("default", fixture, store, nil, slog.New(slog.NewTextHandler(io.Discard, nil)), ingest.Config{
		Mode:            ingest.ModeHTTPPull,
		IdleInterval:    time.Hour,
		MaxIdleInterval: time.Hour,
		BatchSize:       10,
	})
	if err != nil {
		t.Fatal(err)
	}
	processor, err := ingest.NewProcessor(store, slog.New(slog.NewTextHandler(io.Discard, nil)), 10, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	pipeline, err := ingest.NewPipeline(runner, processor, nil, store)
	if err != nil {
		t.Fatal(err)
	}
	fixture.pipeline = pipeline
	fixture.runner = runner
	return fixture
}

func TestUsageIngestRefreshStoresRecordsBeforeItReportsSuccess(t *testing.T) {
	var fixture *fakeUsageIngest
	var store *repository.Repository
	client, baseURL, _ := startDashboardTestServer(t, nil, func(handler *Handler) {
		// The handler owns the repository it queries and the collector writes to;
		// both are the same store, which is what makes this an end-to-end check.
		store = handler.repo
		fixture = startFakeUsageIngest(t, store)
		handler.SetUsagePipeline(fixture.pipeline)
	})
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- fixture.pipeline.Run(ctx) }()
	t.Cleanup(func() {
		cancel()
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			t.Error("pipeline did not stop")
		}
	})

	// CPA accepts a request after the collector has already polled, so this record
	// exists nowhere in Oh My CPA until the refresh pulls it. The first poll is
	// awaited explicitly: queuing earlier would let the background collector win
	// the race and prove nothing about the endpoint.
	fixture.waitForInitialPoll(t)
	fixture.queue([]string{usagePayloadForTest("http-refresh-1")})

	response, payload := postJSON(t, client, baseURL+"/omc/api/v1/usage/ingest/refresh")
	if response.StatusCode != http.StatusOK {
		t.Fatalf("status = %d body %s", response.StatusCode, payload)
	}
	var body ingest.RefreshNowResult
	if err := json.Unmarshal(payload, &body); err != nil {
		t.Fatal(err)
	}
	if !body.Synced || body.Captured != 1 || body.Decoded != 1 {
		t.Fatalf("refresh did not report a stored record: %+v", body)
	}

	// The contract the page depends on: by the time the POST answered, the record
	// is already visible to the list query it runs next.
	var stored int
	if err := store.SQL().QueryRow(
		`SELECT COUNT(1) FROM usage_events WHERE event_key = ?`, "http-refresh-1").Scan(&stored); err != nil {
		t.Fatal(err)
	}
	if stored != 1 {
		t.Fatalf("event rows = %d, want 1 queryable before success returns", stored)
	}
	listResponse, listPayload := getJSON(t, client, baseURL+"/omc/api/v1/usage/events?preset=24h")
	if listResponse.StatusCode != http.StatusOK {
		t.Fatalf("list status = %d body %s", listResponse.StatusCode, listPayload)
	}
	if !strings.Contains(string(listPayload), "http-refresh-1") {
		t.Fatalf("the refreshed record is not in the request list: %s", listPayload)
	}
}

// usagePayloadForTest is a CPA usage record the real decoder accepts.
func usagePayloadForTest(requestID string) string {
	return fmt.Sprintf(`{"request_id":%q,"model":"gemini-2.5-pro","timestamp":%q,"tokens":{"total_tokens":5}}`,
		requestID, time.Now().UTC().Format(time.RFC3339))
}
