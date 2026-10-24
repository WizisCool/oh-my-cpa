import React from 'react';
import { useLocation, useSearchParams } from 'react-router-dom';

/**
 * A page's view state in the URL, where each change the reader makes is one step of the platform's
 * Back.
 *
 * A filter, a tab or a grouping is something the reader did, and the most reachable control on every
 * device - the browser's back arrow, a mouse's back button, a phone's edge gesture - should take it
 * back. Written with `replace`, the change left no entry, so Back skipped every narrowing at once and
 * left the page. Written with a push per keystroke, Back would spell a search out letter by letter.
 *
 * So a change pushes, and a change that names a `coalesce` key replaces the entry when the entry in
 * force was written under the same key: the first keystroke of a search is a step, the rest refine
 * it. The key is kept on the history entry rather than in a ref, so it is still right after the reader
 * goes back and starts typing again.
 */

/** Kept beside the router's own bookkeeping on the history entry; namespaced so it cannot collide. */
const COALESCE_FIELD = 'omcViewCoalesce';

export interface ViewChangeOptions {
  /** Changes sharing a key fold into one history step while they follow each other. */
  coalesce?: string;
  /** Rewrites the entry in force: a correction or a canonical form, never something the reader did. */
  replace?: boolean;
}

export type SetViewSearchParams = (
  next: URLSearchParams | ((current: URLSearchParams) => URLSearchParams),
  options?: ViewChangeOptions,
) => void;

export function useViewSearchParams(): [URLSearchParams, SetViewSearchParams] {
  const [searchParams, setSearchParams] = useSearchParams();
  const location = useLocation();
  const entryKey = (location.state as Record<string, unknown> | null)?.[COALESCE_FIELD];
  const entryKeyRef = React.useRef(entryKey);
  entryKeyRef.current = entryKey;

  const setView = React.useCallback<SetViewSearchParams>((next, options = {}) => {
    const isFolded = options.coalesce !== undefined && entryKeyRef.current === options.coalesce;
    setSearchParams((current) => {
      const resolved = typeof next === 'function' ? next(new URLSearchParams(current)) : next;
      return resolved;
    }, {
      replace: options.replace === true || isFolded,
      state: options.coalesce === undefined ? null : { [COALESCE_FIELD]: options.coalesce },
    });
  }, [setSearchParams]);

  return [searchParams, setView];
}
