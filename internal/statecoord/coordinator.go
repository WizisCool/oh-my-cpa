package statecoord

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"maps"
	"slices"
	"sync"
	"time"

	"golang.org/x/sync/singleflight"
)

const (
	// DefaultDebounceWindow coalesces rapid configuration edits into one serialized
	// upstream write, eliminating config.yaml read-modify-write contention.
	DefaultDebounceWindow = 250 * time.Millisecond

	// DefaultMaxBatchWait bounds how long continuous mutations can defer persistence,
	// preventing indefinite write starvation under sustained clicking.
	DefaultMaxBatchWait = 2 * time.Second

	// DefaultLoadTimeout bounds upstream cold-load and recovery fetches.
	DefaultLoadTimeout = 10 * time.Second

	// DefaultFlushTimeout bounds one serialized write-behind flush pass.
	DefaultFlushTimeout = 15 * time.Second
)

// ErrCoordinatorClosed reports mutations attempted after shutdown started.
var ErrCoordinatorClosed = errors.New("state coordinator is closed")

// ErrCoordinatorUnready reports that repeated concurrent invalidations prevented
// loading a clean baseline for an optimistic mutation.
var ErrCoordinatorUnready = errors.New("state coordinator projection is temporarily unready")

// DomainKey identifies an independent flushable slice of the projected state
// (e.g. "scalars", "client_keys", "provider_family:codex", "oauth_aliases:claude").
type DomainKey string

// StateEnvelope pairs a monotonically increasing state version with its payload.
type StateEnvelope[T any] struct {
	Version uint64 `json:"version"`
	Data    T      `json:"data"`
}

// DomainSpec binds a flush handler and React Query invalidation scopes to a DomainKey
// or DomainKey prefix. Registering new configuration features requires only adding a spec.
type DomainSpec[S any] struct {
	// Order controls deterministic flush ordering when multiple domains flush in one batch.
	Order int
	// Scopes names the frontend query-key scopes invalidated when this domain changes or rolls back.
	Scopes []string
	// Flush persists this domain's slice from the immutable snapshot to CLIProxyAPI.
	Flush func(ctx context.Context, key DomainKey, snapshot S) error
	// CleanPending optionally trims per-domain transient staging entries from the live state
	// under mu after Flush succeeds, using sequence numbers captured in snapshot so newer
	// mutations queued during Flush I/O remain intact.
	CleanPending func(state *S, key DomainKey, flushedSnapshot S)
}

// Options configures a generic StateCoordinator over state type S.
type Options[S any] struct {
	// Load fetches the authoritative full configuration state from CLIProxyAPI.
	Load func(ctx context.Context) (S, error)
	// Clone returns a deep copy of S so in-memory mutations and background flushes
	// never share mutable slices or maps across lock boundaries.
	Clone func(S) S
	// ProjectSafe builds a strictly redacted, secret-free snapshot included in SSE
	// sync_error events so clients reconcile immediately without credential exposure.
	ProjectSafe func(state S, version uint64) any
	// ScrubError extracts a machine-readable code and secret-redacted message from a flush error,
	// receiving the attempted snapshot so secrets introduced since the last Load are scrubbed too.
	ScrubError func(err error, snapshot S) (code string, message string)
	// WithWriteGate optionally wraps upstream flush/reload I/O inside an external write gate
	// (such as Handler.providerWrites + configMu) to serialize against structural writes.
	WithWriteGate func(ctx context.Context, fn func(context.Context) error) error
	// OnDomainOutcome is invoked asynchronously per pending audit entry once a domain's
	// write-behind flush either succeeds (flushErr == nil) or fails (flushErr != nil).
	OnDomainOutcome func(record PendingAuditRecord, flushErr error, snapshot S)
	// AfterFlush runs after a batch of domains flushes cleanly to upstream.
	AfterFlush func(domains []DomainKey)

	DebounceWindow time.Duration
	MaxBatchWait   time.Duration
	LoadTimeout    time.Duration
	FlushTimeout   time.Duration
	Broker         *Broker
	Logger         *slog.Logger
}

type prefixRegistration[S any] struct {
	prefix string
	spec   DomainSpec[S]
}

