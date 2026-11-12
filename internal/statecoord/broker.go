// Package statecoord provides an in-memory state projection coordinator with
// singleflight cold-loading, debounced write-behind persistence, and an SSE
// event broker for real-time reconciliation and rollback notifications.
package statecoord

import (
	"errors"
	"sync"
	"time"
)

const (
	// MAX_SUBSCRIBERS bounds concurrent SSE readers so runaway tabs cannot exhaust
	// file descriptors or memory; matches OMC's live-channel subscriber cap.
	MAX_SUBSCRIBERS = 64

	// subscriberBufferSize absorbs short bursts per SSE client without blocking
	// publishers on slow network readers.
	subscriberBufferSize = 16
)

// Event types emitted on the state coordination SSE stream.
const (
	EventReady     = "ready"
	EventStateSync = "state_sync"
	EventSyncError = "sync_error"
)

var (
	// ErrTooManySubscribers refuses new SSE connections once MAX_SUBSCRIBERS is reached.
	ErrTooManySubscribers = errors.New("too many live event subscribers")
	// ErrBrokerClosed reports a subscription attempt after shutdown began.
	ErrBrokerClosed = errors.New("live event broker is closed")
)

// Event is a serialized state notification broadcast to connected consoles.
// Data must contain only sanitized, secret-free projections.
type Event struct {
	Type        string   `json:"type"`
	Version     uint64   `json:"version"`
	Scopes      []string `json:"scopes,omitempty"`
	Code        string   `json:"code,omitempty"`
	Error       string   `json:"error,omitempty"`
	Data        any      `json:"data,omitempty"`
	TimestampMS int64    `json:"timestamp_ms"`
}

// Broker fans out state events to active SSE subscribers without blocking writers.
// Its mutex is an independent leaf lock: Publish never performs I/O or waits on readers.
type Broker struct {
	mu          sync.Mutex
	subscribers map[uint64]chan Event
	nextID      uint64
	done        chan struct{}
	isClosed    bool
}

// NewBroker constructs a live SSE event broker ready for subscriptions.
func NewBroker() *Broker {
	return &Broker{
		subscribers: make(map[uint64]chan Event),
		done:        make(chan struct{}),
	}
}

// Subscribe registers one SSE listener and returns its receive channel plus an
// idempotent cleanup callback that removes the listener on disconnect.
func (b *Broker) Subscribe() (<-chan Event, func(), error) {
	b.mu.Lock()
	defer b.mu.Unlock()

	if b.isClosed {
		return nil, nil, ErrBrokerClosed
	}
	if len(b.subscribers) >= MAX_SUBSCRIBERS {
		return nil, nil, ErrTooManySubscribers
	}

	b.nextID++
	id := b.nextID
	ch := make(chan Event, subscriberBufferSize)
	b.subscribers[id] = ch

	var once sync.Once
	unsubscribe := func() {
		once.Do(func() {
			b.mu.Lock()
			delete(b.subscribers, id)
			b.mu.Unlock()
		})
	}
	return ch, unsubscribe, nil
}

// Publish broadcasts evt to every active subscriber using non-blocking sends.
// If a slow subscriber's buffer is full, its oldest queued frame is dropped in
// favor of the newest state event so the latest version/rollback always wins.
func (b *Broker) Publish(evt Event) {
	if evt.TimestampMS == 0 {
		evt.TimestampMS = time.Now().UnixMilli()
	}

	b.mu.Lock()
	defer b.mu.Unlock()
	if b.isClosed {
		return
	}

	for _, ch := range b.subscribers {
		select {
		case ch <- evt:
		default:
			// Evict stale buffered notification so the newest reconciliation frame fits.
			select {
			case <-ch:
			default:
			}
			select {
			case ch <- evt:
			default:
			}
		}
	}
}

// SubscriberCount reports the current number of connected SSE streams.
func (b *Broker) SubscriberCount() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	return len(b.subscribers)
}

// Done closes when Close is invoked during server shutdown.
func (b *Broker) Done() <-chan struct{} {
	return b.done
}

// Close terminates all open SSE streams so http.Server.Shutdown does not block
// waiting for long-lived event-stream connections to go idle.
func (b *Broker) Close() {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.isClosed {
		return
	}
	b.isClosed = true
	clear(b.subscribers)
	close(b.done)
}
