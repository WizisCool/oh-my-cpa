package ingest

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"testing"
	"time"
)

func TestPullPacer(t *testing.T) {
	p := pullPacer{base: time.Second, maximum: 10 * time.Second}
	for i, want := range []time.Duration{1, 2, 4, 8, 10, 10} {
		if got := p.nextDelay(0, 1000); got != want*time.Second {
			t.Fatalf("empty %d: %v", i, got)
		}
	}
	if got := p.nextDelay(1000, 1000); got != 0 {
		t.Fatalf("full batch delayed: %v", got)
	}
	if got := p.nextDelay(0, 1000); got != time.Second {
		t.Fatalf("activity did not reset: %v", got)
	}
	p.nextDelay(0, 1000)
	if got := p.nextDelay(1, 1000); got != time.Second {
		t.Fatalf("partial batch delayed: %v", got)
	}
	if got := p.nextDelay(0, 1000); got != time.Second {
		t.Fatalf("partial reset: %v", got)
	}
}

func TestPullPacerFixedInterval(t *testing.T) {
	p := pullPacer{base: 3 * time.Second, maximum: 3 * time.Second}
	for i := 0; i < 10; i++ {
		if got := p.nextDelay(0, 10); got != 3*time.Second {
			t.Fatal(got)
		}
	}
}

func TestPullPacerIdleRequestBudget(t *testing.T) {
	p := pullPacer{base: time.Second, maximum: 10 * time.Second}
	calls := 0
	for elapsed := time.Duration(0); elapsed < time.Hour; elapsed += p.nextDelay(0, 1000) {
		calls++
	}
	if calls != 363 {
		t.Fatalf("idle requests per hour = %d", calls)
	}
	t.Logf("empty-queue schedule: fixed=3600 requests/hour, adaptive=%d (excluding request duration)", calls)
}

func TestRunnerRetriesRequestDeadline(t *testing.T) {
	upstream := newFakeUpstream()
	upstream.httpErr = fmt.Errorf("request timed out: %w", context.DeadlineExceeded)
	cfg := fastConfig(ModeHTTPPull)
	runner, err := NewRunner("default", upstream, newStore(t), nil, slog.New(slog.NewTextHandler(io.Discard, nil)), cfg)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 150*time.Millisecond)
	defer cancel()
	if err := runner.Run(ctx); err != nil {
		t.Fatal(err)
	}
	upstream.mu.Lock()
	defer upstream.mu.Unlock()
	if upstream.httpCalls < 2 {
		t.Fatalf("transient deadline stopped collector after %d attempts", upstream.httpCalls)
	}
}

func TestPullCancelsLongIdleWait(t *testing.T) {
	upstream := newFakeUpstream()
	cfg := fastConfig(ModeHTTPPull)
	cfg.IdleInterval = time.Hour
	cfg.MaxIdleInterval = time.Hour
	runner, err := NewRunner("default", upstream, newStore(t), nil, nil, cfg)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- runner.Run(ctx) }()
	defer cancel()
	deadline := time.Now().Add(time.Second)
	for {
		upstream.mu.Lock()
		calls := upstream.httpCalls
		upstream.mu.Unlock()
		if calls > 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("collector never polled")
		}
		time.Sleep(time.Millisecond)
	}
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("idle wait ignored cancellation")
	}
}
