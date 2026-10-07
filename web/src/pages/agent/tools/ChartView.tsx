import React from 'react';
import { Area, Bar, Column, Line, Pie } from '@ant-design/charts';
import { renderChartTooltip } from '../../../charts/chartTooltip';
import { resolveChartAnimation } from '../../../charts/chartMotion';
import { useChartPlugins } from '../../../charts/chartRender';
import { seriesColor } from '../../../charts/chartTheme';
import type { DisplayView } from '../../../agent/types';
import { usePrefersReducedMotion } from '../../../hooks/usePrefersReducedMotion';
import { useTheme } from '../../../theme/ThemeContext';
import { useTimeZone } from '../../../utils/TimeZoneProvider';
import dayjs from '../../../utils/time';
import { chartSeries } from '../state';
import { agentChartAxis, isPieChart } from './chartAxis';

const CHART_HEIGHT = 260;

/**
 * The chart component per display type, held as one loose component type. The config is built for
 * all five and each library component narrows it itself; letting TypeScript infer a union of the
 * five components' prop types for one JSX element costs gigabytes of checker memory.
 */
type LooseChart = React.ComponentType<Record<string, unknown>>;
const CHARTS: Record<string, LooseChart> = {
  line: Line as unknown as LooseChart,
  area: Area as unknown as LooseChart,
  column: Column as unknown as LooseChart,
  bar: Bar as unknown as LooseChart,
  pie: Pie as unknown as LooseChart,
};

export interface ChartViewProps {
  view: DisplayView;
  /** Receives the chart's container, for exporting the drawn canvas. */
  containerRef?: React.Ref<HTMLDivElement>;
}

/**
 * A display call's chart (ADR 0042), drawn with the console's chart stack: the series palette
 * (ADR 0006), the shared tooltip, the pixel-ratio plugin and the motion rules every dashboard
 * chart follows. Loaded lazily, so the Agent page's first paint never pulls the chart runtime.
 *
 * Values are drawn from the frozen rows the server resolved; nothing here reads capability
 * results or the model's text.
 */
export default function ChartView({ view, containerRef }: ChartViewProps) {
  useTimeZone();
  const { theme, themeMode } = useTheme();
  const isReducedMotion = usePrefersReducedMotion();
  const animate = resolveChartAnimation(isReducedMotion);
  const { plugins, onReady } = useChartPlugins();
  const chart = view.chart;
  const data = React.useMemo(() => chartSeries(view), [view]);
  const names = React.useMemo(() => [...new Set(data.points.map(point => point.series))], [data]);
  const colors = React.useMemo(() => names.map((_, index) => seriesColor(theme.palette, index)), [names, theme.palette]);
  const unit = chart?.unit ? ` ${chart.unit}` : '';
  const formatX = React.useCallback(
    (value: string) => (data.isTime ? dayjs(Number(value)).format('MM-DD HH:mm') : value),
    [data.isTime],
  );

  const config = React.useMemo(() => {
    const isPie = isPieChart(chart);
    const hasSeries = names.length > 1 || (names.length === 1 && names[0] !== '');
    return {
      data: data.points,
      height: CHART_HEIGHT,
      autoFit: true,
      ...(isPie
        ? { angleField: 'value', colorField: 'x', innerRadius: 0.6, label: false }
        : { xField: 'x', yField: 'value', ...(hasSeries ? { colorField: 'series' } : {}), ...(hasSeries && chart?.stacked ? { stack: true } : {}) }),
      scale: isPie
        ? { color: { range: data.points.map((_, index) => seriesColor(theme.palette, index)) } }
        : { color: { domain: names, range: colors }, ...(chart?.type === 'area' || chart?.type === 'line' ? {} : { y: { nice: true } }) },
      ...(chart?.type === 'area' ? { style: { fillOpacity: 0.14 } } : {}),
      axis: isPie ? false : agentChartAxis(formatX),
      legend: hasSeries || isPie ? { color: { position: 'bottom', itemLabelFill: theme.palette.fg2 } } : false,
      theme: { type: themeMode, tooltip: { crosshairsStroke: theme.palette.muted, crosshairsStrokeOpacity: 1 } },
      interaction: {
        tooltip: {
          shared: !isPie,
          render: (_event: unknown, context: { title?: string; items?: Array<{ name?: string; value?: number; color?: string }> }) => renderChartTooltip(
            formatX(String(context.title ?? '')),
            (context.items ?? []).map(item => ({
              name: item.name,
              color: item.color,
              value: `${Number(item.value ?? 0).toLocaleString()}${unit}`,
            })),
          ),
        },
      },
      animate,
      plugins,
      onReady,
    };
  }, [chart?.type, chart?.stacked, names, data, theme.palette, colors, formatX, themeMode, unit, animate, plugins, onReady]);

  const Chart = CHARTS[chart?.type ?? 'column'] ?? CHARTS.column;
  return (
    <div ref={containerRef} className="chart-slot" style={{ height: CHART_HEIGHT }} role="img" aria-label={view.title}>
      <Chart {...config} />
    </div>
  );
}
