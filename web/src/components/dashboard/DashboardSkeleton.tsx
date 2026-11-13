import { usePreference } from '../../hooks/usePreference';
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

/**
 * Exact-geometry KPI tile placeholder matching the loaded `.kpi-tile` structure (label, hero
 * readout, caption, and sparkline slot) so the transition from skeleton to live numbers causes
 * zero layout shift (`CLS = 0`).
 */
export function DashboardKpiTilePlaceholder({
  id,
  index = 0,
}: {
  id: DashboardWidgetId;
  index?: number;
}) {
  const sparkHeight = id === 'requests' || id === 'tokens' ? 64 : 44;
  return (
    <Panel className="dashboard-tile kpi-tile">
      <Placeholder width={id === 'requests' || id === 'tokens' ? '28%' : '46%'} row={index} className="placeholder-line is-meta" />
      <div className="tile-value" aria-hidden="true">
        <Placeholder width={id === 'requests' || id === 'tokens' ? '42%' : '58%'} height={34} row={index + 1} />
      </div>
      <div className="tile-caption" aria-hidden="true">
        <Placeholder width="68%" row={index + 2} className="placeholder-line is-meta" />
      </div>
      <div className="chart-placeholder" style={{ height: sparkHeight }} aria-hidden="true" />
    </Panel>
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
        return (
          <div
            key={item.id}
            className="dashboard-cell"
            data-span={item.span}
            style={{ '--rows': item.rows } as React.CSSProperties}
          >
            {spec.isMetric ? (
              <DashboardKpiTilePlaceholder id={item.id} index={index} />
            ) : item.id === 'routing' ? (
              <Panel className="dashboard-tile">
                <Placeholder width="24%" row={index} className="placeholder-line is-meta" />
                <RoutingMapSkeleton className="tile-placeholder-spark" />
              </Panel>
            ) : (
              <Panel className="dashboard-tile">
                <Placeholder width="32%" row={index} className="placeholder-line is-meta" />
                <Placeholder width="100%" height={180} row={index + 1} className="tile-placeholder-spark" />
              </Panel>
            )}
          </div>
        );
      })}
    </LoadingRegion>
  );
}

export function DashboardSkeleton() {
  const layout = usePreference(DASHBOARD_LAYOUT_PREFERENCE, DEFAULT_DASHBOARD_LAYOUT, parseDashboardLayout);
  return (
    <div className="terminal-page dashboard-page">
      <LoadingRegion>
        <PageHeadPlaceholder />
        <DashboardTilesPlaceholder layout={layout.value} />
      </LoadingRegion>
    </div>
  );
}
