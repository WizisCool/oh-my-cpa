import React, { type ReactNode } from 'react';
import clsx from 'clsx';
import { useProgressTask } from '../../hooks/useProgressTask';
import {
  CodeLinesPlaceholder,
  LogLinesPlaceholder,
  ParagraphPlaceholder,
  TablePlaceholder,
} from './ContentPlaceholder';
import { ListPlaceholder, LoadingRegion, PageHeadPlaceholder, Placeholder } from './Placeholder';
import { Panel } from './Panel';
import { ThreadPlaceholder } from '../workspace/ThreadPlaceholder';
import { DashboardSkeleton } from '../dashboard/DashboardSkeleton';

/**
 * Every layout archetype a console route can declare in `ROUTE_DESCRIPTORS` (`routePreload.ts`).
 *
 * Adding a new page normally requires only picking the archetype that matches its structure.
 * Adding a new custom archetype requires one renderer entry in `PAGE_SKELETON_REGISTRY` below;
 * `ShellLoading`, `AppLayout`'s `RouteLoading`, and `PageSkeleton` all resolve from that single map.
 */
export type RouteLoadingBody =
  | 'dashboard'
  | 'insights'
  | 'workspace'
  | 'catalog'
  | 'directory'
  | 'fleet'
  | 'routing'
  | 'table'
  | 'logs'
  | 'workbench'
  | 'settings'
  | 'system'
  | 'plugins'
  | 'plugins-store'
  | 'plugins-settings'
  | 'frame'
  | 'authorize'
  | 'list';

/** Backwards-compatible alias for non-dashboard route bodies. */
export type PageBody = Exclude<RouteLoadingBody, 'dashboard'>;

/** Optional route `handle` overriding the registry's `loadingBody`. */
export interface RouteLoadingHandle {
  loading: RouteLoadingBody;
}

const SETTING_PANEL_ROWS = [
  [
    { label: 112, desc: '56%', controlWidth: 40, controlHeight: 22 },
    { label: 136, desc: '68%', controlWidth: 132, controlHeight: 32 },
    { label: 96, desc: '48%', controlWidth: 168, controlHeight: 32 },
  ],
  [
    { label: 124, desc: '62%', controlWidth: 192, controlHeight: 32 },
    { label: 104, desc: '44%', controlWidth: 40, controlHeight: 22 },
  ],
] as const;

/** Four-tile (or N-tile) metric/filter strip matching `StatTiles`. */
export function StatTilesPlaceholder({
  count = 4,
  withDelta = false,
  row = 0,
  className,
}: {
  count?: number;
  withDelta?: boolean;
  row?: number;
  className?: string;
}) {
  return (
    <div
      className={clsx('placeholder-stat-tiles', className)}
      style={{ '--placeholder-tile-count': count } as React.CSSProperties}
      aria-hidden="true"
    >
      {Array.from({ length: count }, (_, index) => (
        <div key={index} className="placeholder-stat-tile">
          <Placeholder width="54%" row={row + index} className="placeholder-line is-meta" />
          <Placeholder width={withDelta ? '66%' : 42} height={24} row={row + index} />
          {withDelta && <Placeholder width="38%" row={row + index + 1} className="placeholder-line is-meta" />}
        </div>
      ))}
    </div>
  );
}

/** Search + optional filter pills + optional trailing summary matching `Toolbar`. */
export function ToolbarPlaceholder({
  chips = 0,
  hasFilter = true,
  hasTrailingSummary = false,
  row = 0,
  className,
}: {
  chips?: number;
  hasFilter?: boolean;
  hasTrailingSummary?: boolean;
  row?: number;
  className?: string;
}) {
  return (
    <div className={clsx('placeholder-toolbar', className)} aria-hidden="true">
      <Placeholder width={236} height={32} row={row} className="is-control placeholder-toolbar-search" />
      {hasFilter && (
        <Placeholder width={116} height={32} row={row} className="is-control placeholder-toolbar-filter" />
      )}
      {chips > 0 && (
        <div className="placeholder-toolbar-chips">
          {Array.from({ length: chips }, (_, index) => (
            <Placeholder
              key={index}
              width={56 + (index % 3) * 16}
              height={28}
              row={row}
              className="is-control"
            />
          ))}
        </div>
      )}
      {hasTrailingSummary && (
        <Placeholder width={144} row={row} className="placeholder-line is-meta placeholder-toolbar-trailing" />
      )}
    </div>
  );
}

const CARD_TITLE_WIDTHS = ['58%', '68%', '52%', '74%', '62%', '66%'] as const;
const CARD_META_WIDTHS = ['44%', '54%', '38%', '48%', '58%', '42%'] as const;

