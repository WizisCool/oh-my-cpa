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
