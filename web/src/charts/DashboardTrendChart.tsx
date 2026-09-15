import React from 'react';
import { Area } from '@ant-design/charts';
import dayjs from 'dayjs';
import { useThemeMode } from '../theme/ThemeContext';
import { sparkColor, type ChartTone } from './chartTheme';
import type { DashboardSeriesPoint } from '../types/dashboard';

export interface DashboardTrendChartProps {
  points: DashboardSeriesPoint[];
  pick: (point: DashboardSeriesPoint) => number;
  tone?: ChartTone;
  height?: number;
  label?: (timeMs: number) => string;
  format?: (value: number) => string;
  /**
   * The exact form of the hovered value, shown as the tooltip's own accessible
   * name. The visible readout may be abbreviated - a sparkline's tooltip is a
   * glance, not a ledger - but an abbreviation must never be the only number
   * available, because "1.2B" is a rounded claim and the exact count is the fact.
   */
  formatExact?: (value: number) => string;
}

const PLAIN_NUMBER_FORMAT = new Intl.NumberFormat('en');

function formatCount(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return PLAIN_NUMBER_FORMAT.format(value);
}

/**
 * TrendChart renders one bucket series as an AntV area mark.
 *
 * An area is the right mark for this data because the backend zero-fills a fixed
 * grid (`fillDashboardBuckets`): a quiet window is mostly zero buckets, and a
 * zero is a measured value, not a missing one. Bars would draw each zero as an
 * invisible gap between floating marks, which reads as "no data here" - the one
 * thing it does not mean. An area carries the series down to the baseline, so an
 * empty stretch renders as the axis itself and stays distinguishable from an
 * unmeasured period.
 *
 * The mark is deliberately two paths: `area` is fill-only and `line` is stroke-only.
 * A stroked area closes its path along the baseline, so a single mark would draw a
 * horizontal rule across the plot floor.
 *
 * Animation is off because the geometry swaps on the data revision; a mark that
 * eases between two revisions reads as a repaint rather than as new data.
 */
export const DashboardTrendChart: React.FC<DashboardTrendChartProps> = ({
  points,
  pick,
  tone = 'accent',
  height = 46,
  label,
  format,
  formatExact,
}) => {
  const { themeMode } = useThemeMode();
  const [activeIndex, setActiveIndex] = React.useState<number | null>(null);

  const values = React.useMemo(() => points.map((point) => Math.max(0, pick(point) ?? 0)), [points, pick]);
  const color = sparkColor(themeMode, tone);

  const chartData = React.useMemo(
    () => values.map((value, index) => ({ bucket: String(index), value })),
    [values],
  );

  const config = React.useMemo(
    () => ({
      data: chartData,
      xField: 'bucket',
      yField: 'value',
      height,
      autoFit: true,
      shapeField: 'smooth',
      style: {
        fill: color,
        fillOpacity: 0.14,
        // The closing baseline of the fill must not be painted; the axis already
        // communicates the floor and a second rule there reads as a data line.
        stroke: 'transparent',
      },
      line: {
        style: {
          stroke: color,
          strokeWidth: 1.5,
        },
      },
      // A zero-filled grid must keep zero as the floor: `nice` would lift the
      // domain and turn an empty window into a line floating above the axis.
      scale: { y: { nice: false, domainMin: 0 } },
      axis: false,
      legend: false,
      tooltip: false,
      animate: false,
    }),
    [chartData, height, color],
  );

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    if (bounds.width <= 0) return;
    const ratio = Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width));
    // The drawn mark spans the plot box, which the library insets; mapping the
    // pointer by ratio keeps the readout aligned with the mark under it.
    const index = Math.min(values.length - 1, Math.max(0, Math.round(ratio * (values.length - 1))));
    setActiveIndex(index);
  };

  if (values.length < 2) {
    return <div className="chart-placeholder" style={{ height }} aria-hidden="true" />;
  }

  const activeValue = activeIndex === null ? null : values[activeIndex];
  const activeTime = activeIndex === null ? 0 : points[activeIndex]?.t ?? 0;
  const formatTooltipTitle = label ?? ((timeMs: number) => (timeMs > 0 ? dayjs(timeMs).format('MM-DD HH:mm') : ''));
  const formatTooltipValue = format ?? ((value: number) => formatCount(value));
  const formatTooltipExact = formatExact ?? formatTooltipValue;
  const activeRatio = activeIndex === null || values.length < 2 ? 0 : activeIndex / (values.length - 1);

  return (
    <div
      className="chart-slot"
      style={{ height }}
      onPointerMove={handlePointerMove}
      onPointerLeave={() => setActiveIndex(null)}
    >
      <Area {...config} />
      {activeValue !== null && (
        <div className="chart-tooltip" style={{ left: `${activeRatio * 100}%` }}>
          <div className="chart-tooltip-time">{formatTooltipTitle(activeTime)}</div>
          <div className="chart-tooltip-value" title={formatTooltipExact(activeValue)}>{formatTooltipValue(activeValue)}</div>
        </div>
      )}
    </div>
  );
};