// Coordinator manages an in-memory hot projection of upstream configuration state:
//   - RWMutex-protected <1ms reads and singleflight cold-miss protection;
//   - optimistic in-memory writes with monotonic Version++ and 250ms debounced coalescing;
//   - serialized single-goroutine upstream persistence;
//   - automatic upstream reload and SSE sync_error broadcast on persistence failure.
//
// Lock ordering invariant:
//
//	External WriteGate (if any) -> flushMu -> mu (leaf RWMutex, zero I/O)
//	Broker.mu is an independent leaf lock and is never acquired while holding mu.
//
// PendingAuditRecord captures request-scoped audit metadata for an asynchronous
// write-behind mutation so the terminal success/failure audit event is written
// only after CLIProxyAPI actually accepts or rejects the flush.
type PendingAuditRecord struct {
	Action        string
	TargetType    string
	TargetID      string
	RequestID     string
	SourceSummary string
	Details       map[string]any
}

type Coordinator[S any] struct {
	opts Options[S]

	// flushMu serializes flush executions between writeBehindLoop and explicit FlushNow calls.
	flushMu sync.Mutex

	// mu protects state, version, invalidationEpoch, isReady, isClosed, pendingInvalidation, dirtyGen, and pendingAudits.
	// CRITICAL: Never perform network or disk I/O while holding mu.
	mu                  sync.RWMutex
	state               S
	version             uint64
	invalidationEpoch   uint64
	isReady             bool
	isClosed            bool
	pendingInvalidation bool
	// dirtyGen maps each dirty DomainKey to the state version that last mutated it.
	// Comparing generation numbers on flush completion prevents clearing a newer
	// mutation that arrived while the previous HTTP flush was in flight.
	dirtyGen      map[DomainKey]uint64
	pendingAudits map[DomainKey][]PendingAuditRecord

	exactDomains  map[DomainKey]DomainSpec[S]
	prefixDomains []prefixRegistration[S]

	loadGroup singleflight.Group

	// wakeupCh has capacity 1: Mutate signals writeBehindLoop with a non-blocking send
	// so writers never stall even if a debounce cycle or upstream flush is active.
	wakeupCh  chan struct{}
	stopCh    chan struct{}
	startOnce sync.Once
	stopOnce  sync.Once
	loopWG    sync.WaitGroup
}

// New constructs a Coordinator with safe defaults and initializes its SSE broker if omitted.
func New[S any](opts Options[S]) *Coordinator[S] {
	if opts.DebounceWindow <= 0 {
		opts.DebounceWindow = DefaultDebounceWindow
	}
	if opts.MaxBatchWait <= 0 {
		opts.MaxBatchWait = DefaultMaxBatchWait
	}
	if opts.LoadTimeout <= 0 {
		opts.LoadTimeout = DefaultLoadTimeout
	}
	if opts.FlushTimeout <= 0 {
		opts.FlushTimeout = DefaultFlushTimeout
	}
	if opts.Broker == nil {
		opts.Broker = NewBroker()
	}
	if opts.Logger == nil {
		opts.Logger = slog.Default()
	}
	if opts.Clone == nil {
		opts.Clone = func(value S) S { return value }
	}
	if opts.ScrubError == nil {
		opts.ScrubError = func(err error, _ S) (string, string) {
			if err == nil {
				return "", ""
			}
			// Fail closed by default: never leak raw upstream transport or secret-bearing error strings.
			return "upstream_sync_failed", "upstream configuration sync failed"
		}
	}
	return &Coordinator[S]{
		opts:          opts,
		dirtyGen:      make(map[DomainKey]uint64),
		pendingAudits: make(map[DomainKey][]PendingAuditRecord),
		exactDomains:  make(map[DomainKey]DomainSpec[S]),
		wakeupCh:      make(chan struct{}, 1),
		stopCh:        make(chan struct{}),
	}
}

// Broker returns the SSE event broker associated with this coordinator.
func (c *Coordinator[S]) Broker() *Broker {
	return c.opts.Broker
}

// RegisterDomain registers an exact DomainKey flusher. Call during initialization before Start.
func (c *Coordinator[S]) RegisterDomain(key DomainKey, spec DomainSpec[S]) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.exactDomains[key] = spec
}

