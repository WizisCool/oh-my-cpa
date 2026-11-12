package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/statecoord"
)

const (
	// STATE_EVENTS_HEARTBEAT keeps reverse proxies from closing idle SSE streams
	// and detects half-open client sockets within bounded time.
	STATE_EVENTS_HEARTBEAT = 20 * time.Second

	// STATE_EVENTS_LIFETIME rotates long-lived SSE connections through session
	// authentication middleware so revoked or expired sessions cannot linger.
	STATE_EVENTS_LIFETIME = 5 * time.Minute

	// stateEventsWriteDeadline bounds individual frame writes to slow readers.
	stateEventsWriteDeadline = 10 * time.Second
)

// stateEventsLive streams real-time state coordination events (`ready`, `state_sync`,
// and `sync_error` with authoritative sanitized snapshot) over Server-Sent Events.
func (h *Handler) stateEventsLive(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	if h.cfg.IsDemoMode || h.stateCoord == nil {
		writer.WriteHeader(http.StatusNoContent)
		return
	}

	broker := h.stateCoord.Broker()
	events, unsubscribe, err := broker.Subscribe()
	if errors.Is(err, statecoord.ErrTooManySubscribers) || errors.Is(err, statecoord.ErrBrokerClosed) {
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

	writeFrame := func(frame string) bool {
		if controller.SetWriteDeadline(time.Now().Add(stateEventsWriteDeadline)) != nil {
			return false
		}
		if _, writeErr := io.WriteString(writer, frame); writeErr != nil {
			return false
		}
		return controller.Flush() == nil
	}

	readyPayload, _ := json.Marshal(statecoord.Event{
		Type:        statecoord.EventReady,
		Version:     h.stateCoord.Version(),
		TimestampMS: time.Now().UnixMilli(),
	})
	if !writeFrame(fmt.Sprintf("retry: 2000\nevent: ready\ndata: %s\n\n", readyPayload)) {
		return
	}

	heartbeat := time.NewTicker(STATE_EVENTS_HEARTBEAT)
	defer heartbeat.Stop()
	lifetime := time.NewTimer(STATE_EVENTS_LIFETIME)
	defer lifetime.Stop()
	shutdown := broker.Done()

	for {
		select {
		case <-request.Context().Done():
			return
		case <-shutdown:
			return
		case <-lifetime.C:
			return
		case <-heartbeat.C:
			if !writeFrame(": keepalive\n\n") {
				return
			}
		case evt, ok := <-events:
			if !ok {
				return
			}
			encoded, marshalErr := json.Marshal(evt)
			if marshalErr != nil {
				continue
			}
			if !writeFrame(fmt.Sprintf("event: %s\ndata: %s\n\n", evt.Type, encoded)) {
				return
			}
		}
	}
}

// getProjectedState returns the sanitized in-memory configuration projection
// wrapped in { version, data } in under 1ms.
func (h *Handler) getProjectedState(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	if h.stateCoord != nil {
		envelope, err := statecoord.ProjectTyped(request.Context(), h.stateCoord, func(state projectedConfigState, _ uint64) (SafeProjectedStateDTO, error) {
			return buildSafeProjectedStateDTO(state), nil
		})
		if err != nil {
			writeCPAFacadeError(writer, err)
			return
		}
		setStateVersionHeader(writer, envelope.Version)
		writeJSON(writer, http.StatusOK, envelope)
		return
	}

	loaded, err := h.loadUpstreamProjectedState(request.Context())
	if err != nil {
		writeCPAFacadeError(writer, err)
		return
	}
	setStateVersionHeader(writer, 1)
	writeJSON(writer, http.StatusOK, statecoord.StateEnvelope[SafeProjectedStateDTO]{
		Version: 1,
		Data:    buildSafeProjectedStateDTO(loaded),
	})
}
