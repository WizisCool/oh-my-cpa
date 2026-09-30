package api

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
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

// A gated reader makes admission ordering observable without network timing or large allocations.
type browserRunTestBody struct {
	reader     io.Reader
	beforeRead func()
	readCount  atomic.Int32
}

func (body *browserRunTestBody) Read(buffer []byte) (int, error) {
	body.readCount.Add(1)
	if body.beforeRead != nil {
		body.beforeRead()
	}
	return body.reader.Read(buffer)
}

func (body *browserRunTestBody) Close() error { return nil }

func TestBrowserRunRejectsBusyAndClosedBeforeReadingBody(t *testing.T) {
	for _, kind := range []string{"agent", "playground"} {
		t.Run(kind, func(t *testing.T) {
			handler := &Handler{}
			t.Cleanup(handler.CloseBrowserRuns)
			started := make(chan struct{})
			handler.startBrowserRun(kind, func(writer http.ResponseWriter, request *http.Request) {
				close(started)
				<-request.Context().Done()
			}, httptest.NewRecorder(), detachedBrowserRequest("active", `{}`))
			<-started
			for _, isClosed := range []bool{false, true} {
				if isClosed {
					handler.CloseBrowserRuns()
				}
				request := detachedBrowserRequest("competing", `{}`)
				body := &browserRunTestBody{reader: strings.NewReader(`{}`)}
				request.Body = body
				recorder := httptest.NewRecorder()
				handler.startBrowserRun(kind, func(http.ResponseWriter, *http.Request) {
					t.Error("rejected request executed")
				}, recorder, request)
				status, code := 409, kind+"_busy"
				if isClosed {
					status, code = 503, "server_stopping"
				}
				if recorder.Code != status || !strings.Contains(recorder.Body.String(), code) || body.readCount.Load() != 0 {
					t.Fatalf("read rejected body: status=%d code=%s reads=%d", recorder.Code, recorder.Body.String(), body.readCount.Load())
				}
			}
		})
	}
}

func TestBrowserRunBoundsConcurrentSameIDBodyReadsAndReleasesSlots(t *testing.T) {
	for _, kind := range []string{"agent", "playground"} {
		t.Run(kind, func(t *testing.T) {
			handler := &Handler{}
			t.Cleanup(handler.CloseBrowserRuns)
			released := make(chan struct{})
			var releaseOnce sync.Once
			release := func() { releaseOnce.Do(func() { close(released) }) }
			t.Cleanup(release)
			completed := make(chan int, 4)
			for i := 0; i < 4; i++ {
				entered := make(chan struct{})
				var readOnce sync.Once
				body := &browserRunTestBody{reader: strings.NewReader(`invalid`), beforeRead: func() {
					readOnce.Do(func() { close(entered); <-released })
				}}
				request := detachedBrowserRequest("same-id", "")
				request.Body = body
				go func() {
					recorder := httptest.NewRecorder()
					handler.startBrowserRun(kind, func(http.ResponseWriter, *http.Request) { t.Error("invalid body executed") }, recorder, request)
					completed <- recorder.Code
				}()
				<-entered
			}
			request := detachedBrowserRequest("same-id", "")
			body := &browserRunTestBody{reader: strings.NewReader(`{}`)}
			request.Body = body
			recorder := httptest.NewRecorder()
			handler.startBrowserRun(kind, func(http.ResponseWriter, *http.Request) { t.Error("overflow admission executed") }, recorder, request)
			if recorder.Code != 429 || !strings.Contains(recorder.Body.String(), kind+"_busy") || body.readCount.Load() != 0 {
				t.Fatalf("unbounded body admission: status=%d body=%s reads=%d", recorder.Code, recorder.Body.String(), body.readCount.Load())
			}
			release()
			for i := 0; i < 4; i++ {
				if status := <-completed; status != 400 {
					t.Fatalf("invalid body status: %d", status)
				}
			}
			// Invalid input must return its permit rather than exhausting future admission.
			recorder = httptest.NewRecorder()
			request = detachedBrowserRequest("same-id", `{}`)
			handler.startBrowserRun(kind, func(writer http.ResponseWriter, request *http.Request) {
				writer.WriteHeader(200)
			}, recorder, request)
			if recorder.Code != 200 {
				t.Fatalf("body slots were not released: %d %s", recorder.Code, recorder.Body.String())
			}
		})
	}
}

func TestBrowserRunRechecksAdmissionAfterBodyRead(t *testing.T) {
	for _, isClosed := range []bool{false, true} {
		t.Run(fmt.Sprintf("closed-%t", isClosed), func(t *testing.T) {
			handler := &Handler{}
			t.Cleanup(handler.CloseBrowserRuns)
			entered, released := make(chan struct{}), make(chan struct{})
			var readOnce, releaseOnce sync.Once
			release := func() { releaseOnce.Do(func() { close(released) }) }
			t.Cleanup(release)
			request := detachedBrowserRequest("slow", "")
			request.Body = &browserRunTestBody{reader: strings.NewReader(`{}`), beforeRead: func() {
				readOnce.Do(func() { close(entered); <-released })
			}}
			completed := make(chan *httptest.ResponseRecorder, 1)
			go func() {
				recorder := httptest.NewRecorder()
				handler.startBrowserRun("agent", func(http.ResponseWriter, *http.Request) { t.Error("rejected run executed after body read") }, recorder, request)
				completed <- recorder
			}()
			<-entered
			status, code := 409, "agent_busy"
			if isClosed {
				handler.CloseBrowserRuns()
				status, code = 503, "server_stopping"
			} else {
				started := make(chan struct{})
				handler.startBrowserRun("agent", func(writer http.ResponseWriter, request *http.Request) {
					close(started)
					<-request.Context().Done()
				}, httptest.NewRecorder(), detachedBrowserRequest("first-admitted", `{}`))
				<-started
			}
			release()
			recorder := <-completed
			if recorder.Code != status || !strings.Contains(recorder.Body.String(), code) {
				t.Fatalf("missed post-read race: %d %s", recorder.Code, recorder.Body.String())
			}
		})
	}
}

func TestBrowserRunBodyPermitsAreReleasedBeforeSubscriptions(t *testing.T) {
	handler := &Handler{}
	t.Cleanup(handler.CloseBrowserRuns)
	started := make(chan struct{})
	handler.startBrowserRun("agent", func(writer http.ResponseWriter, request *http.Request) {
		close(started)
		<-request.Context().Done()
	}, httptest.NewRecorder(), detachedBrowserRequest("active", `{}`))
	<-started
	for i := 0; i < 5; i++ {
		run := handler.prepareBrowserRun("agent", "active", func(http.ResponseWriter, *http.Request) {
			t.Error("same-id attachment executed again")
		}, httptest.NewRecorder(), detachedBrowserRequest("active", `{}`))
		if run == nil || run.id != "active" || len(handler.browserRuns.bodySlots) != 0 {
			t.Fatal("a subscription retained its body admission permit")
		}
	}
}
