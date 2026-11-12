import React from 'react';
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceArea,
  XAxis,
  YAxis,
} from 'recharts';
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '@/components/ui/chart';
import { useMotionPreference } from '@/utils/motionPreference';
import { STACK_CAP_KEY, stackCapOf, stackCapShape } from '../../../charts/stackCap';
import { BucketBrush } from '../../../charts/BucketBrush';
import dayjs from '../../../utils/time';
import { useTimeZone } from '../../../utils/TimeZoneProvider';
import { useT } from '../../../i18n';
import { useTheme } from '../../../theme/ThemeContext';
import { useTokenDisplayStyle } from '../../../types/tokenDisplayContext';
import type { InsightsBucket } from '../../../types/insights';
import { isAdditiveMetric, type InsightsMetric, type TrendGroup } from '../../../types/insightsCube';
import { formatShare } from '../../../types/insightsFormat';
import { useInsightsFormat } from '../useInsightsFormat';

export interface InsightsTrendChartProps {
  bucketStarts: readonly number[];
  bucket: InsightsBucket;
  groups: readonly TrendGroup[];
  tooltipGroups: readonly TrendGroup[];
  totals: ReadonlyArray<number | null>;
  totalSamples: readonly number[];
  colorOf: (id: string) => string;
  labelOf: (id: string) => string;
  metric: InsightsMetric;
  showTotal: boolean;
  onSelectGroup: (id: string | null) => void;
  totalLabel: string;
  label: string;
  onBrush?: (fromIndex: number, toIndex: number) => void;
  height?: number;
}

const TOTAL_SERIES_KEY = '__total_series__';
const LOW_SAMPLE_REQUESTS = 5;

const LABEL_FORMATS: Record<InsightsBucket, string> = {
  hour: 'HH:mm',
  day: 'MM-DD',
  week: 'MM-DD',
  month: 'YYYY-MM',
};

const TOOLTIP_FORMATS: Record<InsightsBucket, string> = {
  hour: 'MM-DD HH:mm',
  day: 'YYYY-MM-DD',
  week: 'YYYY-MM-DD',
  month: 'YYYY-MM',
};

function seriesKey(id: string): string {
  return `s:${id}`;
}

