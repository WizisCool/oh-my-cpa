package statecoord

import (
	"context"
	"errors"
	"maps"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type fakeConfigState struct {
	Debug   bool
	Keys    []string
	Toggles map[string]bool
	Secret  string
}

func cloneFakeConfigState(src fakeConfigState) fakeConfigState {
	return fakeConfigState{
		Debug:   src.Debug,
		Keys:    slices.Clone(src.Keys),
		Toggles: maps.Clone(src.Toggles),
		Secret:  src.Secret,
	}
}

func TestBootstrapAndSubMillisecondReadAndDebounceCoalesce(t *testing.T) {
	var upstreamMu sync.Mutex
	upstream := fakeConfigState{
		Debug:   false,
		Keys:    []string{"sk-init-1"},
		Toggles: map[string]bool{"codex-0": false},
		Secret:  "top-secret-never-in-sse",
	}
	var flushCount atomic.Int32
	flushedCh := make(chan fakeConfigState, 4)

	var loadCount atomic.Int32
	coord := New(Options[fakeConfigState]{
		DebounceWindow: 35 * time.Millisecond,
		Load: func(_ context.Context) (fakeConfigState, error) {
			loadCount.Add(1)
			upstreamMu.Lock()
			defer upstreamMu.Unlock()
			return cloneFakeConfigState(upstream), nil
		},
		Clone: cloneFakeConfigState,
		ProjectSafe: func(state fakeConfigState, version uint64) any {
			return map[string]any{
				"version": version,
				"debug":   state.Debug,
				"toggles": maps.Clone(state.Toggles),
			}
		},
	})

	coord.RegisterDomain("toggles", DomainSpec[fakeConfigState]{
		Order:  1,
		Scopes: []string{"management-providers"},
		Flush: func(_ context.Context, _ DomainKey, snapshot fakeConfigState) error {
			flushCount.Add(1)
			upstreamMu.Lock()
			upstream.Toggles = maps.Clone(snapshot.Toggles)
			saved := cloneFakeConfigState(upstream)
			upstreamMu.Unlock()
			flushedCh <- saved
			return nil
		},
	})

	if err := coord.Bootstrap(context.Background()); err != nil {
		t.Fatalf("bootstrap failed: %v", err)
	}
	coord.Start()
	t.Cleanup(func() { _ = coord.Close(context.Background()) })

	if got := coord.Version(); got != 1 {
		t.Fatalf("bootstrap version = %d, want 1", got)
	}
	if gotLoads := loadCount.Load(); gotLoads != 1 {
		t.Fatalf("bootstrap load count = %d, want 1", gotLoads)
	}

	env, err := coord.Read(context.Background())
	if err != nil {
		t.Fatalf("read failed: %v", err)
	}
	if gotLoads := loadCount.Load(); gotLoads != 1 {
		t.Fatalf("in-memory Read triggered upstream Load (count = %d, want 1)", gotLoads)
	}
	if env.Version != 1 || len(env.Data.Keys) != 1 {
		t.Fatalf("unexpected initial envelope: %+v", env)
	}

	// Burst 15 rapid toggles inside the debounce window; only the final state (true)
	// should be flushed once to upstream.
	for i := range 15 {
		desired := i%2 == 0 // ends at i=14 -> true
		version, err := coord.Mutate(context.Background(), "toggles", func(state *fakeConfigState) error {
			state.Toggles["codex-0"] = desired
			return nil
		})
		if err != nil {
			t.Fatalf("mutate %d failed: %v", i, err)
		}
		if want := uint64(i + 2); version != want {
			t.Fatalf("mutate %d version = %d, want %d", i, version, want)
		}
	}

	select {
	case persisted := <-flushedCh:
		if !persisted.Toggles["codex-0"] {
			t.Fatalf("persisted toggle = false, want final coalesced state true")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for debounced write-behind flush")
	}

	if calls := flushCount.Load(); calls != 1 {
		t.Fatalf("expected 1 coalesced upstream flush, got %d", calls)
	}
}

func TestSingleflightPreventsColdCacheStampede(t *testing.T) {
	var loadCalls atomic.Int32
	loadEntered := make(chan struct{})
	releaseLoad := make(chan struct{})

	coord := New(Options[fakeConfigState]{
		Load: func(_ context.Context) (fakeConfigState, error) {
			if loadCalls.Add(1) == 1 {
				close(loadEntered)
			}
			<-releaseLoad
			return fakeConfigState{Debug: true, Toggles: map[string]bool{}}, nil
		},
		Clone: cloneFakeConfigState,
	})

	const readers = 32
	var wg sync.WaitGroup
	errs := make(chan error, readers)
	for range readers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			env, err := coord.Read(context.Background())
			if err != nil {
				errs <- err
				return
			}
			if env.Version != 1 || !env.Data.Debug {
				errs <- errors.New("unexpected cold-load envelope")
			}
		}()
	}

	<-loadEntered
	close(releaseLoad)
	wg.Wait()
	close(errs)

	for err := range errs {
		t.Fatalf("concurrent reader failed: %v", err)
	}
	if calls := loadCalls.Load(); calls != 1 {
		t.Fatalf("singleflight load calls = %d, want 1", calls)
	}
}

