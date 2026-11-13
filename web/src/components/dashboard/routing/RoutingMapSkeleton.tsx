import React from 'react';
import clsx from 'clsx';

import { brandDrawing, brandMarkup } from '../../../assets/brand/markup';
import { sharedResizeObserverHub } from '../../../performance/resizeObserverHub';
import { LoadingRegion, Placeholder } from '../../common/Placeholder';
import styles from './RoutingMapSkeleton.module.css';

interface Point {
  x: number;
  y: number;
}

const MODEL_PLACEHOLDER_ROWS = [
  { name: 108, meta: 56 },
  { name: 84, meta: 68 },
  { name: 122, meta: 48 },
] as const;

const TARGET_PLACEHOLDER_ROWS = [
  { name: 96, meta: 76 },
  { name: 120, meta: 58 },
  { name: 88, meta: 82 },
] as const;

const ORBIT_BOX = 184;
const MARK_DRAWING = brandDrawing('mark');
const MARK_MARKUP = brandMarkup('mark', { ink: 'var(--fg)', accent: 'var(--accent)' });

function curve(from: Point, to: Point): string {
  const dx = (to.x - from.x) * 0.55;
  return `M ${from.x.toFixed(1)} ${from.y.toFixed(1)} C ${(from.x + dx).toFixed(1)} ${from.y.toFixed(1)}, ${(to.x - dx).toFixed(1)} ${to.y.toFixed(1)}, ${to.x.toFixed(1)} ${to.y.toFixed(1)}`;
}

export interface RoutingMapSkeletonProps {
  className?: string;
}

/**
 * First-load topology placeholder matching `RoutingMap`'s three-column wire geometry
 * (model nodes, central gateway hub, and credential targets) across desktop and narrow
 * container breakpoints.
 */
