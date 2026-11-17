import * as React from 'react';
import { stackCapShape } from './stackCap';
import { MOTION_ROLL } from '../theme/themeConfig';

/**
 * Stacked bars that glide from one drawing to the next instead of cross-fading.
 *
 * When a chart keeps its buckets and some of its series - a series picked out of the stack, a legend
 * toggle, another metric, a poll's revision - every segment that is drawn on both sides travels from
 * its old box to its new one, a segment that arrives fades in where it belongs once the others have
 * mostly settled, and one that goes leaves at once (the console's filter rule: what remains moves, what is dropped does not linger).
 *
 * The chart library re-keys a segment whenever its box changes, so there is no element to tween in
 * place. Instead each segment is drawn inside a `<g>` that names its series and bucket and carries
 * its box as an attribute; the old boxes are read before the update (attributes, no layout), and each
 * segment the update mounts is played from its old box with one Web Animations transform. Nothing
 * re-renders during the glide.
 */

/** Past this many segments a glide would cost more than a frame, and the drawing cross-fades instead. */
export const GLIDE_SEGMENT_LIMIT = 600;

const GLIDE_SELECTOR = '[data-glide]';

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

function readBox(element: Element): Box | null {
  const parts = element.getAttribute('data-glide-box')?.split(' ').map(Number);
  if (!parts || parts.length !== 4 || parts.some((part) => !Number.isFinite(part))) return null;
  const [x, y, w, h] = parts as [number, number, number, number];
  return { x, y, w, h };
}

/** A stacked series' segment, capped like every bar and named for the glide. */
export function glideStackShape(series: string) {
  const draw = stackCapShape(series);
  return function GlideSegment(shapeProps: unknown) {
    const bar = shapeProps as { x?: number; y?: number; width?: number; height?: number; payload?: { bucketIndex?: number } };
    return (
      <g data-glide={`${series}|${bar.payload?.bucketIndex}`} data-glide-box={`${bar.x} ${bar.y} ${bar.width} ${bar.height}`}>
        {draw(shapeProps)}
      </g>
    );
  };
}

const transformOf = (box: Box, to: Box) => {
  const sx = to.w > 0 ? box.w / to.w : 1;
  const sy = to.h > 0 ? box.h / to.h : 1;
  // SVG transforms from the user-space origin, so this lands the target box on `box`.
  return `translate(${box.x - sx * to.x}px, ${box.y - sy * to.y}px) scale(${sx}, ${sy})`;
};
const AT_REST = 'translate(0px, 0px) scale(1, 1)';

export interface BarGlide {
  /** Reads the boxes on screen and watches for the segments the next drawing mounts. */
  arm: () => void;
  /** The next drawing has committed: stop watching once its segments have had a frame to land. */
  settle: () => void;
  dispose: () => void;
}

export function useBarGlide(scopeRef: React.RefObject<Element | null>): BarGlide {
  const glide = React.useMemo(() => {
    let before: Map<string, Box> | null = null;
    let observer: MutationObserver | null = null;
    const playing = new WeakMap<Element, Animation>();

    // Where a segment is drawn now: its box, or, mid-glide, the box its running transform puts it at.
    const shownBox = (element: Element): Box | null => {
      const box = readBox(element);
      if (!box || playing.get(element)?.playState !== 'running') return box;
      const m = new DOMMatrixReadOnly(getComputedStyle(element).transform);
      return { x: m.a * box.x + m.e, y: m.d * box.y + m.f, w: m.a * box.w, h: m.d * box.h };
    };

    const play = (element: Element) => {
      const to = readBox(element);
      if (!to || to.w <= 0 || to.h <= 0) return;
      const from = before?.get(element.getAttribute('data-glide') ?? '');
      if (from && from.x === to.x && from.y === to.y && from.w === to.w && from.h === to.h) return;
      const keyframes = from
        ? [{ transform: transformOf(from, to) }, { transform: AT_REST }]
        // A part that was not drawn fades in where it belongs once the moving parts are four fifths
        // of the way home: the offset is read on the same curve they travel, so it never shows
        // through a segment still passing over its place.
        : [{ opacity: 0 }, { opacity: 0, offset: 0.8 }, { opacity: 1 }];
      playing.set(element, element.animate(keyframes, { duration: MOTION_ROLL.duration, easing: MOTION_ROLL.easing }));
    };

    const stop = () => {
      observer?.disconnect();
      observer = null;
      before = null;
    };

    return {
      arm() {
        const scope = scopeRef.current;
        stop();
        // Without Web Animations the new boxes simply land.
        if (!scope || typeof scope.animate !== 'function') return;
        const boxes = new Map<string, Box>();
        for (const element of scope.querySelectorAll(GLIDE_SELECTOR)) {
          const box = shownBox(element);
          if (box) boxes.set(element.getAttribute('data-glide') ?? '', box);
        }
        before = boxes;
        // A mutation callback runs before the frame that would paint the new boxes.
        observer = new MutationObserver((records) => {
          for (const record of records) {
            for (const node of record.addedNodes) {
              if (!(node instanceof Element)) continue;
              if (node.matches(GLIDE_SELECTOR)) play(node);
              for (const element of node.querySelectorAll(GLIDE_SELECTOR)) play(element);
            }
          }
        });
        observer.observe(scope, { childList: true, subtree: true });
      },
      settle() {
        const current = observer;
        if (!current) return;
        requestAnimationFrame(() => requestAnimationFrame(() => {
          if (observer === current) stop();
        }));
      },
      dispose: stop,
    };
  }, [scopeRef]);

  React.useEffect(() => glide.dispose, [glide]);
  return glide;
}
