import React from 'react';
import clsx from 'clsx';
import { useT } from '../../i18n';

/**
 * The console's first-load placeholders: soft ink-washed blocks standing exactly where the content
 * will land, so the frame that replaces them moves nothing.
 *
 * They breathe - a smooth symmetric opacity cycle staggered row by row so one calm wave runs
 * down the frame without sweeping a layout-costing gradient across every bar. Active transitions
 * between loading shells (e.g. `ShellLoading -> RouteLoading -> Page`) hand over their phase and
 * skip the 120ms anti-flash delay so the skeleton never vanishes between phases.
 */

type PlaceholderStyle = React.CSSProperties & { '--placeholder-row'?: number };

export interface PlaceholderProps {
  width?: number | string;
  height?: number | string;
  /** The row in the breathing wave: each step starts 85ms later. */
  row?: number;
  className?: string;
}

export function Placeholder({ width, height, row = 0, className }: PlaceholderProps) {
  const style: PlaceholderStyle = { width, height, '--placeholder-row': row };
  return <span className={clsx('placeholder', className)} style={style} aria-hidden="true" />;
}

export interface LoadingRegionProps {
  children: React.ReactNode;
  className?: string;
  label?: string;
  /**
   * Keeps the wrapper element mounted at one React fiber position across `true -> false`
   * transitions so child panels preserve stateful interactions while the outer status role clears.
   */
  isLoading?: boolean;
  /** Shows immediately without the 120ms anti-flash delay (used for shell boot frames). */
  isImmediate?: boolean;
}

// One full breath: the 1600ms keyframe run forwards and back.
const BREATH_PERIOD_MS = 3200;
const HANDOVER_WINDOW_MS = 240;

let activeLoadingRegions = 0;
let lastRegionEndedAt = -Infinity;

function nowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

const IsInLoadingRegion = React.createContext(false);

/**
 * The status region a placeholder sits in. The region carries the name, because the blocks are
 * decoration and a bare `aria-busy` is announced as an unlabelled status.
 *
 * A region inside another is only a box, so a page frame can compose the body placeholders without
 * announcing itself twice. Every region starts its breath at the same point of one document-wide
 * cycle: a lazy route's frame hands over to the page's own first-load frame mid-breath, and a
 * restarted cycle would make the blocks blink at the seam.
 */
export function LoadingRegion({ children, className, label, isLoading = true, isImmediate = false }: LoadingRegionProps) {
  const t = useT();
  const isNested = React.useContext(IsInLoadingRegion);
  const [mountState] = React.useState(() => {
    const tNow = nowMs();
    const elapsed = tNow - lastRegionEndedAt;
    const isHandover = isImmediate || activeLoadingRegions > 0 || (elapsed >= 0 && elapsed < HANDOVER_WINDOW_MS);
    return {
      epoch: `${-(tNow % BREATH_PERIOD_MS)}ms`,
      isHandover,
    };
  });
  const isActive = isLoading && !isNested;

  React.useLayoutEffect(() => {
    if (!isActive) return undefined;
    activeLoadingRegions += 1;
    return () => {
      activeLoadingRegions = Math.max(0, activeLoadingRegions - 1);
      lastRegionEndedAt = nowMs();
    };
  }, [isActive]);

  return (
    <div
      className={clsx('loading-region', className)}
      style={isActive ? ({ '--placeholder-epoch': mountState.epoch } as React.CSSProperties) : undefined}
      data-handover={isActive && mountState.isHandover ? 'true' : undefined}
      role={isActive ? 'status' : undefined}
      aria-busy={isActive ? 'true' : undefined}
      aria-label={isActive ? (label ?? t('common.loading')) : undefined}
    >
      <IsInLoadingRegion.Provider value={isNested || isLoading}>{children}</IsInLoadingRegion.Provider>
    </div>
  );
}

// Uneven on purpose: identical bars read as a pattern, not as rows of differing names.
const NAME_WIDTHS = [34, 46, 28, 40, 31, 44, 37, 25];
const META_WIDTHS = [52, 38, 60, 45, 56, 33, 48, 58];

/**
 * List rows: a leading mark, a name and its meta line, and a trailing state - the shape every
 * console list (providers, credentials, keys, plugins, logs) shares closely enough that the real
 * rows land without a jump in rhythm.
 */
export function ListPlaceholder({ rows = 6, isFramed = false }: { rows?: number; isFramed?: boolean }) {
  return (
    <div className={clsx('placeholder-list', isFramed && 'placeholder-frame')}>
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="placeholder-list-row">
          <Placeholder width={32} height={32} row={index} className="is-control" />
          <span className="placeholder-list-text">
            <Placeholder width={`${NAME_WIDTHS[index % NAME_WIDTHS.length]}%`} row={index} className="placeholder-line" />
            <Placeholder width={`${META_WIDTHS[index % META_WIDTHS.length]}%`} row={index} className="placeholder-line is-meta" />
          </span>
          <Placeholder width={48} height={20} row={index} className="is-control" />
        </div>
      ))}
    </div>
  );
}

/**
 * The page head: the title, in the line box `PageHeader` sets it in, with optional subtitle bar
 * and right-hand toolbar placeholders when the target view carries page-level controls.
 */
export function PageHeadPlaceholder({
  titleWidth = 148,
  subtitleWidth,
  actions,
  children,
}: {
  titleWidth?: number | string;
  subtitleWidth?: number | string;
  actions?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <div className="terminal-page-head placeholder-page-head">
      <div className="terminal-page-heading placeholder-page-heading">
        <Placeholder width={titleWidth} className="placeholder-title" />
        {subtitleWidth !== undefined && (
          <Placeholder width={subtitleWidth} row={1} className="placeholder-line is-meta" />
        )}
        {children}
      </div>
      {actions ? <div className="terminal-page-actions">{actions}</div> : null}
    </div>
  );
}
