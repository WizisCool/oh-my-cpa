import React from 'react';
import { useT } from '../../i18n';
import { isMotionReduced } from '../../utils/motionPreference';
import { ElasticEdge, type ElasticEdgeBounds } from './elasticEdge';

export interface DrawerResizeHandleProps {
  /** The id of the panel section the separator resizes. */
  controls?: string;
  bounds(): ElasticEdgeBounds;
  defaultWidth(): number;
  onCommit(width: number): void;
  onReset(): void;
}

/**
 * A side panel's resizable leading edge: drag it to resize, click it to return to the opening
 * width. The grip is the border itself swelling where the pointer rests. It renders once and is then driven by `ElasticEdge` outside React: a re-render per
 * animation frame would re-reconcile whatever the panel holds. The separator is a child of antd's
 * content wrapper, the element whose width the panel takes, so it reads and drives that element
 * directly.
 */
export function DrawerResizeHandle({ controls, ...callbacks }: DrawerResizeHandleProps) {
  const t = useT();
  const handleRef = React.useRef<HTMLDivElement>(null);
  const glyphRef = React.useRef<SVGSVGElement>(null);
  const inkRef = React.useRef<SVGPathElement>(null);
  const gradientRef = React.useRef<SVGLinearGradientElement>(null);
  // `url(#…)` needs an id without the colons React's ids carry.
  const gradientId = `drawer-edge-${React.useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  const liveRef = React.useRef<HTMLSpanElement>(null);
  // The engine outlives renders; it reads the newest callbacks and copy through this ref.
  const latest = React.useRef({ ...callbacks, t });
  latest.current = { ...callbacks, t };

  React.useEffect(() => {
    const handle = handleRef.current;
    const wrapper = handle?.parentElement;
    if (!handle || !wrapper || !glyphRef.current || !inkRef.current || !gradientRef.current) return undefined;
    const engine = new ElasticEdge({
      handle,
      glyph: glyphRef.current,
      ink: inkRef.current,
      gradient: gradientRef.current,
      readWidth: () => wrapper.getBoundingClientRect().width,
      readRight: () => wrapper.getBoundingClientRect().right,
      bounds: () => latest.current.bounds(),
      defaultWidth: () => latest.current.defaultWidth(),
      setLiveWidth: (width) => {
        if (width === null) wrapper.style.removeProperty('--app-drawer-live');
        else wrapper.style.setProperty('--app-drawer-live', `${width.toFixed(1)}px`);
      },
      commit: (width) => latest.current.onCommit(width),
      reset: () => latest.current.onReset(),
      describe: (width) => latest.current.t('common.drawer_width', { px: width }),
      announce: (text) => { if (liveRef.current) liveRef.current.textContent = text; },
      isReducedMotion: isMotionReduced,
    });
    return () => engine.destroy();
  }, []);

  return (
    <>
      <div
        ref={handleRef}
        className="app-drawer-resize"
        role="separator"
        tabIndex={0}
        aria-orientation="vertical"
        aria-controls={controls}
        aria-label={t('common.drawer_resize')}
      >
        <svg ref={glyphRef} className="app-drawer-resize-grip" viewBox="0 0 24 200" width="24" height="200" aria-hidden="true">
          <defs>
            {/* The swell's ink at full strength only through its middle, gone at both ends. */}
            <linearGradient ref={gradientRef} id={gradientId} gradientUnits="userSpaceOnUse" x1="0" x2="0" y1="0" y2="200">
              <stop offset="0" stopColor="currentColor" stopOpacity="0" />
              <stop offset="0.3" stopColor="currentColor" stopOpacity="1" />
              <stop offset="0.7" stopColor="currentColor" stopOpacity="1" />
              <stop offset="1" stopColor="currentColor" stopOpacity="0" />
            </linearGradient>
          </defs>
          <path ref={inkRef} className="app-drawer-resize-ink" stroke={`url(#${gradientId})`} />
        </svg>
      </div>
      <span ref={liveRef} className="sr-only" aria-live="polite" />
    </>
  );
}