/** Responsive grid of cards matching `EntityCard` or `ModelSquarePage`'s `.model-row` cards. */
export function CardsPlaceholder({
  count = 6,
  variant = 'entity',
  row = 0,
  className,
}: {
  count?: number;
  variant?: 'entity' | 'model';
  row?: number;
  className?: string;
}) {
  return (
    <div className={clsx('placeholder-cards', variant === 'model' && 'is-model-cards', className)} aria-hidden="true">
      {Array.from({ length: count }, (_, index) => {
        const cardRow = row + Math.floor(index / 2);
        if (variant === 'model') {
          return (
            <div key={index} className="placeholder-card is-model">
              <div className="placeholder-card-head">
                <div className="placeholder-card-identity">
                  <Placeholder width={CARD_TITLE_WIDTHS[index % CARD_TITLE_WIDTHS.length]} row={cardRow} className="placeholder-line" />
                  <Placeholder width={CARD_META_WIDTHS[index % CARD_META_WIDTHS.length]} row={cardRow} className="placeholder-line is-meta" />
                </div>
                <Placeholder width={20} height={20} row={cardRow} className="is-control" />
              </div>
              <div className="placeholder-card-foot">
                <Placeholder width={72} row={cardRow + 1} className="placeholder-line is-meta" />
                <div className="placeholder-card-marks">
                  <Placeholder width={16} height={16} row={cardRow + 1} className="is-circle" />
                  <Placeholder width={16} height={16} row={cardRow + 1} className="is-circle" />
                </div>
              </div>
            </div>
          );
        }
        return (
          <div key={index} className="placeholder-card">
            <div className="placeholder-card-head">
              <Placeholder width={32} height={32} row={cardRow} className="is-control" />
              <div className="placeholder-card-identity">
                <Placeholder width={CARD_TITLE_WIDTHS[index % CARD_TITLE_WIDTHS.length]} row={cardRow} className="placeholder-line" />
                <Placeholder width={CARD_META_WIDTHS[index % CARD_META_WIDTHS.length]} row={cardRow} className="placeholder-line is-meta" />
              </div>
              <Placeholder width={24} height={24} row={cardRow} className="is-control" />
            </div>
            <div className="placeholder-card-body">
              <Placeholder width="92%" row={cardRow + 1} className="placeholder-line is-meta" />
              <Placeholder width="68%" row={cardRow + 1} className="placeholder-line is-meta" />
            </div>
            <div className="placeholder-card-foot">
              <Placeholder width={56} height={20} row={cardRow + 2} className="is-pill" />
              <Placeholder width={36} height={20} row={cardRow + 2} className="is-pill" />
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** Lightweight chart silhouette placeholder (trend curve, sankey flow, or activity rhythm). */
export function ChartLinesPlaceholder({
  height = 280,
  kind = 'trend',
  row = 0,
}: {
  height?: number;
  kind?: 'trend' | 'flow' | 'rhythm';
  row?: number;
}) {
  const uid = React.useId().replace(/:/g, '');
  if (kind === 'flow') {
    return (
      <div className="placeholder-chart-flow" style={{ height }} aria-hidden="true">
        {[4, 5, 3].map((nodes, col) => (
          <div key={col} className="placeholder-chart-flow-col">
            {Array.from({ length: nodes }, (_, idx) => (
              <Placeholder
                key={idx}
                width="100%"
                height={26 + ((idx + col) % 3) * 14}
                row={row + idx}
                className="is-control"
              />
            ))}
          </div>
        ))}
      </div>
    );
  }
  if (kind === 'rhythm') {
    return (
      <div
        className="placeholder-chart-rhythm"
        style={height !== undefined ? { maxHeight: height, overflow: 'hidden' } : undefined}
        aria-hidden="true"
      >
        {Array.from({ length: 24 * 7 }, (_, cell) => {
          const col = cell % 24;
          const isMid = (cell * 3 + col) % 5 === 0;
          return (
            <span
              key={cell}
              className={clsx('placeholder-rhythm-cell', isMid && 'is-mid')}
              style={{ '--placeholder-row': row + (col % 6) } as React.CSSProperties}
            />
          );
        })}
      </div>
    );
  }
  const gradId = `chart-skel-${uid}`;
  return (
    <div className="placeholder-chart-trend" style={{ height }} aria-hidden="true">
      <div className="placeholder-chart-legend">
        {[68, 84, 58, 76].map((width, idx) => (
          <span key={idx} className="placeholder-chart-legend-item">
            <Placeholder width={8} height={8} row={row} />
            <Placeholder width={width} row={row} className="placeholder-line is-meta" />
          </span>
        ))}
      </div>
      <div className="placeholder-chart-canvas">
        <div className="placeholder-chart-guides">
          <span className="placeholder-chart-guide" />
          <span className="placeholder-chart-guide" />
          <span className="placeholder-chart-guide" />
        </div>
        <svg className="placeholder-chart-svg" viewBox="0 0 400 120" preserveAspectRatio="none">
          <defs>
            <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="currentColor" stopOpacity="0.16" />
              <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
            </linearGradient>
          </defs>
          <path
            d="M 0 92 C 42 88, 68 54, 110 62 C 148 69, 178 24, 224 30 C 266 36, 296 76, 338 58 C 364 47, 384 56, 400 50 L 400 120 L 0 120 Z"
            fill={`url(#${gradId})`}
          />
          <path
            d="M 0 92 C 42 88, 68 54, 110 62 C 148 69, 178 24, 224 30 C 266 36, 296 76, 338 58 C 364 47, 384 56, 400 50"
            fill="none"
            stroke="currentColor"
            strokeOpacity="0.24"
            strokeWidth="2"
            strokeLinecap="round"
          />
        </svg>
      </div>
    </div>
  );
}

/** Stacked panels, mixing setting-row pairs and prose bodies like Config, System, and Settings. */
export function PanelsPlaceholder({ count = 3 }: { count?: number }) {
  return (
    <LoadingRegion className="placeholder-panels">
      {Array.from({ length: count }, (_, index) => {
        const rows = SETTING_PANEL_ROWS[index];
        return (
          <Panel
            key={index}
            title={<Placeholder width={112 + (index % 2) * 28} row={index} className="placeholder-line" />}
          >
            {rows ? (
              <div className="placeholder-panel-rows">
                {rows.map((row, rowIndex) => (
                  <div key={rowIndex} className="placeholder-panel-row">
                    <div className="placeholder-panel-row-copy">
                      <Placeholder width={row.label} row={index + rowIndex} className="placeholder-line" />
                      <Placeholder width={row.desc} row={index + rowIndex} className="placeholder-line is-meta" />
                    </div>
                    <Placeholder
                      width={row.controlWidth}
                      height={row.controlHeight}
                      row={index + rowIndex}
                      className={row.controlHeight === 22 ? 'is-pill' : 'is-control'}
                    />
                  </div>
                ))}
              </div>
            ) : (
              <ParagraphPlaceholder rows={4} />
            )}
          </Panel>
        );
      })}
    </LoadingRegion>
  );
}

/** Insights (`/insights`): range controls, 4-col MetricTiles, trend curve panel, and 2x2 rankings. */
export function InsightsSkeleton({
  hasHeader = true,
  isImmediate = false,
}: {
  hasHeader?: boolean;
  isImmediate?: boolean;
}) {
  return (
    <div className={clsx(hasHeader && 'terminal-page')}>
      <LoadingRegion isImmediate={isImmediate} className="placeholder-stack">
        {hasHeader && (
          <PageHeadPlaceholder
            titleWidth={112}
            actions={(
              <div className="placeholder-head-tools">
                <Placeholder width={186} height={32} className="is-control" />
                <Placeholder width={84} height={32} className="is-control" />
              </div>
            )}
          />
        )}
        <StatTilesPlaceholder count={4} withDelta row={0} />
        <Panel
          title={<Placeholder width={132} row={1} className="placeholder-line" />}
          extra={<Placeholder width={164} height={26} row={1} className="is-control" />}
        >
          <ChartLinesPlaceholder height={260} kind="trend" row={2} />
        </Panel>
        <div className="placeholder-insights-rankings" aria-hidden="true">
          {[0, 1, 2, 3].map((panel) => (
            <Panel
              key={panel}
              title={<Placeholder width={84 + (panel % 2) * 20} row={3} className="placeholder-line" />}
            >
              <div className="placeholder-ranking-rows">
                {[88, 66, 48, 30].map((bar, item) => (
                  <div key={item} className="placeholder-ranking-row">
                    <div className="placeholder-ranking-copy">
                      <Placeholder width={92 + ((panel + item) % 3) * 18} row={4 + item} className="placeholder-line" />
                      <Placeholder width={42} row={4 + item} className="placeholder-line is-meta" />
                    </div>
                    <Placeholder width={`${bar}%`} height={6} row={4 + item} className="is-pill" />
                  </div>
                ))}
              </div>
            </Panel>
          ))}
        </div>
      </LoadingRegion>
    </div>
  );
}

/** Model Square (`/model-square`): search, maker chip strip, and grouped model cards. */
export function CatalogSkeleton({
  hasHeader = true,
  isImmediate = false,
}: {
  hasHeader?: boolean;
  isImmediate?: boolean;
}) {
  return (
    <div className={clsx(hasHeader && 'terminal-page')}>
      <LoadingRegion isImmediate={isImmediate} className="placeholder-stack">
        {hasHeader && (
          <PageHeadPlaceholder
            titleWidth={128}
            subtitleWidth={164}
            actions={<Placeholder width={116} height={32} className="is-control" />}
          />
        )}
        <ToolbarPlaceholder hasFilter={false} />
        <div className="placeholder-chip-strip" aria-hidden="true">
          {[56, 74, 82, 68, 92, 64, 72].map((width, idx) => (
            <Placeholder key={idx} width={width} height={30} row={1} className="is-control" />
          ))}
        </div>
        <div className="placeholder-catalog-section">
          <div className="placeholder-catalog-heading">
            <Placeholder width={20} height={20} row={2} className="is-circle" />
            <Placeholder width={96} row={2} className="placeholder-line" />
            <Placeholder width={44} row={2} className="placeholder-line is-meta" />
          </div>
          <CardsPlaceholder count={6} variant="model" row={2} />
        </div>
      </LoadingRegion>
    </div>
  );
}

/** Providers, API Keys, and Audit (`/ai-providers`, `/api-keys`, `/audit`): StatTiles + Toolbar + Table/List. */
export function DirectorySkeleton({
  hasHeader = true,
  isImmediate = false,
}: {
  hasHeader?: boolean;
  isImmediate?: boolean;
}) {
  return (
    <div className={clsx(hasHeader && 'terminal-page terminal-page-stack')}>
      <LoadingRegion isImmediate={isImmediate} className="placeholder-stack">
        {hasHeader && (
          <PageHeadPlaceholder
            titleWidth={140}
            subtitleWidth={196}
            actions={<Placeholder width={108} height={32} className="is-control" />}
          />
        )}
        <StatTilesPlaceholder count={4} row={0} />
        <ToolbarPlaceholder hasFilter hasTrailingSummary row={1} />
        <div className="placeholder-desktop-only">
          <TablePlaceholder rows={6} hasHeader className="placeholder-frame" />
        </div>
        <div className="placeholder-phone-only">
          <ListPlaceholder rows={5} isFramed />
        </div>
      </LoadingRegion>
    </div>
  );
}

/** OAuth Management (`/oauth-management`): provider strip + health lenses + EntityCard grid. */
export function FleetSkeleton({
  hasHeader = true,
  layout = 'cards',
  isImmediate = false,
}: {
  hasHeader?: boolean;
  layout?: 'cards' | 'list';
  isImmediate?: boolean;
}) {
  return (
    <div className={clsx(hasHeader && 'terminal-page')}>
      <LoadingRegion isImmediate={isImmediate} className="placeholder-stack">
        {hasHeader && (
          <PageHeadPlaceholder
            titleWidth={148}
            actions={(
              <div className="placeholder-head-tools">
                <Placeholder width={96} height={32} className="is-control" />
                <Placeholder width={96} height={32} className="is-control" />
              </div>
            )}
          />
        )}
        <div className="placeholder-chip-strip placeholder-desktop-only" aria-hidden="true">
          {[96, 108, 88, 114, 92, 104].map((width, idx) => (
            <Placeholder key={idx} width={width} height={34} row={0} className="is-control" />
          ))}
        </div>
        <ToolbarPlaceholder chips={4} hasFilter hasTrailingSummary row={1} />
        {layout === 'list' ? (
          <ListPlaceholder rows={6} isFramed />
        ) : (
          <CardsPlaceholder count={6} variant="entity" row={2} />
        )}
      </LoadingRegion>
    </div>
  );
}

/** Routing (`/routing`): 2-column workspace with TierLadder on left and sticky PolicyStrip on right. */
export function RoutingSkeleton({
  hasHeader = true,
  isImmediate = false,
}: {
  hasHeader?: boolean;
  isImmediate?: boolean;
}) {
  return (
    <div className={clsx(hasHeader && 'terminal-page terminal-page-stack')}>
      <LoadingRegion isImmediate={isImmediate} className="placeholder-stack">
        {hasHeader && <PageHeadPlaceholder titleWidth={132} />}
        <div className="placeholder-routing-workspace">
          <div className="placeholder-routing-board">
            <div className="placeholder-routing-entry">
              <Placeholder width={10} height={10} row={0} className="is-circle" />
              <Placeholder width={116} row={0} className="placeholder-line" />
              <Placeholder width={220} height={32} row={0} className="is-control placeholder-routing-lens" />
            </div>
            {[0, 1].map((tier) => (
              <div key={tier} className="placeholder-routing-tier">
                <div className="placeholder-routing-gutter">
                  <Placeholder width={24} height={24} row={tier + 1} className="is-circle" />
                  <div className="placeholder-routing-gutter-copy">
                    <Placeholder width={64} row={tier + 1} className="placeholder-line" />
                    <Placeholder width={44} row={tier + 1} className="placeholder-line is-meta" />
                  </div>
                </div>
                <div className="placeholder-routing-cards">
                  {[132, 148, 118].slice(0, tier === 0 ? 3 : 2).map((w, cardIdx) => (
                    <Placeholder key={cardIdx} width={w} height={48} row={tier + 1} className="is-control" />
                  ))}
                </div>
              </div>
            ))}
          </div>
          <Panel
            className="placeholder-routing-aside"
            title={<Placeholder width={92} row={1} className="placeholder-line" />}
          >
            <Placeholder width="100%" height={36} row={1} className="is-control" />
            <div className="placeholder-panel-rows">
              {[0, 1, 2].map((idx) => (
                <div key={idx} className="placeholder-panel-row">
                  <div className="placeholder-panel-row-copy">
                    <Placeholder width={96 + idx * 14} row={idx + 2} className="placeholder-line" />
                    <Placeholder width="72%" row={idx + 2} className="placeholder-line is-meta" />
                  </div>
                  <Placeholder width={40} height={22} row={idx + 2} className="is-pill" />
                </div>
              ))}
            </div>
          </Panel>
        </div>
      </LoadingRegion>
    </div>
  );
}

/** Usage Events & Pricing (`/usage/events`, `/pricing`): head + toolbar + framed table / phone list. */
export function TableSkeleton({
  hasHeader = true,
  isImmediate = false,
}: {
  hasHeader?: boolean;
  isImmediate?: boolean;
}) {
  return (
    <div className={clsx(hasHeader && 'terminal-page')}>
      <LoadingRegion isImmediate={isImmediate} className="placeholder-stack">
        {hasHeader && (
          <PageHeadPlaceholder
            titleWidth={144}
            actions={(
              <div className="placeholder-head-tools">
                <Placeholder width={132} height={32} className="is-control" />
                <Placeholder width={32} height={32} className="is-control" />
              </div>
            )}
          />
        )}
        <ToolbarPlaceholder chips={3} hasFilter row={0} />
        <div className="placeholder-desktop-only">
          <TablePlaceholder rows={8} hasHeader className="placeholder-frame" />
        </div>
        <div className="placeholder-phone-only">
          <ListPlaceholder rows={6} isFramed />
        </div>
      </LoadingRegion>
    </div>
  );
}

/** Logs (`/logs`): segmented source switch + Panel with toolbar, tabs, and monospace log lines. */
export function LogsSkeleton({
  hasHeader = true,
  isImmediate = false,
}: {
  hasHeader?: boolean;
  isImmediate?: boolean;
}) {
  return (
    <div className={clsx(hasHeader && 'terminal-page logs-page')}>
      <LoadingRegion isImmediate={isImmediate} className="placeholder-stack">
        {hasHeader && (
          <PageHeadPlaceholder
            titleWidth={96}
            actions={<Placeholder width={180} height={32} className="is-control" />}
          />
        )}
        <Panel className="logs-panel">
          <ToolbarPlaceholder chips={4} hasFilter={false} hasTrailingSummary row={0} />
          <div className="placeholder-logs-tabs" aria-hidden="true">
            <Placeholder width={64} row={1} className="placeholder-line" />
            <Placeholder width={72} row={1} className="placeholder-line is-meta" />
          </div>
          <LogLinesPlaceholder rows={9} />
        </Panel>
      </LoadingRegion>
    </div>
  );
}

/** Config Workbench (`/config`): sticky config toolbar + 216px left section nav + right setting panels. */
export function WorkbenchSkeleton({
  hasHeader = true,
  isImmediate = false,
}: {
  hasHeader?: boolean;
  isImmediate?: boolean;
}) {
  return (
    <div className={clsx(hasHeader && 'terminal-page config-page')}>
      <LoadingRegion isImmediate={isImmediate} className="placeholder-stack">
        {hasHeader && (
          <PageHeadPlaceholder
            titleWidth={128}
            actions={(
              <div className="placeholder-head-tools">
                <Placeholder width={160} height={32} className="is-control placeholder-desktop-only" />
                <Placeholder width={132} height={32} className="is-control" />
                <Placeholder width={76} height={32} className="is-control" />
              </div>
            )}
          />
        )}
        <div className="placeholder-workbench">
          <div className="placeholder-workbench-nav placeholder-desktop-only" aria-hidden="true">
            {[74, 88, 66, 82, 72, 92, 68].map((width, idx) => (
              <div key={idx} className={clsx('placeholder-workbench-nav-item', idx === 0 && 'is-selected')}>
                <Placeholder width={14} height={14} row={idx} />
                <Placeholder width={width} row={idx} className="placeholder-line" />
              </div>
            ))}
          </div>
          <PanelsPlaceholder count={2} />
        </div>
      </LoadingRegion>
    </div>
  );
}

/** OMC Settings (`/omc-settings`): open caption headings above hairline-divided settings cards. */
export function SettingsSkeleton({ isImmediate = false }: { isImmediate?: boolean }) {
  return (
    <div className="terminal-page omc-settings-page">
      <LoadingRegion isImmediate={isImmediate} className="placeholder-stack">
        <PageHeadPlaceholder titleWidth={136} />
        {SETTING_PANEL_ROWS.map((rows, groupIdx) => (
          <div key={groupIdx} className="omc-settings-group">
            <div className="settings-group-head">
              <Placeholder width={88 + groupIdx * 24} row={groupIdx} className="placeholder-line" />
            </div>
            <div className="settings-group omc-settings-card placeholder-settings-card">
              <div className="placeholder-panel-rows">
                {rows.map((row, rowIdx) => (
                  <div key={rowIdx} className="placeholder-panel-row">
                    <div className="placeholder-panel-row-copy">
                      <Placeholder width={row.label} row={groupIdx + rowIdx} className="placeholder-line" />
                      <Placeholder width={row.desc} row={groupIdx + rowIdx} className="placeholder-line is-meta" />
                    </div>
                    <Placeholder
                      width={row.controlWidth}
                      height={row.controlHeight}
                      row={groupIdx + rowIdx}
                      className={row.controlHeight === 22 ? 'is-pill' : 'is-control'}
                    />
                  </div>
                ))}
              </div>
            </div>
          </div>
        ))}
      </LoadingRegion>
    </div>
  );
}

/** System Information (`/system`): Versions hero card + 2-column Health/Storage grid + Maintenance card. */
export function SystemSkeleton({
  hasHeader = true,
  isImmediate = false,
}: {
  hasHeader?: boolean;
  isImmediate?: boolean;
}) {
  return (
    <div className={clsx(hasHeader && 'terminal-page terminal-page-stack system-page')}>
      <LoadingRegion isImmediate={isImmediate} className="placeholder-stack">
        {hasHeader && <PageHeadPlaceholder titleWidth={128} />}
        <Panel
          title={<Placeholder width={116} row={0} className="placeholder-line" />}
          extra={<Placeholder width={92} height={28} row={0} className="is-control" />}
        >
          <div className="placeholder-panel-rows">
            {[0, 1].map((product) => (
              <div key={product} className="placeholder-system-product">
                <div className="placeholder-system-product-head">
                  <Placeholder width={108 + product * 16} row={product} className="placeholder-line" />
                  <Placeholder width={164} row={product} className="placeholder-line is-meta" />
                </div>
                <div className="placeholder-system-versions">
                  <Placeholder width={96} height={20} row={product + 1} />
                  <Placeholder width={96} height={20} row={product + 1} />
                  <Placeholder width={88} height={28} row={product + 1} className="is-control placeholder-system-action" />
                </div>
              </div>
            ))}
          </div>
        </Panel>
        <div className="placeholder-system-grid">
          {[0, 1].map((card) => (
            <Panel key={card} title={<Placeholder width={96 + card * 24} row={2} className="placeholder-line" />}>
              <div className="placeholder-panel-rows">
                {[0, 1, 2].map((line) => (
                  <div key={line} className="placeholder-panel-row">
                    <Placeholder width={84 + line * 16} row={3 + line} className="placeholder-line" />
                    <Placeholder width={62} row={3 + line} className="placeholder-line is-meta" />
                  </div>
                ))}
              </div>
            </Panel>
          ))}
        </div>
        <Panel title={<Placeholder width={128} row={4} className="placeholder-line" />}>
          <div className="placeholder-panel-rows">
            {[0, 1].map((row) => (
              <div key={row} className="placeholder-panel-row">
                <div className="placeholder-panel-row-copy">
                  <Placeholder width={124} row={5 + row} className="placeholder-line" />
                  <Placeholder width="64%" row={5 + row} className="placeholder-line is-meta" />
                </div>
                <Placeholder width={108} height={32} row={5 + row} className="is-control" />
              </div>
            ))}
          </div>
        </Panel>
      </LoadingRegion>
    </div>
  );
}

/** Plugins (`/plugins`, `/plugins/store`, `/plugins/settings`): tabs + status strip + tab content. */
export function PluginsSkeleton({
  tab = 'installed',
  hasHeader = true,
  isImmediate = false,
}: {
  tab?: 'installed' | 'store' | 'settings';
  hasHeader?: boolean;
  isImmediate?: boolean;
}) {
  return (
    <div className={clsx(hasHeader && 'terminal-page terminal-page-stack plugins-page')}>
      <LoadingRegion isImmediate={isImmediate} className="placeholder-stack">
        {hasHeader && (
          <PageHeadPlaceholder
            titleWidth={128}
            actions={<Placeholder width={236} height={32} className="is-control" />}
          >
            <div className="placeholder-plugins-status" aria-hidden="true">
              <Placeholder width={96} row={0} className="placeholder-line is-meta" />
              <Placeholder width={124} row={0} className="placeholder-line is-meta" />
              <Placeholder width={72} row={0} className="placeholder-line is-meta" />
            </div>
          </PageHeadPlaceholder>
        )}
        {tab === 'settings' ? (
          <PanelsPlaceholder count={2} />
        ) : (
          <Panel>
            <div className="placeholder-stack">
              <ToolbarPlaceholder chips={tab === 'store' ? 3 : 2} hasFilter={tab === 'store'} row={1} />
              <CardsPlaceholder count={tab === 'store' ? 6 : 3} variant="entity" row={2} />
            </div>
          </Panel>
        )}
      </LoadingRegion>
    </div>
  );
}

/** Plugin Page Host (`/plugin-pages/:pluginId/:pageIndex`): identity bar + embedded stage frame. */
export function PluginHostSkeleton({
  hasBar = true,
  isImmediate = false,
  className,
}: {
  hasBar?: boolean;
  isImmediate?: boolean;
  className?: string;
}) {
  return (
    <LoadingRegion isImmediate={isImmediate} className={clsx('placeholder-plugin-host', className)}>
      {hasBar && (
        <div className="placeholder-plugin-bar" aria-hidden="true">
          <Placeholder width={32} height={32} row={0} className="is-control" />
          <div className="placeholder-plugin-identity">
            <Placeholder width={136} row={0} className="placeholder-line" />
            <Placeholder width={212} row={0} className="placeholder-line is-meta" />
          </div>
          <div className="placeholder-plugin-actions">
            <Placeholder width={28} height={28} row={0} className="is-control" />
            <Placeholder width={28} height={28} row={0} className="is-control" />
            <Placeholder width={28} height={28} row={0} className="is-control" />
          </div>
        </div>
      )}
      <div className="placeholder-plugin-stage" aria-hidden="true">
        <div className="placeholder-plugin-stage-inner">
          <PageHeadPlaceholder titleWidth={160} actions={<Placeholder width={96} height={32} className="is-control" />} />
          <PanelsPlaceholder count={2} />
        </div>
      </div>
    </LoadingRegion>
  );
}

/** Consent request card inside `AuthorizePage` (`/authorize/:id`). */
export function AuthorizeCardSkeleton({
  isFullCard = false,
  isImmediate = false,
}: {
  isFullCard?: boolean;
  isImmediate?: boolean;
}) {
  return (
    <LoadingRegion isImmediate={isImmediate} className={clsx(isFullCard && 'auth-card shell-loading-auth-card placeholder-auth-card')}>
      {isFullCard && (
        <>
          <div className="placeholder-auth-parties" aria-hidden="true">
            <Placeholder width={52} height={52} row={0} className="placeholder-auth-party" />
            <Placeholder width={18} height={12} row={0} className="is-meta" />
            <Placeholder width={52} height={52} row={0} className="placeholder-auth-party" />
          </div>
          <Placeholder width="64%" height={24} row={0} className="placeholder-title placeholder-auth-centered" />
          <Placeholder width="86%" row={1} className="placeholder-line placeholder-auth-centered" />
        </>
      )}
      <div className="placeholder-auth-request" aria-hidden="true">
        <div className="placeholder-auth-request-head">
          <Placeholder width="52%" row={2} className="placeholder-line" />
          <Placeholder width={56} height={20} row={2} className="is-pill" />
        </div>
        <Placeholder width="38%" row={2} className="placeholder-line is-meta" />
        <Placeholder width="100%" height={72} row={3} className="is-surface" />
        <div className="placeholder-auth-request-actions">
          <Placeholder width="48%" height={36} row={3} className="is-control" />
          <Placeholder width="48%" height={36} row={3} className="is-control" />
        </div>
      </div>
      {isFullCard && (
        <Placeholder width={116} row={4} className="placeholder-line is-meta placeholder-auth-link" />
      )}
    </LoadingRegion>
  );
}

/** Simple framed list fallback for generic list routes. */
export function ListSkeleton({ isImmediate = false }: { isImmediate?: boolean }) {
  return (
    <div className="terminal-page">
      <LoadingRegion isImmediate={isImmediate}>
        <PageHeadPlaceholder />
        <ListPlaceholder rows={6} isFramed />
      </LoadingRegion>
    </div>
  );
}

/**
 * Single declarative lookup from `RouteLoadingBody` to its skeleton renderer.
 * Both `ShellLoading` (cold boot) and `AppLayout`'s `RouteLoading` (chunk navigation) render
 * through `RouteSkeleton` so every route has one authoritative first-paint frame.
 */
export const PAGE_SKELETON_REGISTRY: Record<RouteLoadingBody, React.FC<{ isImmediate?: boolean }>> = {
  dashboard: ({ isImmediate }) => <DashboardSkeleton isImmediate={isImmediate} />,
  insights: ({ isImmediate }) => <InsightsSkeleton isImmediate={isImmediate} />,
  workspace: ({ isImmediate }) => <ThreadPlaceholder hasHeader hasComposer isImmediate={isImmediate} />,
  catalog: ({ isImmediate }) => <CatalogSkeleton isImmediate={isImmediate} />,
  directory: ({ isImmediate }) => <DirectorySkeleton isImmediate={isImmediate} />,
  fleet: ({ isImmediate }) => <FleetSkeleton isImmediate={isImmediate} />,
  routing: ({ isImmediate }) => <RoutingSkeleton isImmediate={isImmediate} />,
  table: ({ isImmediate }) => <TableSkeleton isImmediate={isImmediate} />,
  logs: ({ isImmediate }) => <LogsSkeleton isImmediate={isImmediate} />,
  workbench: ({ isImmediate }) => <WorkbenchSkeleton isImmediate={isImmediate} />,
  settings: ({ isImmediate }) => <SettingsSkeleton isImmediate={isImmediate} />,
  system: ({ isImmediate }) => <SystemSkeleton isImmediate={isImmediate} />,
  plugins: ({ isImmediate }) => <PluginsSkeleton tab="installed" isImmediate={isImmediate} />,
  'plugins-store': ({ isImmediate }) => <PluginsSkeleton tab="store" isImmediate={isImmediate} />,
  'plugins-settings': ({ isImmediate }) => <PluginsSkeleton tab="settings" isImmediate={isImmediate} />,
  frame: ({ isImmediate }) => (
    <div className="terminal-page">
      <PluginHostSkeleton isImmediate={isImmediate} />
    </div>
  ),
  authorize: ({ isImmediate }) => (
    <div className="auth-main">
      <AuthorizeCardSkeleton isFullCard isImmediate={isImmediate} />
    </div>
  ),
  list: ({ isImmediate }) => <ListSkeleton isImmediate={isImmediate} />,
};

/** Renders the registered skeleton body for a route. */
export function RouteSkeleton({
  body = 'list',
  isImmediate = false,
}: {
  body?: RouteLoadingBody;
  isImmediate?: boolean;
}) {
  const Renderer = PAGE_SKELETON_REGISTRY[body] ?? PAGE_SKELETON_REGISTRY.list;
  return <Renderer isImmediate={isImmediate} />;
}

/** Backwards-compatible alias for `RouteSkeleton`. */
export function PageSkeleton({ body, isImmediate = false }: { body: RouteLoadingBody; isImmediate?: boolean }) {
  return <RouteSkeleton body={body} isImmediate={isImmediate} />;
}

/** List rows standing in for one list or panel inside a page that is already drawn. */
export function ListLoading({
  className,
  rows = 4,
  isFramed = false,
  label,
}: {
  className?: string;
  rows?: number;
  isFramed?: boolean;
  label?: string;
}) {
  return (
    <LoadingRegion className={clsx('block-loading', className)} label={label}>
      <ListPlaceholder rows={rows} isFramed={isFramed} />
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

export { CodeLinesPlaceholder, LogLinesPlaceholder };
