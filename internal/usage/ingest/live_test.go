package ingest

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/management"
)

func TestChangesCoalesceWithoutBlocking(t *testing.T) {
	changes := NewChanges()
	signals, unsubscribe, err := changes.Subscribe()
	if err != nil {
		t.Fatal(err)
	}
	defer unsubscribe()

	// A reader that is not consuming must not hold the publisher: the decoder
	// publishes from its own loop.
	published := make(chan struct{})
	go func() {
		for range 100 {
			changes.Publish()
		}
		close(published)
	}()
	select {
	case <-published:
	case <-time.After(2 * time.Second):
		t.Fatal("Publish blocked on a reader that was not reading")
	}
	select {
	case <-signals:
	default:
		t.Fatal("the reader lost the signal")
	}
	select {
	case <-signals:
		t.Fatal("a hundred publishes must merge into one pending signal")
	default:
	}
}

func TestChangesBoundTheReaders(t *testing.T) {
	changes := NewChanges()
	detach := make([]func(), 0, MAX_CHANGE_SUBSCRIBERS)
	for range MAX_CHANGE_SUBSCRIBERS {
		_, unsubscribe, err := changes.Subscribe()
		if err != nil {
			t.Fatal(err)
		}
		detach = append(detach, unsubscribe)
	}
	if _, _, err := changes.Subscribe(); !errors.Is(err, ErrTooManySubscribers) {
		t.Fatalf("reader past the limit: err = %v", err)
	}
	// Detaching twice must free exactly one slot, not two.
	detach[0]()
	detach[0]()
	if _, _, err := changes.Subscribe(); err != nil {
		t.Fatalf("a freed slot was not reusable: %v", err)
	}
	if _, _, err := changes.Subscribe(); !errors.Is(err, ErrTooManySubscribers) {
		t.Fatalf("a repeated detach freed a second slot: err = %v", err)
	}
}

// A subscribed record must reach a live reader in the time it takes to write and
// decode it. Every interval in the pipeline is set to an hour here, so the test
// can only pass if capture flushes on its own, capture wakes the decoder, and the
// decoder publishes - any fixed wait left on the path would hang it.
func TestSubscribedRecordReachesLiveReaderWithoutWaitingForIntervals(t *testing.T) {
	store := newStore(t)
	upstream := newFakeUpstream()
	config := fastConfig(ModeSubscribe)
	config.IdleInterval = time.Hour
	config.BackfillInterval = time.Hour
	runner, err := NewRunner("default", upstream, store, nil, nil, config)
	if err != nil {
		t.Fatal(err)
	}
	processor, err := NewProcessor(store, nil, 10, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	pipeline, err := NewPipeline(runner, processor, nil, store)
	if err != nil {
		t.Fatal(err)
	}
	signals, unsubscribe, err := pipeline.SubscribeChanges()
	if err != nil {
		t.Fatal(err)
	}
	defer unsubscribe()

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- pipeline.Run(ctx) }()
	defer func() {
		cancel()
		if err := <-done; err != nil {
			t.Errorf("pipeline returned %v", err)
		}
	}()

	waitForMode(t, runner, ModeSubscribe)
	// The decoder's first pass ran before anything was captured and is now in its
	// hour-long idle pause; only a wake can end it.
	upstream.push(management.UsageChannel, usagePayload("live-route-1"))

	select {
	case <-signals:
	case <-time.After(5 * time.Second):
		t.Fatal("the live reader was not told about the record")
	}
	var events int
	if err := store.SQL().QueryRow(`SELECT COUNT(1) FROM usage_events WHERE request_id = 'live-route-1'`).Scan(&events); err != nil {
		t.Fatal(err)
	}
	if events != 1 {
		t.Fatalf("the reader was signalled before the record was queryable: %d events", events)
	}
}
