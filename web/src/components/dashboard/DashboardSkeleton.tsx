import React from 'react';
import { QueryClientContext } from '@tanstack/react-query';
import {
  DASHBOARD_LAYOUT_PREFERENCE,
  DEFAULT_DASHBOARD_LAYOUT,
  dashboardWidgetSpec,
  parseDashboardLayout,
  type DashboardLayout,
  type DashboardWidgetId,
} from '../../types/dashboardLayout';
import { LoadingRegion, PageHeadPlaceholder, Placeholder } from '../common/Placeholder';
import { Panel } from '../common/Panel';
import { RoutingMapSkeleton } from './routing/RoutingMapSkeleton';
import './dashboardGrid.css';

const SPARKLINE_PATHS: Record<DashboardWidgetId, { line: string; area: string }> = {
  requests: {
    line: 'M 0 38 C 28 36, 46 28, 72 31 C 94 34, 110 12, 132 10 C 152 8, 168 33, 192 36 C 212 38, 226 31, 240 33',
    area: 'M 0 38 C 28 36, 46 28, 72 31 C 94 34, 110 12, 132 10 C 152 8, 168 33, 192 36 C 212 38, 226 31, 240 33 L 240 46 L 0 46 Z',
  },
  tokens: {
    line: 'M 0 35 C 24 38, 44 24, 68 29 C 92 34, 112 18, 136 14 C 158 11, 178 35, 202 36 C 218 37, 230 33, 240 34',
    area: 'M 0 35 C 24 38, 44 24, 68 29 C 92 34, 112 18, 136 14 C 158 11, 178 35, 202 36 C 218 37, 230 33, 240 34 L 240 46 L 0 46 Z',
  },
  rpm: {
    line: 'M 0 39 C 30 37, 50 26, 76 30 C 102 34, 120 14, 144 16 C 168 18, 184 36, 208 38 C 222 39, 232 35, 240 36',
    area: 'M 0 39 C 30 37, 50 26, 76 30 C 102 34, 120 14, 144 16 C 168 18, 184 36, 208 38 C 222 39, 232 35, 240 36 L 240 46 L 0 46 Z',
  },
  tpm: {
    line: 'M 0 36 C 26 28, 46 34, 72 24 C 98 14, 120 28, 146 16 C 168 8, 186 35, 212 37 C 224 38, 232 34, 240 35',
    area: 'M 0 36 C 26 28, 46 34, 72 24 C 98 14, 120 28, 146 16 C 168 8, 186 35, 212 37 C 224 38, 232 34, 240 35 L 240 46 L 0 46 Z',
  },
  cache_rate: {
    line: 'M 0 37 C 28 32, 48 22, 74 28 C 98 33, 118 16, 142 15 C 166 14, 182 34, 208 36 C 222 37, 232 34, 240 35',
    area: 'M 0 37 C 28 32, 48 22, 74 28 C 98 33, 118 16, 142 15 C 166 14, 182 34, 208 36 C 222 37, 232 34, 240 35 L 240 46 L 0 46 Z',
  },
  cost: {
    line: 'M 0 38 C 30 34, 52 29, 78 32 C 102 35, 122 14, 144 11 C 166 8, 182 36, 208 37 C 224 38, 232 34, 240 35',
    area: 'M 0 38 C 30 34, 52 29, 78 32 C 102 35, 122 14, 144 11 C 166 8, 182 36, 208 37 C 224 38, 232 34, 240 35 L 240 46 L 0 46 Z',
  },
  routing: { line: '', area: '' },
  model_trend: { line: '', area: '' },
  model_usage: { line: '', area: '' },
  token_activity: { line: '', area: '' },
  credential_quota: { line: '', area: '' },
  providers: { line: '', area: '' },
};

