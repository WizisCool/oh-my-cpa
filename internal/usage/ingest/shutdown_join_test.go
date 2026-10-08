package ingest

import (
	"context"
	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/management"
	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
	"testing"
	"time"
)

type blockingSink struct {
	store     *repository.Repository
	entered   chan struct{}
	release   chan struct{}
	completed chan error
}

func (s *blockingSink) AppendUsageInbox(ctx context.Context, instanceID, mode string, payloads []string, poppedAt time.Time) (int, error) {
	close(s.entered)
	select {
	case <-s.release:
	case <-ctx.Done():
		s.completed <- ctx.Err()
		return 0, ctx.Err()
	}
	count, err := s.store.AppendUsageInbox(ctx, instanceID, mode, payloads, poppedAt)
	s.completed <- err
	return count, err
}

func TestPipelineJoinsShutdownFlushBeforeReturn(t *testing.T) {
	store := newStore(t)
	sink := &blockingSink{store: store, entered: make(chan struct{}), release: make(chan struct{}), completed: make(chan error, 1)}
	upstream := newFakeUpstream()
	stream := &fakeStream{channel: management.UsageChannel, messages: make(chan string)}
	upstream.streams[management.UsageChannel] = stream
	runner, err := NewRunner("default", upstream, sink, nil, nil, Config{Mode: ModeSubscribe, BatchSize: 100, IdleInterval: time.Hour, BackfillInterval: time.Hour})
	if err != nil {
		t.Fatal(err)
	}
	processor, err := NewProcessor(store, nil, 100, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	pipeline, err := NewPipeline(runner, processor, nil, store)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- pipeline.Run(ctx) }()
	// An unbuffered send proves the collector received this destructive payload.
	select {
	case stream.messages <- `{"model":"fixture-shutdown","tokens":{"input":1}}`:
	case <-time.After(2 * time.Second):
		t.Fatal("collector did not receive fixture")
	}
	cancel()
	select {
	case <-sink.entered:
	case <-time.After(2 * time.Second):
		t.Fatal("shutdown flush did not start")
	}
	returned := false
	select {
	case err = <-done:
		returned = true
	case <-time.After(250 * time.Millisecond):
	}
	t.Logf("pipeline_returned_while_shutdown_flush_blocked=%v run_error=%v", returned, err)
	if returned {
		// main.go defers App.Close after App.Run. Model that ownership boundary with
		// the real store while its collector is still flushing a received payload.
		if closeErr := store.SQL().Close(); closeErr != nil {
			t.Fatal(closeErr)
		}
	}
	close(sink.release)
	select {
	case flushErr := <-sink.completed:
		t.Logf("flush_error_after_owner_close=%v", flushErr)
	case <-time.After(2 * time.Second):
		t.Fatal("fixture flush did not finish")
	}
	if !returned {
		select {
		case <-done:
		case <-time.After(2 * time.Second):
			t.Fatal("pipeline did not join")
		}
	}
	if returned {
		t.Error("pipeline return does not join its independent shutdown flush; owner can close DB first")
	}
}
