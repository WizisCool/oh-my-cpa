package api

import (
	"context"
	"errors"
	"net/http"
	"time"
)

// providerWriteGate serialises every whole-list read-modify-write this console
// performs against the CPA provider configuration.
//
// CPA stores each provider family as one list and exposes no per-entry write:
// changing one provider means reading the list, editing one element, and PUTting
// the whole list back. Two of those interleaved read an identical snapshot and
// the later PUT discards the earlier one, so the earlier operator's toggle is
// silently reverted while both requests report success. A per-entry guarantee
// cannot be built on top of a whole-list write, so the window in which the list
// is being replaced has to be exclusive.
//
// The gate is deliberately one global permit rather than one per family. The
// cost is negligible for a console where a write is a single round trip, and it
// also covers the configuration source writer, which replaces the whole
// configuration document rather than one family inside it.
//
// Acquisition is bounded and cancellable: a caller that cannot enter the window
// within the timeout is told the console is busy instead of parking a goroutine
// on the lock. Nothing is written to CPA when acquisition fails, which is what
// makes that refusal safe for the client to retry.
type providerWriteGate struct {
	permits chan struct{}
	// acquireTimeout is the admission bound for one request, not the budget for
	// the operation itself; the gateway call that runs after admission keeps its
	// own client timeout.
	acquireTimeout time.Duration
}

const (
	// providerWriteAcquireTimeout bounds how long a request waits for admission.
	// It is short on purpose: the client retries a refused write, so waiting
	// longer server-side only converts a fast, retryable refusal into a slow
	// one while the operator watches a switch that has not settled.
	providerWriteAcquireTimeout = 5 * time.Second
	// providerWriteBusyCode is the machine-readable refusal the client matches
	// on. It distinguishes "the console is busy, try again" from "this write
	// failed", which have different retry behaviour.
	providerWriteBusyCode = "write_busy"
)

var errProviderWriteBusy = errors.New("another provider configuration write is in progress")

func newProviderWriteGate() providerWriteGate {
	return providerWriteGate{
		permits:        make(chan struct{}, 1),
		acquireTimeout: providerWriteAcquireTimeout,
	}
}

// acquire enters the write window, or reports why it could not.
func (g *providerWriteGate) acquire(ctx context.Context) error {
	if g == nil || g.permits == nil {
		// A Handler assembled without the gate keeps working rather than
		// failing every write; only the serialisation guarantee is absent.
		return nil
	}
	timer := time.NewTimer(g.acquireTimeout)
	defer timer.Stop()
	select {
	case g.permits <- struct{}{}:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return errProviderWriteBusy
	}
}

// release exits the write window. It is safe to call only after a successful
// acquire.
func (g *providerWriteGate) release() {
	if g == nil || g.permits == nil {
		return
	}
	select {
	case <-g.permits:
	default:
	}
}

// providerWriteError carries the HTTP status a failed read-modify-write should
// report. The gateway failures it wraps are translated by writeCPAFacadeError,
// which owns that mapping; everything decided locally (an index that no longer
// exists, an unsupported family) states its own status here.
type providerWriteError struct {
	status  int
	message string
}

func (e *providerWriteError) Error() string { return e.message }

func newProviderWriteError(status int, message string) error {
	return &providerWriteError{status: status, message: message}
}

// writeProviderWriteError reports the outcome of a gated write. A failure that
// came from CPA keeps the facade's existing translation; the local refusals and
// the busy gate answer for themselves.
func writeProviderWriteError(writer http.ResponseWriter, err error) {
	var writeErr *providerWriteError
	if errors.As(err, &writeErr) {
		writeError(writer, writeErr.status, writeErr.message)
		return
	}
	if errors.Is(err, errProviderWriteBusy) {
		writeJSON(writer, http.StatusServiceUnavailable, map[string]string{
			"error": "another provider configuration write is in progress; retry shortly",
			"code":  providerWriteBusyCode,
		})
		return
	}
	writeCPAFacadeError(writer, err)
}

// gatedProviderListWrite performs a family's whole-list read-modify-write inside
// the write window.
//
// It takes the permit itself, so callers must not already hold it: the permit is
// a single slot, and re-entering would deadlock against the caller's own
// acquisition and surface as a busy refusal.
//
// The read is inside the window with the write, not before it: a list read
// outside the window is a snapshot another writer may already have replaced, so
// reading first and locking later would reproduce the very lost update this
// gate exists to prevent. `mutate` receives a pointer because appending to a
// list is as much a modification as editing an element. `afterUpdate` runs after
// the gateway has accepted the list but while the permit is still held, so the
// console's local overlays can be recorded in the same admission as the write
// they describe.
func gatedProviderListWrite[T any](
	h *Handler,
	ctx context.Context,
	read func(context.Context) (T, error),
	update func(context.Context, T) error,
	mutate func(*T) error,
	afterUpdate func(context.Context, T),
) error {
	if err := h.providerWrites.acquire(ctx); err != nil {
		return err
	}
	// Released on every exit path, including a panic in one of the callbacks: a
	// permit leaked here would refuse every later write until the process
	// restarted.
	defer h.providerWrites.release()

	list, err := read(ctx)
	if err != nil {
		return err
	}
	if err := mutate(&list); err != nil {
		return err
	}
	if err := update(ctx, list); err != nil {
		return err
	}
	// The credential lists have changed, so the masks the request list resolves from
	// them are stale. Dropping them here means a re-keyed or renamed credential
	// reads correctly on the next page rather than at the end of the TTL.
	h.providerKeyMasks.invalidate()
	if afterUpdate != nil {
		afterUpdate(ctx, list)
	}
	return nil
}