// RegisterDomainPrefix registers a parameterized DomainKey prefix (e.g. "provider_family:").
func (c *Coordinator[S]) RegisterDomainPrefix(prefix string, spec DomainSpec[S]) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.prefixDomains = append(c.prefixDomains, prefixRegistration[S]{prefix: prefix, spec: spec})
}

func (c *Coordinator[S]) resolveDomainLocked(key DomainKey) (DomainSpec[S], bool) {
	if spec, ok := c.exactDomains[key]; ok {
		return spec, true
	}
	raw := string(key)
	for _, entry := range c.prefixDomains {
		if len(raw) >= len(entry.prefix) && raw[:len(entry.prefix)] == entry.prefix {
			return entry.spec, true
		}
	}
	return DomainSpec[S]{}, false
}

// Bootstrap performs cold-loading from CLIProxyAPI at service startup, populating
// the in-memory projection with Version = 1 before HTTP traffic arrives.
func (c *Coordinator[S]) Bootstrap(ctx context.Context) error {
	loadCtx, cancel := context.WithTimeout(ctx, c.opts.LoadTimeout)
	defer cancel()

	loaded, err := c.opts.Load(loadCtx)
	if err != nil {
		return err
	}

	c.mu.Lock()
	c.state = c.opts.Clone(loaded)
	if c.version == 0 {
		c.version = 1
	} else {
		c.version++
	}
	c.isReady = true
	clear(c.dirtyGen)
	c.mu.Unlock()
	return nil
}

// Start launches the single background writeBehindLoop goroutine. Safe to call once.
func (c *Coordinator[S]) Start() {
	c.startOnce.Do(func() {
		c.loopWG.Add(1)
		go c.writeBehindLoop()
	})
}

// Version reports the current monotonic version (0 before initial load).
func (c *Coordinator[S]) Version() uint64 {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.version
}

// IsDirty reports whether un-flushed write-behind mutations are pending in memory.
func (c *Coordinator[S]) IsDirty() bool {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return len(c.dirtyGen) > 0
}

// Read returns a deep-cloned snapshot of the hot in-memory state in <1ms.
// When the cache is cold or invalidated, singleflight coalesces concurrent callers
// into a single upstream load so CPA is never stampeded.
func (c *Coordinator[S]) Read(ctx context.Context) (StateEnvelope[S], error) {
	c.mu.RLock()
	if c.isReady {
		env := StateEnvelope[S]{
			Version: c.version,
			Data:    c.opts.Clone(c.state),
		}
		c.mu.RUnlock()
		return env, nil
	}
	c.mu.RUnlock()

	if err := c.ensureLoaded(ctx); err != nil {
		return StateEnvelope[S]{}, err
	}

	c.mu.RLock()
	defer c.mu.RUnlock()
	return StateEnvelope[S]{
		Version: c.version,
		Data:    c.opts.Clone(c.state),
	}, nil
}

// Project runs a read-only projection callback directly under RLock once state is ready.
// Because projectFn builds its own DTO output without mutating state, read endpoints avoid
// cloning unrelated configuration trees and consistently respond well under 1ms.
func (c *Coordinator[S]) Project(ctx context.Context, projectFn func(state S, version uint64) (any, error)) (StateEnvelope[any], error) {
	c.mu.RLock()
	if c.isReady {
		version := c.version
		projected, err := projectFn(c.state, version)
		c.mu.RUnlock()
		if err != nil {
			return StateEnvelope[any]{}, err
		}
		return StateEnvelope[any]{Version: version, Data: projected}, nil
	}
	c.mu.RUnlock()

	if err := c.ensureLoaded(ctx); err != nil {
		return StateEnvelope[any]{}, err
	}

	c.mu.RLock()
	version := c.version
	projected, err := projectFn(c.state, version)
	c.mu.RUnlock()
	if err != nil {
		return StateEnvelope[any]{}, err
	}
	return StateEnvelope[any]{Version: version, Data: projected}, nil
}

