import type { ReactNode } from 'react';
import clsx from 'clsx';
import { useProgressTask } from '../../hooks/useProgressTask';
import { ListPlaceholder, LoadingRegion, PageHeadPlaceholder } from './Placeholder';

export interface PageLoadingProps {
  /** `page` stands in for a whole route; `block` for one list or panel inside a page. */
  variant?: 'page' | 'block';
  className?: string;
}

/**
 * The placeholder that stands in for content that has not arrived yet.
 *
 * One component so a route's first load, a lazy chunk and a list's first read draw the same frame:
 * the page head and list rows where the real ones will land, so nothing jumps when they do. The
 * read it waits on is already counted by the loading bar, so this only draws.
 */
export function PageLoading({ variant = 'page', className }: PageLoadingProps) {
  return (
    <LoadingRegion className={clsx(variant === 'page' ? 'page-loading' : 'block-loading', className)}>
      {variant === 'page' && <PageHeadPlaceholder />}
      <ListPlaceholder rows={variant === 'page' ? 6 : 4} isFramed={variant === 'page'} />
    </LoadingRegion>
  );
}

/**
 * A lazy route's Suspense fallback: the page frame, and its module download counted as work in
 * flight, because nothing else knows the download is happening.
 */
export function RouteLoading() {
  useProgressTask();
  return (
    <div className="terminal-page">
      <PageLoading />
    </div>
  );
}

/**
 * A Suspense fallback inside a page - an editor, a drawer's body: draws the placeholder it is given
 * and counts the module download as work in flight, as `RouteLoading` does for a whole route.
 */
export function SuspenseFallback({ children }: { children: ReactNode }) {
  useProgressTask();
  return <>{children}</>;
}
