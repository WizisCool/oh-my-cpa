import React from 'react';
import { Column } from '@ant-design/charts';
import dayjs from 'dayjs';
import { useThemeMode } from '../theme/ThemeContext';
import { buildBarGeometry, sparkColor, type ChartTone } from './chartTheme';
import type { DashboardSeriesPoint } from '../types/dashboard';

export interface DashboardBarChartProps {
  points: DashboardSeriesPoint[];
  pick: (point: DashboardSeriesPoint) => number;
  tone?: ChartTone;
  height?: number;
  label?: (timeMs: number) => string;
  format?: (value: number) => string;
}

const PLAIN_NUMBER_FORMAT = new Intl.NumberFormat('en');

function formatCount(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return PLAIN_NUMBER_FORMAT.format(value);
}

export const DashboardBarChart: React.FC<DashboardBarChartProps> = ({
  points,
  pick,
  tone = 'accent',
  height = 46,
  label,
  format,
}) => {
  const { themeMode } = useThemeMode();
  const [activeIndex, setActiveIndex] = React.useState<number | null>(null);

  const values = React.useMemo(() => points.map((p) => Math.max(0, pick(p) ?? 0)), [points, pick]);
  const geometry = React.useMemo(() => buildBarGeometry(values, height), [values, height]);
  const color = sparkColor(themeMode, tone);

  if (values.length < 2) {
    return <div className="chart-placeholder" style={{ height }} aria-hidden="true" />;
  }

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    if (bounds.width <= 0) return;
    const ratio = Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width));
    const idx = Math.min(values.length - 1, Math.max(0, Math.round(ratio * (values.length - 1))));
    setActiveIndex(idx);
  };

  const activeValue = activeIndex === null ? null : values[activeIndex];
  const activeTime = activeIndex === null ? 0 : points[activeIndex]?.t ?? 0;
  const activeBar = activeIndex === null ? null : geometry.bars[activeIndex];

  const formatTooltipTitle = label ?? ((timeMs: number) => (timeMs > 0 ? dayjs(timeMs).format('MM-DD HH:mm') : ''));
  const formatTooltipValue = format ?? ((val: number) => formatCount(val));

  const chartData = React.useMemo(
    () => values.map((val, idx) => ({ bucket: String(idx), value: val })),
    [values],
  );

  const config = React.useMemo(
    () => ({
      data: chartData,
      xField: 'bucket',
      yField: 'value',
      height,
      autoFit: true,
      style: {
        fill: color,
      },
      axis: false,
      legend: false,
      tooltip: false,
      animate: false,
    }),
    [chartData, height, color],
  );

  return (
    <div
      className="chart-slot"
      style={{ height }}
      onPointerMove={handlePointerMove}
      onPointerLeave={() => setActiveIndex(null)}
    >
      <Column {...config} />
      {activeBar && activeValue !== null && (
        <div
          className="chart-tooltip"
          style={{
            left: `${((activeBar.x + activeBar.width / 2) / 1000) * 100}%`,
          }}
        >
          <div className="chart-tooltip-time">{formatTooltipTitle(activeTime)}</div>
          <div className="chart-tooltip-value">{formatTooltipValue(activeValue)}</div>
        </div>
      )}
    </div>
  );
};
