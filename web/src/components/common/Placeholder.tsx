import React from 'react';
import clsx from 'clsx';
import { useT } from '../../i18n';

/**
 * The console's first-load placeholders: flat blocks in the border step, standing exactly where the
 * content will land, so the frame that replaces them moves nothing.
 *
 * They breathe - an opacity cycle, staggered row by row so the wave runs down the frame - because a
 * frozen grey frame reads as a page that has stalled. An opacity cycle stays on the compositor
 * without sweeping a gradient across the content. The cycle exists only while
 * nothing has ever loaded (a refresh keeps its data on screen and never shows a placeholder), and
 * reduced motion freezes it.
 */

type PlaceholderStyle = React.CSSProperties & { '--placeholder-row'?: number };

export interface PlaceholderProps {
  width?: number | string;
  height?: number | string;
  /** The row in the breathing wave: each step starts one `--motion-base` later. */
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
}

// One full breath: the 1400ms keyframe run forwards and back.
const BREATH_PERIOD_MS = 2800;

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
export function LoadingRegion({ children, className }: LoadingRegionProps) {
  const t = useT();
  const isNested = React.useContext(IsInLoadingRegion);
  const [epoch] = React.useState(() => `${-(performance.now() % BREATH_PERIOD_MS)}ms`);
  if (isNested) return <div className={clsx('loading-region', className)}>{children}</div>;
  return (
    <div
      className={clsx('loading-region', className)}
      style={{ '--placeholder-epoch': epoch } as React.CSSProperties}
      role="status"
      aria-busy="true"
      aria-label={t('common.loading')}
    >
      <IsInLoadingRegion.Provider value>{children}</IsInLoadingRegion.Provider>
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
    <div className={clsx('placeholder-list', isFramed && 'terminal-panel')}>
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="placeholder-list-row">
          <Placeholder width={28} height={28} row={index} />
          <span className="placeholder-list-text">
            <Placeholder width={`${NAME_WIDTHS[index % NAME_WIDTHS.length]}%`} row={index} className="placeholder-line" />
            <Placeholder width={`${META_WIDTHS[index % META_WIDTHS.length]}%`} row={index} className="placeholder-line is-meta" />
          </span>
          <Placeholder width={56} height={20} row={index} className="placeholder-pill" />
        </div>
      ))}
    </div>
  );
}

/**
 * The page head: the title, in the line box `PageHeader` sets it in. No subtitle line, because most
 * subtitles summarise data that has not arrived, so the head the page first draws is a title alone.
 */
export function PageHeadPlaceholder() {
  return (
    <div className="terminal-page-head placeholder-page-head">
      <Placeholder width={168} className="placeholder-title" />
    </div>
  );
}
