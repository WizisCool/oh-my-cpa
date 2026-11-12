import * as React from 'react';
import { flushSync } from 'react-dom';
import { isMotionReduced } from '@/utils/motionPreference';

type MorphScope = HTMLElement & {
  startViewTransition?: (update: () => void) => { ready: Promise<void> };
};

/**
 * Hands a chart its data so that a new set arrives as one render and a compositor cross-fade.
 *
 * A chart library's own update tween re-renders every mark on every frame - hundreds of SVG paths
 * in a stacked bar - so a change of grouping stuttered for a third of a second. Here the chart
 * renders the new `value` once, inside an element-scoped view transition: the browser snapshots
 * the scope before and after and fades one into the other on the GPU, while the rest of the page
 * stays interactive. Where scoped transitions are missing, or motion is reduced, the new value
 * simply lands.
 *
 * The chart renders `shown`, not `value`, and puts `scopeRef` on its own box. Charts using this
 * turn their library's update animation off.
 */
export function useChartMorph<T, E extends HTMLElement = HTMLDivElement>(
  value: T,
  isSame: (next: T, current: T) => boolean = Object.is,
) {
  const scopeRef = React.useRef<E | null>(null);
  const [shown, setShown] = React.useState(value);

  React.useEffect(() => {
    if (isSame(value, shown)) return;
    const scope = scopeRef.current as MorphScope | null;
    if (!scope?.startViewTransition || isMotionReduced() || !scope.isConnected) {
      setShown(value);
      return;
    }
    // A newer value skips the running fade and starts from wherever it had got to.
    scope.startViewTransition(() => flushSync(() => setShown(value))).ready.catch(() => {});
  }, [value, shown, isSame]);

  return { shown, scopeRef };
}

const isHandlerKey = (key: string) => /^on[A-Z]/.test(key);

/**
 * Whether two prop objects draw the same chart: every field the same value, event handlers aside.
 * A handler (`onSelect`, `onBrush`) says what a click does, not what is drawn, and parents commonly
 * pass a fresh one on every render; counting it would redraw every mark for nothing. A handler that
 * appears or goes does count: it turns the chart's clicks on or off.
 */
export function isSameDrawing<T extends object>(next: T, current: T): boolean {
  if (Object.is(next, current)) return true;
  const nextKeys = Object.keys(next) as (keyof T & string)[];
  if (nextKeys.length !== Object.keys(current).length) return false;
  return nextKeys.every((key) => Object.is(next[key], current[key])
    || (isHandlerKey(key) && typeof next[key] === 'function' && typeof current[key] === 'function'));
}

/**
 * A chart's props as the morph should draw them: the drawing from `shown`, and its event handlers
 * as stable functions that always call the newest one passed, so a handler is never stale and never
 * by itself a reason to re-render the marks.
 */
export function useMorphedProps<T extends object>(props: T): { shown: T; scopeRef: React.RefObject<HTMLDivElement | null> } {
  const { shown, scopeRef } = useChartMorph(props, isSameDrawing);
  const latest = React.useRef<Record<string, unknown>>(props as Record<string, unknown>);
  React.useLayoutEffect(() => {
    latest.current = props as Record<string, unknown>;
  });
  const stable = React.useRef(new Map<string, (...args: unknown[]) => unknown>());
  const withHandlers = React.useMemo(() => {
    const out: Record<string, unknown> = { ...(shown as Record<string, unknown>) };
    for (const [key, value] of Object.entries(shown as Record<string, unknown>)) {
      if (!isHandlerKey(key) || typeof value !== 'function') continue;
      let handler = stable.current.get(key);
      if (!handler) {
        handler = (...args: unknown[]) => (latest.current[key] as ((...a: unknown[]) => unknown) | undefined)?.(...args);
        stable.current.set(key, handler);
      }
      out[key] = handler;
    }
    return out as T;
  }, [shown]);
  return { shown: withHandlers, scopeRef };
}
