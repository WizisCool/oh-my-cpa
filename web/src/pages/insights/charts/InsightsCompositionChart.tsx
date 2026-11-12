import React from 'react';
import { Bar, BarChart, CartesianGrid, Cell, XAxis, YAxis } from 'recharts';
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '@/components/ui/chart';
import { useMotionPreference } from '@/utils/motionPreference';
import { STACK_CAP_KEY, stackCapOf, stackCapShape } from '../../../charts/stackCap';
import { useTokenDisplayStyle } from '../../../types/tokenDisplayContext';
import type { InsightsMetric } from '../../../types/insightsCube';
import { formatShare } from '../../../types/insightsFormat';
import { useInsightsFormat } from '../useInsightsFormat';

export interface CompositionSegment {
  id: string | null;
  name: string;
  color: string;
}

export interface InsightsCompositionChartProps {
  rows: ReadonlyArray<{ id: string; name: string }>;
  segments: readonly CompositionSegment[];
  values: ReadonlyArray<readonly number[]>;
  metric: InsightsMetric;
  totalLabel: string;
  label: string;
  isDimmed?: (rowId: string, segmentId: string | null) => boolean;
  onSelect?: (rowId: string, segmentId: string | null) => void;
}

const ROW_HEIGHT = 32;
const REST_KEY = '__rest__';

function segKey(segment: CompositionSegment, index: number): string {
  return segment.id !== null ? `seg:${segment.id}` : `${REST_KEY}:${index}`;
}

const InsightsCompositionChartView: React.FC<InsightsCompositionChartProps> = ({
  rows,
  segments,
  values,
  metric,
  totalLabel,
  label,
  isDimmed,
  onSelect,
}) => {
  const { isReducedMotion } = useMotionPreference();
  const { style } = useTokenDisplayStyle();
  const { formatMetric, formatMetricExact } = useInsightsFormat();

  const totals = React.useMemo(
    () => rows.map((_, rowIdx) => values.reduce((sum, series) => sum + (series[rowIdx] ?? 0), 0)),
    [rows, values],
  );

  const data = React.useMemo(
    () =>
      rows.map((row, rowIdx) => {
        const entry: Record<string, string | number> = {
          rowId: row.id,
          rowName: row.name,
          total: totals[rowIdx] ?? 0,
        };
        segments.forEach((segment, segIdx) => {
          entry[segKey(segment, segIdx)] = values[segIdx]?.[rowIdx] ?? 0;
        });
        entry[STACK_CAP_KEY] = stackCapOf(entry, segments.map((segment, segIdx) => segKey(segment, segIdx)));
        return entry;
      }),
    [rows, segments, totals, values],
  );

  const config = React.useMemo<ChartConfig>(() => {
    const out: ChartConfig = {};
    segments.forEach((segment, idx) => {
      out[segKey(segment, idx)] = { label: segment.name, color: segment.color };
    });
    return out;
  }, [segments]);

  const chartHeight = Math.max(120, rows.length * ROW_HEIGHT + 32);

  return (
    <ChartContainer
      config={config}
      role="img"
      aria-label={label}
      data-testid="insights-composition-chart"
      style={{ height: chartHeight }}
      initialDimension={{ width: 560, height: chartHeight }}
    >
      <BarChart data={data} layout="vertical" margin={{ top: 4, right: 16, bottom: 4, left: 4 }}>
        <CartesianGrid horizontal={false} />
        <XAxis
          type="number"
          tickCount={4}
          tickLine={false}
          axisLine={false}
          tickFormatter={(v: number) => formatMetric(metric, v, style)}
        />
        <YAxis
          type="category"
          dataKey="rowName"
          width={148}
          tickLine={false}
          axisLine={false}
          tickFormatter={(name: string) => (name.length > 20 ? `${name.slice(0, 19)}…` : name)}
        />
        <ChartTooltip
          content={
            <ChartTooltipContent
              buildRows={(payload) => {
                const entry = payload[0]?.payload as Record<string, string | number> | undefined;
                if (!entry) return null;
                const total = Number(entry.total ?? 0);
                const breakdown = segments
                  .map((segment, segIdx) => {
                    const v = Number(entry[segKey(segment, segIdx)] ?? 0);
                    return { segment, v };
                  })
                  .filter((item) => item.v > 0)
                  .map(({ segment, v }) => ({
                    key: segment.id ?? segment.name,
                    name: segment.name,
                    color: segment.color,
                    value: formatMetric(metric, v, style),
                    share: formatShare(total > 0 ? v / total : null),
                  }));
                return {
                  heading: String(entry.rowName),
                  rows: [
                    ...breakdown,
                    {
                      key: '__total__',
                      name: totalLabel,
                      value: formatMetric(metric, total, style),
                      note: formatMetricExact(metric, total) !== formatMetric(metric, total, style)
                        ? formatMetricExact(metric, total)
                        : undefined,
                      isTotal: true,
                    },
                  ],
                };
              }}
            />
          }
        />
        {segments.map((segment, segIdx) => {
          const key = segKey(segment, segIdx);
          return (
            <Bar
              key={key}
              dataKey={key}
              name={segment.name}
              stackId="composition"
              maxBarSize={18}
              fill={segment.color}
              shape={stackCapShape(key, 'row')}
              isAnimationActive={!isReducedMotion}
              animationDuration={180}
              onClick={(_, rowIdx) => {
                const row = rows[rowIdx];
                if (row) onSelect?.(row.id, segment.id);
              }}
            >
              {rows.map((row) => (
                <Cell
                  key={row.id}
                  fill={segment.color}
                  fillOpacity={isDimmed?.(row.id, segment.id) ? 0.22 : 1}
                  className="cursor-pointer"
                />
              ))}
            </Bar>
          );
        })}
      </BarChart>
    </ChartContainer>
  );
};

export const InsightsCompositionChart = React.memo(InsightsCompositionChartView);
export default InsightsCompositionChart;
