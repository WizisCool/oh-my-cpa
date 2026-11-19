import React from 'react';
import clsx from 'clsx';

/** The semantic tones a state can carry; `neutral` is the absence of a verdict. */
export type StatusTone = 'success' | 'warn' | 'danger' | 'accent' | 'neutral';

export interface StatusLabelProps extends React.HTMLAttributes<HTMLSpanElement> {
  tone: StatusTone;
  /** `small` matches `Tag size="small"` (18px) for compact inline rows and annotations. */
  size?: 'default' | 'small';
  /** Optional trailing cue inside the chip (for example a chevron on an interactive status trigger). */
  trailing?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}

/**
 * A state as a tinted chip led by a 6px pip: soft semantic wash, tone ink and matching pip, on the
 * console's shared chip geometry (22px high, 18px small, `--radius-sm`, weight 500).
 *
 * Every status in the console - request verdicts, credential health, quota states, config sync,
 * system topology, audit results and agent/playground turn states - renders through this component
 * so a state reads the same way in lists, drawers, cards and toolbars.
 */
// Tooltip's trigger owns the DOM ref and pointer handlers; forwarding both keeps it on the label.
export const StatusLabel = React.forwardRef<HTMLSpanElement, StatusLabelProps>(function StatusLabel(
  { tone, size = 'default', trailing, children, className, ...attributes }, ref,
) {
  return (
    <span {...attributes} ref={ref} className={clsx('status-label', `is-${tone}`, size === 'small' && 'is-small', className)}>
      <span className="status-label-pip" aria-hidden="true" />
      <span className="status-label-text">{children}</span>
      {trailing !== undefined && trailing !== null && (
        <span className="status-label-trailing" aria-hidden="true">{trailing}</span>
      )}
    </span>
  );
});