// ProjectTyped is a strongly typed generic wrapper around Coordinator read projection.
func ProjectTyped[S any, P any](ctx context.Context, c *Coordinator[S], projectFn func(state S, version uint64) (P, error)) (StateEnvelope[P], error) {
	c.mu.RLock()
	if c.isReady {
		version := c.version
		projected, err := projectFn(c.state, version)
		c.mu.RUnlock()
		if err != nil {
			return StateEnvelope[P]{}, err
		}
		return StateEnvelope[P]{Version: version, Data: projected}, nil
	}
	c.mu.RUnlock()

	if err := c.ensureLoaded(ctx); err != nil {
		return StateEnvelope[P]{}, err
	}

	c.mu.RLock()
	version := c.version
	projected, err := projectFn(c.state, version)
	c.mu.RUnlock()
	if err != nil {
		return StateEnvelope[P]{}, err
	}
	return StateEnvelope[P]{Version: version, Data: projected}, nil
}

// ensureLoaded populates the hot cache via singleflight when cold or invalidated.
// The upstream fetch context is detached from any single HTTP caller's cancellation so
// one aborted browser request cannot fail the shared flight for other concurrent readers,
// while each individual caller still exits promptly if its own ctx is cancelled.
func (c *Coordinator[S]) ensureLoaded(ctx context.Context) error {
	resultCh := c.loadGroup.DoChan("bootstrap", func() (any, error) {
		c.mu.RLock()
		alreadyReady := c.isReady
		observedEpoch := c.invalidationEpoch
		c.mu.RUnlock()
		if alreadyReady {
			return nil, nil
		}

		loadCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), c.opts.LoadTimeout)
		defer cancel()

		loaded, err := c.opts.Load(loadCtx)
		if err != nil {
			return nil, err
		}

		c.mu.Lock()
		// Re-check under write lock: if a mutation populated dirty state or Invalidate()
		// advanced invalidationEpoch while we were reading upstream, discard the stale snapshot.
		if !c.isReady && len(c.dirtyGen) == 0 && c.invalidationEpoch == observedEpoch {
			c.state = c.opts.Clone(loaded)
			if c.version == 0 {
				c.version = 1
			} else {
				c.version++
			}
			c.isReady = true
		}
		stillCold := !c.isReady && len(c.dirtyGen) == 0
		c.mu.Unlock()

		// If Invalidate raced with our load, do one fresh read so callers receive post-write state.
		if stillCold {
			retryCtx, retryCancel := context.WithTimeout(context.WithoutCancel(ctx), c.opts.LoadTimeout)
			defer retryCancel()
			c.mu.RLock()
			retryEpoch := c.invalidationEpoch
			c.mu.RUnlock()
			fresh, freshErr := c.opts.Load(retryCtx)
			if freshErr != nil {
				return nil, freshErr
			}
			c.mu.Lock()
			if !c.isReady && len(c.dirtyGen) == 0 && c.invalidationEpoch == retryEpoch {
				c.state = c.opts.Clone(fresh)
				if c.version == 0 {
					c.version = 1
				} else {
					c.version++
				}
				c.isReady = true
			}
			c.mu.Unlock()
		}
		return nil, nil
	})

	select {
	case <-ctx.Done():
		return ctx.Err()
	case res := <-resultCh:
		return res.Err
	}
}

// Mutate validates and applies an in-memory configuration mutation atomically:
//  1. Ensures initial state is loaded;
//  2. Applies mutateFn to an isolated clone under write lock (rolling back automatically if mutateFn errors);
//  3. Increments Version++, marks domain dirty at the new version, and non-blockingly wakes writeBehindLoop.
func (c *Coordinator[S]) Mutate(ctx context.Context, domain DomainKey, mutateFn func(state *S) error) (uint64, error) {
	return c.MutateWithAudit(ctx, domain, nil, mutateFn)
}

