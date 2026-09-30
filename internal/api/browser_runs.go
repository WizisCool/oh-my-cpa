package api

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/gateway"
)

const (
	BROWSER_RUN_BYTES     = 4 << 20
	BROWSER_RUN_RETENTION = 15 * time.Minute
)

var BROWSER_RUN_ID = regexp.MustCompile(`^[a-zA-Z0-9_-]{1,96}$`)

// One bounded journal per workspace. Its writer belongs to the task, never to a browser socket;
// subscribers replay from a byte cursor and wait on notifications without blocking inference.
type browserRun struct {
	mu           sync.Mutex
	header       http.Header
	frozenHeader http.Header
	kind         string
	status       int
	body         []byte
	changed      chan struct{}
	isDone       bool
	isOverflowed bool
	endedAt      time.Time
	cancel       context.CancelFunc
	id           string
	startedAt    int64
	input        json.RawMessage
	digest       [32]byte
	finished     chan struct{}
}

type browserRuns struct {
	mu       sync.Mutex
	latest   map[string]*browserRun
	retired  map[string]time.Time
	workers  sync.WaitGroup
	isClosed bool
}

func (run *browserRun) Header() http.Header { return run.header }
func (run *browserRun) notify()             { close(run.changed); run.changed = make(chan struct{}) }
func (run *browserRun) WriteHeader(status int) {
	run.mu.Lock()
	defer run.mu.Unlock()
	if run.status == 0 {
		run.status = status
		run.frozenHeader = run.header.Clone()
		run.notify()
	}
}
func (run *browserRun) Write(body []byte) (int, error) {
	run.mu.Lock()
	defer run.mu.Unlock()
	if run.isOverflowed {
		return 0, errors.New("response_too_large")
	}
	if run.status == 0 {
		run.status = http.StatusOK
		run.frozenHeader = run.header.Clone()
	}
	if len(run.body)+len(body) > BROWSER_RUN_BYTES {
		run.isOverflowed = true
		if strings.HasPrefix(run.frozenHeader.Get("Content-Type"), "text/event-stream") {
			terminal := "event: error\ndata: {\"code\":\"response_too_large\"}\n\n"
			if run.kind == "agent" {
				terminal = "data: {\"type\":\"RUN_ERROR\",\"code\":\"response_too_large\",\"message\":\"response_too_large\"}\n\n"
			}
			run.body = append(run.body, terminal...)
		}
		run.notify()
		run.cancel()
		return 0, errors.New("run_output_too_large")
	}
	run.body = append(run.body, body...)
	run.notify()
	return len(body), nil
}
func (run *browserRun) Flush()                           {}
func (run *browserRun) SetWriteDeadline(time.Time) error { return nil }
func (run *browserRun) finish() {
	run.mu.Lock()
	defer run.mu.Unlock()
	run.isDone = true
	run.endedAt = time.Now()
	if run.status == 0 {
		run.status = http.StatusOK
	}
	run.notify()
	close(run.finished)
}

func (runs *browserRuns) find(kind, id string) *browserRun {
	runs.mu.Lock()
	defer runs.mu.Unlock()
	run := runs.latest[kind]
	if run == nil || (id != "" && run.id != id) {
		return nil
	}
	run.mu.Lock()
	isExpired := run.isDone && time.Since(run.endedAt) > BROWSER_RUN_RETENTION
	run.mu.Unlock()
	if isExpired {
		if runs.retired == nil {
			runs.retired = map[string]time.Time{}
		}
		runs.retired[kind+":"+run.id] = time.Now()
		delete(runs.latest, kind)
		return nil
	}
	return run
}

