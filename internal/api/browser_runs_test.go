package api

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func detachedBrowserRequest(id, body string) *http.Request {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	request := httptest.NewRequest(http.MethodPost, "/run", strings.NewReader(body)).WithContext(ctx)
	request.Header.Set("X-OMC-Run-ID", id)
	return request
}

func TestBrowserRunDisconnectReplayAdmissionAndShutdown(t *testing.T) {
	handler := &Handler{}
	var calls atomic.Int32
	started, released := make(chan struct{}), make(chan struct{})
	handler.startBrowserRun("agent", func(writer http.ResponseWriter, request *http.Request) {
		calls.Add(1)
		writer.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(writer, "data: {\"type\":\"RUN_STARTED\"}\n\n")
		close(started)
		<-released
		if request.Context().Err() != nil {
			t.Error("socket loss cancelled inference")
		}
		_, _ = io.WriteString(writer, "data: {\"type\":\"RUN_FINISHED\"}\n\n")
	}, httptest.NewRecorder(), detachedBrowserRequest("original", `{}`))
	<-started
	run := handler.browserRuns.find("agent", "original")
	duplicate := httptest.NewRecorder()
	handler.startBrowserRun("agent", func(http.ResponseWriter, *http.Request) { t.Error("duplicate execution") }, duplicate, detachedBrowserRequest("original", `{}`))
	if duplicate.Code != 200 || duplicate.Header().Get("X-OMC-Run-ID") != "original" || !strings.Contains(duplicate.Body.String(), "RUN_STARTED") {
		t.Fatalf("same-id POST did not attach: %d %s", duplicate.Code, duplicate.Body.String())
	}
	for _, input := range []struct{ id, body, code string }{{"original", `{"different":true}`, "run_id_conflict"}, {"second", `{}`, "agent_busy"}} {
		recorder := httptest.NewRecorder()
		handler.startBrowserRun("agent", func(http.ResponseWriter, *http.Request) { t.Error("conflicting execution") }, recorder, detachedBrowserRequest(input.id, input.body))
		if recorder.Code != 409 || !strings.Contains(recorder.Body.String(), input.code) {
			t.Fatalf("admission: %d %s", recorder.Code, recorder.Body.String())
		}
	}
	close(released)
	<-run.finished
	for i := 0; i < 2; i++ {
		recorder := httptest.NewRecorder()
		run.serve(recorder, httptest.NewRequest("GET", "/run", nil))
		if strings.Count(recorder.Body.String(), "RUN_STARTED") != 1 || strings.Count(recorder.Body.String(), "RUN_FINISHED") != 1 || recorder.Header().Get("X-OMC-Run-ID") != "original" {
			t.Fatalf("replay: %s", recorder.Body.String())
		}
	}
	if calls.Load() != 1 {
		t.Fatalf("paid calls: %d", calls.Load())
	}
	handler.CloseBrowserRuns()
	recorder := httptest.NewRecorder()
	handler.startBrowserRun("agent", func(http.ResponseWriter, *http.Request) { t.Error("admission after shutdown") }, recorder, detachedBrowserRequest("third", `{}`))
	if recorder.Code != 503 {
		t.Fatalf("shutdown: %d", recorder.Code)
	}
}

func TestBrowserRunExplicitCancellationAndExpiry(t *testing.T) {
	handler := &Handler{}
	entered, cancelled := make(chan struct{}), make(chan struct{})
	handler.startBrowserRun("playground", func(writer http.ResponseWriter, request *http.Request) {
		close(entered)
		<-request.Context().Done()
		close(cancelled)
	}, httptest.NewRecorder(), detachedBrowserRequest("cancel-me", `{}`))
	<-entered
	run := handler.browserRuns.find("playground", "cancel-me")
	run.cancel()
	<-cancelled
	<-run.finished
	run.mu.Lock()
	run.endedAt = time.Now().Add(-BROWSER_RUN_RETENTION - time.Second)
	run.mu.Unlock()
	if handler.browserRuns.find("playground", "cancel-me") != nil {
		t.Fatal("expired journal retained")
	}
	recorder := httptest.NewRecorder()
	handler.startBrowserRun("playground", func(http.ResponseWriter, *http.Request) { t.Error("expired id restarted") }, recorder, detachedBrowserRequest("cancel-me", `{}`))
	if recorder.Code != 409 || !strings.Contains(recorder.Body.String(), "run_expired") {
		t.Fatalf("expired admission: %s", recorder.Body.String())
	}
	handler.CloseBrowserRuns()
}

func TestBrowserRunShutdownJoinsInference(t *testing.T) {
	handler := &Handler{}
	entered, joined := make(chan struct{}), make(chan struct{})
	handler.startBrowserRun("agent", func(writer http.ResponseWriter, request *http.Request) {
		close(entered)
		<-request.Context().Done()
		close(joined)
	}, httptest.NewRecorder(), detachedBrowserRequest("shutdown", `{}`))
	<-entered
	handler.CloseBrowserRuns()
	select {
	case <-joined:
	default:
		t.Fatal("shutdown returned before inference")
	}
}

