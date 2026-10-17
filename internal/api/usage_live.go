package api

import (
	"errors"
	"io"
	"net/http"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/usage/ingest"
)

const (
	// USAGE_LIVE_HEARTBEAT keeps idle intermediaries from closing a quiet stream
	// and lets a write to a vanished reader fail within a bounded time.
	USAGE_LIVE_HEARTBEAT = 20 * time.Second
	// USAGE_LIVE_LIFETIME ends every stream after a while so the browser
	// reconnects through the ordinary authentication middleware: a session that
	// was signed out or expired cannot keep a stream it opened earlier.
	USAGE_LIVE_LIFETIME = 5 * time.Minute
	// USAGE_LIVE_MIN_GAP is the shortest spacing between two signals to one
	// reader. Under a burst every reader would otherwise re-read once per decode
	// pass; signals that arrive inside the gap merge into the next one, so the
	// reader still sees the burst, at a bounded read rate.
	USAGE_LIVE_MIN_GAP = 250 * time.Millisecond
	// usageLiveWriteDeadline bounds one write to a slow reader.
	usageLiveWriteDeadline = 10 * time.Second
)

// usageChangeSource is the part of the pipeline the live stream reads.
type usageChangeSource interface {
	SubscribeChanges() (<-chan struct{}, func(), error)
}

// usageLive streams "stored usage data changed" signals as server-sent events.
//
// The stream carries no records - only `event: usage` with an empty object - so
// it needs no projection of its own and cannot widen what a reader may see: on a
// signal the page re-reads the ordinary endpoints with its own filters and
// cursor. A reader that missed signals while reconnecting re-reads on `ready`.
//
// 204 means "this deployment has no live source" (ingestion off, or demonstration
// mode), which EventSource treats as final; the page then keeps its
// polling fallback. 503 means the reader limit is reached.
func (h *Handler) usageLive(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	source, ok := h.usage.(usageChangeSource)
	if h.cfg.IsDemoMode || !ok || source == nil {
		writer.WriteHeader(http.StatusNoContent)
		return
	}
	signals, unsubscribe, err := source.SubscribeChanges()
	if errors.Is(err, ingest.ErrTooManySubscribers) {
		writeError(writer, http.StatusServiceUnavailable, err.Error())
		return
	}
	if err != nil {
		writeInternalError(writer, err)
		return
	}
	defer unsubscribe()

	controller := http.NewResponseController(writer)
	writer.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
	writer.Header().Set("X-Accel-Buffering", "no")
	write := func(frame string) bool {
		if controller.SetWriteDeadline(time.Now().Add(usageLiveWriteDeadline)) != nil {
			return false
		}
		if _, errWrite := io.WriteString(writer, frame); errWrite != nil {
			return false
		}
		return controller.Flush() == nil
	}
	// retry is the browser's reconnect delay after the lifetime ends or the
	// connection drops.
	if !write("retry: 2000\nevent: ready\ndata: {}\n\n") {
		return
	}

	heartbeat := time.NewTicker(USAGE_LIVE_HEARTBEAT)
	defer heartbeat.Stop()
	lifetime := time.NewTimer(USAGE_LIVE_LIFETIME)
	defer lifetime.Stop()
	for {
		select {
		case <-request.Context().Done():
			return
		case <-lifetime.C:
			return
		case <-heartbeat.C:
			if !write(": keepalive\n\n") {
				return
			}
		case <-signals:
			if !write("event: usage\ndata: {}\n\n") {
				return
			}
			gap := time.NewTimer(USAGE_LIVE_MIN_GAP)
			select {
			case <-request.Context().Done():
				gap.Stop()
				return
			case <-gap.C:
			}
		}
	}
}
