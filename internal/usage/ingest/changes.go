package ingest

import (
	"errors"
	"sync"
)

// MAX_CHANGE_SUBSCRIBERS bounds the live readers one process serves. Each is an
// open HTTP stream; the bound keeps a reconnect storm or a leaked tab from
// turning the console into a connection sink. Past it a reader falls back to
// polling, which is still correct, only slower.
const MAX_CHANGE_SUBSCRIBERS = 64

// ErrTooManySubscribers is returned when MAX_CHANGE_SUBSCRIBERS are attached.
var ErrTooManySubscribers = errors.New("too many live usage readers")

// Changes tells live readers that stored usage data moved: new request records
// became queryable, or a credential error was recorded.
//
// It carries no data, only the fact that something changed. A reader re-reads
// with its own cursor and filters, so a missed or merged signal can never lose a
// record - the next read returns everything past the reader's boundary. That is
// what lets delivery be coalescing and non-blocking: each subscriber holds at
// most one pending signal, and a slow reader can never stall the decoder that
// publishes.
type Changes struct {
	mu          sync.Mutex
	subscribers map[chan struct{}]struct{}
}

// NewChanges returns an empty hub.
func NewChanges() *Changes {
	return &Changes{subscribers: make(map[chan struct{}]struct{})}
}

// Subscribe attaches a reader. The returned function detaches it and is safe to
// call more than once.
func (c *Changes) Subscribe() (<-chan struct{}, func(), error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.subscribers) >= MAX_CHANGE_SUBSCRIBERS {
		return nil, nil, ErrTooManySubscribers
	}
	signal := make(chan struct{}, 1)
	c.subscribers[signal] = struct{}{}
	var once sync.Once
	return signal, func() {
		once.Do(func() {
			c.mu.Lock()
			delete(c.subscribers, signal)
			c.mu.Unlock()
		})
	}, nil
}

// Publish signals every reader without blocking. A reader that has not consumed
// its previous signal keeps that one: both mean "re-read", so merging them loses
// nothing.
func (c *Changes) Publish() {
	if c == nil {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	for signal := range c.subscribers {
		select {
		case signal <- struct{}{}:
		default:
		}
	}
}