// MutateWithAudit atomically applies mutateFn, marks domain dirty, and attaches an optional
// PendingAuditRecord under the same coordinator write lock before waking writeBehindLoop,
// ensuring no concurrent flush can observe the mutation without its paired audit record.
func (c *Coordinator[S]) MutateWithAudit(ctx context.Context, domain DomainKey, audit *PendingAuditRecord, mutateFn func(state *S) error) (uint64, error) {
	if err := c.ensureLoaded(ctx); err != nil {
		return 0, err
	}

	c.mu.Lock()
	if c.isClosed {
		c.mu.Unlock()
		return 0, ErrCoordinatorClosed
	}
	if !c.isReady {
		c.mu.Unlock()
		if err := c.ensureLoaded(ctx); err != nil {
			return 0, err
		}
		c.mu.Lock()
		if c.isClosed {
			c.mu.Unlock()
			return 0, ErrCoordinatorClosed
		}
		if !c.isReady {
			c.mu.Unlock()
			return 0, ErrCoordinatorUnready
		}
	}

	if _, known := c.resolveDomainLocked(domain); !known {
		c.mu.Unlock()
		return 0, fmt.Errorf("unregistered state coordinator domain %q", domain)
	}

	// Mutate a deep clone so a mid-function validation error leaves c.state untouched.
	candidate := c.opts.Clone(c.state)
	if err := mutateFn(&candidate); err != nil {
		c.mu.Unlock()
		return 0, err
	}

	c.state = candidate
	c.version++
	version := c.version
	c.dirtyGen[domain] = version
	if audit != nil && audit.Action != "" {
		c.pendingAudits[domain] = append(c.pendingAudits[domain], *audit)
	}
	c.mu.Unlock()

	c.signalWakeup()
	return version, nil
}

func (c *Coordinator[S]) signalWakeup() {
	// Non-blocking send on capacity-1 channel: if a wakeup token is already queued,
	// writeBehindLoop will either reset its debounce timer or pick up the new dirtyGen
	// on the next iteration without stalling the HTTP handler goroutine.
	select {
	case c.wakeupCh <- struct{}{}:
	default:
	}
}

// writeBehindLoop is the single background worker that coalesces bursts of mutations
// over DebounceWindow (250ms) and flushes dirty domains serially to CLIProxyAPI.
func (c *Coordinator[S]) writeBehindLoop() {
	defer c.loopWG.Done()

	// Create an initially stopped, drained timer so timer.C never fires spuriously.
	debounceTimer := time.NewTimer(c.opts.DebounceWindow)
	if !debounceTimer.Stop() {
		select {
		case <-debounceTimer.C:
		default:
		}
	}
	timerArmed := false
	var batchStartedAt time.Time

	stopAndDrainTimer := func() {
		if !timerArmed {
			return
		}
		if !debounceTimer.Stop() {
			select {
			case <-debounceTimer.C:
			default:
			}
		}
		timerArmed = false
	}

	armTimer := func(now time.Time) {
		if batchStartedAt.IsZero() {
			batchStartedAt = now
		}
		delay := c.opts.DebounceWindow
		// Cap continuous deferrals at MaxBatchWait so non-stop edits still checkpoint.
		if remaining := c.opts.MaxBatchWait - now.Sub(batchStartedAt); remaining < delay {
			if remaining <= 0 {
				delay = time.Millisecond
			} else {
				delay = remaining
			}
		}
		stopAndDrainTimer()
		debounceTimer.Reset(delay)
		timerArmed = true
	}

	for {
		select {
		case <-c.stopCh:
			stopAndDrainTimer()
			return

		case <-c.wakeupCh:
			if !c.IsDirty() {
				continue
			}
			armTimer(time.Now())

		case <-debounceTimer.C:
			timerArmed = false
			batchStartedAt = time.Time{}

			flushCtx, cancel := context.WithTimeout(context.Background(), c.opts.FlushTimeout)
			_ = c.FlushNow(flushCtx)
			cancel()

			// If new mutations arrived while FlushNow was executing over HTTP, re-arm
			// the debounce window so those newer generations are persisted next.
			if c.IsDirty() {
				armTimer(time.Now())
			}
		}
	}
}

type pendingDomainFlush[S any] struct {
	key    DomainKey
	gen    uint64
	spec   DomainSpec[S]
	audits []PendingAuditRecord
}

// QueueDomainAudit attaches a request-scoped audit entry to a dirty domain so its
// terminal outcome ('success' or 'failure') is recorded when the domain flushes.
func (c *Coordinator[S]) QueueDomainAudit(domain DomainKey, record PendingAuditRecord) {
	c.mu.Lock()
	c.pendingAudits[domain] = append(c.pendingAudits[domain], record)
	c.mu.Unlock()
}

