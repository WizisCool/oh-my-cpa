import React from 'react';

import { createDisposableSlot, type DisposableSlot } from '../../hooks/disposableSlot';
import { EVENT_SEARCH_DEBOUNCE_MS } from '../../types/usageEventCadence';
import { createSearchDebounce } from './searchDebounce';

/**
 * The search box's debounce.
 *
 * The policy - what invalidates a queued keystroke, and why the commit is read at
 * fire time - lives in `searchDebounce.ts` and is tested there. This hook owns only
 * what needs a component: the box's rendered value, the controller's lifetime, and
 * reading the latest commit so a filter changed during the debounce window is not
 * erased.
 *
 * `resetToken` is the signal the committed value cannot provide: a clear-all runs
 * while this box is usually already empty, so nothing observable changes and a
 * queued keystroke would land after it.
 */
export function useDebouncedSearch(
  committed: string,
  commit: (value: string) => void,
  resetToken: number,
) {
  const [value, setValue] = React.useState(committed);
  // The controller is built by the effect that owns it and released by its cleanup,
  // so a StrictMode remount builds a fresh one. Creating it during render and
  // disposing it in the cleanup is the failure this avoids: React runs mount ->
  // unmount -> mount in development, the first cleanup would dispose the controller,
  // and the remount would hand every consumer the *disposed* one - `change` returns
  // early forever, so the search box stops committing while looking perfectly
  // healthy. Production builds skip the double-invoke, so only the dev server ever
  // showed it. `disposableSlot` owns that rule for the provider toggle too.
  const slotRef = React.useRef<DisposableSlot<ReturnType<typeof createSearchDebounce>> | null>(null);
  if (slotRef.current === null) {
    slotRef.current = createDisposableSlot(() =>
      createSearchDebounce({ delayMs: EVENT_SEARCH_DEBOUNCE_MS }),
    );
  }
  const slot = slotRef.current;
  const controller = slot.current();

  // Read at call time so the timer invokes the current render's commit rather than
  // the one captured when it was scheduled.
  const commitRef = React.useRef(commit);
  React.useEffect(() => {
    commitRef.current = commit;
  });

  // Installs the controller for this effect lifetime. A remount after the StrictMode
  // unmount takes this path again and builds a live controller, which is what keeps
  // the search box working on the development server.
  React.useEffect(() => {
    slot.setup();
    return () => slot.teardown();
  }, [slot]);

  // The committed value is the source of truth for every change that did not come
  // from this box: hydration from saved preferences, Back/Forward, a drill-down, a
  // removed chip. Adopting it also cancels whatever this box had queued against the
  // value it replaces.
  React.useEffect(() => {
    controller?.sync(committed);
    setValue(committed);
  }, [committed, controller]);

  // A clear runs while this box is usually already empty, so nothing observable
  // changes and the committed value cannot signal that queued work must be dropped.
  // That is what the token is for.
  //
  // The rendered value is reset here as well as the queue being invalidated. The two
  // are separate needs that share one event: clearing must drop queued work (the
  // token's job) *and* empty the box, because a keystroke typed before the clear is
  // still on screen even though the URL it was typed against is gone.
  React.useEffect(() => {
    controller?.invalidate();
    setValue(committed);
  }, [resetToken, committed, controller]);

  const change = React.useCallback(
    (next: string) => {
      setValue(next);
      // Read through the slot rather than closing over the controller: a StrictMode
      // remount replaces the instance, and a handler captured against the old one
      // would write into a controller nobody is draining.
      slot.current()?.change(next, (value_) => commitRef.current(value_));
    },
    [slot],
  );

  return [value, change] as const;
}
