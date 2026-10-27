import { useInsightsFormat } from '../useInsightsFormat';
import React from 'react';
import { EChart } from '../../../charts/echarts/EChart';
import { renderChartTooltip } from '../../../charts/chartTooltip';
import { useTokenDisplayStyle } from '../../../types/tokenDisplayContext';
import type { InsightsMetric } from '../insightsCube';
import { formatShare } from '../insightsFormat';

export interface CompositionSegment {
  /** The column value (a model), or null for the row's remainder. */
  id: string | null;
  name: string;
  color: string;
}

export interface InsightsCompositionChartProps {
  /** One bar per row (a key), top to bottom. */
  rows: ReadonlyArray<{ id: string; name: string }>;
  segments: readonly CompositionSegment[];
  /** `values[segment][row]`. */
  values: ReadonlyArray<readonly number[]>;
  metric: InsightsMetric;
  totalLabel: string;
  label: string;
  /** Steps back what the page is not narrowed to; absent, every segment is at full ink. */
  isDimmed?: (rowId: string, segmentId: string | null) => boolean;
  onSelect?: (rowId: string, segmentId: string | null) => void;
}

interface ItemParams {
  seriesIndex: number;
  dataIndex: number;
  value?: number;
}

const ROW_HEIGHT = 30;

/**
 * What each key is made of: one horizontal bar per key, its length the key's whole, cut into the
 * models it used. Read like a sentence - "this key, this much, mostly this model" - which a heat table
 * of the same numbers asks the reader to assemble cell by cell. Hovering a segment names the model,
 * its amount and its part of the key; selecting it narrows the page to that key and model.
 */
const InsightsCompositionChartView: React.FC<InsightsCompositionChartProps> = ({ rows, segments, values, metric, totalLabel, label, isDimmed, onSelect }) => {
  const { style } = useTokenDisplayStyle();
  const { formatMetric, formatMetricExact } = useInsightsFormat();
  const selectRef = React.useRef(onSelect);
  selectRef.current = onSelect;

  const option = React.useMemo(() => {
    const totals = rows.map((_, row) => values.reduce((sum, series) => sum + (series[row] ?? 0), 0));
    return {
      grid: { left: 4, right: 16, top: 4, bottom: 4, containLabel: true },
      xAxis: { type: 'value', splitNumber: 4, axisLabel: { formatter: (value: number) => formatMetric(metric, value, style) } },
      yAxis: {
        type: 'category',
        inverse: true,
        data: rows.map((row) => row.name),
        axisLabel: { width: 150, overflow: 'truncate' },
        axisLine: { show: false },
      },
      tooltip: {
        trigger: 'item',
        className: 'omc-echart-tip',
        formatter: (item: ItemParams) => {
          const segment = segments[item.seriesIndex];
          const total = totals[item.dataIndex] ?? 0;
          const value = item.value ?? 0;
          return renderChartTooltip(rows[item.dataIndex]?.name, [
            { name: segment?.name, color: segment?.color, value: formatMetric(metric, value, style), exact: formatMetricExact(metric, value), share: formatShare(total > 0 ? value / total : null) },
            { name: totalLabel, value: formatMetric(metric, total, style), exact: formatMetricExact(metric, total) },
          ]);
        },
      },
      series: segments.map((segment, index) => ({
        id: segment.id ?? '\u0000rest',
        name: segment.name,
        type: 'bar',
        stack: 'composition',
        barMaxWidth: 18,
        itemStyle: { color: segment.color },
        emphasis: { focus: 'series' },
        data: isDimmed
          ? values[index].map((value, row) => ({ value, itemStyle: { opacity: isDimmed(rows[row].id, segment.id) ? 0.22 : 1 } }))
          : values[index],
      })),
    };
  }, [isDimmed, metric, rows, segments, style, totalLabel, values, formatMetric, formatMetricExact]);

  const handlers = React.useMemo(() => ({
    click: (params: unknown) => {
      const item = params as ItemParams;
      const row = rows[item.dataIndex];
      const segment = segments[item.seriesIndex];
      if (row && segment) selectRef.current?.(row.id, segment.id);
    },
  }), [rows, segments]);

  return (
    <EChart
      option={option}
      height={Math.max(120, rows.length * ROW_HEIGHT + 32)}
      label={label}
      handlers={handlers}
      testId="insights-composition-chart"
    />
  );
};

export const InsightsCompositionChart = React.memo(InsightsCompositionChartView);
export default InsightsCompositionChart;
