import React from 'react';
import { Area } from '@ant-design/charts';
import dayjs from 'dayjs';
import { renderChartTooltip } from './chartTooltip';
import { useTheme } from '../theme/ThemeContext';
import { usePrefersReducedMotion } from '../hooks/usePrefersReducedMotion';
import { resolveChartAnimation } from './chartMotion';
import { useChartPlugins } from './chartRender';
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
 * Animation is on: the mark morphs between two revisions instead of being replaced, which is what
 * makes a poll's new data read as movement rather than as a hard cut. A reader who asked for reduced
 * motion gets the old behaviour, an instant swap, because the mark is redrawn on a canvas that CSS
 * cannot reach. See `chartMotion.ts` and docs/design.md §7 rule 5.
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
  const { theme, themeMode } = useTheme();
  const isReducedMotion = usePrefersReducedMotion();
  const animate = resolveChartAnimation(isReducedMotion);
  const { plugins, onReady } = useChartPlugins();

  const values = React.useMemo(() => points.map((point) => Math.max(0, pick(point) ?? 0)), [points, pick]);
  const color = sparkColor(theme.palette, tone);

  const chartData = React.useMemo(
    () => values.map((value, index) => ({ bucket: String(points[index].t), value })),
    [values, points],
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
      tooltip: { title: 'bucket', items: ['value'] },
      theme: { type: themeMode, tooltip: { crosshairsStroke: theme.palette.muted, crosshairsStrokeOpacity: 1 } },
      interaction: {
        tooltip: {
          shared: true,
          crosshairs: true,
          render: (_event: unknown, context: { title?: string; items?: Array<{ value?: number }> }) => {
            const value = Number(context.items?.[0]?.value ?? 0);
            const time = Number(context.title);
            const displayValue = (format ?? formatCount)(value);
            return renderChartTooltip((label ?? ((at: number) => dayjs(at).format('MM-DD HH:mm')))(time), [
              { color, value: displayValue, exact: formatExact?.(value) ?? displayValue },
            ]);
          },
        },
      },
      animate,
      plugins,
      onReady,
    }),
    [chartData, height, color, animate, plugins, onReady, themeMode, theme.palette.muted, format, formatExact, label],
  );

  if (values.length < 2) {
    return <div className="chart-placeholder" style={{ height }} aria-hidden="true" />;
  }

  return (
    <div className="chart-slot" style={{ height }}>
      <Area {...config} />
    </div>
  );
};
