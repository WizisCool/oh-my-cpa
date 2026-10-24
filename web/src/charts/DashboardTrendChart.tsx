import { useTimeZone } from '../utils/TimeZoneProvider';
import React from 'react';
import dayjs from '../utils/time';
import { renderChartTooltip } from './chartTooltip';
import { useTheme } from '../theme/ThemeContext';
import { EChart } from './echarts/EChart';
import { echarts, type EChartsCoreOption } from './echarts/core';
import { sparkColor, type ChartTone } from './chartTheme';
import type { DashboardSeriesPoint } from '../types/dashboard';

export interface DashboardTrendChartProps {
  points: DashboardSeriesPoint[];
  ariaLabel: string;
  pick: (point: DashboardSeriesPoint) => number;
  tone?: ChartTone;
  height?: number;
  label?: (timeMs: number) => string;
  format?: (value: number) => string;
  /** The exact value remains accessible when the visible readout is abbreviated. */
  formatExact?: (value: number) => string;
}

const PLAIN_NUMBER_FORMAT = new Intl.NumberFormat('en');

/** An area carries measured zero buckets to the baseline rather than implying missing data. */
export const DashboardTrendChart: React.FC<DashboardTrendChartProps> = ({
  points, pick, ariaLabel, tone = 'accent', height = 46, label, format, formatExact,
}) => {
  const timeZone = useTimeZone();
  const { theme } = useTheme();
  const color = sparkColor(theme.palette, tone);
  const values = React.useMemo(() => points.map((point) => Math.max(0, pick(point) ?? 0)), [points, pick]);
  const option = React.useMemo<EChartsCoreOption>(() => {
    const [red, green, blue] = echarts.color.parse(color)!;
    return {
      grid: { left: 16, right: 16, top: 16, bottom: 16 },
      xAxis: { type: 'category', data: points.map((point) => String(point.t)), show: false, boundaryGap: false },
      yAxis: { type: 'value', min: 0, show: false },
      tooltip: {
        trigger: 'axis', className: 'omc-echart-tip', confine: true,
        axisPointer: { type: 'line' },
        formatter: (items: Array<{ dataIndex: number }>) => {
          const index = items[0]?.dataIndex;
          if (index === undefined) return '';
          const value = values[index];
          const display = format?.(value) ?? PLAIN_NUMBER_FORMAT.format(value);
          return renderChartTooltip((label ?? ((at: number) => dayjs(at).format('MM-DD HH:mm')))(points[index].t), [
            { color, value: display, exact: formatExact?.(value) ?? display },
          ]);
        },
      },
      series: [{
        id: 'metric', type: 'line', data: values, smooth: true, smoothMonotone: 'x',
        showSymbol: false, symbol: 'circle', symbolSize: 5,
        lineStyle: { color, width: 1.5, cap: 'round', join: 'round' }, itemStyle: { color },
        emphasis: { scale: true, lineStyle: { width: 1.5 } },
        areaStyle: {
          opacity: 1,
          color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
            { offset: 0, color: `rgba(${red},${green},${blue},0.22)` },
            { offset: 1, color: `rgba(${red},${green},${blue},0)` },
          ]),
        },
      }],
    };
  }, [points, values, color, label, format, formatExact, timeZone]);

  if (values.length < 2) return <div className="chart-placeholder" style={{ height }} aria-hidden="true" />;
  return <div className="chart-slot" style={{ height }}><EChart option={option} height={height} label={ariaLabel} /></div>;
};
