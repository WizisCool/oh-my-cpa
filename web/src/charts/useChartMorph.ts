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
export function useChartMorph<T, E extends HTMLElement = HTMLDivElement>(value: T) {
  const scopeRef = React.useRef<E | null>(null);
  const [shown, setShown] = React.useState(value);

  React.useEffect(() => {
    if (Object.is(value, shown)) return;
    const scope = scopeRef.current as MorphScope | null;
    if (!scope?.startViewTransition || isMotionReduced() || !scope.isConnected) {
      setShown(value);
      return;
    }
    // A newer value skips the running fade and starts from wherever it had got to.
    scope.startViewTransition(() => flushSync(() => setShown(value))).ready.catch(() => {});
  }, [value, shown]);

  return { shown, scopeRef };
}
