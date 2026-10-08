package ingest

import (
	"context"
	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/management"
	"testing"
	"time"
)

func TestSubscriptionClosurePreservesReceivedBatch(t *testing.T) {
	store := newStore(t)
	upstream := newFakeUpstream()
	stream := &fakeStream{channel: management.UsageChannel, messages: make(chan string, 1)}
	stream.messages <- `{"model":"fixture-model","tokens":{"input":1,"output":1}}`
	_ = stream.Close()
	upstream.streams[management.UsageChannel] = stream
	runner, buildErr := NewRunner("default", upstream, store, nil, nil, Config{Mode: ModeSubscribe, BatchSize: 100, IdleInterval: time.Hour, BackfillInterval: time.Hour})
	if buildErr != nil {
		t.Fatal(buildErr)
	}
	err := runner.runSubscribe(context.Background())
	var count int
	if queryErr := store.SQL().QueryRow(`SELECT COUNT(*) FROM usage_inboxes`).Scan(&count); queryErr != nil {
		t.Fatal(queryErr)
	}
	status := runner.Status()
	t.Logf("transport_error=%v received=1 persisted=%d captured=%d coverage_gaps=%d", err, count, status.Captured, status.CoverageGaps)
	if count != 1 {
		t.Errorf("received destructive payload lost on stream closure: want1 got%d", count)
	}
}

func TestManualSubscriptionClosurePreservesBatch(t *testing.T) {
	store := newStore(t)
	runner, buildErr := NewRunner("default", newFakeUpstream(), store, nil, nil, Config{Mode: ModeSubscribe, BatchSize: 100, IdleInterval: time.Hour, BackfillInterval: time.Hour})
	if buildErr != nil {
		t.Fatal(buildErr)
	}
	messages := make(chan string, 1)
	messages <- `{"model":"fixture-model","tokens":{"input":1}}`
	close(messages)
	batch := []string{`{"model":"fixture-existing","tokens":{"input":1}}`}
	result := runner.syncSubscribe(context.Background(), context.Background(), messages, &batch, func() error { return nil })
	var count int
	if err := store.SQL().QueryRow(`SELECT COUNT(*) FROM usage_inboxes`).Scan(&count); err != nil {
		t.Fatal(err)
	}
	t.Logf("error=%v buffered=%d persisted=%d coverage_gaps=%d", result.Err, len(batch), count, runner.Status().CoverageGaps)
	if count != 2 {
		t.Errorf("manual closure lost existing and newly received payloads: want2 got%d", count)
	}
}
