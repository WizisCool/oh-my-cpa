import React from 'react';
import { createOverlayHistory, type OverlayHistory, type OverlayHistoryHost } from './overlayHistory';

/**
 * The React binding for `overlayHistory`: one call per overlay, wired to the platform's
 * Back button.
 *
 * The contract is deliberately the one every overlay already has - a boolean saying
 * whether it is open and the callback its own UI calls to close it - so wiring a surface
 * is one line and no call site has to learn a new shape:
 *
 * ```tsx
 * useOverlayHistory({ isOpen, onClose: () => setIsOpen(false) });
 * ```
 *
 * Nothing else changes: the drawer still closes on its mask, its X and Escape, and it
 * additionally closes on Back. What the caller must not do is call `onClose` for a reason
 * that is not a dismissal; every existing call site already uses it that way.
 */

/** The sentinel marker. Namespaced so it cannot collide with a router state field. */
const SENTINEL_FIELD = 'omcOverlay';

/** `@remix-run/router` keeps its own bookkeeping here; only `key` is read by this module. */
interface RouterHistoryState {
  key?: string;
  [field: string]: unknown;
}

/** Ids to the overlay that owns them, so a pop can be dispatched to one overlay. */
const openOverlayClosers = new Map<string, () => void>();

/**
 * Dismisses the overlay a platform Back belongs to.
 *
 * Called from exactly one listener. `handlePop` must run **once per `popstate`**: it consumes
 * one sentinel per call, so a dispatcher registered per hook would have the first call answer
 * the press and every later one pop the stack again - a single Back dismissing as many
 * overlays as there were hooks mounted. That is not hypothetical; it is what the icon-picker
 * scenario caught, one Back closing both the picker and the drawer underneath it.
 */
function dispatchPop(history: OverlayHistory): void {
  const id = history.handlePop();
  if (id === undefined) return;
  // An id with no closer is a sentinel whose overlay unmounted without closing - a dead
  // entry. `handlePop` has already dropped it, so the press is spent and nothing else may be
  // dismissed for it.
  const closer = openOverlayClosers.get(id);
  if (!closer) return;
  closer();
  // Deferred to after React has committed, because a close can be *refused*: the auth-file
  // drawer asks for confirmation when an edit is in progress and stays open if the reader
  // declines. That press spent the sentinel without dismissing anything, so the sentinel is
  // re-armed rather than leaving the next press to navigate the page out from under an open
  // editor. `open` is idempotent, so a close that did happen leaves this a no-op.
  window.setTimeout(() => {
    if (openOverlayClosers.has(id)) history.open(id);
  }, 0);
}

/**
 * The browser host, created on first use.
 *
 * The listener is installed once for the whole console rather than once per overlay: a pop
 * belongs to the topmost overlay, and only one authority can decide which that is.
 */
function createBrowserOverlay(): OverlayHistory {
  const host: OverlayHistoryHost = {
    // Read from the history entry rather than from the router's location: they agree, in that
    // the router replicates this field onto its location, and reading it here keeps this module
    // free of React and of the router.
    currentKey: () => (window.history.state as RouterHistoryState | null)?.key,
    pushSentinel: (id) => {
      // The current entry's state is spread rather than replaced. `@remix-run/router` keeps its
      // `key` and `idx` in there and derives its back/forward arithmetic from the latter, so
      // dropping them would make every Back look like a forward and the router would then
      // navigate on an entry that exists only to hold an overlay.
      window.history.pushState(
        { ...(window.history.state as RouterHistoryState | null), [SENTINEL_FIELD]: id },
        '',
        window.location.href,
      );
    },
    goBack: () => window.history.back(),
    schedule: (callback) => queueMicrotask(callback),
  };
  const history = createOverlayHistory(host);
  // No listener is installed here: this function runs during render, and a global listener added
  // there is a side effect with no owner - it outlives the app unmounting and can never be released.
  // `acquirePopListener` installs it from an effect instead.
  return history;
}

let browserOverlay: OverlayHistory | undefined;

function browserOverlaySingleton(): OverlayHistory {
  browserOverlay ??= createBrowserOverlay();
  return browserOverlay;
}

/**
 * Installs the console's one `popstate` dispatcher for as long as any overlay hook is mounted.
 *
 * Two properties, each of which a simpler shape loses:
 *
 *   - **One listener, not one per hook.** A pop must be consumed exactly once, so a listener per hook
 *     would call `handlePop` repeatedly - the first call answering the press and every later one
 *     popping the stack again, which makes a single Back dismiss as many overlays as there are hooks
 *     mounted. It is ref-counted rather than owned by the first hook, so the listener lives exactly as
 *     long as something is using it and is released when the last user unmounts.
 *   - **Installed from an effect.** `AppLayout` renders inside the authentication gate, so signing out
 *     unmounts every hook at once; a listener created during render survived that and could never be
 *     cleaned up.
 */
let popListenerUsers = 0;
let releasePopListener: (() => void) | undefined;

function acquirePopListener(): () => void {
  popListenerUsers += 1;
  if (popListenerUsers === 1) {
    const notify = () => dispatchPop(browserOverlaySingleton());
    // `popstate` is not cancellable, so this cannot stop the router from also seeing it; it only
    // decides what the console does about it.
    window.addEventListener('popstate', notify);
    releasePopListener = () => window.removeEventListener('popstate', notify);
  }
  let isReleased = false;
  return () => {
    // Idempotent, so a StrictMode double-invoke cannot decrement twice and tear the listener down
    // while another hook still needs it.
    if (isReleased) return;
    isReleased = true;
    popListenerUsers -= 1;
    if (popListenerUsers === 0) {
      releasePopListener?.();
      releasePopListener = undefined;
    }
  };
}

export interface UseOverlayHistoryOptions {
  /** Whether the overlay is currently open. */
  isOpen: boolean;
  /**
   * Closes the overlay. Called by the overlay's own UI, and by this hook when the platform's
   * Back dismisses it.
   */
  onClose: () => void;
}

export function useOverlayHistory({ isOpen, onClose }: UseOverlayHistoryOptions): void {
  const history = browserOverlaySingleton();
  // Stable for the life of the mounted component and unique per overlay, which is what a
  // sentinel needs: the generated form keeps every call site from inventing an id.
  const overlayId = React.useId();

  // The callback is read through a ref so the pop dispatcher always calls the current one
  // without the effect below having to re-register on each render.
  const onCloseRef = React.useRef(onClose);
  onCloseRef.current = onClose;

  React.useEffect(() => acquirePopListener(), []);

  React.useEffect(() => {
    if (!isOpen) {
      openOverlayClosers.delete(overlayId);
      return undefined;
    }
    openOverlayClosers.set(overlayId, () => onCloseRef.current());
    return () => {
      openOverlayClosers.delete(overlayId);
    };
  }, [overlayId, isOpen]);

  React.useEffect(() => {
    if (!isOpen) {
      history.close(overlayId);
      return undefined;
    }
    history.open(overlayId);
    // An unmount while open cannot be a dismissal - there is no overlay left to close - so it
    // drops the sentinel without navigating, deferred so that StrictMode's immediate re-setup
    // cancels the departure rather than stranding a second sentinel.
    return () => history.forgetSoon(overlayId);
  }, [history, overlayId, isOpen]);
}
