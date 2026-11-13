package api

import (
	"errors"
	"io"
	"net/http"
	"time"
)

const (
	// SYSTEM_LIVE_HEARTBEAT keeps idle intermediaries from closing a quiet stream and lets a
	// write to a vanished reader fail within a bounded time.
	SYSTEM_LIVE_HEARTBEAT = 20 * time.Second
	// SYSTEM_LIVE_LIFETIME ends every stream after a while so the browser reconnects through
	// the ordinary authentication middleware: a session that was signed out or expired cannot
	// keep a stream it opened earlier.
	SYSTEM_LIVE_LIFETIME = 5 * time.Minute
	// systemLiveWriteDeadline bounds one write to a slow reader.
	systemLiveWriteDeadline = 10 * time.Second
)

// systemLive streams "the stored update observations changed" signals as server-sent events.
//
// The stream carries no data - only `event: updates` with an empty object - so a reader
// re-reads the ordinary endpoints and cannot see anything a normal request would not show. It
// exists because the observations are written by the background sweep, which no browser is
// waiting on; without it the shell's update indicators could trail a release by a whole poll.
//
// 204 means "this deployment has no release service" (demonstration mode, or a build without
// one), which EventSource treats as final; the console then keeps its polling interval. 503
// means the reader limit is reached, and it keeps polling too.
// systemLive streams "the stored update observations changed" signals as server-sent events.
//
// @Summary Stream live system update notifications
// @Description Subscribe to Server-Sent Events emitted when background update observations change.
// @Tags System
// @Produce text/event-stream
// @Security CookieAuth
// @Success 200 {string} string "Server-Sent Events stream"
// @Success 204 {string} string "No content when release checking is unavailable or in demo mode"
// @Failure 401 {object} ErrorResponseDTO
// @Failure 503 {object} ErrorResponseDTO
// @Router /v1/management/system/live [get]
func (h *Handler) systemLive(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	if h.cfg.IsDemoMode || h.release == nil {
		writer.WriteHeader(http.StatusNoContent)
		return
	}
	signals, unsubscribe, err := h.updateSignals.Subscribe()
	if errors.Is(err, ErrTooManyUpdateSubscribers) || errors.Is(err, ErrUpdateSignalsClosed) {
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
		if controller.SetWriteDeadline(time.Now().Add(systemLiveWriteDeadline)) != nil {
			return false
		}
		if _, errWrite := io.WriteString(writer, frame); errWrite != nil {
			return false
		}
		return controller.Flush() == nil
	}
	// retry is the browser's reconnect delay after the lifetime ends or the connection drops.
	// `ready` is a signal too: a reader that reconnected may have missed one.
	if !write("retry: 2000\nevent: ready\ndata: {}\n\n") {
		return
	}

	heartbeat := time.NewTicker(SYSTEM_LIVE_HEARTBEAT)
	defer heartbeat.Stop()
	lifetime := time.NewTimer(SYSTEM_LIVE_LIFETIME)
	defer lifetime.Stop()
	// Captured after Subscribe, so a shutdown that starts now closes this reader's channel too.
	shutdown := h.updateSignals.Done()
	for {
		select {
		case <-request.Context().Done():
			return
		case <-shutdown:
			return
		case <-lifetime.C:
			return
		case <-heartbeat.C:
			if !write(": keepalive\n\n") {
				return
			}
		case <-signals:
			if !write("event: updates\ndata: {}\n\n") {
				return
			}
		}
	}
}