// FlushNow synchronously flushes any currently dirty domains through the configured
// external write gate. Safe to call before synchronous structural writes or on shutdown.
//
// Lock-order invariant: External WriteGate MUST be acquired BEFORE flushMu so FlushNow
// (used by writeBehindLoop and Close) and FlushWithinGate (called by handlers that already
// hold WriteGate) always acquire locks in the exact same acyclic order:
//
//	External WriteGate -> flushMu -> mu
//
// Checking IsDirty() first avoids acquiring WriteGate when there is nothing to flush.
func (c *Coordinator[S]) FlushNow(ctx context.Context) error {
	if !c.IsDirty() {
		return nil
	}
	if c.opts.WithWriteGate != nil {
		return c.opts.WithWriteGate(ctx, c.FlushWithinGate)
	}
	return c.FlushWithinGate(ctx)
}

// FlushWithinGate flushes dirty domains when the caller ALREADY holds the external
// write gate (e.g. inside managementConfigPatch or gatedProviderListWrite), avoiding
// re-entrant lock acquisition while guaranteeing upstream consistency before read-modify-write.
func (c *Coordinator[S]) FlushWithinGate(ctx context.Context) error {
	c.flushMu.Lock()
	defer c.flushMu.Unlock()
	return c.flushUngatedLocked(ctx)
}

func (c *Coordinator[S]) flushUngatedLocked(ctx context.Context) error {
	// Step 1: Snapshot dirty domains and clone state under leaf lock; release mu BEFORE I/O.
	c.mu.RLock()
	if !c.isReady || len(c.dirtyGen) == 0 {
		c.mu.RUnlock()
		return nil
	}
	snapshot := c.opts.Clone(c.state)
	dirtyCopy := maps.Clone(c.dirtyGen)
	pending := make([]pendingDomainFlush[S], 0, len(dirtyCopy))
	for key, gen := range dirtyCopy {
		if spec, ok := c.resolveDomainLocked(key); ok {
			audits := slices.Clone(c.pendingAudits[key])
			pending = append(pending, pendingDomainFlush[S]{key: key, gen: gen, spec: spec, audits: audits})
		}
	}
	c.mu.RUnlock()

	if len(pending) == 0 {
		return nil
	}

	// Deterministic flush order prevents order-dependent test or YAML diff variance.
	slices.SortFunc(pending, func(left, right pendingDomainFlush[S]) int {
		if left.spec.Order != right.spec.Order {
			return left.spec.Order - right.spec.Order
		}
		if left.key < right.key {
			return -1
		}
		if left.key > right.key {
			return 1
		}
		return 0
	})

	// Step 2: Persist each dirty domain serially to CLIProxyAPI with mu UNLOCKED.
	// Continue flushing independent domains even if an earlier domain fails so valid
	// unrelated mutations in the same 250ms batch are preserved instead of discarded.
	flushedItems := make([]pendingDomainFlush[S], 0, len(pending))
	flushedKeys := make([]DomainKey, 0, len(pending))
	type failedDomainFlush struct {
		item pendingDomainFlush[S]
		err  error
	}
	var failedItems []failedDomainFlush
	scopeSet := make(map[string]struct{})
	var firstFlushErr error
	for idx := range pending {
		item := pending[idx]
		for _, scope := range item.spec.Scopes {
			scopeSet[scope] = struct{}{}
		}
		if err := item.spec.Flush(ctx, item.key, snapshot); err != nil {
			if firstFlushErr == nil {
				firstFlushErr = err
			}
			failedItems = append(failedItems, failedDomainFlush{item: item, err: err})
			continue
		}
		flushedItems = append(flushedItems, item)
		flushedKeys = append(flushedKeys, item.key)
	}

	if firstFlushErr != nil {
		// Consume audit records for succeeded domains before reconciling failed ones.
		c.mu.Lock()
		for _, okItem := range flushedItems {
			if currentGen, stillDirty := c.dirtyGen[okItem.key]; stillDirty && currentGen == okItem.gen {
				delete(c.dirtyGen, okItem.key)
			}
			if existing := c.pendingAudits[okItem.key]; len(existing) > 0 {
				if len(existing) <= len(okItem.audits) {
					delete(c.pendingAudits, okItem.key)
				} else {
					c.pendingAudits[okItem.key] = slices.Clone(existing[len(okItem.audits):])
				}
			}
		}
		c.mu.Unlock()

		if c.opts.OnDomainOutcome != nil {
			for _, okItem := range flushedItems {
				for _, rec := range okItem.audits {
					c.opts.OnDomainOutcome(rec, nil, snapshot)
				}
			}
			for _, failed := range failedItems {
				for _, rec := range failed.item.audits {
					c.opts.OnDomainOutcome(rec, failed.err, snapshot)
				}
			}
		}
		if c.opts.AfterFlush != nil && len(flushedKeys) > 0 {
			c.opts.AfterFlush(flushedKeys)
		}
		c.reconcileFlushFailure(ctx, firstFlushErr, snapshot, pending)
		return firstFlushErr
	}

	// Step 3: Clear only domains whose generation did NOT advance during Step 2 I/O,
	// trim flushed staging entries, consume flushed audit entries, and apply any deferred invalidation.
	c.mu.Lock()
	hasCleaners := false
	for _, item := range flushedItems {
		if item.spec.CleanPending != nil {
			hasCleaners = true
		}
		if currentGen, stillDirty := c.dirtyGen[item.key]; stillDirty && currentGen == item.gen {
			delete(c.dirtyGen, item.key)
		}
		if existing := c.pendingAudits[item.key]; len(existing) > 0 {
			if len(existing) <= len(item.audits) {
				delete(c.pendingAudits, item.key)
			} else {
				c.pendingAudits[item.key] = slices.Clone(existing[len(item.audits):])
			}
		}
	}
	if hasCleaners {
		cleaned := c.opts.Clone(c.state)
		for _, item := range flushedItems {
			if item.spec.CleanPending != nil {
				item.spec.CleanPending(&cleaned, item.key, snapshot)
			}
		}
		c.state = cleaned
	}
	if len(c.dirtyGen) == 0 && c.pendingInvalidation {
		c.isReady = false
		c.pendingInvalidation = false
	}
	currentVersion := c.version
	c.mu.Unlock()

	if c.opts.OnDomainOutcome != nil {
		for _, item := range flushedItems {
			for _, rec := range item.audits {
				c.opts.OnDomainOutcome(rec, nil, snapshot)
			}
		}
	}

	if c.opts.AfterFlush != nil && len(flushedKeys) > 0 {
		c.opts.AfterFlush(flushedKeys)
	}

	scopes := sortedScopeList(scopeSet)
	c.opts.Broker.Publish(Event{
		Type:    EventStateSync,
		Version: currentVersion,
		Scopes:  scopes,
	})
	return nil
}

