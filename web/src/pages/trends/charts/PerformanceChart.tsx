import React from 'react';
import { Area, CartesianGrid, ComposedChart, Line, Scatter, ScatterChart, XAxis, YAxis, ZAxis } from 'recharts';
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart';
import type { TooltipReadoutRow } from '../../../components/common/Tooltip';
import { useMorphedProps } from '../../../charts/useChartMorph';
import { BucketBrush } from '../../../charts/BucketBrush';
import dayjs from '../../../utils/time';
import { useTimeZone } from '../../../utils/TimeZoneProvider';
import { useT } from '../../../i18n';
import { useTheme } from '../../../theme/ThemeContext';
import { formatLatency } from '../../../types/insightsFormat';
import type { InsightsBucket, InsightsWindow } from '../../../types/insights';
import type { TrendsScatterPoint, TrendsTelemetryBucket, TrendsTelemetrySeries } from '../../../types/trends';
import { GLOBAL_SERIES_ID, latencySeriesRows, percentileRows, perfSeriesKey, tpsRows, type PerfMode, type PerfQuantile } from '../trendsLogic';

export interface PerformanceChartProps {
  mode: PerfMode;
  bucket: InsightsBucket;
  window: Pick<InsightsWindow, 'from' | 'to' | 'open_end'>;
  buckets: readonly TrendsTelemetryBucket[];
  series: readonly TrendsTelemetrySeries[];
  scatter: readonly TrendsScatterPoint[];
  groupBy: string;
  /** When false in ttft/latency mode, draws a single P50 + P95-band view from `buckets`. */
  isMultiSeries?: boolean;
  quantile?: PerfQuantile;
  colorOf: (id: string) => string;
  labelOf: (id: string) => string;
  /** A provider key as the console names it. */
  providerLabel: (id: string) => string;
  label: string;
  height?: number;
  /** Highlights one series across the plot while dimming the others. */
  focusedKey?: string | null;
  onFocusGroup?: (id: string) => void;
  onClearFocus?: () => void;
  /** A stretch of buckets was swept on a time mode: resolved range from the rendered drawing's buckets. */
  onBrush?: (range: { from: number; to: number | null }) => void;
}

const LABEL_FORMATS: Record<InsightsBucket, string> = { hour: 'HH:mm', day: 'MM-DD', week: 'MM-DD', month: 'YYYY-MM' };
const TOOLTIP_FORMATS: Record<InsightsBucket, string> = { hour: 'MM-DD HH:mm', day: 'YYYY-MM-DD', week: 'YYYY-MM-DD', month: 'YYYY-MM' };

function formatTps(value: number | null | undefined): string {
  return value === null || value === undefined || !Number.isFinite(value) ? '—' : value.toFixed(value >= 100 ? 0 : 1);
}

