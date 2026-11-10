import React from 'react';
import {
  dashboardWidgetSpec,
  type DashboardLayout,
  type DashboardLayoutItem,
  type DashboardWidgetId,
} from '../../types/dashboardLayout';
import { createNamedLoader, lazyRoute } from '../../utils/routeLoader';
import './dashboardGrid.css';

export interface DashboardBoardProps {
  layout: DashboardLayout;
  /** True while the operator is arranging the board; the arrangement then lives in `onChange`'s draft. */
  isEditing: boolean;
  isPhone: boolean;
  /** Draws one widget, or nothing when it has nothing to show yet. */
  renderWidget: (id: DashboardWidgetId) => React.ReactNode;
  onChange: (next: DashboardLayout) => void;
}

export const loadDashboardBoardEditor = createNamedLoader(
  () => import('./DashboardBoardEditor'),
  'DashboardBoardEditor',
);
const LazyDashboardBoardEditor = lazyRoute<DashboardBoardProps>(loadDashboardBoardEditor);

export function preloadDashboardBoardEditor(): void {
  void loadDashboardBoardEditor().catch(() => undefined);
}

const StaticDashboardBoard: React.FC<Pick<DashboardBoardProps, 'layout' | 'isPhone' | 'renderWidget'>> = ({
  layout,
  isPhone,
  renderWidget,
}) => {
  const shown = layout.filter(
    (item: DashboardLayoutItem) => !item.hidden && !(isPhone && dashboardWidgetSpec(item.id).isPhoneOmitted),
  );
  return (
    <div className="dashboard-grid" data-testid="dashboard-board">
      {shown.map((item) => {
        const spec = dashboardWidgetSpec(item.id);
        const content = renderWidget(item.id);
        if (content === null || content === undefined || content === false) return null;
        return (
          <div
            key={item.id}
            className="dashboard-cell"
            style={{ '--rows': item.rows } as React.CSSProperties}
            data-widget={item.id}
            data-widget-kind={spec.isMetric ? 'metric' : 'panel'}
            data-span={item.span}
            data-rows={item.rows}
          >
            {content}
          </div>
        );
      })}
    </div>
  );
};

/**
 * Renders a zero-overhead CSS Grid on ordinary reads (99.9% of Dashboard visits) without mounting
 * `@dnd-kit` `MeasuringStrategy.Always` or Framer Motion layout projection nodes, and loads the
 * interactive arrangement editor only when the operator enters Arrange mode.
 */
export const DashboardBoard: React.FC<DashboardBoardProps> = React.memo(function DashboardBoard(props) {
  if (!props.isEditing) {
    return (
      <StaticDashboardBoard
        layout={props.layout}
        isPhone={props.isPhone}
        renderWidget={props.renderWidget}
      />
    );
  }
  return (
    <React.Suspense
      fallback={(
        <StaticDashboardBoard
          layout={props.layout}
          isPhone={props.isPhone}
          renderWidget={props.renderWidget}
        />
      )}
    >
      <LazyDashboardBoardEditor {...props} />
    </React.Suspense>
  );
});
