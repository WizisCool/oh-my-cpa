import React from 'react';
import { brandDrawing, brandMarkup } from '../../../assets/brand/markup';
import { BUILT_IN_PALETTES } from '../../../theme/palette';
import { GithubOutlined } from '../../icons';

export interface ReceiptRow {
  label: string;
  value: string;
  tone?: 'muted' | 'up' | 'down';
}

/** A model's mark as the receipt draws it: a data URI, so an exported picture carries it too. */
export interface ReceiptMarkSource {
  src: string;
  /** A silhouette, filled with the receipt's ink rather than drawn in its own colours. */
  isMono: boolean;
}

export interface ReceiptLine {
  label: string;
  qty: string;
  amount: string;
  /** The model a line names, for its mark. */
  model?: string;
  isMuted?: boolean;
}

export interface ReceiptGroup extends ReceiptLine {
  /** A second line under the name: a key's mask beneath its alias. */
  detail?: string;
  lines: ReceiptLine[];
}

/** Everything the receipt prints, already worded and formatted. */
export interface ReceiptSheet {
  title: string;
  tagline: string;
  meta: ReceiptRow[];
  totalLabel: string;
  total: string;
  totalNote?: string;
  summary: ReceiptRow[];
  itemsHeader: [string, string, string];
  groups: ReceiptGroup[];
  /** What the itemised section says instead of lines: still reading, nothing in the window, a failed read. */
  placeholder?: string;
  tokens: ReceiptRow[];
  notes: string[];
}

/** Where the receipt says it was printed from, the way a till slip names its shop. */
const REPOSITORY = 'WizisCool/Oh-My-CPA';

/** The brand in its default colours: the light palette's ink and accent, the pair the paper is printed in. */
const BRAND_COLORS = (() => {
  const core = BUILT_IN_PALETTES.find((palette) => palette.id === 'omc-light')!.core;
  return { ink: core.fg, accent: core.accent };
})();

function Rows({ rows }: { rows: readonly ReceiptRow[] }) {
  return (
    <dl className="omc-receipt-rows">
      {rows.map((row) => (
        <div key={row.label} className={`omc-receipt-row${row.tone ? ` is-${row.tone}` : ''}`}>
          <dt>{row.label}</dt>
          <dd>{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function Mark({ source }: { source: ReceiptMarkSource | undefined }) {
  if (!source) return <span className="omc-receipt-mark is-blank" aria-hidden="true" />;
  if (source.isMono) {
    return <span className="omc-receipt-mark is-mono" style={{ '--mark': `url("${source.src}")` } as React.CSSProperties} aria-hidden="true" />;
  }
  return <img className="omc-receipt-mark" src={source.src} alt="" />;
}

interface ReceiptPaperProps {
  sheet: ReceiptSheet;
  marks: ReadonlyMap<string, ReceiptMarkSource>;
}

/**
 * The receipt itself: a strip of paper set in the console's monospace, ruled into sections the way
 * a till slip is. It carries no interaction, so the same element is what an exported picture shows.
 */
export const ReceiptPaper = React.forwardRef<HTMLElement, ReceiptPaperProps>(({ sheet, marks }, ref) => {
  const { viewBox, width, height } = brandDrawing('wordmark');
  return (
    <article ref={ref} className="omc-receipt">
      <header className="omc-receipt-head">
        <svg
          className="omc-receipt-logo"
          viewBox={viewBox}
          width={Math.round((17 * width) / height)}
          height={17}
          aria-label="Oh My CPA"
          role="img"
          dangerouslySetInnerHTML={{ __html: brandMarkup('wordmark', BRAND_COLORS) }}
        />
        <h2 className="omc-receipt-title">{sheet.title}</h2>
        <p className="omc-receipt-tagline">{sheet.tagline}</p>
      </header>
      <hr className="omc-receipt-rule" />
      <Rows rows={sheet.meta} />
      <hr className="omc-receipt-rule" />
      <section className="omc-receipt-total">
        <span className="omc-receipt-total-label">{sheet.totalLabel}</span>
        <span className="omc-receipt-total-value">{sheet.total}</span>
        {sheet.totalNote && <span className="omc-receipt-total-note">{sheet.totalNote}</span>}
      </section>
      <hr className="omc-receipt-rule" />
      <Rows rows={sheet.summary} />
      <hr className="omc-receipt-rule" />
      <div className="omc-receipt-items">
        <div className="omc-receipt-line omc-receipt-items-head">
          {sheet.itemsHeader.map((cell) => <span key={cell}>{cell}</span>)}
        </div>
        {sheet.placeholder && <p className="omc-receipt-placeholder">{sheet.placeholder}</p>}
        {sheet.groups.map((group, index) => (
          <React.Fragment key={`${group.label}-${index}`}>
            <div className={`omc-receipt-line omc-receipt-key${group.isMuted ? ' is-muted' : ''}`}>
              <span className="omc-receipt-line-name"><span>{group.label}</span></span>
              <span>{group.qty}</span>
              <span>{group.amount}</span>
            </div>
            {group.detail && <p className="omc-receipt-key-detail">{group.detail}</p>}
            {group.lines.map((line, lineIndex) => (
              <div key={`${line.label}-${lineIndex}`} className={`omc-receipt-line omc-receipt-model${line.isMuted ? ' is-muted' : ''}`}>
                <span className="omc-receipt-line-name">
                  <Mark source={line.model ? marks.get(line.model) : undefined} />
                  <span>{line.label}</span>
                </span>
                <span>{line.qty}</span>
                <span>{line.amount}</span>
              </div>
            ))}
          </React.Fragment>
        ))}
      </div>
      <hr className="omc-receipt-rule" />
      <Rows rows={sheet.tokens} />
      {sheet.notes.map((note) => <p key={note} className="omc-receipt-notes">{note}</p>)}
      <hr className="omc-receipt-rule" />
      <footer className="omc-receipt-foot">
        <GithubOutlined className="omc-receipt-foot-mark" />
        <span>{REPOSITORY}</span>
      </footer>
    </article>
  );
});
ReceiptPaper.displayName = 'ReceiptPaper';