const InsightsTrendChartView: React.FC<InsightsTrendChartProps> = ({
  bucketStarts,
  bucket,
  groups,
  tooltipGroups,
  totals,
  totalSamples,
  colorOf,
  labelOf,
  metric,
  showTotal,
  onSelectGroup,
  totalLabel,
  label,
  onBrush,
  height = 280,
}) => {
  useTimeZone();
  const t = useT();
  const { theme } = useTheme();
  const { isReducedMotion } = useMotionPreference();
  const { style } = useTokenDisplayStyle();
  const { formatMetric } = useInsightsFormat();
  const isAdditive = isAdditiveMetric(metric);

  const didInteractSeriesRef = React.useRef(false);

  const categories = React.useMemo(
    () => bucketStarts.map((start) => dayjs(start).format(LABEL_FORMATS[bucket])),
    [bucket, bucketStarts],
  );

  const data = React.useMemo(
    () =>
      bucketStarts.map((start, index) => {
        const row: Record<string, string | number | null> = {
          bucketIndex: index,
          category: categories[index] ?? '',
          start,
          [TOTAL_SERIES_KEY]: totals[index] ?? null,
        };
        for (const group of groups) {
          row[seriesKey(group.id)] = group.values[index] ?? null;
        }
        row[STACK_CAP_KEY] = stackCapOf(row, groups.map((group) => seriesKey(group.id)));
        return row;
      }),
    [bucketStarts, categories, groups, totals],
  );

  const config = React.useMemo<ChartConfig>(() => {
    const out: ChartConfig = {};
    for (const group of groups) {
      out[seriesKey(group.id)] = { label: labelOf(group.id), color: colorOf(group.id) };
    }
    if (showTotal) {
      out[TOTAL_SERIES_KEY] = { label: totalLabel, color: theme.palette.muted };
    }
    return out;
  }, [colorOf, groups, labelOf, showTotal, theme.palette.muted, totalLabel]);

  const noUsageRuns = React.useMemo(() => {
    if (isAdditive) return [];
    const runs: number[][] = [];
    for (let idx = 0; idx < totalSamples.length; idx += 1) {
      if ((totalSamples[idx] ?? 0) > 0) continue;
      const last = runs.at(-1);
      if (last && last.at(-1) === idx - 1) last.push(idx);
      else runs.push([idx]);
    }
    return runs;
  }, [isAdditive, totalSamples]);

  const longestQuietRun = React.useMemo(
    () => noUsageRuns.reduce<number[]>((best, run) => (run.length > best.length ? run : best), []),
    [noUsageRuns],
  );

  const sampleNote = React.useCallback(
    (sample: number) => {
      if (isAdditive || sample <= 0) return undefined;
      return t('insights.sample_note', { n: formatMetric('requests', sample, style) });
    },
    [formatMetric, isAdditive, style, t],
  );

  const renderedSeriesNames = React.useMemo(
    () => [
      ...groups.map((group) => labelOf(group.id)),
      ...(showTotal ? [totalLabel] : []),
    ],
    [groups, labelOf, showTotal, totalLabel],
  );

  return (
    <ChartContainer
      config={config}
      role="img"
      aria-label={label}
      data-testid="insights-trend-chart"
      data-series={JSON.stringify(renderedSeriesNames)}
      style={{ height }}
      initialDimension={{ width: 760, height }}
      onClick={() => {
        if (didInteractSeriesRef.current) {
          didInteractSeriesRef.current = false;
          return;
        }
        onSelectGroup(null);
      }}
    >
      <ComposedChart
        data={data}
        margin={{ top: 14, right: 12, bottom: 4, left: 4 }}
      >
        <CartesianGrid vertical={false} />
        <XAxis
          dataKey="bucketIndex"
          // Bands in both modes: a line-only chart would otherwise take a point scale, and the brush
          // reads the plot as equal bucket bands.
          scale="band"
          tickLine={false}
          axisLine={false}
          tickMargin={6}
          minTickGap={24}
          tickFormatter={(idx: number) => categories[idx] ?? ''}
        />
        <YAxis
          width={56}
          tickCount={4}
          tickLine={false}
          axisLine={false}
          tickFormatter={(v: number) => formatMetric(metric, v, style)}
        />
        {noUsageRuns.map((run) =>
          run.length > 0 ? (
            <ReferenceArea
              key={run[0]}
              x1={run[0]}
              x2={run.at(-1)}
              fill={theme.palette.hover}
              fillOpacity={0.55}
              label={
                run === longestQuietRun
                  ? { value: t('insights.no_requests_bucket'), position: 'insideTop', fill: theme.palette.fg2, fontSize: 12 }
                  : undefined
              }
            />
          ) : null,
        )}
        <ChartTooltip
          isPinnedTop
          content={
            <ChartTooltipContent
              buildRows={(payload) => {
                const entry = payload[0]?.payload as { bucketIndex: number; start: number } | undefined;
                if (!entry) return null;
                const idx = entry.bucketIndex;
                const heading = dayjs(entry.start).format(TOOLTIP_FORMATS[bucket]);
                const total = totals[idx] ?? null;

                if (total === null) {
                  return {
                    heading,
                    rows: [{ value: t('insights.no_requests_bucket') }],
                  };
                }

                const contributorRows = tooltipGroups
                  .filter((group) => {
                    const val = group.values[idx];
                    return val !== null && val !== undefined && val !== 0;
                  })
                  .map((group) => {
                    const val = group.values[idx]!;
                    return {
                      key: group.id,
                      name: labelOf(group.id),
                      color: colorOf(group.id),
                      value: formatMetric(metric, val, style),
                      share:
                        isAdditive && tooltipGroups.length > 1
                          ? formatShare(total > 0 ? val / total : null)
                          : undefined,
                      note: sampleNote(group.samples[idx] ?? 0),
                    };
                  });

                return {
                  heading,
                  rows: [
                    ...contributorRows,
                    {
                      key: TOTAL_SERIES_KEY,
                      name: totalLabel,
                      color: showTotal ? theme.palette.muted : undefined,
                      indicator: showTotal ? 'dashed' : 'dot',
                      value: formatMetric(metric, total, style),
                      note: sampleNote(totalSamples[idx] ?? 0),
                      isTotal: contributorRows.length > 0,
                    },
                  ],
                };
              }}
            />
          }
        />
        {isAdditive
          ? groups.map((group) => {
              const key = seriesKey(group.id);
              const color = colorOf(group.id);
              return (
                <Bar
                  key={group.id}
                  dataKey={key}
                  name={labelOf(group.id)}
                  stackId="total"
                  maxBarSize={28}
                  fill={color}
                  shape={stackCapShape(key)}
                  isAnimationActive={!isReducedMotion}
                  animationDuration={180}
                  onClick={() => {
                    didInteractSeriesRef.current = true;
                    onSelectGroup(group.id);
                  }}
                />
              );
            })
          : groups.map((group) => {
              const key = seriesKey(group.id);
              const color = colorOf(group.id);
              return (
                <Line
                  key={group.id}
                  type="monotone"
                  dataKey={key}
                  name={labelOf(group.id)}
                  stroke={color}
                  strokeWidth={showTotal ? 1.5 : 1.75}
                  strokeOpacity={showTotal ? 0.72 : 1}
                  connectNulls={false}
                  dot={(dotProps) => {
                    const { cx, cy, index, value } = dotProps as {
                      cx?: number;
                      cy?: number;
                      index?: number;
                      value?: number | null;
                    };
                    if (cx === undefined || cy === undefined || value === null || value === undefined) {
                      return <g key={`empty-${index}`} />;
                    }
                    const isThin = (group.samples[index ?? 0] ?? 0) < LOW_SAMPLE_REQUESTS;
                    return (
                      <circle
                        key={`dot-${index}`}
                        cx={cx}
                        cy={cy}
                        r={isThin ? 2.5 : 2.25}
                        fill={isThin ? 'var(--bg)' : color}
                        stroke={color}
                        strokeWidth={isThin ? 1.25 : 0}
                      />
                    );
                  }}
                  activeDot={{
                    r: 3.5,
                    fill: color,
                    strokeWidth: 0,
                    onClick: () => {
                      didInteractSeriesRef.current = true;
                      onSelectGroup(group.id);
                    },
                  }}
                  onClick={() => {
                    didInteractSeriesRef.current = true;
                    onSelectGroup(group.id);
                  }}
                  isAnimationActive={!isReducedMotion}
                  animationDuration={180}
                />
              );
            })}
        {showTotal && (
          <Line
            type="monotone"
            dataKey={TOTAL_SERIES_KEY}
            name={totalLabel}
            stroke={theme.palette.muted}
            strokeDasharray="4 3"
            strokeWidth={1.35}
            dot={false}
            connectNulls={false}
            isAnimationActive={!isReducedMotion}
            animationDuration={180}
          />
        )}
        {onBrush && <BucketBrush bucketCount={data.length} onBrush={onBrush} />}
      </ComposedChart>
    </ChartContainer>
  );
};

export const InsightsTrendChart = React.memo(InsightsTrendChartView);
export default InsightsTrendChart;
