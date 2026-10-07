import React from 'react';
import clsx from 'clsx';

/** The semantic tones a state can carry; `neutral` is the absence of a verdict. */
export type StatusTone = 'success' | 'warn' | 'danger' | 'accent' | 'neutral';

export interface StatusLabelProps extends React.HTMLAttributes<HTMLSpanElement> {
  tone: StatusTone;
  children: React.ReactNode;
  className?: string;
}

/**
 * A state, as a 7px pip and the word for it.
 *
 * The console states a state in text and paints it with the pip, never with colour alone and
 * never with a filled tag: a tag per row turned every table into a column of coloured boxes,
 * and the box itself carried no information the word did not. The label keeps the reading
 * colour (`--fg-2`) so a column of states scans as text, and the pip alone carries the tone.
 */
// Tooltip's trigger owns the DOM ref and pointer handlers; forwarding both keeps it on the label.
export const StatusLabel = React.forwardRef<HTMLSpanElement, StatusLabelProps>(function StatusLabel(
  { tone, children, className, ...attributes }, ref,
) {
  return (
    <span {...attributes} ref={ref} className={clsx('status-label', `is-${tone}`, className)}>
      <span className="status-label-pip" aria-hidden="true" />
      <span className="status-label-text">{children}</span>
    </span>
  );
});
