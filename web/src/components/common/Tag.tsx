import React from 'react';
import clsx from 'clsx';

/** `neutral` labels a kind; the others pass a verdict and take that verdict's ink. */
export type TagTone = 'neutral' | 'success' | 'warn' | 'danger' | 'accent';

export interface TagProps extends React.HTMLAttributes<HTMLSpanElement> {
  tone?: TagTone;
  /** A glyph ahead of the text; it takes the tag's own ink. */
  icon?: React.ReactNode;
  /** `small` is for a tag that annotates a name inside a dense row. */
  size?: 'default' | 'small';
}

/**
 * A short label on a tinted chip: a kind ("OAuth", "Plugin"), a count, or a verdict that needs more
 * weight than `StatusLabel`'s pip - a banner-level state in a drawer head, a permission on a card.
 *
 * It has no margin. Ant Design's tag carried one, so half its call sites zeroed it inline and the
 * other half depended on it; spacing between a tag and its neighbour belongs to their container.
 */
// Tooltip's trigger owns the DOM ref and pointer handlers; forwarding both keeps it on the tag.
export const Tag = React.forwardRef<HTMLSpanElement, TagProps>(function Tag(
  { tone = 'neutral', icon, size = 'default', className, children, ...attributes }, ref,
) {
  return (
    <span {...attributes} ref={ref} className={clsx('tag', `is-${tone}`, size === 'small' && 'is-small', className)}>
      {icon !== undefined && icon !== null && <span className="tag-icon" aria-hidden="true">{icon}</span>}
      {children}
    </span>
  );
});

export interface ToggleTagProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'onChange'> {
  checked: boolean;
  onChange: (checked: boolean) => void;
}

/** A tag that is pressed to narrow a list: a facet such as "Providers (12)". */
export function ToggleTag({ checked, onChange, className, children, ...attributes }: ToggleTagProps) {
  return (
    <button
      {...attributes}
      type="button"
      aria-pressed={checked}
      className={clsx('tag is-toggle', className)}
      onClick={() => onChange(!checked)}
    >
      {children}
    </button>
  );
}
