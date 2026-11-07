package api

import (
	"errors"
	"sync"
)

// MAX_UPDATE_SUBSCRIBERS bounds the open update streams one process serves. Each is an open
// HTTP stream; past the bound a reader falls back to its polling interval, which is still
// correct, only slower.
const MAX_UPDATE_SUBSCRIBERS = 64

// ErrTooManyUpdateSubscribers is returned when MAX_UPDATE_SUBSCRIBERS are attached.
var ErrTooManyUpdateSubscribers = errors.New("too many live update readers")

// ErrUpdateSignalsClosed is returned once the console's update streams are closed for shutdown.
var ErrUpdateSignalsClosed = errors.New("update streams are closed")

// updateSignals tells open consoles that the stored update observations moved.
//
// It carries no data, only the fact that something changed: a reader re-reads the stored
// answers and the plugin observations joined with them, using its own request. Delivery is
// coalescing and non-blocking, so a slow reader holds at most one pending signal and can never
// stall the sweep that publishes. The zero value is usable.
type updateSignals struct {
	mutex       sync.Mutex
	subscribers map[chan struct{}]struct{}
	// done closes when the streams are closed for shutdown; nil until the first subscriber.
	done     chan struct{}
	isClosed bool
}

// Subscribe attaches a reader. The returned function detaches it and is safe to call twice.
func (s *updateSignals) Subscribe() (<-chan struct{}, func(), error) {
	s.mutex.Lock()
	defer s.mutex.Unlock()
	if s.isClosed {
		return nil, nil, ErrUpdateSignalsClosed
	}
	if len(s.subscribers) >= MAX_UPDATE_SUBSCRIBERS {
		return nil, nil, ErrTooManyUpdateSubscribers
	}
	if s.subscribers == nil {
		s.subscribers = make(map[chan struct{}]struct{})
	}
	if s.done == nil {
		s.done = make(chan struct{})
	}
	signal := make(chan struct{}, 1)
	s.subscribers[signal] = struct{}{}
	var once sync.Once
	return signal, func() {
		once.Do(func() {
			s.mutex.Lock()
			delete(s.subscribers, signal)
			s.mutex.Unlock()
		})
	}, nil
}

// Publish signals every reader without blocking. A reader that has not consumed its previous
// signal keeps that one: both mean "re-read", so merging them loses nothing.
func (s *updateSignals) Publish() {
	s.mutex.Lock()
	defer s.mutex.Unlock()
	for signal := range s.subscribers {
		select {
		case signal <- struct{}{}:
		default:
		}
	}
}

// NotifyUpdateObservations reports that a check recorded a result or a plugin observation
// changed, so every open console re-reads the stored answer. It is called by the release
// service's outcome hook and by the plugin sweep, and never blocks the caller.
func (h *Handler) NotifyUpdateObservations() {
	if h == nil {
		return
	}
	h.updateSignals.Publish()
}

// Done closes when the streams are closed for shutdown. It is captured after a successful
// Subscribe, so it is never nil for a reader.
func (s *updateSignals) Done() <-chan struct{} {
	s.mutex.Lock()
	defer s.mutex.Unlock()
	return s.done
}

// Close ends every open stream and refuses new readers.
//
// It is called before the HTTP server shuts down, because Shutdown waits for active
// connections to go idle and an event stream never does: without this, one open console tab
// holds the shutdown until its deadline and the process reports a shutdown error.
func (s *updateSignals) Close() {
	s.mutex.Lock()
	defer s.mutex.Unlock()
	if s.isClosed {
		return
	}
	s.isClosed = true
	if s.done == nil {
		s.done = make(chan struct{})
	}
	close(s.done)
}

// CloseUpdateStreams ends the console's open update streams and refuses new ones. It is part of
// the shutdown sequence, before the HTTP server stops accepting and waits for connections.
func (h *Handler) CloseUpdateStreams() {
	if h == nil {
		return
	}
	h.updateSignals.Close()
}