// reconcileFlushFailure recovers from a failed asynchronous CPA write by reloading the
// authoritative configuration from CPA, overwriting speculative in-memory state, and
// pushing an SSE sync_error event carrying the sanitized real snapshot.
func (c *Coordinator[S]) reconcileFlushFailure(ctx context.Context, flushErr error, snapshot S, attempted []pendingDomainFlush[S]) {
	code, message := c.opts.ScrubError(flushErr, snapshot)
	c.opts.Logger.Warn("state coordinator write-behind flush failed; reconciling from upstream",
		"code", code,
		"error", message,
	)

	scopeSet := make(map[string]struct{})
	alreadyReported := make(map[DomainKey]int, len(attempted))
	for _, item := range attempted {
		alreadyReported[item.key] = len(item.audits)
		for _, scope := range item.spec.Scopes {
			scopeSet[scope] = struct{}{}
		}
	}

	reloadCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), c.opts.LoadTimeout)
	defer cancel()

	authoritative, reloadErr := c.opts.Load(reloadCtx)

	var safePayload any
	var newVersion uint64
	var lateAudits []PendingAuditRecord
	var latestSnapshot S

	c.mu.Lock()
	latestSnapshot = c.opts.Clone(c.state)
	// Include scopes for any domain that became dirty during Flush/Load I/O so SSE
	// subscribers reconcile every rolled-back scope, not only the attempted subset.
	for key := range c.dirtyGen {
		if spec, ok := c.resolveDomainLocked(key); ok {
			for _, scope := range spec.Scopes {
				scopeSet[scope] = struct{}{}
			}
		}
	}
	// Any audit records queued while Flush/Load I/O was running are rolled back by
	// the authoritative reload, so collect them now and emit terminal failure outcomes.
	for key, records := range c.pendingAudits {
		skip := alreadyReported[key]
		if skip < len(records) {
			lateAudits = append(lateAudits, records[skip:]...)
		}
	}
	clear(c.dirtyGen)
	clear(c.pendingAudits)
	c.pendingInvalidation = false
	c.version++
	newVersion = c.version
	if reloadErr == nil {
		c.state = c.opts.Clone(authoritative)
		c.isReady = true
		if c.opts.ProjectSafe != nil {
			safePayload = c.opts.ProjectSafe(c.state, newVersion)
		}
	} else {
		// Upstream is still unreachable: mark projection unready so the next read
		// re-fetches via singleflight instead of serving the rejected optimistic state.
		c.isReady = false
		c.opts.Logger.Warn("state coordinator upstream reload after flush failure also failed",
			"error", reloadErr.Error(),
		)
	}
	c.mu.Unlock()

	if c.opts.OnDomainOutcome != nil && len(lateAudits) > 0 {
		supersededErr := fmt.Errorf("superseded by upstream reconciliation: %w", flushErr)
		for _, rec := range lateAudits {
			c.opts.OnDomainOutcome(rec, supersededErr, latestSnapshot)
		}
	}

	c.opts.Broker.Publish(Event{
		Type:    EventSyncError,
		Version: newVersion,
		Scopes:  sortedScopeList(scopeSet),
		Code:    code,
		Error:   message,
		Data:    safePayload,
	})
}

