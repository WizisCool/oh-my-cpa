import React from 'react';
import clsx from 'clsx';

/** The semantic tones a state can carry; `neutral` is the absence of a verdict. */
export type StatusTone = 'success' | 'warn' | 'danger' | 'accent' | 'neutral';

export interface StatusLabelProps extends React.HTMLAttributes<HTMLSpanElement> {
  tone: StatusTone;
  /**
   * `text` (the default) is a pip and a word on the surface's own ground. `chip` sets the same
   * pip and word on a tinted chip and is reserved for the outcome of an event (a request, an
   * audit event, a backup job, a warmup run) in its list's result column and in that event's own
   * drawer head, where a reader scans a column of verdicts for the exceptions.
   */
  variant?: 'text' | 'chip';
  /** `small` is the 20px line for compact rows; `default` is 22px. Both variants keep the height. */
  size?: 'default' | 'small';
  /** Optional trailing cue (for example a chevron on an interactive status trigger). */
  trailing?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}

/**
 * A state led by a round pip in its tone. A thing that lives on (a component, a credential, a
 * plugin, a key, a configuration, a quota) reports its state as text: a healthy or neutral state
 * reads in the secondary ink and only the pip carries the colour, while a warning, a failure or a
 * pending action takes the tone's ink as well, so the exception is what a page shows.
 *
 * Both variants keep one height, so a row's other parts never move between them.
 */
// Tooltip's trigger owns the DOM ref and pointer handlers; forwarding both keeps it on the label.
export const StatusLabel = React.forwardRef<HTMLSpanElement, StatusLabelProps>(function StatusLabel(
  { tone, variant = 'text', size = 'default', trailing, children, className, ...attributes }, ref,
) {
  return (
    <span
      {...attributes}
      ref={ref}
      className={clsx('status-label', `is-${tone}`, variant === 'chip' && 'is-chip', size === 'small' && 'is-small', className)}
    >
      <span className="status-label-pip" aria-hidden="true" />
      <span className="status-label-text">{children}</span>
      {trailing !== undefined && trailing !== null && (
        <span className="status-label-trailing" aria-hidden="true">{trailing}</span>
      )}
    </span>
  );
});
