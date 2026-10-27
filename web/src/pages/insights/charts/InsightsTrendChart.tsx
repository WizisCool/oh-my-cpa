import { useInsightsFormat } from '../useInsightsFormat';
import React from 'react';
import dayjs from '../../../utils/time';
import { useTimeZone } from '../../../utils/TimeZoneProvider';
import { EChart } from '../../../charts/echarts/EChart';
import type { ECharts } from '../../../charts/echarts/core';
import { renderChartTooltip } from '../../../charts/chartTooltip';
import { useT } from '../../../i18n';
import { useTheme } from '../../../theme/ThemeContext';
import { useTokenDisplayStyle } from '../../../types/tokenDisplayContext';
import type { InsightsBucket } from '../../../types/insights';
import { isAdditiveMetric, type InsightsMetric, type TrendGroup } from '../insightsCube';
import { formatShare } from '../insightsFormat';

export interface InsightsTrendChartProps {
  bucketStarts: readonly number[];
  bucket: InsightsBucket;
  groups: readonly TrendGroup[];
  /** Unfolded groups let the tooltip name every contributor while the plot stays compact. */
  tooltipGroups: readonly TrendGroup[];
  /** Computed from bucket measures so latency retains its weighted denominator. */
  totals: ReadonlyArray<number | null>;
  /** Requests behind each aggregate line point. */
  totalSamples: readonly number[];
  /** Colour and name per group id, from the page's one ranking. */
  colorOf: (id: string) => string;
  labelOf: (id: string) => string;
  metric: InsightsMetric;
  /** Latency keeps the aggregate line even when the legend isolates one group. */
  showTotal: boolean;
  /** A painted series selects its group; the background clears the selection. */
  onSelectGroup: (id: string | null) => void;
  /** What the tooltip calls the bucket's whole. */
  totalLabel: string;
  label: string;
  /** A dragged span, as bucket indices, inclusive. */
  onBrush?: (fromIndex: number, toIndex: number) => void;
  height?: number;
}

const TOTAL_SERIES_ID = '\u0000total';
/** Below this many requests, a latency point is closer to one outlier than to a stable average. */
const LOW_SAMPLE_REQUESTS = 5;

const LABEL_FORMATS: Record<InsightsBucket, string> = { hour: 'HH:mm', day: 'MM-DD', week: 'MM-DD', month: 'YYYY-MM' };
const TOOLTIP_FORMATS: Record<InsightsBucket, string> = { hour: 'MM-DD HH:mm', day: 'YYYY-MM-DD', week: 'YYYY-MM-DD', month: 'YYYY-MM' };

interface AxisTooltipItem {
  dataIndex: number;
  seriesId?: string;
  seriesIndex?: number;
}

/**
 * The trend: the selected metric per bucket.
 *
 * A metric that adds up (spend, tokens, requests) is a stack of bars, one segment per group, so the
 * bar's height is the whole and each segment its share - the reading the page exists for. Latency
 * does not add up, so it is one line per named group on a shared axis,
 * with a muted dashed aggregate for reference. Hovering a line or point keeps the tooltip on that
 * series even while the pointer moves; a click pins that group and the empty plot clears it.
 * Dragging across the plot narrows the window to the buckets dragged over.
 */
