import * as React from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface PagerProps {
  /** 1-based. */
  page: number;
  pageSize: number;
  total: number;
  onChange: (page: number, pageSize: number) => void;
  variant?: 'numbered' | 'stepped';
  hasQuickJumper?: boolean;
  className?: string;
}

function buildPageRange(current: number, totalPages: number): (number | 'ellipsis-start' | 'ellipsis-end')[] {
  if (totalPages <= 7) {
    return Array.from({ length: totalPages }, (_, i) => i + 1);
  }
  const items: (number | 'ellipsis-start' | 'ellipsis-end')[] = [1];
  const left = Math.max(2, current - 1);
  const right = Math.min(totalPages - 1, current + 1);
  if (left > 2) items.push('ellipsis-start');
  for (let p = left; p <= right; p += 1) items.push(p);
  if (right < totalPages - 1) items.push('ellipsis-end');
  items.push(totalPages);
  return items;
}

export function Pager({
  page,
  pageSize,
  total,
  onChange,
  variant = 'numbered',
  hasQuickJumper = false,
  className,
}: PagerProps) {
  const totalPages = Math.max(1, Math.ceil(total / Math.max(1, pageSize)));
  const [jumpDraft, setJumpDraft] = React.useState('');

  if (total <= pageSize || totalPages <= 1) return null;

  const safePage = Math.min(Math.max(1, page), totalPages);
  const go = (target: number) => {
    const clamped = Math.min(Math.max(1, target), totalPages);
    if (clamped !== safePage) onChange(clamped, pageSize);
  };

  const navBtnClass =
    'inline-flex size-7 cursor-pointer items-center justify-center rounded-sm border-0 bg-secondary p-0 text-foreground shadow-control transition-colors hover:enabled:bg-secondary-hover disabled:cursor-not-allowed disabled:opacity-45 [@media(pointer:coarse)]:size-9';

  if (variant === 'stepped') {
    return (
      <nav
        aria-label="Pagination"
        data-slot="pager"
        data-variant="stepped"
        className={cn('pager inline-flex items-center gap-2 text-sm text-muted-foreground tabular-nums', className)}
      >
        <button type="button" aria-label="Previous page" disabled={safePage <= 1} onClick={() => go(safePage - 1)} className={navBtnClass}>
          <ChevronLeft className="size-3.5" />
        </button>
        <span className="px-1 text-sm text-foreground">
          {safePage} / {totalPages}
        </span>
        <button type="button" aria-label="Next page" disabled={safePage >= totalPages} onClick={() => go(safePage + 1)} className={navBtnClass}>
          <ChevronRight className="size-3.5" />
        </button>
      </nav>
    );
  }

  const pages = buildPageRange(safePage, totalPages);

  return (
    <nav
      aria-label="Pagination"
      data-slot="pager"
      data-variant="numbered"
      className={cn('pager inline-flex flex-wrap items-center gap-1 text-sm tabular-nums', className)}
    >
      <button type="button" aria-label="Previous page" disabled={safePage <= 1} onClick={() => go(safePage - 1)} className={navBtnClass}>
        <ChevronLeft className="size-3.5" />
      </button>
      {pages.map((entry) =>
        typeof entry === 'string' ? (
          <span key={entry} className="inline-flex size-7 items-center justify-center text-muted-foreground select-none">
            …
          </span>
        ) : (
          <button
            key={entry}
            type="button"
            data-page={entry}
            aria-current={entry === safePage ? 'page' : undefined}
            onClick={() => go(entry)}
            className={cn(
              'inline-flex h-7 min-w-7 cursor-pointer items-center justify-center rounded-sm border-0 px-2 text-sm font-medium transition-colors [@media(pointer:coarse)]:min-h-9 [@media(pointer:coarse)]:min-w-9',
              entry === safePage
                ? 'bg-primary text-primary-foreground shadow-control'
                : 'bg-secondary text-foreground shadow-control hover:bg-secondary-hover',
            )}
          >
            {entry}
          </button>
        ),
      )}
      <button type="button" aria-label="Next page" disabled={safePage >= totalPages} onClick={() => go(safePage + 1)} className={navBtnClass}>
        <ChevronRight className="size-3.5" />
      </button>
      {hasQuickJumper ? (
        <input
          type="text"
          inputMode="numeric"
          value={jumpDraft}
          aria-label="Jump to page"
          placeholder="#"
          onChange={(e) => setJumpDraft(e.target.value.replace(/\D/g, ''))}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && jumpDraft) {
              go(Number(jumpDraft));
              setJumpDraft('');
            }
          }}
          className="ml-1 h-7 w-12 rounded-sm border-0 bg-field px-2 text-center text-sm text-foreground shadow-well outline-none focus-visible:shadow-field-focus"
        />
      ) : null}
    </nav>
  );
}