const TREND_BAR_HEIGHTS = [18, 32, 24, 54, 78, 44, 62, 86, 48, 36, 68, 42] as const;
const USAGE_SEGMENTS = [44, 25, 15, 10, 6] as const;
const USAGE_ROWS = [
  { name: '66%', cost: 38, tokens: 34, share: 24 },
  { name: '58%', cost: 34, tokens: 32, share: 24 },
  { name: '46%', cost: 30, tokens: 28, share: 24 },
  { name: '62%', cost: 34, tokens: 32, share: 24 },
  { name: '50%', cost: 28, tokens: 30, share: 22 },
] as const;
const HEATMAP_COLUMNS = 24;
const HEATMAP_ROWS = 7;
const QUOTA_ROWS = [
  { name: '62%', labelA: 18, fillA: '74%', labelB: 16, fillB: '88%', when: 34 },
  { name: '54%', labelA: 18, fillA: '48%', labelB: 16, fillB: '64%', when: 30 },
  { name: '68%', labelA: 18, fillA: '86%', labelB: 16, fillB: '92%', when: 36 },
  { name: '48%', labelA: 18, fillA: '36%', labelB: 16, fillB: '52%', when: 32 },
] as const;
const PROVIDER_ROWS = [
  { name: 112, creds: 56, total: 48, rate: 40 },
  { name: 96, creds: 48, total: 44, rate: 36 },
  { name: 124, creds: 60, total: 52, rate: 40 },
] as const;

type PlaceholderStyle = React.CSSProperties & { '--placeholder-row'?: number };

export function DashboardHeadPlaceholder() {
  return (
    <PageHeadPlaceholder
      titleWidth={76}
      actions={(
        <div className="dash-skeleton-actions" aria-hidden="true">
          <Placeholder height={32} className="is-control dash-skeleton-range-filter" />
          <Placeholder height={32} className="is-control dash-skeleton-key-filter" />
          <Placeholder width={32} height={32} className="is-control dash-skeleton-desktop-only" />
          <Placeholder width={32} height={32} className="is-control dash-skeleton-desktop-only" />
          <Placeholder width={32} height={32} className="is-control dash-skeleton-desktop-only" />
          <Placeholder width={32} height={32} className="is-control dash-skeleton-phone-only" />
        </div>
      )}
    />
  );
}

/**
 * Exact-geometry KPI tile placeholder matching the loaded `.kpi-tile` structure (label, hero
 * readout, caption, and subtle sparkline curve) so the transition from skeleton to live numbers
 * causes zero layout shift (`CLS = 0`).
 */
export function DashboardKpiTilePlaceholder({
  id,
  index = 0,
}: {
  id: DashboardWidgetId;
  index?: number;
}) {
  const isWide = id === 'requests' || id === 'tokens';
  const hasLink = id === 'requests' || id === 'cost';
  const hasDelta = id === 'requests' || id === 'tokens' || id === 'cost';
  const sparkHeight = isWide ? 64 : 44;
  const gradId = React.useId();
  const path = SPARKLINE_PATHS[id];

  return (
    <Panel className="dashboard-tile kpi-tile">
      <div className="dash-skeleton-tile-head" aria-hidden="true">
        <Placeholder width={isWide ? 72 : 56} row={index} className="placeholder-line is-meta" />
        {hasLink && <Placeholder width={48} row={index} className="placeholder-line is-meta" />}
      </div>
      <div className="dash-skeleton-tile-value" aria-hidden="true">
        <Placeholder width={isWide ? '34%' : '46%'} height={28} row={index + 1} className="placeholder-title" />
        {hasDelta && <Placeholder width={38} height={14} row={index + 1} className="is-meta" />}
      </div>
      <div className="dash-skeleton-tile-caption" aria-hidden="true">
        {id === 'requests' ? (
          <>
            <Placeholder width={72} row={index + 2} className="placeholder-line is-meta" />
            <Placeholder width={54} row={index + 2} className="placeholder-line is-meta" />
            <Placeholder width={46} row={index + 2} className="placeholder-line is-meta" />
          </>
        ) : id === 'tokens' ? (
          <>
            <Placeholder width={56} row={index + 2} className="placeholder-line is-meta" />
            <Placeholder width={50} row={index + 2} className="placeholder-line is-meta" />
            <Placeholder width={64} row={index + 2} className="placeholder-line is-meta" />
          </>
        ) : (
          <>
            <Placeholder width={64} row={index + 2} className="placeholder-line is-meta" />
            <Placeholder width={44} row={index + 2} className="placeholder-line is-meta" />
          </>
        )}
      </div>
      <div className="chart-placeholder" style={{ height: sparkHeight }} aria-hidden="true">
        <svg
          className="chart-placeholder-svg"
          style={{ '--placeholder-row': index + 2 } as PlaceholderStyle}
          viewBox="0 0 240 48"
          preserveAspectRatio="none"
          focusable="false"
        >
          <defs>
            <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="currentColor" stopOpacity="0.1" />
              <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
            </linearGradient>
          </defs>
          <line className="chart-placeholder-base" x1="0" y1="46" x2="240" y2="46" vectorEffect="non-scaling-stroke" />
          <path d={path.area} fill={`url(#${gradId})`} style={{ color: 'var(--fg)' }} />
          <path className="chart-placeholder-line" d={path.line} vectorEffect="non-scaling-stroke" />
        </svg>
      </div>
    </Panel>
  );
}