func (h *Handler) startBrowserRun(kind string, next http.HandlerFunc, writer http.ResponseWriter, request *http.Request) {
	id := request.Header.Get("X-OMC-Run-ID")
	// Keep the existing direct stream available to non-console clients. Console runs always carry
	// an id so a lost POST response can be recovered without duplicating a paid request or write.
	if id == "" {
		next(writer, request)
		return
	}
	if !BROWSER_RUN_ID.MatchString(id) {
		writePlaygroundError(writer, 400, "invalid_parameters")
		return
	}
	if h.cfg.IsDemoMode {
		next(writer, request)
		return
	}
	limit := int64(gateway.MaxRequestBytes)
	if kind == "agent" {
		limit = 64 << 10
	}
	body, err := io.ReadAll(http.MaxBytesReader(writer, request.Body, limit))
	if err != nil {
		writePlaygroundError(writer, 413, "request_too_large")
		return
	}
	if !json.Valid(body) {
		writePlaygroundError(writer, 400, "invalid_request")
		return
	}
	digest := sha256.Sum256(body)
	h.browserRuns.mu.Lock()
	if h.browserRuns.isClosed {
		h.browserRuns.mu.Unlock()
		writePlaygroundError(writer, 503, "server_stopping")
		return
	}
	if h.browserRuns.latest == nil {
		h.browserRuns.latest = map[string]*browserRun{}
		h.browserRuns.retired = map[string]time.Time{}
	}
	if previous := h.browserRuns.latest[kind]; previous != nil {
		previous.mu.Lock()
		isExpired := previous.isDone && time.Since(previous.endedAt) > BROWSER_RUN_RETENTION
		previous.mu.Unlock()
		if isExpired {
			h.browserRuns.retired[kind+":"+previous.id] = time.Now()
			delete(h.browserRuns.latest, kind)
		}
	}
	for key, retiredAt := range h.browserRuns.retired {
		if time.Since(retiredAt) > 24*time.Hour {
			delete(h.browserRuns.retired, key)
		}
	}
	if _, isRetired := h.browserRuns.retired[kind+":"+id]; isRetired {
		h.browserRuns.mu.Unlock()
		writePlaygroundError(writer, 409, "run_expired")
		return
	}
	existing := h.browserRuns.latest[kind]
	if existing != nil {
		existing.mu.Lock()
		isActive := !existing.isDone
		existing.mu.Unlock()
		if existing.id == id {
			h.browserRuns.mu.Unlock()
			if existing.digest != digest {
				writePlaygroundError(writer, 409, "run_id_conflict")
				return
			}
			existing.serve(writer, request)
			return
		}
		if isActive {
			h.browserRuns.mu.Unlock()
			writePlaygroundError(writer, 409, kind+"_busy")
			return
		}
	}
	// Retiring an id promises that a delayed POST cannot execute it again within the window.
	// Refuse admission at the bound instead of evicting that promise to make room for new work.
	if len(h.browserRuns.retired)+len(h.browserRuns.latest) >= 1024 {
		h.browserRuns.mu.Unlock()
		writePlaygroundError(writer, 429, "run_history_full")
		return
	}
	if existing != nil {
		h.browserRuns.retired[kind+":"+existing.id] = time.Now()
	}
	ctx, cancel := context.WithTimeout(context.WithoutCancel(request.Context()), 30*time.Minute)
	run := &browserRun{kind: kind, header: http.Header{}, changed: make(chan struct{}), cancel: cancel, id: id, startedAt: time.Now().UnixMilli(), digest: digest, finished: make(chan struct{})}
	if kind == "playground" {
		run.input = playgroundRecoveryTurn(body, id, run.startedAt)
	}
	h.browserRuns.latest[kind] = run
	h.browserRuns.workers.Add(1)
	h.browserRuns.mu.Unlock()
	detached := request.Clone(ctx)
	detached.Body = io.NopCloser(bytes.NewReader(body))
	go func() {
		defer h.browserRuns.workers.Done()
		defer cancel()
		defer run.finish()
		// A detached worker is outside net/http's panic boundary. Keep the task failure inside
		// that same boundary without putting panic values (which may contain data) in logs.
		defer func() {
			if recover() != nil {
				run.cancel()
				run.mu.Lock()
				status, isStream := run.status, strings.HasPrefix(run.frozenHeader.Get("Content-Type"), "text/event-stream")
				run.mu.Unlock()
				if status == 0 {
					writePlaygroundError(run, 500, "gateway_unavailable")
				} else if isStream {
					terminal := "event: error\ndata: {\"code\":\"gateway_unavailable\"}\n\n"
					if kind == "agent" {
						terminal = "data: {\"type\":\"RUN_ERROR\",\"code\":\"gateway_unavailable\",\"message\":\"gateway_unavailable\"}\n\n"
					}
					_, _ = io.WriteString(run, terminal)
				}
				if h.logger != nil {
					h.logger.Error("browser run failed", "workspace", kind)
				}
			}
		}()
		next(run, detached)
	}()
	run.serve(writer, request)
}

