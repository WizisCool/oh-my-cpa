import type { ReactNode } from 'react';
import clsx from 'clsx';
import { Tooltip } from './Tooltip';
import styles from './GlyphBadge.module.css';

export interface GlyphBadgeProps {
  glyph: ReactNode;
  /** The figure, and anything after it, such as a `GlyphBadgeSecondary`. */
  children: ReactNode;
  /** The fact in words: the accessible name, and the tooltip's first line. */
  label: string;
  /** What the fact means or why it is flagged, under the label. */
  hint?: string;
  /** The names the figure counts, one a line. */
  items?: readonly string[];
  tone?: 'warn';
  /**
   * Inside a control that already answers for the whole row (a card that opens its editor), the
   * badge is a picture only: no focus stop and no tooltip of its own.
   */
  isStatic?: boolean;
  [data: `data-${string}`]: string | undefined;
}

// A tooltip lists a handful of names; past that the figure on the badge already says how many.
const MAX_TIP_ITEMS = 8;

/**
 * A count or a routing fact as a small badge beside a name: a glyph and a figure. The label spells
 * the fact out on hover and to assistive technology, so the glyph never has to be learnt; the
 * tooltip adds what the badge has no room for, a sentence on what it means or the names it counts.
 */
export function GlyphBadge({ glyph, children, label, hint, items, tone, isStatic = false, ...data }: GlyphBadgeProps) {
  const badge = (
    <span className={clsx(styles.badge, tone && styles[`badge-${tone}`])} tabIndex={isStatic ? undefined : 0} role="img" aria-label={label} {...data}>
      <span className={styles.glyph} aria-hidden="true">{glyph}</span>
      {children}
    </span>
  );
  if (isStatic) return badge;
  const shown = items?.slice(0, MAX_TIP_ITEMS) ?? [];
  const rest = (items?.length ?? 0) - shown.length;
  const tip = (
    <div className={styles.tip}>
      <div className={styles['tip-title']}>{label}</div>
      {hint && <div className={styles['tip-hint']}>{hint}</div>}
      {shown.length > 0 && (
        <ul className={styles['tip-items']}>
          {/* Aliases can share a model name, so the position keeps the keys apart. */}
          {shown.map((item, index) => <li key={`${index}:${item}`}>{item}</li>)}
          {rest > 0 && <li className={styles['tip-more']}>+{rest}</li>}
        </ul>
      )}
    </div>
  );
  return <Tooltip title={tip}>{badge}</Tooltip>;
}

/** A quieter figure after the main one, such as a routing weight. */
export function GlyphBadgeSecondary({ children }: { children: ReactNode }) {
  return <span className={styles.secondary}>{children}</span>;
}