export const RoutingMapSkeleton = React.memo(function RoutingMapSkeleton({ className }: RoutingMapSkeletonProps) {
  const containerRef = React.useRef<HTMLDivElement>(null);
  const gatewayRef = React.useRef<HTMLSpanElement>(null);
  const modelTileRefs = React.useRef<Array<HTMLSpanElement | null>>([]);
  const targetTileRefs = React.useRef<Array<HTMLSpanElement | null>>([]);
  const inPathRefs = React.useRef<Array<SVGPathElement | null>>([]);
  const outPathRefs = React.useRef<Array<SVGPathElement | null>>([]);

  const draw = React.useCallback(() => {
    const container = containerRef.current;
    const gateway = gatewayRef.current;
    if (!container || !gateway) return;

    // Phase 1: Batch geometry reads before updating SVG path strings.
    const box = container.getBoundingClientRect();
    if (!(box.width > 0 && box.height > 0)) return;
    const node = gateway.getBoundingClientRect();
    const middle = node.top + node.height / 2 - box.top;
    const gatewayLeftX = node.left - box.left;
    const gatewayRightX = node.right - box.left;
    const gatewayMidX = gatewayLeftX + node.width / 2;

    const modelAnchors = modelTileRefs.current.map((element) => {
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return { x: rect.right - box.left, y: rect.top + rect.height / 2 - box.top };
    });

    let isSpineLayout = false;
    const targetAnchors = targetTileRefs.current.map((element) => {
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      const targetMidX = rect.left - box.left + rect.width / 2;
      const isLeftOfGateway = targetMidX < gatewayMidX;
      if (isLeftOfGateway) isSpineLayout = true;
      return {
        x: (isLeftOfGateway ? rect.right : rect.left) - box.left,
        y: rect.top + rect.height / 2 - box.top,
      };
    });

    const portSpread = Math.min(10, node.height * 0.16);
    const hubIn: Point = isSpineLayout
      ? { x: gatewayLeftX, y: middle - portSpread }
      : { x: gatewayLeftX, y: middle };
    const hubOut: Point = isSpineLayout
      ? { x: gatewayLeftX, y: middle + portSpread }
      : { x: gatewayRightX, y: middle };

    // Phase 2: Write only changed SVG path strings.
    for (let i = 0; i < MODEL_PLACEHOLDER_ROWS.length; i += 1) {
      const path = inPathRefs.current[i];
      const from = modelAnchors[i];
      if (!path) continue;
      const d = from ? curve(from, hubIn) : '';
      if (path.getAttribute('d') !== d) path.setAttribute('d', d);
    }
    for (let i = 0; i < TARGET_PLACEHOLDER_ROWS.length; i += 1) {
      const path = outPathRefs.current[i];
      const to = targetAnchors[i];
      if (!path) continue;
      const d = to ? curve(hubOut, to) : '';
      if (path.getAttribute('d') !== d) path.setAttribute('d', d);
    }
  }, []);

  React.useLayoutEffect(() => {
    draw();
  }, [draw]);

  React.useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;
    return sharedResizeObserverHub.observe(container, () => draw(), { freezeOnTransition: false });
  }, [draw]);

  return (
    <LoadingRegion className={clsx(styles['scope'], className)}>
      <div ref={containerRef} className={styles['map']} data-testid="routing-skeleton" aria-hidden="true">
        <svg className={styles['map-edges']}>
          {MODEL_PLACEHOLDER_ROWS.map((_, index) => (
            <path
              key={`in:${index}`}
              ref={(element) => {
                inPathRefs.current[index] = element;
              }}
              className={styles['edge']}
              style={{ '--placeholder-row': index + 1 } as React.CSSProperties}
            />
          ))}
          {TARGET_PLACEHOLDER_ROWS.map((_, index) => (
            <path
              key={`out:${index}`}
              ref={(element) => {
                outPathRefs.current[index] = element;
              }}
              className={styles['edge']}
              style={{ '--placeholder-row': index + 1 } as React.CSSProperties}
            />
          ))}
        </svg>

        <div className={clsx(styles['map-column'], styles['column-models'])}>
          <div className={styles['column-head']}>
            <Placeholder width={36} row={0} className="placeholder-line is-meta" />
          </div>
          {MODEL_PLACEHOLDER_ROWS.map((row, index) => (
            <div key={index} className={styles['node']}>
              <span className={styles['row-text']}>
                <Placeholder width={row.name} row={index + 1} className="placeholder-line" />
                <Placeholder width={row.meta} row={index + 1} className="placeholder-line is-meta" />
              </span>
              <span
                ref={(element) => {
                  modelTileRefs.current[index] = element;
                }}
                className={styles['tile']}
              >
                <Placeholder width={18} height={18} row={index + 1} />
              </span>
            </div>
          ))}
        </div>

        <div className={styles['map-center']}>
          <div className={styles['hub']}>
            <svg className={styles['orbits']} viewBox={`0 0 ${ORBIT_BOX} ${ORBIT_BOX}`}>
              <circle className={styles['orbit-outer']} cx={ORBIT_BOX / 2} cy={ORBIT_BOX / 2} r={ORBIT_BOX / 2 - 1} />
              <circle className={styles['orbit-inner']} cx={ORBIT_BOX / 2} cy={ORBIT_BOX / 2} r={ORBIT_BOX / 2 - 26} />
            </svg>
            <span className={styles['hub-glow']} />
            <span ref={gatewayRef} className={clsx(styles['tile'], styles['gateway'])}>
              <svg
                className={styles['gateway-mark']}
                viewBox={MARK_DRAWING.viewBox}
                height={30}
                width={Math.round((30 * MARK_DRAWING.width) / MARK_DRAWING.height)}
                focusable="false"
                dangerouslySetInnerHTML={{ __html: MARK_MARKUP }}
              />
            </span>
          </div>
        </div>

        <div className={clsx(styles['map-column'], styles['column-targets'])}>
          <div className={styles['column-head']}>
            <Placeholder width={44} row={0} className="placeholder-line is-meta" />
          </div>
          {TARGET_PLACEHOLDER_ROWS.map((row, index) => (
            <div key={index} className={styles['node']}>
              <span
                ref={(element) => {
                  targetTileRefs.current[index] = element;
                }}
                className={styles['tile']}
              >
                <Placeholder width={18} height={18} row={index + 1} />
              </span>
              <span className={styles['row-text']}>
                <Placeholder width={row.name} row={index + 1} className="placeholder-line" />
                <Placeholder width={row.meta} row={index + 1} className="placeholder-line is-meta" />
              </span>
            </div>
          ))}
        </div>
      </div>
    </LoadingRegion>
  );
});