func TestBrowserRunOutputBoundSettlesBothProtocols(t *testing.T) {
	for _, kind := range []string{"agent", "playground"} {
		ctx, cancel := context.WithCancel(context.Background())
		run := &browserRun{kind: kind, header: http.Header{"Content-Type": []string{"text/event-stream"}}, changed: make(chan struct{}), finished: make(chan struct{}), cancel: cancel}
		_, _ = run.Write([]byte("data: {}\n\n"))
		if _, err := run.Write(make([]byte, BROWSER_RUN_BYTES)); err == nil {
			t.Fatal("unbounded output")
		}
		if ctx.Err() != context.Canceled || !strings.Contains(string(run.body), "response_too_large") || len(run.body) > BROWSER_RUN_BYTES+256 {
			t.Fatal("overflow did not settle bounded journal")
		}
		run.finish()
	}
}

func TestPlaygroundRecoveryUsesActualRequestAndRedactsImages(t *testing.T) {
	raw := `{"model":"actual","client_key_fingerprint":"fingerprint","messages":[{"role":"user","content":[{"type":"image_url","image_url":{"url":"data:image/png;base64,` + strings.Repeat("X", 20000) + `"}}]}],"recovery_turn":{"id":"invented","reply":"invented","keyLabel":"visible","replaces_id":"previous"}}`
	turn := playgroundRecoveryTurn([]byte(raw), "authoritative", 100)
	var decoded map[string]any
	if json.Unmarshal(turn, &decoded) != nil {
		t.Fatalf("invalid recovery: %s", turn)
	}
	if decoded["id"] != "authoritative" || decoded["status"] != "running" || decoded["reply"] != "" || decoded["replaces_id"] != "previous" || strings.Contains(string(turn), strings.Repeat("X", 20000)) {
		t.Fatalf("untrusted recovery: %s", turn)
	}
}

func TestBrowserRunAdmissionRetainsTheDedupeWindowAtCapacity(t *testing.T) {
	handler := &Handler{browserRuns: browserRuns{latest: map[string]*browserRun{}, retired: map[string]time.Time{}}}
	for i := 0; i < 1024; i++ {
		handler.browserRuns.retired[fmt.Sprintf("agent:old-%d", i)] = time.Now()
	}
	recorder := httptest.NewRecorder()
	handler.startBrowserRun("agent", func(http.ResponseWriter, *http.Request) { t.Error("capacity admission") }, recorder, detachedBrowserRequest("new", `{}`))
	if recorder.Code != 429 || !strings.Contains(recorder.Body.String(), "run_history_full") {
		t.Fatalf("capacity: %d %s", recorder.Code, recorder.Body.String())
	}
	recorder = httptest.NewRecorder()
	handler.startBrowserRun("agent", func(http.ResponseWriter, *http.Request) { t.Error("retired execution") }, recorder, detachedBrowserRequest("old-0", `{}`))
	if recorder.Code != 409 || !strings.Contains(recorder.Body.String(), "run_expired") {
		t.Fatalf("lost dedupe promise: %d %s", recorder.Code, recorder.Body.String())
	}
}

func TestBrowserRunCancelAcknowledgesOnlyAnUnfinishedTask(t *testing.T) {
	fixture := newProviderTestFixture(t)
	entered := make(chan struct{})
	fixture.handler.startBrowserRun("agent", func(writer http.ResponseWriter, request *http.Request) { close(entered); <-request.Context().Done() }, httptest.NewRecorder(), detachedBrowserRequest("stop-target", `{}`))
	<-entered
	response, body := doJSON(t, fixture.client, "POST", fixture.baseURL+"/omc/api/v1/agent/runs/stop-target/cancel", `{}`)
	if response.StatusCode != 200 || !strings.Contains(string(body), `"is_cancelled":true`) {
		t.Fatalf("stop: %d %s", response.StatusCode, body)
	}
	<-fixture.handler.browserRuns.find("agent", "stop-target").finished
	response, body = doJSON(t, fixture.client, "POST", fixture.baseURL+"/omc/api/v1/agent/runs/stop-target/cancel", `{}`)
	if response.StatusCode != 200 || !strings.Contains(string(body), `"is_cancelled":false`) {
		t.Fatalf("settled stop: %d %s", response.StatusCode, body)
	}
	fixture.handler.CloseBrowserRuns()
}

func TestBrowserRunWorkerKeepsTheHTTPPanicBoundary(t *testing.T) {
	handler := &Handler{}
	handler.startBrowserRun("agent", func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(writer, "data: {}\n\n")
		panic("private panic value")
	}, httptest.NewRecorder(), detachedBrowserRequest("panic", `{}`))
	run := handler.browserRuns.find("agent", "panic")
	<-run.finished
	recorder := httptest.NewRecorder()
	run.serve(recorder, httptest.NewRequest("GET", "/", nil))
	if !strings.Contains(recorder.Body.String(), "RUN_ERROR") || strings.Contains(recorder.Body.String(), "private panic value") {
		t.Fatalf("panic projection: %s", recorder.Body.String())
	}
	handler.CloseBrowserRuns()
}
