import * as React from 'react';
import { cn } from '@/lib/utils';

export interface PanelProps extends Omit<React.ComponentProps<'div'>, 'title'> {
  title?: React.ReactNode;
  extra?: React.ReactNode;
}

/**
 * The framed surface a page sets its content on: one shadow, one radius, one inset.
 *
 * `title` and `extra` draw the header rule; a panel whose heading needs a description or a count
 * leaves them out and opens its body with a `SectionHeading` instead.
 */
export const Panel = React.forwardRef<HTMLDivElement, PanelProps>(function Panel(
  { title, extra, className, children, ...props },
  ref,
) {
  const hasHead = title !== undefined || extra !== undefined;
  return (
    <div
      ref={ref}
      data-slot="panel"
      className={cn(
        'panel flex flex-col rounded-xl bg-card text-card-foreground shadow-edge',
        className,
      )}
      {...props}
    >
      {hasHead ? (
        <div
          data-slot="panel-head"
          className="flex min-h-12 items-center justify-between gap-3 border-b-[length:var(--hairline)] border-b-border-soft px-5 py-3 max-sm:px-4"
        >
          {title !== undefined ? (
            <div data-slot="panel-head-title" className="min-w-0 flex-1 text-base font-semibold text-foreground">
              {title}
            </div>
          ) : (
            <span />
          )}
          {extra !== undefined ? <div data-slot="panel-head-extra" className="shrink-0">{extra}</div> : null}
        </div>
      ) : null}
      <div data-slot="panel-body" className="p-5 max-sm:p-4">
        {children}
      </div>
    </div>
  );
});
