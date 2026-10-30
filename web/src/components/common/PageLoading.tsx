import type { ReactNode } from 'react';
import clsx from 'clsx';
import { useProgressTask } from '../../hooks/useProgressTask';
import { ParagraphPlaceholder, TablePlaceholder } from './ContentPlaceholder';
import { ListPlaceholder, LoadingRegion, PageHeadPlaceholder, Placeholder } from './Placeholder';
import { Panel } from './Panel';
import { ThreadPlaceholder } from '../workspace/ThreadPlaceholder';

/**
 * The few bodies a console page is built from. A page names the one its loaded content resembles,
 * so its first frame already has the content's shape instead of every page opening on the same
 * list: rows (providers, keys, credentials, plugins), a dense table (requests, audit, prices),
 * stacked panels (system, settings, routing, configuration) or a conversation (Agent, Playground).
 */
export type PageBody = 'list' | 'table' | 'panels' | 'workspace';

/** A route's loading frame: one of the shared bodies, or the dashboard's own board of tiles. */
export type RouteLoadingBody = PageBody | 'dashboard';

/** The route `handle` that names the frame `AppLayout` draws while the route's module downloads. */
export interface RouteLoadingHandle {
  loading: RouteLoadingBody;
}

// Heading and line counts per panel: uneven, as the pages that stack panels are.
const PANEL_LINES = [4, 3, 5];

/** Stacked panels, each a heading and a few lines - a settings group, a status card, a board. */
export function PanelsPlaceholder({ count = 3 }: { count?: number }) {
  return (
    <LoadingRegion className="placeholder-panels">
      {Array.from({ length: count }, (_, index) => (
        <Panel key={index}>
          <Placeholder width={132} row={index} className="placeholder-title" />
          <ParagraphPlaceholder rows={PANEL_LINES[index % PANEL_LINES.length]} className="placeholder-panel-body" />
        </Panel>
      ))}
    </LoadingRegion>
  );
}

function PageBodyPlaceholder({ body }: { body: PageBody }) {
  switch (body) {
    case 'list': return <ListPlaceholder rows={6} isFramed />;
    case 'table': return <TablePlaceholder rows={8} className="terminal-panel" />;
    case 'panels': return <PanelsPlaceholder />;
    case 'workspace': return <ThreadPlaceholder />;
  }
}

/**
 * A whole page that has not arrived: the page head and the body it will have. A conversation has
 * no page head - its frame is the thread - so a workspace draws the thread alone.
 */
export function PageSkeleton({ body }: { body: PageBody }) {
  if (body === 'workspace') return <ThreadPlaceholder />;
  return (
    <div className="terminal-page">
      <LoadingRegion>
        <PageHeadPlaceholder />
        <PageBodyPlaceholder body={body} />
      </LoadingRegion>
    </div>
  );
}

/** List rows standing in for one list or panel inside a page that is already drawn. */
export function ListLoading({ className }: { className?: string }) {
  return (
    <LoadingRegion className={clsx('block-loading', className)}>
      <ListPlaceholder rows={4} />
    </LoadingRegion>
  );
}

/**
 * A Suspense fallback - a lazy route's frame, an editor, a drawer's body: draws the placeholder it
 * is given and counts the module download as work in flight, because nothing else knows the
 * download is happening.
 */
export function SuspenseFallback({ children }: { children: ReactNode }) {
  useProgressTask();
  return <>{children}</>;
}
