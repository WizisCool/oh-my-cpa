import React from 'react';
import clsx from 'clsx';
import { useT } from '../../i18n';

/**
 * The console's first-load placeholders: flat blocks in the border step, standing exactly where the
 * content will land, so the frame that replaces them moves nothing.
 *
 * They breathe - an opacity cycle, staggered row by row so the wave runs down the frame - because a
 * frozen grey frame reads as a page that has stalled, while antd's sweeping gradient is the shimmer
 * design.md §7 rule 3 forbids. Opacity alone stays on the compositor, the cycle exists only while
 * nothing has ever loaded (a refresh keeps its data on screen and never shows a placeholder), and
 * reduced motion freezes it. See ADR 0052.
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

export interface PlaceholderLinesProps {
  /** One width per line; the count of widths is the count of lines. */
  widths: Array<number | string>;
  /** The wave row of the first line. */
  row?: number;
  className?: string;
}

/** Text lines: one bar per line of the copy that will replace it. */
export function PlaceholderLines({ widths, row = 0, className }: PlaceholderLinesProps) {
  return (
    <span className={clsx('placeholder-lines', className)}>
      {widths.map((width, index) => (
        <Placeholder key={index} width={width} row={row + index} className="placeholder-line" />
      ))}
    </span>
  );
}

export interface LoadingRegionProps {
  children: React.ReactNode;
  className?: string;
}

/**
 * The status region a placeholder sits in. The region carries the name, because the blocks are
 * decoration and a bare `aria-busy` is announced as an unlabelled status.
 */
export function LoadingRegion({ children, className }: LoadingRegionProps) {
  const t = useT();
  return (
    <div className={clsx('loading-region', className)} role="status" aria-busy="true" aria-label={t('common.loading')}>
      {children}
    </div>
  );
}

// Uneven on purpose: identical bars read as a pattern, not as rows of differing names.
const NAME_WIDTHS = ['34%', '46%', '28%', '40%', '31%', '44%', '37%', '25%'];
const META_WIDTHS = ['52%', '38%', '60%', '45%', '56%', '33%', '48%', '58%'];

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
          <Placeholder width={28} height={28} row={index} className="placeholder-mark" />
          <span className="placeholder-list-text">
            <Placeholder width={NAME_WIDTHS[index % NAME_WIDTHS.length]} row={index} className="placeholder-line" />
            <Placeholder width={META_WIDTHS[index % META_WIDTHS.length]} row={index} className="placeholder-line is-meta" />
          </span>
          <Placeholder width={56} height={20} row={index} className="placeholder-pill" />
        </div>
      ))}
    </div>
  );
}

/** The page head: the title and its one subtitle line, at the heights `PageHeader` renders them. */
export function PageHeadPlaceholder() {
  return (
    <div className="terminal-page-head placeholder-page-head">
      <span className="placeholder-lines">
        <Placeholder width={168} className="placeholder-title" />
        <Placeholder width={312} row={1} className="placeholder-line is-subtitle" />
      </span>
    </div>
  );
}

// Paragraph lines run long-long-short, the way prose and form fields actually wrap.
const PARAGRAPH_WIDTHS = ['100%', '92%', '64%', '96%', '84%', '72%', '100%', '58%'];

/** Lines of a body that will hold prose, a form or a document: a drawer, a panel, an editor. */
export function ParagraphPlaceholder({ rows = 4, className }: { rows?: number; className?: string }) {
  return (
    <LoadingRegion className={clsx('placeholder-paragraph', className)}>
      <PlaceholderLines widths={Array.from({ length: rows }, (_, index) => PARAGRAPH_WIDTHS[index % PARAGRAPH_WIDTHS.length])} />
    </LoadingRegion>
  );
}

// Column shares for a request-style table row; each row varies them a little so columns read as
// data rather than as stripes.
const TABLE_COLUMNS = [14, 22, 18, 12, 10, 12];

/** Rows of a dense table, at the row height of the console's request list. */
export function TablePlaceholder({ rows = 8, className }: { rows?: number; className?: string }) {
  return (
    <LoadingRegion className={clsx('placeholder-table', className)}>
      {Array.from({ length: rows }, (_, row) => (
        <div key={row} className="placeholder-table-row">
          {TABLE_COLUMNS.map((share, column) => (
            <span key={column} className="placeholder-table-cell" style={{ flexBasis: `${share}%` }}>
              <Placeholder width={`${55 + ((row * 5 + column * 3) % 4) * 15}%`} row={row} className="placeholder-line" />
            </span>
          ))}
        </div>
      ))}
    </LoadingRegion>
  );
}