const InsightsTrendChartView: React.FC<InsightsTrendChartProps> = ({
  bucketStarts, bucket, groups, tooltipGroups, totals, totalSamples, colorOf, labelOf, metric, showTotal, onSelectGroup, totalLabel, label, onBrush, height = 280,
}) => {
  useTimeZone();
  const t = useT();
  const { theme } = useTheme();
  const { style } = useTokenDisplayStyle();
  const { formatMetric, formatMetricExact } = useInsightsFormat();
  const isAdditive = isAdditiveMetric(metric);
  const brushRef = React.useRef(onBrush);
  brushRef.current = onBrush;
  const selectGroupRef = React.useRef(onSelectGroup);
  selectGroupRef.current = onSelectGroup;
  const hoveredSeriesRef = React.useRef<string | null>(null);
  const seriesIdsRef = React.useRef<string[]>([]);
  seriesIdsRef.current = [...groups.map((group) => group.id), ...(showTotal ? [TOTAL_SERIES_ID] : [])];
  React.useEffect(() => { hoveredSeriesRef.current = null; }, [groups, isAdditive]);
  const option = React.useMemo(() => {
    const categories = bucketStarts.map((start) => dayjs(start).format(LABEL_FORMATS[bucket]));
    const timeOf = (index: number) => (bucketStarts[index] === undefined ? undefined : dayjs(bucketStarts[index]).format(TOOLTIP_FORMATS[bucket]));
    const sampleThreshold = isAdditive ? 0 : LOW_SAMPLE_REQUESTS;
    const sampleNote = (sample: number) => {
      if (isAdditive || sample <= 0) return undefined;
      return t('insights.sample_note', { n: formatMetric('requests', sample, style) });
    };
    const linePoint = (value: number | null, sample: number, color: string) => {
      if (value === null) return null;
      const isThin = sample < sampleThreshold;
      return {
        value,
        symbol: isThin ? 'emptyCircle' : 'circle',
        symbolSize: isThin ? 5 : 4.5,
        itemStyle: { color, borderColor: color, borderWidth: isThin ? 1.2 : 0, opacity: isThin ? 0.8 : 1 },
      };
    };
    const series: Array<Record<string, unknown>> = groups.map((group) => {
      const color = colorOf(group.id);
      return {
        id: group.id,
        name: labelOf(group.id),
        type: isAdditive ? 'bar' : 'line',
        stack: isAdditive ? 'total' : undefined,
        barMaxWidth: 28,
        barCategoryGap: '28%',
        connectNulls: false,
        showSymbol: !isAdditive,
        symbol: 'circle',
        triggerEvent: isAdditive ? undefined : 'line',
        itemStyle: { color },
        lineStyle: isAdditive ? undefined : { color, width: showTotal ? 1.25 : 1.6, opacity: showTotal ? 0.58 : 1 },
        emphasis: { focus: 'series', lineStyle: { width: 2.6 } },
        blur: { lineStyle: { opacity: 0.16 }, itemStyle: { opacity: 0.24 } },
        data: group.values.map((value, index) => (isAdditive ? value : linePoint(value, group.samples[index] ?? 0, color))),
      };
    });
    if (showTotal) {
      const color = theme.palette.muted;
      series.push({
        id: TOTAL_SERIES_ID,
        name: totalLabel,
        type: 'line',
        connectNulls: false,
        showSymbol: false,
        triggerEvent: 'line',
        itemStyle: { color },
        lineStyle: { color, type: 'dashed', width: 1.25, opacity: 0.72 },
        emphasis: { focus: 'series', lineStyle: { width: 1.8 } },
        blur: { lineStyle: { opacity: 0.14 }, itemStyle: { opacity: 0.2 } },
        z: 4,
        data: totals,
      });
    }
    const noUsageRuns: number[][] = [];
    if (!isAdditive) {
      for (let index = 0; index < totalSamples.length; index += 1) {
        if ((totalSamples[index] ?? 0) > 0) continue;
        const last = noUsageRuns.at(-1);
        if (last && last.at(-1) === index - 1) last.push(index);
        else noUsageRuns.push([index]);
      }
    }
    const longestQuietRun = noUsageRuns.reduce<number[]>((best, run) => (run.length > best.length ? run : best), []);
    const markArea = {
      silent: true,
      itemStyle: { color: theme.palette.hover, opacity: 0.55 },
      label: { color: theme.palette.fg2, fontSize: 11, position: 'insideTop', distance: 3 },
      data: noUsageRuns.map((run) => run.length === 0 ? [] : [
        {
          xAxis: categories[run[0]],
          name: run === longestQuietRun ? t('insights.no_requests_bucket') : '',
          // A quiet run at either end of the axis is narrower than its label on a phone; anchoring the
          // label to the inner edge keeps it inside the plot rather than past the card's border.
          label: run.at(-1) === categories.length - 1 ? { position: 'insideTopRight' }
            : run[0] === 0 ? { position: 'insideTopLeft' } : undefined,
        },
        { xAxis: categories[run.at(-1)!] },
      ]),
    };
    const markAreaSeries = series.at(-1);
    if (markAreaSeries) (markAreaSeries as { markArea?: typeof markArea }).markArea = markArea;
    // The axis pointer supplies a bucket array on the background; painted bars supply one item.
    const tooltip = {
      trigger: 'item',
      className: 'omc-echart-tip omc-insights-trend-tip',
      enterable: false,
      confine: true,
      axisPointer: { type: isAdditive ? 'shadow' : 'line' },
      formatter: (params: AxisTooltipItem | AxisTooltipItem[]) => {
        const item = Array.isArray(params) ? undefined : params;
        const isBucket = item === undefined;
        const index = Array.isArray(params) ? params[0]?.dataIndex : params.dataIndex;
        if (index === undefined) return '';
        const total = totals[index];
        const itemSeriesId = item?.seriesId ?? (item?.seriesIndex === undefined ? undefined : seriesIdsRef.current[item.seriesIndex]);
        const activeSeriesId = hoveredSeriesRef.current ?? (isBucket ? undefined : itemSeriesId);
        const isBackground = isBucket && activeSeriesId === undefined;
        const selected = activeSeriesId === undefined ? tooltipGroups : tooltipGroups.filter((group) => group.id === activeSeriesId);
        const rows = selected.filter((group) => {
          const value = group.values[index];
          // A background enumerates contributors, so a quiet group is noise. A directly chosen
          // line or point states its reading, including a genuine zero.
          return value !== null && (isBackground ? value !== 0 : true);
        }).map((group) => {
          const value = group.values[index];
          return {
            name: labelOf(group.id),
            color: colorOf(group.id),
            value: formatMetric(metric, value, style),
            exact: formatMetricExact(metric, value),
            share: isAdditive && tooltipGroups.length > 1 ? formatShare(total !== null && total > 0 && value !== null ? value / total : null) : undefined,
            note: sampleNote(group.samples[index] ?? 0),
          };
        });
        if (total === null && isBackground) return renderChartTooltip(timeOf(index), [{ value: t('insights.no_requests_bucket') }]);
        const totalRow = total === null ? [] : [{
          name: totalLabel,
          value: formatMetric(metric, total, style),
          exact: formatMetricExact(metric, total),
          note: sampleNote(totalSamples[index] ?? 0),
        }];
        const includesTotal = isAdditive || isBackground || activeSeriesId === TOTAL_SERIES_ID;
        return renderChartTooltip(timeOf(index), includesTotal ? [...rows, ...totalRow] : rows);
      },
    };
    return {
      grid: { left: 8, right: 12, top: 16, bottom: 4, containLabel: true },
      xAxis: {
        type: 'category',
        data: categories,
        boundaryGap: true,
        axisLabel: { hideOverlap: true },
        // ECharts mutates this model; keep it defined and reset the pointer when metrics merge.
        axisPointer: { show: true, triggerTooltip: true, type: isAdditive ? 'shadow' : 'line', label: { show: false } },
      },
      yAxis: {
        type: 'value',
        splitNumber: 3,
        axisLabel: { formatter: (value: number) => formatMetric(metric, value, style) },
      },
      tooltip,
      toolbox: { show: false },
      brush: onBrush ? { xAxisIndex: 0, brushType: 'lineX', brushMode: 'single', transformable: false, throttleType: 'debounce', throttleDelay: 120 } : undefined,
      series,
    };
  }, [bucket, bucketStarts, colorOf, groups, isAdditive, labelOf, metric, onBrush, showTotal, style, t, theme.palette, tooltipGroups, totalLabel, totalSamples, totals, formatMetric, formatMetricExact]);

  const armBrush = React.useCallback((chart: ECharts) => {
    if (!brushRef.current) return;
    chart.dispatchAction({ type: 'takeGlobalCursor', key: 'brush', brushOption: { brushType: 'lineX', brushMode: 'single' } });
  }, []);

  const handlers = React.useMemo(() => ({
    backgroundClick: (_params: unknown, chart: ECharts) => {
      // A click is a selection gesture, not the start of a brush. Clear the narrow area a press
      // leaves behind before returning the chart to its unfiltered state.
      chart.dispatchAction({ type: 'brush', areas: [] });
      selectGroupRef.current(null);
    },
    click: (params: unknown, chart: ECharts) => {
      chart.dispatchAction({ type: 'brush', areas: [] });
      const item = params as { componentSubType?: string; seriesId?: string; seriesIndex?: number };
      const seriesId = item.seriesId ?? (item.seriesIndex === undefined ? undefined : seriesIdsRef.current[item.seriesIndex]);
      selectGroupRef.current(seriesId === undefined || seriesId === TOTAL_SERIES_ID ? null : seriesId);
    },
    mouseover: (params: unknown, chart: ECharts) => {
      if (isAdditive) return;
      const line = params as {
        componentSubType?: string;
        selfType?: string;
        seriesId?: string;
        seriesIndex?: number;
        event?: { offsetX?: number; offsetY?: number };
      };
      if (line.componentSubType !== 'line' || line.seriesIndex === undefined) return;
      hoveredSeriesRef.current = line.seriesId ?? seriesIdsRef.current[line.seriesIndex] ?? null;
      chart.dispatchAction({ type: 'highlight', seriesIndex: line.seriesIndex });
      if (line.selfType !== 'line') return;
      const { offsetX, offsetY } = line.event ?? {};
      if (offsetX === undefined || offsetY === undefined) return;
      const point = chart.convertFromPixel({ gridIndex: 0 }, [offsetX, offsetY]);
      if (!Array.isArray(point)) return;
      const dataIndex = Math.round(Number(point[0]));
      if (!Number.isInteger(dataIndex) || dataIndex < 0 || dataIndex >= bucketStarts.length) return;
      chart.dispatchAction({ type: 'showTip', seriesIndex: line.seriesIndex, dataIndex });
    },
    mouseout: (params: unknown, chart: ECharts) => {
      if (isAdditive) return;
      const line = params as { componentSubType?: string; seriesId?: string; seriesIndex?: number };
      if (line.componentSubType !== 'line') return;
      const seriesId = line.seriesId ?? (line.seriesIndex === undefined ? undefined : seriesIdsRef.current[line.seriesIndex]);
      if (line.seriesIndex !== undefined) chart.dispatchAction({ type: 'downplay', seriesIndex: line.seriesIndex });
      if (seriesId !== undefined && seriesId === hoveredSeriesRef.current) hoveredSeriesRef.current = null;
    },
    brushEnd: (params: unknown, chart: ECharts) => {
      const areas = (params as { areas?: Array<{ coordRange?: [number, number] }> }).areas ?? [];
      const range = areas[0]?.coordRange;
      chart.dispatchAction({ type: 'brush', areas: [] });
      if (!range || !brushRef.current) return;
      const [from, to] = range[0] <= range[1] ? range : [range[1], range[0]];
      // A click without a drag selects one bucket, which is not a request to narrow to it.
      if (to > from) brushRef.current(Math.max(0, from), Math.min(bucketStarts.length - 1, to));
    },
  }), [bucketStarts.length, isAdditive]);

  return (
    <EChart
      option={option}
      height={height}
      label={label}
      handlers={handlers}
      onApplied={armBrush}
      className="insights-trend-chart"
      testId="insights-trend-chart"
    />
  );
};

export const InsightsTrendChart = React.memo(InsightsTrendChartView);
export default InsightsTrendChart;
