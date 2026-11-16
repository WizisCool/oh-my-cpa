import clsx from 'clsx';
import { LoadingRegion, Placeholder } from './Placeholder';

// Page-only compositions stay behind route imports; sign-in and shell fallbacks need only the kit.
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
export function TablePlaceholder({
  rows = 8,
  hasHeader = false,
  className,
}: {
  rows?: number;
  hasHeader?: boolean;
  className?: string;
}) {
  return (
    <LoadingRegion className={clsx('placeholder-table', className)}>
      {hasHeader && (
        <div className="placeholder-table-head" aria-hidden="true">
          {TABLE_COLUMNS.map((share, column) => (
            <span key={column} className="placeholder-table-cell" style={{ flexBasis: `${share}%` }}>
              <Placeholder width={`${36 + ((column * 17) % 3) * 14}%`} row={0} className="placeholder-line is-meta" />
            </span>
          ))}
        </div>
      )}
      {Array.from({ length: rows }, (_, row) => (
        <div key={row} className="placeholder-table-row">
          {TABLE_COLUMNS.map((share, column) => (
            <span key={column} className="placeholder-table-cell" style={{ flexBasis: `${share}%` }}>
              <Placeholder width={`${55 + ((row * 5 + column * 3) % 4) * 15}%`} row={row + (hasHeader ? 1 : 0)} className="placeholder-line" />
            </span>
          ))}
        </div>
      ))}
    </LoadingRegion>
  );
}

const LOG_ROW_SHAPES = [
  { level: 34, method: 42, message: '64%' },
  { level: 40, method: 34, message: '52%' },
  { level: 34, method: 48, message: '74%' },
  { level: 36, method: 38, message: '44%' },
  { level: 40, method: 44, message: '68%' },
  { level: 34, method: 32, message: '58%' },
] as const;

/** Structured monospace log stream rows for CPA/Service log tails. */
export function LogLinesPlaceholder({ rows = 8, className }: { rows?: number; className?: string }) {
  return (
    <LoadingRegion className={clsx('placeholder-log-lines', className)}>
      {Array.from({ length: rows }, (_, row) => {
        const shape = LOG_ROW_SHAPES[row % LOG_ROW_SHAPES.length];
        return (
          <div key={row} className="placeholder-log-row">
            <Placeholder width={68} row={row} className="placeholder-line is-meta" />
            <Placeholder width={shape.level} height={18} row={row} className="is-pill" />
            <Placeholder width={shape.method} row={row} className="placeholder-line is-meta" />
            <Placeholder width={shape.message} row={row} className="placeholder-line placeholder-log-message" />
          </div>
        );
      })}
    </LoadingRegion>
  );
}

const CODE_LINE_SHAPES = [
  { indent: 0, width: '32%' },
  { indent: 1, width: '48%' },
  { indent: 1, width: '38%' },
  { indent: 2, width: '56%' },
  { indent: 2, width: '42%' },
  { indent: 0, width: '28%' },
  { indent: 1, width: '64%' },
  { indent: 1, width: '50%' },
  { indent: 2, width: '36%' },
  { indent: 1, width: '44%' },
] as const;

/** Indented YAML/code editor lines with line-number gutter. */
export function CodeLinesPlaceholder({ rows = 12, className }: { rows?: number; className?: string }) {
  return (
    <LoadingRegion className={clsx('placeholder-code-lines', className)}>
      {Array.from({ length: rows }, (_, row) => {
        const shape = CODE_LINE_SHAPES[row % CODE_LINE_SHAPES.length];
        return (
          <div key={row} className="placeholder-code-row">
            <Placeholder width={20} row={row} className="placeholder-line is-meta" />
            <span className="placeholder-code-body" style={{ paddingLeft: `${shape.indent * 18}px` }}>
              <Placeholder width={shape.width} row={row} className="placeholder-line" />
            </span>
          </div>
        );
      })}
    </LoadingRegion>
  );
}
