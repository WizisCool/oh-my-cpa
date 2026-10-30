import { usePreference } from '../../hooks/usePreference';
import {
  DASHBOARD_LAYOUT_PREFERENCE,
  DEFAULT_DASHBOARD_LAYOUT,
  dashboardWidgetSpec,
  parseDashboardLayout,
  type DashboardLayout,
} from '../../types/dashboardLayout';
import { LoadingRegion, PageHeadPlaceholder, Placeholder } from '../common/Placeholder';
import { Panel } from '../common/Panel';
import './dashboardGrid.css';

/**
 * The dashboard's metric tiles before the first reading: each tile's own readouts - label, number,
 * sparkline - where they will land, in the operator's arrangement. The panels below the tiles read
 * on their own and draw their own first frames.
 */
export function DashboardTilesPlaceholder({ layout }: { layout: DashboardLayout }) {
  const tiles = layout.filter((item) => !item.hidden && dashboardWidgetSpec(item.id).isMetric);
  return (
    <LoadingRegion className="dashboard-grid">
      {tiles.map((item, index) => (
        <div key={item.id} className="dashboard-cell" data-span={item.span}>
          {item.span > 1 ? (
            <Panel className="dashboard-tile">
              <Placeholder width="28%" row={index} className="placeholder-line is-meta" />
              <Placeholder width="42%" height={34} row={index + 1} className="tile-placeholder-hero" />
              <Placeholder width="100%" height={44} row={index + 2} className="tile-placeholder-spark" />
            </Panel>
          ) : (
            <Panel className="dashboard-tile">
              <Placeholder width="46%" row={index + 2} className="placeholder-line is-meta" />
              <Placeholder width="58%" height={24} row={index + 3} className="tile-placeholder-value" />
              <Placeholder width="72%" row={index + 4} className="placeholder-line is-meta" />
            </Panel>
          )}
        </div>
      ))}
    </LoadingRegion>
  );
}

/**
 * The dashboard route while its module downloads. The arrangement is a stored preference the shell
 * has usually read already, so the frame is the operator's own board and the page's first-load
 * frame that follows it moves nothing.
 */
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