func TestInFlightMutationDuringFlushIsPreservedByGenerationGuard(t *testing.T) {
	var upstreamMu sync.Mutex
	upstream := fakeConfigState{Toggles: map[string]bool{"claude-0": false}}

	firstFlushStarted := make(chan struct{})
	releaseFirstFlush := make(chan struct{})
	flushedValues := make(chan bool, 4)
	var flushCall atomic.Int32

	coord := New(Options[fakeConfigState]{
		DebounceWindow: 20 * time.Millisecond,
		Load: func(_ context.Context) (fakeConfigState, error) {
			upstreamMu.Lock()
			defer upstreamMu.Unlock()
			return cloneFakeConfigState(upstream), nil
		},
		Clone: cloneFakeConfigState,
	})
	coord.RegisterDomain("toggles", DomainSpec[fakeConfigState]{
		Scopes: []string{"management-providers"},
		Flush: func(_ context.Context, _ DomainKey, snapshot fakeConfigState) error {
			call := flushCall.Add(1)
			if call == 1 {
				close(firstFlushStarted)
				<-releaseFirstFlush
			}
			val := snapshot.Toggles["claude-0"]
			upstreamMu.Lock()
			upstream.Toggles["claude-0"] = val
			upstreamMu.Unlock()
			flushedValues <- val
			return nil
		},
	})

	if err := coord.Bootstrap(context.Background()); err != nil {
		t.Fatal(err)
	}
	coord.Start()
	t.Cleanup(func() { _ = coord.Close(context.Background()) })

	// Mutation 1 sets claude-0 = true.
	if _, err := coord.Mutate(context.Background(), "toggles", func(s *fakeConfigState) error {
		s.Toggles["claude-0"] = true
		return nil
	}); err != nil {
		t.Fatal(err)
	}

	// Wait until Flush 1 is mid-flight over HTTP, then mutate claude-0 back to false.
	<-firstFlushStarted
	if _, err := coord.Mutate(context.Background(), "toggles", func(s *fakeConfigState) error {
		s.Toggles["claude-0"] = false
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	close(releaseFirstFlush)

	firstVal := <-flushedValues
	secondVal := <-flushedValues
	if !firstVal || secondVal {
		t.Fatalf("flush sequence = [%v, %v], want [true, false]", firstVal, secondVal)
	}
}

func TestFlushFailureReloadsUpstreamAndBroadcastsSanitizedSyncError(t *testing.T) {
	upstream := fakeConfigState{
		Debug:   false,
		Keys:    []string{"sk-live-authoritative"},
		Toggles: map[string]bool{"gemini-0": false},
		Secret:  "ultra-secret-token-value",
	}

	coord := New(Options[fakeConfigState]{
		DebounceWindow: 20 * time.Millisecond,
		Load: func(_ context.Context) (fakeConfigState, error) {
			return cloneFakeConfigState(upstream), nil
		},
		Clone: cloneFakeConfigState,
		ProjectSafe: func(state fakeConfigState, version uint64) any {
			return map[string]any{
				"version": version,
				"debug":   state.Debug,
				"toggles": maps.Clone(state.Toggles),
			}
		},
		ScrubError: func(_ error, _ fakeConfigState) (string, string) {
			return "cpa_rejected_request", "upstream rejected configuration update"
		},
	})

	coord.RegisterDomain("scalars", DomainSpec[fakeConfigState]{
		Scopes: []string{"management-config"},
		Flush: func(_ context.Context, _ DomainKey, _ fakeConfigState) error {
			return errors.New("upstream disk full containing ultra-secret-token-value")
		},
	})

	if err := coord.Bootstrap(context.Background()); err != nil {
		t.Fatal(err)
	}
	events, unsub, err := coord.Broker().Subscribe()
	if err != nil {
		t.Fatal(err)
	}
	defer unsub()

	coord.Start()
	t.Cleanup(func() { _ = coord.Close(context.Background()) })

	// Optimistically flip Debug = true in memory (Version = 2).
	ver, err := coord.Mutate(context.Background(), "scalars", func(state *fakeConfigState) error {
		state.Debug = true
		return nil
	})
	if err != nil || ver != 2 {
		t.Fatalf("mutate ver=%d err=%v, want 2/nil", ver, err)
	}

	// Wait for SSE sync_error notification after background flush fails.
	select {
	case evt := <-events:
		if evt.Type != EventSyncError {
			t.Fatalf("event type = %q, want %q", evt.Type, EventSyncError)
		}
		if evt.Code != "cpa_rejected_request" || evt.Error != "upstream rejected configuration update" {
			t.Fatalf("unexpected error payload: %+v", evt)
		}
		if evt.Version <= 2 {
			t.Fatalf("expected version to advance past speculative version 2, got %d", evt.Version)
		}
		if !slices.Contains(evt.Scopes, "management-config") {
			t.Fatalf("missing management-config scope in %+v", evt.Scopes)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for SSE sync_error event")
	}

	// Verify in-memory state rolled back to upstream's Debug = false.
	rolledBack, err := coord.Read(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if rolledBack.Data.Debug {
		t.Fatal("speculative Debug=true was not overwritten by authoritative upstream reload")
	}
}

func TestCoordinatorFlushNowAndFlushWithinGateNoDeadlock(t *testing.T) {
	var externalGate sync.Mutex
	var flushed atomic.Int32

	coord := New(Options[fakeConfigState]{
		DebounceWindow: 15 * time.Millisecond,
		MaxBatchWait:   100 * time.Millisecond,
		Clone:          cloneFakeConfigState,
		Load: func(context.Context) (fakeConfigState, error) {
			return fakeConfigState{}, nil
		},
		ProjectSafe: func(s fakeConfigState, _ uint64) any { return s },
		WithWriteGate: func(ctx context.Context, fn func(context.Context) error) error {
			externalGate.Lock()
			defer externalGate.Unlock()
			return fn(ctx)
		},
	})
	coord.RegisterDomain("scalars", DomainSpec[fakeConfigState]{
		Order:  1,
		Scopes: []string{"management-config"},
		Flush: func(context.Context, DomainKey, fakeConfigState) error {
			flushed.Add(1)
			time.Sleep(2 * time.Millisecond)
			return nil
		},
	})
	if err := coord.Bootstrap(context.Background()); err != nil {
		t.Fatal(err)
	}
	coord.Start()
	defer func() { _ = coord.Close(context.Background()) }()

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	// Race timer-driven/explicit FlushNow against external-gate-holding FlushWithinGate
	// across 40 iterations; the inverted lock order previously deadlocked immediately.
	var wg sync.WaitGroup
	for i := range 40 {
		if _, err := coord.Mutate(ctx, "scalars", func(s *fakeConfigState) error {
			s.Debug = i%2 == 0
			return nil
		}); err != nil {
			t.Fatal(err)
		}
		wg.Add(2)
		go func() {
			defer wg.Done()
			_ = coord.FlushNow(ctx)
		}()
		go func() {
			defer wg.Done()
			externalGate.Lock()
			defer externalGate.Unlock()
			// Yield briefly while holding externalGate to maximize overlap with FlushNow.
			time.Sleep(time.Millisecond)
			_ = coord.FlushWithinGate(ctx)
		}()
		wg.Wait()
	}

	if flushed.Load() == 0 {
		t.Fatal("expected at least one domain flush to complete")
	}
}

func TestCoordinatorDeferredInvalidateWhileDirtyAndDefaultScrubError(t *testing.T) {
	var upstreamMu sync.Mutex
	upstream := fakeConfigState{Debug: false, Secret: "sk-sensitive-upstream-secret"}
	var loadCalls atomic.Int32
	blockFlush := make(chan struct{})

	// Omit ScrubError intentionally to verify fail-closed default never echoes raw error text.
	coord := New(Options[fakeConfigState]{
		DebounceWindow: 15 * time.Millisecond,
		Load: func(context.Context) (fakeConfigState, error) {
			loadCalls.Add(1)
			upstreamMu.Lock()
			defer upstreamMu.Unlock()
			return cloneFakeConfigState(upstream), nil
		},
		Clone: cloneFakeConfigState,
	})
	coord.RegisterDomain("toggles", DomainSpec[fakeConfigState]{
		Order:  1,
		Scopes: []string{"management-providers"},
		Flush: func(context.Context, DomainKey, fakeConfigState) error {
			<-blockFlush
			return nil
		},
	})
	if err := coord.Bootstrap(context.Background()); err != nil {
		t.Fatal(err)
	}
	coord.Start()
	defer func() { _ = coord.Close(context.Background()) }()

	events, unsub, err := coord.Broker().Subscribe()
	if err != nil {
		t.Fatal(err)
	}
	defer unsub()

	if _, err := coord.Mutate(context.Background(), "toggles", func(s *fakeConfigState) error {
		s.Toggles = map[string]bool{"codex-0": true}
		return nil
	}); err != nil {
		t.Fatal(err)
	}

	// Simulate a structural write changing upstream Debug=true and calling Invalidate while "toggles" is dirty.
	upstreamMu.Lock()
	upstream.Debug = true
	upstreamMu.Unlock()
	coord.Invalidate("management-config")

	// Unblock flush so "toggles" drains and applies pendingInvalidation (marking projection unready).
	close(blockFlush)
	deadline := time.Now().Add(2 * time.Second)
	for coord.IsDirty() && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}

	reloaded, err := coord.Read(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !reloaded.Data.Debug || loadCalls.Load() < 2 {
		t.Fatalf("expected deferred invalidation to reload upstream Debug=true after dirty flush; got Debug=%t loads=%d", reloaded.Data.Debug, loadCalls.Load())
	}

	// Verify default ScrubError fails closed when a flush errors with secret-bearing text.
	coord.RegisterDomain("failing", DomainSpec[fakeConfigState]{
		Order: 2,
		Flush: func(context.Context, DomainKey, fakeConfigState) error {
			return errors.New("dial http://127.0.0.1:8317/v8/management?key=sk-raw-secret: refused")
		},
	})
	_, _ = coord.Mutate(context.Background(), "failing", func(s *fakeConfigState) error {
		s.Debug = false
		return nil
	})
	_ = coord.FlushNow(context.Background())
	for {
		select {
		case evt := <-events:
			if evt.Type == EventSyncError {
				if evt.Error != "upstream configuration sync failed" {
					t.Fatalf("default ScrubError leaked raw error %q", evt.Error)
				}
				return
			}
		case <-time.After(2 * time.Second):
			t.Fatal("timed out waiting for sync_error")
		}
	}
}

func TestCoordinatorIndependentDomainFlushAndSnapshotSecretScrubbing(t *testing.T) {
	upstream := fakeConfigState{
		Debug:  false,
		Keys:   []string{"sk-initial"},
		Secret: "sk-initial",
	}
	var outcomesMu sync.Mutex
	outcomes := make(map[string]bool)

	coord := New(Options[fakeConfigState]{
		DebounceWindow: 20 * time.Millisecond,
		Load: func(context.Context) (fakeConfigState, error) {
			return cloneFakeConfigState(upstream), nil
		},
		Clone: cloneFakeConfigState,
		ScrubError: func(err error, snap fakeConfigState) (string, string) {
			msg := err.Error()
			for _, key := range snap.Keys {
				msg = strings.ReplaceAll(msg, key, "[hidden]")
			}
			return "cpa_rejected_request", msg
		},
		OnDomainOutcome: func(rec PendingAuditRecord, flushErr error, _ fakeConfigState) {
			outcomesMu.Lock()
			outcomes[rec.Action] = flushErr == nil
			outcomesMu.Unlock()
		},
	})

	coord.RegisterDomain("scalars", DomainSpec[fakeConfigState]{
		Order:  1,
		Scopes: []string{"management-config"},
		Flush: func(_ context.Context, _ DomainKey, snap fakeConfigState) error {
			// Echo newly created key in the rejection text to prove snapshot-aware ScrubError hides it.
			return errors.New("rejected while batch carried " + snap.Keys[len(snap.Keys)-1])
		},
	})
	coord.RegisterDomain("keys", DomainSpec[fakeConfigState]{
		Order:  2,
		Scopes: []string{"management-client-keys"},
		Flush: func(_ context.Context, _ DomainKey, snap fakeConfigState) error {
			upstream.Keys = slices.Clone(snap.Keys)
			return nil
		},
	})

	if err := coord.Bootstrap(context.Background()); err != nil {
		t.Fatal(err)
	}
	events, unsub, err := coord.Broker().Subscribe()
	if err != nil {
		t.Fatal(err)
	}
	defer unsub()

	_, _ = coord.Mutate(context.Background(), "scalars", func(s *fakeConfigState) error {
		s.Debug = true
		return nil
	})
	coord.QueueDomainAudit("scalars", PendingAuditRecord{Action: "config.save_scalar"})

	_, _ = coord.Mutate(context.Background(), "keys", func(s *fakeConfigState) error {
		s.Keys = append(s.Keys, "synthetic-added-key")
		return nil
	})
	coord.QueueDomainAudit("keys", PendingAuditRecord{Action: "api_key.create"})

	_ = coord.FlushNow(context.Background())

	select {
	case evt := <-events:
		if evt.Type != EventSyncError {
			t.Fatalf("expected sync_error, got %q", evt.Type)
		}
		if strings.Contains(evt.Error, "synthetic-added-key") {
			t.Fatalf("ScrubError leaked newly added secret in sync_error: %q", evt.Error)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for sync_error")
	}

	outcomesMu.Lock()
	scalarOK, hasScalar := outcomes["config.save_scalar"]
	keyOK, hasKey := outcomes["api_key.create"]
	outcomesMu.Unlock()
	if !hasScalar || scalarOK || !hasKey || !keyOK {
		t.Fatalf("expected independent 'keys' flush to succeed and 'scalars' to fail; got scalar=(%t,%t) key=(%t,%t)", hasScalar, scalarOK, hasKey, keyOK)
	}
	reconciled, err := coord.Read(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(reconciled.Data.Keys) != 2 {
		t.Fatalf("expected valid 'keys' mutation to survive scalar failure, got %+v", reconciled.Data.Keys)
	}
}