func (run *browserRun) serve(writer http.ResponseWriter, request *http.Request) {
	controller := http.NewResponseController(writer)
	cursor := 0
	hasStarted := false
	heartbeat := time.NewTicker(15 * time.Second)
	defer heartbeat.Stop()
	for {
		run.mu.Lock()
		status, isDone, changed := run.status, run.isDone, run.changed
		var headers http.Header
		if !hasStarted && status != 0 {
			headers = run.frozenHeader.Clone()
		}
		if cursor > len(run.body) {
			cursor = len(run.body)
		}
		chunk := append([]byte(nil), run.body[cursor:]...)
		cursor = len(run.body)
		run.mu.Unlock()
		if !hasStarted && status != 0 {
			for key, values := range headers {
				writer.Header()[key] = values
			}
			writer.Header().Set("Cache-Control", "no-store")
			writer.Header().Set("X-OMC-Run-ID", run.id)
			writer.WriteHeader(status)
			hasStarted = true
		}
		if len(chunk) > 0 {
			_ = controller.SetWriteDeadline(time.Now().Add(30 * time.Second))
			if _, err := writer.Write(chunk); err != nil {
				return
			}
			if err := controller.Flush(); err != nil {
				return
			}
		}
		if isDone {
			return
		}
		select {
		case <-request.Context().Done():
			return
		case <-changed:
		case <-heartbeat.C:
			if hasStarted && strings.HasPrefix(writer.Header().Get("Content-Type"), "text/event-stream") {
				_ = controller.SetWriteDeadline(time.Now().Add(30 * time.Second))
				if _, err := io.WriteString(writer, ": heartbeat\n\n"); err != nil {
					return
				}
				if err := controller.Flush(); err != nil {
					return
				}
			}
		}
	}
}

func (h *Handler) startAgentRun(writer http.ResponseWriter, request *http.Request) {
	h.startBrowserRun("agent", h.runAgent, writer, request)
}
func (h *Handler) startPlaygroundRun(writer http.ResponseWriter, request *http.Request) {
	h.startBrowserRun("playground", h.chatPlayground, writer, request)
}
func (h *Handler) browserRunKind(request *http.Request) string {
	if chi.URLParam(request, "workspace") == "playground" {
		return "playground"
	}
	return "agent"
}
func (h *Handler) currentBrowserRun(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	run := h.browserRuns.find(h.browserRunKind(request), "")
	if run == nil {
		writeJSON(writer, 200, map[string]any{"run": nil})
		return
	}
	run.mu.Lock()
	isRunning := !run.isDone
	input := run.input
	if run.isDone && (run.status >= 400 || !strings.HasPrefix(run.frozenHeader.Get("Content-Type"), "text/event-stream")) {
		input = nil
	}
	run.mu.Unlock()
	writeJSON(writer, 200, map[string]any{"run": map[string]any{"id": run.id, "started_at_ms": run.startedAt, "is_running": isRunning, "request": input}})
}
func (h *Handler) subscribeBrowserRun(writer http.ResponseWriter, request *http.Request) {
	run := h.browserRuns.find(h.browserRunKind(request), chi.URLParam(request, "id"))
	if run == nil {
		writePlaygroundError(writer, 404, "run_not_found")
		return
	}
	run.serve(writer, request)
}
func (h *Handler) cancelBrowserRun(writer http.ResponseWriter, request *http.Request) {
	run := h.browserRuns.find(h.browserRunKind(request), chi.URLParam(request, "id"))
	if run == nil {
		writePlaygroundError(writer, 404, "run_not_found")
		return
	}
	run.mu.Lock()
	isRunning := !run.isDone
	run.mu.Unlock()
	if isRunning {
		run.cancel()
	}
	writeJSON(writer, 200, map[string]bool{"is_cancelled": isRunning})
}

// CloseBrowserRuns stops admission and joins detached work before its database and upstream
// dependencies close. Browser disconnection is not shutdown; only the application owns this call.
func (h *Handler) CloseBrowserRuns() {
	if h == nil {
		return
	}
	h.browserRuns.mu.Lock()
	h.browserRuns.isClosed = true
	for _, run := range h.browserRuns.latest {
		run.cancel()
	}
	h.browserRuns.mu.Unlock()
	h.browserRuns.workers.Wait()
}
