package ingest

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
)

type failingSinkWithGapRecorder struct {
	mu           sync.Mutex
	recordedGaps []repository.IngestGap
}

func (f *failingSinkWithGapRecorder) AppendUsageInbox(ctx context.Context, instanceID, sourceMode string, payloads []string, poppedAt time.Time) (int, error) {
	return 0, errors.New("simulated database disk error")
}

func (f *failingSinkWithGapRecorder) RecordIngestGap(ctx context.Context, gap repository.IngestGap) (int64, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.recordedGaps = append(f.recordedGaps, gap)
	return int64(len(f.recordedGaps)), nil
}

func TestRunnerRecordsIngestGapOnAppendFailure(t *testing.T) {
	fakeUpstream := newFakeUpstream()
	sink := &failingSinkWithGapRecorder{}
	cfg := fastConfig(ModeHTTPPull)

	runner, err := NewRunner("default", fakeUpstream, sink, nil, nil, cfg)
	if err != nil {
		t.Fatal(err)
	}

	fakeUpstream.mu.Lock()
	fakeUpstream.httpBatches = append(fakeUpstream.httpBatches, []string{`{"request_id":"req-gap-1"}`, `{"request_id":"req-gap-2"}`})
	fakeUpstream.mu.Unlock()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Running pull once will pop items and attempt to flush to sink
	go func() {
		_ = runner.runPull(ctx, ModeHTTPPull)
	}()

	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		sink.mu.Lock()
		count := len(sink.recordedGaps)
		sink.mu.Unlock()
		if count > 0 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}

	sink.mu.Lock()
	defer sink.mu.Unlock()
	if len(sink.recordedGaps) == 0 {
		t.Fatal("expected ingest gap to be recorded on append failure, got 0")
	}
	gap := sink.recordedGaps[0]
	if gap.EstimatedCount != 2 {
		t.Fatalf("expected estimated count 2, got %d", gap.EstimatedCount)
	}
	if gap.ReasonCode != "append_failure" {
		t.Fatalf("expected reason_code append_failure, got %q", gap.ReasonCode)
	}
	if runner.Status().CoverageGaps == 0 {
		t.Fatal("expected runner status coverage_gaps > 0")
	}
}

func TestRunnerShutdownFlushPreservesBufferedItems(t *testing.T) {
	store := newStore(t)
	fakeUpstream := newFakeUpstream()
	// Long flush interval so normal tick doesn't fire before shutdown
	cfg := Config{
		Mode:         ModeSubscribe,
		IdleInterval: 10 * time.Second,
		BatchSize:    100,
	}

	runner, err := NewRunner("default", fakeUpstream, store, nil, nil, cfg)
	if err != nil {
		t.Fatal(err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- runner.Run(ctx) }()

	// Wait until subscription is established
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if runner.Status().Mode == ModeSubscribe {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}

	// Push one payload to the subscription channel
	fakeUpstream.push("usage", `{"request_id":"req-shutdown-flush","model":"m"}`)
	time.Sleep(20 * time.Millisecond)

	// Cancel context to trigger shutdown flush
	cancel()
	if err := <-done; err != nil {
		t.Fatal(err)
	}

	// The payload should be flushed into the store on shutdown!
	var count int
	if err := store.SQL().QueryRow(`SELECT COUNT(1) FROM usage_inboxes WHERE raw_message LIKE '%req-shutdown-flush%'`).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("expected 1 inbox item flushed on shutdown, found %d", count)
	}
}
