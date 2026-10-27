import { useInsightsFormat } from '../useInsightsFormat';
import React from 'react';
import { EChart } from '../../../charts/echarts/EChart';
import { renderChartTooltip } from '../../../charts/chartTooltip';
import { useTheme } from '../../../theme/ThemeContext';
import { useTokenDisplayStyle } from '../../../types/tokenDisplayContext';
import type { InsightsMetric } from '../insightsCube';
import { formatShare } from '../insightsFormat';

export interface InsightsHourChartProps {
  /** Twenty-four values, local hour 0 first. */
  values: readonly number[];
  /** The busiest hours, drawn in the full series ink; the rest are drawn lighter. */
  peakHours: ReadonlySet<number>;
  /** The word written over the busiest stretch. */
  peakLabel: string;
  metric: InsightsMetric;
  label: string;
}

const HOUR_LABELS = Array.from({ length: 24 }, (_, hour) => `${String(hour).padStart(2, '0')}:00`);

/**
 * When in the day the window's usage happened: one bar per local hour, summed over every day of the
 * window. The busiest hours carry the full ink and the rest a lighter one, and the stretch is named
 * on the chart, so the peak is the first thing read without a sentence or a legend to learn.
 */
const InsightsHourChartView: React.FC<InsightsHourChartProps> = ({ values, peakHours, peakLabel, metric, label }) => {
  const { theme } = useTheme();
  const { style } = useTokenDisplayStyle();
  const { formatMetric, formatMetricExact } = useInsightsFormat();

  const option = React.useMemo(() => {
    const total = values.reduce((sum, value) => sum + value, 0);
    const ink = theme.palette.series[0];
    const peak = [...peakHours].sort((left, right) => left - right);
    // A stretch over midnight is two areas on a 00-23 axis; the label goes on the larger part.
    const runs: number[][] = [];
    for (const hour of peak) {
      const last = runs.at(-1);
      if (last && last.at(-1) === hour - 1) last.push(hour);
      else runs.push([hour]);
    }
    const longest = runs.reduce<number[]>((best, run) => (run.length > best.length ? run : best), []);
    // Always an object: a merged update keeps a mark area an option merely leaves out.
    const markArea = runs.length === 0 ? { data: [] } : {
      silent: true,
      itemStyle: { color: theme.palette.hover, opacity: 0.55 },
      label: { color: theme.palette.fg2, fontSize: 11, position: 'insideTop', distance: 2 },
      data: runs.map((run) => [
        { xAxis: HOUR_LABELS[run[0]], name: run === longest ? peakLabel : '' },
        { xAxis: HOUR_LABELS[run[run.length - 1]] },
      ]),
    };
    return {
      grid: { left: 4, right: 8, top: 22, bottom: 4, containLabel: true },
      xAxis: { type: 'category', data: HOUR_LABELS, axisLabel: { interval: 2 } },
      yAxis: { type: 'value', splitNumber: 3, axisLabel: { formatter: (value: number) => formatMetric(metric, value, style) } },
      tooltip: {
        trigger: 'axis',
        className: 'omc-echart-tip',
        axisPointer: { type: 'shadow' },
        formatter: (items: Array<{ dataIndex: number; value?: number }>) => {
          const hour = items[0]?.dataIndex ?? 0;
          const value = items[0]?.value ?? 0;
          return renderChartTooltip(`${HOUR_LABELS[hour]} – ${HOUR_LABELS[(hour + 1) % 24]}`, [
            { value: formatMetric(metric, value, style), exact: formatMetricExact(metric, value), share: formatShare(total > 0 ? value / total : null) },
          ]);
        },
      },
      series: [{
        id: 'hours',
        type: 'bar',
        markArea,
        barCategoryGap: '24%',
        data: values.map((value, hour) => ({
          value,
          itemStyle: { color: ink, opacity: peakHours.has(hour) ? 1 : 0.42 },
        })),
      }],
    };
  }, [metric, peakHours, peakLabel, style, theme.palette, values, formatMetric, formatMetricExact]);

  return <EChart option={option} height={200} label={label} testId="insights-hour-chart" />;
};

export const InsightsHourChart = React.memo(InsightsHourChartView);
export default InsightsHourChart;
