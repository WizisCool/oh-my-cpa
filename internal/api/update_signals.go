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

// updateSignals tells open consoles that the stored update observations moved.
//
// It carries no data, only the fact that something changed: a reader re-reads the stored
// answers and the plugin observations joined with them, using its own request. Delivery is
// coalescing and non-blocking, so a slow reader holds at most one pending signal and can never
// stall the sweep that publishes. The zero value is usable.
type updateSignals struct {
	mutex       sync.Mutex
	subscribers map[chan struct{}]struct{}
}

// Subscribe attaches a reader. The returned function detaches it and is safe to call twice.
func (s *updateSignals) Subscribe() (<-chan struct{}, func(), error) {
	s.mutex.Lock()
	defer s.mutex.Unlock()
	if len(s.subscribers) >= MAX_UPDATE_SUBSCRIBERS {
		return nil, nil, ErrTooManyUpdateSubscribers
	}
	if s.subscribers == nil {
		s.subscribers = make(map[chan struct{}]struct{})
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
