import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * A one-line slot for a label that may be bare text or a rich node, such as a mark beside a name.
 *
 * A block slot sets its content on a text line: an inline-flex node sits on the baseline and the
 * line box grows by the font's descent below it, so the node lands above the slot's centre, and
 * further still when a CJK fallback brings a deeper descent. As a flex row the slot centres every
 * node on its own box. Bare text is wrapped so it keeps its ellipsis, and only the last part gives
 * way when space runs out, so a mark never shrinks beside a long name.
 */
export const LINE_SLOT_CLASS =
  'flex min-w-0 items-center gap-1.5 overflow-hidden whitespace-nowrap [&>*]:min-w-0 [&>*]:shrink-0 [&>*]:truncate [&>*:last-child]:shrink';

/** Wraps bare text among a slot's children so it can truncate; nodes pass through as flex items. */
export function lineSlotChildren(children: React.ReactNode): React.ReactNode {
  return React.Children.map(children, (child) => {
    if (typeof child === 'string' || typeof child === 'number') {
      return <span>{child}</span>;
    }
    if (React.isValidElement<{ children?: React.ReactNode }>(child) && child.type === React.Fragment) {
      const normalized = lineSlotChildren(child.props.children);
      return child.key !== null ? <React.Fragment key={child.key}>{normalized}</React.Fragment> : <React.Fragment>{normalized}</React.Fragment>;
    }
    return child;
  });
}

export function LineSlot({ className, children, ...props }: React.HTMLAttributes<HTMLSpanElement>) {
  return (
    <span className={cn(LINE_SLOT_CLASS, className)} {...props}>
      {lineSlotChildren(children)}
    </span>
  );
}