// UpdateBaseline updates upstream-owned baseline metadata in place even when unrelated
// domains have pending mutations, passing clean=true when dirtyGen is empty.
func (c *Coordinator[S]) UpdateBaseline(updateFn func(state *S, isClean bool)) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.isClosed || !c.isReady {
		return false
	}
	candidate := c.opts.Clone(c.state)
	updateFn(&candidate, len(c.dirtyGen) == 0)
	c.state = candidate
	return true
}

// RefreshCleanBaseline updates non-dirty baseline metadata in place only when
// no write-behind mutations are pending in memory. If a new Mutate landed while
// the caller was reading upstream metadata, the update is skipped so speculative
// state is never overwritten.
func (c *Coordinator[S]) RefreshCleanBaseline(updateFn func(state *S)) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.isClosed || !c.isReady || len(c.dirtyGen) > 0 {
		return false
	}
	candidate := c.opts.Clone(c.state)
	updateFn(&candidate)
	c.state = candidate
	return true
}

// Invalidate marks the cached projection stale after a synchronous structural write
// (e.g. raw YAML save, provider create/delete, backup restore) and broadcasts state_sync
// so open tabs invalidate their React Query caches.
func (c *Coordinator[S]) Invalidate(scopes ...string) uint64 {
	c.mu.Lock()
	c.invalidationEpoch++
	if len(c.dirtyGen) == 0 {
		c.isReady = false
		c.pendingInvalidation = false
	} else {
		c.pendingInvalidation = true
	}
	c.version++
	version := c.version
	c.mu.Unlock()

	scopeSet := make(map[string]struct{}, len(scopes))
	for _, scope := range scopes {
		if scope != "" {
			scopeSet[scope] = struct{}{}
		}
	}
	c.opts.Broker.Publish(Event{
		Type:    EventStateSync,
		Version: version,
		Scopes:  sortedScopeList(scopeSet),
	})
	return version
}

// Close stops writeBehindLoop, performs a final synchronous flush of any pending
// mutations within ctx, and closes the SSE broker so HTTP shutdown never blocks.
func (c *Coordinator[S]) Close(ctx context.Context) error {
	var flushErr error
	c.stopOnce.Do(func() {
		c.mu.Lock()
		c.isClosed = true
		c.mu.Unlock()

		close(c.stopCh)
		c.loopWG.Wait()

		flushErr = c.FlushNow(ctx)
		c.opts.Broker.Close()
	})
	return flushErr
}

func sortedScopeList(set map[string]struct{}) []string {
	if len(set) == 0 {
		return nil
	}
	out := make([]string, 0, len(set))
	for scope := range set {
		out = append(out, scope)
	}
	slices.Sort(out)
	return out
}
