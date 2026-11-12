import * as React from 'react';
import { usePlotArea } from 'recharts';
import { RADIUS } from '../theme/radius';

export interface BucketBrushProps {
  /** How many category buckets the x axis holds; each is an equal band of the plot's width. */
  bucketCount: number;
  /** A span of at least two buckets was swept: `from` and `to` are inclusive bucket indexes. */
  onBrush: (from: number, to: number) => void;
}

/** Travel, in pixels, before a press becomes a sweep rather than a click on a mark. */
const SWEEP_THRESHOLD = 4;

/**
 * BucketBrush lets the reader sweep a stretch of a category-axis chart to zoom into it.
 *
 * Rendered as a child of the chart, it reads the plot box from the chart and listens on the chart's
 * own surface, so the pointer never meets a layer of its own: a press that does not travel is still
 * a click on the bar beneath it. Once it travels, the sweep is drawn by moving one rectangle - no
 * React render per bucket crossed - and it follows the pointer outside the plot until release.
 * Escape abandons it.
 */
export function BucketBrush({ bucketCount, onBrush }: BucketBrushProps) {
  const plot = usePlotArea();
  const bandRef = React.useRef<SVGRectElement | null>(null);
  const latest = React.useRef({ plot, bucketCount, onBrush });
  React.useLayoutEffect(() => {
    latest.current = { plot, bucketCount, onBrush };
  });

  React.useEffect(() => {
    const band = bandRef.current;
    const surface = band?.ownerSVGElement;
    if (!band || !surface) return undefined;

    let sweep: { pointerId: number; originX: number; start: number; current: number; isActive: boolean } | null = null;

    const bucketAt = (clientX: number) => {
      const { plot: area, bucketCount: count } = latest.current;
      if (!area || count <= 0) return undefined;
      const x = clientX - surface.getBoundingClientRect().left - area.x;
      return Math.min(count - 1, Math.max(0, Math.floor((x / area.width) * count)));
    };

    const draw = () => {
      const { plot: area, bucketCount: count } = latest.current;
      if (!sweep || !area) return;
      const step = area.width / count;
      const from = Math.min(sweep.start, sweep.current);
      const to = Math.max(sweep.start, sweep.current);
      band.setAttribute('x', String(area.x + from * step));
      band.setAttribute('width', String((to - from + 1) * step));
      band.setAttribute('y', String(area.y));
      band.setAttribute('height', String(area.height));
    };

    const end = (shouldCommit: boolean) => {
      if (!sweep) return;
      const { start, current, isActive, pointerId } = sweep;
      sweep = null;
      if (surface.hasPointerCapture(pointerId)) surface.releasePointerCapture(pointerId);
      surface.removeAttribute('data-sweeping');
      band.removeAttribute('data-shown');
      if (!isActive || !shouldCommit) return;
      const from = Math.min(start, current);
      const to = Math.max(start, current);
      if (to > from) latest.current.onBrush(from, to);
      // The click that follows a sweep's release is the sweep's own, not a click on the chart.
      const swallow = (event: MouseEvent) => event.stopPropagation();
      window.addEventListener('click', swallow, { capture: true, once: true });
      window.setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 0);
    };

    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0 || event.pointerType === 'touch') return;
      const { plot: area } = latest.current;
      if (!area) return;
      const box = surface.getBoundingClientRect();
      const x = event.clientX - box.left;
      const y = event.clientY - box.top;
      if (x < area.x || x > area.x + area.width || y < area.y || y > area.y + area.height) return;
      const start = bucketAt(event.clientX);
      if (start === undefined) return;
      sweep = { pointerId: event.pointerId, originX: event.clientX, start, current: start, isActive: false };
    };

    const onPointerMove = (event: PointerEvent) => {
      if (!sweep || event.pointerId !== sweep.pointerId) return;
      // Released outside the chart before the sweep began: the surface had not captured the pointer,
      // so it never heard the release, and a later pass over the chart must not start a sweep.
      if ((event.buttons & 1) === 0) {
        end(false);
        return;
      }
      if (!sweep.isActive) {
        if (Math.abs(event.clientX - sweep.originX) < SWEEP_THRESHOLD) return;
        sweep.isActive = true;
        surface.setPointerCapture(event.pointerId);
        surface.setAttribute('data-sweeping', '');
        // Placed before it shows, so the band appears where the sweep began rather than gliding in.
        draw();
        band.setAttribute('data-shown', '');
      }
      const current = bucketAt(event.clientX);
      if (current === undefined || current === sweep.current) return;
      sweep.current = current;
      draw();
    };

    const onPointerUp = (event: PointerEvent) => {
      if (sweep && event.pointerId === sweep.pointerId) end(true);
    };
    const onCancel = () => end(false);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && sweep?.isActive) end(false);
    };

    surface.addEventListener('pointerdown', onPointerDown);
    surface.addEventListener('pointermove', onPointerMove);
    surface.addEventListener('pointerup', onPointerUp);
    surface.addEventListener('pointercancel', onCancel);
    surface.addEventListener('lostpointercapture', onCancel);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      surface.removeEventListener('pointerdown', onPointerDown);
      surface.removeEventListener('pointermove', onPointerMove);
      surface.removeEventListener('pointerup', onPointerUp);
      surface.removeEventListener('pointercancel', onCancel);
      surface.removeEventListener('lostpointercapture', onCancel);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  return <rect ref={bandRef} className="omc-bucket-brush" rx={RADIUS.xs} ry={RADIUS.xs} x={0} y={0} width={0} height={0} />;
}