const PerformanceChartView: React.FC<PerformanceChartProps> = ({
  mode, bucket, window, buckets, series, scatter, isMultiSeries = true, quantile = 'p50', colorOf, labelOf, providerLabel, label, height = 280,
  focusedKey = null, onFocusGroup, onClearFocus, onBrush,
}) => {
  useTimeZone();
  const t = useT();
  const { theme } = useTheme();
  const { timingGreen, timingOrange } = theme.palette;
  const didInteractSeriesRef = React.useRef(false);
  const isLineMulti = mode === 'tps' || ((mode === 'ttft' || mode === 'latency') && isMultiSeries);

  const handleBrush = React.useCallback((fromIndex: number, toIndex: number) => {
    if (!onBrush) return;
    const from = Math.max(buckets[fromIndex]?.start_ms ?? window.from, window.from);
    const isThroughNow = window.open_end && toIndex >= buckets.length - 1;
    const to = Math.min((buckets[toIndex + 1]?.start_ms ?? window.to + 1) - 1, window.to);
    onBrush({ from, to: isThroughNow ? null : to });
  }, [buckets, onBrush, window]);

  const lineData = React.useMemo<Array<Record<string, unknown>>>(() => {
    if (mode === 'tps' || (isLineMulti && (mode === 'ttft' || mode === 'latency'))) {
      const source = mode === 'tps'
        ? tpsRows(buckets, series)
        : latencySeriesRows(buckets, series, mode, quantile);
      return source.map((row, index) => ({ ...row, bucketIndex: index }));
    }
    if (mode === 'ttft' || mode === 'latency') return percentileRows(buckets, mode).map((row, index) => ({ ...row, bucketIndex: index }));
    return [];
  }, [buckets, isLineMulti, mode, quantile, series]);

  const altLatencyRows = React.useMemo(() => {
    if (!isLineMulti || (mode !== 'ttft' && mode !== 'latency')) return [];
    return latencySeriesRows(buckets, series, mode, quantile === 'p50' ? 'p95' : 'p50');
  }, [buckets, isLineMulti, mode, quantile, series]);

  const config = React.useMemo<ChartConfig>(() => {
    const out: ChartConfig = {};
    if (isLineMulti) {
      out[GLOBAL_SERIES_ID] = { label: t('trends.perf.all'), color: theme.palette.muted };
      for (const group of series) out[perfSeriesKey(group.id)] = { label: labelOf(group.id), color: colorOf(group.id) };
    } else {
      out.p50 = { label: 'P50', color: timingGreen };
      out.band = { label: 'P95', color: timingOrange };
    }
    return out;
  }, [colorOf, isLineMulti, labelOf, series, t, theme.palette.muted, timingGreen, timingOrange]);

  const scatterGroups = React.useMemo(() => {
    if (mode !== 'scatter') return [];
    const measured = scatter.filter((point) => point.ttft_ms !== null && point.latency_ms !== null);
    const byGroup = new Map<string, TrendsScatterPoint[]>();
    const failed: TrendsScatterPoint[] = [];
    for (const point of measured) {
      if (point.failed) {
        failed.push(point);
        continue;
      }
      const list = byGroup.get(point.group_id) ?? [];
      list.push(point);
      byGroup.set(point.group_id, list);
    }
    const groups = [...byGroup.entries()].map(([id, points]) => ({ id, points, color: colorOf(id), name: labelOf(id) }));
    if (failed.length > 0) groups.push({ id: '\u0000failed', points: failed, color: theme.palette.danger, name: t('trends.perf.failed') });
    return groups;
  }, [colorOf, labelOf, mode, scatter, t, theme.palette.danger]);

  const orderedSeries = React.useMemo(() => {
    if (!focusedKey) return series;
    return [...series.filter((group) => group.id !== focusedKey), ...series.filter((group) => group.id === focusedKey)];
  }, [focusedKey, series]);

  const orderedScatterGroups = React.useMemo(() => {
    if (!focusedKey) return scatterGroups;
    return [...scatterGroups.filter((group) => group.id !== focusedKey), ...scatterGroups.filter((group) => group.id === focusedKey)];
  }, [focusedKey, scatterGroups]);

  if (mode === 'scatter') {
    return (
      <ChartContainer
        config={config}
        role="img"
        aria-label={label}
        data-testid="trends-perf-chart"
        data-mode={mode}
        style={{ height }}
        initialDimension={{ width: 760, height }}
        onClick={() => {
          if (didInteractSeriesRef.current) {
            didInteractSeriesRef.current = false;
            return;
          }
          onClearFocus?.();
        }}
      >
        <ScatterChart margin={{ top: 14, right: 12, bottom: 4, left: 4 }}>
          <CartesianGrid />
          <XAxis dataKey="ttft_ms" type="number" name="TTFT" tickLine={false} axisLine={false} tickMargin={6} tickFormatter={(value: number) => formatLatency(value)} />
          <YAxis dataKey="latency_ms" type="number" width={56} tickLine={false} axisLine={false} tickFormatter={(value: number) => formatLatency(value)} />
          <ZAxis range={[18, 18]} />
          <ChartTooltip
            content={(
              <ChartTooltipContent
                buildRows={(payload) => {
                  const point = payload[0]?.payload as unknown as TrendsScatterPoint | undefined;
                  if (!point) return null;
                  const rows: TooltipReadoutRow[] = [
                    { key: 'model', name: t('trends.dim.model'), value: point.model, isText: true },
                    { key: 'provider', name: t('trends.dim.provider'), value: providerLabel(point.provider), isText: true },
                    { key: 'ttft', name: 'TTFT', value: point.ttft_ms === null ? '—' : formatLatency(point.ttft_ms) },
                    { key: 'latency', name: t('trends.perf.latency'), value: point.latency_ms === null ? '—' : formatLatency(point.latency_ms) },
                    { key: 'tps', name: 'TPS', value: formatTps(point.tps) },
                  ];
                  if (point.failed) rows.push({ key: 'failed', value: t('trends.perf.failed'), tone: 'danger' });
                  if (point.model_substituted) rows.push({ key: 'sub', value: t('trends.stability.lane.model_substituted'), tone: 'warn' });
                  return { heading: dayjs(point.timestamp_ms).format('MM-DD HH:mm:ss'), rows };
                }}
              />
            )}
          />
          {orderedScatterGroups.map((group) => {
            const isFailed = group.id === '\u0000failed';
            const fillOpacity = focusedKey === null ? 0.7 : group.id === focusedKey ? 0.88 : 0.14;
            return (
              <Scatter
                key={group.id}
                name={group.name}
                data={group.points}
                fill={group.color}
                fillOpacity={fillOpacity}
                isAnimationActive={false}
                onClick={isFailed ? undefined : () => {
                  didInteractSeriesRef.current = true;
                  onFocusGroup?.(group.id);
                }}
              />
            );
          })}
        </ScatterChart>
      </ChartContainer>
    );
  }

  const tick = (index: number) => {
    const start = (lineData[index] as { start?: number | null } | undefined)?.start;
    return start === undefined || start === null ? '' : dayjs(start).format(LABEL_FORMATS[bucket]);
  };

  return (
    <ChartContainer
      config={config}
      role="img"
      aria-label={label}
      data-testid="trends-perf-chart"
      data-mode={mode}
      style={{ height }}
      initialDimension={{ width: 760, height }}
      onClick={() => {
        if (didInteractSeriesRef.current) {
          didInteractSeriesRef.current = false;
          return;
        }
        onClearFocus?.();
      }}
    >
      <ComposedChart data={lineData} margin={{ top: 14, right: 12, bottom: 4, left: 4 }}>
        <CartesianGrid vertical={false} />
        <XAxis dataKey="bucketIndex" scale="band" tickLine={false} axisLine={false} tickMargin={6} minTickGap={24} tickFormatter={tick} />
        <YAxis
          width={56}
          tickCount={4}
          tickLine={false}
          axisLine={false}
          tickFormatter={(value: number) => (mode === 'tps' ? formatTps(value) : formatLatency(value))}
        />
        <ChartTooltip
          isPinnedTop
          content={(
            <ChartTooltipContent
              buildRows={(payload) => {
                const row = payload[0]?.payload;
                if (!row) return null;
                const heading = dayjs(row.start as number).format(TOOLTIP_FORMATS[bucket]);
                if (isLineMulti) {
                  const activeSeries = series.filter((group) => row[perfSeriesKey(group.id)] !== null && row[perfSeriesKey(group.id)] !== undefined);
                  const globalVal = row[GLOBAL_SERIES_ID] as number | null;
                  if (activeSeries.length === 0 && (globalVal === null || globalVal === undefined)) {
                    return { heading, rows: [{ value: t('trends.perf.no_samples') }] };
                  }
                  if (mode === 'tps') {
                    const rows: TooltipReadoutRow[] = activeSeries.map((group) => ({
                      key: group.id,
                      name: labelOf(group.id),
                      color: colorOf(group.id),
                      value: formatTps(row[perfSeriesKey(group.id)] as number | null),
                    }));
                    rows.push({ key: 'all', name: t('trends.perf.all'), indicator: 'dashed', color: theme.palette.muted, value: formatTps(globalVal), isTotal: rows.length > 0 });
                    return { heading, rows };
                  }
                  const altRow = altLatencyRows[Number(row.bucketIndex)];
                  const altLabel = quantile === 'p50' ? 'P95' : 'P50';
                  const rows: TooltipReadoutRow[] = activeSeries.map((group) => {
                    const val = row[perfSeriesKey(group.id)] as number;
                    const altVal = altRow?.[perfSeriesKey(group.id)] ?? null;
                    return {
                      key: group.id,
                      name: labelOf(group.id),
                      color: colorOf(group.id),
                      value: formatLatency(val),
                      note: altVal !== null && Number.isFinite(altVal) ? `${altLabel} ${formatLatency(altVal)}` : undefined,
                    };
                  });
                  const altGlobal = altRow?.[GLOBAL_SERIES_ID] ?? null;
                  rows.push({
                    key: 'all',
                    name: t('trends.perf.all'),
                    indicator: 'dashed',
                    color: theme.palette.muted,
                    value: globalVal !== null && globalVal !== undefined && Number.isFinite(globalVal) ? formatLatency(globalVal) : '—',
                    note: altGlobal !== null && Number.isFinite(altGlobal) ? `${altLabel} ${formatLatency(altGlobal)}` : undefined,
                    isTotal: rows.length > 0,
                  });
                  return { heading, rows };
                }
                const samples = Number(row.samples ?? 0);
                if (samples === 0) return { heading, rows: [{ value: t('trends.perf.no_samples') }] };
                return {
                  heading,
                  rows: [
                    { key: 'p50', name: 'P50', color: timingGreen, indicator: 'line', value: formatLatency(row.p50 as number) },
                    { key: 'p95', name: 'P95', color: timingOrange, value: formatLatency(row.p95 as number) },
                    { key: 'n', name: t('trends.perf.samples'), value: samples.toLocaleString('en'), tone: 'muted' },
                  ],
                };
              }}
            />
          )}
        />
        {isLineMulti ? (
          <>
            {orderedSeries.map((group) => {
              const color = colorOf(group.id);
              const isFocused = focusedKey === group.id;
              const strokeOpacity = focusedKey === null ? 1 : isFocused ? 1 : 0.2;
              return (
                <Line
                  key={group.id}
                  dataKey={perfSeriesKey(group.id)}
                  type="monotone"
                  stroke={color}
                  strokeWidth={isFocused ? 2.4 : 1.75}
                  strokeOpacity={strokeOpacity}
                  dot={false}
                  activeDot={focusedKey !== null && !isFocused ? false : {
                    r: 3.5,
                    fill: color,
                    strokeWidth: 0,
                    onClick: () => {
                      didInteractSeriesRef.current = true;
                      onFocusGroup?.(group.id);
                    },
                  }}
                  onClick={() => {
                    didInteractSeriesRef.current = true;
                    onFocusGroup?.(group.id);
                  }}
                  connectNulls={false}
                  isAnimationActive={false}
                />
              );
            })}
            <Line
              dataKey={GLOBAL_SERIES_ID}
              type="monotone"
              stroke={theme.palette.muted}
              strokeWidth={1.35}
              strokeOpacity={focusedKey !== null ? 0.3 : 1}
              strokeDasharray="4 3"
              dot={false}
              activeDot={focusedKey !== null ? false : { r: 3, fill: theme.palette.muted, strokeWidth: 0 }}
              connectNulls={false}
              isAnimationActive={false}
            />
          </>
        ) : (
          <>
            <Area dataKey="band" type="monotone" stroke="none" fill={timingOrange} fillOpacity={0.18} connectNulls={false} isAnimationActive={false} />
            <Line dataKey="p95" type="monotone" stroke={timingOrange} strokeOpacity={0.6} strokeWidth={1} dot={false} connectNulls={false} isAnimationActive={false} />
            <Line dataKey="p50" type="monotone" stroke={timingGreen} strokeWidth={2} dot={false} connectNulls={false} isAnimationActive={false} />
          </>
        )}
        {onBrush && <BucketBrush bucketCount={lineData.length} onBrush={handleBrush} />}
      </ComposedChart>
    </ChartContainer>
  );
};

const PerformanceChartPlot = React.memo(PerformanceChartView);
export const PerformanceChart = React.memo<PerformanceChartProps>(({ focusedKey = null, onFocusGroup, onClearFocus, ...drawing }) => {
  const { shown, scopeRef } = useMorphedProps(drawing);
  return (
    <div ref={scopeRef} className="omc-chart-morph">
      <PerformanceChartPlot {...shown} focusedKey={focusedKey} onFocusGroup={onFocusGroup} onClearFocus={onClearFocus} />
    </div>
  );
});
PerformanceChart.displayName = 'PerformanceChart';
export default PerformanceChart;