export function ModelTrendBarsPlaceholder({ index = 0 }: { index?: number }) {
  return (
    <div className="dash-skeleton-bars" aria-hidden="true">
      {TREND_BAR_HEIGHTS.map((height, bar) => (
        <span
          key={bar}
          className="dash-skeleton-bar-col"
          style={{ height: `${height}%`, '--placeholder-row': index + (bar % 4) } as PlaceholderStyle}
        />
      ))}
    </div>
  );
}

export function ModelTrendPlaceholder({ index = 0, hasHeader = true }: { index?: number; hasHeader?: boolean }) {
  const body = (
    <>
      <div className="dash-skeleton-legend" aria-hidden="true">
        {[72, 86, 62, 78, 68].map((width, chip) => (
          <span key={chip} className="dash-skeleton-legend-chip">
            <Placeholder width={8} height={8} row={index} />
            <Placeholder width={width} row={index} className="placeholder-line is-meta" />
          </span>
        ))}
      </div>
      <ModelTrendBarsPlaceholder index={index + 1} />
    </>
  );
  if (!hasHeader) return body;
  return (
    <Panel
      className="dashboard-tile model-trend-card"
      title={<Placeholder width={76} row={index} className="placeholder-line" />}
    >
      {body}
    </Panel>
  );
}

export function ModelUsagePlaceholder({ index = 0, hasHeader = true }: { index?: number; hasHeader?: boolean }) {
  const body = (
    <>
      <div className="dash-skeleton-usage-bar" aria-hidden="true">
        {USAGE_SEGMENTS.map((grow, seg) => (
          <span
            key={seg}
            className="dash-skeleton-usage-seg"
            style={{ flexGrow: grow, '--placeholder-row': index } as PlaceholderStyle}
          />
        ))}
      </div>
      <ul className="dash-skeleton-usage-list" aria-hidden="true">
        {USAGE_ROWS.map((row, rowIdx) => (
          <li key={rowIdx} className="dash-skeleton-usage-row">
            <Placeholder width={8} height={8} row={index + rowIdx} />
            <Placeholder width={16} height={16} row={index + rowIdx} />
            <Placeholder width={row.name} row={index + rowIdx} className="placeholder-line" />
            <Placeholder width={row.cost} row={index + rowIdx} className="placeholder-line is-meta" />
            <Placeholder width={row.tokens} row={index + rowIdx} className="placeholder-line is-meta" />
            <Placeholder width={row.share} row={index + rowIdx} className="placeholder-line is-meta" />
          </li>
        ))}
      </ul>
    </>
  );
  if (!hasHeader) return body;
  return (
    <Panel
      className="dashboard-tile model-usage-card"
      title={<Placeholder width={84} row={index} className="placeholder-line" />}
    >
      {body}
    </Panel>
  );
}

