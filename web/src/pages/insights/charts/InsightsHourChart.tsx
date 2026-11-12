import React from 'react';
import { useMorphedProps } from '../../../charts/useChartMorph';
import { Bar, BarChart, CartesianGrid, Cell, ReferenceArea, XAxis, YAxis } from 'recharts';
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '@/components/ui/chart';
import { COLUMN_CAP } from '../../../charts/stackCap';
import { useTheme } from '../../../theme/ThemeContext';
import { useTokenDisplayStyle } from '../../../types/tokenDisplayContext';
import type { InsightsMetric } from '../../../types/insightsCube';
import { formatShare } from '../../../types/insightsFormat';
import { useInsightsFormat } from '../useInsightsFormat';

export interface InsightsHourChartProps {
  values: readonly number[];
  peakHours: ReadonlySet<number>;
  peakLabel: string;
  metric: InsightsMetric;
  label: string;
}

const HOUR_LABELS = Array.from({ length: 24 }, (_, hour) => `${String(hour).padStart(2, '0')}:00`);
const VISIBLE_TICKS = HOUR_LABELS.filter((_, hour) => hour % 3 === 0);

function contiguousRuns(hours: ReadonlySet<number>): number[][] {
  const runs: number[][] = [];
  for (let hour = 0; hour < 24; hour += 1) {
    if (!hours.has(hour)) continue;
    const last = runs[runs.length - 1];
    if (last && last[last.length - 1] === hour - 1) last.push(hour);
    else runs.push([hour]);
  }
  return runs;
}

const InsightsHourChartView: React.FC<InsightsHourChartProps> = ({
  values,
  peakHours,
  peakLabel,
  metric,
  label,
}) => {
  const { theme } = useTheme();
  const { style } = useTokenDisplayStyle();
  const { formatMetric, formatMetricExact } = useInsightsFormat();
  const ink = theme.palette.series[0] ?? theme.palette.accent;

  const total = React.useMemo(() => values.reduce((sum, v) => sum + v, 0), [values]);
  const runs = React.useMemo(() => contiguousRuns(peakHours), [peakHours]);
  const longest = React.useMemo(
    () => runs.reduce<number[]>((best, run) => (run.length > best.length ? run : best), []),
    [runs],
  );

  const data = React.useMemo(
    () =>
      HOUR_LABELS.map((hourLabel, hour) => ({
        hour,
        hourLabel,
        value: values[hour] ?? 0,
      })),
    [values],
  );

  const config = React.useMemo<ChartConfig>(() => ({ value: { color: ink } }), [ink]);

  return (
    <ChartContainer
      config={config}
      role="img"
      aria-label={label}
      data-testid="insights-hour-chart"
      style={{ height: 200 }}
      initialDimension={{ width: 520, height: 200 }}
    >
      <BarChart data={data} margin={{ top: 18, right: 8, bottom: 4, left: 4 }}>
        <CartesianGrid vertical={false} />
        <XAxis
          dataKey="hourLabel"
          ticks={VISIBLE_TICKS}
          tickLine={false}
          axisLine={false}
          tickMargin={6}
        />
        <YAxis
          width={52}
          tickCount={4}
          tickLine={false}
          axisLine={false}
          tickFormatter={(value: number) => formatMetric(metric, value, style)}
        />
        {runs.map((run) => (
          <ReferenceArea
            key={run[0]}
            x1={HOUR_LABELS[run[0]!]}
            x2={HOUR_LABELS[run[run.length - 1]!]}
            fill={ink}
            fillOpacity={0.07}
            ifOverflow="extendDomain"
            label={
              run === longest
                ? { value: peakLabel, position: 'insideTop', fill: theme.palette.fg2, fontSize: 12 }
                : undefined
            }
          />
        ))}
        <ChartTooltip
          isPinnedTop
          content={
            <ChartTooltipContent
              buildRows={(payload) => {
                const entry = payload[0]?.payload as { hour: number; value: number } | undefined;
                if (!entry) return null;
                const display = formatMetric(metric, entry.value, style);
                const exact = formatMetricExact(metric, entry.value);
                return {
                  heading: `${HOUR_LABELS[entry.hour]} – ${HOUR_LABELS[(entry.hour + 1) % 24]}`,
                  rows: [
                    {
                      color: ink,
                      value: display,
                      share: formatShare(total > 0 ? entry.value / total : null),
                      note: exact && exact !== display ? exact : undefined,
                    },
                  ],
                };
              }}
            />
          }
        />
        <Bar
          dataKey="value"
          radius={COLUMN_CAP}
          isAnimationActive={false}
        >
          {data.map((entry) => (
            <Cell
              key={entry.hour}
              fill={ink}
              fillOpacity={peakHours.has(entry.hour) ? 1 : 0.38}
            />
          ))}
        </Bar>
      </BarChart>
    </ChartContainer>
  );
};

/**
 * The chart takes its props through `useChartMorph`: a new dataset is one render of the marks inside
 * a compositor cross-fade, not a library tween that re-renders every SVG mark on every frame - which
 * is what made a filter or metric change stall the page.
 */
const InsightsHourChartPlot = React.memo(InsightsHourChartView);
export const InsightsHourChart = React.memo<InsightsHourChartProps>((props) => {
  const { shown, scopeRef } = useMorphedProps(props);
  return (
    <div ref={scopeRef} className="omc-chart-morph">
      <InsightsHourChartPlot {...shown} />
    </div>
  );
});
InsightsHourChart.displayName = 'InsightsHourChart';
export default InsightsHourChart;
