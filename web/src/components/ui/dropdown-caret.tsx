import * as React from 'react';
import { cn } from '@/lib/utils';

export interface DropdownCaretProps extends React.SVGProps<SVGSVGElement> {
  /** Rotate 180deg when an ancestor trigger carries aria-expanded="true" or data-popup-open. */
  rotateOnOpen?: boolean;
}

/**
 * Optical 12x12 disclosure/select caret.
 *
 * Drawn on a 12px coordinate grid rather than scaling a 24px icon down: the 5.5x2.75 chevron sits
 * on half-pixel centres with a 1.35px stroke so it aligns with CJK and tabular text at 32px control
 * height without dominating the label or hugging the trailing edge.
 */
export function DropdownCaret({
  className,
  rotateOnOpen = true,
  ...props
}: DropdownCaretProps) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 12 12"
      fill="none"
      aria-hidden="true"
      data-slot="dropdown-caret"
      className={cn(
        'shrink-0 text-muted-foreground transition-transform duration-150 ease-out',
        rotateOnOpen && [
          '[[aria-expanded=true]>&]:rotate-180',
          '[[data-popup-open]>&]:rotate-180',
          '[[aria-expanded=true]_&]:rotate-180',
          '[[data-popup-open]_&]:rotate-180',
        ],
        className,
      )}
      {...props}
    >
      <path
        d="M3.25 4.75L6 7.5L8.75 4.75"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