export function HeatmapPlaceholder({ index = 0, hasHeader = true }: { index?: number; hasHeader?: boolean }) {
  const body = (
    <div className="dash-skeleton-heatmap-body" aria-hidden="true">
      <div className="dash-skeleton-heatmap-months">
        {[24, 22, 24, 22, 24].map((width, month) => (
          <Placeholder key={month} width={width} row={index} className="placeholder-line is-meta" />
        ))}
      </div>
      <div className="dash-skeleton-heatmap-matrix">
        <div className="dash-skeleton-heatmap-weekdays">
          {Array.from({ length: HEATMAP_ROWS }, (_, row) => (
            <Placeholder key={row} width={14} row={index + row} className="placeholder-line is-meta" />
          ))}
        </div>
        <div className="dash-skeleton-heatmap-grid">
          {Array.from({ length: HEATMAP_COLUMNS * HEATMAP_ROWS }, (_, cell) => {
            const col = cell % HEATMAP_COLUMNS;
            const tone = (cell * 7 + col * 3) % 11 === 0
              ? 'is-high'
              : (cell * 5 + col) % 4 === 0
                ? 'is-mid'
                : '';
            return (
              <span
                key={cell}
                className={`dash-skeleton-heatmap-cell${tone ? ` ${tone}` : ''}`}
                style={{ '--placeholder-row': index + (col % 6) } as PlaceholderStyle}
              />
            );
          })}
        </div>
      </div>
      <div className="dash-skeleton-heatmap-legend">
        <Placeholder width={16} row={index + 2} className="placeholder-line is-meta" />
        <div className="dash-skeleton-heatmap-swatches">
          {[0, 1, 2, 3, 4].map((swatch) => (
            <Placeholder key={swatch} width={12} height={12} row={index + 2} />
          ))}
        </div>
        <Placeholder width={16} row={index + 2} className="placeholder-line is-meta" />
      </div>
    </div>
  );
  if (!hasHeader) return body;
  return (
    <Panel className="dashboard-tile heatmap-panel">
      <div className="dash-skeleton-heatmap-head" aria-hidden="true">
        <Placeholder width={72} row={index} className="placeholder-line is-meta" />
      </div>
      {body}
    </Panel>
  );
}

export function CredentialQuotaPlaceholder({ index = 0, hasHeader = true }: { index?: number; hasHeader?: boolean }) {
  const rows = (
    <div className="dash-skeleton-quota-rows" aria-hidden="true">
      {QUOTA_ROWS.map((row, rowIdx) => (
        <div key={rowIdx} className="dash-skeleton-quota-row">
          <Placeholder width={16} height={16} row={index + rowIdx} />
          <Placeholder width={row.name} row={index + rowIdx} className="placeholder-line" />
          <div className="dash-skeleton-quota-meters">
            <div className="dash-skeleton-quota-meter">
              <Placeholder width={row.labelA} row={index + rowIdx} className="placeholder-line is-meta" />
              <Placeholder width="100%" height={6} row={index + rowIdx} />
              <Placeholder width={22} row={index + rowIdx} className="placeholder-line is-meta" />
            </div>
            <div className="dash-skeleton-quota-meter">
              <Placeholder width={row.labelB} row={index + rowIdx} className="placeholder-line is-meta" />
              <Placeholder width="100%" height={6} row={index + rowIdx} />
              <Placeholder width={22} row={index + rowIdx} className="placeholder-line is-meta" />
            </div>
          </div>
          <Placeholder width={row.when} row={index + rowIdx} className="placeholder-line is-meta" />
        </div>
      ))}
    </div>
  );
  if (!hasHeader) return rows;
  return (
    <Panel className="dashboard-tile credential-quota-panel">
      <div className="dash-skeleton-quota-head" aria-hidden="true">
        <Placeholder width={72} row={index} className="placeholder-line is-meta" />
        <span className="dash-skeleton-quota-aside">
          <Placeholder width={44} row={index} className="placeholder-line is-meta" />
          <Placeholder width={44} row={index} className="placeholder-line is-meta" />
          <Placeholder width={16} height={16} row={index} />
        </span>
      </div>
      {rows}
    </Panel>
  );
}

export function ProvidersPlaceholder({ index = 0, hasHeader = true }: { index?: number; hasHeader?: boolean }) {
  return (
    <section className="dashboard-section dashboard-providers-section" aria-hidden="true">
      {hasHeader && (
        <div className="dash-skeleton-provider-head">
          <Placeholder width={104} row={index} className="placeholder-line is-meta" />
        </div>
      )}
      <div className="placeholder-frame">
        {PROVIDER_ROWS.map((row, rowIdx) => (
          <div key={rowIdx} className="dash-skeleton-provider-row">
            <div className="dash-skeleton-provider-main">
              <Placeholder width={32} height={32} row={index + rowIdx} className="is-control" />
              <Placeholder width={row.name} row={index + rowIdx} className="placeholder-line" />
            </div>
            <Placeholder width={row.creds} row={index + rowIdx} className="placeholder-line is-meta" />
            <Placeholder width={row.total} row={index + rowIdx} className="placeholder-line" />
            <Placeholder width={row.rate} row={index + rowIdx} className="placeholder-line is-meta" />
            <div className="dash-skeleton-provider-strip">
              {Array.from({ length: 10 }, (_, block) => (
                <span key={block} />
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

/**
 * Renders the full dashboard board outline in the operator's stored arrangement while the route
 * module downloads, reserving both KPI and lower panel tracks so the page height never jumps.
 */
export function DashboardTilesPlaceholder({ layout }: { layout: DashboardLayout }) {
  const items = layout.filter((item) => !item.hidden);
  return (
    <LoadingRegion className="dashboard-grid">
      {items.map((item, index) => {
        const spec = dashboardWidgetSpec(item.id);
        let widget: React.ReactNode;
        if (spec.isMetric) {
          widget = <DashboardKpiTilePlaceholder id={item.id} index={index} />;
        } else {
          switch (item.id) {
            case 'routing':
              widget = (
                <Panel className="dashboard-tile">
                  <div className="dash-skeleton-tile-head" aria-hidden="true">
                    <Placeholder width={88} row={index} className="placeholder-line is-meta" />
                    <Placeholder width={56} row={index} className="placeholder-line is-meta" />
                  </div>
                  <RoutingMapSkeleton className="tile-placeholder-spark" />
                </Panel>
              );
              break;
            case 'model_trend':
              widget = <ModelTrendPlaceholder index={index} />;
              break;
            case 'model_usage':
              widget = <ModelUsagePlaceholder index={index} />;
              break;
            case 'token_activity':
              widget = <HeatmapPlaceholder index={index} />;
              break;
            case 'credential_quota':
              widget = <CredentialQuotaPlaceholder index={index} />;
              break;
            case 'providers':
              widget = <ProvidersPlaceholder index={index} />;
              break;
          }
        }
        return (
          <div
            key={item.id}
            className="dashboard-cell"
            data-span={item.span}
            style={{ '--rows': item.rows } as React.CSSProperties}
          >
            {widget}
          </div>
        );
      })}
    </LoadingRegion>
  );
}

export function DashboardSkeleton({ isImmediate = false }: { isImmediate?: boolean }) {
  const queryClient = React.useContext(QueryClientContext);
  const stored = queryClient?.getQueryData<Record<string, unknown>>(['preferences'])?.[DASHBOARD_LAYOUT_PREFERENCE];
  const layout = React.useMemo(() => parseDashboardLayout(stored) ?? DEFAULT_DASHBOARD_LAYOUT, [stored]);

  return (
    <div className="terminal-page dashboard-page">
      <LoadingRegion isImmediate={isImmediate}>
        <DashboardHeadPlaceholder />
        <DashboardTilesPlaceholder layout={layout} />
      </LoadingRegion>
    </div>
  );
}
